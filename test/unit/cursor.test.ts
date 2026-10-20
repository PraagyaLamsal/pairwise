import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorEngine } from '../../src/main/session/cursor';
import type { DisplayService, InputHooks } from '../../src/main/platform/types';

function engine(mouse = { x: 100, y: 600 }) {
  const display = { id: 'd1', index: 1, label: 'Built-in', bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, primary: true };
  const displays = { list: () => [display], cursor: () => ({ ...mouse }), byId: () => display } as unknown as DisplayService;
  const hooks = {} as InputHooks;
  const c = new CursorEngine(displays, hooks, { name: () => 'Ada', behavior: () => 'follow' });
  return { c, mouse };
}

describe('CursorEngine', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('flies, parks with its label, then returns to the student after the hold', () => {
    const { c } = engine();
    c.start();
    expect(c.currentMode).toBe('follow');
    c.schedule([{ kind: 'fly', to: { x: 800, y: 120 }, label: 'Submit' }], Date.now(), 'Submit', 2000);
    expect(c.currentMode).toBe('timeline');
    vi.advanceTimersByTime(1500);
    expect(c.currentMode).toBe('parked');
    expect(c.position).toEqual({ x: 800, y: 120 });
    vi.advanceTimersByTime(2200);
    expect(['timeline', 'follow']).toContain(c.currentMode); // flying home
    vi.advanceTimersByTime(1600);
    expect(c.currentMode).toBe('follow');
    c.stop();
  });

  it('a new flight during the flight home lands and parks (does not snap back to following)', () => {
    const { c } = engine();
    c.start();
    c.schedule([{ kind: 'fly', to: { x: 800, y: 120 } }], Date.now(), 'Submit', 500);
    vi.advanceTimersByTime(1500 + 600); // parked, then hold over → returning
    expect(c.currentMode).toBe('timeline');
    c.cancelFuture(Date.now(), false);
    c.schedule([{ kind: 'fly', to: { x: 300, y: 140 } }], Date.now(), 'Run', 3000);
    vi.advanceTimersByTime(1500);
    expect(c.currentMode).toBe('parked');
    expect(c.position).toEqual({ x: 300, y: 140 });
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
});
