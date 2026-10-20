import { getStroke } from 'perfect-freehand';
import type { Point, Rect } from '@shared/geometry';
import type { InkItem } from '@shared/ink';
import { easeInOut, inkShapes, partial, polyLength, rng } from '@shared/ink-geometry';

export { rng };

/**
 * Hand-drawn ink renderer shared by the screen overlays and the whiteboard.
 * Every shape is generated from a seed (src/shared/ink-geometry.ts) so all displays draw the
 * exact same wobble, then rendered progressively ("drawn" over item.drawMs) with a marker-like
 * variable-width stroke and a soft glow.
 */

export const FADE_MS = 650;

const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

interface InkStyle {
  width: number;
  glow: number;
  alpha: number;
  thinning: number;
}

function styleFor(item: InkItem): InkStyle {
  const base = item.width ?? (item.author === 'student' ? 4.2 : 4.6);
  switch (item.kind) {
    case 'highlight':
      return { width: (item.rect?.height ?? 20) + 6, glow: 0, alpha: 0.26, thinning: 0 };
    case 'stroke':
      return { width: base, glow: 9, alpha: 1, thinning: 0.55 };
    default:
      return { width: base, glow: 10, alpha: 1, thinning: 0.5 };
  }
}

function outlinePath(points: Point[], width: number, thinning: number, complete: boolean, pressures?: number[]): Path2D {
  const input = pressures && pressures.length === points.length ? points.map((p, i) => [p.x, p.y, pressures[i]]) : points.map((p) => [p.x, p.y]);
  const outline = getStroke(input, {
    size: width,
    thinning,
    smoothing: 0.55,
    streamline: 0.35,
    simulatePressure: !pressures,
    last: complete,
    start: { taper: thinning > 0 ? Math.min(28, width * 4) : 0, cap: true },
    end: { taper: thinning > 0 && complete ? Math.min(22, width * 3) : 0, cap: true },
  });
  const path = new Path2D();
  if (!outline.length) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

export function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(v.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Renders ink items; caches finished geometry so steady-state frames are just a few fills. */
export class InkRenderer {
  private cache = new Map<string, Path2D[]>();
  private geom = new Map<string, Point[][]>();
  fontFamily = "'Caveat', 'Bradley Hand', cursive";

  forget(id: string): void {
    this.cache.delete(id);
    this.geom.delete(id);
  }

  clearCache(): void {
    this.cache.clear();
    this.geom.clear();
  }

  /** Whether any item is still animating (drawing in, popping or fading) at `now`. */
  animating(items: InkItem[], now: number): boolean {
    return items.some((i) => now < i.revealAt + i.drawMs + 350 || (i.fadeAt != null && now < i.fadeAt + FADE_MS) || i.kind === 'ring');
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
      const fade = item.fadeAt != null ? Math.max(0, 1 - (now - item.fadeAt) / FADE_MS) : 1;
      if (fade <= 0) continue;
      const raw = Math.min(1, (now - item.revealAt) / Math.max(1, item.drawMs));
      const progress = easeInOut(raw);
      ctx.save();
      ctx.globalAlpha = fade;
      switch (item.kind) {
        case 'text':
          this.drawText(ctx, item, progress, dpr);
          break;
        case 'step':
          this.drawStep(ctx, item, raw, now, dpr);
          break;
        case 'ring':
          this.drawRing(ctx, item, now, dpr);
          break;
        default:
          this.drawStrokes(ctx, item, progress, dpr);
      }
      ctx.restore();
    }
  }

  private drawStrokes(ctx: CanvasRenderingContext2D, item: InkItem, progress: number, dpr: number): void {
    const style = styleFor(item);
    const shapes = this.shapes(item);
    if (!shapes.length) return;
    let paths: Path2D[];
    const complete = progress >= 1;
    const cached = this.cache.get(item.id);
    if (complete && cached) paths = cached;
    else {
      // Distribute progress across sub-shapes in order (e.g. arrow shaft, then head).
      const lengths = shapes.map((sh) => polyLength(sh));
      const total = lengths.reduce((a, b) => a + b, 0) || 1;
      let remaining = progress * total;
      paths = [];
      shapes.forEach((sh, i) => {
        if (remaining <= 0) return;
        const p = Math.min(1, remaining / (lengths[i] || 1));
        remaining -= lengths[i];
        const pts = partial(sh, p);
        if (pts.length < 2 && item.kind !== 'stroke') return;
        paths.push(outlinePath(pts, style.width, style.thinning, p >= 1, item.kind === 'stroke' ? item.pressures : undefined));
      });
      if (complete) this.cache.set(item.id, paths);
    }
    const color = item.color;
    if (item.kind === 'highlight') {
      ctx.fillStyle = hexToRgba(color, style.alpha);
      for (const p of paths) ctx.fill(p);
      return;
    }
    if (style.glow > 0) {
      ctx.shadowColor = hexToRgba(color, 0.75);
      ctx.shadowBlur = style.glow * dpr;
      ctx.fillStyle = hexToRgba(color, 0.9);
      for (const p of paths) ctx.fill(p);
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = color;
    for (const p of paths) ctx.fill(p);
    // a slightly brighter core makes it read as marker ink
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (const p of paths) ctx.fill(p);
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawText(ctx: CanvasRenderingContext2D, item: InkItem, progress: number, dpr: number): void {
    if (!item.at || !item.text) return;
    const size = item.fontSize ?? 27;
    ctx.font = `700 ${size}px ${this.fontFamily}`;
    ctx.textBaseline = 'top';
    const lines = wrapText(ctx, item.text, Math.max(220, size * 16));
    const lineH = size * 1.05;
    const widths = lines.map((l) => ctx.measureText(l).width);
    const totalChars = lines.reduce((a, l) => a + l.length, 0) || 1;
    let charsToShow = progress * totalChars;
    lines.forEach((line, i) => {
      if (charsToShow <= 0) return;
      const frac = Math.min(1, charsToShow / Math.max(1, line.length));
      charsToShow -= line.length;
      const x = item.align === 'center' ? item.at!.x - widths[i] / 2 : item.at!.x;
      const y = item.align === 'center' ? item.at!.y - lineH / 2 + i * lineH : item.at!.y + i * lineH;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 6, y - 8, widths[i] * frac + 10, lineH + 16);
      ctx.clip();
      // legibility halo, then glow, then ink
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(4, size * 0.2);
      ctx.strokeStyle = 'rgba(8, 10, 16, 0.55)';
      ctx.strokeText(line, x, y);
      ctx.shadowColor = hexToRgba(item.color, 0.8);
      ctx.shadowBlur = 10 * dpr;
      ctx.fillStyle = item.color;
      ctx.fillText(line, x, y);
      ctx.shadowBlur = 0;
      ctx.fillText(line, x, y);
      ctx.restore();
    });
  }

  private drawStep(ctx: CanvasRenderingContext2D, item: InkItem, raw: number, now: number, dpr: number): void {
    if (!item.at) return;
    const r = (item.fontSize ?? 26) / 2 + 1;
    const pop = raw >= 1 ? 1 : Math.max(0, easeOutBack(Math.min(1, raw * 1.6)));
    const { x, y } = item.at;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pop, pop);
    const t = (now - item.revealAt - item.drawMs * 0.4) / 900;
    if (t > 0 && t < 1) {
      ctx.beginPath();
      ctx.arc(0, 0, r + 4 + t * 16, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(item.color, 0.55 * (1 - t));
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    const g = ctx.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, lighten(item.color, 0.35));
    g.addColorStop(1, item.color);
    ctx.shadowColor = hexToRgba(item.color, 0.8);
    ctx.shadowBlur = 12 * dpr;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `750 ${Math.round(r * 1.05)}px -apple-system, BlinkMacSystemFont, 'Inter Variable', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(item.num ?? item.text ?? ''), 0, 0.5);
    ctx.restore();
  }

  /** Target ring: contracts onto the target twice, then rests as a soft breathing halo. */
  private drawRing(ctx: CanvasRenderingContext2D, item: InkItem, now: number, dpr: number): void {
    const c = item.at ?? (item.rect ? { x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 } : null);
    if (!c) return;
    const base = item.rect ? Math.min(90, Math.max(item.rect.width, item.rect.height) / 2 + 8) : 18;
    const t = (now - item.revealAt) / 1000;
    ctx.lineWidth = 2.6;
    for (let k = 0; k < 2; k++) {
      const local = t - k * 0.35;
      if (local < 0 || local > 0.9) continue;
      const p = local / 0.9;
      const rad = base + 34 * (1 - easeInOut(p));
      ctx.beginPath();
      ctx.arc(c.x, c.y, rad, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(item.color, 0.85 * (1 - p * 0.7));
      ctx.shadowColor = hexToRgba(item.color, 0.7);
      ctx.shadowBlur = 8 * dpr;
      ctx.stroke();
    }
    if (t > 0.6) {
      const breathe = 0.5 + 0.5 * Math.sin((t - 0.6) * 3.2);
      ctx.beginPath();
      ctx.arc(c.x, c.y, base + 2 + breathe * 3, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(item.color, 0.45);
      ctx.shadowBlur = 10 * dpr;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }
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

function lighten(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const l = (v: number) => Math.round(v + (255 - v) * amt);
  return `rgb(${l(r)}, ${l(g)}, ${l(b)})`;
}

/** Bounds of an item (notes thumbnails, hit tests). */
export function inkBounds(item: InkItem): Rect | null {
  if (item.rect) return { ...item.rect };
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
