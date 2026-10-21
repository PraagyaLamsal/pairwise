// Phase 1: onboarding → add a course → start session (overlays on every display, HUD, timer,
// hotkey-driven mute) → end session.
import { join } from 'node:path';
import { launch, main, windowByRole, waitFor, sleep, captureOverlay, artifacts, assert } from './harness.mjs';

const { app } = await launch();
try {
  const hub = await windowByRole(app, 'hub');
  await hub.setViewportSize({ width: 1060, height: 720 }).catch(() => undefined);

  // --- onboarding (first run) ---
  await hub.waitForSelector('text=A tutor that sits next to you');
  await sleep(2600); // let the illustration animate in
  await hub.screenshot({ path: join(artifacts, 'p1-onboarding-welcome.png') });
  await hub.click('text=Set it up');
  await hub.waitForSelector('text=Connect Gemini');
  await hub.screenshot({ path: join(artifacts, 'p1-onboarding-key.png') });
  await hub.click('text=Continue');
  await hub.waitForSelector('text=Three permissions');
  await sleep(400);
  await hub.screenshot({ path: join(artifacts, 'p1-onboarding-permissions.png') });
  const allowed = await hub.locator('text=Allowed').count();
  assert.equal(allowed, 3, 'fake platform reports all three permissions as allowed');
  await hub.click('text=Continue');
  await hub.waitForSelector('text=How do you want to talk?');
  await hub.click('text=Hold to talk');
  await sleep(600);
  await hub.screenshot({ path: join(artifacts, 'p1-onboarding-talk.png') });
  await hub.click('text=Hands-free');
  await hub.click('text=Continue');
  await hub.click('text=Go to my courses');

  // --- empty state + add a course ---
  await hub.waitForSelector('text=Pick a class and say hi.');
  await hub.screenshot({ path: join(artifacts, 'p1-courses-empty.png') });
  await hub.click('button:has-text("COMP 1405")');
  await hub.waitForSelector('text=Add a course >> nth=-1');
  const code = await hub.inputValue('input[placeholder="COMP 1405"]');
  assert.equal(code, 'COMP 1405');
  await hub.click(".modal-foot button:has-text(\"Add course\")");
  await hub.waitForSelector('.course-tile');
  await hub.click('.add-tile');
  await hub.fill('input[placeholder="COMP 1405"]', 'COMP 1805');
  await hub.fill('input[placeholder="Introduction to Computer Science I"]', 'Discrete Structures I');
  await hub.click(".modal-foot button:has-text(\"Add course\")");
  await waitFor(async () => (await hub.locator('.course-tile').count()) === 2, { label: 'two courses' });
  await hub.click('.course-tile >> nth=0');
  await sleep(700);
  await hub.screenshot({ path: join(artifacts, 'p1-courses.png') });

  // --- start a session ---
  await hub.click('button:has-text("Start session")');
  const snap = await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot), { label: 'live session' });
  await waitFor(async () => (await main(app, () => globalThis.__pairwise.session.snapshot.status)) === 'live', { label: 'status live' });
  assert.ok(snap.courseLabel === 'COMP 1405' || snap.courseLabel === 'COMP 1805');

  // Overlays: one per display, positioned at the display bounds, all ready.
  await waitFor(() => main(app, () => globalThis.__pairwise.session.overlays.allReady() && globalThis.__pairwise.session.overlays.displayIds().length === 2), { label: 'overlays ready' });
  const bounds = await main(app, () =>
    globalThis.__pairwise.session.overlays.displayIds().map((id) => ({ id, b: globalThis.__pairwise.session.overlays.windowFor(id).getBounds(), d: globalThis.__pairwise.platform.displays.byId(id).bounds })),
  );
  for (const o of bounds) assert.deepEqual(o.b, o.d, `overlay ${o.id} covers its display`);
  const overlayFlags = await main(app, () =>
    globalThis.__pairwise.session.overlays.displayIds().map((id) => {
      const w = globalThis.__pairwise.session.overlays.windowFor(id);
      return { onTop: w.isAlwaysOnTop(), focusable: w.isFocusable(), visible: w.isVisible() };
    }),
  );
  for (const f of overlayFlags) assert.ok(f.onTop && !f.focusable && f.visible, 'overlay is on top, non-focusable and visible');

  // HUD exists and shows the course + timer.
  const hud = await windowByRole(app, 'hud');
  await hud.waitForSelector('.hud .timer');
  await sleep(2200);
  const timer = await hud.textContent('.timer');
  assert.match(timer, /^0:0[1-9]$/, `timer ticks (${timer})`);
  await hud.screenshot({ path: join(artifacts, 'p1-hud.png') });

  // Mute via the session command (same path as the ⌃⌥M hotkey) and via a HUD click.
  await main(app, () => globalThis.__pairwise.session.command({ type: 'toggleMute' }));
  await waitFor(async () => (await hud.getAttribute('.mic', 'class')).includes('muted'), { label: 'HUD shows muted' });
  await hud.click('.mic');
  await waitFor(async () => !(await hud.getAttribute('.mic', 'class')).includes('muted'), { label: 'HUD shows unmuted' });

  // Shortcut wiring: hotkey service emits → session reacts.
  await main(app, () => globalThis.__pairwise.hotkeys.emit('action', 'toggleMute'));
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.muted === true), { label: 'hotkey mute' });
  await main(app, () => globalThis.__pairwise.hotkeys.emit('action', 'toggleMute'));

  // Cursor buddy renders on the display under the pointer.
  await sleep(500);
  const ids = await main(app, () => globalThis.__pairwise.session.overlays.displayIds());
  await captureOverlay(app, ids[0], join(artifacts, 'p1-overlay-display1.png'));

  // Display hot-plug: removing a display removes its overlay.
  // (Fake displays are static; real hot-plug is covered by the display service unit test.)

  // --- end the session from the HUD ---
  await hud.click('.end');
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.status === 'idle'), { label: 'session ended' });
  const left = await main(app, () => globalThis.__pairwise.session.overlays.displayIds().length);
  assert.equal(left, 0, 'overlays removed after the session');
  const course = await main(app, () => globalThis.__pairwise.courses.list().find((c) => c.lastSessionAt));
  assert.ok(course?.sessionCount === 1, 'session recorded on the course');

  // Hotkey starts the last course again, and again ends it.
  await main(app, () => globalThis.__pairwise.hotkeys.emit('action', 'toggleSession'));
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'hotkey start' });
  await main(app, () => globalThis.__pairwise.hotkeys.emit('action', 'toggleSession'));
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.status === 'idle'), { label: 'hotkey end' });

  console.log('phase 1 e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
