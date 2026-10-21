// Round 2 — Ada uses her cursor as a pointer, without drawing or labels:
//  follow_line glides under a real line of code at reading pace, sweep runs down a block line
//  by line, hover rests on a button. Grounded on real pixels (OCR stands in for Gemini), checked
//  both in main and in what the overlay actually draws, and nothing is inked.
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, SCALE, openTargetWindow, callTool, screenShot, pointer } from './harness.mjs';

const { app } = await launch({ PAIRWISE_GROUNDER: 'ocr', PAIRWISE_MOCK_SCRIPT: 'none' });
const S = (fn, arg) => main(app, fn, arg);
const tag = SCALE === 2 ? '2x' : '1x';

const IDE = `<!doctype html><html><body style="margin:0;font-family:DejaVu Sans,Arial,sans-serif;background:#fff;color:#111">
<div style="display:flex;gap:14px;padding:12px 16px;background:#eef1f5;border-bottom:1px solid #ccd">
  <button data-t="run" style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">Run</button>
</div>
<pre data-t="code" style="margin:0;padding:18px 22px;font:22px/1.6 DejaVu Sans Mono,monospace">
<span data-t="line1">def factorial(n):</span>
<span data-t="line2">    if n == 0:</span>
<span data-t="line3">        return 1</span>
<span data-t="line4">    return n * factorial(n - 1)</span></pre></body></html>`;

async function overlayPage(displayId) {
  for (let i = 0; i < 50; i++) {
    for (const w of app.windows()) {
      const id = await w.evaluate(() => (window.pw?.role === 'overlay' ? window.pw.displayId : null)).catch(() => null);
      if (id === displayId) return w;
    }
    await sleep(100);
  }
  throw new Error(`no overlay page for ${displayId}`);
}

/** Sample where the cursor is (main) and where the overlay draws it, until `ms` from now. */
async function sample(ov, d, ms) {
  const out = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [m, drawn] = await Promise.all([
      S(() => ({ p: globalThis.__pairwise.session.cursor.position, mode: globalThis.__pairwise.session.cursor.currentMode })),
      ov.evaluate(() => {
        const el = document.querySelector('.buddy');
        const mt = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el?.style.transform ?? '');
        const lab = el?.querySelector('.buddy-label');
        const shown = lab && getComputedStyle(lab).display !== 'none' && lab.textContent.trim() ? getComputedStyle(lab).opacity : 0;
        return mt ? { x: Number(mt[1]) + 3, y: Number(mt[2]) + 3, label: shown } : null;
      }),
    ]);
    out.push({ t: Date.now(), ...m, drawn: drawn ? { x: d.bounds.x + drawn.x, y: d.bounds.y + drawn.y, label: Number(drawn.label) } : null });
    await sleep(40);
  }
  return out;
}

try {
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false, inkFade: 'manual' });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  const f = SCALE === 2 ? 0.62 : 1;
  const win = await openTargetWindow(app, { x: d1.bounds.x + Math.round(70 * f), y: d1.bounds.y + Math.round(90 * f), width: Math.round(860 * f), height: Math.round(420 * f), html: SCALE === 2 ? IDE.replaceAll('22px', '14px').replaceAll('20px', '13px') : IDE });
  pointer.move(d1.bounds.x + d1.bounds.width - 80, d1.bounds.y + d1.bounds.height - 60);
  const started = await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await S(() => globalThis.__pairwise.session.setMuted(true));
  await waitFor(() => S(() => Boolean(globalThis.__pairwise.session.modelFrame)), { label: 'a frame the model has seen' });
  await sleep(800);
  const ids = await S(() => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
  const ov = await overlayPage(ids[0]);
  const inkCount = () => S(() => globalThis.__pairwise.session.ink.all().length);
  const ink0 = await inkCount();
  await S(() => {
    globalThis.__glides = [];
    globalThis.__pairwise.session.cursor.on('trace', (t) => t.path && globalThis.__glides.push({ startAt: t.startAt, endAt: t.startAt + t.duration, style: t.style }));
  });
  const lastGlide = () => S(() => globalThis.__glides[globalThis.__glides.length - 1]);

  // --- 1. follow_line: under line 1, left to right, at a reading pace ----------------------
  const line = win.els.line1;
  const r1 = await callTool(app, 'move_cursor', { target: 'the line "def factorial(n):"', style: 'follow_line' });
  assert.equal(r1.response.found, true, JSON.stringify(r1.response));
  const s1 = await sample(ov, d1, 3200);
  await screenShot(app, ids[0], join(artifacts, `p12-${tag}-follow-line-screen.png`));
  const g1 = await lastGlide();
  assert.equal(g1?.style, 'read', 'a reading-pace glide');
  const during = s1.filter((s) => s.t >= g1.startAt && s.t <= g1.endAt);
  const under = during.filter((s) => s.p.y > line.y + line.height * 0.6 && s.p.y < line.y + line.height + 12 && s.p.x >= line.x - 8 && s.p.x <= line.x + line.width + 8);
  assert.equal(under.length, during.length, 'the whole glide stays just under the line');
  assert.ok(under.length >= 8, `the cursor spends time just under the line (${under.length} samples)`);
  const xs = under.map((s) => s.p.x);
  assert.ok(Math.min(...xs) < line.x + line.width * 0.15, `starts near the line's start (${Math.round(Math.min(...xs))} vs ${Math.round(line.x)})`);
  assert.ok(Math.max(...xs) > line.x + line.width * 0.85, `reaches its end (${Math.round(Math.max(...xs))} vs ${Math.round(line.x + line.width)})`);
  assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1] - 0.5), 'moves steadily left to right');
  const glideMs = under[under.length - 1].t - under[0].t;
  assert.ok(glideMs > 500, `at a reading pace, not a jump (${glideMs} ms along the line)`);
  // The overlay really draws it there (not just main's idea of it), and with no label.
  const drawnUnder = s1.filter((s) => s.drawn && s.drawn.y > line.y + line.height * 0.6 && s.drawn.y < line.y + line.height + 12 && s.drawn.x > line.x + line.width * 0.3 && s.drawn.x < line.x + line.width * 0.7);
  assert.ok(drawnUnder.length >= 2, `drawn under the middle of the line (${drawnUnder.length} samples)`);
  assert.ok(s1.every((s) => !s.drawn || s.drawn.label < 0.05 || s.mode !== 'timeline'), 'no label while gesturing');
  assert.equal(await inkCount(), ink0, 'nothing drawn');

  // --- 2. sweep: down the four lines, one stop per line, left of the text -------------------
  const code = { x: win.els.line1.x, y: win.els.line1.y, width: win.els.line4.x + win.els.line4.width - win.els.line1.x, height: win.els.line4.y + win.els.line4.height - win.els.line1.y };
  const box = await S((_e, r) => {
    const fr = globalThis.__pairwise.session.modelFrame;
    const n = (v, o, s) => Math.round(((v - o) / s) * 1000);
    return [n(r.y, fr.region.y, fr.region.height), n(r.x, fr.region.x, fr.region.width), n(r.y + r.height, fr.region.y, fr.region.height), n(r.x + r.width, fr.region.x, fr.region.width)];
  }, code);
  const r2 = await callTool(app, 'move_cursor', { target: 'the four lines of factorial', style: 'sweep', lines: 4, box });
  assert.equal(r2.response.found, true, JSON.stringify(r2.response));
  const s2 = await sample(ov, d1, 3600);
  const lines = [win.els.line1, win.els.line2, win.els.line3, win.els.line4];
  const visited = lines.map((l) => s2.filter((s) => s.p.x < code.x && s.p.x > code.x - 40 && Math.abs(s.p.y - (l.y + l.height / 2)) < l.height * 0.6).length);
  if (process.env.E2E_DEBUG) console.log(JSON.stringify({ code, lines, s2: s2.map((s) => [s.t - s2[0].t, Math.round(s.p.x), Math.round(s.p.y), s.mode]) }));
  assert.ok(visited.every((n) => n >= 2), `rests on every line (${visited})`);
  await screenShot(app, ids[0], join(artifacts, `p12-${tag}-sweep-screen.png`));
  assert.equal(await inkCount(), ink0, 'still nothing drawn');

  // --- 3. hover: rests on the Run button, no ring, no label ---------------------------------
  const r3 = await callTool(app, 'move_cursor', { target: 'the "Run" button', style: 'hover' });
  assert.equal(r3.response.found, true, JSON.stringify(r3.response));
  await waitFor(() => S(() => globalThis.__pairwise.session.cursor.currentMode === 'parked'), { label: 'hover landed', timeout: 6000 });
  const tip = await S(() => globalThis.__pairwise.session.cursor.position);
  const run = win.els.run;
  assert.ok(tip.x >= run.x && tip.x <= run.x + run.width && tip.y >= run.y && tip.y <= run.y + run.height, `rests on Run ${JSON.stringify(tip)}`);
  assert.equal(await inkCount(), ink0, 'no ring, no marks');
  const presence = await S(() => globalThis.__pairwise.session.cursor.presence);
  assert.equal(presence, 'active', 'full strength while it means something');
  await screenShot(app, ids[0], join(artifacts, `p12-${tag}-hover-screen.png`));
  console.log(`gestures (${tag}): followed ${Math.round(Math.max(...xs) - Math.min(...xs))} px of a ${Math.round(line.width)} px line in ${glideMs} ms; swept lines ${visited}; hovered Run`);
  console.log(`round 2 gestures e2e (${tag}): all checks passed`);
} finally {
  await app.close().catch(() => undefined);
}
