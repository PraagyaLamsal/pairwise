import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followMs, followPath, gestureSteps, sweepStops, SWEEP_MS_PER_LINE } from '../../src/main/session/gestures';
import { CursorEngine } from '../../src/main/session/cursor';
import type { DisplayService, InputHooks } from '../../src/main/platform/types';
import type { EncodedFrame } from '../../src/shared/ipc';
import type { CursorTrace } from '../../src/shared/ink';

// visual.ts pulls in Electron through its feature imports; the pure helpers are what we test.
vi.mock('electron', () => ({ ipcMain: { on() {} }, app: { isPackaged: false } }));
const { beatSequence, demoBeats } = await import('../../src/main/session/features/visual');

const line = { x: 120, y: 300, width: 400, height: 24 };

describe('pointer gestures', () => {
  it('follow_line glides under the line, start to end, at a reading pace', () => {
    const path = followPath(line);
    expect(path[0].x).toBeLessThan(line.x + 6);
    expect(path[path.length - 1].x).toBeGreaterThan(line.x + line.width - 6);
    for (const p of path) {
      expect(p.y).toBeGreaterThan(line.y + line.height); // under the text, never on it
      expect(p.y).toBeLessThan(line.y + line.height + 6);
    }
    // ~190 px/s for 24-26 px text: a 400 px line takes about two seconds; a short one less.
    expect(followMs(line)).toBeGreaterThan(1800);
    expect(followMs(line)).toBeLessThan(2500);
    expect(followMs({ ...line, width: 120 })).toBeLessThan(followMs(line));
    const steps = gestureSteps({ style: 'follow_line', rect: line });
    expect(steps.map((s) => s.kind)).toEqual(['fly', 'hold', 'glide']);
    expect(steps[2]).toMatchObject({ kind: 'glide', style: 'read' });
  });

  it('sweep stops on each line, just left of where they start', () => {
    const block = { x: 200, y: 100, width: 300, height: 112 };
    const stops = sweepStops(block);
    expect(stops).toHaveLength(4); // ~28 px lines
    for (const s of stops) expect(s.x).toBeLessThan(block.x);
    expect(stops[0].y).toBeGreaterThan(block.y);
    expect(stops[3].y).toBeLessThan(block.y + block.height);
    expect(sweepStops(block, 6)).toHaveLength(6);
    const steps = gestureSteps({ style: 'sweep', rect: block, lines: 4 });
    expect(steps[1]).toMatchObject({ kind: 'glide', style: 'sweep', ms: 3 * SWEEP_MS_PER_LINE });
  });

  it('hover just goes there and rests — no label, nothing drawn', () => {
    const steps = gestureSteps({ style: 'hover', rect: { x: 100, y: 100, width: 60, height: 30 } });
    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual({ kind: 'hold', ms: 1400 });
    const to = (steps[0] as { to: { x: number; y: number } }).to;
    // On the button, below and right of the middle of its label.
    expect(to.x).toBeGreaterThan(130);
    expect(to.x).toBeLessThan(160);
    expect(to.y).toBeGreaterThan(115);
    expect(to.y).toBeLessThan(130);
  });
});

describe('explanation beats with gestures', () => {
  const frame = { ref: { id: 'f', displayId: 'd1', region: { x: 0, y: 0, width: 1000, height: 800 }, pixelWidth: 2000, pixelHeight: 1600, capturedAt: 0, kind: 'hires' }, data: new Uint8Array(), mime: 'image/jpeg', changeScore: 0, veiled: [] } as unknown as EncodedFrame;
  const style = { color: '#2F7BFF', author: 'tutor' as const, surface: 'screen' as const, group: 'g', font: 'system' as const };

  it('keeps the order of gestures and marks, and turns only marks into ink', () => {
    const seq = beatSequence(
      [
        { kind: 'follow_line', box_2d: [400, 100, 440, 600] },
        { kind: 'circle', box_2d: [500, 100, 560, 300], label: 'this' },
        { kind: 'hover', box_2d: [700, 700, 740, 760] },
      ],
      frame,
      frame.ref.region,
      style,
    );
    expect(seq.map((s) => ('gesture' in s ? s.gesture.style : s.ink.kind))).toEqual(['follow_line', 'circle', 'hover']);
    const g = seq[0] as { gesture: { rect: { x: number; y: number; width: number; height: number } } };
    expect(g.gesture.rect).toEqual({ x: 100, y: 320, width: 500, height: 32 }); // 0–1000 of the frame → global DIP
  });

  it('the demo explanation leads with gestures and saves ink for the point that matters', () => {
    const beats = demoBeats(frame, 'how does it work?');
    const kinds = beats.map((b) => b.marks.map((m) => m.kind));
    expect(kinds[0]).toEqual(['sweep']);
    expect(kinds[1]).toEqual(['follow_line']);
    expect(kinds.flat().filter((k) => !['sweep', 'follow_line', 'hover'].includes(k))).toHaveLength(2);
  });

  describe('on the cursor', () => {
    beforeEach(() => vi.useFakeTimers({ now: 2_000_000 }));
    afterEach(() => vi.useRealTimers());

    it('a follow_line beat visits the line from left to right over time and creates no ink', () => {
      const display = { id: 'd1', index: 1, label: 'Built-in', bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 1, primary: true };
      const c = new CursorEngine({ list: () => [display], cursor: () => ({ x: 900, y: 700 }), byId: () => display } as unknown as DisplayService, {} as InputHooks, { name: () => 'Ada' });
      const traces: CursorTrace[] = [];
      c.on('trace', (t: CursorTrace) => traces.push(t));
      c.start();
      const times = c.schedule(gestureSteps({ style: 'follow_line', rect: line }));
      const glide = times[2];
      const xs: number[] = [];
      for (let t = glide.startAt; t <= glide.endAt; t += 100) {
        const p = c.positionAt(t);
        xs.push(p.x);
        expect(p.y).toBeGreaterThan(line.y + line.height);
      }
      expect(Math.min(...xs)).toBeLessThan(line.x + 10);
      expect(Math.max(...xs)).toBeGreaterThan(line.x + line.width - 10);
      expect(xs.every((x, i) => i === 0 || x >= xs[i - 1] - 0.01)).toBe(true); // steadily rightwards
      expect(traces).toHaveLength(1);
      expect(traces[0].itemId).toBeUndefined(); // a gesture, not a pen stroke
      vi.advanceTimersByTime(glide.endAt - Date.now() + 100);
      expect(c.currentMode).toBe('parked');
      c.stop();
    });
  });
});
