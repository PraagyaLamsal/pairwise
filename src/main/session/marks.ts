import { clampPointInside, inflateRect, intersectRect, rectCenter, type Point, type Rect } from '@shared/geometry';
import { inkId, seedFrom, type InkItem, type InkKind } from '@shared/ink';
import { approxTextWidth, drawDurationFor } from '@shared/ink-geometry';

/** A mark the tutor wants to make, already located on screen (global DIP). */
export interface MarkSpec {
  kind: Extract<InkKind, 'circle' | 'underline' | 'highlight' | 'box' | 'bracket' | 'arrow' | 'text' | 'step' | 'check' | 'cross' | 'ring' | 'line'>;
  /** What it marks (rect of the target). Arrows point at it; notes sit beside it. */
  rect?: Rect;
  /** Explicit position for free-floating notes / badges. */
  at?: Point;
  /** Explicit arrow start (else a clear spot near the target is chosen). */
  from?: Point;
  to?: Point;
  text?: string;
  num?: number;
  label?: string;
}

export interface MarkStyle {
  color: string;
  author: 'tutor' | 'student';
  surface: 'screen' | 'whiteboard';
  group?: string;
}

const NOTE_SIZE = 27;

/** Directions to try for an arrow's tail, in order of preference (screen-up-ish first). */
const ARROW_DIRS = [
  { x: 1, y: -0.75 },
  { x: -1, y: -0.75 },
  { x: 1, y: 0.75 },
  { x: -1, y: 0.75 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: 1.4, y: 0 },
  { x: -1.4, y: 0 },
];

function norm(v: Point): Point {
  const d = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / d, y: v.y / d };
}

/** Where the segment from `p` toward the centre of `r` first touches `r` (inflated). */
export function edgePoint(r: Rect, p: Point, pad = 6): Point {
  const b = inflateRect(r, pad);
  const c = rectCenter(b);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const tx = dx !== 0 ? b.width / 2 / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? b.height / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function inside(p: Point, b: Rect, m: number): boolean {
  return p.x >= b.x + m && p.y >= b.y + m && p.x <= b.x + b.width - m && p.y <= b.y + b.height - m;
}

function overlapArea(a: Rect, b: Rect): number {
  const i = intersectRect(a, b);
  return i ? i.width * i.height : 0;
}

/** Pick a clear spot for an arrow's tail: inside the display, away from the other marks. */
export function arrowTail(target: Rect, display: Rect, avoid: Rect[] = [], length = 130): Point {
  const c = rectCenter(target);
  const reach = Math.max(target.width, target.height) / 2 + length;
  let best: { p: Point; score: number } | null = null;
  ARROW_DIRS.forEach((dir, i) => {
    const d = norm(dir);
    const p = { x: c.x + d.x * reach * (Math.abs(d.x) > 0.9 ? 1 : 0.85), y: c.y + d.y * reach * 0.8 };
    if (!inside(p, display, 24)) return;
    const box = { x: p.x - 40, y: p.y - 20, width: 80, height: 40 };
    const clash = avoid.reduce((a, r) => a + overlapArea(box, r), 0) + overlapArea(box, inflateRect(target, 8));
    const score = clash + i * 40; // preference order breaks ties
    if (!best || score < best.score) best = { p, score };
  });
  return best ? (best as { p: Point }).p : clampPointInside({ x: c.x + reach, y: c.y - reach * 0.6 }, display);
}

/** Where a handwritten note goes next to a target (right, else left, else above/below). */
export function notePosition(target: Rect, text: string, display: Rect, size = NOTE_SIZE): Point {
  const w = Math.min(approxTextWidth(text, size), size * 16);
  const h = size * 1.1;
  const right = { x: target.x + target.width + 16, y: target.y + target.height / 2 - h / 2 };
  if (right.x + w < display.x + display.width - 12) return right;
  const left = { x: target.x - 16 - w, y: right.y };
  if (left.x > display.x + 12) return left;
  const above = { x: Math.max(display.x + 12, Math.min(target.x, display.x + display.width - w - 12)), y: target.y - h - 14 };
  if (above.y > display.y + 12) return above;
  return { x: above.x, y: target.y + target.height + 14 };
}

/** Turn located mark specs into ink items (geometry + timing fields; revealAt is set later). */
export function buildInk(specs: MarkSpec[], display: Rect, style: MarkStyle): InkItem[] {
  const out: InkItem[] = [];
  const taken: Rect[] = specs.flatMap((s) => (s.rect ? [s.rect] : []));
  for (const s of specs) {
    const id = inkId(style.author === 'tutor' ? 't' : 's');
    const base: InkItem = {
      id,
      author: style.author,
      kind: s.kind,
      color: style.color,
      surface: style.surface,
      revealAt: 0,
      drawMs: 0,
      fadeAt: null,
      seed: seedFrom(id),
      group: style.group,
      label: s.label,
    };
    let item: InkItem | null = null;
    let after: InkItem | null = null;
    switch (s.kind) {
      case 'circle':
      case 'box':
      case 'highlight':
      case 'underline':
      case 'bracket':
      case 'ring':
        if (s.rect) item = { ...base, rect: { ...s.rect } };
        else if (s.at) item = { ...base, rect: { x: s.at.x - 40, y: s.at.y - 18, width: 80, height: 36 } };
        break;
      case 'arrow': {
        const to0 = s.to ?? (s.rect ? rectCenter(s.rect) : s.at);
        if (!to0) break;
        const from = s.from ?? (s.rect ? arrowTail(s.rect, display, taken) : { x: to0.x + 110, y: to0.y - 80 });
        const to = s.rect ? edgePoint(s.rect, from, 7) : to0;
        item = { ...base, from, to, bend: 0.18 * (from.x < to.x ? 1 : -1) };
        if (s.text) {
          // Arrow with a note at its tail, written after the arrow is drawn.
          after = { ...base, id: inkId('t'), kind: 'text', text: s.text, fontSize: NOTE_SIZE, at: tailNoteAt(from, to, s.text, display), seed: seedFrom(`${id}n`) };
        }
        break;
      }
      case 'line':
        if (s.from && s.to) item = { ...base, from: s.from, to: s.to };
        break;
      case 'text': {
        const text = (s.text ?? '').trim();
        if (!text) break;
        const at = s.at ?? (s.rect ? notePosition(s.rect, text, display) : null);
        if (at) item = { ...base, text, fontSize: NOTE_SIZE, at };
        break;
      }
      case 'step': {
        const at = s.at ?? (s.rect ? { x: s.rect.x - 4, y: s.rect.y - 4 } : null);
        if (at) item = { ...base, at: clampPointInside(at, inflateRect(display, -16)), num: s.num ?? 1, fontSize: 26 };
        break;
      }
      case 'check':
      case 'cross': {
        const at = s.at ?? (s.rect ? { x: s.rect.x + s.rect.width + 22, y: s.rect.y + s.rect.height / 2 } : null);
        if (at) item = { ...base, at, fontSize: s.kind === 'check' ? 28 : 22 };
        break;
      }
    }
    if (!item) continue;
    item.drawMs = drawDurationFor(item);
    out.push(item);
    if (after) {
      after.drawMs = drawDurationFor(after);
      out.push(after);
    }
  }
  return out;
}

function tailNoteAt(from: Point, to: Point, text: string, display: Rect): Point {
  const w = approxTextWidth(text, NOTE_SIZE);
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  // Put the note beyond the tail, on the side away from the target.
  const p = {
    x: dx >= 0 ? from.x + 8 : from.x - w - 8,
    y: dy >= 0 ? from.y + 4 : from.y - NOTE_SIZE * 1.1 - 4,
  };
  return clampPointInside(p, { x: display.x + 8, y: display.y + 8, width: display.width - w - 16, height: display.height - NOTE_SIZE * 1.3 - 16 });
}

/** Where the cursor should point at a target: its centre for small things, near the start of wide ones. */
export function pointTip(r: Rect): Point {
  const x = r.width > 90 ? r.x + Math.min(r.width * 0.3, 60) : r.x + r.width / 2;
  return { x, y: r.y + r.height / 2 };
}
