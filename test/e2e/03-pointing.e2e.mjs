// Phase 3 — pointing accuracy, end to end. A window with known UI is opened at a known place;
// the tutor's tools ground targets on a real screen capture (OCR stands in for Gemini so the
// test is deterministic), the cursor flies there and the pen draws — then we check the cursor
// tip and the rendered ink PIXELS against the window's real element rectangles.
// Runs at 1× and (run-e2e) again at 2× with Chromium forced to HiDPI.
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, SCALE, openTargetWindow, inkPixelsBBox, callTool, captureOverlay, pointer, screenShot } from './harness.mjs';

const tag = SCALE === 2 ? '2x' : '1x';
const { app } = await launch({ PAIRWISE_GROUNDER: 'ocr', PAIRWISE_MOCK_SCRIPT: 'none' });
const inside = (p, r, m = 0) => p.x >= r.x - m && p.y >= r.y - m && p.x <= r.x + r.width + m && p.y <= r.y + r.height + m;
const contains = (outer, inner, m = 0) => outer.x <= inner.x - m && outer.y <= inner.y - m && outer.x + outer.width >= inner.x + inner.width + m && outer.y + outer.height >= inner.y + inner.height + m;
const inflate = (r, d) => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
const report = [];

const IDE = (f) => `<!doctype html><html><body style="margin:0;font-family:DejaVu Sans,Arial,sans-serif;background:#fff;color:#111">
<div style="display:flex;gap:${14 * f}px;padding:${12 * f}px ${16 * f}px;background:#eef1f5;border-bottom:1px solid #ccd">
  <button data-t="run" style="font-size:${20 * f}px;padding:${6 * f}px ${16 * f}px;border:1px solid #889;border-radius:6px;background:#fff">Run</button>
  <button data-t="debug" style="font-size:${20 * f}px;padding:${6 * f}px ${16 * f}px;border:1px solid #889;border-radius:6px;background:#fff">Debug</button>
  <span style="flex:1"></span>
  <button data-t="submit" style="font-size:${20 * f}px;padding:${6 * f}px ${16 * f}px;border:1px solid #889;border-radius:6px;background:#fff">Submit</button>
</div>
<pre style="margin:0;padding:${18 * f}px ${22 * f}px;font:${22 * f}px/1.6 DejaVu Sans Mono,monospace">
<span data-t="line1">def <span data-t="fact">factorial</span>(n):</span>
<span data-t="line2">    if n == 0:</span>
<span data-t="line3">        return 1</span>
<span data-t="line4">    return n * factorial(n - 1)</span></pre></body></html>`;

try {
  const courseId = await main(app, () => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false, inkFade: 'manual' });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  const d2 = FAKE_DISPLAYS[1];
  const f = SCALE === 2 ? 0.62 : 1;
  const win = await openTargetWindow(app, { x: d1.bounds.x + Math.round(70 * f), y: d1.bounds.y + Math.round(90 * f), width: Math.round(860 * f), height: Math.round(420 * f), html: IDE(f) });
  const win2 = await openTargetWindow(app, {
    x: d2.bounds.x + Math.round(40 * f), y: d2.bounds.y + Math.round(80 * f), width: Math.round(380 * f), height: Math.round(200 * f),
    html: `<body style="margin:0;background:#fff;font-family:DejaVu Sans,Arial"><div style="padding:${40 * f}px"><button data-t="compile" style="font-size:${22 * f}px;padding:${8 * f}px ${18 * f}px">Compile</button></div></body>`,
  });
  pointer.move(d1.bounds.x + 40, d1.bounds.y + d1.bounds.height - 60);
  const started = await main(app, (_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await main(app, () => globalThis.__pairwise.session.setMuted(true));
  await sleep(1500);
  const ids = await main(app, () => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
  const color = await main(app, () => globalThis.__pairwise.settings.get().tutorColor);

  // --- 1. point_at: the cursor tip lands on the real button -------------------------------
  for (const [name, desc] of [['submit', 'the "Submit" button'], ['run', 'the "Run" button']]) {
    const r = await callTool(app, 'point_at', { target: desc, label: name });
    assert.equal(r.response.found, true, `${name} found (${JSON.stringify(r.response)})`);
    await waitFor(() => main(app, () => globalThis.__pairwise.session.cursor.currentMode === 'parked'), { label: `cursor landed on ${name}`, timeout: 6000 });
    const tip = await main(app, () => globalThis.__pairwise.session.cursor.position);
    const truth = win.els[name];
    assert.ok(inside(tip, truth), `cursor tip ${JSON.stringify(tip)} inside ${name} ${JSON.stringify(truth)}`);
    // Where the overlay actually drew it (DOM transform → global).
    const drawn = await (async () => {
      for (const w of app.windows()) {
        const info = await w.evaluate(() => (window.pw?.role === 'overlay' ? { id: window.pw.displayId, t: document.querySelector('.buddy')?.style.transform ?? '', hidden: document.querySelector('.buddy')?.classList.contains('hidden') } : null)).catch(() => null);
        if (info && info.id === ids[0]) return info;
      }
      return null;
    })();
    const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(drawn?.t ?? '');
    assert.ok(m && !drawn.hidden, 'cursor visible on display 1');
    const drawnTip = { x: d1.bounds.x + Number(m[1]) + 3, y: d1.bounds.y + Number(m[2]) + 3 };
    assert.ok(inside(drawnTip, truth), `drawn cursor tip ${JSON.stringify(drawnTip)} inside ${name}`);
    report.push(`${name}: tip ${Math.round(drawnTip.x - (truth.x + truth.width / 2))},${Math.round(drawnTip.y - (truth.y + truth.height / 2))} px from centre (button ${Math.round(truth.width)}×${Math.round(truth.height)})`);
  }
  await captureOverlay(app, ids[0], join(artifacts, `p3-${tag}-point.png`));
  await screenShot(app, ids[0], join(artifacts, `p3-${tag}-point-screen.png`));

  // --- 2. annotate: a circle drawn around the button encloses it (rendered pixels) ----------
  const r2 = await callTool(app, 'annotate', { items: [{ kind: 'circle', target: 'the "Submit" button' }] });
  assert.equal(r2.response.drawn, 1, JSON.stringify(r2.response));
  // Pen traces the loop, holds, then the cursor heads back to the student's pointer.
  await waitFor(() => main(app, () => globalThis.__pairwise.session.cursor.currentMode === 'follow'), { label: 'cursor done drawing', timeout: 12000 });
  await sleep(700);
  const submit = win.els.submit;
  const cur = await main(app, () => globalThis.__pairwise.session.cursor.position);
  await captureOverlay(app, ids[0], join(artifacts, `p3-${tag}-circle.png`));
  await screenShot(app, ids[0], join(artifacts, `p3-${tag}-circle-screen.png`));
  const ring = await inkPixelsBBox(app, ids[0], color, inflate(submit, 90 * f), { x: cur.x - 4, y: cur.y - 4, width: 130, height: 60 });
  assert.ok(ring.pixels > 200, `circle ink rendered (${ring.pixels} px)`);
  assert.ok(contains(ring, submit, 1), `circle ${JSON.stringify(ring)} encloses Submit ${JSON.stringify(submit)}`);
  assert.ok(contains(inflate(submit, 55 * f), ring), 'circle hugs the button (within 55 px)');
  report.push(`circle: ${Math.round(submit.x - ring.x)}/${Math.round(ring.x + ring.width - submit.x - submit.width)} px margin left/right, ${Math.round(submit.y - ring.y)}/${Math.round(ring.y + ring.height - submit.y - submit.height)} top/bottom`);

  // --- 3. underline one word inside a line of code ------------------------------------------
  await callTool(app, 'clear_drawings', { who: 'all' });
  await sleep(800);
  const r3 = await callTool(app, 'annotate', { items: [{ kind: 'underline', target: 'the word "factorial" on line 1' }] });
  assert.equal(r3.response.drawn, 1, JSON.stringify(r3.response));
  await waitFor(() => main(app, () => globalThis.__pairwise.session.cursor.currentMode === 'follow'), { label: 'cursor done underlining', timeout: 12000 });
  await sleep(700);
  const word = win.els.fact;
  const cur3 = await main(app, () => globalThis.__pairwise.session.cursor.position);
  await captureOverlay(app, ids[0], join(artifacts, `p3-${tag}-underline.png`));
  await screenShot(app, ids[0], join(artifacts, `p3-${tag}-underline-screen.png`));
  const ul = await inkPixelsBBox(app, ids[0], color, { x: word.x - 40, y: word.y + word.height * 0.4, width: word.width + 80, height: word.height }, { x: cur3.x - 4, y: cur3.y - 4, width: 130, height: 60 });
  assert.ok(ul.pixels > 40, `underline rendered (${ul.pixels} px)`);
  assert.ok(ul.y >= word.y + word.height * 0.55 && ul.y <= word.y + word.height + 14, `underline sits under the word (y ${Math.round(ul.y)} vs word ${Math.round(word.y)}–${Math.round(word.y + word.height)})`);
  assert.ok(ul.x <= word.x + 6 && ul.x + ul.width >= word.x + word.width - 6, `underline spans the word (${Math.round(ul.x)}–${Math.round(ul.x + ul.width)} vs ${Math.round(word.x)}–${Math.round(word.x + word.width)})`);
  assert.ok(ul.x >= word.x - 20 && ul.x + ul.width <= word.x + word.width + 24, 'and only that word');
  report.push(`underline: ${Math.round(word.x - ul.x)}/${Math.round(ul.x + ul.width - word.x - word.width)} px overhang`);

  // --- 4. another display: the tutor points at a button on display 2 ------------------------
  const r4 = await callTool(app, 'point_at', { target: 'the "Compile" button', display: 2 });
  assert.equal(r4.response.found, true, JSON.stringify(r4.response));
  await waitFor(() => main(app, () => globalThis.__pairwise.session.cursor.currentMode === 'parked'), { label: 'landed on display 2', timeout: 6000 });
  const tip2 = await main(app, () => globalThis.__pairwise.session.cursor.position);
  assert.ok(inside(tip2, win2.els.compile), `tip ${JSON.stringify(tip2)} inside Compile ${JSON.stringify(win2.els.compile)} on display 2`);
  await captureOverlay(app, ids[1], join(artifacts, `p3-${tag}-display2.png`));

  console.log(`pointing accuracy (${tag}):\n  ${report.join('\n  ')}`);
  console.log(`phase 3 pointing e2e (${tag}): all checks passed`);
} finally {
  await app.close().catch(() => undefined);
}
