import type { Point, Rect } from './geometry';
import type { CursorFlight, CursorTrace, InkItem } from './ink';

/**
 * Deterministic hand-drawn shape generators and the pen model, shared by the overlay renderer
 * (which draws the ink) and the main process (which moves the tutor's cursor along the same
 * path, at the same moments). Everything is a pure function of the item and its seed, so every
 * display draws exactly the same marks and the cursor is always on the stroke being drawn.
 *
 * Marks vary from seed to seed like a person's would (no two arrows or circles are the same),
 * and the pen moves like a hand: each stroke speeds up and slows down (minimum jerk), slows
 * into corners, and lifts between strokes.
 */

export function rng(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smoothstep = (t: number): number => t * t * (3 - 2 * t);
/** Minimum-jerk position profile (0→1): how a hand moves from rest to rest. */
export const minJerk = (t: number): number => t * t * t * (10 + t * (-15 + 6 * t));
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Uniform in [a, b). */
const between = (r: () => number, a: number, b: number) => a + (b - a) * r();
/** -1 or 1. */
const side = (r: () => number) => (r() < 0.5 ? -1 : 1);

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

/**
 * Marker loop around a rect. Starts mostly at the upper left, goes either way round (more often
 * anticlockwise, like most right-handed people), overshoots its start by 8–25°, tilts up to ±4°
 * and wobbles 1.5–3 % in radius — and always clears the target's corners.
 */
export function circlePoints(r: Rect, seed: number): Point[] {
  const rand = rng(seed);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  // A loop that clears the target's corners: an ellipse for squarish things, squarer
  // (superellipse, exponent 2.2 → 3.1) for wide ones so a long line isn't circled 60 px wide.
  const aspect = Math.max(r.width, 1) / Math.max(r.height, 1);
  const ex2 = 2.2 + Math.min(0.9, Math.max(0, (aspect - 1) / 3));
  // Smallest half-width that keeps the corners inside even at the wobble's narrowest (×0.95).
  const W0 = 0.95;
  const fit = (ry: number) => r.width / 2 / (W0 * Math.pow(Math.max(0.12, 1 - Math.pow(r.height / 2 / (W0 * ry), ex2)), 1 / ex2)) + 3;
  const ry0 = r.height / 2 + Math.max(8, Math.min(r.height * 0.3, 26)) + between(rand, -1, 2);
  // Long loops tilt less, and the tilt's lift at the ends is added to the vertical clearance.
  const tilt = between(rand, -0.07, 0.07) * Math.min(1, 60 / fit(ry0));
  const rx = fit(ry0) + between(rand, 0, 3);
  const ry = ry0 + Math.abs(Math.sin(tilt)) * rx * 1.1;
  const se = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 2 / ex2);
  const dir = rand() < 0.65 ? -1 : 1; // -1: anticlockwise on screen
  const start = rand() < 0.82 ? between(rand, -2.8, -1.75) : between(rand, -Math.PI, Math.PI);
  const overshoot = between(rand, 0.14, 0.44); // 8–25°
  const sweep = (Math.PI * 2 + overshoot) * dir;
  // Low-frequency radius wobble: 1.5–3 % in total, never pulling in past W0.
  const amp = between(rand, 0.015, 0.03);
  const split = between(rand, 0.35, 0.75);
  const ph1 = rand() * Math.PI * 2;
  const ph2 = rand() * Math.PI * 2;
  const f2 = rand() < 0.5 ? 3 : 1;
  const drift = between(rand, 0.02, 0.07); // the end spirals out a little as the hand lifts
  const circumference = Math.PI * (rx + ry);
  const n = Math.max(48, Math.min(160, Math.round(circumference / 6)));
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + sweep * t;
    const wob = 1 + amp * split * Math.sin(a * 2 + ph1) + amp * (1 - split) * Math.sin(a * f2 + ph2) + (t > 0.8 ? ((t - 0.8) / 0.2) * drift : 0);
    const ex = se(Math.cos(a)) * rx * wob;
    const ey = se(Math.sin(a)) * ry * wob;
    pts.push({ x: cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), y: cy + ex * Math.sin(tilt) + ey * Math.cos(tilt) });
  }
  return pts;
}

/** Under a word: tilts up to ±1.5°, sags a little, ±4 % in length, sometimes a hook at the end. */
export function underlinePoints(r: Rect, seed: number): Point[] {
  const rand = rng(seed);
  const y = r.y + r.height + Math.max(3, r.height * 0.12);
  const len = r.width + 8;
  const x1 = r.x - 2 - between(rand, 0, 0.03) * len;
  const x2 = Math.max(r.x + r.width - 3, r.x + r.width + 4 + between(rand, -0.025, 0.04) * len);
  const n = Math.max(12, Math.round((x2 - x1) / 7));
  // ±1.5°, but never more than ±3.5 px over the whole line (long lines stay under their text).
  const rise = Math.max(-3.5, Math.min(3.5, Math.tan(between(rand, -0.026, 0.026)) * (x2 - x1)));
  const sag = between(rand, 0.4, 1.8) * side(rand);
  const amp = Math.min(1.2, r.height * 0.05);
  const ph = rand() * Math.PI * 2;
  const hook = rand() < 0.35 ? between(rand, 3, 6) : 0;
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const end = t > 0.92 ? Math.pow((t - 0.92) / 0.08, 2) : 0;
    pts.push({ x: x1 + (x2 - x1) * t - end * hook * 0.6, y: y + rise * (t - 0.5) + sag * Math.sin(t * Math.PI) + Math.sin(t * Math.PI * 2.2 + ph) * amp - end * hook });
  }
  return pts;
}

export function highlightPoints(r: Rect, seed: number): Point[] {
  const rand = rng(seed);
  const y = r.y + r.height / 2 + between(rand, -1, 1);
  const x1 = r.x - between(rand, 1, 4);
  const x2 = r.x + r.width + between(rand, 0, 4);
  const n = Math.max(8, Math.round((x2 - x1) / 14));
  const skew = between(rand, -0.5, 0.5) * Math.min(4, r.height * 0.15);
  const ph = rand() * 9;
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x1 + (x2 - x1) * t, y: y + skew * (t - 0.5) + Math.sin(t * 9 + ph) * 0.6 });
  }
  return pts;
}

/** A box drawn in one go: usually from the top-left corner, sides slightly bowed, closing past the start. */
export function boxPoints(r: Rect, seed: number): Point[] {
  const rand = rng(seed);
  const pad = 6;
  const j = () => between(rand, -1.6, 1.6);
  const x1 = r.x - pad;
  const y1 = r.y - pad;
  const x2 = r.x + r.width + pad;
  const y2 = r.y + r.height + pad;
  let corners: Point[] = [
    { x: x1 + j(), y: y1 + j() },
    { x: x2 + j() + 2, y: y1 + j() },
    { x: x2 + j(), y: y2 + j() + 1.5 },
    { x: x1 + j() - 1.5, y: y2 + j() },
  ];
  if (rand() < 0.2) corners = [corners[0], corners[3], corners[2], corners[1]]; // anticlockwise
  const over = between(rand, 6, 14);
  const a = corners[0];
  const b = corners[1];
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const close = { x: a.x + ((b.x - a.x) / d) * over + between(rand, -1, 1), y: a.y + ((b.y - a.y) / d) * over + between(rand, -2.5, 0.5) };
  const loop = [...corners, a];
  const out: Point[] = [];
  for (let i = 0; i < loop.length - 1; i++) {
    const p = loop[i];
    const q = loop[i + 1];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(2, Math.round(len / 6));
    const bow = between(rand, -1.6, 1.6);
    const nx = -(q.y - p.y) / (len || 1);
    const ny = (q.x - p.x) / (len || 1);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const s = Math.sin(t * Math.PI) * bow;
      out.push({ x: p.x + (q.x - p.x) * t + nx * s, y: p.y + (q.y - p.y) * t + ny * s });
    }
  }
  out.push(...densify([a, close], 6));
  return out;
}

/** Curly bracket along the left side of a rect. */
export function bracketPoints(r: Rect, seed: number): Point[] {
  const rand = rng(seed);
  const x = r.x - 10 - rand() * 3;
  const w = Math.min(12, Math.max(7, r.height * 0.08)) * between(rand, 0.85, 1.15);
  const top = r.y - 2;
  const bot = r.y + r.height + 2;
  const mid = (top + bot) / 2 + between(rand, -0.04, 0.04) * (bot - top);
  const pts: Point[] = [];
  const seg = (a: Point, c: Point, b: Point, n = 10) => {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      pts.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
    }
  };
  seg({ x: x + w, y: top }, { x, y: top }, { x, y: top + (mid - top) * 0.3 });
  seg({ x, y: top + (mid - top) * 0.3 }, { x, y: mid }, { x: x - w, y: mid });
  seg({ x: x - w, y: mid }, { x, y: mid }, { x, y: mid + (bot - mid) * 0.7 });
  seg({ x, y: mid + (bot - mid) * 0.7 }, { x, y: bot }, { x: x + w, y: bot });
  return pts;
}

/**
 * An arrow's shaft: bowed ±4–12 % of its length to a random side (±1–3 % for diagram edges,
 * `bend` 0), with a faint tremor.
 */
export function arrowShaft(from: Point, to: Point, bend: number, seed: number): Point[] {
  const rand = rng(seed);
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const nx = -(to.y - from.y) / d;
  const ny = (to.x - from.x) / d;
  const bow = (bend === 0 ? between(rand, 0.01, 0.03) : between(rand, 0.04, 0.12)) * side(rand);
  // A quadratic's middle sits half-way to its control point: control at 2× the bow.
  const b = bow * d * 2;
  const c = { x: (from.x + to.x) / 2 + nx * b, y: (from.y + to.y) / 2 + ny * b };
  const n = Math.max(14, Math.round(d / 7));
  const tremor = Math.min(0.8, d * 0.004);
  const ph = rand() * Math.PI * 2;
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const w = Math.sin(t * Math.PI * 3 + ph) * tremor * Math.sin(t * Math.PI);
    pts.push({ x: u * u * from.x + 2 * u * t * c.x + t * t * to.x + nx * w, y: u * u * from.y + 2 * u * t * c.y + t * t * to.y + ny * w });
  }
  return pts;
}

/**
 * Arrowhead strokes at the shaft's tip: 22–35° wide, 12–18 px long, slightly lopsided. Drawn
 * either as one "V" (one barb's end → tip → other barb) or as two separate barbs from the tip.
 */
export function arrowHeads(shaft: Point[], arrowLength: number, seed: number): Point[][] {
  const rand = rng(seed ^ 0x5bd1e995);
  const end = shaft[shaft.length - 1];
  // Direction of the last few pixels of the shaft (not just the last segment).
  let k = shaft.length - 2;
  while (k > 0 && Math.hypot(end.x - shaft[k].x, end.y - shaft[k].y) < 10) k--;
  const prev = shaft[Math.max(0, k)];
  const ang = Math.atan2(end.y - prev.y, end.x - prev.x);
  const spread = between(rand, 22, 35) * (Math.PI / 180);
  const size = Math.min(18, Math.max(12, 11 + arrowLength * 0.03 + between(rand, -1.5, 2.5)));
  const lop = between(rand, -0.15, 0.15);
  const skew = between(rand, -4, 4) * (Math.PI / 180);
  const a1 = ang + Math.PI - spread + skew;
  const a2 = ang + Math.PI + spread + skew;
  const b1 = { x: end.x + Math.cos(a1) * size * (1 + lop), y: end.y + Math.sin(a1) * size * (1 + lop) };
  const b2 = { x: end.x + Math.cos(a2) * size * (1 - lop), y: end.y + Math.sin(a2) * size * (1 - lop) };
  if (rand() < 0.55) return [densify([b1, end, b2], 4)];
  return [densify([end, b1], 4), densify([end, b2], 4)];
}

/** Kept for callers that want a single head polyline (one "V"). */
export function arrowHead(shaft: Point[], size: number): Point[] {
  const end = shaft[shaft.length - 1];
  const prev = shaft[Math.max(0, shaft.length - 4)];
  const ang = Math.atan2(end.y - prev.y, end.x - prev.x);
  const a1 = ang + Math.PI - 0.5;
  const a2 = ang + Math.PI + 0.5;
  return [
    { x: end.x + Math.cos(a1) * size, y: end.y + Math.sin(a1) * size },
    { x: end.x, y: end.y },
    { x: end.x + Math.cos(a2) * size * 0.92, y: end.y + Math.sin(a2) * size * 0.92 },
  ];
}

export function checkPoints(at: Point, size: number, seed = 1): Point[] {
  const rand = rng(seed);
  const s = size * between(rand, 0.92, 1.08);
  const dip = { x: at.x - s * between(rand, 0.05, 0.15), y: at.y + s * between(rand, 0.32, 0.42) };
  const start = { x: at.x - s * between(rand, 0.4, 0.5), y: at.y + between(rand, -0.06, 0.06) * s };
  const end = { x: at.x + s * between(rand, 0.48, 0.6), y: at.y - s * between(rand, 0.45, 0.58) };
  // The long stroke curves a little, like a flick of the wrist.
  const c = { x: (dip.x + end.x) / 2 - s * 0.06, y: (dip.y + end.y) / 2 + s * between(rand, 0, 0.08) };
  const out = densify([start, dip], 4);
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const u = 1 - t;
    out.push({ x: u * u * dip.x + 2 * u * t * c.x + t * t * end.x, y: u * u * dip.y + 2 * u * t * c.y + t * t * end.y });
  }
  return out;
}

export function crossPoints(at: Point, size: number, seed = 1): Point[][] {
  const rand = rng(seed);
  const s = (size / 2) * between(rand, 0.9, 1.1);
  const tw = () => between(rand, -0.1, 0.1);
  const a = [{ x: at.x - s * (1 + tw()), y: at.y - s * (1 + tw()) }, { x: at.x + s * (1 + tw()), y: at.y + s * (1 + tw()) }];
  const b = [{ x: at.x + s * (1 + tw()), y: at.y - s * (1 + tw()) }, { x: at.x - s * (1 + tw()), y: at.y + s * (1 + tw()) }];
  return rand() < 0.75 ? [densify(a, 4), densify(b, 4)] : [densify(b, 4), densify(a, 4)];
}

export function linePoints(from: Point, to: Point, seed: number): Point[] {
  const rand = rng(seed);
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(6, Math.round(d / 10));
  const nx = -(to.y - from.y) / (d || 1);
  const ny = (to.x - from.x) / (d || 1);
  const amp = Math.min(2, d * 0.01) * between(rand, 0.4, 1.2);
  const ph = rand() * 6;
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = Math.sin(t * Math.PI + ph) * amp * Math.sin(t * Math.PI);
    pts.push({ x: from.x + (to.x - from.x) * t + nx * w, y: from.y + (to.y - from.y) * t + ny * w });
  }
  return pts;
}

export function densify(pts: Point[], step: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(d / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function polyLength(pts: Point[]): number {
  let d = 0;
  for (let i = 0; i < pts.length - 1; i++) d += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  return d;
}

/** First `p` (0..1) of a polyline by arc length, with the last point interpolated. */
export function partial(pts: Point[], p: number): Point[] {
  if (p >= 1 || pts.length < 2) return pts;
  if (p <= 0) return pts.slice(0, 1);
  let total = 0;
  const segs: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segs.push(d);
    total += d;
  }
  let target = total * p;
  const out: Point[] = [pts[0]];
  for (let i = 0; i < segs.length; i++) {
    if (target >= segs[i]) {
      out.push(pts[i + 1]);
      target -= segs[i];
    } else {
      const t = segs[i] === 0 ? 0 : target / segs[i];
      out.push({ x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t });
      break;
    }
  }
  return out;
}

/** Point at arc-length fraction `p` along a polyline. */
export function pointAlong(pts: Point[], p: number): Point {
  const part = partial(pts, Math.min(1, Math.max(0, p)));
  return part[part.length - 1];
}

/**
 * The brush path through a polyline: midpoint quadratic smoothing (each segment curves to the
 * midpoint of the next two points, using the point as its control), as Tuple's paint does.
 * Feeds a Path2D (renderer) or a flattener (tests).
 */
export function smoothPath(pts: Point[], sink: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; quadraticCurveTo(cx: number, cy: number, x: number, y: number): void }): void {
  if (!pts.length) return;
  sink.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) return;
  if (pts.length === 2) {
    sink.lineTo(pts[1].x, pts[1].y);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    sink.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
  }
  const last = pts[pts.length - 1];
  sink.lineTo(last.x, last.y);
}

/** smoothPath sampled into points (`step` px or finer). */
export function flattenSmooth(pts: Point[], step = 1): Point[] {
  const out: Point[] = [];
  let cur: Point = pts[0] ?? { x: 0, y: 0 };
  smoothPath(pts, {
    moveTo: (x, y) => {
      cur = { x, y };
      out.push(cur);
    },
    lineTo: (x, y) => {
      const n = Math.max(1, Math.ceil(Math.hypot(x - cur.x, y - cur.y) / step));
      for (let i = 1; i <= n; i++) out.push({ x: cur.x + ((x - cur.x) * i) / n, y: cur.y + ((y - cur.y) * i) / n });
      cur = { x, y };
    },
    quadraticCurveTo: (cx, cy, x, y) => {
      const n = Math.max(2, Math.ceil((Math.hypot(cx - cur.x, cy - cur.y) + Math.hypot(x - cx, y - cy)) / step));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        out.push({ x: u * u * cur.x + 2 * u * t * cx + t * t * x, y: u * u * cur.y + 2 * u * t * cy + t * t * y });
      }
      cur = { x, y };
    },
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** The tutor's typed notes: the system font, semibold (SF Pro on a Mac), like Tuple's text tool. */
export const NOTE_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter Variable', sans-serif";
export const NOTE_WEIGHT = 600;
/** Handwritten notes (Settings → Ada writes notes → Handwritten). */
export const HAND_FONT = "'Caveat', 'Bradley Hand', cursive";
export const HAND_WEIGHT = 700;

// Advance widths in em, measured from Inter 600 (a close stand-in for SF Pro Text Semibold) and
// Caveat 700 in Chromium. Classes rather than every glyph: good to a few percent on phrases.
const SYS = { space: 0.252, narrow: 0.27, punct: 0.32, bracket: 0.373, semi: 0.38, lower: 0.575, upper: 0.7, digit: 0.61, one: 0.423, wide: 0.88, wideUpper: 0.97, other: 0.62, arrow: 1 };
const HAND = { space: 0.242, narrow: 0.19, punct: 0.2, bracket: 0.33, semi: 0.33, lower: 0.385, upper: 0.52, digit: 0.449, one: 0.45, wide: 0.54, wideUpper: 0.72, other: 0.45, arrow: 1 };

function charEm(ch: string, t: typeof SYS): number {
  if (ch === ' ') return t.space;
  if ("ijlI|'`".includes(ch)) return t.narrow;
  if ('.,:;!'.includes(ch)) return t.punct;
  if ('()[]{}'.includes(ch)) return t.bracket;
  if ('ftr'.includes(ch)) return t.semi;
  if (ch === 'm' || ch === 'w') return t.wide;
  if (ch === 'M' || ch === 'W') return t.wideUpper;
  if (ch === '1') return t.one;
  if (ch >= '0' && ch <= '9') return t.digit;
  if (ch >= 'a' && ch <= 'z') return t.lower;
  if (ch >= 'A' && ch <= 'Z') return t.upper;
  if ('→←—–×'.includes(ch)) return ch === '×' ? 0.67 : t.arrow;
  return t.other;
}

/** Estimated width of a single line of note text (px). `font` defaults to the typed system font. */
export function approxTextWidth(text: string, fontSize: number, font: InkItem['font'] = 'system'): number {
  const table = font === 'hand' ? HAND : SYS;
  let em = 0;
  for (const ch of text) em += charEm(ch, table);
  return Math.max(fontSize * 0.6, em * fontSize);
}

/**
 * When each character of a typed note appears (ms from the start, before scaling to drawMs):
 * 45–110 ms per key, a longer pause after a space and longer still after punctuation, like a
 * person typing a short note. The first key lands a moment after the click.
 */
export function typingPlan(text: string, seed: number): number[] {
  const rand = rng(seed ^ 0x2c1b3c6d);
  const out: number[] = [];
  let t = between(rand, 110, 200);
  const chars = [...text];
  chars.forEach((ch, i) => {
    out.push(t);
    let d = between(rand, 45, 110);
    if (ch === ' ') d += between(rand, 40, 120);
    else if (',;:'.includes(ch)) d += between(rand, 110, 220);
    else if ('.!?'.includes(ch)) d += between(rand, 160, 280);
    // Doubled letters and common pairs come fast; the odd hesitation doesn't.
    if (i > 0 && chars[i - 1] === ch) d *= 0.7;
    if (rand() < 0.04) d += between(rand, 120, 260);
    t += d;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Items → strokes
// ---------------------------------------------------------------------------------------------

/** Centerline sub-paths of an ink item (what the renderer strokes and the cursor traces). */
export function inkShapes(item: InkItem): Point[][] {
  const s = item.seed;
  switch (item.kind) {
    case 'circle':
      return item.rect ? [circlePoints(item.rect, s)] : [];
    case 'underline':
      return item.rect ? [underlinePoints(item.rect, s)] : [];
    case 'highlight':
      return item.rect ? [highlightPoints(item.rect, s)] : [];
    case 'box':
      return item.rect ? [boxPoints(item.rect, s)] : [];
    case 'bracket':
      return item.rect ? [bracketPoints(item.rect, s)] : [];
    case 'arrow': {
      if (!item.from || !item.to) return [];
      const shaft = arrowShaft(item.from, item.to, item.bend ?? 0.18, s);
      const len = Math.hypot(item.to.x - item.from.x, item.to.y - item.from.y);
      return [shaft, ...arrowHeads(shaft, len, s)];
    }
    case 'line':
      return item.from && item.to ? [linePoints(item.from, item.to, s)] : [];
    case 'check':
      return item.at ? [checkPoints(item.at, item.fontSize ?? 26, s)] : [];
    case 'cross':
      return item.at ? crossPoints(item.at, item.fontSize ?? 22, s) : [];
    case 'stroke':
      return item.points?.length ? [item.points] : [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// The pen: when each stroke is drawn, and where the pen is
// ---------------------------------------------------------------------------------------------

interface StrokeTiming {
  pts: Point[];
  len: number;
  /** Cumulative arc length at each point. */
  arc: Float64Array;
  /** Cumulative "effort" at each point: arc length weighted up around corners. */
  effort: Float64Array;
  /** Natural start / end (ms) within the item. */
  t0: number;
  t1: number;
}

interface PenTiming {
  sig: string;
  strokes: StrokeTiming[];
  /** Natural duration (ms) before scaling to item.drawMs. */
  natural: number;
  /** Typed text: when each character appears (natural ms). */
  keys?: number[];
}

const timingCache = new WeakMap<InkItem, PenTiming>();

function signature(it: InkItem): string {
  const r = it.rect;
  return `${it.kind}|${it.seed}|${r ? `${r.x},${r.y},${r.width},${r.height}` : ''}|${it.from?.x},${it.from?.y}|${it.to?.x},${it.to?.y}|${it.at?.x},${it.at?.y}|${it.fontSize}|${it.text}|${it.points?.length}|${it.bend}|${it.font}`;
}

/** Turning per pixel around each point, spread over ~3 neighbours either side. */
function cornerWeights(pts: Point[]): number[] {
  const n = pts.length;
  const turn = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[i].x - pts[i - 1].x;
    const ay = pts[i].y - pts[i - 1].y;
    const bx = pts[i + 1].x - pts[i].x;
    const by = pts[i + 1].y - pts[i].y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
    turn[i] = Math.acos(cos) / Math.max(2, (la + lb) / 2);
  }
  let w = turn;
  for (let pass = 0; pass < 3; pass++) {
    const next = w.slice();
    for (let i = 0; i < n; i++) next[i] = ((w[i - 1] ?? w[i]) + 2 * w[i] + (w[i + 1] ?? w[i])) / 4;
    w = next;
  }
  // ≈ +140 % time per pixel at a sharp corner, ~+15 % around a tight circle.
  return w.map((c) => 1 + 1.4 * Math.min(1, c / 0.12));
}

function strokeTiming(pts: Point[]): Omit<StrokeTiming, 't0' | 't1'> {
  const n = pts.length;
  const arc = new Float64Array(n);
  const effort = new Float64Array(n);
  const w = cornerWeights(pts);
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    arc[i] = arc[i - 1] + d;
    effort[i] = effort[i - 1] + d * (w[i - 1] + w[i]) / 2;
  }
  return { pts, len: arc[n - 1] ?? 0, arc, effort };
}

/** ms per px and fixed costs, ~30 % slower than round 1's pen. */
const PEN = { firstStroke: 260, nextStroke: 120, msPerPx: 0.975, highlightMsPerPx: 0.72 };

function timingFor(item: InkItem): PenTiming {
  const sig = signature(item);
  const hit = timingCache.get(item);
  if (hit && hit.sig === sig) return hit;
  let t: PenTiming;
  if (item.kind === 'text') {
    const text = item.text ?? '';
    if (item.font === 'hand') t = { sig, strokes: [], natural: Math.max(300, (240 + [...text].length * 55) * 1.3) };
    else {
      const keys = typingPlan(text, item.seed);
      t = { sig, strokes: [], natural: (keys[keys.length - 1] ?? 0) + 90, keys };
    }
  } else if (item.kind === 'step') t = { sig, strokes: [], natural: 550 };
  else if (item.kind === 'ring') t = { sig, strokes: [], natural: 900 };
  else {
    const rand = rng(item.seed ^ 0x68e31da4);
    const rate = item.kind === 'highlight' ? PEN.highlightMsPerPx : PEN.msPerPx;
    const strokes: StrokeTiming[] = [];
    let at = 0;
    inkShapes(item).forEach((pts, i) => {
      if (i > 0) at += between(rand, 80, 200); // pen lift, travelling to the next stroke
      const st = strokeTiming(pts);
      const d = (i === 0 ? PEN.firstStroke : PEN.nextStroke) + st.len * rate * (st.effort[st.effort.length - 1] / Math.max(1e-6, st.len) || 1) * 0.86;
      strokes.push({ ...st, t0: at, t1: at + d });
      at += d;
    });
    t = { sig, strokes, natural: Math.max(1, at) };
  }
  timingCache.set(item, t);
  return t;
}

/** How long drawing an item should take (ms): its strokes at the pen's pace, plus pen lifts. */
export function drawDurationFor(item: InkItem): number {
  const t = timingFor(item);
  // Diagram labels on the whiteboard are typed briskly (a diagram has many of them).
  if (item.kind === 'text' && item.surface === 'whiteboard') return Math.round(Math.min(900, Math.max(240, t.natural * 0.6)));
  if (item.kind === 'text') return Math.round(Math.min(item.font === 'hand' ? 2100 : 3800, Math.max(260, t.natural)));
  if (item.kind === 'step' || item.kind === 'ring') return Math.round(t.natural);
  return Math.round(Math.min(1900, Math.max(420, t.natural)));
}

export interface PenState {
  /** Fraction (0..1, by arc length) of each sub-stroke drawn so far. */
  reveal: number[];
  /** Where the pen (the cursor's tip) is. */
  pen: Point | null;
  /** Text: characters shown so far. */
  chars: number;
  /** Whether the pen is touching the paper (false during lifts and before/after). */
  down: boolean;
  done: boolean;
}

/** Arc-length position reached by `e` (0..1) of a stroke's effort. */
function arcAtEffort(st: Omit<StrokeTiming, 't0' | 't1'>, e: number): number {
  const total = st.effort[st.effort.length - 1] ?? 0;
  if (total <= 0) return 0;
  const target = e * total;
  let lo = 0;
  let hi = st.effort.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (st.effort[mid] <= target) lo = mid;
    else hi = mid;
  }
  const de = st.effort[hi] - st.effort[lo];
  const k = de > 0 ? (target - st.effort[lo]) / de : 0;
  return st.arc[lo] + (st.arc[hi] - st.arc[lo]) * k;
}

function pointAtArc(st: Omit<StrokeTiming, 't0' | 't1'>, s: number): Point {
  const pts = st.pts;
  if (pts.length === 1 || st.len <= 0) return pts[0];
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (st.arc[mid] <= s) lo = mid;
    else hi = mid;
  }
  const da = st.arc[hi] - st.arc[lo];
  const k = da > 0 ? Math.min(1, Math.max(0, (s - st.arc[lo]) / da)) : 0;
  return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * k, y: pts[lo].y + (pts[hi].y - pts[lo].y) * k };
}

/** Where a typed note's writer "clicked" to place it (the cursor rests here while typing). */
export function textAnchor(item: InkItem): Point | null {
  if (!item.at) return null;
  const size = item.fontSize ?? 19;
  const w = approxTextWidth(item.text ?? '', size, item.font);
  const x0 = item.align === 'center' ? item.at.x - w / 2 : item.at.x;
  const y0 = item.align === 'center' ? item.at.y - size * 0.6 : item.at.y;
  return { x: x0 - 3, y: y0 + size * 0.72 };
}

/**
 * The state of an item `ms` after it starts drawing: how much of each stroke is down, where the
 * pen is and (for text) how many characters are showing. The renderer reveals ink from this and
 * the cursor follows `pen`, so the two can't drift apart.
 */
export function penStateAt(item: InkItem, ms: number): PenState {
  const t = timingFor(item);
  const k = item.drawMs > 0 ? item.drawMs / t.natural : 1;
  const local = ms / k;
  const finished = ms >= item.drawMs;
  if (item.kind === 'text') {
    const n = [...(item.text ?? '')].length;
    if (item.font === 'hand' || !t.keys) {
      const p = clamp01(ms / Math.max(1, item.drawMs));
      const e = easeInOut(p);
      let pen: Point | null = null;
      if (item.at) {
        const size = item.fontSize ?? 27;
        const w = approxTextWidth(item.text ?? '', size, 'hand');
        const x0 = item.align === 'center' ? item.at.x - w / 2 : item.at.x;
        const y0 = item.align === 'center' ? item.at.y - size * 0.52 : item.at.y;
        pen = { x: x0 + w * e, y: y0 + size * 0.85 };
      }
      return { reveal: [], pen, chars: finished ? n : Math.floor(e * n + 1e-9), down: !finished && ms >= 0, done: finished };
    }
    let chars = 0;
    while (chars < t.keys.length && t.keys[chars] <= local) chars++;
    return { reveal: [], pen: textAnchor(item), chars: finished ? n : chars, down: false, done: finished };
  }
  if (item.kind === 'step' || item.kind === 'ring' || !t.strokes.length) {
    const pen = item.at ?? (item.rect ? { x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 } : null);
    return { reveal: t.strokes.map(() => (finished ? 1 : 0)), pen, chars: 0, down: false, done: finished };
  }
  const reveal: number[] = [];
  let pen: Point | null = null;
  let down = false;
  for (let i = 0; i < t.strokes.length; i++) {
    const st = t.strokes[i];
    if (local >= st.t1 || finished) {
      reveal.push(1);
      continue;
    }
    if (local <= st.t0) {
      reveal.push(0);
      if (pen === null) {
        // Before this stroke: on the way here from the previous one (a pen lift), or not started.
        const prev = t.strokes[i - 1];
        if (!prev) pen = st.pts[0];
        else {
          const lift = Math.max(1, st.t0 - prev.t1);
          const u = smoothstep(clamp01((local - prev.t1) / lift));
          const a = prev.pts[prev.pts.length - 1];
          const b = st.pts[0];
          pen = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        }
      }
      continue;
    }
    const tau = (local - st.t0) / Math.max(1, st.t1 - st.t0);
    const e = 0.82 * minJerk(tau) + 0.18 * tau;
    const s = arcAtEffort(st, e);
    reveal.push(st.len > 0 ? Math.min(1, s / st.len) : 1);
    pen = pointAtArc(st, s);
    down = true;
  }
  if (!pen) {
    const last = t.strokes[t.strokes.length - 1];
    pen = last.pts[last.pts.length - 1];
  }
  return { reveal, pen, chars: 0, down, done: finished };
}

/** The pen position for any ink kind at `progress` (0..1) of its drawing time. */
export function inkPenPoint(item: InkItem, progress: number): Point | null {
  if (item.kind === 'text') return item.font === 'hand' ? penStateAt(item, clamp01(progress) * Math.max(1, item.drawMs)).pen : textAnchor(item);
  if ((item.kind === 'step' || item.kind === 'ring') && (item.at || item.rect)) {
    return item.at ?? { x: item.rect!.x + item.rect!.width / 2, y: item.rect!.y + item.rect!.height / 2 };
  }
  const shapes = timingFor(item).strokes;
  if (!shapes.length) return null;
  if (progress <= 0) return shapes[0].pts[0];
  if (progress >= 1) {
    const last = shapes[shapes.length - 1].pts;
    return last[last.length - 1];
  }
  return penStateAt(item, progress * Math.max(1, item.drawMs)).pen;
}

/**
 * Where a pointer-only gesture is at `t` (0..1 of its time): `glide` eases along the path,
 * `read` moves at a steady reading pace (easing only at the ends), `sweep` treats the path's
 * points as lines of a list — it rests on each, then moves on to the next.
 */
export function glidePoint(path: Point[], t: number, style: NonNullable<CursorTrace['style']>): Point {
  if (!path.length) return { x: 0, y: 0 };
  if (path.length === 1) return path[0];
  const u = clamp01(t);
  if (style === 'sweep') {
    const moves = path.length - 1;
    const i = Math.min(moves - 1, Math.floor(u * moves));
    const local = u * moves - i;
    // Rest on the line (reading it), then a quick, eased move down to the next.
    const m = local < 0.45 ? 0 : easeInOut((local - 0.45) / 0.55);
    const a = path[i];
    const b = path[i + 1];
    return { x: a.x + (b.x - a.x) * m, y: a.y + (b.y - a.y) * m };
  }
  if (style === 'read') {
    // Trapezoid speed: 12 % to get going, steady, 12 % to stop.
    const acc = 0.12;
    const vmax = 1 / (1 - acc);
    let s: number;
    if (u < acc) s = (vmax * u * u) / (2 * acc);
    else if (u > 1 - acc) s = 1 - (vmax * (1 - u) * (1 - u)) / (2 * acc);
    else s = vmax * (u - acc / 2);
    return pointAlong(path, s);
  }
  return pointAlong(path, easeInOut(u));
}

/**
 * Where a cursor flight is at `now`: along its gentle curve with a minimum-jerk speed profile
 * (how a hand moves a mouse from rest to rest). Shared by main and the overlays.
 */
export function flightPoint(f: CursorFlight, now: number): { p: Point; t: number; done: boolean } {
  const lin = clamp01((now - f.startAt) / Math.max(1, f.duration));
  const t = minJerk(lin);
  const u = 1 - t;
  const p = {
    x: u * u * f.from.x + 2 * u * t * f.ctrl.x + t * t * f.to.x,
    y: u * u * f.from.y + 2 * u * t * f.ctrl.y + t * t * f.to.y,
  };
  return { p, t: lin, done: lin >= 1 };
}
