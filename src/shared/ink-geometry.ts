import type { Point, Rect } from './geometry';
import type { InkItem } from './ink';

/**
 * Deterministic hand-drawn shape generators, shared by the overlay renderer (which draws them)
 * and the main process (which moves the tutor's cursor along the same path while drawing).
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

/** Marker loop around a rect: starts upper-left, overshoots, slight tilt and radius wobble. */
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
  const ry0 = r.height / 2 + Math.max(8, Math.min(r.height * 0.3, 26));
  // Long loops tilt less, and the tilt's lift at the ends is added to the vertical clearance.
  const tilt = (rand() - 0.5) * 0.12 * Math.min(1, 60 / fit(ry0));
  const rx = fit(ry0);
  const ry = ry0 + Math.abs(Math.sin(tilt)) * rx * 1.1;
  const se = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 2 / ex2);
  const start = -2.55 + (rand() - 0.5) * 0.35;
  const sweep = Math.PI * 2 + 0.42 + rand() * 0.28;
  const ph1 = rand() * Math.PI * 2;
  const ph2 = rand() * Math.PI * 2;
  const circumference = Math.PI * (rx + ry);
  const n = Math.max(48, Math.min(160, Math.round(circumference / 6)));
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + sweep * t;
    const wob = 1 + 0.028 * Math.sin(a * 2 + ph1) + 0.018 * Math.sin(a * 3 + ph2) + (t > 0.82 ? (t - 0.82) * 0.32 : 0);
    const ex = se(Math.cos(a)) * rx * wob;
    const ey = se(Math.sin(a)) * ry * wob;
    pts.push({ x: cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), y: cy + ex * Math.sin(tilt) + ey * Math.cos(tilt) });
  }
  return pts;
}

export function underlinePoints(r: Rect, seed: number): Point[] {
  const rand = rng(seed);
  const y = r.y + r.height + Math.max(3, r.height * 0.12);
  const x1 = r.x - 3;
  const x2 = r.x + r.width + 5;
  const n = Math.max(12, Math.round((x2 - x1) / 8));
  const amp = Math.min(2.2, r.height * 0.08);
  const ph = rand() * Math.PI * 2;
  const tilt = (rand() - 0.5) * 3;
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x1 + (x2 - x1) * t, y: y + Math.sin(t * Math.PI * 2.2 + ph) * amp + tilt * t + (t > 0.9 ? -(t - 0.9) * 18 : 0) });
  }
  return pts;
}

export function highlightPoints(r: Rect, seed: number): Point[] {
  const rand = rng(seed);
  const y = r.y + r.height / 2;
  const x1 = r.x - 2;
  const x2 = r.x + r.width + 2;
  const n = Math.max(8, Math.round((x2 - x1) / 14));
  const skew = (rand() - 0.5) * Math.min(4, r.height * 0.15);
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x1 + (x2 - x1) * t, y: y + skew * (t - 0.5) + Math.sin(t * 9 + seed) * 0.6 });
  }
  return pts;
}

export function boxPoints(r: Rect, seed: number): Point[] {
  const rand = rng(seed);
  const pad = 6;
  const j = () => (rand() - 0.5) * 3;
  const x1 = r.x - pad;
  const y1 = r.y - pad;
  const x2 = r.x + r.width + pad;
  const y2 = r.y + r.height + pad;
  const corners: Point[] = [
    { x: x1 + j(), y: y1 + j() },
    { x: x2 + j() + 3, y: y1 + j() },
    { x: x2 + j(), y: y2 + j() + 2 },
    { x: x1 + j() - 2, y: y2 + j() },
    { x: x1 + j() + 1, y: y1 + j() - 4 },
  ];
  return densify(corners, 6);
}

/** Curly bracket along the left side of a rect. */
export function bracketPoints(r: Rect, seed: number): Point[] {
  const rand = rng(seed);
  const x = r.x - 10 - rand() * 3;
  const w = Math.min(12, Math.max(7, r.height * 0.08));
  const top = r.y - 2;
  const bot = r.y + r.height + 2;
  const mid = (top + bot) / 2;
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

export function arrowShaft(from: Point, to: Point, bend: number, seed: number): Point[] {
  const rand = rng(seed);
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const nx = -(to.y - from.y) / d;
  const ny = (to.x - from.x) / d;
  const b = (bend === 0 ? 0.12 : bend) * d * 0.28 + (rand() - 0.5) * 6;
  const c = { x: (from.x + to.x) / 2 + nx * b, y: (from.y + to.y) / 2 + ny * b };
  const n = Math.max(14, Math.round(d / 7));
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({ x: u * u * from.x + 2 * u * t * c.x + t * t * to.x, y: u * u * from.y + 2 * u * t * c.y + t * t * to.y });
  }
  return pts;
}

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

export function checkPoints(at: Point, size: number): Point[] {
  return densify(
    [
      { x: at.x - size * 0.45, y: at.y },
      { x: at.x - size * 0.1, y: at.y + size * 0.38 },
      { x: at.x + size * 0.55, y: at.y - size * 0.5 },
    ],
    4,
  );
}

export function crossPoints(at: Point, size: number): Point[][] {
  const s = size / 2;
  return [
    densify([{ x: at.x - s, y: at.y - s }, { x: at.x + s, y: at.y + s }], 4),
    densify([{ x: at.x + s, y: at.y - s }, { x: at.x - s, y: at.y + s }], 4),
  ];
}

export function linePoints(from: Point, to: Point, seed: number): Point[] {
  const rand = rng(seed);
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(6, Math.round(d / 10));
  const nx = -(to.y - from.y) / (d || 1);
  const ny = (to.x - from.x) / (d || 1);
  const amp = Math.min(2, d * 0.01);
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
 * Where the pen is when `progress` (0..1, already eased) of an item's strokes is drawn. Progress
 * is spread over the sub-paths by length, exactly like the renderer reveals them.
 */
export function penPoint(shapes: Point[][], progress: number): Point | null {
  if (!shapes.length) return null;
  const lengths = shapes.map((s) => polyLength(s));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= 0) return shapes[0][0] ?? null;
  let remaining = Math.min(1, Math.max(0, progress)) * total;
  for (let i = 0; i < shapes.length; i++) {
    if (remaining <= lengths[i] || i === shapes.length - 1) return pointAlong(shapes[i], lengths[i] ? Math.min(1, remaining / lengths[i]) : 1);
    remaining -= lengths[i];
  }
  return shapes[shapes.length - 1][shapes[shapes.length - 1].length - 1];
}

/** Rough handwritten text width (Caveat 700 is ~0.46 em per character). */
export function approxTextWidth(text: string, fontSize: number): number {
  return Math.max(fontSize, text.length * fontSize * 0.46);
}

/** The pen position for any ink kind (text is "written" left to right along its baseline). */
export function inkPenPoint(item: InkItem, progress: number): Point | null {
  if (item.kind === 'text' && item.at) {
    const size = item.fontSize ?? 27;
    const w = approxTextWidth(item.text ?? '', size);
    const x0 = item.align === 'center' ? item.at.x - w / 2 : item.at.x;
    const y0 = item.align === 'center' ? item.at.y - size * 0.52 : item.at.y;
    return { x: x0 + w * Math.min(1, Math.max(0, progress)), y: y0 + size * 0.85 };
  }
  if ((item.kind === 'step' || item.kind === 'ring') && (item.at || item.rect)) {
    return item.at ?? { x: item.rect!.x + item.rect!.width / 2, y: item.rect!.y + item.rect!.height / 2 };
  }
  return penPoint(inkShapes(item), progress);
}

/** How long drawing an item should take, from the length of its strokes (ms). */
export function drawDurationFor(item: InkItem): number {
  if (item.kind === 'text') return Math.min(1600, 240 + (item.text?.length ?? 0) * 55);
  if (item.kind === 'step') return 420;
  if (item.kind === 'ring') return 900;
  const len = inkShapes(item).reduce((a, s) => a + polyLength(s), 0);
  const base = item.kind === 'highlight' ? 0.55 : 0.75; // ms per px
  return Math.round(Math.min(1300, Math.max(320, 200 + len * base * (item.kind === 'arrow' ? 0.8 : 1))));
}

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
      const shaft = arrowShaft(item.from, item.to, item.bend ?? 0, s);
      const len = Math.hypot(item.to.x - item.from.x, item.to.y - item.from.y);
      return [shaft, arrowHead(shaft, Math.min(24, 12 + len * 0.06))];
    }
    case 'line':
      return item.from && item.to ? [linePoints(item.from, item.to, s)] : [];
    case 'check':
      return item.at ? [checkPoints(item.at, item.fontSize ?? 26)] : [];
    case 'cross':
      return item.at ? crossPoints(item.at, item.fontSize ?? 22) : [];
    case 'stroke':
      return item.points?.length ? [item.points] : [];
    default:
      return [];
  }
}
