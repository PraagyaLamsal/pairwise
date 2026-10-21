import { describe, expect, it } from 'vitest';
import type { Point } from '../../src/shared/geometry';
import type { InkItem } from '../../src/shared/ink';
import { approxTextWidth, arrowHeads, arrowShaft, circlePoints, drawDurationFor, flattenSmooth, glidePoint, inkPenPoint, inkShapes, penStateAt, polyLength, typingPlan, underlinePoints } from '../../src/shared/ink-geometry';

// ---------------------------------------------------------------------------------------------
// A tiny stand-in for Canvas 2D: records what the renderer asks for.
// ---------------------------------------------------------------------------------------------
type Op = { op: string; args: number[] };
class FakePath {
  ops: Op[] = [];
  moveTo(...a: number[]) {
    this.ops.push({ op: 'M', args: a });
  }
  lineTo(...a: number[]) {
    this.ops.push({ op: 'L', args: a });
  }
  quadraticCurveTo(...a: number[]) {
    this.ops.push({ op: 'Q', args: a });
  }
  arc(...a: number[]) {
    this.ops.push({ op: 'A', args: a });
  }
  closePath() {
    this.ops.push({ op: 'Z', args: [] });
  }
}
(globalThis as unknown as { Path2D: typeof FakePath }).Path2D = FakePath;

function fakeCtx() {
  const calls: { kind: 'stroke' | 'fill'; path: FakePath | null; lineWidth: number; lineCap: string; lineJoin: string; shadowBlur: number; color: string }[] = [];
  const ctx = {
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '#000',
    fillStyle: '#000',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetY: 0,
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    translate() {},
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    closePath() {},
    rect() {},
    clip() {},
    setLineDash() {},
    fillRect() {},
    fillText() {},
    strokeText() {},
    measureText: (s: string) => ({ width: s.length * 9 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    stroke(p?: FakePath) {
      calls.push({ kind: 'stroke', path: p ?? null, lineWidth: ctx.lineWidth, lineCap: ctx.lineCap, lineJoin: ctx.lineJoin, shadowBlur: ctx.shadowBlur, color: String(ctx.strokeStyle) });
    },
    fill(p?: FakePath) {
      calls.push({ kind: 'fill', path: p ?? null, lineWidth: ctx.lineWidth, lineCap: ctx.lineCap, lineJoin: ctx.lineJoin, shadowBlur: ctx.shadowBlur, color: String(ctx.fillStyle) });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const { InkRenderer, BRUSH_WIDTH } = await import('../../src/renderer/ui/ink-render');

const item = (over: Partial<InkItem>): InkItem => ({ id: `i${Math.random()}`, author: 'tutor', kind: 'circle', color: '#2F7BFF', surface: 'screen', revealAt: 0, drawMs: 0, fadeAt: null, seed: 1, ...over });
const withTiming = (it: InkItem) => ({ ...it, drawMs: drawDurationFor(it) });

/** Distance from p to the polyline. */
function distToPoly(p: Point, pts: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return pts.length === 1 ? Math.hypot(p.x - pts[0].x, p.y - pts[0].y) : best;
}

describe('Tuple brush', () => {
  it('a single click (one point, or a stroke with no length) is a dot the width of the brush', () => {
    for (const points of [[{ x: 200, y: 140 }], [{ x: 200, y: 140 }, { x: 200.2, y: 140.1 }]]) {
      const { ctx, calls } = fakeCtx();
      new InkRenderer().render(ctx, [item({ kind: 'stroke', author: 'student', color: '#FF8A1F', points, drawMs: 1 })], 1000, 1);
      expect(calls).toHaveLength(1);
      expect(calls[0].kind).toBe('fill');
      const arc = calls[0].path!.ops.find((o) => o.op === 'A')!;
      expect(arc.args[0]).toBeCloseTo(200, 0);
      expect(arc.args[2]).toBeCloseTo(BRUSH_WIDTH / 2, 5);
    }
  });

  it('strokes every mark with one constant width, round caps and joins, and no glow', () => {
    const kinds: Partial<InkItem>[] = [
      { kind: 'circle', rect: { x: 100, y: 100, width: 96, height: 37 } },
      { kind: 'underline', rect: { x: 100, y: 100, width: 140, height: 20 } },
      { kind: 'box', rect: { x: 100, y: 100, width: 120, height: 60 } },
      { kind: 'arrow', from: { x: 400, y: 300 }, to: { x: 260, y: 180 } },
      { kind: 'check', at: { x: 300, y: 300 } },
      { kind: 'cross', at: { x: 300, y: 300 } },
      { kind: 'stroke', author: 'student', points: [{ x: 10, y: 10 }, { x: 40, y: 30 }, { x: 80, y: 20 }] },
    ];
    for (const k of kinds) {
      const it = withTiming(item(k));
      for (const now of [it.drawMs * 0.4, it.drawMs + 10]) {
        const { ctx, calls } = fakeCtx();
        new InkRenderer().render(ctx, [it], now, 2);
        const strokes = calls.filter((c) => c.kind === 'stroke');
        expect(strokes.length, `${k.kind} at ${now}`).toBeGreaterThan(0);
        for (const c of strokes) {
          expect(c.lineWidth).toBe(BRUSH_WIDTH);
          expect(c.lineCap).toBe('round');
          expect(c.lineJoin).toBe('round');
          expect(c.shadowBlur).toBeLessThanOrEqual(3); // at most a barely visible shadow (1.5 px at 2×)
          // A centreline path (moveTo/quadratic/line), not a filled pressure outline.
          expect(c.path!.ops[0].op).toBe('M');
          expect(c.path!.ops.some((o) => o.op === 'Z')).toBe(false);
        }
        expect(calls.filter((c) => c.kind === 'fill' && c.path?.ops.some((o) => o.op !== 'A'))).toHaveLength(0);
      }
    }
  });

  it('highlights are one flat translucent band in the same colour', () => {
    const it = withTiming(item({ kind: 'highlight', rect: { x: 100, y: 100, width: 200, height: 22 } }));
    const { ctx, calls } = fakeCtx();
    new InkRenderer().render(ctx, [it], it.drawMs + 10, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0].lineWidth).toBe(26);
    expect(calls[0].shadowBlur).toBe(0);
    expect(calls[0].color).toBe('#2F7BFF');
  });

  it('midpoint smoothing stays within ±1 px of the drawn polyline', () => {
    for (let seed = 1; seed < 40; seed++) {
      const shapes = [
        ...inkShapes(item({ kind: 'circle', seed, rect: { x: 100, y: 100, width: 40 + seed * 5, height: 20 + seed } })),
        ...inkShapes(item({ kind: 'box', seed, rect: { x: 100, y: 100, width: 60 + seed * 4, height: 30 + seed } })),
        ...inkShapes(item({ kind: 'arrow', seed, from: { x: 500, y: 400 }, to: { x: 300 + seed * 3, y: 200 } })),
        ...inkShapes(item({ kind: 'underline', seed, rect: { x: 100, y: 100, width: 80 + seed * 6, height: 18 } })),
        ...inkShapes(item({ kind: 'check', seed, at: { x: 300, y: 300 } })),
      ];
      for (const pts of shapes) {
        const smooth = flattenSmooth(pts, 0.5);
        const worst = Math.max(...smooth.map((p) => distToPoly(p, pts)));
        expect(worst, `seed ${seed}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('Tuple highlight click (ring)', () => {
  it('starts as a dot, becomes a ring that grows and thins from 6 to 3 px, and is gone after two pulses', () => {
    const ring = item({ kind: 'ring', rect: { x: 100, y: 100, width: 60, height: 30 }, revealAt: 0, drawMs: 900, fadeAt: 2600 });
    const at = (ms: number) => {
      const { ctx, calls } = fakeCtx();
      new InkRenderer().render(ctx, [ring], ms, 1);
      return calls;
    };
    const dot = at(60);
    expect(dot.map((c) => c.kind)).toEqual(['fill']);
    const early = at(250).filter((c) => c.kind === 'stroke');
    const late = at(800).filter((c) => c.kind === 'stroke');
    expect(early[0].lineWidth).toBeGreaterThan(late[0].lineWidth);
    expect(early[0].lineWidth).toBeLessThanOrEqual(6);
    expect(late[0].lineWidth).toBeGreaterThanOrEqual(3);
    expect(at(1500)).toHaveLength(0); // two pulses, then nothing (Tuple's ring doesn't linger)
  });
});

describe('typed notes', () => {
  it('type in letter by letter at a human pace, slower after spaces and punctuation', () => {
    const text = 'look here, base case!';
    const keys = typingPlan(text, 42);
    expect(keys).toHaveLength(text.length);
    const gaps = keys.slice(1).map((k, i) => k - keys[i]);
    const after = (ch: string) => gaps.filter((_, i) => text[i] === ch);
    const letters = gaps.filter((_, i) => /[a-z]/.test(text[i]) && text[i] !== text[i + 1]);
    for (const g of letters) {
      expect(g).toBeGreaterThanOrEqual(45);
      expect(g).toBeLessThanOrEqual(110 + 260);
    }
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(mean(after(' '))).toBeGreaterThan(mean(letters));
    expect(mean(after(','))).toBeGreaterThan(mean(after(' ')));
    // Same seed → same rhythm on every display; another seed → a different one.
    expect(typingPlan(text, 42)).toEqual(keys);
    expect(typingPlan(text, 43)).not.toEqual(keys);
    // The renderer shows exactly the characters the plan says.
    const note = withTiming(item({ kind: 'text', text, at: { x: 100, y: 100 }, fontSize: 19, seed: 42 }));
    expect(penStateAt(note, 0).chars).toBe(0);
    expect(penStateAt(note, note.drawMs).chars).toBe(text.length);
    const mid = penStateAt(note, note.drawMs / 2).chars;
    expect(mid).toBeGreaterThan(3);
    expect(mid).toBeLessThan(text.length - 2);
    // While typing, the cursor rests where it "clicked" (the start of the note).
    expect(penStateAt(note, note.drawMs / 2).pen).toEqual(inkPenPoint(note, 0));
  });

  it('width estimates follow the font actually used', () => {
    // Measured in Chromium: Inter 600 "stopping case → 1" ≈ 8.73 em, Caveat 700 ≈ 6.49 em.
    expect(approxTextWidth('stopping case → 1', 100) / 100).toBeCloseTo(8.73, 0);
    expect(approxTextWidth('stopping case → 1', 100, 'hand') / 100).toBeCloseTo(6.49, 0);
    expect(approxTextWidth('look here!', 100) / 100).toBeCloseTo(4.79, 0);
  });
});

describe('human pen', () => {
  const rect = { x: 300, y: 200, width: 96, height: 37 };

  it('no two circles are the same, and every one still encloses its target', () => {
    const loops = Array.from({ length: 20 }, (_, i) => circlePoints(rect, 1000 + i * 7919));
    for (let i = 0; i < loops.length; i++) {
      for (let j = 0; j < i; j++) {
        const same = loops[i].length === loops[j].length && loops[i].every((p, k) => Math.hypot(p.x - loops[j][k].x, p.y - loops[j][k].y) < 0.5);
        expect(same, `circles ${i} and ${j}`).toBe(false);
      }
      const xs = loops[i].map((p) => p.x);
      const ys = loops[i].map((p) => p.y);
      expect(Math.min(...xs)).toBeLessThan(rect.x);
      expect(Math.max(...xs)).toBeGreaterThan(rect.x + rect.width);
      expect(Math.min(...ys)).toBeLessThan(rect.y);
      expect(Math.max(...ys)).toBeGreaterThan(rect.y + rect.height);
    }
    // Both directions and a spread of start angles and overshoots turn up.
    const turns = loops.map((pts) => {
      let a = 0;
      for (let k = 1; k < pts.length; k++) a += (pts[k - 1].x - 348) * (pts[k].y - 218.5) - (pts[k].x - 348) * (pts[k - 1].y - 218.5);
      return Math.sign(a);
    });
    expect(new Set(turns).size).toBe(2);
  });

  it('no two arrows are the same: bow, head angle, head size and one- or two-stroke heads vary', () => {
    const from = { x: 600, y: 420 };
    const to = { x: 420, y: 260 };
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const bows: number[] = [];
    const angles: number[] = [];
    const sizes: number[] = [];
    const strokes = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const seed = 31 + i * 104729;
      const shaft = arrowShaft(from, to, 0.18, seed);
      const heads = arrowHeads(shaft, len, seed);
      strokes.add(heads.length);
      // Bow: farthest distance of the shaft from the straight line, as a share of the length.
      const dev = Math.max(...shaft.map((p) => Math.abs((to.x - from.x) * (from.y - p.y) - (from.x - p.x) * (to.y - from.y)) / len));
      bows.push(dev / len);
      expect(Math.hypot(shaft[shaft.length - 1].x - to.x, shaft[shaft.length - 1].y - to.y)).toBeLessThan(0.01); // still lands on the target
      const barbs = heads.length === 1 ? [heads[0][0], heads[0][heads[0].length - 1]] : heads.map((h) => h[h.length - 1]);
      const dir = Math.atan2(to.y - shaft[shaft.length - 6].y, to.x - shaft[shaft.length - 6].x) + Math.PI;
      for (const b of barbs) {
        sizes.push(Math.hypot(b.x - to.x, b.y - to.y));
        let d = Math.atan2(b.y - to.y, b.x - to.x) - dir;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        angles.push((Math.abs(d) * 180) / Math.PI);
      }
    }
    expect(Math.min(...bows)).toBeGreaterThanOrEqual(0.035);
    expect(Math.max(...bows)).toBeLessThanOrEqual(0.125);
    expect(Math.max(...bows) - Math.min(...bows)).toBeGreaterThan(0.03);
    expect(Math.min(...angles)).toBeGreaterThan(15);
    expect(Math.max(...angles)).toBeLessThan(42);
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(6);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12 * 0.84);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(18 * 1.16);
    expect(strokes).toEqual(new Set([1, 2]));
  });

  it('underlines vary but stay under the word they mark', () => {
    const word = { x: 200, y: 300, width: 110, height: 22 };
    const lines = Array.from({ length: 20 }, (_, i) => underlinePoints(word, 77 + i * 31337));
    const sig = new Set(lines.map((pts) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')));
    expect(sig.size).toBe(20);
    for (const pts of lines) {
      expect(pts[0].x).toBeLessThanOrEqual(word.x + 2);
      expect(pts[pts.length - 1].x).toBeGreaterThanOrEqual(word.x + word.width - 6);
      for (const p of pts) {
        expect(p.y).toBeGreaterThan(word.y + word.height - 4);
        expect(p.y).toBeLessThan(word.y + word.height + 14);
      }
    }
    // Not even the flick at the end cuts into the word, whatever the size (a 2× code font is small).
    for (const h of [12, 16, 22, 30]) {
      const w = { x: 200, y: 300, width: 9 * h * 0.6, height: h };
      for (let i = 0; i < 300; i++) {
        for (const p of underlinePoints(w, 5 + i * 7919)) expect(p.y).toBeGreaterThanOrEqual(w.y + w.height - 1.01);
      }
    }
  });

  it('draws ~30% slower than before, with each stroke easing in and out and slowing into corners', () => {
    const circle = item({ kind: 'circle', rect });
    const len = inkShapes(circle).reduce((a, s) => a + polyLength(s), 0);
    const old = Math.round(Math.min(1300, Math.max(320, 200 + len * 0.75)));
    const now = drawDurationFor(circle);
    expect(now / old).toBeGreaterThan(1.2);
    expect(now / old).toBeLessThan(1.45);

    // Pen speed along a box: slow at the very start/end, slower at corners than mid-side.
    const box = withTiming(item({ kind: 'box', rect: { x: 100, y: 100, width: 300, height: 120 }, seed: 9 }));
    const speeds: { t: number; v: number; p: Point }[] = [];
    let prev = penStateAt(box, 0).pen!;
    for (let ms = 8; ms <= box.drawMs; ms += 8) {
      const p = penStateAt(box, ms).pen!;
      speeds.push({ t: ms / box.drawMs, v: Math.hypot(p.x - prev.x, p.y - prev.y) / 8, p });
      prev = p;
    }
    const peak = Math.max(...speeds.map((s) => s.v));
    expect(speeds[0].v).toBeLessThan(peak * 0.25);
    expect(speeds[speeds.length - 2].v).toBeLessThan(peak * 0.35);
    const nearCorner = (p: Point) => [
      { x: 94, y: 94 },
      { x: 406, y: 94 },
      { x: 406, y: 226 },
      { x: 94, y: 226 },
    ].some((c) => Math.hypot(p.x - c.x, p.y - c.y) < 10);
    const mid = speeds.filter((s) => s.t > 0.15 && s.t < 0.85);
    const atCorners = mid.filter((s) => nearCorner(s.p));
    const onSides = mid.filter((s) => !nearCorner(s.p));
    const avg = (v: { v: number }[]) => v.reduce((a, s) => a + s.v, 0) / v.length;
    expect(atCorners.length).toBeGreaterThan(2);
    expect(avg(atCorners)).toBeLessThan(avg(onSides) * 0.8);
  });

  it('lifts the pen between strokes (an arrow head is drawn after a short pause in travel)', () => {
    const arrow = withTiming(item({ kind: 'arrow', from: { x: 600, y: 420 }, to: { x: 420, y: 260 }, seed: 5 }));
    const samples = Array.from({ length: 200 }, (_, i) => penStateAt(arrow, (i / 199) * arrow.drawMs));
    const shaftDone = samples.findIndex((s) => s.reveal[0] >= 1);
    const headStart = samples.findIndex((s) => (s.reveal[1] ?? 0) > 0);
    expect(shaftDone).toBeGreaterThan(0);
    expect(headStart).toBeGreaterThan(shaftDone);
    const liftMs = ((headStart - shaftDone) / 199) * arrow.drawMs;
    expect(liftMs).toBeGreaterThan(60);
    expect(liftMs).toBeLessThan(260);
    expect(samples.slice(shaftDone + 1, headStart - 1).every((s) => !s.down)).toBe(true);
    // The pen ends where the last stroke ends, which is where the cursor parks.
    expect(samples[199].pen).toEqual(inkPenPoint(arrow, 1));
  });
});

describe('pointer gestures', () => {
  it('reading glides steadily; sweeps rest on each line before moving on', () => {
    const line = [
      { x: 100, y: 200 },
      { x: 500, y: 200 },
    ];
    const xs = Array.from({ length: 11 }, (_, i) => glidePoint(line, i / 10, 'read').x);
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    // Steady in the middle (within 10 %), slower only at the ends.
    const middle = steps.slice(2, 8);
    expect(Math.max(...middle) / Math.min(...middle)).toBeLessThan(1.1);
    expect(steps[0]).toBeLessThan(middle[0]);
    const stops = [
      { x: 90, y: 100 },
      { x: 90, y: 130 },
      { x: 90, y: 160 },
    ];
    expect(glidePoint(stops, 0.1, 'sweep')).toEqual(stops[0]); // resting on line 1
    expect(glidePoint(stops, 0.6, 'sweep')).toEqual(stops[1]); // resting on line 2
    expect(glidePoint(stops, 1, 'sweep')).toEqual(stops[2]);
  });
});
