import { describe, expect, it, vi } from 'vitest';
import type { InkItem } from '../../src/shared/ink';
import { chipBox, inkAnchor, inkCover, shiftInk, slideOffset } from '../../src/shared/ink-geometry';
import { InkManager } from '../../src/main/session/ink';

vi.mock('electron', () => ({ app: { isPackaged: false }, systemPreferences: {} }));
const { trackGroups } = await import('../../src/main/session/features/sticky');

const base = (over: Partial<InkItem>): InkItem => ({ id: 'i', author: 'tutor', kind: 'circle', color: '#2F7BFF', surface: 'screen', revealAt: 0, drawMs: 600, seed: 3, ...over });

describe('sticky ink: moving marks with what they mark', () => {
  it('moves every kind of geometry', () => {
    const now = 10_000;
    const circle = shiftInk(base({ rect: { x: 10, y: 20, width: 50, height: 20 } }), 0, -40, now, 180);
    expect(circle.rect).toEqual({ x: 10, y: -20, width: 50, height: 20 });
    const arrow = shiftInk(base({ kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 30, y: 30 } }), 5, 10, now, 180);
    expect([arrow.from, arrow.to]).toEqual([{ x: 5, y: 10 }, { x: 35, y: 40 }]);
    const stroke = shiftInk(base({ kind: 'stroke', points: [{ x: 1, y: 1 }, { x: 2, y: 3 }] }), 0, 7, now, 180);
    expect(stroke.points).toEqual([{ x: 1, y: 8 }, { x: 2, y: 10 }]);
    const chip = shiftInk(base({ kind: 'text', chip: true, text: 'n = 3', at: { x: 300, y: 100 } }), 0, 24, now, 180);
    expect(chip.at).toEqual({ x: 300, y: 124 });
  });

  it('a drawn mark glides from where it was; one still to come just moves', () => {
    const now = 10_000;
    const drawn = shiftInk(base({ rect: { x: 0, y: 100, width: 40, height: 20 } }), 0, -60, now, 200);
    expect(drawn.slide).toEqual({ dx: 0, dy: -60, at: now, ms: 200 });
    // Drawn where it was at the start of the glide, where it is at the end.
    expect(slideOffset(drawn, now)).toEqual({ x: -0, y: 60 });
    expect(slideOffset(drawn, now + 200)).toEqual({ x: 0, y: 0 });
    expect(slideOffset(drawn, now + 100).y).toBeLessThan(30); // eases out: most of the way early
    // Moved again mid-glide: it carries on from where it's drawn, no jump.
    const mid = now + 60;
    const seen = drawn.rect!.y + slideOffset(drawn, mid).y;
    const again = shiftInk(drawn, 0, -30, mid, 200);
    expect(again.rect!.y + slideOffset(again, mid).y).toBeCloseTo(seen, 6);
    const later = shiftInk(base({ revealAt: now + 5000, rect: { x: 0, y: 100, width: 40, height: 20 } }), 0, -60, now, 200);
    expect(later.slide).toBeUndefined();
    expect(later.rect!.y).toBe(40);
  });

  it("a value chip is about the line before it; its cover is its pill", () => {
    const chip = base({ kind: 'text', chip: true, text: 'n = 3', at: { x: 400, y: 200 }, fontSize: 13.5 });
    const pill = chipBox(chip)!;
    const a = inkAnchor(chip)!;
    expect(a.x + a.width).toBeLessThanOrEqual(pill.x);
    expect(a.width).toBeGreaterThan(200);
    expect(a.y).toBeLessThanOrEqual(pill.y);
    expect(inkCover(chip)).toEqual([pill]);
    // A circle's cover follows its stroke (many small boxes), not its whole area.
    const cover = inkCover(base({ rect: { x: 100, y: 100, width: 200, height: 40 } }));
    expect(cover.length).toBeGreaterThan(20);
    expect(cover.every((r) => r.width <= 12)).toBe(true);
  });

  it('groups marks by their turn, skipping faded, whiteboard and off-screen ones', () => {
    const display = { x: 0, y: 0, width: 1440, height: 900 };
    const items = [
      base({ id: 'a', group: 't1', rect: { x: 10, y: 10, width: 50, height: 20 } }),
      base({ id: 'b', group: 't1', kind: 'text', chip: true, text: 'x = 1', at: { x: 400, y: 60 } }),
      base({ id: 'c', group: 't2', rect: { x: 10, y: 300, width: 50, height: 20 }, fadeAt: 900 }),
      base({ id: 'd', group: 't3', rect: { x: 10, y: 300, width: 50, height: 20 }, fadeAt: 0 }),
      base({ id: 'e', group: 't4', surface: 'whiteboard', rect: { x: 10, y: 300, width: 50, height: 20 } }),
      base({ id: 'f', group: 't5', rect: { x: 2000, y: 300, width: 50, height: 20 } }),
      base({ id: 'g', rect: { x: 10, y: 500, width: 50, height: 20 } }),
    ];
    const groups = trackGroups(items, display, 1000);
    expect(groups.map((g) => [g.key, g.ids])).toEqual([
      ['t1', ['a', 'b']],
      ['g', ['g']],
    ]);
    expect(groups[0].anchors.length).toBe(2);
  });

  it('the ink store moves a group and tells the overlays', () => {
    const ink = new InkManager();
    const ops: unknown[] = [];
    ink.on('op', (op) => ops.push(op));
    ink.add([base({ id: 'a', group: 't1', rect: { x: 0, y: 100, width: 40, height: 20 } }), base({ id: 'b', group: 't2', rect: { x: 0, y: 300, width: 40, height: 20 } })]);
    const moved = ink.shift({ group: 't1' }, 0, -50);
    expect(moved.map((i) => i.id)).toEqual(['a']);
    expect(ink.all().find((i) => i.id === 'a')!.rect!.y).toBe(50);
    expect(ink.all().find((i) => i.id === 'b')!.rect!.y).toBe(300);
    expect((ops[ops.length - 1] as { op: string }).op).toBe('update');
    ink.dispose();
  });
});
