// Phase 5 — takeover with consent and instant reclaim, end to end (fake input driver records
// what would be clicked/typed; fake global hooks stand in for the student's real hand).
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, openTargetWindow, captureOverlay, screenShot, windowByRole } from './harness.mjs';

const { app } = await launch({ PAIRWISE_GROUNDER: 'ocr', PAIRWISE_MOCK_SCRIPT: 'none' });
const S = (fn, arg) => main(app, fn, arg);
const snap = () => S(() => globalThis.__pairwise.session.snapshot);
const actions = () => S(() => globalThis.__pairwise.platform.driver.actions);
const inside = (p, r) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;

const IDE = `<!doctype html><html><body style="margin:0;font-family:DejaVu Sans,Arial,sans-serif;background:#fff;color:#111">
<div style="display:flex;gap:14px;padding:12px 16px;background:#eef1f5;border-bottom:1px solid #ccd">
  <button data-t="run" style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">Run</button>
  <button data-t="view" style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">View</button>
  <span style="flex:1"></span>
  <button data-t="submit" style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">Submit</button>
</div><pre style="margin:0;padding:18px 22px;font:22px/1.6 DejaVu Sans Mono,monospace">def main():\n    pass</pre></body></html>`;

/** Start a tool call without waiting for it (request_control waits for the student). */
const start = (name, args) =>
  S((_e, o) => {
    globalThis.__calls = globalThis.__calls ?? {};
    globalThis.__calls[o.name] = globalThis.__pairwise.session.tools.dispatch({ id: `t-${Date.now()}`, name: o.name, args: o.args });
  }, { name, args });
const result = (name) => S(async (_e, n) => (await globalThis.__calls[n])?.response, name);
const hook = (type, ev) => S((_e, o) => globalThis.__pairwise.platform.hooks.emit(o.type, { time: Date.now(), ...o.ev }), { type, ev });
const driving = async () => (await snap()).driving === 'driving';

async function overlayPage(displayId) {
  for (let i = 0; i < 50; i++) {
    for (const w of app.windows()) {
      const id = await w.evaluate(() => (window.pw?.role === 'overlay' ? window.pw.displayId : null)).catch(() => null);
      if (id === displayId) return w;
    }
    await sleep(100);
  }
  throw new Error('no overlay');
}

async function grant(how) {
  await start('request_control', { reason: 'show you where the Run button is' });
  await waitFor(() => S(() => globalThis.__pairwise.session.ui.consent?.kind === 'control'), { label: 'consent card' });
  await how();
  const r = await result('request_control');
  return r;
}

try {
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  const win = await openTargetWindow(app, { x: d1.bounds.x + 70, y: d1.bounds.y + 90, width: 860, height: 300, html: IDE });
  const started = await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(async () => (await snap()).status === 'live', { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays' });
  await S(() => globalThis.__pairwise.session.setMuted(true));
  const ids = await S(() => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
  const ov = await overlayPage(ids[0]);

  // --- 1. nothing happens without consent; "Not now" is respected ---------------------------
  const before = (await actions()).length;
  let r = await grant(async () => {
    await sleep(300);
    assert.equal((await snap()).driving, 'requested');
    await ov.click('.consent .deny');
  });
  assert.equal(r.granted, false);
  assert.equal((await actions()).length, before, 'no input was sent');
  const c0 = await S(() => globalThis.__pairwise.session.tools.dispatch({ id: 'c0', name: 'control', args: { actions: [{ type: 'click', target: 'the "Run" button' }] } }));
  assert.equal(c0.response.ok, false, 'control without permission is refused');

  // --- 2. allow by clicking the card --------------------------------------------------------
  r = await grant(async () => {
    await sleep(400);
    await captureOverlay(app, ids[0], join(artifacts, 'p5-consent.png'));
    await screenShot(app, ids[0], join(artifacts, 'p5-consent-screen.png'));
    await ov.click('.consent .allow');
  });
  assert.equal(r.granted, true, JSON.stringify(r));
  assert.ok(await driving());
  assert.equal(await S(() => globalThis.__pairwise.session.cursor.currentMode), 'driving', 'the buddy rides the real pointer');
  const ui = await S(() => globalThis.__pairwise.session.ui);
  assert.ok(ui.driving && /driving/.test(ui.drivingLabel));
  await sleep(400);
  await screenShot(app, ids[0], join(artifacts, 'p5-driving-screen.png'));
  const hud = await windowByRole(app, 'hud');
  await hud.waitForSelector('.driving-chip');
  await hud.screenshot({ path: join(artifacts, 'p5-hud-driving.png') });

  // --- 3. a click lands on the real button, after a visible glide (Run would need a yes: it runs code)
  const a0 = (await actions()).length;
  const c1 = await S(() => globalThis.__pairwise.session.tools.dispatch({ id: 'c1', name: 'control', args: { actions: [{ type: 'click', target: 'the "View" button' }], explain: 'Opening the View menu' } }));
  assert.equal(c1.response.ok, true, JSON.stringify(c1.response));
  const acts = (await actions()).slice(a0);
  const moves = acts.filter((a) => a.t === 'move');
  assert.ok(moves.length >= 4, `glides in steps (${moves.length})`);
  const clickAt = moves[moves.length - 1].p;
  assert.ok(inside(clickAt, win.els.view), `clicked at ${JSON.stringify(clickAt)} inside View ${JSON.stringify(win.els.view)}`);
  assert.equal(acts[acts.length - 1].t, 'click');

  // Our own synthetic move doesn't count as the student's…
  await hook('mousemove', { x: clickAt.x, y: clickAt.y });
  assert.ok(await driving(), 'own synthetic move ignored');
  // …the student's hand does — within that one event.
  const reclaimed = await S((_e, p) => {
    const s = globalThis.__pairwise.session;
    globalThis.__pairwise.platform.hooks.emit('mousemove', { x: p.x + 140, y: p.y + 90, time: Date.now() });
    return s.snapshot.driving;
  }, clickAt);
  assert.equal(reclaimed, 'none', 'reclaimed synchronously on the first real mouse event');
  assert.equal(await S(() => globalThis.__pairwise.session.cursor.currentMode), 'parked', 'the cursor stays where it last drove to');
  const parkedAt = await S(() => globalThis.__pairwise.session.cursor.position);
  assert.ok(Math.hypot(parkedAt.x - clickAt.x, parkedAt.y - clickAt.y) < 3, `parked at the last driven spot ${JSON.stringify(parkedAt)} vs ${JSON.stringify(clickAt)}`);
  assert.ok(!(await S(() => globalThis.__pairwise.session.ui)).driving);

  // --- 4. allow with the hotkey; the student takes over mid-typing ---------------------------
  r = await grant(() => S(() => globalThis.__pairwise.session.command({ type: 'grantControl' })));
  assert.equal(r.granted, true);
  const chars0 = (await actions()).filter((a) => a.t === 'char').length;
  await start('control', { actions: [{ type: 'type', text: 'print("hello from the tutor, typing slowly")' }] });
  await sleep(700);
  await hook('mousemove', { x: 900, y: 600 });
  const typed = await result('control');
  const chars = (await actions()).filter((a) => a.t === 'char').length - chars0;
  assert.equal(typed.ok, false);
  assert.match(typed.stopped, /took back control/);
  assert.ok(chars > 2 && chars < 40, `typing stopped mid-way (${chars} chars)`);
  assert.ok(!(await driving()));

  // --- 5. allow by voice; Esc takes it back ---------------------------------------------------
  r = await grant(() => S(() => globalThis.__pairwise.session.mock.hear('yeah, go ahead')));
  assert.equal(r.granted, true, JSON.stringify(r));
  assert.match(r.how, /said/);
  await hook('keydown', { key: 'Escape', keycode: 1 });
  assert.ok(!(await driving()), 'Esc reclaims');
  // …and "no" by voice is a no.
  r = await grant(() => S(() => globalThis.__pairwise.session.mock.hear(' no, let me try it myself')));
  assert.equal(r.granted, false);

  // --- 6. a risky action needs its own yes, every time ---------------------------------------
  r = await grant(() => S(() => globalThis.__pairwise.session.command({ type: 'grantControl' })));
  assert.equal(r.granted, true);
  const a1 = (await actions()).length;
  await start('control', { actions: [{ type: 'click', target: 'the "Submit" button' }], explain: 'Submitting your lab' });
  await waitFor(() => S(() => globalThis.__pairwise.session.ui.consent?.kind === 'risky-action'), { label: 'risky-action card' });
  const card = await S(() => globalThis.__pairwise.session.ui.consent);
  assert.match(card.action, /Submit/);
  await sleep(300);
  await captureOverlay(app, ids[0], join(artifacts, 'p5-risky.png'));
  await screenShot(app, ids[0], join(artifacts, 'p5-risky-screen.png'));
  await ov.click('.consent .deny');
  const risky = await result('control');
  assert.equal(risky.ok, false);
  assert.match(risky.stopped, /did not allow/);
  assert.ok(!(await actions()).slice(a1).some((a) => a.t === 'click'), 'no click was sent');
  // Allowing it goes ahead.
  await start('control', { actions: [{ type: 'click', target: 'the "Submit" button' }] });
  await waitFor(() => S(() => globalThis.__pairwise.session.ui.consent?.kind === 'risky-action'), { label: 'risky-action card again' });
  await ov.click('.consent .allow');
  const ok = await result('control');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const lastMove = (await actions()).filter((a) => a.t === 'move').pop().p;
  assert.ok(inside(lastMove, win.els.submit));

  // --- 7. assignment mode: no typing into their work -----------------------------------------
  await S(() => globalThis.__pairwise.session.update({ assignment: 'A3 - Recursion.pdf' }));
  const asg = await S(() => globalThis.__pairwise.session.tools.dispatch({ id: 'c9', name: 'control', args: { actions: [{ type: 'type', text: 'return 1' }] } }));
  assert.equal(asg.response.ok, false);
  assert.match(asg.response.stopped, /Assignment mode/);
  await S(() => globalThis.__pairwise.session.update({ assignment: undefined }));

  // --- 8. release_control, and control lapses when idle --------------------------------------
  const rel = await S(() => globalThis.__pairwise.session.tools.dispatch({ id: 'rel', name: 'release_control', args: {} }));
  assert.equal(rel.response.ok, true);
  assert.ok(!(await driving()));
  await S(() => globalThis.__pairwise.settings.update({ takeover: { enabled: true, typingCharsPerSecond: 18, autoRevokeSec: 5 } }));
  r = await grant(() => S(() => globalThis.__pairwise.session.command({ type: 'grantControl' })));
  assert.equal(r.granted, true);
  await waitFor(async () => !(await driving()), { label: 'auto-revoked after 5 s idle', timeout: 9000 });

  // --- 9. turned off in Settings → refused politely ------------------------------------------
  await S(() => globalThis.__pairwise.settings.update({ takeover: { enabled: false, typingCharsPerSecond: 18, autoRevokeSec: 45 } }));
  const off = await S(() => globalThis.__pairwise.session.tools.dispatch({ id: 'off', name: 'request_control', args: { reason: 'x' } }));
  assert.equal(off.response.granted, false);
  assert.match(off.response.note, /turned off/);

  console.log('phase 5 takeover e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
