// Phase 6 — App Veil, end to end: a "Messages" window with a secret on it, partly covered by an
// ordinary window in front. The frames that actually leave for the tutor must have the visible
// part of Messages painted black (z-order aware), the covering window untouched, the student
// sees an outline, and the veil follows the window when it moves.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launch, main, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, openTargetWindow, screenShot } from './harness.mjs';

const d1 = FAKE_DISPLAYS[0];
const MSG = { x: d1.bounds.x + 760, y: d1.bounds.y + 220, width: 520, height: 360 };
const FRONT = { x: d1.bounds.x + 600, y: d1.bounds.y + 420, width: 420, height: 300 };
const fakeWindows = (msg = MSG, extra = []) => [
  ...extra,
  { id: 2, title: 'Notes', app: 'Safari', bundleId: 'com.apple.Safari', pid: 999, bounds: FRONT },
  { id: 1, title: 'Messages', app: 'Messages', bundleId: 'com.apple.MobileSMS', pid: 998, bounds: msg },
];
const { app } = await launch({ PAIRWISE_MOCK_SCRIPT: 'none', PAIRWISE_FAKE_WINDOWS: JSON.stringify(fakeWindows()) });

const secret = `<!doctype html><body style="margin:0;background:#e5484d;color:#fff;font:700 48px DejaVu Sans,Arial;display:grid;place-items:center;height:100vh">SECRET 4242</body>`;
const front = `<!doctype html><body style="margin:0;background:#22c55e;color:#04210f;font:600 26px DejaVu Sans,Arial;display:grid;place-items:center;height:100vh">lecture notes</body>`;

/** Colours of global points in a frame (decoded in the main process). */
const colours = (frame, points) =>
  main(
    app,
    ({ nativeImage }, o) => {
      const img = nativeImage.createFromBuffer(Buffer.from(o.data, 'base64'));
      const { width, height } = img.getSize();
      const bmp = img.toBitmap();
      return o.points.map((p) => {
        const x = Math.min(width - 1, Math.max(0, Math.round(((p.x - o.ref.region.x) / o.ref.region.width) * width)));
        const y = Math.min(height - 1, Math.max(0, Math.round(((p.y - o.ref.region.y) / o.ref.region.height) * height)));
        const i = (y * width + x) * 4;
        return [bmp[i + 2], bmp[i + 1], bmp[i]];
      });
    },
    { data: frame.data, ref: frame.ref, points },
  );
const black = (c) => c.every((v) => v < 40);
const red = (c) => c[0] > 170 && c[1] < 120 && c[2] < 120;
const green = (c) => c[1] > 150 && c[0] < 120;

/** A full-detail frame, sent to the tutor exactly like a question frame, plus what the server got. */
async function sentFrame() {
  const f = await main(app, async () => {
    const s = globalThis.__pairwise.session;
    s.lastQuestionFrameAt = 0;
    const fr = await s.sendQuestionFrame();
    return fr ? { ref: fr.ref } : null;
  });
  assert.ok(f, 'frame sent');
  await sleep(300);
  const got = await main(app, () => globalThis.__pairwise.session.mock.stats.recentVideo.slice(-1)[0]);
  return { ref: f.ref, data: got.data };
}

try {
  const courseId = await main(app, () => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  // Real windows matching the fake window list (Messages behind, the green window in front).
  await openTargetWindow(app, { ...MSG, html: secret });
  await openTargetWindow(app, { ...FRONT, html: front });
  // Match the fake z-order (no window manager here: restack by hand).
  const order = await main(app, async () => {
    const [msg, front] = globalThis.__targets;
    front.setAlwaysOnTop(true, 'screen-saver');
    front.moveTop();
    msg.blur();
    front.focus();
    await new Promise((r) => setTimeout(r, 300));
    return 'ok';
  });
  void order;
  const started = await main(app, (_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays' });
  await main(app, () => globalThis.__pairwise.session.setMuted(true));
  assert.equal(await main(app, () => globalThis.__pairwise.session.snapshot.veiledWindows), 1);

  const inMsgOnly = [
    { x: MSG.x + 60, y: MSG.y + 60 },
    { x: MSG.x + MSG.width - 40, y: MSG.y + 40 },
    { x: MSG.x + MSG.width / 2, y: MSG.y + MSG.height / 2 - 40 }, // where the secret text is
    { x: MSG.x + MSG.width - 30, y: MSG.y + MSG.height - 30 },
  ];
  const inFront = [
    { x: FRONT.x + 40, y: FRONT.y + FRONT.height - 40 },
    { x: MSG.x + 30, y: FRONT.y + 120 }, // front window over the Messages area
  ];
  const outside = [{ x: d1.bounds.x + 200, y: d1.bounds.y + 700 }];

  // 1. what leaves the machine
  let f = await sentFrame();
  const png = await main(app, ({ nativeImage }, data) => nativeImage.createFromBuffer(Buffer.from(data, 'base64')).toPNG().toString('base64'), f.data);
  writeFileSync(join(artifacts, 'p6-veil-what-the-tutor-saw.png'), Buffer.from(png, 'base64'));
  let c = await colours(f, [...inMsgOnly, ...inFront, ...outside]);
  inMsgOnly.forEach((p, i) => assert.ok(black(c[i]), `veiled pixel at ${JSON.stringify(p)} is black (got ${c[i]})`));
  inFront.forEach((p, i) => assert.ok(green(c[inMsgOnly.length + i]), `the window in front stays visible at ${JSON.stringify(p)} (got ${c[inMsgOnly.length + i]})`));
  assert.ok(!black(c[c.length - 1]), 'elsewhere is not blacked out');
  // grounding/reading captures go through the same veil
  const g = await main(app, async (_e, id) => {
    const s = globalThis.__pairwise.session;
    const r = await s.deps.engine.request({ type: 'captureNow', requestId: s.deps.engine.nextRequestId('t'), displayId: id, maxWidth: 2048, quality: 0.9, kind: 'crop' });
    return { ref: r.frame.ref, data: Buffer.from(r.frame.data).toString('base64') };
  }, await main(app, () => globalThis.__pairwise.platform.displays.list()[0].id));
  c = await colours(g, inMsgOnly);
  c.forEach((col, i) => assert.ok(black(col), `grounding capture veiled at ${JSON.stringify(inMsgOnly[i])}`));

  // 2. the student sees an outline on the veiled window
  const outlines = await main(app, () => globalThis.__pairwise.session.ui.veilOutlines);
  assert.equal(outlines.length, 1);
  assert.equal(outlines[0].app, 'Messages');
  const ids = await main(app, () => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
  await sleep(300);
  await screenShot(app, ids[0], join(artifacts, 'p6-veil-screen.png'));

  // 3. the veil follows a moved window
  const MOVED = { x: d1.bounds.x + 120, y: d1.bounds.y + 120, width: 420, height: 300 };
  await main(app, (_e, o) => {
    globalThis.__pairwise.platform.windows.windows = o.list;
    globalThis.__targets[0].setBounds(o.moved);
  }, { list: fakeWindows(MOVED), moved: MOVED });
  await sleep(900);
  f = await sentFrame();
  c = await colours(f, [{ x: MOVED.x + 50, y: MOVED.y + 50 }, { x: MOVED.x + MOVED.width - 30, y: MOVED.y + MOVED.height - 30 }]);
  assert.ok(c.every(black), `moved window veiled (${JSON.stringify(c)})`);

  // 4. notification banners are veiled too
  const BANNER = { x: d1.bounds.x + d1.bounds.width - 380, y: d1.bounds.y + 40, width: 360, height: 80 };
  await main(app, (_e, list) => (globalThis.__pairwise.platform.windows.windows = list), fakeWindows(MOVED, [{ id: 9, title: '', app: 'Notification Center', bundleId: 'com.apple.notificationcenterui', pid: 997, bounds: BANNER }]));
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.veiledWindows === 2), { label: 'banner veiled', timeout: 4000 });

  // 5. un-veiling an app takes effect right away
  await main(app, () => {
    const p = globalThis.__pairwise;
    const v = p.settings.get().veil;
    p.settings.update({ veil: { ...v, apps: v.apps.filter((a) => a.name !== 'Messages') } });
  });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.veiledWindows === 1), { label: 'Messages no longer veiled', timeout: 4000 });
  f = await sentFrame();
  c = await colours(f, [{ x: MOVED.x + 50, y: MOVED.y + 50 }]);
  assert.ok(red(c[0]), `visible again (${c[0]})`);

  console.log('phase 6 App Veil e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
