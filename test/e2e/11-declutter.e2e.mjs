// Round 2 — a quiet screen, like a Tuple call: lots of features, little on screen.
//  1. an idle session shows only the session pill (dimmed, collapsed) and Ada's dimmed cursor
//  2. the pill opens on hover (all the controls), closes again, can be dragged and remembers
//     where it was put on that display
//  3. no toast for things the pill already shows (mute, talk mode)
//  4. the step card is one line that opens for a moment when the step changes, and fades out of
//     the way when the student's pointer comes near; citations are chips that hide on their own
//  5. captions (off by default) are one subtle line of what Ada is saying, fading after ~4 s
//  6. hiding the pill keeps a tiny "can see" eye on screen (privacy indicator)
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, windowByRole, callTool, screenShot, pointer, openTargetWindow } from './harness.mjs';

const { app } = await launch({ PAIRWISE_MOCK_SCRIPT: 'none' });
const S = (fn, arg) => main(app, fn, arg);

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

/** What the student can actually see on an overlay: elements with size and opacity. */
const visibleOverlayUi = (ov) =>
  ov.evaluate(() => {
    const seen = [];
    for (const el of document.querySelectorAll('.ui-layer > *, .ui-layer .veil-outline span, .draw-hint, .calibration > *')) {
      const r = el.getBoundingClientRect();
      let o = 1;
      for (let e = el; e && e !== document.body; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      if (r.width > 1 && r.height > 1 && o > 0.05 && getComputedStyle(el).display !== 'none') seen.push({ cls: el.className, o: Math.round(o * 100) / 100 });
    }
    const b = document.querySelector('.buddy');
    return { ui: seen, cursor: b && !b.classList.contains('hidden') ? { presence: b.dataset.presence, opacity: Number(getComputedStyle(b).opacity) } : null };
  });

try {
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  await openTargetWindow(app, {
    x: d1.bounds.x + 70, y: d1.bounds.y + 90, width: 860, height: 420,
    html: `<body style="margin:0;font-family:DejaVu Sans,Arial;background:#fff"><div style="padding:12px 16px;background:#eef1f5;border-bottom:1px solid #ccd"><button style="font-size:20px;padding:6px 16px">Run</button></div><pre style="margin:0;padding:18px 22px;font:22px/1.6 DejaVu Sans Mono,monospace">def factorial(n):\n    if n == 0:\n        return 1\n    return n * factorial(n - 1)</pre></body>`,
  });
  pointer.move(d1.bounds.x + 640, d1.bounds.y + 620);
  const started = await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await S(() => globalThis.__pairwise.session.setMuted(true));
  const ids = await S(() => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
  const ov = await overlayPage(ids[0]);
  const hud = await windowByRole(app, 'hud');

  // --- 1. an idle session: the pill and a dimmed cursor, nothing else ------------------------
  const joined = await visibleOverlayUi(ov);
  assert.equal(joined.cursor?.presence, 'active', 'Ada says hello with her cursor when the session starts');
  await waitFor(async () => (await visibleOverlayUi(ov)).cursor?.presence !== 'active', { label: 'cursor settles', timeout: 6000 });
  await sleep(700);
  const idle = await visibleOverlayUi(ov);
  assert.deepEqual(idle.ui, [], `no cards, pills or toasts on an idle screen (${JSON.stringify(idle.ui)})`);
  assert.ok(idle.cursor && idle.cursor.opacity <= 0.36, `Ada's cursor is dimmed (${JSON.stringify(idle.cursor)})`);
  const ov2 = await visibleOverlayUi(await overlayPage(ids[1]));
  assert.deepEqual(ov2.ui, [], 'nothing on the other display either');
  const pill = await hud.evaluate(() => {
    const h = document.querySelector('.hud');
    return {
      open: h.classList.contains('open'),
      opacity: Number(getComputedStyle(h).opacity),
      width: h.getBoundingClientRect().width,
      captions: Boolean(document.querySelector('.captions')),
      notes: document.querySelectorAll('.hud-note').length,
      buttons: [...h.querySelectorAll('button')].map((b) => b.className.split(' ')[0]),
      eye: Boolean(h.querySelector('.hud-btn[aria-label*="can see"]')),
      demo: Boolean(h.querySelector('.demo-badge')),
    };
  });
  assert.equal(pill.open, false, 'the pill starts collapsed');
  assert.ok(Math.abs(pill.opacity - 0.62) < 0.05, `and dimmed while not hovered (${pill.opacity})`);
  assert.ok(pill.width < 280, `small: ${Math.round(pill.width)} px wide`);
  assert.equal(pill.captions, false, 'captions are off by default');
  assert.equal(pill.notes, 0, 'no banner under it (the demo note is a badge in the pill)');
  assert.ok(pill.demo, 'demo badge in the pill');
  assert.ok(pill.eye, 'the "can see" eye is in the pill (it replaced the separate pill)');
  assert.deepEqual(pill.buttons, ['mic', 'hud-btn', 'end'], `only mic, eye and End are buttons (${pill.buttons})`);
  const hudBounds = await S(() => globalThis.__pairwise.hud.bounds());
  assert.ok(hudBounds.width < 300 && hudBounds.height < 60, `the window is small too (${JSON.stringify(hudBounds)})`);
  await screenShot(app, ids[0], join(artifacts, 'p11-idle-session-screen.png'));
  await hud.screenshot({ path: join(artifacts, 'p11-hud-pill.png') });
  console.log(`idle session: pill ${Math.round(pill.width)} px at ${pill.opacity} opacity, cursor at ${idle.cursor.opacity}, ${idle.ui.length} other overlay elements`);

  // --- 2. hover opens it; it closes again; drag remembers the spot per display ---------------
  await hud.hover('.hud .timer');
  await waitFor(() => hud.evaluate(() => document.querySelector('.hud').classList.contains('open')), { label: 'pill opens on hover', timeout: 3000 });
  await sleep(250);
  const opened = await hud.evaluate(() => ({ more: document.querySelectorAll('.hud-more button').length, code: document.querySelector('.course-code')?.textContent, opacity: Number(getComputedStyle(document.querySelector('.hud')).opacity) }));
  assert.ok(opened.more >= 5, `all the controls are there (${opened.more})`);
  assert.equal(opened.code, 'COMP 1405');
  assert.equal(opened.opacity, 1);
  await hud.screenshot({ path: join(artifacts, 'p11-hud-open.png') });
  await hud.mouse.move(2, 2);
  await hud.evaluate(() => document.querySelector('.hud').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
  await waitFor(() => hud.evaluate(() => !document.querySelector('.hud').classList.contains('open')), { label: 'pill closes when the pointer leaves', timeout: 3000 });
  const before = await S(() => globalThis.__pairwise.hud.bounds());
  await hud.evaluate(async () => {
    await window.pw.invoke('hud:moveBy', 0, 140);
  });
  const moved = await S(() => ({ b: globalThis.__pairwise.hud.bounds(), saved: globalThis.__pairwise.settings.get().hudPositions }));
  assert.equal(moved.b.y, before.y + 140, 'dragged down');
  assert.deepEqual(moved.saved[ids[0]], { x: moved.b.x, y: moved.b.y }, 'position remembered for this display');
  await hud.evaluate(async () => {
    await window.pw.invoke('hud:moveBy', 0, -140);
  });

  // --- 3. no toast for what the pill shows --------------------------------------------------
  await S(() => globalThis.__pairwise.session.command({ type: 'toggleMute' }));
  await S(() => globalThis.__pairwise.session.command({ type: 'toggleTalkMode' }));
  await sleep(300);
  assert.equal(await S(() => globalThis.__pairwise.session.ui.toast?.text ?? null), null, 'no toast for mute or talk mode');
  assert.ok(await hud.evaluate(() => Boolean(document.querySelector('.mic .kbd'))), 'hold-to-talk shows as a key badge on the mic');
  await S(() => globalThis.__pairwise.session.command({ type: 'toggleTalkMode' }));
  await S(() => globalThis.__pairwise.session.setMuted(true));

  // --- 4. the step card: one line, opens when it changes, steps aside for the pointer --------
  await callTool(app, 'show_steps', { title: 'Run your program', steps: ['Click Run', 'Hover Debug to see its shortcut', 'Type your input in the console'] });
  await waitFor(() => ov.evaluate(() => document.querySelector('.step-card')?.classList.contains('open')), { label: 'step card opens when shown', timeout: 3000 });
  await screenShot(app, ids[0], join(artifacts, 'p11-step-card-open-screen.png'));
  await waitFor(() => ov.evaluate(() => document.querySelector('.step-card') && !document.querySelector('.step-card').classList.contains('open')), { label: 'step card folds to one line', timeout: 6000 });
  const card = await ov.evaluate(() => {
    const el = document.querySelector('.step-card');
    const r = el.getBoundingClientRect();
    return { h: r.height, w: r.width, text: el.querySelector('.step-line').textContent, x: r.x, y: r.y };
  });
  assert.ok(card.h < 40, `one line (${card.h} px)`);
  assert.match(card.text, /^1\/3\s*Click Run/);
  await screenShot(app, ids[0], join(artifacts, 'p11-step-card-line-screen.png'));
  // The pointer heads for something under the card: it fades to ~15 %.
  pointer.move(d1.bounds.x + card.x + card.w / 2 - 70, d1.bounds.y + card.y + card.h + 30);
  await waitFor(() => ov.evaluate(() => document.querySelector('.step-card').classList.contains('shy')), { label: 'step card fades near the pointer', timeout: 3000 });
  await sleep(300);
  const shy = await ov.evaluate(() => Number(getComputedStyle(document.querySelector('.step-card')).opacity));
  assert.ok(shy < 0.2, `faded to ${shy}`);
  pointer.move(d1.bounds.x + 640, d1.bounds.y + 620);
  await waitFor(() => ov.evaluate(() => !document.querySelector('.step-card').classList.contains('shy')), { label: 'and comes back when it leaves', timeout: 3000 });
  // A citation is a small chip that hides on its own.
  await S(() => {
    const s = globalThis.__pairwise.session;
    s.ui.citation = { id: 'c1', cite: 'Lecture 05 - Recursion, slide 2', snippet: 'The stopping case …', displayId: s.activeDisplayId, until: Date.now() + 5000 };
    s.pushUi();
  });
  await waitFor(() => ov.evaluate(() => Boolean(document.querySelector('.citation'))), { label: 'citation chip', timeout: 3000 });
  const chip = await ov.evaluate(() => document.querySelector('.citation').getBoundingClientRect().height);
  assert.ok(chip < 34, `a chip, not a card (${chip} px)`);
  await screenShot(app, ids[0], join(artifacts, 'p11-citation-chip-screen.png'));
  await waitFor(() => ov.evaluate(() => !document.querySelector('.citation')), { label: 'citation hides itself', timeout: 8000 });
  await S(() => {
    const s = globalThis.__pairwise.session;
    s.ui.stepCard = undefined;
    s.pushUi();
  });

  // --- 5. captions: one line of what Ada is saying, gone ~4 s later ---------------------------
  await S(() => globalThis.__pairwise.session.command({ type: 'toggleCaptions' }));
  await S(() => globalThis.__pairwise.session.mock.speakNow({ segments: [{ say: 'A recursive function calls itself on a smaller input. The stopping case ends it.' }] }));
  await hud.waitForSelector('.captions .cap.tutor', { timeout: 10_000 });
  await sleep(1200);
  const cap = await hud.evaluate(() => ({ lines: document.querySelectorAll('.captions .cap').length, text: document.querySelector('.captions .what').textContent, h: document.querySelector('.captions').getBoundingClientRect().height }));
  assert.equal(cap.lines, 1, 'one line');
  assert.ok(cap.h < 30, `a single subtle line (${cap.h} px)`);
  await hud.screenshot({ path: join(artifacts, 'p11-hud-caption.png') });
  await waitFor(() => S(() => !globalThis.__pairwise.session.playback.playing && !globalThis.__pairwise.session.turn), { label: 'Ada finished', timeout: 20_000 });
  await waitFor(() => hud.evaluate(() => !document.querySelector('.captions')), { label: 'caption fades after ~4 s', timeout: 7000 });
  await S(() => globalThis.__pairwise.session.command({ type: 'toggleCaptions' }));

  // --- 6. hiding the pill keeps the privacy eye on screen -------------------------------------
  await S(() => globalThis.__pairwise.session.command({ type: 'toggleHud' }));
  await waitFor(() => ov.evaluate(() => Boolean(document.querySelector('.vision-dot'))), { label: 'tiny can-see eye when the pill is hidden', timeout: 3000 });
  await S(() => globalThis.__pairwise.session.command({ type: 'toggleHud' }));
  await waitFor(() => ov.evaluate(() => !document.querySelector('.vision-dot')), { label: 'gone again with the pill back', timeout: 3000 });

  console.log('round 2 declutter e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
