import type { FrameRef, Point, Rect } from '@shared/geometry';
import type { CaptureSourceSpec, EncodedFrame, TrackGroup, TrackResult } from '@shared/ipc';
import { ipc } from '../ui/ipc';
import { InkTracker, grayFromRGBA, maskOf, movingAreas, type PxBox } from './ink-track';

const GRID_W = 64;
const GRID_H = 36;
const SAMPLE_MS = 500;
const MIN_LIVE_INTERVAL_MS = 1000; // Live API accepts at most 1 frame per second
const CHANGE_CELLS = 0.004; // fraction of grid cells that must change to count as "screen changed"
/** Sticky ink compares the screen at half a pixel per DIP. */
const TRACK_SCALE = 0.5;

interface Source {
  spec: CaptureSourceSpec;
  stream: MediaStream | null;
  video: HTMLVideoElement;
  ready: Promise<void>;
  lastUsed: number;
}

const log = (level: 'info' | 'warn' | 'error', message: string) => ipc.send('engine:log', { level, message });

let frameSeq = 0;

/**
 * Per-display screen streams. Only the display the student is working on streams continuously
 * (sampled twice a second for change detection); other displays are opened on demand. App Veil
 * rectangles are painted black on the canvas *before* JPEG encoding, so veiled pixels never
 * leave this process.
 */
export class ScreenCapture {
  private sources = new Map<string, Source>();
  private specs = new Map<string, CaptureSourceSpec>();
  private active = '';
  private veil = new Map<string, Rect[]>();
  private liveEnabled = true;
  private maxLiveWidth = 1280;
  private quality = 0.62;
  private timer: number | null = null;
  private lastSentAt = 0;
  private lastSentGrid: Uint8ClampedArray | null = null;
  private history: Uint8Array[] = []; // per-sample changed-cell masks (motion → video detection)
  private gridCanvas = new OffscreenCanvas(GRID_W, GRID_H);
  private gridCtx = this.gridCanvas.getContext('2d', { willReadFrequently: true })!;
  videoLikely = false;

  async start(specs: CaptureSourceSpec[], activeId: string, maxLiveWidth: number, quality: number): Promise<void> {
    this.stop();
    for (const s of specs) this.specs.set(s.displayId, s);
    this.maxLiveWidth = maxLiveWidth;
    this.quality = quality;
    await this.setActive(activeId);
    this.timer = window.setInterval(() => void this.sample(), SAMPLE_MS);
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    this.tracker.clear();
    this.trackSig = null;
    for (const s of this.sources.values()) s.stream?.getTracks().forEach((t) => t.stop());
    this.sources.clear();
    this.specs.clear();
    this.lastSentGrid = null;
    this.history = [];
  }

  setLive(enabled: boolean): void {
    this.liveEnabled = enabled;
    if (enabled) this.lastSentGrid = null; // force a fresh frame on resume
  }

  setVeil(entries: { displayId: string; rects: Rect[] }[]): void {
    this.veil = new Map(entries.map((e) => [e.displayId, e.rects]));
  }

  async setActive(displayId: string): Promise<void> {
    if (!this.specs.has(displayId)) return;
    if (this.active === displayId && this.sources.has(displayId)) return;
    const previous = this.active;
    this.active = displayId;
    this.lastSentGrid = null;
    this.history = [];
    await this.ensure(displayId);
    // close the previous display's stream after a grace period (it may be needed again soon)
    if (previous && previous !== displayId) {
      window.setTimeout(() => {
        if (this.active !== previous) this.close(previous);
      }, 15_000);
    }
  }

  private close(displayId: string): void {
    const s = this.sources.get(displayId);
    if (!s) return;
    s.stream?.getTracks().forEach((t) => t.stop());
    this.sources.delete(displayId);
  }

  private async ensure(displayId: string): Promise<Source | null> {
    const existing = this.sources.get(displayId);
    if (existing) {
      existing.lastUsed = Date.now();
      await existing.ready;
      return existing.stream ? existing : null;
    }
    const spec = this.specs.get(displayId);
    if (!spec) return null;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const src: Source = { spec, stream: null, video, ready: Promise.resolve(), lastUsed: Date.now() };
    src.ready = (async () => {
      try {
        const physW = Math.round((spec.sourceSize?.width ?? spec.bounds.width * spec.scaleFactor));
        const physH = Math.round((spec.sourceSize?.height ?? spec.bounds.height * spec.scaleFactor));
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            // Chromium desktop-capture constraints (ScreenCaptureKit on macOS 14+).
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: spec.sourceId,
              maxWidth: physW,
              maxHeight: physH,
              maxFrameRate: 4,
            },
          } as unknown as MediaTrackConstraints,
        });
        src.stream = stream;
        video.srcObject = stream;
        await video.play();
        if (!video.videoWidth) await new Promise<void>((r) => video.addEventListener('loadedmetadata', () => r(), { once: true }));
      } catch (e) {
        log('error', `screen capture failed for ${displayId}: ${(e as Error).message}`);
        src.stream = null;
      }
    })();
    this.sources.set(displayId, src);
    await src.ready;
    return src.stream ? src : null;
  }

  /** Source-pixel rect for a global DIP rect on this source. */
  private toSource(src: Source, r: Rect): Rect {
    const { spec, video } = src;
    const base = spec.cropFromSource ?? { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
    const sx = base.width / spec.bounds.width;
    const sy = base.height / spec.bounds.height;
    return { x: base.x + (r.x - spec.bounds.x) * sx, y: base.y + (r.y - spec.bounds.y) * sy, width: r.width * sx, height: r.height * sy };
  }

  private async sample(): Promise<void> {
    if (!this.active) return;
    const src = this.sources.get(this.active);
    if (!src?.stream || !src.video.videoWidth) return;
    const area = this.toSource(src, src.spec.bounds);
    this.gridCtx.drawImage(src.video, area.x, area.y, area.width, area.height, 0, 0, GRID_W, GRID_H);
    const data = this.gridCtx.getImageData(0, 0, GRID_W, GRID_H).data;
    const grid = new Uint8ClampedArray(GRID_W * GRID_H);
    for (let i = 0; i < grid.length; i++) grid[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;

    // motion history for "is a video playing?"
    if (this.prevGrid) {
      const mask = new Uint8Array(grid.length);
      for (let i = 0; i < grid.length; i++) mask[i] = Math.abs(grid[i] - this.prevGrid[i]) > 6 ? 1 : 0;
      this.history.push(mask);
      if (this.history.length > 5) this.history.shift();
      this.videoLikely = detectVideo(this.history);
    }
    this.prevGrid = grid;

    if (!this.liveEnabled) return;
    let changed = 1;
    if (this.lastSentGrid) {
      let n = 0;
      for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i] - this.lastSentGrid[i]) > 8) n++;
      changed = n / grid.length;
    }
    if (changed < CHANGE_CELLS) return;
    if (Date.now() - this.lastSentAt < MIN_LIVE_INTERVAL_MS) return;
    const frame = await this.encode(src, { maxWidth: this.maxLiveWidth, quality: this.quality, kind: 'live' });
    if (!frame) return;
    frame.changeScore = changed;
    this.lastSentGrid = grid;
    this.lastSentAt = Date.now();
    ipc.send('engine:frame', frame);
  }

  private prevGrid: Uint8ClampedArray | null = null;

  private tracker = new InkTracker();
  private trackDisplay = '';
  private trackCanvas: OffscreenCanvas | null = null;
  private trackCtx: OffscreenCanvasRenderingContext2D | null = null;
  private trackSig: Uint8Array | null = null;
  // GPU-backed on purpose: the video frame is scaled down on the GPU and only the small
  // result is read back (a CPU canvas would copy the whole screen-sized frame every time).
  private sigCtx = new OffscreenCanvas(1, 1).getContext('2d')!;

  /** The marked areas (their union) in grey at a quarter pixel per DIP, to see if anything changed. */
  private signature(src: Source, groups: TrackGroup[]): Uint8Array | null {
    const b = src.spec.bounds;
    const all = groups.flatMap((g) => g.anchors);
    if (!all.length) return null;
    const x1 = Math.max(b.x, Math.min(...all.map((r) => r.x)));
    const y1 = Math.max(b.y, Math.min(...all.map((r) => r.y)));
    const x2 = Math.min(b.x + b.width, Math.max(...all.map((r) => r.x + r.width)));
    const y2 = Math.min(b.y + b.height, Math.max(...all.map((r) => r.y + r.height)));
    if (x2 - x1 < 4 || y2 - y1 < 4) return null;
    const u = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    const w = Math.max(1, Math.round(u.width / 4));
    const h = Math.max(1, Math.round(u.height / 4));
    const c = this.sigCtx.canvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const area = this.toSource(src, u);
    this.sigCtx.drawImage(src.video, area.x, area.y, area.width, area.height, 0, 0, w, h);
    const d = this.sigCtx.getImageData(0, 0, w, h).data;
    // Where the area is on screen is part of it: a moved area never matches the old one.
    const out = new Uint8Array(w * h + 4);
    for (let i = 0; i < w * h; i++) out[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    out.set([x1 & 255, y1 & 255, w & 255, h & 255], w * h);
    return out;
  }

  /**
   * Sticky ink: where each group's content is now, on the display being streamed. Only the
   * verdicts leave this process (no pixels), and a still screen costs one small look.
   */
  trackInk(displayId: string, groups: TrackGroup[], masks: Rect[]): TrackResult[] {
    const src = this.sources.get(displayId);
    if (displayId !== this.active || !src?.stream || !src.video.videoWidth) return groups.map((g) => ({ key: g.key, state: 'unsure', dy: 0 }));
    if (displayId !== this.trackDisplay) {
      this.tracker.clear();
      this.trackDisplay = displayId;
    }
    this.tracker.retain(new Set(groups.map((g) => g.key)));
    // Nothing new on screen since the last look: the same verdicts, without looking again.
    const again = (): TrackResult[] => groups.map((g) => ({ key: g.key, ...this.tracker.again(g.key) }));
    const known = groups.every((g) => this.tracker.has(g.key));
    const b = src.spec.bounds;
    // A quick look first: a small copy of just the marked areas. Unchanged since last time →
    // nothing to compare, and no need to read back the whole screen.
    const sig = this.signature(src, groups);
    const same = sig && this.trackSig && sig.length === this.trackSig.length && sig.every((v, i) => Math.abs(v - this.trackSig![i]) <= 3);
    this.trackSig = sig;
    if (known && same) return again();
    const w = Math.max(1, Math.round(b.width * TRACK_SCALE));
    const h = Math.max(1, Math.round(b.height * TRACK_SCALE));
    if (!this.trackCanvas || this.trackCanvas.width !== w || this.trackCanvas.height !== h) {
      this.trackCanvas = new OffscreenCanvas(w, h);
      this.trackCtx = this.trackCanvas.getContext('2d');
    }
    const ctx = this.trackCtx!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const area = this.toSource(src, b);
    ctx.drawImage(src.video, area.x, area.y, area.width, area.height, 0, 0, w, h);
    const gray = grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h);
    const px = (r: Rect): PxBox => ({ x: (r.x - b.x) * TRACK_SCALE, y: (r.y - b.y) * TRACK_SCALE, w: r.width * TRACK_SCALE, h: r.height * TRACK_SCALE });
    const mask = maskOf(w, h, [...masks, ...movingAreas(this.history, GRID_W, GRID_H, b)].map(px));
    return groups.map((g) => {
      const r = this.tracker.step(g.key, gray, mask, g.anchors.map(px), g.ids, (g.parked ?? []).map((p) => ({ id: p.id, box: px(p.anchor) })), Boolean(g.away));
      return { key: g.key, state: r.state, dy: r.dy / TRACK_SCALE, ...(r.lost?.length ? { lost: r.lost } : {}), ...(r.back ? { back: r.back } : {}), ...(r.forget ? { forget: r.forget } : {}) };
    });
  }

  /** Note that main just sent a frame (e.g. a hi-res one), so live sampling respects the 1 fps cap. */
  markSent(): void {
    this.lastSentAt = Date.now();
  }

  async captureNow(opts: {
    displayId: string;
    maxWidth: number;
    quality: number;
    crop?: Rect;
    kind: 'hires' | 'crop' | 'live';
    composite?: { color: string; strokes: { points: Point[] }[] };
    format?: 'jpeg' | 'png';
  }): Promise<EncodedFrame | null> {
    const src = await this.ensure(opts.displayId);
    if (!src) return null;
    src.lastUsed = Date.now();
    return this.encode(src, opts);
  }

  private async encode(
    src: Source,
    opts: { maxWidth: number; quality: number; crop?: Rect; kind: FrameRef['kind']; composite?: { color: string; strokes: { points: Point[] }[] }; format?: 'jpeg' | 'png' },
  ): Promise<EncodedFrame | null> {
    const { spec, video } = src;
    if (!video.videoWidth) return null;
    const region = opts.crop ? clampTo(opts.crop, spec.bounds) : { ...spec.bounds };
    const s = this.toSource(src, region);
    const scale = Math.min(1, opts.maxWidth / s.width);
    const w = Math.max(1, Math.round(s.width * scale));
    const h = Math.max(1, Math.round(s.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, s.x, s.y, s.width, s.height, 0, 0, w, h);

    const toPx = (p: Point) => ({ x: ((p.x - region.x) / region.width) * w, y: ((p.y - region.y) / region.height) * h });

    // App Veil: paint veiled windows black before the pixels leave this process.
    const veiled: Rect[] = [];
    for (const r of this.veil.get(spec.displayId) ?? []) {
      const a = toPx({ x: r.x, y: r.y });
      const b = toPx({ x: r.x + r.width, y: r.y + r.height });
      if (b.x <= 0 || b.y <= 0 || a.x >= w || a.y >= h) continue;
      ctx.fillStyle = '#000';
      ctx.fillRect(a.x - 1, a.y - 1, b.x - a.x + 2, b.y - a.y + 2);
      ctx.fillStyle = '#5a5a5a';
      ctx.font = `${Math.max(10, Math.round(14 * scale * spec.scaleFactor))}px sans-serif`;
      ctx.fillText('hidden by App Veil', a.x + 8, a.y + 20);
      veiled.push(r);
    }

    // Student strokes are composited explicitly (our overlay is excluded from capture).
    if (opts.composite) {
      const lw = Math.max(3, 5 * (w / region.width));
      for (const st of opts.composite.strokes) {
        if (!st.points.length) continue;
        // A tap is a dot: a zero-length line with round caps.
        if (st.points.length === 1) st.points = [st.points[0], st.points[0]];
        for (const pass of [{ c: 'rgba(0,0,0,0.65)', w: lw + 3 }, { c: opts.composite.color, w: lw }]) {
          ctx.strokeStyle = pass.c;
          ctx.lineWidth = pass.w;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          const p0 = toPx(st.points[0]);
          ctx.moveTo(p0.x, p0.y);
          for (const p of st.points.slice(1)) {
            const q = toPx(p);
            ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
        }
      }
    }

    const mime = opts.format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await canvas.convertToBlob({ type: mime, quality: opts.quality });
    const data = new Uint8Array(await blob.arrayBuffer());
    frameSeq += 1;
    return {
      ref: { id: `fr-${Date.now().toString(36)}-${frameSeq}`, displayId: spec.displayId, region, pixelWidth: w, pixelHeight: h, capturedAt: Date.now(), kind: opts.kind },
      data,
      mime,
      changeScore: 0,
      veiled,
    };
  }

  /** Release streams of inactive displays that haven't been used for a while. */
  gc(): void {
    const now = Date.now();
    for (const [id, s] of this.sources) if (id !== this.active && now - s.lastUsed > 20_000) this.close(id);
  }
}

function clampTo(r: Rect, b: Rect): Rect {
  const x = Math.max(b.x, Math.min(r.x, b.x + b.width - 1));
  const y = Math.max(b.y, Math.min(r.y, b.y + b.height - 1));
  const x2 = Math.min(b.x + b.width, Math.max(x + 1, r.x + r.width));
  const y2 = Math.min(b.y + b.height, Math.max(y + 1, r.y + r.height));
  return { x, y, width: x2 - x, height: y2 - y };
}

/**
 * A video is likely playing when the same compact block of cells kept changing in most recent
 * samples while most of the screen stayed still (typing/scrolling changes don't look like this).
 */
export function detectVideo(history: Uint8Array[]): boolean {
  if (history.length < 4) return false;
  const n = history[0].length;
  const persistent = new Uint8Array(n);
  let count = 0;
  let minX = GRID_W, minY = GRID_H, maxX = -1, maxY = -1;
  for (let i = 0; i < n; i++) {
    let hits = 0;
    for (const h of history) hits += h[i];
    if (hits >= history.length - 1) {
      persistent[i] = 1;
      count++;
      const x = i % GRID_W;
      const y = Math.floor(i / GRID_W);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (count < n * 0.02) return false;
  const boxArea = (maxX - minX + 1) * (maxY - minY + 1);
  const density = count / boxArea;
  return density > 0.35 && boxArea < n * 0.9;
}
