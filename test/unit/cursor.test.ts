import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARRIVE_OFFSET, CursorEngine, IDLE_AFTER_MS, NEAR_PX } from '../../src/main/session/cursor';
import type { DisplayService, InputHooks } from '../../src/main/platform/types';
import type { CursorFrame } from '../../src/shared/ink';

function engine(start = { x: 100, y: 600 }) {
  const mouse = { ...start };
  const display = { id: 'd1', index: 1, label: 'Built-in', bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, primary: true };
  const displays = { list: () => [display], cursor: () => ({ ...mouse }), byId: () => display } as unknown as DisplayService;
  const hooks = {} as InputHooks;
  const c = new CursorEngine(displays, hooks, { name: () => 'Ada' });
  const frames: CursorFrame[] = [];
  c.on('frame', (f: CursorFrame) => frames.push(f));
  return { c, mouse, frames };
}

describe('CursorEngine (stays where she leaves it)', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('appears once beside the student pointer, says its name, then dims', () => {
    const { c, frames } = engine();
    c.start();
    expect(c.currentMode).toBe('parked');
    expect(c.position).toEqual({ x: 100 + ARRIVE_OFFSET.x, y: 600 + ARRIVE_OFFSET.y });
    expect(c.presence).toBe('active');
    expect(frames.at(-1)?.label).toBe('Ada');
    vi.advanceTimersByTime(3000);
    // Beside the pointer but just outside "near": dimmed, label gone.
    expect(c.presence).toBe('idle');
    expect(frames.at(-1)?.presence).toBe('idle');
    c.stop();
  });

  it('stays put while the student moves their mouse around (never follows, never flies home)', () => {
    const { c, mouse } = engine();
    c.start();
    c.schedule([{ kind: 'fly', to: { x: 800, y: 120 }, label: 'Submit' }], Date.now(), 'Submit', 2000);
    expect(c.currentMode).toBe('timeline');
    vi.advanceTimersByTime(1500);
    expect(c.currentMode).toBe('parked');
    expect(c.position).toEqual({ x: 800, y: 120 });
    // The student wanders all over the screen for a long time.
    for (let i = 0; i < 40; i++) {
      mouse.x = 50 + ((i * 137) % 1300);
      mouse.y = 300 + ((i * 89) % 500);
      vi.advanceTimersByTime(250);
    }
    expect(c.currentMode).toBe('parked');
    expect(c.position).toEqual({ x: 800, y: 120 });
    c.stop();
  });

  it('is active while moving and holding its label, then idles, and fades further when the student comes close', () => {
    const { c, mouse, frames } = engine({ x: 1300, y: 800 });
    c.start();
    vi.advanceTimersByTime(3000);
    expect(c.presence).toBe('idle');
    // The student's pointer drifts onto it.
    mouse.x = c.position.x + 4;
    mouse.y = c.position.y + 6;
    vi.advanceTimersByTime(50);
    expect(c.presence).toBe('near');
    mouse.x = 200;
    mouse.y = 200;
    vi.advanceTimersByTime(100);
    expect(c.presence).toBe('idle');
    c.schedule([{ kind: 'fly', to: { x: 700, y: 400 }, label: 'Run' }], Date.now(), 'Run', 2000);
    expect(c.presence).toBe('active');
    vi.advanceTimersByTime(1300); // landed, label up
    expect(c.currentMode).toBe('parked');
    expect(c.presence).toBe('active');
    expect(frames.at(-1)?.labelKind).toBe('pointing');
    vi.advanceTimersByTime(2000 + 200); // hold over
    expect(c.presence).toBe('idle');
    expect(frames.at(-1)?.presence).toBe('idle');
    // The student's pointer comes within ~60 px → nearly transparent; moves away → back to idle.
    mouse.x = 700 + 20;
    mouse.y = 400 + 30;
    vi.advanceTimersByTime(50);
    expect(c.presence).toBe('near');
    expect(frames.at(-1)?.mouse).toEqual({ x: 720, y: 430 });
    mouse.x = 700 + NEAR_PX + 60;
    vi.advanceTimersByTime(50);
    expect(c.presence).toBe('idle');
    // A new move: full strength at once, from where it was (no jump).
    c.schedule([{ kind: 'fly', to: { x: 300, y: 500 } }], Date.now());
    expect(c.presence).toBe('active');
    expect(c.positionAt(Date.now())).toEqual({ x: 700, y: 400 });
    vi.advanceTimersByTime(1200 + IDLE_AFTER_MS + 100);
    expect(c.presence).toBe('idle');
    c.stop();
  });

  it('keeps a pointing label up while the tutor is still talking about it', () => {
    const { c } = engine();
    let talking = true;
    c.holdWhile = () => talking;
    c.start();
    c.schedule([{ kind: 'fly', to: { x: 900, y: 300 }, label: 'Submit' }], Date.now(), 'Submit', 1500);
    vi.advanceTimersByTime(1200 + 1500 + 2000);
    expect(c.presence).toBe('active');
    talking = false;
    vi.advanceTimersByTime(IDLE_AFTER_MS + 100);
    expect(c.presence).toBe('idle');
    c.stop();
  });

  it('a pointer-only glide moves along its path and stays at the end', () => {
    const { c } = engine();
    c.start();
    const path = [
      { x: 200, y: 300 },
      { x: 500, y: 300 },
    ];
    const [fly, glide] = c.schedule([{ kind: 'fly', to: path[0] }, { kind: 'glide', path, ms: 1500, style: 'read' }]);
    const mid = c.positionAt((glide.startAt + glide.endAt) / 2);
    expect(mid.y).toBeCloseTo(300, 5);
    expect(mid.x).toBeGreaterThan(300);
    expect(mid.x).toBeLessThan(400);
    expect(glide.startAt).toBe(fly.endAt);
    vi.advanceTimersByTime(glide.endAt - Date.now() + 50);
    expect(c.currentMode).toBe('parked');
    expect(c.position).toEqual({ x: 500, y: 300 });
    c.stop();
  });

  it('reports where it is during a move, not where the next move starts (regression)', () => {
    const { c } = engine();
    c.start();
    const from = c.position;
    const [fly, hold, glide] = c.schedule([
      { kind: 'fly', to: { x: 900, y: 500 } },
      { kind: 'hold', ms: 300 },
      { kind: 'glide', path: [{ x: 900, y: 500 }, { x: 900, y: 700 }], ms: 1000, style: 'sweep' },
    ]);
    const mid = c.positionAt((fly.startAt + fly.endAt) / 2);
    expect(mid.x).toBeGreaterThan(from.x + 50);
    expect(mid.x).toBeLessThan(900 - 50);
    expect(c.positionAt((hold.startAt + hold.endAt) / 2)).toEqual({ x: 900, y: 500 });
    expect(c.positionAt(glide.startAt + 100).y).toBeCloseTo(500, 5); // resting on the first line
    c.stop();
  });

  it('positionAt follows the scheduled timeline', () => {
    const { c } = engine();
    c.start();
    const now = Date.now();
    const [f] = c.schedule([{ kind: 'fly', to: { x: 900, y: 500 } }], now + 1000);
    expect(f.startAt).toBe(now + 1000);
    expect(c.positionAt(now + 500)).toEqual(c.positionAt(now)); // not moving yet
    expect(c.positionAt(f.endAt)).toEqual({ x: 900, y: 500 });
    c.stop();
  });

  it('rides the real pointer while driving, then stays where it last drove to', () => {
    const { c, mouse } = engine();
    c.start();
    c.setDriving(true);
    expect(c.currentMode).toBe('driving');
    mouse.x = 640;
    mouse.y = 320;
    vi.advanceTimersByTime(50);
    expect(c.position).toEqual({ x: 640, y: 320 });
    // The student grabs the mouse back (and moves it away): the cursor stays at the last spot.
    mouse.x = 1000;
    mouse.y = 700;
    c.setDriving(false, { x: 640, y: 320 });
    vi.advanceTimersByTime(500);
    expect(c.currentMode).toBe('parked');
    expect(c.position).toEqual({ x: 640, y: 320 });
    c.stop();
  });

  it('an interruption cancels what has not happened yet and parks where it is', () => {
    const { c } = engine();
    c.start();
    const [f] = c.schedule([{ kind: 'fly', to: { x: 900, y: 500 } }]);
    vi.advanceTimersByTime((f.endAt - f.startAt) / 2);
    const here = c.positionAt(Date.now());
    c.cancelFuture(Date.now());
    expect(c.currentMode).toBe('parked');
    vi.advanceTimersByTime(5000);
    expect(c.position.x).toBeCloseTo(here.x, 0);
    expect(c.position.y).toBeCloseTo(here.y, 0);
    c.stop();
  });
});
