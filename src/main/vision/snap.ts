/**
 * Control snapping: grow a box around a control's label to the control itself.
 *
 * Grounders are best at finding text (OCR is pixel-exact on words; Gemini's boxes for a
 * "Submit button" often hug the label). A circle around a button must enclose the button, so
 * for targets that name a control we look outward from the label for the control's edges — the
 * first row/column on each side where the colour changes across (nearly) the whole span. If all
 * four edges turn up close by, that's the control; otherwise the box is left alone.
 */

/** Decoded image, 4 bytes per pixel (RGBA or BGRA — only colour differences matter). */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Pixel box, [x1, x2) × [y1, y2). */
export interface PxBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SnapOptions {
  /** How far up/down to look for the edge, px (default ~1.3 × label height). */
  maxY?: number;
  /** How far left/right, px (default ~3 × label height). */
  maxX?: number;
  /** Sum-of-channels difference that counts as "not background" (default 48). */
  threshold?: number;
  /** Fraction of a line that must differ for it to be an edge (default 0.85). */
  coverage?: number;
}

/** Words in a target description that mean "the control, not just its text". */
const CONTROL_WORDS = /\b(button|btn|tab|field|input|text ?box|search ?box|checkbox|check box|toggle|switch|dropdown|drop-down|select|menu item|chip|pill|badge|card|tile|key)\b/i;

export function namesControl(description: string): boolean {
  return CONTROL_WORDS.test(description);
}

export function snapToControl(img: Bitmap, box: PxBox, opts: SnapOptions = {}): PxBox | null {
  const W = img.width;
  const H = img.height;
  const b = { x1: Math.max(0, Math.round(box.x1)), y1: Math.max(0, Math.round(box.y1)), x2: Math.min(W, Math.round(box.x2)), y2: Math.min(H, Math.round(box.y2)) };
  const th = b.y2 - b.y1;
  const tw = b.x2 - b.x1;
  if (th < 3 || tw < 3) return null;
  const maxY = opts.maxY ?? Math.max(10, Math.round(th * 1.3));
  const maxX = opts.maxX ?? Math.max(20, Math.round(th * 3));
  const threshold = opts.threshold ?? 48;
  const coverage = opts.coverage ?? 0.85;
  const d = img.data;

  const bg = backgroundAround(img, b);
  if (!bg) return null;
  const off = (x: number, y: number) => (y * W + x) * 4;
  const differs = (x: number, y: number) => {
    const i = off(x, y);
    return Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > threshold;
  };
  // Inset the span a little so anti-aliased glyph edges at the ends don't count.
  const rowIsEdge = (y: number) => {
    let n = 0;
    let total = 0;
    for (let x = b.x1; x < b.x2; x++) {
      total++;
      if (differs(x, y)) n++;
    }
    return total > 0 && n / total >= coverage;
  };
  const colIsEdge = (x: number) => {
    let n = 0;
    let total = 0;
    for (let y = b.y1; y < b.y2; y++) {
      total++;
      if (differs(x, y)) n++;
    }
    return total > 0 && n / total >= coverage;
  };

  // Start one pixel outside the label (its own box may clip glyph edges).
  let top = -1;
  for (let y = b.y1 - 2; y >= Math.max(0, b.y1 - maxY); y--) if (rowIsEdge(y)) { top = y; break; }
  let bottom = -1;
  for (let y = b.y2 + 1; y < Math.min(H, b.y2 + maxY); y++) if (rowIsEdge(y)) { bottom = y; break; }
  let left = -1;
  for (let x = b.x1 - 2; x >= Math.max(0, b.x1 - maxX); x--) if (colIsEdge(x)) { left = x; break; }
  let right = -1;
  for (let x = b.x2 + 1; x < Math.min(W, b.x2 + maxX); x++) if (colIsEdge(x)) { right = x; break; }
  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;

  // Labels sit roughly centred vertically in their control (descender room makes it uneven).
  const padTop = b.y1 - top;
  const padBottom = bottom - b.y2;
  if (Math.abs(padTop - padBottom) > Math.max(5, th * 0.6)) return null;
  // The edges must be real lines across the control, not another word: check the found top and
  // bottom rows also cover the stretch between the found side edges.
  const span = (y: number) => {
    let n = 0;
    let total = 0;
    for (let x = left + 3; x <= right - 3; x++) {
      total++;
      if (differs(x, y)) n++;
    }
    return total ? n / total : 0;
  };
  if (span(top) < 0.7 || span(bottom) < 0.7) return null;
  return { x1: left, y1: top, x2: right + 1, y2: bottom + 1 };
}

/** The dominant colour in a thin ring just outside the label (the control's fill). */
function backgroundAround(img: Bitmap, b: PxBox): [number, number, number] | null {
  const W = img.width;
  const H = img.height;
  const d = img.data;
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++;
    c.r += d[i];
    c.g += d[i + 1];
    c.b += d[i + 2];
    counts.set(key, c);
  };
  for (const gap of [1, 2]) {
    for (let x = b.x1 - gap; x < b.x2 + gap; x++) {
      add(x, b.y1 - gap - 1);
      add(x, b.y2 + gap);
    }
    for (let y = b.y1; y < b.y2; y++) {
      add(b.x1 - gap - 1, y);
      add(b.x2 + gap, y);
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  let total = 0;
  for (const c of counts.values()) {
    total += c.n;
    if (!best || c.n > best.n) best = c;
  }
  if (!best || best.n < total * 0.4) return null;
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}
