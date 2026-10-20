// Feature 11 — the whiteboard: the tutor's pen draws a recursion tree on a board window (the
// cursor flies onto the board and traces each box and arrow), the student draws and erases,
// free-form marks, toggling, and diagram snapshots kept for the session notes.
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, windowByRole, callTool, screenShot } from './harness.mjs';

const { app } = await launch({ PAIRWISE_MOCK_SCRIPT: 'none' });
const S = (fn, arg) => main(app, fn, arg);
const boardInk = () => S(() => globalThis.__pairwise.session.whiteboard.ink.all().map((i) => ({ id: i.id, kind: i.kind, author: i.author, revealAt: i.revealAt, drawMs: i.drawMs, text: i.text })));

try {
  const courseId = await S(() => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const started = await S((_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays' });
  await S(() => globalThis.__pairwise.session.setMuted(true));

  // --- 1. the tutor draws factorial(3)'s call tree --------------------------------------------
  const r = await callTool(app, 'draw_diagram', {
    title: 'factorial(3)',
    kind: 'tree',
    nodes: [
      { id: 'a', label: 'factorial(3)' },
      { id: 'b', label: 'factorial(2)' },
      { id: 'c', label: 'factorial(1)' },
      { id: 'd', label: 'factorial(0)', note: 'stopping case → 1', highlight: true },
    ],
    edges: [
      { from: 'a', to: 'b', label: '3 ×' },
      { from: 'b', to: 'c', label: '2 ×' },
      { from: 'c', to: 'd', label: '1 ×' },
    ],
  });
  assert.equal(r.response.ok, true, JSON.stringify(r.response));
  assert.equal(await S(() => globalThis.__pairwise.session.snapshot.whiteboard), true, 'whiteboard opened');
  const board = await windowByRole(app, 'whiteboard');
  const cb = await S(() => globalThis.__pairwise.session.whiteboard.window.contentBounds());
  const ink = await boardInk();
  assert.ok(ink.length >= 12, `diagram ink (${ink.length})`);
  // The pen is on the board while it draws.
  const end = Math.max(...ink.map((i) => i.revealAt + i.drawMs));
  const t0 = Date.now();
  let onBoard = 0;
  let samples = 0;
  while (Date.now() < end - 200) {
    const s = await S(() => ({ p: globalThis.__pairwise.session.cursor.position, m: globalThis.__pairwise.session.cursor.currentMode }));
    if (s.m === 'timeline') {
      samples++;
      if (s.p.x >= cb.x && s.p.y >= cb.y && s.p.x <= cb.x + cb.width && s.p.y <= cb.y + cb.height) onBoard++;
    }
    if (Date.now() - t0 > 2200 && Date.now() - t0 < 2500) {
      const ids = await S(() => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
      await screenShot(app, ids[0], join(artifacts, 'p6-whiteboard-drawing-screen.png'));
    }
    await sleep(120);
  }
  assert.ok(samples > 5 && onBoard / samples > 0.85, `cursor drew on the board (${onBoard}/${samples} samples inside it)`);
  await sleep(Math.max(0, end - Date.now()) + 700);
  await board.screenshot({ path: join(artifacts, 'p6-whiteboard.png') });
  // Items are revealed one after another (the pen draws in order).
  const reveals = ink.map((i) => i.revealAt);
  assert.ok(reveals.every((t, i) => i === 0 || t >= reveals[i - 1]), 'drawn in order');
  await waitFor(() => S(() => globalThis.__pairwise.session.whiteboard.diagrams.length === 1), { label: 'diagram snapshot kept for the notes', timeout: 5000 });

  // --- 2. the student draws on the board, then erases it --------------------------------------
  await board.mouse.move(300, 420);
  await board.mouse.down();
  for (let i = 1; i <= 20; i++) await board.mouse.move(300 + i * 12, 420 + Math.sin(i / 3) * 20);
  await board.mouse.up();
  await waitFor(async () => (await boardInk()).some((i) => i.author === 'student'), { label: 'student stroke on the board' });
  await board.screenshot({ path: join(artifacts, 'p6-whiteboard-student.png') });
  await board.click('button[aria-label="Eraser"]');
  await board.mouse.move(360, 420 + Math.sin(5 / 3) * 20);
  await board.mouse.down();
  await board.mouse.move(372, 420 + Math.sin(6 / 3) * 20);
  await board.mouse.up();
  await waitFor(async () => !(await boardInk()).some((i) => i.author === 'student'), { label: 'erased' });

  // --- 3. free-form marks, toggling, clearing --------------------------------------------------
  const w = await callTool(app, 'whiteboard', { action: 'draw', items: [{ kind: 'text', text: 'n! = n × (n−1)!', x: 560, y: 820 }, { kind: 'arrow', x: 540, y: 860, x2: 420, y2: 760 }] });
  assert.equal(w.response.drawn, 2);
  await S(() => globalThis.__pairwise.session.command({ type: 'toggleWhiteboard' }));
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.whiteboard === false), { label: 'closed' });
  await S(() => globalThis.__pairwise.session.command({ type: 'toggleWhiteboard' }));
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.whiteboard === true), { label: 'reopened' });
  assert.ok((await boardInk()).length >= ink.length, 'ink kept while closed');
  await board.click('button[aria-label="Clear the board"]');
  await waitFor(async () => (await boardInk()).length === 0, { label: 'cleared' });

  console.log('phase 6 whiteboard e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
