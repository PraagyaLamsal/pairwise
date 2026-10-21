import type { Point, Rect } from '@shared/geometry';
import type { InkItem } from '@shared/ink';
import { CHIP_FONT_SIZE, HAND_FONT, HAND_WEIGHT, MONO_FONT, MONO_WEIGHT, NOTE_FONT, NOTE_WEIGHT, PARK_IN_MS, PARK_OUT_MS, chipBox, inkShapes, parkAlpha, partial, penStateAt, polyLength, ringReach, rng, slideOffset, smoothPath } from '@shared/ink-geometry';

export { rng };

/**
 * Ink renderer shared by the screen overlays and the whiteboard, drawn the way Tuple paints:
 * one flat colour, a constant-width brush with round ends and joins (a single click is a dot),
 * midpoint-smoothed curves, no glow and no pressure. Marks are revealed as the pen moves
 * (src/shared/ink-geometry.ts decides when each stroke is drawn, so the cursor stays on the
 * pen); notes are typed in the system font with a caret, or handwritten if the student prefers.
 * Values beside code are chips: monospaced white text typed onto a pill in the tutor's colour.
 */

export const FADE_MS = 650;
/** Brush diameter in DIP (Tuple's paint is ~6 pt). */
export const BRUSH_WIDTH = 5.5;
/** Barely-there shadow so ink separates from busy backgrounds without looking like a glow. */
const SHADOW = 'rgba(0, 0, 0, 0.2)';

const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(v.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** The brush path for one stroke (or part of one): a dot when it has no length yet. */
function brushPath(pts: Point[], width: number): { path: Path2D; dot: boolean } {
  const path = new Path2D();
  if (pts.length < 2 || polyLength(pts) < 0.5) {
    const p = pts[0];
    path.arc(p.x, p.y, width / 2, 0, Math.PI * 2);
    return { path, dot: true };
  }
  smoothPath(pts, path);
  return { path, dot: false };
}

/** Shorten a polyline by `d` px at both ends (highlights: round caps land at the ends). */
function inset(pts: Point[], d: number): Point[] {
  const len = polyLength(pts);
  if (len <= d * 2 + 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return [m, { x: m.x + 0.5, y: m.y }];
  }
  const head = partial(pts, 1 - d / len);
  const rev = [...head].reverse();
  return partial(rev, 1 - d / polyLength(head)).reverse();
}

/** Renders ink items; caches finished geometry so steady-state frames are just a few strokes. */
export class InkRenderer {
  private cache = new Map<string, { path: Path2D; dot: boolean }[]>();
  private geom = new Map<string, Point[][]>();
  /** Font stack for typed text (celebrations use it too). */
  fontFamily = NOTE_FONT;
  /** macOS "Reduce motion": rings and badges appear and fade instead of pulsing and popping. */
  reducedMotion = false;

  forget(id: string): void {
    this.cache.delete(id);
    this.geom.delete(id);
  }

  clearCache(): void {
    this.cache.clear();
    this.geom.clear();
  }

  /** Whether any item is animating (drawing in, popping, pulsing or fading) at `now`. */
  animating(items: InkItem[], now: number): boolean {
    return this.nextChange(items, now) <= now;
  }

  /**
   * When the scene next changes: `now` if something is moving at this moment, else the time the
   * next thing starts (a scheduled mark, a fade, a staying ring's next pulse), else Infinity.
   * Lets an idle overlay stop drawing frames altogether.
   */
  nextChange(items: InkItem[], now: number): number {
    let next = Infinity;
    for (const i of items) {
      if (now < i.revealAt) {
        next = Math.min(next, i.revealAt);
        continue;
      }
      if (now < i.revealAt + i.drawMs + 450) return now;
      if (i.slide && !this.reducedMotion && now < i.slide.at + i.slide.ms) return now;
      if (i.park && now < i.park.at + (i.park.on ? PARK_OUT_MS : PARK_IN_MS)) return now;
      if (i.fadeAt != null) {
        if (now < i.fadeAt) next = Math.min(next, i.fadeAt);
        else if (now < i.fadeAt + (i.fadeMs ?? FADE_MS)) return now;
        else continue;
      }
      if (i.kind === 'ring') {
        const t = now - i.revealAt;
        if (this.reducedMotion) {
          if (t < RING_STILL_MS) return now;
          continue;
        }
        if (i.fadeAt == null) {
          const cycle = RING_REPEAT_S * 1000;
          if (t % cycle < RING_PULSES_MS) return now;
          next = Math.min(next, now - (t % cycle) + cycle);
        } else if (t < RING_PULSES_MS) return now;
      }
    }
    return next;
  }

  private shapes(item: InkItem): Point[][] {
    let hit = this.geom.get(item.id);
    if (!hit) {
      hit = inkShapes(item);
      this.geom.set(item.id, hit);
    }
    return hit;
  }

  render(ctx: CanvasRenderingContext2D, items: InkItem[], now: number, dpr: number): void {
    for (const item of items) {
      if (now < item.revealAt) continue;
      const fade = (item.fadeAt != null ? Math.max(0, 1 - (now - item.fadeAt) / (item.fadeMs ?? FADE_MS)) : 1) * parkAlpha(item, now);
      if (fade <= 0) continue;
      const ms = now - item.revealAt;
      ctx.save();
      ctx.globalAlpha = fade;
      // What it marks just scrolled: glide after it (a jump with Reduce motion).
      const off = this.reducedMotion ? null : slideOffset(item, now);
      if (off && (off.x || off.y)) ctx.translate(off.x, off.y);
      switch (item.kind) {
        case 'text':
          if (item.chip) this.drawChip(ctx, item, ms, dpr);
          else this.drawText(ctx, item, ms, dpr);
          break;
        case 'step':
          this.drawStep(ctx, item, ms, dpr);
          break;
        case 'ring':
          this.drawRing(ctx, item, now, dpr);
          break;
        default:
          this.drawStrokes(ctx, item, ms, dpr);
      }
      ctx.restore();
    }
  }

  private drawStrokes(ctx: CanvasRenderingContext2D, item: InkItem, ms: number, dpr: number): void {
    const shapes = this.shapes(item);
    if (!shapes.length) return;
    const highlight = item.kind === 'highlight';
    const width = highlight ? Math.max(8, (item.rect?.height ?? 20) + 4) : (item.width ?? BRUSH_WIDTH);
    const complete = ms >= item.drawMs;
    let paths = complete ? this.cache.get(item.id) : undefined;
    if (!paths) {
      const reveal = complete ? shapes.map(() => 1) : penStateAt(item, ms).reveal;
      paths = [];
      shapes.forEach((sh, i) => {
        const r = reveal[i] ?? 0;
        if (r <= 0) return;
        let pts = r >= 1 ? sh : partial(sh, r);
        if (highlight) pts = inset(pts, Math.max(0, width / 2 - 3));
        paths!.push(brushPath(pts, width));
      });
      if (complete) this.cache.set(item.id, paths);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    if (highlight) {
      ctx.globalAlpha *= 0.3;
      for (const p of paths) (p.dot ? ctx.fill(p.path) : ctx.stroke(p.path));
      return;
    }
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 1.5 * dpr;
    ctx.shadowOffsetY = 0.5 * dpr;
    for (const p of paths) (p.dot ? ctx.fill(p.path) : ctx.stroke(p.path));
  }

  private drawText(ctx: CanvasRenderingContext2D, item: InkItem, ms: number, dpr: number): void {
    if (!item.at || !item.text) return;
    const hand = item.font === 'hand';
    const size = item.fontSize ?? (hand ? 27 : 19);
    ctx.font = hand ? `${HAND_WEIGHT} ${size}px ${HAND_FONT}` : `${NOTE_WEIGHT} ${size}px ${this.fontFamily}`;
    ctx.textBaseline = 'top';
    const lines = wrapText(ctx, item.text, Math.max(220, size * 16));
    const lineH = size * (hand ? 1.05 : 1.22);
    const widths = lines.map((l) => ctx.measureText(l).width);
    const st = penStateAt(item, ms);
    let left = st.chars;
    const typing = !hand && ms < item.drawMs + 420;
    const origin = (i: number) => ({
      x: item.align === 'center' ? item.at!.x - widths[i] / 2 : item.at!.x,
      y: item.align === 'center' ? item.at!.y - (lineH * lines.length) / 2 + i * lineH : item.at!.y + i * lineH,
    });
    ctx.fillStyle = item.color;
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 1.5 * dpr;
    ctx.shadowOffsetY = 0.5 * dpr;
    let caret: Point | null = null;
    let boxW = 0;
    let shownLines = 0;
    lines.forEach((line, i) => {
      // Wrapping dropped the space between lines: count it so the pacing matches the text.
      const n = [...line].length + (i < lines.length - 1 ? 1 : 0);
      const k = Math.max(0, Math.min([...line].length, left));
      left -= n;
      if (k <= 0 && !(i === 0 && typing)) return;
      const { x, y } = origin(i);
      const shown = [...line].slice(0, k).join('');
      const w = k >= [...line].length ? widths[i] : ctx.measureText(shown).width;
      ctx.fillText(shown, x, y);
      boxW = Math.max(boxW, w);
      shownLines = i + 1;
      caret = { x: x + w + 1.5, y };
    });
    if (!typing || !caret) return;
    // While typing, like Tuple's text tool: a caret and a dotted outline around the note.
    const a = ms < item.drawMs ? 1 : Math.max(0, 1 - (ms - item.drawMs) / 420);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.globalAlpha *= a;
    const blink = ms < item.drawMs || Math.floor(ms / 260) % 2 === 0;
    if (blink) {
      ctx.fillRect((caret as Point).x, (caret as Point).y - size * 0.06, 2, size * 1.12);
    }
    const o = origin(0);
    ctx.strokeStyle = hexToRgba(item.color, 0.55);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    roundRect(ctx, o.x - 6, o.y - 5, Math.max(size, boxW) + 14, lineH * Math.max(1, shownLines) + 8, 6);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * A value chip: the pill grows under the caret as the value is typed onto it, like a
   * debugger's inline value appearing at the end of a line.
   */
  private drawChip(ctx: CanvasRenderingContext2D, item: InkItem, ms: number, dpr: number): void {
    if (!item.at || !item.text) return;
    const size = item.fontSize ?? CHIP_FONT_SIZE;
    const st = penStateAt(item, ms);
    const chars = [...item.text];
    const k = Math.max(0, Math.min(chars.length, st.chars));
    const b = chipBox(item, k)!;
    // The pill pops in as the first key is pressed, then keeps up with the text.
    const pop = Math.min(1, ms / 140);
    ctx.globalAlpha *= 0.35 + 0.65 * pop;
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 2 * dpr;
    ctx.shadowOffsetY = 0.5 * dpr;
    ctx.fillStyle = item.color;
    roundRect(ctx, b.x, b.y, b.width, b.height, Math.min(6, b.height / 2));
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.font = `${MONO_WEIGHT} ${size}px ${MONO_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const padX = size * 0.52;
    const shown = chars.slice(0, k).join('');
    const y = b.y + b.height / 2 + 0.5;
    ctx.fillText(shown, b.x + padX, y);
    if (ms < item.drawMs + 420) {
      const blink = ms < item.drawMs || Math.floor(ms / 260) % 2 === 0;
      const a = ms < item.drawMs ? 1 : Math.max(0, 1 - (ms - item.drawMs) / 420);
      if (blink && a > 0) {
        ctx.globalAlpha *= a;
        ctx.fillRect(b.x + padX + ctx.measureText(shown).width + 1, y - size * 0.56, 1.5, size * 1.12);
      }
    }
  }

  private drawStep(ctx: CanvasRenderingContext2D, item: InkItem, ms: number, dpr: number): void {
    if (!item.at) return;
    const r = (item.fontSize ?? 26) / 2 + 1;
    const raw = Math.min(1, ms / Math.max(1, item.drawMs));
    const pop = this.reducedMotion || raw >= 1 ? 1 : Math.max(0, easeOutBack(Math.min(1, raw * 1.6)));
    if (this.reducedMotion) ctx.globalAlpha *= Math.min(1, ms / 160);
    const { x, y } = item.at;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pop, pop);
    const t = (ms - item.drawMs * 0.4) / 900;
    if (t > 0 && t < 1 && !this.reducedMotion) {
      ctx.beginPath();
      ctx.arc(0, 0, r + 3 + easeOut(t) * 14, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(item.color, 0.5 * (1 - t));
      ctx.lineWidth = 3 - 1.5 * t;
      ctx.stroke();
    }
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 2 * dpr;
    ctx.shadowOffsetY = 0.5 * dpr;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = item.color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(r * 1.05)}px ${NOTE_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(item.num ?? item.text ?? ''), 0, 0.5);
    ctx.restore();
  }

  /**
   * Tuple's highlight click: a small filled dot that turns into a thin ring, expands and fades
   * (the line thins from 6 to 3 px as it grows). Two pulses; a ring that stays (a guided step
   * waiting for a click) pulses again every few seconds.
   */
  private drawRing(ctx: CanvasRenderingContext2D, item: InkItem, now: number, _dpr: number): void {
    const c = item.at ?? (item.rect ? { x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 } : null);
    if (!c) return;
    const reach = ringReach(item);
    if (this.reducedMotion) {
      // One still ring at its full size that fades in (and out, unless it's waiting for a click).
      const ms = now - item.revealAt;
      const a = item.fadeAt == null ? Math.min(1, ms / 160) : ms < 160 ? ms / 160 : Math.max(0, 1 - (ms - RING_STILL_MS + 400) / 400);
      if (a <= 0) return;
      ctx.beginPath();
      ctx.arc(c.x, c.y, reach * 0.8, 0, Math.PI * 2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = hexToRgba(item.color, 0.85 * a);
      ctx.stroke();
      return;
    }
    let t = (now - item.revealAt) / 1000;
    if (item.fadeAt == null) t %= RING_REPEAT_S;
    for (let k = 0; k < 2; k++) {
      const local = t - k * RING_GAP_S;
      if (local < 0 || local > RING_PULSE_S) continue;
      const p = local / RING_PULSE_S;
      if (p < 0.16) {
        // the click: a dot that swells a touch
        const q = p / 0.16;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 5 + 3 * easeOut(q), 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(item.color, 0.92);
        ctx.fill();
        continue;
      }
      const q = (p - 0.16) / 0.84;
      const rad = 8 + (reach - 8) * easeOut(q);
      ctx.beginPath();
      ctx.arc(c.x, c.y, rad, 0, Math.PI * 2);
      ctx.lineWidth = 6 - 3 * q;
      ctx.strokeStyle = hexToRgba(item.color, 0.9 * Math.pow(1 - q, 1.4));
      ctx.stroke();
    }
  }
}

/** One pulse lasts this long; the second starts after the gap; a staying ring repeats. */
const RING_PULSE_S = 0.9;
const RING_GAP_S = 0.42;
const RING_REPEAT_S = 3.4;
const RING_PULSES_MS = (RING_GAP_S + RING_PULSE_S) * 1000 + 60;
/** Reduce motion: how long a still ring shows before it fades. */
const RING_STILL_MS = 1400;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

/** Bounds of an item (notes thumbnails, hit tests). */
export function inkBounds(item: InkItem): Rect | null {
  if (item.rect) return { ...item.rect };
  if (item.kind === 'text' && item.chip) return chipBox(item);
  if (item.points?.length) {
    const xs = item.points.map((p) => p.x);
    const ys = item.points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (item.from && item.to) {
    return { x: Math.min(item.from.x, item.to.x), y: Math.min(item.from.y, item.to.y), width: Math.abs(item.to.x - item.from.x), height: Math.abs(item.to.y - item.from.y) };
  }
  if (item.at) return { x: item.at.x, y: item.at.y, width: 40, height: 30 };
  return null;
}
