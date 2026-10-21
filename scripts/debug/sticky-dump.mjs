// Debugging sticky ink: the README's sticky scene (a trace, then the code scrolls DOWN px and
// back), with every look the engine's tracker takes dumped for scripts/debug/replay-track.mts.
// Run it inside Xvfb + xcompmgr, after `npm run build`, as the e2e tests run:
//   Xvfb :97 -screen 0 2560x1440x24 -ac +extension RANDR +extension Composite -nolisten tcp &
//   DISPLAY=:97 xcompmgr -n &
//   DISPLAY=:97 DUMP_DIR=/tmp/dump DOWN=120 node scripts/debug/sticky-dump.mjs
// DRAG=70,40 then drags the window by that much (as the README demo does), with a smaller
// window so there's room.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, main, waitFor, sleep, FAKE_DISPLAYS, openTargetWindow, pointer, windowByRole } from '../../test/e2e/harness.mjs';

const OUT = process.env.DUMP_DIR ?? '/tmp/pairwise-track-dump';
const DOWN = Number(process.env.DOWN ?? 120);
const DRAG = process.env.DRAG ? process.env.DRAG.split(',').map(Number) : null;
const LONG = [
  'def fib(k):',
  '    """The k-th Fibonacci number."""',
  '    a, b = 0, 1',
  '    for _ in range(k):',
  '        a, b = b, a + b',
  '    return a',
  '',
  'def factorial(n):',
  '    if n == 0:',
  '        return 1',
  '    return n * factorial(n - 1)',
  '',
  'class Counter:',
  '    def __init__(self):',
  '        self.count = 0',
  '    def bump(self, by=1):',
  '        self.count += by',
  '        return self.count',
  '',
  'print(fib(3), factorial(3))',
];
const SCROLLING = `<!doctype html><html><body style="margin:0;font-family:DejaVu Sans,Arial,sans-serif;background:#fff;color:#111">
<div style="padding:10px 16px;background:#eef1f5;border-bottom:1px solid #ccd;font-size:16px">main.py</div>
<pre id="code" style="margin:0;height:${DRAG ? 300 : 330}px;overflow:auto;padding:14px 22px;font:20px/1.5 DejaVu Sans Mono,monospace">${LONG.map((l, i) => `<span data-t="l${i}">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || ' '}</span>`).join('\n')}</pre></body></html>`;

const { app, userData } = await launch({ PAIRWISE_GROUNDER: 'ocr', PAIRWISE_MOCK_SCRIPT: 'none' });
const S = (fn, arg) => main(app, fn, arg);
try {
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false, inkFade: 'manual' });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  const win = await openTargetWindow(app, { x: d1.bounds.x + 70, y: d1.bounds.y + 90, ...(DRAG ? { width: 620, height: 340 } : { width: 760, height: 380 }), html: SCROLLING });
  pointer.move(d1.bounds.x + 760, d1.bounds.y + 600);
  await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await S(() => globalThis.__pairwise.session.setMuted(true));
  await waitFor(() => S(() => Boolean(globalThis.__pairwise.session.modelFrame)), { label: 'frame' });
  await sleep(3000);
  const engine = await windowByRole(app, 'engine');
  const box = (r) => S((_e, rr) => {
    const fr = globalThis.__pairwise.session.modelFrame;
    const n = (v, o, sz) => Math.round(((v - o) / sz) * 1000);
    return [n(rr.y, fr.region.y, fr.region.height), n(rr.x, fr.region.x, fr.region.width), n(rr.y + rr.height, fr.region.y, fr.region.height), n(rr.x + rr.width, fr.region.x, fr.region.width)];
  }, r);
  const script = [
    { say: 'fib of three: k is three.', box: await box(win.els.l0), value: 'k = 3' },
    { say: 'The loop runs three times.', box: await box(win.els.l3), value: '_ = 0, 1, 2' },
    { say: 'And a ends up as two, which it returns.', box: await box(win.els.l5), value: 'returns 2' },
  ];
  await S((_e, sc) => {
    const s = globalThis.__pairwise.session;
    s.mock.afterTool.set('trace_code', (r) => ({ segments: (r.script ?? []).map((say) => ({ say })) }));
    s.mock.speakNow({ segments: [{ tool: 'trace_code', args: { question: 'what does fib(3) return?', script: sc } }] });
  }, script);
  await waitFor(() => S(() => [...globalThis.__pairwise.session.ink.all()].filter((i) => i.chip).length >= 3), { label: 'trace drawn', timeout: 40_000 });
  await waitFor(() => S(() => !globalThis.__pairwise.session.turn && !globalThis.__pairwise.session.playback.playing), { label: 'spoken', timeout: 40_000 });
  await sleep(1200);
  const marks = () => S(() => globalThis.__pairwise.session.ink.all().filter((i) => i.chip).map((i) => ({ id: i.id, text: i.text, y: Math.round(i.at.y), park: i.park?.on ?? false })));
  console.log('before', JSON.stringify(await marks()));
  await engine.evaluate(() => { globalThis.__pairwiseTrackDump = []; });
  const t0 = Date.now();
  const events = [];
  const scroll = async (from, to, ms) => {
    const n = Math.max(2, Math.round(ms / 40));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const v = Math.round(from + (to - from) * (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2));
      await S((_e, o) => globalThis.__targets.find((w) => w.id === o.id).webContents.executeJavaScript(`document.getElementById('code').scrollTop = ${o.v}`), { id: win.id, v });
      events.push({ t: Date.now() - t0, scrollTop: v });
      // As the recorder does: a capture of the window after each step (slows the scroll down).
      await S(async (_e, id) => { await globalThis.__targets.find((x) => x.id === id).webContents.capturePage(); }, win.id);
      await sleep(25);
    }
  };
  await scroll(0, DOWN, 700);
  await sleep(2200);
  console.log('down', JSON.stringify(await marks()));
  await scroll(DOWN, 0, 600);
  await sleep(2400);
  console.log('up', JSON.stringify(await marks()));
  if (DRAG) {
    // By the title bar, the pointer along with it, a capture of the window after each step.
    const grab = { x: win.bounds.x + 260, y: win.bounds.y + 20 };
    pointer.move(grab.x, grab.y);
    await sleep(300);
    for (let i = 1; i <= 16; i++) {
      const t = i / 16;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const off = { x: Math.round(DRAG[0] * e), y: Math.round(DRAG[1] * e) };
      await S((_e, o) => globalThis.__targets.find((w) => w.id === o.id).setBounds({ ...o.b, x: o.b.x + o.off.x, y: o.b.y + o.off.y }), { id: win.id, b: win.bounds, off });
      events.push({ t: Date.now() - t0, drag: off });
      pointer.move(grab.x + off.x, grab.y + off.y);
      await S(async (_e, id) => { await globalThis.__targets.find((x) => x.id === id).webContents.capturePage(); }, win.id);
      await sleep(20);
    }
    await sleep(2500);
    console.log('dragged', JSON.stringify(await S(() => globalThis.__pairwise.session.ink.all().filter((i) => i.chip).map((i) => ({ text: i.text, x: Math.round(i.at.x), y: Math.round(i.at.y), park: i.park?.on ?? false, fade: i.fadeAt != null })))));
  }
  const dump = await engine.evaluate(() => {
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
    return (globalThis.__pairwiseTrackDump ?? []).map((d) => (d.gray ? { ...d, gray: b64(d.gray), mask: b64(d.mask) } : d));
  });
  mkdirSync(OUT, { recursive: true });
  const meta = dump.map((d, i) => {
    if (d.gray) {
      writeFileSync(join(OUT, `g${i}.bin`), Buffer.from(d.gray, 'base64'));
      writeFileSync(join(OUT, `m${i}.bin`), Buffer.from(d.mask, 'base64'));
    }
    return { ...d, t: d.t - t0, gray: d.gray ? `g${i}.bin` : undefined, mask: d.mask ? `m${i}.bin` : undefined };
  });
  writeFileSync(join(OUT, 'index.json'), JSON.stringify({ events, frames: meta }, null, 1));
  console.log(`dumped ${meta.length} looks to ${OUT}`);
  const log = readFileSync(join(userData, 'logs', `pairwise-${new Date().toISOString().slice(0, 10)}.log`), 'utf8');
  console.log(log.split('\n').filter((l) => /\[sticky\]/.test(l)).join('\n'));
} finally {
  await app.close();
}
