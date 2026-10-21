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

/**
 * Where a line of text really ends (pixel x, exclusive): the right edge of the glyphs that start
 * inside `box`, following them past its right edge if they run on, and stopping at the first gap
 * wider than ~3 characters that starts beyond it. A value chip then sits just after the code,
 * even when a vision model's box for the line is a little short or runs on past it.
 */
export function lineEnd(img: Bitmap, box: PxBox, opts: { threshold?: number; reach?: number; ignore?: PxBox[] } = {}): number | null {
  const W = img.width;
  const H = img.height;
  const y1 = Math.max(0, Math.round(box.y1));
  const y2 = Math.min(H, Math.round(box.y2));
  const x1 = Math.max(0, Math.round(box.x1));
  const x2 = Math.min(W, Math.round(box.x2));
  const th = y2 - y1;
  if (th < 4 || x2 - x1 < 2) return null;
  const reach = Math.min(W, x2 + (opts.reach ?? Math.max(160, th * 10)));
  // The middle of the line only: a neighbouring line's ascenders and descenders stay out.
  const r1 = y1 + Math.floor(th * 0.2);
  const r2 = Math.max(r1 + 1, y2 - Math.floor(th * 0.2));
  const d = img.data;
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  // The background: the commonest colour in the line's band and in the leading just above and
  // below it (dense text alone could outnumber it).
  const rows: number[] = [];
  for (let y = r1; y < r2; y++) rows.push(y);
  for (const y of [y1 - 2, y1 - 1, y2, y2 + 1]) if (y >= 0 && y < H) rows.push(y, y);
  for (const y of rows) {
    for (let x = x1; x < reach; x += 2) {
      const i = (y * W + x) * 4;
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      c.n++;
      c.r += d[i];
      c.g += d[i + 1];
      c.b += d[i + 2];
      counts.set(key, c);
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  let total = 0;
  for (const c of counts.values()) {
    total += c.n;
    if (!best || c.n > best.n) best = c;
  }
  if (!best || best.n < total * 0.4) return null;
  const bg = [best.r / best.n, best.g / best.n, best.b / best.n];
  const threshold = opts.threshold ?? 60;
  // Pairwise's own cursor or cards, where the capture includes them (Linux): not the line.
  const ignore = (opts.ignore ?? []).filter((g) => g.y2 > r1 && g.y1 < r2);
  /** 0: background only, 1: some ink, 2: every row differs (an edge or a fill, not glyphs). */
  const inkAt = (x: number): 0 | 1 | 2 => {
    const skip = ignore.filter((g) => x >= g.x1 && x < g.x2);
    let hits = 0;
    let rowsSeen = 0;
    for (let y = r1; y < r2; y++) {
      if (skip.length && skip.some((g) => y >= g.y1 && y < g.y2)) continue;
      rowsSeen++;
      const i = (y * W + x) * 4;
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > threshold) hits++;
    }
    return hits === 0 ? 0 : hits === rowsSeen ? 2 : 1;
  };
  const gapMax = Math.max(8, Math.round(th * 1.6));
  let end = -1;
  let gap = 0;
  // Where the current run of solid columns started, and where the line had ended before it.
  let solid = 0;
  let endBeforeSolid = -1;
  let x = x1;
  for (; x < reach; x++) {
    const k = inkAt(x);
    if (k === 2) {
      if (!solid) endBeforeSolid = end;
      solid++;
    } else solid = 0;
    if (k) {
      end = x + 1;
      gap = 0;
      continue;
    }
    gap++;
    // Nothing in the box or just after it: the pixels don't show this line.
    if (end < 0 && x >= x2 + gapMax) break;
    // A wide gap after the box: the line is over (inside it, it's alignment, unless very wide).
    if (end >= 0 && gap >= gapMax && (x - gap + 1 >= x2 || gap >= gapMax * 3)) break;
  }
  // Still solid where the scan gave up: the window or pane ends there, and the line before it.
  if (x >= reach && solid >= 4) end = endBeforeSolid;
  return end >= 0 ? end : null;
}
