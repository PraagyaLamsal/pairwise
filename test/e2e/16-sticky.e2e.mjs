// Polish — sticky ink: Ada's marks stay with what they mark. Scroll the code and her circle and
// value chip move with their lines (through the real screen stream and the engine's tracker);
// a still screen, or the student's pointer resting on a mark, moves nothing; another page in
// front of the code hides them until it's back; drag the window and they go with it.
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, openTargetWindow, screenShot, pointer } from './harness.mjs';

const { app } = await launch({ PAIRWISE_MOCK_SCRIPT: 'none' });
const S = (fn, arg) => main(app, fn, arg);

// An editor with a scrolling code pane (distinct lines, so a scroll can't be mistaken).
const CODE = [
  'def factorial(n):',
  '    """Return n! for n >= 0."""',
  '    if n == 0:',
  '        return 1',
  '    return n * factorial(n - 1)',
  '',
  'def fib(k):',
  '    a, b = 0, 1',
  '    for _ in range(k):',
  '        a, b = b, a + b',
  '    return a',
  '',
  'class Counter:',
  '    def __init__(self):',
  '        self.count = 0',
  '    def bump(self, by=1):',
  '        self.count += by',
  '        return self.count',
  '',
  'if __name__ == "__main__":',
  '    print(factorial(5), fib(10))',
  '    c = Counter()',
  '    for i in range(3):',
  '        c.bump(i)',
  '    print("count:", c.count)',
  '# the end of the file, with a long comment line',
];
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const d1 = FAKE_DISPLAYS[0];
const winSize = { width: Math.min(860, d1.bounds.width - 140), height: Math.min(470, d1.bounds.height - 110) };
const IDE = `<!doctype html><html><body style="margin:0;font-family:DejaVu Sans,Arial,sans-serif;background:#fff;color:#111">
<div style="padding:10px 16px;background:#eef1f5;border-bottom:1px solid #ccd;font-size:16px">main.py</div>
<pre id="code" style="margin:0;height:${winSize.height - 50}px;overflow:auto;padding:14px 22px;font:20px/1.5 DejaVu Sans Mono,monospace">${CODE.map((l, i) => `<span data-t="l${i}">${esc(l) || ' '}</span>`).join('\n')}</pre></body></html>`;
const OTHER = `<!doctype html><html><body style="margin:0;background:#f6f3ea;font:28px/1.4 DejaVu Serif,serif;color:#333;padding:40px">
<h1 style="margin:0 0 16px">Course notes — week 4</h1><p>Recursion: a function that calls itself on a smaller input,
until it reaches a case it can answer directly.</p><p>Iteration: a loop that updates state until a condition holds.</p></body></html>`;

try {
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false, inkFade: 'manual' });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const win = await openTargetWindow(app, { x: d1.bounds.x + 70, y: d1.bounds.y + 90, ...winSize, html: IDE });
  pointer.move(d1.bounds.x + d1.bounds.width - 60, d1.bounds.y + d1.bounds.height - 40);
  const started = await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await S(() => globalThis.__pairwise.session.setMuted(true));
  await sleep(800);
  const id = await S(() => globalThis.__pairwise.platform.displays.list()[0].id);

  // Ada circles `if n == 0:` and puts a value chip after `return n * factorial(n - 1)`.
  const l2 = win.els.l2;
  const l4 = win.els.l4;
  await S((_e, o) => {
    const s = globalThis.__pairwise.session;
    const now = Date.now();
    const common = { author: 'tutor', color: '#2F7BFF', surface: 'screen', group: 'turn-1', fadeAt: null };
    s.addInk([
      { ...common, id: 'circle', kind: 'circle', rect: o.l2, revealAt: now, drawMs: 600, seed: 4, label: 'if n == 0:' },
      { ...common, id: 'chip', kind: 'text', chip: true, font: 'mono', fontSize: 13.5, text: 'returns 6', at: { x: o.l4.x + o.l4.width + 14, y: Math.round(o.l4.y + o.l4.height / 2 - 11) }, revealAt: now + 200, drawMs: 500, seed: 5 },
    ]);
  }, { l2, l4 });
  const marks = () => S(() => Object.fromEntries(globalThis.__pairwise.session.ink.all().map((i) => [i.id, { y: i.rect?.y ?? i.at?.y, fadeAt: i.fadeAt, slide: i.slide ?? null }])));
  const start = await marks();
  await sleep(1200);
  await screenShot(app, id, join(artifacts, `p16-${d1.scaleFactor}x-marked-screen.png`));

  // --- 1. a still screen moves nothing ------------------------------------------------------
  await sleep(2000);
  let m = await marks();
  assert.equal(m.circle.y, start.circle.y, 'still screen: the circle stays');
  assert.equal(m.chip.y, start.chip.y, 'and the chip');
  assert.equal(m.circle.fadeAt, null, 'and nothing clears');

  // --- 2. the student's pointer resting on the circled line moves nothing --------------------
  pointer.move(l2.x + 40, l2.y + l2.height / 2);
  await sleep(2000);
  m = await marks();
  assert.equal(m.circle.y, start.circle.y, 'their pointer on the line: the circle stays');
  assert.equal(m.circle.fadeAt, null, 'and stays up');
  pointer.move(d1.bounds.x + d1.bounds.width - 60, d1.bounds.y + d1.bounds.height - 40);

  // --- 3. scrolling the code: the marks move with their lines --------------------------------
  const scrollTo = (top) => S((_e, o) => globalThis.__targets.find((w) => w.id === o.id).webContents.executeJavaScript(`document.getElementById('code').scrollTop = ${o.top}; document.getElementById('code').scrollTop`), { id: win.id, top });
  const scrolled = await scrollTo(60);
  assert.equal(scrolled, 60, 'the code pane scrolled');
  await waitFor(async () => Math.abs((await marks()).circle.y - (start.circle.y - 60)) <= 2, { label: 'the circle follows its line up', timeout: 4000, interval: 100 });
  m = await marks();
  assert.ok(Math.abs(m.chip.y - (start.chip.y - 60)) <= 2, `the chip too (${m.chip.y} vs ${start.chip.y - 60})`);
  assert.ok(m.circle.slide && m.circle.slide.dy < 0, 'gliding there');
  await sleep(700);
  await screenShot(app, id, join(artifacts, `p16-${d1.scaleFactor}x-scrolled-screen.png`));
  // …and back down part of the way.
  await scrollTo(25);
  await waitFor(async () => Math.abs((await marks()).circle.y - (start.circle.y - 25)) <= 2, { label: 'the circle follows back down', timeout: 4000, interval: 100 });
  // Settled: no drifting afterwards.
  await sleep(1500);
  m = await marks();
  assert.ok(Math.abs(m.circle.y - (start.circle.y - 25)) <= 2, `settled where the line is (${m.circle.y})`);
  assert.equal(m.circle.fadeAt, null, 'still up');

  // --- 3c. a mark whose line scrolls out of view is parked, and comes back with its line -------
  const parkState = () => S(() => {
    const c = globalThis.__pairwise.session.ink.all().find((i) => i.id === 'circle');
    return c ? { y: c.rect.y, parked: Boolean(c.park?.on), fadeAt: c.fadeAt } : null;
  });
  await scrollTo(110);
  await waitFor(async () => (await parkState())?.parked === true, { label: 'the circle is parked when its line goes under the header', timeout: 5000, interval: 100 });
  m = await marks();
  assert.ok(Math.abs(m.chip.y - (start.chip.y - 110)) <= 2, `the chip, still in view, follows (${m.chip.y})`);
  assert.equal((await parkState()).fadeAt, null, 'parked, not cleared');
  await screenShot(app, id, join(artifacts, `p16-${d1.scaleFactor}x-parked-screen.png`));
  await scrollTo(25);
  await waitFor(async () => (await parkState())?.parked === false, { label: 'the circle comes back with its line', timeout: 5000, interval: 100 });
  const back = await parkState();
  assert.ok(Math.abs(back.y - (start.circle.y - 25)) <= 2, `back on its line (${back.y} vs ${start.circle.y - 25})`);

  // --- 3b. scrolling mid-trace: the chips still to come land on their lines' new places ------
  // (Lines further down the file, so all of them stay in view after the second scroll.)
  await S(() => globalThis.__pairwise.session.ink.clear());
  await scrollTo(90);
  await waitFor(() => S(() => Boolean(globalThis.__pairwise.session.modelFrame)), { label: 'a frame the model has seen' });
  await sleep(600);
  const toBox = (r) => S((_e, rr) => {
    const fr = globalThis.__pairwise.session.modelFrame;
    const n = (v, o, sz) => Math.round(((v - o) / sz) * 1000);
    return [n(rr.y, fr.region.y, fr.region.height), n(rr.x, fr.region.x, fr.region.width), n(rr.y + rr.height, fr.region.y, fr.region.height), n(rr.x + rr.width, fr.region.x, fr.region.width)];
  }, r);
  const up = (r, by) => ({ ...r, y: r.y - by });
  const LINES = { l6: up(win.els.l6, 90), l8: up(win.els.l8, 90), l10: up(win.els.l10, 90) };
  const STEPS = [
    { say: 'We call fib with three, so k is three.', line: 'l6', value: 'k = 3' },
    { say: 'The loop runs three times.', line: 'l8', value: '_ = 0, 1, 2' },
    { say: 'After the loop, a is two, and that is what it returns.', line: 'l10', value: 'returns 2' },
    { say: 'And if we call it again with four, k is four.', line: 'l6', value: 'k = 4' },
  ];
  const script = [];
  for (const st of STEPS) script.push({ say: st.say, box: await toBox(LINES[st.line]), value: st.value });
  await S((_e, script) => {
    const s = globalThis.__pairwise.session;
    globalThis.__chips = new Map();
    s.ink.on('op', (op) => {
      if (op.op === 'add' || op.op === 'update') for (const i of op.items) if (i.chip) globalThis.__chips.set(i.id, { ...i });
    });
    s.mock.afterTool.set('trace_code', (r) => ({ segments: (r.script ?? []).map((say) => ({ say })) }));
    s.mock.speakNow({ segments: [{ say: 'Let us trace it.' }, { tool: 'trace_code', args: { question: 'what does factorial(3) do?', script } }] });
  }, script);
  await waitFor(() => S(() => [...globalThis.__chips.values()].filter((c) => c.revealAt + c.drawMs < Date.now()).length >= 2), { label: 'two chips typed', timeout: 30_000 });
  await scrollTo(150);
  await waitFor(() => S(() => !globalThis.__pairwise.session.turn && !globalThis.__pairwise.session.playback.playing), { label: 'trace spoken', timeout: 40_000, interval: 50 });
  await sleep(1500);
  const chips = await S(() => [...globalThis.__chips.values()].map((c) => ({ text: c.text, y: c.at.y, h: Math.round(c.fontSize * 1.62) })));
  assert.equal(chips.length, 4, JSON.stringify(chips));
  for (const st of STEPS) {
    const c = chips.find((x) => x.text === st.value);
    const line = LINES[st.line];
    const want = line.y - 60 + line.height / 2;
    assert.ok(c && Math.abs(c.y + c.h / 2 - want) <= 4, `"${st.value}" is beside its line after the scroll (${c && c.y + c.h / 2} vs ${want})`);
  }
  await screenShot(app, id, join(artifacts, `p16-${d1.scaleFactor}x-trace-scrolled-screen.png`));

  // --- 4. another tab in front of the code: the marks hide; back to the code, they come back ---
  // (Switching the window's page, like a browser tab: in this test display a newly opened window
  // is composited under the older ones, so covering the code with one isn't seen.)
  await S((_e, o) => globalThis.__targets.find((w) => w.id === o.id).webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(o.html)}`), { id: win.id, html: OTHER });
  const shown = () => S(() => globalThis.__pairwise.session.ink.all().filter((i) => (i.fadeAt == null || i.fadeAt > Date.now()) && !i.park?.on));
  assert.ok((await shown()).length >= 3, 'the trace is on screen');
  await waitFor(async () => (await shown()).length === 0, { label: 'the marks hide when what they marked is gone', timeout: 6000, interval: 150 });
  await screenShot(app, id, join(artifacts, `p16-${d1.scaleFactor}x-switched-screen.png`));
  // Back to the code (the page reloads at the top, 150 px from where the marks were): the
  // chips come back, each beside its line.
  await S((_e, o) => globalThis.__targets.find((w) => w.id === o.id).webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(o.html)}`), { id: win.id, html: IDE });
  await waitFor(async () => (await shown()).length >= 3, { label: 'the marks come back with the code', timeout: 8000, interval: 150 });
  await sleep(500);
  for (const c of (await shown()).filter((i) => i.chip)) {
    const st = STEPS.find((x) => x.value === c.text);
    const line = win.els[st.line];
    const mid = c.at.y + Math.round(c.fontSize * 1.62) / 2;
    assert.ok(Math.abs(mid - (line.y + line.height / 2)) <= 4, `"${c.text}" is back beside its line (${mid} vs ${line.y + line.height / 2})`);
  }
  await screenShot(app, id, join(artifacts, `p16-${d1.scaleFactor}x-back-screen.png`));

  // --- 5. dragging the window: the marks go with it, sideways too ------------------------------
  const before = (await shown()).filter((i) => i.chip);
  const b0 = await S((_e, wid) => globalThis.__targets.find((w) => w.id === wid).getBounds(), win.id);
  const drag = { x: -30, y: -24 };
  for (let i = 1; i <= 8; i++) {
    await S((_e, o) => globalThis.__targets.find((w) => w.id === o.id).setBounds({ ...o.b, x: Math.round(o.b.x + o.dx * o.t), y: Math.round(o.b.y + o.dy * o.t) }), { id: win.id, b: b0, dx: drag.x, dy: drag.y, t: i / 8 });
    await sleep(60);
  }
  await sleep(2500);
  const after = (await shown()).filter((i) => i.chip);
  assert.equal(after.length, before.length, `every chip still shows after the drag (${after.length} of ${before.length})`);
  for (const c of after) {
    const was = before.find((i) => i.id === c.id);
    const off = { x: c.at.x - was.at.x, y: c.at.y - was.at.y };
    assert.ok(Math.abs(off.x - drag.x) <= 2 && Math.abs(off.y - drag.y) <= 2, `"${c.text}" went with the window (moved ${off.x}, ${off.y}; the window ${drag.x}, ${drag.y})`);
  }
  await screenShot(app, id, join(artifacts, `p16-${d1.scaleFactor}x-dragged-screen.png`));

  console.log('sticky ink: still and pointer-over → unchanged; scrolled 60 px up and 35 back → marks followed (±2 px); a line under the header → parked, back with it; scrolled mid-trace → later chips on their lines; another page → hidden, and back with the code; the window dragged → the chips went with it (±2 px)');
  console.log(`sticky ink e2e (${d1.scaleFactor}x): all checks passed`);
} finally {
  await app.close().catch(() => undefined);
}
