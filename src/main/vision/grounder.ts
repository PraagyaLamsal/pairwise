import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { box2dToGlobal, cropAround, inflateRect, normToGlobal, rectCenter, type Box2D, type FrameRef, type Point, type Rect } from '@shared/geometry';
import type { EncodedFrame } from '@shared/ipc';
import type { GeminiRest } from '../gemini/rest';
import { logger } from '../log';
import { snapToControl, type Bitmap } from './snap';

const log = logger('grounder');

export interface GroundTarget {
  id: string;
  description: string;
  /** Model's own estimate, 0–1000 in `hintFrame`. */
  approx?: { x: number; y: number };
  /** Ask for a tight text box (underline/highlight) → triggers the zoom pass. */
  precise?: boolean;
  /** Names a control (button, tab, field…): grow a label box to the control's own edges. */
  control?: boolean;
}

export interface GroundResult {
  id: string;
  found: boolean;
  rect?: Rect;
  point?: Point;
  displayId?: string;
  via: 'gemini' | 'gemini-zoom' | 'ocr' | 'approx' | 'none';
  ms: number;
}

export interface FrameSource {
  /** High-resolution capture of a display (optionally a crop, global DIP). */
  capture(displayId: string, opts: { maxWidth: number; crop?: Rect }): Promise<EncodedFrame | null>;
}

/** One model box answer: box_2d is [ymin, xmin, ymax, xmax] normalized 0–1000 to the image sent. */
export interface ModelBox {
  id: string;
  found: boolean;
  box_2d?: number[];
}

/** Something that can find described targets in an image. */
export interface GroundingBackend {
  readonly name: GroundResult['via'];
  readonly available: boolean;
  /** `exclude`: global rects of Pairwise's own UI (cursor bubble, HUD) to ignore when matching. */
  find(frame: EncodedFrame, targets: GroundTarget[], signal?: AbortSignal, exclude?: Rect[]): Promise<ModelBox[]>;
}

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'STRING' },
      found: { type: 'BOOLEAN' },
      box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
    },
    required: ['id', 'found'],
  },
};

/** gemini-3.8-flash spatial understanding: tight box_2d per described target. */
export class GeminiBackend implements GroundingBackend {
  readonly name = 'gemini' as const;
  constructor(
    private readonly rest: GeminiRest,
    private readonly model: () => string,
  ) {}

  get available(): boolean {
    return this.rest.hasKey;
  }

  async find(frame: EncodedFrame, targets: GroundTarget[]): Promise<ModelBox[]> {
    const list = targets
      .map((t, i) => {
        const hint = t.approx ? ` (a teammate guessed roughly x=${Math.round(t.approx.x)}, y=${Math.round(t.approx.y)} on a 0-1000 scale; the guess can be wrong)` : '';
        return `${i + 1}. id "${t.id}": ${t.description}${hint}`;
      })
      .join('\n');
    const prompt = [
      `This is a screenshot of a computer screen (${frame.ref.pixelWidth}×${frame.ref.pixelHeight} px).`,
      'Find each target below and return a tight bounding box around exactly that element or text — the button, word, line or icon itself, not the panel or window around it. For a line of code or text, box just that line.',
      'Return a JSON array: [{"id": "...", "found": true, "box_2d": [ymin, xmin, ymax, xmax]}] with coordinates normalized to 0-1000. If a target is not visible, return {"id": "...", "found": false}. Black areas labelled "hidden by App Veil" are private: never return a box inside them.',
      'Targets:',
      list,
    ].join('\n');
    const r = await this.rest.generateJson<ModelBox[] | { targets?: ModelBox[] }>(
      this.model(),
      {
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: frame.mime, data: Buffer.from(frame.data).toString('base64') } }, { text: prompt }] }],
        generationConfig: { responseSchema: SCHEMA, thinkingConfig: { thinkingLevel: 'low' }, temperature: 0.2 },
      },
      { timeoutMs: 12_000, inputModality: 'IMAGE' },
    );
    return Array.isArray(r) ? r : (r.targets ?? []);
  }
}

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  line: string;
}

/** Words + pixel boxes from the tesseract CLI (tests, offline fallback). */
export function runTesseract(image: Uint8Array, mime: string, extra: string[] = []): Promise<OcrWord[]> {
  const dir = mkdtempSync(join(tmpdir(), 'pw-ocr-'));
  const file = join(dir, mime === 'image/png' ? 'f.png' : 'f.jpg');
  writeFileSync(file, image);
  return new Promise((resolve) => {
    // Several passes run at once; tesseract's OpenMP threads then fight over the cores and a
    // pass that takes 0.25 s alone can stall for 30 s+ (seen on a 4-core machine). One thread each.
    const opts = { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: '1' } };
    execFile('tesseract', [file, 'stdout', '--psm', '11', ...extra, 'tsv'], opts, (err, stdout) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) return resolve([]);
      const words: OcrWord[] = [];
      for (const line of stdout.split('\n').slice(1)) {
        const c = line.split('\t');
        if (c.length < 12) continue;
        const text = c[11].trim();
        const conf = Number(c[10]);
        if (!text || conf < 30) continue;
        words.push({ text, x: +c[6], y: +c[7], w: +c[8], h: +c[9], line: `${c[2]}-${c[3]}-${c[4]}` });
      }
      resolve(words);
    });
  });
}

/** Text to look for in a description: quoted parts first, else capitalised/code-ish words. */
export function searchTerms(description: string): string[] {
  const quoted = [...description.matchAll(/["“'‘`]([^"”'’`]{1,60})["”'’`]/g)].map((m) => m[1].trim()).filter(Boolean);
  if (quoted.length) return quoted;
  const stop = new Set(['the', 'a', 'an', 'button', 'line', 'word', 'text', 'in', 'on', 'of', 'at', 'to', 'menu', 'tab', 'icon', 'this', 'that', 'top', 'bottom', 'left', 'right', 'field', 'link']);
  return description
    .split(/\s+/)
    .map((w) => w.replace(/[^\w()+=.:-]/g, ''))
    .filter((w) => w.length > 1 && !stop.has(w.toLowerCase()))
    .slice(0, 3);
}

/** OCR tokens and search terms compared without surrounding punctuation ("(Run", "‘Submit", "1):"). */
export function ocrNorm(s: string): string {
  return s.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
}

/** Scales an encoded frame (for OCR passes at another pixel density). */
export type FrameResizer = (frame: EncodedFrame, factor: number) => { data: Uint8Array; mime: string } | null;

/**
 * Finds targets whose description names visible text, by OCR. Exact to the pixel, text only.
 * Tesseract is fussy about text inside bordered buttons and about mid-grey backgrounds, so it
 * runs a few passes in parallel (global/adaptive thresholding; half scale for HiDPI frames) and
 * takes the first pass that has the words.
 */
export class OcrBackend implements GroundingBackend {
  readonly name = 'ocr' as const;
  readonly available = true;

  constructor(private readonly resize?: FrameResizer) {}

  async find(frame: EncodedFrame, targets: GroundTarget[], _signal?: AbortSignal, exclude: Rect[] = []): Promise<ModelBox[]> {
    const W = frame.ref.pixelWidth;
    const H = frame.ref.pixelHeight;
    // Where X11 can't keep our overlays out of captures, don't match the cursor's own label.
    const sx = W / frame.ref.region.width;
    const sy = H / frame.ref.region.height;
    const own = exclude.map((r) => ({ x1: (r.x - frame.ref.region.x) * sx, y1: (r.y - frame.ref.region.y) * sy, x2: (r.x + r.width - frame.ref.region.x) * sx, y2: (r.y + r.height - frame.ref.region.y) * sy }));
    const mine = (h: WordHit) => own.some((o) => (h.x1 + h.x2) / 2 >= o.x1 && (h.x1 + h.x2) / 2 <= o.x2 && (h.y1 + h.y2) / 2 >= o.y1 && (h.y1 + h.y2) / 2 <= o.y2);
    const density = W / frame.ref.region.width;
    const passes: Promise<OcrWord[]>[] = [runTesseract(frame.data, frame.mime), runTesseract(frame.data, frame.mime, ['-c', 'thresholding_method=1'])];
    const half = density >= 1.5 && this.resize ? this.resize(frame, 0.5) : null;
    if (half) {
      const up = (ws: OcrWord[]) => ws.map((w) => ({ ...w, x: w.x * 2, y: w.y * 2, w: w.w * 2, h: w.h * 2 }));
      passes.push(runTesseract(half.data, half.mime).then(up), runTesseract(half.data, half.mime, ['-c', 'thresholding_method=1']).then(up));
    }
    const results = await Promise.all(passes);
    const mergedHits = (description: string) => mergeHits(results.flatMap((words) => matchWords(words, description)).filter((h) => !mine(h)));
    return targets.map((t) => {
      // Every pass's matches compete: exact words beat prefixes ("factorial" vs "factorial(n"),
      // then closeness to the model's guess, then reading order (top-to-bottom, left-to-right).
      const hits = mergedHits(t.description);
      if (!hits.length) return { id: t.id, found: false };
      const guess = t.approx ? { x: (t.approx.x / 1000) * W, y: (t.approx.y / 1000) * H } : null;
      const lineH = Math.max(8, ...hits.map((h) => h.y2 - h.y1));
      hits.sort((a, b) => {
        if (a.exact !== b.exact) return a.exact ? -1 : 1;
        if (guess) {
          const da = Math.hypot((a.x1 + a.x2) / 2 - guess.x, (a.y1 + a.y2) / 2 - guess.y);
          const db = Math.hypot((b.x1 + b.x2) / 2 - guess.x, (b.y1 + b.y2) / 2 - guess.y);
          if (Math.abs(da - db) > lineH) return da - db;
        }
        if (Math.abs(a.y1 - b.y1) > lineH * 0.6) return a.y1 - b.y1;
        return a.x1 - b.x1;
      });
      const { x1, y1, x2, y2 } = hits[0];
      return { id: t.id, found: true, box_2d: [Math.round((y1 / H) * 1000), Math.round((x1 / W) * 1000), Math.round((y2 / H) * 1000), Math.round((x2 / W) * 1000)] };
    });
  }
}

export interface WordHit {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  exact: boolean;
}

/**
 * The same word found by several OCR passes → one box with the median of each edge (single
 * passes are often off by a glyph or swallow a button border; the median rarely is).
 */
export function mergeHits(hits: WordHit[]): WordHit[] {
  const groups: WordHit[][] = [];
  const area = (h: WordHit) => Math.max(1, (h.x2 - h.x1) * (h.y2 - h.y1));
  const overlap = (a: WordHit, b: WordHit) => {
    const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    return w > 0 && h > 0 ? (w * h) / Math.min(area(a), area(b)) : 0;
  };
  for (const h of hits) {
    const g = groups.find((g) => overlap(g[0], h) > 0.3);
    if (g) g.push(h);
    else groups.push([h]);
  }
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return groups.map((g) => ({ x1: median(g.map((h) => h.x1)), y1: median(g.map((h) => h.y1)), x2: median(g.map((h) => h.x2)), y2: median(g.map((h) => h.y2)), exact: g.some((h) => h.exact) }));
}

/** All runs of OCR words that spell a search term of the description. */
export function matchWords(words: OcrWord[], description: string): WordHit[] {
  const hits: WordHit[] = [];
  for (const term of searchTerms(description)) {
    const parts = term.split(/\s+/).map(ocrNorm).filter(Boolean);
    if (!parts.length) continue;
    for (let i = 0; i < words.length; i++) {
      const run = words.slice(i, i + parts.length);
      if (run.length !== parts.length || new Set(run.map((w) => w.line)).size > 1) continue;
      let exact = true;
      const ok = run.every((w, k) => {
        const t = ocrNorm(w.text);
        if (t === parts[k]) return true;
        if (k === run.length - 1 && t.startsWith(parts[k])) {
          exact = false;
          return true;
        }
        return false;
      });
      if (!ok) continue;
      const last = run[run.length - 1];
      let lastX2 = last.x + last.w;
      if (!exact) {
        // "factorial(n):" matched "factorial": keep the box to the matching characters.
        const lead = last.text.length - last.text.replace(/^[^\w]+/, '').length;
        const upto = lead + parts[parts.length - 1].length;
        lastX2 = last.x + (last.w * upto) / Math.max(1, last.text.length);
      }
      hits.push({
        x1: Math.min(...run.map((w) => w.x)),
        y1: Math.min(...run.map((w) => w.y)),
        x2: Math.max(...run.slice(0, -1).map((w) => w.x + w.w), lastX2),
        y2: Math.max(...run.map((w) => w.y + w.h)),
        exact,
      });
    }
    if (hits.length) break; // the first term that appears at all wins (quoted text first)
  }
  return hits;
}

/** Default size of a box synthesized around an approximate point (DIP). */
const APPROX_BOX = { width: 120, height: 40 };

/**
 * Finds on-screen targets precisely. The live model only sees a low-detail stream, so it names
 * a target (plus a rough guess); we ground that description on a fresh full-resolution capture
 * (box_2d, 0–1000) and, for small or text targets, zoom in on a crop for a second, tighter pass.
 * Every box is mapped back to global DIPs through the frame's FrameRef — the one conversion that
 * test/unit/geometry.test.ts pins down.
 */
export class Grounder {
  private cache = new Map<string, { at: number; result: GroundResult }>();

  constructor(
    private readonly backend: () => GroundingBackend | null,
    private readonly frames: FrameSource,
    /** Decodes a frame to pixels for control snapping (absent → no snapping). */
    private readonly decode?: (frame: EncodedFrame) => Bitmap | null,
    /** Pairwise's own on-screen UI right now (global DIP), never a grounding answer. */
    private readonly ownUi: () => Rect[] = () => [],
  ) {}

  get canSee(): boolean {
    return Boolean(this.backend()?.available);
  }

  async locate(displayId: string, targets: GroundTarget[], hintFrame: FrameRef | null, signal?: AbortSignal): Promise<GroundResult[]> {
    const t0 = Date.now();
    if (!targets.length) return [];
    const approx = (t: GroundTarget): GroundResult => {
      if (!t.approx || !hintFrame) return { id: t.id, found: false, via: 'none', ms: Date.now() - t0 };
      const p = normToGlobal(hintFrame, t.approx.x, t.approx.y);
      return { id: t.id, found: true, point: p, displayId: hintFrame.displayId, rect: { x: p.x - APPROX_BOX.width / 2, y: p.y - APPROX_BOX.height / 2, ...APPROX_BOX }, via: 'approx', ms: Date.now() - t0 };
    };
    const backend = this.backend();
    if (!backend?.available) return targets.map(approx);

    // Recently grounded identical descriptions (point_at then annotate the same thing).
    const fresh: GroundResult[] = [];
    const todo: GroundTarget[] = [];
    for (const t of targets) {
      const hit = this.cache.get(`${displayId}|${t.description}`);
      if (hit && Date.now() - hit.at < 4000) fresh.push({ ...hit.result, id: t.id, ms: 0 });
      else todo.push(t);
    }
    if (!todo.length) return targets.map((t) => fresh.find((f) => f.id === t.id)!);

    const frame = await this.frames.capture(displayId, { maxWidth: 2048 });
    if (!frame || signal?.aborted) return targets.map(approx);

    let boxes: ModelBox[] = [];
    try {
      boxes = await backend.find(frame, todo, signal, this.ownUi());
      debugDump('ground', frame, { targets: todo, boxes });
    } catch (e) {
      log.warn('grounding failed; using approximate positions', e);
      return targets.map((t) => fresh.find((f) => f.id === t.id) ?? approx(t));
    }

    const results: GroundResult[] = todo.map((t) => {
      const b = boxes.find((x) => x.id === t.id);
      if (!b?.found || !b.box_2d || b.box_2d.length !== 4 || b.box_2d.some((v) => !Number.isFinite(v))) return approx(t);
      const rect = box2dToGlobal(frame.ref, b.box_2d as Box2D);
      if (rect.width < 1 || rect.height < 1) return approx(t);
      return { id: t.id, found: true, rect, point: rectCenter(rect), displayId, via: backend.name, ms: Date.now() - t0 };
    });

    // Zoom pass for small or text-precise targets (Gemini only; OCR is already pixel-exact).
    if (backend.name === 'gemini') {
      await Promise.all(
        results.map(async (r, i) => {
          if (!r.found || r.via !== 'gemini' || !r.rect || signal?.aborted) return;
          const t = todo[i];
          const small = r.rect.width < frame.ref.region.width * 0.035 || r.rect.height < frame.ref.region.height * 0.025;
          if (!small && !t.precise) return;
          const crop = cropAround(frame.ref.region, rectCenter(r.rect), Math.max(520, r.rect.width * 3.2), Math.max(320, r.rect.height * 5));
          const zoom = await this.frames.capture(displayId, { maxWidth: 1600, crop });
          if (!zoom) return;
          try {
            const [zb] = await backend.find(zoom, [{ ...t, approx: undefined }], signal, this.ownUi());
            if (zb?.found && zb.box_2d?.length === 4) {
              const z = box2dToGlobal(zoom.ref, zb.box_2d as Box2D);
              // Accept only if the zoomed box is consistent with the first pass.
              const c = rectCenter(z);
              if (pointNear(c, inflateRect(r.rect, Math.max(30, r.rect.width), Math.max(20, r.rect.height)))) {
                results[i] = { ...r, rect: z, point: c, via: 'gemini-zoom', ms: Date.now() - t0 };
              }
            }
          } catch (e) {
            log.debug('zoom pass failed', e);
          }
        }),
      );
    }
    this.snapControls(frame, todo, results);
    if (process.env.PAIRWISE_DEBUG_DIR) log.info('grounded', JSON.stringify(results.map((r) => ({ id: r.id, via: r.via, rect: r.rect }))));
    for (let i = 0; i < todo.length; i++) if (results[i].found && results[i].via !== 'approx') this.cache.set(`${displayId}|${todo[i].description}`, { at: Date.now(), result: results[i] });
    log.info(`grounded ${results.filter((r) => r.found).length}/${todo.length} via ${backend.name} in ${Date.now() - t0} ms`);
    return targets.map((t) => fresh.find((f) => f.id === t.id) ?? results.find((r) => r.id === t.id)!);
  }

  /** Label box → control box for targets that name a control (see snap.ts). */
  private snapControls(frame: EncodedFrame, todo: GroundTarget[], results: GroundResult[]): void {
    if (!this.decode || !todo.some((t, i) => t.control && results[i].found && results[i].via !== 'approx')) return;
    let img: Bitmap | null = null;
    try {
      img = this.decode(frame);
    } catch (e) {
      log.debug('frame decode failed', e);
    }
    if (!img) return;
    const ref = frame.ref;
    const sx = img.width / ref.region.width;
    const sy = img.height / ref.region.height;
    todo.forEach((t, i) => {
      const r = results[i];
      if (!t.control || !r.found || !r.rect || r.via === 'approx') return;
      const px = { x1: (r.rect.x - ref.region.x) * sx, y1: (r.rect.y - ref.region.y) * sy, x2: (r.rect.x + r.rect.width - ref.region.x) * sx, y2: (r.rect.y + r.rect.height - ref.region.y) * sy };
      const snapped = snapToControl(img!, px);
      if (!snapped) return;
      const rect = { x: ref.region.x + snapped.x1 / sx, y: ref.region.y + snapped.y1 / sy, width: (snapped.x2 - snapped.x1) / sx, height: (snapped.y2 - snapped.y1) / sy };
      results[i] = { ...r, rect, point: rectCenter(rect) };
    });
  }
}

/** PAIRWISE_DEBUG_DIR: keep each grounding frame and the backend's answer for inspection. */
function debugDump(tag: string, frame: EncodedFrame, info: unknown): void {
  const dir = process.env.PAIRWISE_DEBUG_DIR;
  if (!dir) return;
  try {
    const stem = join(dir, `${tag}-${Date.now()}`);
    writeFileSync(`${stem}.${frame.mime === 'image/png' ? 'png' : 'jpg'}`, frame.data);
    writeFileSync(`${stem}.json`, JSON.stringify({ ref: frame.ref, ...(info as object) }, null, 2));
  } catch {
    /* debugging aid only */
  }
}

function pointNear(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
}
