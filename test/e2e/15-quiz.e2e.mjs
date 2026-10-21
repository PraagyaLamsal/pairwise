// Polish — "Show me" (ask_to_point): Ada asks the student to click the answer on their own
// screen. The overlays take that one click with a real OS click (it never reaches the app
// underneath), mark it with the student's highlight ring, and tell Ada whether it was on the
// answer she had in mind. A wrong click says how far off it was; Esc skips.
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, openTargetWindow, callTool, screenShot, pointer } from './harness.mjs';

const { app } = await launch({ PAIRWISE_GROUNDER: 'ocr', PAIRWISE_MOCK_SCRIPT: 'none' });
const S = (fn, arg) => main(app, fn, arg);

const IDE = `<!doctype html><html><body style="margin:0;font-family:DejaVu Sans,Arial,sans-serif;background:#fff;color:#111">
<div style="display:flex;gap:14px;padding:12px 16px;background:#eef1f5;border-bottom:1px solid #ccd">
  <button data-t="run" onclick="window.runs=(window.runs||0)+1" style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">Run</button>
</div>
<pre style="margin:0;padding:18px 22px;font:22px/1.6 DejaVu Sans Mono,monospace">
<span data-t="line1">def factorial(n):</span>
<span data-t="line2">    if n == 0:</span>
<span data-t="line3">        return 1</span>
<span data-t="line4">    return n * factorial(n - 1)</span></pre></body></html>`;

const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

try {
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false, inkFade: 'manual' });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  const win = await openTargetWindow(app, { x: d1.bounds.x + 70, y: d1.bounds.y + 90, width: 860, height: 420, html: IDE });
  pointer.move(d1.bounds.x + d1.bounds.width - 80, d1.bounds.y + d1.bounds.height - 60);
  const started = await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await S(() => globalThis.__pairwise.session.setMuted(true));
  await waitFor(() => S(() => Boolean(globalThis.__pairwise.session.modelFrame)), { label: 'a frame the model has seen' });
  await sleep(600);
  const ids = await S(() => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
  const overlays = [];
  for (let i = 0; i < 50 && overlays.length < ids.length; i++) {
    overlays.length = 0;
    for (const w of app.windows()) if ((await w.evaluate(() => window.pw?.role === 'overlay').catch(() => false))) overlays.push(w);
    await sleep(100);
  }
  const answering = () => Promise.all(overlays.map((o) => o.evaluate(() => document.body.classList.contains('answering'))));
  const runs = () => S((_e, id) => globalThis.__targets.find((w) => w.id === id).webContents.executeJavaScript('window.runs || 0'), win.id);
  const ask = (args) => {
    const p = callTool(app, 'ask_to_point', args);
    return { done: p };
  };

  // --- 1. the right answer ---------------------------------------------------------------------
  const q1 = ask({ question: 'Click the line where the recursion stops', answer: 'the line "if n == 0:"' });
  await waitFor(async () => (await answering()).every(Boolean), { label: 'every display takes the answer', timeout: 10_000 });
  await sleep(300); // the question fades in
  const chip = await overlays[0].evaluate(() => {
    const c = document.querySelector('.answer-hint');
    return { text: c.textContent, opacity: Number(getComputedStyle(c).opacity), cursor: getComputedStyle(document.querySelector('.draw-surface')).cursor };
  });
  assert.ok(chip.text.includes('Click the line where the recursion stops') && chip.text.includes('Esc'), `the question is on screen in one line (${chip.text})`);
  assert.ok(chip.opacity > 0.9, 'and visible');
  assert.ok(/url\(/.test(chip.cursor), 'with a target cursor');
  assert.equal(await S(() => globalThis.__pairwise.session.snapshot.activity), 'waiting', 'Ada waits');
  await screenShot(app, ids[0], join(artifacts, 'p15-asking-screen.png'));
  const c2 = centre(win.els.line2);
  pointer.move(c2.x, c2.y);
  await sleep(120);
  pointer.click();
  const r1 = (await q1.done).response;
  assert.equal(r1.clicked, true, JSON.stringify(r1));
  assert.equal(r1.on_target, true, `on the answer (${JSON.stringify(r1)})`);
  assert.ok(r1.at && Number.isFinite(r1.at.x) && Number.isFinite(r1.at.y), 'with where they clicked, for the tutor');
  assert.deepEqual(await answering(), overlays.map(() => false), 'one click only: the overlays let clicks through again');
  const ring = await S(() => globalThis.__pairwise.session.ink.all().find((i) => i.author === 'student' && i.kind === 'ring'));
  assert.ok(ring && Math.hypot(ring.at.x - c2.x, ring.at.y - c2.y) < 3, `their click is marked with their highlight ring (${JSON.stringify(ring?.at)})`);
  // When she's pleased, the celebration goes off where they clicked (not where her cursor is).
  const cel = await S(() => {
    const s = globalThis.__pairwise.session;
    const send = s.overlays.send.bind(s.overlays);
    let at = null;
    s.overlays.send = (ch, payload, id) => {
      if (ch === 'overlay:celebrate') at = payload.at;
      return send(ch, payload, id);
    };
    s.visual.celebrate('nice!');
    s.overlays.send = send;
    return at;
  });
  assert.ok(cel && Math.hypot(cel.x - c2.x, cel.y - c2.y) < 3, `the celebration is at their answer (${JSON.stringify(cel)})`);
  await sleep(450);
  await screenShot(app, ids[0], join(artifacts, 'p15-answered-screen.png'));

  // --- 2. a wrong answer says how far off it was ---------------------------------------------
  const q2 = ask({ question: 'Click the button that runs the code', answer: 'the "Run" button' });
  await waitFor(async () => (await answering()).every(Boolean), { label: 'asking again', timeout: 10_000 });
  const c4 = centre(win.els.line4);
  pointer.move(c4.x, c4.y);
  await sleep(120);
  pointer.click();
  const r2 = (await q2.done).response;
  assert.equal(r2.clicked, true);
  assert.equal(r2.on_target, false, JSON.stringify(r2));
  assert.ok(r2.off_by_px > 60, `off by ${r2.off_by_px} px`);

  // --- 3. the click never reaches the app underneath -----------------------------------------
  const q3 = ask({ question: 'Click the button that runs the code', answer: 'the "Run" button' });
  await waitFor(async () => (await answering()).every(Boolean), { label: 'asking a third time', timeout: 10_000 });
  const cr = centre(win.els.run);
  pointer.move(cr.x, cr.y);
  await sleep(120);
  pointer.click();
  const r3 = (await q3.done).response;
  assert.equal(r3.on_target, true, JSON.stringify(r3));
  assert.equal(await runs(), 0, 'the Run button itself was not pressed');
  // …and afterwards clicks go through as usual.
  await sleep(200);
  pointer.click();
  await waitFor(async () => (await runs()) === 1, { label: 'a normal click reaches the app again', timeout: 3000 });

  // --- 4. Esc skips --------------------------------------------------------------------------
  const q4 = ask({ question: 'Click where n gets smaller' });
  await waitFor(async () => (await answering()).every(Boolean), { label: 'asking a fourth time', timeout: 10_000 });
  await S(() => globalThis.__pairwise.hotkeys.emit('escape'));
  const r4 = (await q4.done).response;
  assert.deepEqual([r4.clicked, r4.skipped], [false, true], JSON.stringify(r4));
  assert.deepEqual(await answering(), overlays.map(() => false), 'and the screen is back to normal');

  console.log(`show me: right answer on target, wrong one ${r2.off_by_px} px off, the app underneath untouched, Esc skips`);
  console.log('show-me e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
