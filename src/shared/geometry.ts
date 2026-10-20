/**
 * Coordinate system used everywhere in Pairwise:
 *   GLOBAL = Electron screen coordinates in DIPs (points), origin at the primary
 *   display's top-left, y grows downward, other displays may have negative origins.
 *
 * Models never see global coordinates. Every image sent to Gemini carries a FrameRef
 * describing which global DIP rectangle the image covers, and every coordinate a model
 * returns is normalized 0–1000 relative to that image. The helpers below are the only
 * place where those spaces are converted, and they are covered by test/unit/geometry.test.ts.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  /** Electron display id (stringified so it survives JSON/IPC unchanged). */
  id: string;
  /** Global DIP bounds. */
  bounds: Rect;
  workArea: Rect;
  /** Backing scale factor (2 on Retina). Physical pixels = DIP × scaleFactor. */
  scaleFactor: number;
  label: string;
  /** 1-based order (left-to-right, then top-to-bottom) used when talking to the model. */
  index: number;
  isPrimary: boolean;
}

export type FrameKind = 'live' | 'hires' | 'crop' | 'whiteboard';

export interface FrameRef {
  id: string;
  displayId: string;
  /** Global DIP rectangle covered by the encoded image. */
  region: Rect;
  /** Size of the encoded image in pixels. */
  pixelWidth: number;
  pixelHeight: number;
  capturedAt: number;
  kind: FrameKind;
}

/** Gemini box_2d order: [ymin, xmin, ymax, xmax], each 0–1000. */
export type Box2D = [number, number, number, number];

export const NORM = 1000;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function inflateRect(r: Rect, dx: number, dy = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, width: r.width + dx * 2, height: r.height + dy * 2 };
}

export function rectFromPoints(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Clamp a rectangle so it lies inside `bounds` (shrinking it if it is larger). */
export function clampRectInside(r: Rect, bounds: Rect): Rect {
  const width = Math.min(r.width, bounds.width);
  const height = Math.min(r.height, bounds.height);
  const x = clamp(r.x, bounds.x, bounds.x + bounds.width - width);
  const y = clamp(r.y, bounds.y, bounds.y + bounds.height - height);
  return { x, y, width, height };
}

export function clampPointInside(p: Point, bounds: Rect): Point {
  return {
    x: clamp(p.x, bounds.x, bounds.x + bounds.width - 1),
    y: clamp(p.y, bounds.y, bounds.y + bounds.height - 1),
  };
}

/** A rectangle of the given DIP size centred on `center`, kept inside `bounds`. */
export function cropAround(bounds: Rect, center: Point, width: number, height: number): Rect {
  return clampRectInside({ x: center.x - width / 2, y: center.y - height / 2, width, height }, bounds);
}

// ---------------------------------------------------------------------------
// Model space <-> global space
// ---------------------------------------------------------------------------

/** Normalized (0–1000, x then y) point relative to a frame → global DIP point. */
export function normToGlobal(frame: Pick<FrameRef, 'region'>, nx: number, ny: number): Point {
  const { region } = frame;
  return {
    x: region.x + (clamp(nx, 0, NORM) / NORM) * region.width,
    y: region.y + (clamp(ny, 0, NORM) / NORM) * region.height,
  };
}

/** Global DIP point → normalized (0–1000) coordinates of a frame. */
export function globalToNorm(frame: Pick<FrameRef, 'region'>, p: Point): Point {
  const { region } = frame;
  return {
    x: ((p.x - region.x) / region.width) * NORM,
    y: ((p.y - region.y) / region.height) * NORM,
  };
}

/** Gemini box_2d [ymin, xmin, ymax, xmax] (0–1000) → global DIP rect. Tolerates swapped corners. */
export function box2dToGlobal(frame: Pick<FrameRef, 'region'>, box: Box2D): Rect {
  const [a, b, c, d] = box;
  const ymin = Math.min(a, c);
  const ymax = Math.max(a, c);
  const xmin = Math.min(b, d);
  const xmax = Math.max(b, d);
  const p1 = normToGlobal(frame, xmin, ymin);
  const p2 = normToGlobal(frame, xmax, ymax);
  return { x: p1.x, y: p1.y, width: p2.x - p1.x, height: p2.y - p1.y };
}

/** Global DIP rect → Gemini box_2d relative to a frame. */
export function globalToBox2d(frame: Pick<FrameRef, 'region'>, r: Rect): Box2D {
  const p1 = globalToNorm(frame, { x: r.x, y: r.y });
  const p2 = globalToNorm(frame, { x: r.x + r.width, y: r.y + r.height });
  return [Math.round(p1.y), Math.round(p1.x), Math.round(p2.y), Math.round(p2.x)];
}

/** Gemini pointing format [y, x] (0–1000) → global DIP point. */
export function yxToGlobal(frame: Pick<FrameRef, 'region'>, yx: [number, number]): Point {
  return normToGlobal(frame, yx[1], yx[0]);
}

/** Pixel coordinate inside the encoded frame image → global DIP point. */
export function framePixelToGlobal(frame: FrameRef, px: number, py: number): Point {
  return {
    x: frame.region.x + (px / frame.pixelWidth) * frame.region.width,
    y: frame.region.y + (py / frame.pixelHeight) * frame.region.height,
  };
}

/** Global DIP point → pixel coordinate inside the encoded frame image. */
export function globalToFramePixel(frame: FrameRef, p: Point): Point {
  return {
    x: ((p.x - frame.region.x) / frame.region.width) * frame.pixelWidth,
    y: ((p.y - frame.region.y) / frame.region.height) * frame.pixelHeight,
  };
}

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

/** Global DIP point → coordinates local to a display's overlay window. */
export function globalToDisplayLocal(display: Pick<DisplayInfo, 'bounds'>, p: Point): Point {
  return { x: p.x - display.bounds.x, y: p.y - display.bounds.y };
}

export function displayLocalToGlobal(display: Pick<DisplayInfo, 'bounds'>, p: Point): Point {
  return { x: p.x + display.bounds.x, y: p.y + display.bounds.y };
}

/**
 * Global DIP rect → physical-pixel rect inside that display's capture (what a crop of the
 * native-resolution stream must use). Assumes the capture spans the display bounds.
 */
export function globalRectToCapturePixels(display: Pick<DisplayInfo, 'bounds' | 'scaleFactor'>, r: Rect, captureWidth?: number): Rect {
  const scale = captureWidth ? captureWidth / display.bounds.width : display.scaleFactor;
  return {
    x: Math.round((r.x - display.bounds.x) * scale),
    y: Math.round((r.y - display.bounds.y) * scale),
    width: Math.round(r.width * scale),
    height: Math.round(r.height * scale),
  };
}

/** Display containing the point, or the nearest one if the point is in a gap between displays. */
export function displayForPoint<T extends Pick<DisplayInfo, 'bounds'>>(displays: T[], p: Point): T | undefined {
  const inside = displays.find((d) => rectContains(d.bounds, p));
  if (inside) return inside;
  let best: T | undefined;
  let bestDist = Infinity;
  for (const d of displays) {
    const c = clampPointInside(p, d.bounds);
    const dist = distance(c, p);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/** Displays that a global rect touches (used to route overlay work to the right windows). */
export function displaysForRect<T extends Pick<DisplayInfo, 'bounds'>>(displays: T[], r: Rect): T[] {
  return displays.filter((d) => rectsIntersect(d.bounds, r));
}

/** Stable human/model-facing numbering: left-to-right, then top-to-bottom. */
export function numberDisplays<T extends { bounds: Rect; index?: number }>(displays: T[]): T[] {
  const sorted = [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  sorted.forEach((d, i) => (d.index = i + 1));
  return sorted;
}

/** Bounding box of every display (the global desktop). */
export function desktopBounds(displays: Pick<DisplayInfo, 'bounds'>[]): Rect {
  return unionRects(displays.map((d) => d.bounds)) ?? { x: 0, y: 0, width: 0, height: 0 };
}
