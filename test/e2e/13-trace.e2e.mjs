// Polish — trace_code: Ada steps through code like a debugger. As each line of the script is
// spoken, her cursor goes to that line and a value chip ("n = 2") is typed just after where the
// line's text really ends; a line that runs again gets its new value in place. Grounded on real
// pixels (OCR stands in for Gemini) and measured on what the overlay draws.
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, SCALE, openTargetWindow, screenShot, pointer, inkPixelsBBox } from './harness.mjs';

const { app } = await launch({ PAIRWISE_GROUNDER: 'ocr', PAIRWISE_MOCK_SCRIPT: 'none' });
const S = (fn, arg) => main(app, fn, arg);
const tag = SCALE === 2 ? '2x' : '1x';

const IDE = `<!doctype html><html><body style="margin:0;font-family:DejaVu Sans,Arial,sans-serif;background:#fff;color:#111">
<div style="display:flex;gap:14px;padding:12px 16px;background:#eef1f5;border-bottom:1px solid #ccd">
  <button style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">Run</button>
</div>
<pre style="margin:0;padding:18px 22px;font:22px/1.6 DejaVu Sans Mono,monospace">
<span data-t="line1">def factorial(n):</span>
<span data-t="line2">    if n == 0:</span>
<span data-t="line3">        return 1</span>
<span data-t="line4">    return n * factorial(n - 1)</span>

<span data-t="line6">print(factorial(2))</span></pre></body></html>`;

const SCRIPT = [
  { say: 'We start at the print call, with factorial of two.', line: 'print(factorial(2))', value: 'factorial(2)' },
  { say: 'First n is two.', line: 'def factorial(n):', value: 'n = 2' },
  { say: 'Two is not zero, so we skip the base case.', line: 'if n == 0:', value: '2 == 0 → False' },
  { say: 'So it returns two times factorial of one.', line: 'return n * factorial(n - 1)', value: '2 * factorial(1)' },
  { say: 'Now the call runs again with n equal to one.', line: 'def factorial(n):', value: 'n = 1' },
];

try {
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false, inkFade: 'manual' });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  const f = SCALE === 2 ? 0.62 : 1;
  const win = await openTargetWindow(app, { x: d1.bounds.x + Math.round(70 * f), y: d1.bounds.y + Math.round(90 * f), width: Math.round(940 * f), height: Math.round(470 * f), html: SCALE === 2 ? IDE.replaceAll('22px', '14px').replaceAll('20px', '13px') : IDE });
  pointer.move(d1.bounds.x + d1.bounds.width - 80, d1.bounds.y + d1.bounds.height - 60);
  const started = await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await S(() => globalThis.__pairwise.session.setMuted(true));
  await waitFor(() => S(() => Boolean(globalThis.__pairwise.session.modelFrame)), { label: 'a frame the model has seen' });
  await sleep(800);
  const ids = await S(() => globalThis.__pairwise.platform.displays.list().map((d) => d.id));

  // Tesseract (standing in for Gemini) reads "0:" at 2× with too little confidence to match it:
  // that one line is given by its box in the latest frame instead of its text.
  const toBox = (r) => S((_e, rr) => {
    const fr = globalThis.__pairwise.session.modelFrame;
    const n = (v, o, sz) => Math.round(((v - o) / sz) * 1000);
    return [n(rr.y, fr.region.y, fr.region.height), n(rr.x, fr.region.x, fr.region.width), n(rr.y + rr.height, fr.region.y, fr.region.height), n(rr.x + rr.width, fr.region.x, fr.region.width)];
  }, r);
  const ifBox = await toBox(win.els.line2);
  const script = SCRIPT.map((st) => (st.line === 'if n == 0:' ? { say: st.say, box: ifBox, value: st.value } : st));
  await S((_e, script) => {
    const s = globalThis.__pairwise.session;
    globalThis.__words = [];
    globalThis.__traces = [];
    s.on('tutorWords', (t) => globalThis.__words.push({ t: Date.now(), text: t }));
    // Every chip as it was added, and how replaced ones were told to go (they're dropped once faded).
    globalThis.__chips = new Map();
    s.ink.on('op', (op) => {
      if (op.op === 'add' || op.op === 'update') for (const i of op.items) if (i.chip) globalThis.__chips.set(i.id, { ...i });
    });
    s.cursor.on('trace', (tr) => globalThis.__traces.push({ startAt: tr.startAt, end: tr.startAt + tr.duration, style: tr.style ?? null, item: tr.itemId ?? null, path: tr.path ? [tr.path[0], tr.path[tr.path.length - 1]] : null }));
    s.mock.afterTool.set('trace_code', (r) => ({ segments: (r.script ?? []).map((say) => ({ say })) }));
    s.mock.speakNow({ segments: [{ say: 'Let us trace it.' }, { tool: 'trace_code', args: { question: 'what does factorial(2) return?', script } }] });
  }, script);

  // Mid-trace: the third value is being typed.
  await waitFor(() => S(() => globalThis.__chips.size >= 3), { label: 'three chips', timeout: 30_000 });
  const third = await S(() => [...globalThis.__chips.values()][2]);
  await sleep(Math.max(0, third.revealAt - Date.now()) + third.drawMs * 0.5);
  await screenShot(app, ids[0], join(artifacts, `p13-${tag}-trace-typing-screen.png`));
  await waitFor(() => S(() => !globalThis.__pairwise.session.turn && !globalThis.__pairwise.session.playback.playing), { label: 'trace spoken', timeout: 40_000, interval: 50 });
  const quietAt = Date.now();
  await sleep(1800);
  await screenShot(app, ids[0], join(artifacts, `p13-${tag}-trace-screen.png`));

  const r = await S(() => {
    const s = globalThis.__pairwise.session;
    return { chips: [...globalThis.__chips.values()], other: s.ink.all().filter((i) => !i.chip).length, words: globalThis.__words, traces: globalThis.__traces };
  });
  assert.equal(r.chips.length, SCRIPT.length, `one chip per step (${r.chips.map((c) => c.text)})`);
  assert.equal(r.other, 0, 'nothing else is drawn: no circles, rings or notes');
  const lineOf = (k) => win.els[`line${k}`];
  const want = [6, 1, 2, 4, 1];
  r.chips.sort((a, b) => a.revealAt - b.revealAt);
  if (process.env.E2E_DEBUG) console.log(JSON.stringify({ chips: r.chips.map((c) => ({ t: c.text, at: c.at })), lines: want.map((k) => lineOf(k)) }));
  r.chips.forEach((c, i) => {
    const l = lineOf(want[i]);
    assert.equal(c.text, SCRIPT[i].value);
    assert.equal(c.font, 'mono');
    const cy = c.at.y + Math.round(c.fontSize * 1.62) / 2;
    assert.ok(Math.abs(cy - (l.y + l.height / 2)) < l.height * 0.35, `chip ${i} is centred on its line (${Math.round(cy)} vs ${Math.round(l.y + l.height / 2)})`);
    assert.ok(Math.round(c.fontSize * 1.62) <= l.height + 2, `chip ${i} is no taller than its line (${c.fontSize} px text)`);
    // Just after where the text ends (the span's box is exact here), not on it and not far off.
    const gap = c.at.x - (l.x + l.width);
    assert.ok(gap >= 6 && gap <= 26, `chip ${i} starts just after the line's end (gap ${Math.round(gap)} px)`);
  });
  // The repeated line: the newer value replaced the old one, which went quickly.
  const [old, fresh] = [r.chips[1], r.chips[4]];
  assert.ok(old.fadeAt != null && old.fadeAt <= fresh.revealAt && old.fadeMs <= 200, `"n = 2" made way for "n = 1" (${JSON.stringify({ fadeAt: old.fadeAt, fadeMs: old.fadeMs, next: fresh.revealAt })})`);
  assert.equal(r.chips.filter((c) => c.fadeAt == null).length, SCRIPT.length - 1, 'every other chip stays');

  // Each value appears as its words are heard (never before them), typed by the cursor itself,
  // and the trace keeps up: the last value is done within ~1.5 s of Ada going quiet.
  const heard = (re) => r.words.find((w) => re.test(w.text))?.t;
  // (Captions arrive a few words at a time: one distinctive word per step.)
  const cues = [/\bprint\b/, /\bFirst\b/, /\bskip\b/, /\btimes\b/, /\bagain\b/];
  if (process.env.E2E_DEBUG) console.log(JSON.stringify({ lags: r.chips.map((c, i) => c.revealAt - (heard(cues[i]) ?? 0)), quietAt, lastChip: r.chips[r.chips.length - 1].revealAt, traces: r.traces.map((t) => [t.style, t.startAt - r.chips[0].revealAt, t.end - t.startAt]) }));
  let skimmed = 0;
  r.chips.forEach((c, i) => {
    const t = heard(cues[i]);
    assert.ok(t, `step ${i} was spoken`);
    assert.ok(c.revealAt >= t - 900, `chip ${i} waits for its words (${c.revealAt - t} ms)`);
    assert.ok(r.traces.some((tr) => tr.item === c.id && tr.startAt === c.revealAt), `the cursor types chip ${i} itself`);
    // Usually it skims the line being run first (it skips that when the speech has moved on).
    const l = lineOf(want[i]);
    const prev = r.chips[i - 1]?.revealAt ?? 0;
    const glide = r.traces.find((tr) => tr.style === 'read' && tr.startAt >= prev && tr.startAt <= c.revealAt);
    if (glide) {
      skimmed++;
      assert.ok(Math.abs(glide.path[0].y - (l.y + l.height)) < l.height * 0.6, `skims under line ${want[i]} (${Math.round(glide.path[0].y)} vs ${Math.round(l.y + l.height)})`);
      assert.ok(glide.end - glide.startAt <= 760, `briskly (${glide.end - glide.startAt} ms)`);
    }
  });
  assert.ok(skimmed >= 3, `most steps skim their line first (${skimmed} of ${r.chips.length})`);
  const last = r.chips[r.chips.length - 1];
  assert.ok(last.revealAt + last.drawMs <= quietAt + 1500, `keeps up with the speech: the last value is done ${last.revealAt + last.drawMs - quietAt} ms after Ada stops`);

  // What the student sees: each remaining chip is drawn as a pill of Ada's blue, where planned.
  const tip = await S(() => globalThis.__pairwise.session.cursor.position);
  const ignore = { x: tip.x - 4, y: tip.y - 4, width: 26, height: 30 };
  for (const c of r.chips.filter((k) => k.fadeAt == null)) {
    const h = Math.round(c.fontSize * 1.62);
    const w = Math.max(h, [...c.text].length * 0.602 * c.fontSize + c.fontSize * 0.52 * 2);
    const box = await inkPixelsBBox(app, ids[0], '#2F7BFF', { x: c.at.x - 8, y: c.at.y - 2, width: w + 16, height: h + 4 }, ignore);
    assert.ok(box.pixels > w * h * 0.35, `"${c.text}" is drawn (${box.pixels} px of blue)`);
    assert.ok(Math.abs(box.x - c.at.x) <= 3 && Math.abs(box.y - c.at.y) <= 3, `"${c.text}" is where it was placed (${Math.round(box.x)},${Math.round(box.y)} vs ${c.at.x},${c.at.y})`);
    assert.ok(Math.abs(box.width - w) <= 12, `"${c.text}" is as wide as its text (${Math.round(box.width)} vs ${Math.round(w)})`);
  }

  console.log(`trace (${tag}): ${r.chips.length} values on lines ${want.join(',')}; gaps ${r.chips.map((c, i) => Math.round(c.at.x - (lineOf(want[i]).x + lineOf(want[i]).width))).join(',')} px; "n = 2" → "n = 1" in place`);
  console.log(`trace e2e (${tag}): all checks passed`);
} finally {
  await app.close().catch(() => undefined);
}
