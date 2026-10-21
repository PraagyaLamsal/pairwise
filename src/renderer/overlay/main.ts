import '@fontsource/caveat/700.css';
import '@fontsource-variable/inter';
import '../ui/tokens.css';
import './overlay.css';
import type { InkItem } from '@shared/ink';
import type { InkOp, OverlayInit } from '@shared/ipc';
import { ipc } from '../ui/ipc';
import { FADE_MS, InkRenderer } from '../ui/ink-render';
import { CursorView } from './cursor';
import { OverlayUi } from './ui';
import { DrawInput } from './draw';
import { Celebrations } from './celebrate';
import { AnswerInput } from './answer';

const canvas = document.createElement('canvas');
canvas.className = 'ink-canvas';
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d', { alpha: true })!;
const drawSurface = document.createElement('div');
drawSurface.className = 'draw-surface';
document.body.appendChild(drawSurface);

let init: OverlayInit | null = null;
let dpr = window.devicePixelRatio || 1;
const items = new Map<string, InkItem>();
const renderer = new InkRenderer();
/** Screen-space twins of whiteboard ink: never drawn here, only traced by the cursor. */
const penOnly = new Map<string, InkItem>();
const cursor = new CursorView(document.body, '#2F7BFF', (id) => items.get(id) ?? penOnly.get(id));
const ui = new OverlayUi(document.body);
const celebrations = new Celebrations(['#2F7BFF', '#FF8A1F', '#FFFFFF', '#34D399', '#9B5DE5']);
let dirty = true;
let wasAnimating = false;
let raf = 0;
let sleepTimer = 0;
/**
 * Draw on the next frame. The loop only runs while something moves; an idle overlay sleeps
 * (no frames at all) until an event or the next scheduled change wakes it.
 */
function wake(): void {
  if (sleepTimer) {
    window.clearTimeout(sleepTimer);
    sleepTimer = 0;
  }
  if (!raf) raf = requestAnimationFrame(frame);
}
function markDirty(): void {
  dirty = true;
  wake();
}
const draw = new DrawInput(drawSurface, markDirty);
const answer = new AnswerInput(drawSurface);
let fontsReady = false;

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  markDirty();
}
window.addEventListener('resize', resize);
resize();

/** macOS "Reduce motion" (or forced by main for tests): fades instead of swoops, pops and pulses. */
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
function applyMotion(): void {
  const reduced = Boolean(init?.reducedMotion) || motionQuery.matches;
  document.body.classList.toggle('reduced-motion', reduced);
  renderer.reducedMotion = reduced;
  celebrations.reducedMotion = reduced;
  cursor.reducedMotion = reduced;
  markDirty();
}
motionQuery.addEventListener('change', applyMotion);

ipc.on('overlay:init', (i) => {
  init = i;
  applyMotion();
  document.body.dataset.platform = i.platform;
  cursor.setBounds(i.display.bounds);
  cursor.setColor(i.tutorColor);
  ui.configure(i.display.id, i.display.bounds, i.tutorName);
  draw.configure(i.display.id, i.display.bounds);
  answer.configure(i.display.id, i.display.bounds);
  celebrations.setColors([i.tutorColor, i.studentColor, '#FFFFFF', '#34D399', '#9B5DE5']);
  document.documentElement.style.setProperty('--tutor', i.tutorColor);
  document.documentElement.style.setProperty('--student', i.studentColor);
  resize();
  void document.fonts.ready.then(() => {
    fontsReady = true;
    markDirty();
    ipc.send('overlay:ready', { displayId: i.display.id });
  });
});

ipc.on('overlay:cursor', (f) => {
  cursor.pushFrame(f);
  // The student's pointer: cards and chips it comes near fade out of its way.
  if (f.mouse) ui.setPointer(f.mouse);
  wake();
});
ipc.on('overlay:flight', (f) => {
  cursor.startFlight(f);
  wake();
});
ipc.on('overlay:trace', (t) => {
  cursor.startTrace(t);
  wake();
});
ipc.on('overlay:penItems', (m) => {
  const now = Date.now();
  for (const [id, it] of penOnly) if (it.revealAt && now - it.revealAt > 60_000) penOnly.delete(id);
  for (const it of m.items) penOnly.set(it.id, { ...it, revealAt: now });
});
ipc.on('overlay:cursorCancel', (c) => {
  cursor.cancel(c);
  wake();
});
ipc.on('overlay:ui', (s) => ui.render(s));
ipc.on('overlay:calibration', (c) => ui.renderCalibration(c));
ipc.on('overlay:celebrate', (c) => {
  celebrations.add(c);
  markDirty();
});
ipc.on('overlay:drawMode', (m) => {
  const hint = m.active ? (m.via === 'hold' ? 'Drawing — talk and drag; let go of the keys to send' : 'Drawing — Return to send · Esc to cancel · Shift for straight lines') : '';
  draw.setMode(m, hint);
  markDirty();
});
ipc.on('overlay:answerMode', (m) => answer.setMode(m));
ipc.on('overlay:ink', (op: InkOp) => applyInk(op));

function applyInk(op: InkOp): void {
  switch (op.op) {
    case 'add':
    case 'update':
      for (const it of op.items) {
        if (op.op === 'update') renderer.forget(it.id);
        items.set(it.id, it);
      }
      break;
    case 'remove':
      for (const id of op.ids) {
        items.delete(id);
        renderer.forget(id);
      }
      break;
    case 'fade':
      for (const it of items.values()) {
        if (op.ids && !op.ids.includes(it.id)) continue;
        if (op.group && it.group !== op.group) continue;
        if (op.author && it.author !== op.author) continue;
        if (it.fadeAt == null || it.fadeAt > op.at) it.fadeAt = op.at;
      }
      break;
    case 'clear':
      for (const [id, it] of items) {
        if (op.author && it.author !== op.author) continue;
        if (op.group && it.group !== op.group) continue;
        items.delete(id);
        renderer.forget(id);
      }
      break;
  }
  markDirty();
}

function liveStrokeItem(): InkItem | null {
  const s = draw.current;
  if (!s || s.points.length < 1) return null;
  return {
    id: '__live__',
    author: 'student',
    kind: 'stroke',
    color: draw.color,
    surface: 'screen',
    // A single click is a dot (the renderer draws a stroke with no length as one).
    points: s.points,
    revealAt: 0,
    drawMs: 1,
    seed: 1,
  };
}

function frame(): void {
  raf = 0;
  const now = Date.now();
  cursor.update(now);
  let next = cursor.nextChange(now);

  if (init && fontsReady) {
    // garbage-collect fully faded items
    for (const [id, it] of items) {
      if (it.fadeAt != null && now > it.fadeAt + FADE_MS + 100) {
        items.delete(id);
        renderer.forget(id);
        dirty = true;
      }
    }
    const list = [...items.values()];
    const live = liveStrokeItem();
    // The canvas only redraws for ink; the cursor is a DOM element with its own schedule.
    const animating = renderer.animating(list, now) || celebrations.active || live !== null;
    if (dirty || animating || wasAnimating) {
      const b = init.display.bounds;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, -b.x * dpr, -b.y * dpr);
      renderer.render(ctx, list, now, dpr);
      if (live) {
        renderer.forget('__live__');
        renderer.render(ctx, [live], now, dpr);
      }
      celebrations.render(ctx, now, dpr, renderer.fontFamily);
      dirty = false;
    }
    wasAnimating = animating;
    if (animating) next = now;
    else next = Math.min(next, renderer.nextChange(list, now));
  }
  if (next <= now + 20) wake();
  else if (Number.isFinite(next)) sleepTimer = window.setTimeout(wake, Math.max(0, next - Date.now() - 12));
}
wake();
