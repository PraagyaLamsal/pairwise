// Polish — macOS "Reduce motion" is respected (forced on here with PAIRWISE_REDUCED_MOTION=1):
// Ada's cursor moves straight and quickly instead of swooping, a celebration is just the word
// (no confetti), and the overlay knows to fade rather than slide or pop.
import { launch, main, waitFor, sleep, assert, FAKE_DISPLAYS, openTargetWindow, callTool, pointer, inkPixelsBBox } from './harness.mjs';

const { app } = await launch({ PAIRWISE_GROUNDER: 'ocr', PAIRWISE_MOCK_SCRIPT: 'none', PAIRWISE_REDUCED_MOTION: '1' });
const S = (fn, arg) => main(app, fn, arg);

try {
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  const win = await openTargetWindow(app, {
    x: d1.bounds.x + 120, y: d1.bounds.y + 140, width: 600, height: 240,
    html: '<body style="margin:0;font-family:DejaVu Sans,Arial;background:#fff"><div style="padding:24px"><button data-t="run" style="font-size:22px;padding:8px 20px">Run</button></div></body>',
  });
  pointer.move(d1.bounds.x + d1.bounds.width - 120, d1.bounds.y + d1.bounds.height - 100);
  const started = await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await S(() => globalThis.__pairwise.session.setMuted(true));
  await waitFor(() => S(() => Boolean(globalThis.__pairwise.session.modelFrame)), { label: 'a frame the model has seen' });
  const ids = await S(() => globalThis.__pairwise.platform.displays.list().map((d) => d.id));

  // The overlay is told (it would also follow the system setting by itself).
  const ov = await (async () => {
    for (let i = 0; i < 50; i++) {
      for (const w of app.windows()) if ((await w.evaluate(() => window.pw?.role === 'overlay' && window.pw.displayId).catch(() => null)) === ids[0]) return w;
      await sleep(100);
    }
    throw new Error('no overlay');
  })();
  assert.equal(await ov.evaluate(() => document.body.classList.contains('reduced-motion')), true, 'the overlay is in reduced-motion mode');

  // --- the cursor goes straight there, quickly ----------------------------------------------
  await S(() => {
    globalThis.__flights = [];
    globalThis.__pairwise.session.cursor.on('flight', (f) => globalThis.__flights.push(f));
  });
  const r = await callTool(app, 'point_at', { target: 'the "Run" button', label: 'Run button' });
  assert.equal(r.response.found, true, JSON.stringify(r.response));
  await waitFor(() => S(() => globalThis.__pairwise.session.cursor.currentMode === 'parked'), { label: 'landed', timeout: 6000 });
  const flights = await S(() => globalThis.__flights);
  assert.ok(flights.length >= 1, 'it moved');
  for (const f of flights) {
    assert.ok(f.duration <= 260, `a short move (${f.duration} ms)`);
    const mid = { x: (f.from.x + f.to.x) / 2, y: (f.from.y + f.to.y) / 2 };
    assert.ok(Math.hypot(f.ctrl.x - mid.x, f.ctrl.y - mid.y) < 0.5, 'in a straight line, no swoop');
  }
  const tip = await S(() => globalThis.__pairwise.session.cursor.position);
  const run = win.els.run;
  assert.ok(tip.x >= run.x && tip.x <= run.x + run.width && tip.y >= run.y && tip.y <= run.y + run.height, `and still lands on the button ${JSON.stringify(tip)}`);

  // --- a celebration is only the word --------------------------------------------------------
  await callTool(app, 'clear_drawings', { who: 'all' });
  await sleep(900);
  const at = { x: d1.bounds.x + 760, y: d1.bounds.y + 520 };
  await S((_e, p) => globalThis.__pairwise.session.visual.celebrate('nice!', p), at);
  await sleep(380);
  const color = await S(() => globalThis.__pairwise.settings.get().tutorColor);
  const box = await inkPixelsBBox(app, ids[0], color, { x: at.x - 260, y: at.y - 240, width: 520, height: 480 });
  assert.ok(box.pixels > 30, `the word is drawn (${box.pixels} px)`);
  assert.ok(box.width < 110 && box.height < 50, `and nothing else: no confetti (${Math.round(box.width)}×${Math.round(box.height)} px of colour)`);

  console.log(`reduced motion: ${flights.length} straight flight(s), longest ${Math.max(...flights.map((f) => f.duration))} ms; celebration ${Math.round(box.width)}×${Math.round(box.height)} px`);
  console.log('reduced motion e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
