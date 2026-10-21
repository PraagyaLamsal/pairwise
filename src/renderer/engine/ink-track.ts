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
/** An anchor scoring this badly where the rest went may not have come along (under a header, say). */
const T_LOST = 0.8;
/** Most of the texture has to agree that it's still there… */
const AGREE = 0.6;
/** …or a good part of it that it moved, with none of it still in place (lines that scrolled out of view can't agree). */
const MOVE_AGREE = 0.4;
/** Gone: almost none of it is where it was, and no shift explains it. */
const GONE = 0.2;
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

/**
 * How unlike its old self an anchor is with the current image shifted by `dy` (fractional rows
 * are interpolated): mean absolute difference over its own texture. When too little of it can
 * be compared: Infinity if it's off the image, NaN (unknown) if it's masked.
 */
function score(a: Anchor, cur: Gray, curMask: Uint8Array, dy: number, step = 1): number {
  const W = cur.width;
  const H = cur.height;
  const fy = Math.floor(dy);
  const fr = dy - fy;
  let sum = 0;
  let n = 0;
  let tried = 0;
  let outside = 0;
  for (let k = 0; k < a.xs.length; k += step) {
    tried++;
    const y = a.ys[k] + fy;
    if (y < 0 || y >= H - 1) {
      outside++;
      continue;
    }
    const i = y * W + a.xs[k];
    if (curMask[i] || (fr && curMask[i + W])) continue;
    const c = fr ? cur.data[i] * (1 - fr) + cur.data[i + W] * fr : cur.data[i];
    sum += Math.abs(a.refs[k] - c);
    n++;
  }
  if (n < tried * 0.5 || n < 8) return outside > tried - n - outside ? Infinity : NaN;
  return sum / n / Math.max(a.act, 3);
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
 * Like `score`, but a pixel that is unchanged where it was also counts as explained: a header,
 * toolbar or gutter that doesn't scroll looks the same before and after, and would otherwise
 * vote "nothing moved" for the part of a line under it. Only for shifts of a couple of pixels
 * and more: for tiny ones, edges that moved would match their own glyphs one pixel along.
 */
function staticTolerantScore(a: Anchor, cur: Gray, curMask: Uint8Array, dy: number, step = 1): number {
  const W = cur.width;
  const H = cur.height;
  const fy = Math.floor(dy);
  const fr = dy - fy;
  let sum = 0;
  let n = 0;
  let tried = 0;
  for (let k = 0; k < a.xs.length; k += step) {
    tried++;
    const y = a.ys[k] + fy;
    if (y < 0 || y >= H - 1) continue;
    const i = y * W + a.xs[k];
    const i0 = a.ys[k] * W + a.xs[k];
    if (curMask[i] || (fr && curMask[i + W]) || curMask[i0]) continue;
    const c = fr ? cur.data[i] * (1 - fr) + cur.data[i + W] * fr : cur.data[i];
    sum += Math.min(Math.abs(a.refs[k] - c), Math.abs(a.refs[k] - cur.data[i0]));
    n++;
  }
  if (n < tried * 0.5 || n < 8) return NaN;
  return sum / n / Math.max(a.act, 3);
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
  const verdict = (state: TrackState, dy = 0, steady = 0, match = 0, lost: number[] = []): Verdict => ({ state, dy, steady, match, lost });
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
  // long trace costs no more than one line), then quarter pixels.
  const coarse = Math.max(3, Math.ceil(anchors.reduce((s, a) => s + a.xs.length, 0) / 1500));
  const search = (fn: (a: Anchor, dy: number, step: number) => number, minShift: number, voters = anchors.map(() => true)) => {
    const cost = (dy: number, step = 1) => anchors.reduce((s, a) => s + a.weight * capped(fn(a, dy, step)), 0) / total;
    let best = 0;
    let bestCost = minShift > 0 ? Infinity : cost(0, coarse);
    for (let dy = -maxShift; dy <= maxShift; dy++) {
      if (Math.abs(dy) < Math.max(1, minShift)) continue;
      const c = cost(dy, coarse);
      if (c < bestCost) {
        bestCost = c;
        best = dy;
      }
    }
    let fine = best;
    let fineCost = cost(best);
    for (let d = best - 1; d <= best + 1.001; d += 0.25) {
      if (d === best || Math.abs(d) < minShift) continue;
      const c = cost(d);
      if (c < fineCost) {
        fineCost = c;
        fine = d;
      }
    }
    const atFine = anchors.map((a) => fn(a, fine, 1));
    const match = anchors.reduce((s, a, k) => s + (voters[k] && atFine[k] < T_MATCH ? a.weight : 0), 0) / total;
    const moved = Math.abs(fine) >= 0.5 && fineCost < cost(0) * 0.6;
    return { fine, atFine, match, moved };
  };
  const movedVerdict = (r: ReturnType<typeof search>) => {
    // Lost: off the screen, or under something that doesn't scroll (where it went still looks
    // the same as before). Masked isn't lost, and neither is content that's there but changed.
    const lost = anchors.filter((a, k) => r.atFine[k] === Infinity || (r.atFine[k] >= T_LOST && staticAt(a, ref, refMask, cur, curMask, r.fine)));
    return verdict('moved', r.fine, steady, r.match, lost.map((a) => a.index));
  };
  const agrees = (r: ReturnType<typeof search>) => r.moved && (r.match >= AGREE || (r.match >= MOVE_AGREE && steady < GONE));
  const plain = search((a, dy, step) => score(a, cur, curMask, dy, step), 0);
  if (agrees(plain)) return movedVerdict(plain);
  // Within a pixel of where it was (a sub-pixel scroll): still there.
  if (!plain.moved && plain.match >= AGREE) return verdict('steady', 0, steady, plain.match);
  // Part of it can't agree: maybe it sits under something that doesn't scroll. Look again,
  // letting unchanged pixels count as explained (a scroll of a couple of pixels and more).
  // Only anchors that changed can say they moved: one still in place would agree with any shift.
  const tolerant = search((a, dy, step) => staticTolerantScore(a, cur, curMask, dy, step), 2, at0.map((v) => !(v < T_STEADY)));
  if (agrees(tolerant)) return movedVerdict(tolerant);
  if (steady < GONE && plain.match < GONE + 0.1) return verdict('changed', 0, steady, plain.match);
  return verdict('unsure', 0, steady, plain.match);
}

/**
 * After a few moves the small errors of each add up: measure where the content is now against
 * how it first looked (within a couple of pixels of where the moves say it is). The correction
 * (px), or null when the first look can't be found well enough (it has changed since).
 */
function resync(origin: Gray, originMask: Uint8Array, cur: Gray, curMask: Uint8Array, boxes: PxBox[], offset: number): number | null {
  const anchors = boxes.map((b, i) => prepare(origin, originMask, { ...b, y: b.y - offset }, i)).filter((a): a is Anchor => a !== null);
  const total = anchors.reduce((s, a) => s + a.weight, 0);
  if (!anchors.length || !total) return null;
  const cost = (d: number) => anchors.reduce((s, a) => s + a.weight * capped(score(a, cur, curMask, offset + d)), 0) / total;
  let best = 0;
  let bestCost = cost(0);
  for (let d = -2; d <= 2.001; d += 0.25) {
    const c = cost(d);
    if (c < bestCost - 1e-9) {
      bestCost = c;
      best = d;
    }
  }
  const match = anchors.reduce((s, a) => s + (score(a, cur, curMask, offset + best) < T_MATCH ? a.weight : 0), 0) / total;
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
  /** How it first looked, how far it has moved since (px), and whether that was checked against it. */
  origin: Gray;
  originMask: Uint8Array;
  offset: number;
  synced: boolean;
  /** Marks whose line went out of view: how that line looked then, and where it was (px). */
  looks: Map<string, { look: Anchor; y: number }>;
}

/** What one sample says about a group. */
export interface StepResult {
  state: 'steady' | 'moved' | 'gone' | 'unsure';
  dy: number;
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
    if (!g) return { state: 'unsure', dy: 0 };
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

  private changedAgain(key: string, g: GroupState): { state: 'gone' | 'unsure'; dy: number } {
    g.changed++;
    if (g.changed < GONE_AFTER) return { state: 'unsure', dy: 0 };
    this.groups.delete(key);
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
  step(key: string, cur: Gray, mask: Uint8Array, boxes: PxBox[], ids: string[] = [], parked: { id: string; box: PxBox }[] = []): StepResult {
    const g = this.groups.get(key);
    if (!g || g.ref.width !== cur.width || g.ref.height !== cur.height) {
      this.groups.set(key, { ref: cur, refMask: mask, changed: 0, last: 'steady', prev: cur, prevMask: mask, stillFor: 0, origin: cur, originMask: mask, offset: 0, synced: true, looks: new Map() });
      return parked.length ? { state: 'steady', dy: 0, forget: parked.map((p) => p.id) } : { state: 'steady', dy: 0 };
    }
    const v = judge(g.ref, g.refMask, cur, mask, boxes);
    // A line that went out of view: remember how it looked (in the reference, before the move).
    if (v.state === 'moved') {
      for (const k of v.lost) {
        const look = ids[k] ? prepare(g.ref, g.refMask, boxes[k], k) : null;
        if (look) g.looks.set(ids[k], { look, y: boxes[k].y });
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
      g.synced = false;
      return { state: 'moved', dy: v.dy, lost: v.lost, ...this.parkedBack(g, cur, mask, parked, v.dy) };
    }
    // Settled after moving: line up exactly with where its content really is now.
    if (v.state === 'steady' && !g.synced) {
      g.synced = true;
      const fix = resync(g.origin, g.originMask, cur, mask, boxes, g.offset);
      if (fix !== null && Math.abs(fix) >= 0.5) {
        g.offset += fix;
        return { state: 'moved', dy: fix, ...this.parkedBack(g, cur, mask, parked, fix) };
      }
    }
    return v.state === 'steady' ? { state: 'steady', dy: 0, ...this.parkedBack(g, cur, mask, parked, 0) } : { state: v.state, dy: v.dy };
  }

  /**
   * Which parked marks' lines are back in view: each one's line, as it looked when it went,
   * is where the group's movement since puts it (`dy` = this sample's move, not yet applied).
   */
  private parkedBack(g: GroupState, cur: Gray, mask: Uint8Array, parked: { id: string; box: PxBox }[], dy: number): { back?: string[]; forget?: string[] } {
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
      if (score(seen.look, cur, mask, p.box.y + dy - seen.y) < T_MATCH) {
        back.push(p.id);
        g.looks.delete(p.id);
      }
    }
    return { ...(back.length ? { back } : {}), ...(forget.length ? { forget } : {}) };
  }
}
