// Records the README's animated demos (docs/screenshots/*.gif) from the real app, the way the
// e2e tests run it (Linux, private Xvfb display, scripted demo tutor, OCR standing in for
// Gemini). Needs Xvfb, xcompmgr, tesseract, ffmpeg and python3 with Pillow.
//   node scripts/record-demos.mjs [scene]      scenes: trace, gestures, showme, pen
//
// The overlay's own frames are recorded as it paints them (beginFrameSubscription), laid over
// one capture of the screen underneath, so the motion is smooth however slow screen capture is.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] ?? '';
const display = `:${80 + Math.floor(Math.random() * 9)}`;
const xvfb = spawn('Xvfb', [display, '-screen', '0', '2560x1440x24', '-ac', '+extension', 'RANDR', '+extension', 'Composite', '-nolisten', 'tcp'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));
process.env.DISPLAY = display;
const compositor = spawn('xcompmgr', ['-n'], { stdio: 'ignore', env: process.env });
await new Promise((r) => setTimeout(r, 400));

const { launch, main, waitFor, sleep, FAKE_DISPLAYS, openTargetWindow, callTool, pointer } = await import('../test/e2e/harness.mjs');
const out = join(root, 'docs', 'screenshots');

const IDE = `<!doctype html><html><body style="margin:0;font-family:DejaVu Sans,Arial,sans-serif;background:#fff;color:#111">
<div style="display:flex;gap:14px;padding:12px 16px;background:#eef1f5;border-bottom:1px solid #ccd">
  <button data-t="run" style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">Run</button>
</div>
<pre style="margin:0;padding:18px 22px;font:22px/1.6 DejaVu Sans Mono,monospace">
<span data-t="line1">def factorial(n):</span>
<span data-t="line2">    if n == 0:</span>
<span data-t="line3">        return 1</span>
<span data-t="line4">    return n * factorial(n - 1)</span>

<span data-t="line6">print(factorial(2))</span></pre></body></html>`;

async function session() {
  const { app } = await launch({ PAIRWISE_GROUNDER: 'ocr', PAIRWISE_MOCK_SCRIPT: 'none' });
  const S = (fn, arg) => main(app, fn, arg);
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false, inkFade: 'manual' });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  const win = await openTargetWindow(app, { x: d1.bounds.x + 70, y: d1.bounds.y + 90, width: 860, height: 440, html: IDE });
  pointer.move(d1.bounds.x + 760, d1.bounds.y + 600);
  await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await S(() => globalThis.__pairwise.session.setMuted(true));
  await waitFor(() => S(() => Boolean(globalThis.__pairwise.session.modelFrame)), { label: 'frame' });
  await sleep(3000); // the join label goes, the cursor dims
  const displayId = await S(() => globalThis.__pairwise.platform.displays.list()[0].id);
  return { app, S, win, d1, displayId };
}

/** Start recording the overlay's frames in `region` (global DIP) over the screen beneath. */
async function record(app, displayId, region) {
  await app.evaluate(async ({ desktopCapturer, screen }, o) => {
    const s = globalThis.__pairwise.session;
    const d = globalThis.__pairwise.platform.displays.byId(o.displayId);
    const w = s.overlays.windowFor(o.displayId);
    const vis = (v) => w.webContents.executeJavaScript(`document.documentElement.style.visibility = '${v}'; new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    await vis('hidden');
    await new Promise((r) => setTimeout(r, 150));
    const all = screen.getAllDisplays();
    const W = Math.max(...all.map((x) => x.bounds.x + x.bounds.width));
    const H = Math.max(...all.map((x) => x.bounds.y + x.bounds.height));
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: W, height: H } });
    await vis('visible');
    const crop = { x: Math.round(o.region.x), y: Math.round(o.region.y), width: Math.round(o.region.width), height: Math.round(o.region.height) };
    const local = { ...crop, x: crop.x - d.bounds.x, y: crop.y - d.bounds.y };
    globalThis.__rec = { bg: src.thumbnail.crop(crop).toPNG().toString('base64'), frames: [], t0: Date.now() };
    w.webContents.beginFrameSubscription(false, (img) => {
      const k = img.getSize().width / d.bounds.width;
      globalThis.__rec.frames.push({ t: Date.now(), png: img.crop({ x: Math.round(local.x * k), y: Math.round(local.y * k), width: Math.round(local.width * k), height: Math.round(local.height * k) }).resize({ width: local.width }).toPNG().toString('base64') });
    });
    w.webContents.invalidate();
  }, { displayId, region });
  return {
    pointer: [],
    async stop(name, { fps = 20, width = 720 } = {}) {
      const rec = await app.evaluate((_e, id) => {
        globalThis.__pairwise.session.overlays.windowFor(id).webContents.endFrameSubscription();
        const r = { ...globalThis.__rec, t1: Date.now() };
        globalThis.__rec = null;
        return r;
      }, displayId);
      const dir = mkdtempSync(join(tmpdir(), 'pw-rec-'));
      writeFileSync(join(dir, 'bg.png'), Buffer.from(rec.bg, 'base64'));
      const index = rec.frames.map((f, i) => {
        writeFileSync(join(dir, `o${i}.png`), Buffer.from(f.png, 'base64'));
        return { t: f.t - rec.t0, file: `o${i}.png` };
      });
      writeFileSync(join(dir, 'index.json'), JSON.stringify({ frames: index, duration: rec.t1 - rec.t0, region, pointer: this.pointer.map((p) => ({ t: p.t - rec.t0, x: p.x - region.x, y: p.y - region.y, click: p.click })) }));
      const r = spawnSync('python3', [join(root, 'scripts', 'compose-demo.py'), dir, join(out, `${name}.gif`), String(fps), String(width)], { stdio: 'inherit' });
      rmSync(dir, { recursive: true, force: true });
      if (r.status !== 0) throw new Error(`composing ${name} failed`);
      console.log(`✓ docs/screenshots/${name}.gif (${rec.frames.length} overlay frames, ${((rec.t1 - rec.t0) / 1000).toFixed(1)} s)`);
    },
    /** Move the student's (real) pointer and remember where it went, to draw it in. */
    async move(to, ms = 600, click = false) {
      const from = pointer.pos();
      const n = Math.max(2, Math.round(ms / 16));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const p = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
        pointer.move(p.x, p.y);
        this.pointer.push({ t: Date.now(), x: p.x, y: p.y });
        await sleep(16);
      }
      if (click) {
        pointer.click();
        this.pointer.push({ t: Date.now(), x: to.x, y: to.y, click: true });
      }
    },
  };
}

const scenes = {
  async trace() {
    const { app, S, win, d1, displayId } = await session();
    const script = [
      { say: 'We start at the print call, with factorial of two.', line: 'print(factorial(2))', value: 'factorial(2)' },
      { say: 'First n is two.', line: 'def factorial(n):', value: 'n = 2' },
      { say: 'Two is not zero, so we skip the base case.', line: 'if n == 0:', value: '2 == 0 → False' },
      { say: 'So it returns two times factorial of one.', line: 'return n * factorial(n - 1)', value: '2 * factorial(1)' },
      { say: 'Now the call runs again, with n equal to one.', line: 'def factorial(n):', value: 'n = 1' },
    ];
    const rec = await record(app, displayId, { x: d1.bounds.x + 70, y: d1.bounds.y + 150, width: 720, height: 300 });
    await S((_e, sc) => {
      const s = globalThis.__pairwise.session;
      s.mock.afterTool.set('trace_code', (r) => ({ segments: (r.script ?? []).map((say) => ({ say })) }));
      s.mock.speakNow({ segments: [{ tool: 'trace_code', args: { question: 'what does factorial(2) return?', script: sc } }] });
    }, script);
    await waitFor(() => S(() => [...globalThis.__pairwise.session.ink.all()].filter((i) => i.chip).length >= 5), { label: 'trace drawn', timeout: 40_000 });
    await waitFor(() => S(() => !globalThis.__pairwise.session.turn && !globalThis.__pairwise.session.playback.playing), { label: 'spoken', timeout: 40_000 });
    await sleep(1500);
    await rec.stop('demo-trace');
    void win;
    await app.close();
  },

  async gestures() {
    const { app, S, win, d1, displayId } = await session();
    const rec = await record(app, displayId, { x: d1.bounds.x + 70, y: d1.bounds.y + 90, width: 720, height: 300 });
    await callTool(app, 'move_cursor', { target: 'the four lines of factorial', style: 'sweep', lines: 4, box: await S((_e, r) => {
      const fr = globalThis.__pairwise.session.modelFrame;
      const n = (v, o, s) => Math.round(((v - o) / s) * 1000);
      return [n(r.y, fr.region.y, fr.region.height), n(r.x, fr.region.x, fr.region.width), n(r.y + r.height, fr.region.y, fr.region.height), n(r.x + r.width, fr.region.x, fr.region.width)];
    }, { x: win.els.line1.x, y: win.els.line1.y, width: win.els.line4.x + win.els.line4.width - win.els.line1.x, height: win.els.line4.y + win.els.line4.height - win.els.line1.y }) });
    await sleep(3400);
    await callTool(app, 'move_cursor', { target: 'the line "return n * factorial(n - 1)"', style: 'follow_line' });
    await sleep(3200);
    await callTool(app, 'move_cursor', { target: 'the "Run" button', style: 'hover' });
    await sleep(2600);
    await rec.stop('demo-gestures');
    await app.close();
  },

  async showme() {
    const { app, S, win, d1, displayId } = await session();
    const rec = await record(app, displayId, { x: d1.bounds.x + 40, y: d1.bounds.y + 90, width: 920, height: 790 });
    await S(() => {
      const s = globalThis.__pairwise.session;
      s.mock.afterTool.set('ask_to_point', (r) => (r.on_target ? { segments: [{ say: 'Yes, exactly there!' }, { tool: 'celebrate', args: { message: 'nice!' } }] } : null));
    });
    const asked = S(() => {
      const s = globalThis.__pairwise.session;
      s.mock.speakNow({ segments: [{ say: 'Quick check.' }, { tool: 'ask_to_point', args: { question: 'Click the line where the recursion stops', answer: 'the line "if n == 0:"' } }] });
    });
    await asked;
    await waitFor(() => S(() => globalThis.__pairwise.session.quiz.asking), { label: 'asking', timeout: 10_000 });
    await sleep(1400);
    const l2 = win.els.line2;
    await rec.move({ x: l2.x + 120, y: l2.y + l2.height / 2 }, 1100);
    await sleep(350);
    await rec.move({ x: l2.x + 120, y: l2.y + l2.height / 2 }, 16, true);
    await sleep(3600);
    await rec.stop('demo-show-me', { width: 640 });
    await app.close();
  },

  async pen() {
    const { app, win, d1, displayId } = await session();
    const rec = await record(app, displayId, { x: d1.bounds.x + 50, y: d1.bounds.y + 64, width: 720, height: 326 });
    await callTool(app, 'annotate', { items: [{ kind: 'circle', target: 'the "Run" button' }] });
    await sleep(2600);
    await callTool(app, 'annotate', { items: [{ kind: 'underline', target: 'the line "def factorial(n):"' }] });
    await sleep(2200);
    await callTool(app, 'annotate', { items: [{ kind: 'arrow', target: 'the line "return 1"', text: 'base case' }] });
    await sleep(4200);
    void win;
    await rec.stop('demo-pen');
    await app.close();
  },
};

mkdirSync(out, { recursive: true });
let failed = 0;
try {
  for (const [name, run] of Object.entries(scenes)) {
    if (only && name !== only) continue;
    try {
      await run();
    } catch (e) {
      failed++;
      console.error(`✗ ${name}: ${e.message}`);
    }
  }
} finally {
  compositor.kill();
  xvfb.kill();
}
process.exit(failed ? 1 : 0);
