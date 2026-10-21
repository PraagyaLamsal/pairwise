import type { Rect } from '@shared/geometry';

/**
 * Sticky ink: does what a group of marks points at still sit where it was, did it move (the
 * student scrolled), or is it gone (they switched to another app)?
 *
 * Pure image maths on small grey images of the screen (half a pixel per DIP), so it can be
 * tested without a screen. Each anchor (the content under one mark) is compared with how it
 * looked before, scored against its own texture (see T_MATCH). Pixels under masks are skipped:
 * the student's pointer, areas that never stop changing, and (where screen captures include
 * Pairwise's overlays) the marks themselves. The group's verdict is a vote of its anchors
 * weighted by how much texture each has, so a tooltip over one line or a blinking caret doesn't
 * move or clear a whole trace. D-046 has the reasons behind each rule.
 */

export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A box in image pixels. */
export interface PxBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TrackState = 'steady' | 'moved' | 'changed' | 'unsure';

export interface Verdict {
  state: TrackState;
  /** moved: how far the content moved, in image pixels (+ = down; quarter-pixel steps). */
  dy: number;
  /** moved: …and sideways (+ = right; half-pixel steps; a dragged window, a sideways scroll). */
  dx: number;
  /** Share of the group's texture that's unchanged where it was (0..1). */
  steady: number;
  /** Share that matches at `dy` (moved), 0..1. */
  match: number;
  /** moved: the anchors (indices into the boxes) whose content didn't come along — scrolled out of view. */
  lost: number[];
}

/** An anchor this close to unchanged counts as still there. */
const T_STEADY = 0.16;
/**
 * …and this close as the same content (at a shift, or within a pixel of where it was). Content
 * half a pixel off scores ~0.35 (captures are area-averaged, so that can't be interpolated
 * away), a pixel and a half ~1.1, unrelated content 1.5 and up.
 */
const T_MATCH = 0.5;
/**
 * …and, for a move found by the search of the whole screen (a dragged window), this close: half
 * a pixel off both ways, which an odd number of DIP sideways leaves, scores ~0.55.
 */
const T_MATCH_FAR = 0.75;
/** An anchor scoring this badly where the rest went may not have come along (under a header, say). */
const T_LOST = 0.8;
/** Most of the texture has to agree that it's still there… */
const AGREE = 0.6;
/** …or a good part of it that it moved, with none of it still in place (lines that scrolled out of view can't agree). */
const MOVE_AGREE = 0.4;
/** Gone: almost none of it is where it was, and no shift explains it. */
const GONE = 0.2;
/**
 * Rows that didn't change at all, this many or more in a row across the marks' width, are
 * something that doesn't scroll: a header, a toolbar, the desktop around a window. (The gaps
 * between lines of text are thinner.) Content that moves under them is hidden, not different.
 */
const BAND_MIN = 6;
/** What a hidden part of an anchor costs in the search: about what a poor match does. */
const C_HIDDEN = 1;
/** Of what can be seen, most has to agree; and at least this much of it has to be seen. */
const SEEN_MIN = 0.25;
/** A move only part of the group backs is taken only if no other shift comes this close. */
const RIVAL_MARGIN = 0.1;
/** Points per anchor (bigger ones are subsampled on a grid). */
const MAX_POINTS = 2400;

export function grayFromRGBA(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return { width, height, data };
}

/**
 * Cells of the screen's change grid that kept changing across the recent samples — a video, an
 * animation — as DIP rects within `bounds`. They're treated as unknown: they change all the
 * time without anything having moved or gone (a scroll is a burst, not this).
 */
export function movingAreas(history: Uint8Array[], gridW: number, gridH: number, bounds: Rect): Rect[] {
  if (history.length < 4) return [];
  const out: Rect[] = [];
  const cw = bounds.width / gridW;
  const ch = bounds.height / gridH;
  for (let i = 0; i < gridW * gridH; i++) {
    let hits = 0;
    for (const h of history) hits += h[i];
    if (hits >= history.length - 1) out.push({ x: bounds.x + (i % gridW) * cw - 1, y: bounds.y + Math.floor(i / gridW) * ch - 1, width: cw + 2, height: ch + 2 });
  }
  return out;
}

/** 1 where a pixel is under one of the boxes (skipped), 0 elsewhere. */
export function maskOf(width: number, height: number, boxes: PxBox[]): Uint8Array {
  const m = new Uint8Array(width * height);
  for (const b of boxes) {
    const x1 = Math.max(0, Math.floor(b.x));
    const y1 = Math.max(0, Math.floor(b.y));
    const x2 = Math.min(width, Math.ceil(b.x + b.w));
    const y2 = Math.min(height, Math.ceil(b.y + b.h));
    for (let y = y1; y < y2; y++) m.fill(1, y * width + x1, y * width + Math.max(x1, x2));
  }
  return m;
}

interface Anchor {
  /** Which of the boxes it is. */
  index: number;
  xs: Int32Array;
  ys: Int32Array;
  refs: Uint8Array;
  /** Mean absolute difference between neighbouring pixels: how much texture it has. */
  act: number;
  weight: number;
}

function prepare(ref: Gray, refMask: Uint8Array, box: PxBox, index: number): Anchor | null {
  const W = ref.width;
  const H = ref.height;
  const x1 = Math.max(0, Math.round(box.x));
  const y1 = Math.max(0, Math.round(box.y));
  const x2 = Math.min(W - 1, Math.round(box.x + box.w));
  const y2 = Math.min(H - 1, Math.round(box.y + box.h));
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  const area = (x2 - x1) * (y2 - y1);
  const stride = Math.max(1, Math.ceil(Math.sqrt(area / MAX_POINTS)));
  const xs: number[] = [];
  const ys: number[] = [];
  const refs: number[] = [];
  let act = 0;
  for (let y = y1; y < y2; y += stride) {
    for (let x = x1; x < x2; x += stride) {
      const i = y * W + x;
      if (refMask[i]) continue;
      const v = ref.data[i];
      xs.push(x);
      ys.push(y);
      refs.push(v);
      act += (Math.abs(v - ref.data[i + 1]) + Math.abs(v - ref.data[i + W])) / 2;
    }
  }
  if (xs.length < 12) return null;
  act /= xs.length;
  return { index, xs: Int32Array.from(xs), ys: Int32Array.from(ys), refs: Uint8Array.from(refs), act, weight: xs.length * Math.min(act, 40) };
}

/** How much of the anchor the last `score` could see (the rest was off the image or hidden). */
const lastSeen = { share: 1 };

/**
 * How unlike its old self an anchor is with the current image shifted by `dy` (fractional rows
 * are interpolated): mean absolute difference over its own texture. `still` marks rows of
 * things that don't scroll (see BAND_MIN): a pixel that was on one, or would be under one, says
 * nothing about where the content went and isn't compared (`lastSeen.share` says how much could
 * be). `dx` shifts it sideways too (fractions blend neighbouring columns). When too little of
 * it can be seen: Infinity; when too little of that can be compared: NaN (masked).
 */
function score(a: Anchor, cur: Gray, curMask: Uint8Array, dy: number, step = 1, still: Uint8Array | null = null, dx = 0): number {
  const W = cur.width;
  const H = cur.height;
  const fy = Math.floor(dy);
  const fr = dy - fy;
  const fx = Math.floor(dx);
  const frx = dx - fx;
  const hide = still !== null;
  let sum = 0;
  let n = 0;
  let tried = 0;
  let hidden = 0;
  for (let k = 0; k < a.xs.length; k += step) {
    tried++;
    const x = a.xs[k] + fx;
    const y = a.ys[k] + fy;
    if (x < 0 || x >= W - 1 || y < 0 || y >= H - 1 || (hide && (still![a.ys[k]] || still![y] || (fr && still![y + 1])))) {
      hidden++;
      continue;
    }
    const i = y * W + x;
    if (curMask[i] || (fr && curMask[i + W])) continue;
    let c = fr ? cur.data[i] * (1 - fr) + cur.data[i + W] * fr : cur.data[i];
    if (frx) {
      // Sideways by part of a pixel too: blend with the next column.
      if (curMask[i + 1] || (fr && curMask[i + W + 1])) continue;
      const next = fr ? cur.data[i + 1] * (1 - fr) + cur.data[i + W + 1] * fr : cur.data[i + 1];
      c = c * (1 - frx) + next * frx;
    }
    sum += Math.abs(a.refs[k] - c);
    n++;
  }
  const visible = tried - hidden;
  lastSeen.share = tried ? visible / tried : 0;
  if (visible < tried * SEEN_MIN || visible < 8) return Infinity;
  if (n < visible * 0.5 || n < 8) return NaN;
  return sum / n / Math.max(a.act, 3);
}

/**
 * Rows (1) of things that don't scroll, between `ref` and `cur`: bands of at least BAND_MIN
 * rows where nothing changed across `x1`..`x2` (the marks' width).
 */
function stillBands(ref: Gray, refMask: Uint8Array, cur: Gray, curMask: Uint8Array, x1: number, x2: number): Uint8Array {
  const W = cur.width;
  const H = cur.height;
  const step = Math.max(1, Math.floor((x2 - x1) / 320));
  const per = Math.ceil((x2 - x1) / step);
  const rows = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    let looked = 0;
    let changed = 0;
    for (let x = x1; x < x2; x += step) {
      const i = y * W + x;
      if (refMask[i] || curMask[i]) continue;
      looked++;
      if (Math.abs(ref.data[i] - cur.data[i]) > 10) changed++;
    }
    rows[y] = looked >= per * 0.3 && changed <= Math.max(1, looked * 0.01) ? 1 : 0;
  }
  const out = new Uint8Array(H);
  for (let y = 0; y < H; ) {
    let e = y;
    while (e < H && rows[e]) e++;
    if (e - y >= BAND_MIN) out.fill(1, y, e);
    y = Math.max(e, y + 1);
  }
  return out;
}

/**
 * Did the place an anchor moved to stay as it was (`ref` vs `cur` there, unshifted)? Then the
 * anchor's content went under something that doesn't scroll — a toolbar, a header — and is lost.
 * If that place changed too, the content is (partly) there, just not matching its old look.
 */
function staticAt(a: Anchor, ref: Gray, refMask: Uint8Array, cur: Gray, curMask: Uint8Array, dy: number): boolean {
  const W = cur.width;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < a.xs.length; k++) {
    const y = Math.round(a.ys[k] + dy);
    if (y < 0 || y >= cur.height) continue;
    const i = y * W + a.xs[k];
    if (refMask[i] || curMask[i]) continue;
    sum += Math.abs(ref.data[i] - cur.data[i]);
    n++;
  }
  return n >= a.xs.length * 0.3 && sum / n / Math.max(a.act, 3) < T_STEADY;
}

/**
 * Means of any box of an image from summed-area tables (four look-ups each): `mean(x, y, w, h)`
 * is -1 when the box is mostly masked or not all on the image.
 */
function boxMeans(img: Gray, mask: Uint8Array): { mean: (x: number, y: number, w: number, h: number) => number; sum: Uint32Array } {
  const W = img.width;
  const H = img.height;
  const S = W + 1;
  const sum = new Uint32Array(S * (H + 1));
  const masked = new Uint32Array(S * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0;
    let rm = 0;
    for (let x = 0, i = y * W; x < W; x++, i++) {
      rs += img.data[i];
      rm += mask[i];
      sum[(y + 1) * S + x + 1] = sum[y * S + x + 1] + rs;
      masked[(y + 1) * S + x + 1] = masked[y * S + x + 1] + rm;
    }
  }
  const mean = (x: number, y: number, w: number, h: number) => {
    if (x < 0 || y < 0 || x + w > W || y + h > H) return -1;
    const a = y * S + x;
    const b = a + w;
    const c = a + h * S;
    const d = c + w;
    if (masked[d] - masked[b] - masked[c] + masked[a] > (w * h) / 2) return -1;
    return (sum[d] - sum[b] - sum[c] + sum[a]) / (w * h);
  };
  return { mean, sum };
}

/** Mean of a box of an image, worked out directly (for the few blocks of the marked areas); -1 when mostly masked. */
function directMean(img: Gray, mask: Uint8Array, x: number, y: number, w: number, h: number): number {
  if (x < 0 || y < 0 || x + w > img.width || y + h > img.height) return -1;
  let sum = 0;
  let masked = 0;
  for (let r = y; r < y + h; r++) {
    for (let i = r * img.width + x, e = i + w; i < e; i++) {
      sum += img.data[i];
      masked += mask[i];
    }
  }
  return masked > (w * h) / 2 ? -1 : sum / (w * h);
}

/** The `size`×`size` blocks (on a `size` grid) wholly inside the boxes, as [x, y, mean, …] in pixels. */
function blocksIn(mean: (x: number, y: number, w: number, h: number) => number, size: number, boxes: PxBox[]): number[] {
  const out: number[] = [];
  const taken = new Set<number>();
  for (const b of boxes) {
    for (let y = Math.ceil(b.y / size) * size; y + size <= b.y + b.h; y += size) {
      for (let x = Math.ceil(b.x / size) * size; x + size <= b.x + b.w; x += size) {
        const v = mean(x, y, size, size);
        if (v < 0 || taken.has(y * 100_000 + x)) continue;
        taken.add(y * 100_000 + x);
        out.push(x, y, v);
      }
    }
  }
  return out;
}

/** Mean difference of `cells` (from blocksIn) against the image moved by (sx, sy) px; Infinity if too little lands on it. */
function blockCost(cells: number[], mean: (x: number, y: number, w: number, h: number) => number, size: number, sx: number, sy: number): number {
  let sum = 0;
  let n = 0;
  for (let j = 0; j < cells.length; j += 3) {
    const v = mean(cells[j] + sx, cells[j + 1] + sy, size, size);
    if (v < 0) continue;
    sum += Math.abs(cells[j + 2] - v);
    n++;
  }
  return n < (cells.length / 3) * 0.6 ? Infinity : sum / n;
}

/**
 * Where the content went when it moved sideways too (a dragged window, a sideways scroll): the
 * marked areas' 8×8-pixel block means against the whole screen every 4 px (a block is never
 * more than a quarter off), then 4×4 blocks pixel by pixel around the best few, then single
 * pixels, then half pixels sideways and quarter pixels down for the best. The best place, its
 * cost, what the best other place (3 px or more away) costs by as much more, the cost of not
 * moving at all, and how much of the group matches there.
 */
function locate(ref: Gray, refMask: Uint8Array, cur: Gray, curMask: Uint8Array, boxes: PxBox[], anchors: Anchor[], total: number): { dx: number; dy: number; cost: number; rival: number; here: number; match: number } | null {
  const refMean = (x: number, y: number, w: number, h: number) => directMean(ref, refMask, x, y, w, h);
  const { mean: curMean, sum: table } = boxMeans(cur, curMask);
  const cells = blocksIn(refMean, 8, boxes);
  if (cells.length < 18) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < cells.length; j += 3) {
    minX = Math.min(minX, cells[j]);
    maxX = Math.max(maxX, cells[j] + 8);
    minY = Math.min(minY, cells[j + 1]);
    maxY = Math.max(maxY, cells[j + 1] + 8);
  }
  // The best few offsets, at least 8 px apart. (Every cell stays on the image over this range,
  // so the table is read directly; the screen's mask only counts from the next level on.)
  const S = cur.width + 1;
  const n = cells.length / 3;
  const base = new Int32Array(n);
  const want = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    base[j] = cells[3 * j + 1] * S + cells[3 * j];
    want[j] = cells[3 * j + 2] * 64;
  }
  const best: { sx: number; sy: number; c: number }[] = [];
  for (let sy = -Math.floor(minY / 4) * 4; sy <= cur.height - maxY; sy += 4) {
    for (let sx = -Math.floor(minX / 4) * 4; sx <= cur.width - maxX; sx += 4) {
      const off = sy * S + sx;
      const bound = best.length === 6 ? best[5].c * n * 64 : Infinity;
      let sum = 0;
      for (let j = 0; j < n && sum < bound; j++) {
        const a = base[j] + off;
        sum += Math.abs(want[j] - (table[a + 8 * S + 8] - table[a + 8] - table[a + 8 * S] + table[a]));
      }
      if (sum >= bound) continue;
      const c = sum / n / 64;
      const near = best.findIndex((q) => Math.abs(q.sx - sx) < 8 && Math.abs(q.sy - sy) < 8);
      if (near >= 0) {
        if (c >= best[near].c) continue;
        best.splice(near, 1);
      }
      const at = best.findIndex((q) => q.c > c);
      best.splice(at < 0 ? best.length : at, 0, { sx, sy, c });
      if (best.length > 6) best.pop();
    }
  }
  if (!best.length || !Number.isFinite(best[0].c)) return null;
  // 4×4 blocks, every pixel within a coarse step of each.
  const midCells = blocksIn(refMean, 4, boxes);
  const mid = best
    .map((b) => {
      let at = { sx: b.sx, sy: b.sy, c: Infinity };
      for (let sy = b.sy - 4; sy <= b.sy + 4; sy++) {
        for (let sx = b.sx - 4; sx <= b.sx + 4; sx++) {
          const c = blockCost(midCells, curMean, 4, sx, sy);
          if (c < at.c) at = { sx, sy, c };
        }
      }
      return at;
    })
    .sort((p, q) => p.c - q.c)
    .filter((m, i, all) => all.findIndex((o) => Math.abs(o.sx - m.sx) < 3 && Math.abs(o.sy - m.sy) < 3) === i)
    .slice(0, 3);
  // Single pixels, then half pixels sideways (a window moved by an odd number of DIP) and
  // quarter pixels down.
  const step = Math.max(2, Math.ceil(anchors.reduce((s, a) => s + a.xs.length, 0) / 1500));
  const cost = (dx: number, dy: number, st = 1) => anchors.reduce((s, a) => s + a.weight * capped(score(a, cur, curMask, dy, st, null, dx)), 0) / total;
  const whole = mid
    .map((m) => {
      let at = { dx: m.sx, dy: m.sy, c: Infinity };
      for (let dy = m.sy - 1; dy <= m.sy + 1; dy++) {
        for (let dx = m.sx - 1; dx <= m.sx + 1; dx++) {
          const c = cost(dx, dy, step);
          if (c < at.c) at = { dx, dy, c };
        }
      }
      return at;
    })
    .sort((p, q) => p.c - q.c);
  // How close the best other place comes (in whole pixels, like the best), then the best one
  // to the half and quarter pixel.
  const rival = (whole.find((f) => Math.abs(f.dx - whole[0].dx) >= 3 || Math.abs(f.dy - whole[0].dy) >= 3)?.c ?? Infinity) - whole[0].c;
  let top = { ...whole[0], c: cost(whole[0].dx, whole[0].dy) };
  for (let e = whole[0].dx - 0.5; e <= whole[0].dx + 0.5; e += 0.5) {
    for (let d = whole[0].dy - 1; d <= whole[0].dy + 1.001; d += 0.25) {
      const c = cost(e, d);
      if (c < top.c) top = { dx: e, dy: d, c };
    }
  }
  const match = anchors.reduce((s, a) => s + (score(a, cur, curMask, top.dy, 1, null, top.dx) < T_MATCH_FAR ? a.weight : 0), 0) / total;
  return { dx: top.dx, dy: top.dy, cost: top.c, rival: top.c + rival, here: cost(0, 0), match };
}

/** A score as a cost: anything that can't be compared counts as no match. */
const capped = (v: number) => (Number.isFinite(v) ? Math.min(v, 1.5) : 1.5);

/**
 * Where a group's anchors are now: `steady`, `moved` by `dy` (content scrolled), `changed`
 * (nothing like it is anywhere along the scroll: another app, a closed file) or `unsure` (part
 * of it changed: a tooltip, typing — leave the marks alone). `maxShift` limits the search (px).
 */
export function judge(ref: Gray, refMask: Uint8Array, cur: Gray, curMask: Uint8Array, boxes: PxBox[], maxShift = cur.height): Verdict {
  const anchors = boxes.map((b, i) => prepare(ref, refMask, b, i)).filter((a): a is Anchor => a !== null);
  const total = anchors.reduce((s, a) => s + a.weight, 0);
  const verdict = (state: TrackState, dy = 0, steady = 0, match = 0, lost: number[] = [], dx = 0): Verdict => ({ state, dy, dx, steady, match, lost });
  if (!anchors.length) return verdict('unsure');
  // Blank anchors (a note on empty space) can't say where they went, only whether something
  // else is there now.
  if (total < anchors.reduce((s, a) => s + a.xs.length, 0) * 1.5) {
    let diff = 0;
    let n = 0;
    for (const a of anchors) {
      for (let k = 0; k < a.xs.length; k++) {
        const i = a.ys[k] * cur.width + a.xs[k];
        if (curMask[i]) continue;
        diff += Math.abs(a.refs[k] - cur.data[i]);
        n++;
      }
    }
    const mad = n ? diff / n : 0;
    return mad < 6 ? verdict('steady', 0, 1, 1) : verdict(mad > 14 ? 'changed' : 'unsure');
  }
  // What can be seen where it was (an anchor under the student's pointer, say, can't).
  const at0 = anchors.map((a) => score(a, cur, curMask, 0));
  const seen = anchors.reduce((s, a, k) => s + (Number.isFinite(at0[k]) ? a.weight : 0), 0);
  if (seen < total * 0.3) return verdict('unsure');
  const steady = anchors.reduce((s, a, k) => s + (at0[k] < T_STEADY ? a.weight : 0), 0) / seen;
  if (steady >= AGREE) return verdict('steady', 0, steady, steady);

  // Where does it fit best? Coarse whole-pixel search on a subsample (~1500 points in all, so a
  // long trace costs no more than one line), then quarter pixels around the best few: a real
  // half-pixel scroll scores worse at whole pixels than a look-alike line does (`return a`,
  // five lines on, `return n * …`).
  const coarse = Math.max(3, Math.ceil(anchors.reduce((s, a) => s + a.xs.length, 0) / 1500));
  // What doesn't scroll: content that moved under (or past) it can't be seen, which is not
  // the same as not matching.
  let x1 = Infinity;
  let x2 = -Infinity;
  for (const a of anchors) for (let k = 0; k < a.xs.length; k++) (x1 = Math.min(x1, a.xs[k])), (x2 = Math.max(x2, a.xs[k] + 1));
  const still = stillBands(ref, refMask, cur, curMask, x1, x2);
  const cost = (dy: number, step = 1) => {
    let c = 0;
    for (const a of anchors) {
      const v = score(a, cur, curMask, dy, step, still);
      c += a.weight * (lastSeen.share * capped(v) + (1 - lastSeen.share) * C_HIDDEN);
    }
    return c / total;
  };
  const coarseCost: { dy: number; c: number }[] = [];
  for (let dy = -maxShift; dy <= maxShift; dy++) coarseCost.push({ dy, c: cost(dy, coarse) });
  coarseCost.sort((p, q) => p.c - q.c);
  const candidates: number[] = [];
  for (const { dy } of coarseCost) {
    if (candidates.every((c) => Math.abs(c - dy) >= 3)) candidates.push(dy);
    if (candidates.length === 3) break;
  }
  // Each candidate's best quarter-pixel shift; the best of them, and how close the next one comes.
  const refined = candidates.map((c) => {
    let at = c;
    let best = Infinity;
    for (let d = c - 1; d <= c + 1.001; d += 0.25) {
      const v = cost(d);
      if (v < best) (best = v), (at = d);
    }
    return { at, c: best };
  });
  refined.sort((p, q) => p.c - q.c);
  const fine = refined[0].at;
  const fineCost = refined[0].c;
  const clear = (refined[1]?.c ?? Infinity) - fineCost >= RIVAL_MARGIN;
  // How much of each anchor matches there, and how much of it could be seen at all.
  const atFine: number[] = [];
  let agreeing = 0;
  let seenWeight = 0;
  for (const a of anchors) {
    const v = score(a, cur, curMask, fine, 1, still);
    atFine.push(v);
    seenWeight += a.weight * lastSeen.share;
    if (v < T_MATCH) agreeing += a.weight * lastSeen.share;
  }
  const match = agreeing / total;
  const matchSeen = seenWeight ? agreeing / seenWeight : 0;
  const seenEnough = seenWeight / total >= SEEN_MIN;
  const moved = Math.abs(fine) >= 0.5 && fineCost < cost(0) * 0.6;
  // Most of it agrees; or none of it is still in place and most of what can be seen agrees
  // (the rest went under a header, or off the screen); or a good part agrees and no other
  // shift comes close.
  if (moved && (match >= AGREE || (steady < GONE && ((seenEnough && matchSeen >= AGREE) || (match >= MOVE_AGREE && clear))))) {
    // Lost: off the screen, or under something that doesn't scroll (where it went still looks
    // the same as before). Masked isn't lost, and neither is content that's there but changed.
    const lost = anchors.filter((a, k) => atFine[k] === Infinity || (atFine[k] >= T_LOST && staticAt(a, ref, refMask, cur, curMask, fine)));
    return verdict('moved', fine, steady, match, lost.map((a) => a.index));
  }
  const nearby = !moved && Math.abs(fine) <= 1;
  // Within a pixel of where it was (a sub-pixel scroll): still there.
  if (nearby && (match >= AGREE || (seenEnough && matchSeen >= AGREE))) return verdict('steady', 0, steady, match);
  // None of it is where it was and no scroll explains it: maybe it moved sideways too (a
  // dragged window, a sideways scroll). All of the group has to be there, and nowhere else.
  if (steady < GONE) {
    const far = locate(ref, refMask, cur, curMask, boxes, anchors, total);
    if (far && far.dx !== 0 && far.match >= AGREE && far.rival - far.cost >= RIVAL_MARGIN && far.cost < far.here * 0.6) {
      const lost = anchors.filter((a) => score(a, cur, curMask, far.dy, 1, null, far.dx) === Infinity);
      return verdict('moved', far.dy, steady, far.match, lost.map((a) => a.index), far.dx);
    }
  }
  // No other shift comes close, but it doesn't quite match either (half a pixel off scores
  // poorly where the screen changed; or a pointer or tooltip is over it): leave it be.
  if (nearby && clear) return verdict('unsure', 0, steady, match);
  if (steady < GONE && match < GONE + 0.1) return verdict('changed', 0, steady, match);
  return verdict('unsure', 0, steady, match);
}

/**
 * After a few moves the small errors of each add up: measure where the content is now against
 * how it first looked (within a couple of pixels of where the moves say it is). The correction
 * (px), or null when the first look can't be found well enough (it has changed since).
 */
function resync(origin: Gray, originMask: Uint8Array, cur: Gray, curMask: Uint8Array, boxes: PxBox[], offset: number, offsetX: number): number | null {
  const anchors = boxes.map((b, i) => prepare(origin, originMask, { ...b, x: b.x - offsetX, y: b.y - offset }, i)).filter((a): a is Anchor => a !== null);
  const total = anchors.reduce((s, a) => s + a.weight, 0);
  if (!anchors.length || !total) return null;
  const cost = (d: number) => anchors.reduce((s, a) => s + a.weight * capped(score(a, cur, curMask, offset + d, 1, null, offsetX)), 0) / total;
  let best = 0;
  let bestCost = cost(0);
  for (let d = -2; d <= 2.001; d += 0.25) {
    const c = cost(d);
    if (c < bestCost - 1e-9) {
      bestCost = c;
      best = d;
    }
  }
  const match = anchors.reduce((s, a) => s + (score(a, cur, curMask, offset + best, 1, null, offsetX) < T_MATCH ? a.weight : 0), 0) / total;
  return match >= AGREE ? best : null;
}

/** What the engine remembers about one group between samples. */
interface GroupState {
  ref: Gray;
  refMask: Uint8Array;
  changed: number;
  last: TrackState;
  /** The previous sample, and how many in a row it has held still while partly changed. */
  prev: Gray;
  prevMask: Uint8Array;
  stillFor: number;
  /** How it first looked, how far it has moved since (px; down, and sideways), and whether that was checked against it. */
  origin: Gray;
  originMask: Uint8Array;
  offset: number;
  offsetX: number;
  synced: boolean;
  /** Marks whose line went out of view: how that line first looked, and where it was then (px). */
  looks: Map<string, { look: Anchor; x: number; y: number }>;
  /** All of it went (another app, a far scroll): `ref` is the last good view, looked for in each new one. */
  away: boolean;
}

/** What one sample says about a group. */
export interface StepResult {
  /** `gone`: all of it went (hide the marks); `back`: it's on screen again, `dy` (and `dx`) from where it was. */
  state: 'steady' | 'moved' | 'gone' | 'unsure' | 'back';
  dy: number;
  /** moved, back: sideways too (half-pixel steps). */
  dx?: number;
  /** moved: anchors (indices) whose line went out of view — park those marks. */
  lost?: number[];
  /** Parked marks whose line is back where the group's movement says it should be. */
  back?: string[];
  /** Parked marks with nothing to recognise their line by (this engine never saw it): let them go. */
  forget?: string[];
}

/** Partly changed and then still for this many samples: that's the new normal. */
const SETTLE_AFTER = 2;

/** Changed this many samples in a row (~1 s at 4 a second) before the marks are cleared. */
export const GONE_AFTER = 4;

/** Follows each group of marks from sample to sample (one display's images). */
export class InkTracker {
  private groups = new Map<string, GroupState>();

  has(key: string): boolean {
    return this.groups.has(key);
  }

  /**
   * The screen hasn't changed since the last look: the same verdict, without looking again. A
   * change that stays still counts towards clearing, as if it had been seen again.
   */
  again(key: string): { state: 'steady' | 'gone' | 'unsure'; dy: number } {
    const g = this.groups.get(key);
    if (!g || g.away) return { state: 'unsure', dy: 0 };
    if (g.last === 'unsure') {
      g.stillFor++;
      this.settle(g);
      return { state: 'unsure', dy: 0 };
    }
    if (g.last !== 'changed') return { state: 'steady', dy: 0 };
    return this.changedAgain(key, g);
  }

  /**
   * Part of it changed and has stayed that way (a tooltip that stays up, a line being typed in,
   * marks drawn into the capture): judge from here on against how it looks now, so that a
   * lasting small change can't add up to "gone" later.
   */
  private settle(g: GroupState): void {
    if (g.stillFor < SETTLE_AFTER) return;
    g.ref = g.prev;
    g.refMask = g.prevMask;
    g.last = 'steady';
    g.stillFor = 0;
  }

  private changedAgain(_key: string, g: GroupState): { state: 'gone' | 'unsure'; dy: number } {
    g.changed++;
    if (g.changed < GONE_AFTER) return { state: 'unsure', dy: 0 };
    // Gone: keep the last good view (ref) to recognise it if it comes back.
    g.away = true;
    g.changed = 0;
    return { state: 'gone', dy: 0 };
  }

  /** Forget groups that are no longer on screen. */
  retain(keys: Set<string>): void {
    for (const k of [...this.groups.keys()]) if (!keys.has(k)) this.groups.delete(k);
  }

  clear(): void {
    this.groups.clear();
  }

  /**
   * One sample for one group: `boxes` are its anchors now (the marks `ids`), `mask` the pixels to
   * skip in this image, `parked` the marks hidden because their line went out of view (where
   * they'd be now). The first sample just remembers how it looks. `gone` only after it stays
   * changed.
   */
  step(key: string, cur: Gray, mask: Uint8Array, boxes: PxBox[], ids: string[] = [], parked: { id: string; box: PxBox }[] = [], away = false): StepResult {
    const g = this.groups.get(key);
    // Away, but this engine never saw it (it restarted): nothing to look for.
    if (away && (!g || !g.away)) return { state: 'unsure', dy: 0 };
    if (!g || g.ref.width !== cur.width || g.ref.height !== cur.height) {
      this.groups.set(key, { ref: cur, refMask: mask, changed: 0, last: 'steady', prev: cur, prevMask: mask, stillFor: 0, origin: cur, originMask: mask, offset: 0, offsetX: 0, synced: true, looks: new Map(), away: false });
      return parked.length ? { state: 'steady', dy: 0, forget: parked.map((p) => p.id) } : { state: 'steady', dy: 0 };
    }
    if (g.away) return this.lookForIt(g, cur, mask, boxes);
    const v = judge(g.ref, g.refMask, cur, mask, boxes);
    // A line that went out of view: remember how it looked when the marks were made (by the
    // time it's lost it may be half under a header already), and where that was.
    if (v.state === 'moved') {
      for (const k of v.lost) {
        const first = { ...boxes[k], x: boxes[k].x - g.offsetX, y: boxes[k].y - g.offset };
        const look = ids[k] ? prepare(g.origin, g.originMask, first, k) : null;
        if (look) g.looks.set(ids[k], { look, x: first.x, y: first.y });
      }
    }
    const still = v.state === 'unsure' && judge(g.prev, g.prevMask, cur, mask, boxes).state === 'steady';
    g.prev = cur;
    g.prevMask = mask;
    g.last = v.state;
    g.stillFor = still ? g.stillFor + 1 : 0;
    if (v.state === 'changed') return this.changedAgain(key, g);
    g.changed = 0;
    if (v.state === 'unsure') this.settle(g);
    // Remember the new look once it's settled (all of it steady), or wherever it moved to.
    if (v.state === 'moved' || (v.state === 'steady' && v.steady > 0.95)) {
      g.ref = cur;
      g.refMask = mask;
    }
    if (v.state === 'moved') {
      g.offset += v.dy;
      g.offsetX += v.dx;
      g.synced = false;
      return { state: 'moved', dy: v.dy, ...(v.dx ? { dx: v.dx } : {}), lost: v.lost, ...this.parkedBack(g, cur, mask, parked, v.dy, v.dx) };
    }
    // Settled after moving: line up exactly with where its content really is now.
    if (v.state === 'steady' && !g.synced) {
      g.synced = true;
      const fix = resync(g.origin, g.originMask, cur, mask, boxes, g.offset, g.offsetX);
      if (fix !== null && Math.abs(fix) >= 0.5) {
        g.offset += fix;
        return { state: 'moved', dy: fix, ...this.parkedBack(g, cur, mask, parked, fix) };
      }
    }
    return v.state === 'steady' ? { state: 'steady', dy: 0, ...this.parkedBack(g, cur, mask, parked, 0) } : { state: v.state, dy: v.dy };
  }

  /**
   * While it's away: is its last good view on screen again — where it was (they switched back)
   * or anywhere up or down (they scrolled back to it)? Most of it has to be there, at one shift.
   */
  private lookForIt(g: GroupState, cur: Gray, mask: Uint8Array, boxes: PxBox[]): StepResult {
    const v = judge(g.ref, g.refMask, cur, mask, boxes);
    const there = v.state === 'steady' ? v.steady >= AGREE || v.match >= AGREE : v.state === 'moved' && v.match >= AGREE;
    if (!there) return { state: 'unsure', dy: 0 };
    g.away = false;
    g.last = 'steady';
    g.ref = cur;
    g.refMask = mask;
    g.prev = cur;
    g.prevMask = mask;
    g.stillFor = 0;
    g.offset += v.dy;
    g.offsetX += v.dx;
    g.synced = v.dy === 0;
    return { state: 'back', dy: v.dy, ...(v.dx ? { dx: v.dx } : {}) };
  }

  /**
   * Which parked marks' lines are back in view: each one's line, as it looked when it went,
   * is where the group's movement since puts it (`dy`, `dx` = this sample's move, not yet applied).
   */
  private parkedBack(g: GroupState, cur: Gray, mask: Uint8Array, parked: { id: string; box: PxBox }[], dy: number, dx = 0): { back?: string[]; forget?: string[] } {
    const back: string[] = [];
    const forget: string[] = [];
    for (const p of parked) {
      const seen = g.looks.get(p.id);
      // Nothing to recognise it by (never seen here, or a blank line that would match any blank).
      if (!seen || seen.look.act < 4) {
        forget.push(p.id);
        g.looks.delete(p.id);
        continue;
      }
      if (score(seen.look, cur, mask, p.box.y + dy - seen.y, 1, null, p.box.x + dx - seen.x) < T_MATCH) {
        back.push(p.id);
        g.looks.delete(p.id);
      }
    }
    return { ...(back.length ? { back } : {}), ...(forget.length ? { forget } : {}) };
  }
}
