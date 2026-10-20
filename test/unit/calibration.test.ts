import { describe, expect, it } from 'vitest';
import { calibrationLayout, calibrationPage, scoreCalibration, type CalTarget } from '../../src/main/vision/calibration';

const display = { id: 'd1', workArea: { x: 0, y: 25, width: 1440, height: 875 } };

describe('calibration', () => {
  it('lays out nine uniquely-labelled buttons inside the work area', () => {
    const used = new Set<string>();
    const a = calibrationLayout(display, 42, used);
    const b = calibrationLayout({ id: 'd2', workArea: { x: 1440, y: 0, width: 1120, height: 700 } }, 43, used);
    expect(a).toHaveLength(9);
    const labels = [...a, ...b].map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const t of a) {
      expect(t.x).toBeGreaterThan(40);
      expect(t.x).toBeLessThan(1440 - 40);
      expect(t.y).toBeGreaterThan(40);
      expect(t.y).toBeLessThan(875 - 40);
    }
    expect(new Set(a.map((t) => t.size)).size).toBeGreaterThan(1);
    // Deterministic for a seed.
    expect(calibrationLayout(display, 42)).toEqual(calibrationLayout(display, 42));
  });

  it('renders a page with one button per target', () => {
    const html = calibrationPage(calibrationLayout(display, 1), 'test');
    expect(html.match(/<button /g)).toHaveLength(9);
  });

  it('scores hits, misses and errors', () => {
    const t = (id: string, x: number): CalTarget => ({ id, label: id, rect: { x, y: 100, width: 80, height: 30 }, displayId: 'd1', size: 'm' });
    const targets = [t('a', 100), t('b', 300), t('c', 500)];
    const found = new Map([
      ['a', { x: 102, y: 101, width: 80, height: 30 }], // ~2.2 px off
      ['b', { x: 400, y: 100, width: 80, height: 30 }], // 100 px off: a miss
      ['c', null],
    ]);
    const s = scoreCalibration(targets, found, [{ id: 'd1', label: 'Built-in', scaleFactor: 2 }]);
    expect(s.found).toBe(2);
    expect(s.hits).toBe(1);
    expect(s.results[0].errorPx).toBeCloseTo(Math.hypot(2, 1), 5);
    expect(s.maxErrorPx).toBeCloseTo(100, 5);
    expect(s.perDisplay[0]).toMatchObject({ hits: 1, total: 3 });
  });
});
