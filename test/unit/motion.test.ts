import { describe, expect, it } from 'vitest';
import type { InkItem } from '../../src/shared/ink';
import { planFlight } from '../../src/main/session/cursor';

// The renderers draw with Path2D (strokes); rings and badges only need the context.
(globalThis as unknown as { Path2D: unknown }).Path2D = class {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  arc() {}
};
const { InkRenderer } = await import('../../src/renderer/ui/ink-render');
const { Celebrations } = await import('../../src/renderer/overlay/celebrate');

/** Records arcs (with the stroke width/colour in force) and text a renderer draws. */
function recorder() {
  const arcs: { r: number; width: number; style: string }[] = [];
  let pending: number[] = [];
  const texts: string[] = [];
  let fills = 0;
  const ctx = {
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    beginPath() {
      pending = [];
    },
    arc(_x: number, _y: number, r: number) {
      pending.push(r);
    },
    moveTo() {},
    lineTo() {},
    closePath() {},
    fillRect() {
      fills++;
    },
    stroke() {
      for (const r of pending) arcs.push({ r, width: ctx.lineWidth, style: String(ctx.strokeStyle) });
    },
    fill() {
      fills++;
    },
    fillText(t: string) {
      texts.push(t);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, arcs, texts, fills: () => fills };
}

const ring = (fadeAt: number | null): InkItem => ({ id: `r${fadeAt}`, author: 'tutor', kind: 'ring', color: '#2F7BFF', surface: 'screen', rect: { x: 100, y: 100, width: 60, height: 30 }, revealAt: 1000, drawMs: 900, fadeAt, seed: 1 });

describe('Reduce motion', () => {
  it('the cursor moves straight and quickly instead of swooping', () => {
    const from = { x: 100, y: 500 };
    const to = { x: 900, y: 200 };
    const normal = planFlight(from, to, 0);
    const reduced = planFlight(from, to, 0, undefined, 1200, true);
    expect(reduced.duration).toBeLessThanOrEqual(260);
    expect(reduced.duration).toBeLessThan(normal.duration);
    // The control point sits on the straight line: no arc.
    expect(reduced.ctrl.x).toBeCloseTo((from.x + to.x) / 2, 5);
    expect(reduced.ctrl.y).toBeCloseTo((from.y + to.y) / 2, 5);
    expect(Math.hypot(normal.ctrl.x - (from.x + to.x) / 2, normal.ctrl.y - (from.y + to.y) / 2)).toBeGreaterThan(20);
    expect(planFlight(from, { x: 110, y: 505 }, 0, undefined, 1200, true).duration).toBeLessThan(150);
  });

  it('a highlight click is one still ring that fades, not an expanding pulse', () => {
    const r = new InkRenderer();
    r.reducedMotion = true;
    const radii = [1100, 1400, 1800].map((t) => {
      const rec = recorder();
      r.render(rec.ctx, [ring(null)], t, 1);
      return rec.arcs.map((a) => a.r);
    });
    expect(radii.every((x) => x.length === 1)).toBe(true);
    expect(new Set(radii.flat()).size).toBe(1); // same size throughout
    // A staying ring (a step waiting for a click) doesn't keep waking the overlay to pulse.
    expect(r.nextChange([ring(null)], 1200)).toBe(1200);
    expect(r.nextChange([ring(null)], 5000)).toBe(Infinity);
    const normal = new InkRenderer();
    expect(normal.nextChange([ring(null)], 1000 + 3400 * 3 + 200)).toBeLessThanOrEqual(1000 + 3400 * 3 + 200); // pulsing
    // Normal motion: the ring grows.
    const grow = [1300, 1600].map((t) => {
      const rec = recorder();
      normal.render(rec.ctx, [ring(null)], t, 1);
      return rec.arcs[0]?.r ?? 0;
    });
    expect(grow[1]).toBeGreaterThan(grow[0]);
  });

  it('a step badge fades in without the pop or the ripple', () => {
    const step: InkItem = { id: 's', author: 'tutor', kind: 'step', color: '#2F7BFF', surface: 'screen', at: { x: 50, y: 50 }, num: 1, fontSize: 26, revealAt: 0, drawMs: 550, seed: 1 };
    const r = new InkRenderer();
    r.reducedMotion = true;
    const rec = recorder();
    r.render(rec.ctx, [step], 600, 1);
    expect(rec.arcs.length).toBe(1); // the badge's own outline only: no ripple ring
    const normal = recorder();
    new InkRenderer().render(normal.ctx, [step], 600, 1);
    expect(normal.arcs.length).toBe(2);
  });

  it('a celebration is just the word: no confetti', () => {
    const c = new Celebrations(['#2F7BFF']);
    c.reducedMotion = true;
    c.add({ id: 'c', at: { x: 300, y: 300 }, text: 'nice!', startAt: 0 });
    const rec = recorder();
    c.render(rec.ctx, 300, 1, 'sans-serif');
    expect(rec.texts).toEqual(['nice!']);
    expect(rec.fills()).toBe(0);
    const full = new Celebrations(['#2F7BFF']);
    full.add({ id: 'c', at: { x: 300, y: 300 }, text: 'nice!', startAt: 0 });
    const rec2 = recorder();
    full.render(rec2.ctx, 300, 1, 'sans-serif');
    expect(rec2.fills()).toBeGreaterThan(10);
  });
});
