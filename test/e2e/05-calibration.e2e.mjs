// The on-device pointing-accuracy test (Settings → Setup & checks → Pointing accuracy), run
// end to end: labelled buttons on every display, each grounded on a real capture like point_at,
// scored against the buttons' true rects. Runs at 1× and 2×.
//
// Default backend is OCR (deterministic, offline). `npm run eval:grounding` runs the same test
// with Gemini (needs GEMINI_API_KEY; the Live side stays on the local mock so it costs only the
// grounding calls) and writes test/artifacts/grounding-eval-*.json.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launch, main, waitFor, sleep, artifacts, assert, SCALE, screenShot } from './harness.mjs';

const backend = process.env.PAIRWISE_EVAL_GROUNDER === 'gemini' ? 'gemini' : 'ocr';
if (backend === 'gemini' && !process.env.GEMINI_API_KEY) {
  console.log('eval:grounding needs GEMINI_API_KEY in the environment — skipping');
  process.exit(0);
}
const tag = `${backend}-${SCALE === 2 ? '2x' : '1x'}`;
const { app } = await launch({
  PAIRWISE_GROUNDER: backend,
  PAIRWISE_MOCK_SCRIPT: 'none',
  ...(backend === 'gemini' ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY, PAIRWISE_MOCK_LIVE: '1' } : {}),
});

try {
  const courseId = await main(app, () => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  // Before a session: a clear message, not a crash.
  const early = await main(app, () => globalThis.__pairwise.session.runPointingTest());
  assert.equal(early.ok, false);
  assert.match(early.error, /session/i);

  const started = await main(app, (_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await main(app, () => globalThis.__pairwise.session.setMuted(true));
  await sleep(1000);

  const pending = main(app, () => globalThis.__pairwise.session.runPointingTest());
  const ids = await main(app, () => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
  const r = await pending;
  assert.ok(r.ok, r.error);
  console.log(`pointing test (${tag}): ${r.summary}`);
  const report = await main(app, () => globalThis.__pairwise.session.lastCalibration);
  writeFileSync(join(artifacts, `grounding-eval-${tag}.json`), JSON.stringify(report, null, 2));
  for (const id of ids) await screenShot(app, id, join(artifacts, `p3-calibration-${tag}-${id}.png`));
  for (const d of report.perDisplay) {
    console.log(`  ${d.label} @${d.scaleFactor}×: ${d.hits}/${d.total} hit, mean ${d.meanErrorPx?.toFixed(1) ?? 'n/a'} px`);
    // Tesseract (the offline stand-in) occasionally misses a button label outright on the
    // small 2× display; what it finds is still pixel-exact (the mean-error check below).
    const allowed = backend === 'ocr' && SCALE === 2 ? 2 : 1;
    assert.ok(d.hits >= d.total - allowed, `${d.label}: at most ${allowed} missed (${d.hits}/${d.total})`);
  }
  // Never a confident wrong answer: anything found must be on its button.
  const wrong = report.results.filter((x) => x.found && !x.hit);
  assert.equal(wrong.length, 0, `found but off target: ${JSON.stringify(wrong)}`);
  assert.ok(report.meanErrorPx !== null && report.meanErrorPx <= 8, `average error ${report.meanErrorPx?.toFixed(1)} px ≤ 8`);
  // The results are drawn on the overlays, then cleared together with the target windows.
  await waitFor(() => main(app, () => globalThis.__pairwise.session.lastCalibration !== null), { label: 'report kept' });
  console.log(`phase 3 calibration e2e (${tag}): all checks passed`);
} finally {
  await app.close().catch(() => undefined);
}
