import type { Point, Rect } from '@shared/geometry';
import type { CursorStep } from './cursor';
import { pointTip } from './marks';

/**
 * Pointer-only gestures: the tutor using her cursor the way a person uses theirs on a call —
 * resting on something while talking about it, gliding under a line while reading it, running
 * down a list line by line — with nothing drawn and no label.
 */
export type GestureStyle = 'hover' | 'follow_line' | 'sweep' | 'run_line';

export interface Gesture {
  style: GestureStyle;
  /** What it is about (global DIP): a control, a line of text, a block of lines. */
  rect?: Rect;
  /** Free path (global DIP) when there is no single target. */
  path?: Point[];
  /** sweep: how many lines the block has (estimated from its height when absent). */
  lines?: number;
}

/** Following a line: px/s for ~26 px tall text (bigger text → proportionally faster). */
export const READ_PX_PER_S = 190;
/** run_line (a trace stepping onto the line being run): a brisk skim, ~3× reading pace. */
export const RUN_PX_PER_S = 560;
/** sweep: time per line (resting on it, then moving down to the next). */
export const SWEEP_MS_PER_LINE = 640;
const HOVER_HOLD_MS = 1400;

/** Under the line, start to end: the tip just below the text so it never covers the letters. */
export function followPath(r: Rect): Point[] {
  const y = r.y + r.height + 3;
  const x1 = r.x + Math.min(4, r.width * 0.05);
  const x2 = r.x + r.width - Math.min(4, r.width * 0.05);
  const n = Math.max(2, Math.round((x2 - x1) / 40));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / n, y }));
}

/** How long following a line takes at a reading pace. */
export function followMs(r: Rect): number {
  const scale = Math.min(1.6, Math.max(0.7, r.height / 26));
  return Math.round(Math.min(4500, Math.max(800, (r.width / (READ_PX_PER_S * scale)) * 1000)));
}

/** One stop per line, just left of where the lines start (the arrow's body stays off the text). */
export function sweepStops(r: Rect, lines?: number): Point[] {
  // Without a count, assume ~28 px lines (code and body text at normal sizes).
  const n = Math.max(2, Math.min(14, lines && lines > 0 ? Math.round(lines) : Math.round(r.height / 28)));
  const lineH = r.height / n;
  return Array.from({ length: n }, (_, i) => ({ x: r.x - 16, y: r.y + lineH * (i + 0.5) - 2 }));
}

/**
 * Where to rest when hovering: on the thing, but low and a little right of its middle, so the
 * arrow's body sits below the label instead of over it (wide things: near their start).
 */
export function hoverTip(r: Rect): Point {
  const tip = pointTip(r);
  return { x: tip.x + Math.min(r.width * 0.18, 12), y: r.y + r.height * 0.74 };
}

/** The cursor moves for a gesture: travel to where it starts, then the gesture itself. */
export function gestureSteps(g: Gesture): CursorStep[] {
  if (g.path && g.path.length >= 2 && !g.rect) {
    const len = g.path.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - g.path![i].x, p.y - g.path![i].y), 0);
    return [
      { kind: 'fly', to: g.path[0], maxMs: 700 },
      { kind: 'glide', path: g.path, ms: Math.min(4000, Math.max(600, len * 2.6)), style: 'glide' },
    ];
  }
  if (!g.rect) return [];
  switch (g.style) {
    case 'follow_line': {
      const path = followPath(g.rect);
      return [
        { kind: 'fly', to: path[0], maxMs: 750 },
        { kind: 'hold', ms: 160 },
        { kind: 'glide', path, ms: followMs(g.rect), style: 'read' },
      ];
    }
    case 'run_line': {
      // A trace moving onto the next line to run: a quick skim along it, ending where its value goes.
      const path = followPath(g.rect);
      return [
        { kind: 'fly', to: path[0], maxMs: 450 },
        { kind: 'glide', path, ms: Math.round(Math.min(750, Math.max(280, (g.rect.width / RUN_PX_PER_S) * 1000))), style: 'read' },
      ];
    }
    case 'sweep': {
      const stops = sweepStops(g.rect, g.lines);
      return [
        { kind: 'fly', to: stops[0], maxMs: 750 },
        { kind: 'glide', path: stops, ms: (stops.length - 1) * SWEEP_MS_PER_LINE, style: 'sweep' },
        { kind: 'hold', ms: Math.round(SWEEP_MS_PER_LINE * 0.6) },
      ];
    }
    default:
      return [
        { kind: 'fly', to: hoverTip(g.rect) },
        { kind: 'hold', ms: HOVER_HOLD_MS },
      ];
  }
}
