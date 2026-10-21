import type { Point, Rect } from '@shared/geometry';
import type { CursorCancel, CursorFlight, CursorFrame, CursorPresence, CursorTrace, InkItem } from '@shared/ink';
import { flightPoint, glidePoint, penStateAt } from '@shared/ink-geometry';

/** The pointer's tip inside its 26×26 box (the SVG draws the tip at 3,3). */
const TIP = { x: 3, y: 3 };
const INTERP_DELAY_MS = 22;
const DRIVING_COLOR = '#FFB224';

type Seg =
  | { kind: 'flight'; startAt: number; endAt: number; f: CursorFlight }
  | { kind: 'trace'; startAt: number; endAt: number; t: CursorTrace };

/**
 * The tutor's cursor, drawn like a person's cursor on a Tuple call: a flat arrow in her colour
 * with a white edge, and a small name label that only shows while she is doing something. It
 * stays wherever she left it and dims when it's idle (more when the student's pointer is near),
 * so it never covers their work. Motion comes from main as scheduled flights, traces (the cursor
 * is the pen: it follows the ink's own stroke timing) and pointer-only glides, animated here.
 */
export class CursorView {
  readonly el: HTMLDivElement;
  private label: HTMLDivElement;
  private labelText: HTMLSpanElement;
  private frames: CursorFrame[] = [];
  private segs: Seg[] = [];
  private lastLabelSeq = -1;
  private streamTimer: number | null = null;
  private activity = '';
  private presence: CursorPresence | '' = '';
  private visible = false;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private latest: CursorFrame | null = null;
  private pos: Point = { x: -1000, y: -1000 };
  private parkedAt: Point | null = null;
  private tutorColor: string;
  private mode: 'frames' | 'segment' | 'parked' = 'frames';
  private lastSegEnd: number | null = null;
  /** macOS "Reduce motion": labels appear at once instead of typing themselves in. */
  reducedMotion = false;

  constructor(
    root: HTMLElement,
    color: string,
    private readonly itemFor: (id: string) => InkItem | undefined,
  ) {
    this.tutorColor = color;
    this.el = document.createElement('div');
    this.el.className = 'buddy hidden';
    this.el.innerHTML = `
      <svg class="buddy-arrow" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <path d="M3 3 L3 20.6 L7.4 16.6 L10.4 23.4 L13.5 22.1 L10.6 15.4 L16.6 15.4 Z" fill="var(--buddy)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
      <div class="buddy-label"><span class="buddy-label-text"></span></div>`;
    root.appendChild(this.el);
    this.label = this.el.querySelector('.buddy-label') as HTMLDivElement;
    this.labelText = this.el.querySelector('.buddy-label-text') as HTMLSpanElement;
    this.applyColor(color);
  }

  setBounds(b: Rect): void {
    this.bounds = b;
  }

  /** The tutor's colour (amber is used automatically while driving). */
  setColor(color: string): void {
    this.tutorColor = color;
    this.applyColor(this.activity === 'driving' ? DRIVING_COLOR : color);
  }

  private applyColor(color: string): void {
    this.el.style.setProperty('--buddy', color);
  }

  pushFrame(f: CursorFrame): void {
    this.latest = f;
    this.frames.push(f);
    if (this.frames.length > 8) this.frames.shift();
    this.applyState(f);
  }

  startFlight(f: CursorFlight): void {
    // Start from where this overlay really drew the cursor (avoids a hop when main could only
    // approximate where the previous move ended).
    const from = this.segs.length || this.mode !== 'frames' ? this.positionAtTime(f.startAt) : null;
    const fixed = from && Math.hypot(from.x - f.from.x, from.y - f.from.y) < 80 ? { ...f, from } : f;
    this.segs.push({ kind: 'flight', startAt: f.startAt, endAt: f.startAt + f.duration, f: fixed });
    this.segs.sort((a, b) => a.startAt - b.startAt);
  }

  startTrace(t: CursorTrace): void {
    this.segs.push({ kind: 'trace', startAt: t.startAt, endAt: t.startAt + t.duration, t });
    this.segs.sort((a, b) => a.startAt - b.startAt);
  }

  cancel(c: CursorCancel): void {
    this.segs = [];
    this.parkedAt = c.pos;
    this.mode = 'parked';
  }

  get position(): Point {
    return this.pos;
  }

  /** When the cursor next needs drawing: now while it moves (or follows main's frames), else when its next move starts. */
  nextChange(now: number): number {
    if (this.segs.length) {
      const s = this.segs[0];
      return now >= s.startAt - 16 ? now : s.startAt - 16;
    }
    // Following main's frames (driving): keep interpolating briefly after the last one, unless
    // the cursor isn't moving (the frame only carried the student's pointer).
    const f = this.latest;
    if (f && this.mode === 'frames' && now < f.t + INTERP_DELAY_MS + 80) {
      const prev = this.frames[this.frames.length - 2];
      const still = prev && prev.pos.x === f.pos.x && prev.pos.y === f.pos.y && this.pos.x === f.pos.x && this.pos.y === f.pos.y;
      if (!still) return now;
    }
    return Infinity;
  }

  private positionAtTime(t: number): Point {
    let p = this.parkedAt ?? this.pos;
    const at = (s: Seg, u: number) => (s.kind === 'flight' ? flightPoint(s.f, u).p : (this.tracePoint(s.t, u) ?? s.t.end));
    for (const s of this.segs) {
      // Before a segment starts the cursor waits where the previous one left it.
      if (t < s.startAt) return p;
      if (t <= s.endAt) return at(s, t);
      p = at(s, s.endAt);
    }
    return p;
  }

  private tracePoint(t: CursorTrace, now: number): Point | null {
    const ms = Math.min(t.duration, Math.max(0, now - t.startAt));
    if (t.path) return glidePoint(t.path, ms / Math.max(1, t.duration), t.style ?? 'glide');
    const item = t.itemId ? this.itemFor(t.itemId) : undefined;
    if (!item) return t.end;
    return penStateAt(item, ms).pen ?? t.end;
  }

  /** Called every animation frame. */
  update(now: number): void {
    const f = this.latest;
    if (!f || !f.visible) {
      this.setVisible(false);
      return;
    }
    let pos: Point;
    let moving = false;

    // Drop finished segments, remembering where the last one ended.
    while (this.segs.length && now > this.segs[0].endAt + 16) {
      const s = this.segs.shift()!;
      this.parkedAt = s.kind === 'flight' ? s.f.to : (this.tracePoint(s.t, s.endAt) ?? s.t.end);
      this.lastSegEnd = s.endAt;
      this.mode = 'parked';
    }
    const active = this.segs.find((s) => now >= s.startAt && now <= s.endAt + 16);
    if (active?.kind === 'flight') {
      pos = flightPoint(active.f, now).p;
      moving = true;
      this.mode = 'segment';
    } else if (active?.kind === 'trace') {
      pos = this.tracePoint(active.t, now) ?? active.t.end;
      moving = true;
      this.mode = 'segment';
    } else if (this.segs.length) {
      // Waiting for a scheduled segment: hold where the next one starts.
      pos = this.positionAtTime(now);
    } else if (this.mode === 'parked' && this.parkedAt && f.t <= (this.lastSegEnd ?? 0) + 40) {
      // Main hasn't sent a frame since the timeline ended yet: stay exactly where we drew.
      pos = this.parkedAt;
    } else {
      if (this.mode !== 'frames' && this.lastSegEnd) this.frames = this.frames.filter((fr) => fr.t >= (this.lastSegEnd ?? 0));
      this.mode = 'frames';
      this.parkedAt = null;
      pos = this.interpolate(now);
    }
    this.el.classList.toggle('moving', moving);
    this.el.classList.toggle('tracing', active?.kind === 'trace' && !active.t.path);
    // Moving always reads at full strength, whatever the last frame said.
    this.setPresence(moving || this.segs.length ? 'active' : f.presence);
    this.pos = pos;

    const lx = pos.x - this.bounds.x;
    const ly = pos.y - this.bounds.y;
    const margin = 140;
    const onThis = lx > -margin && ly > -margin && lx < this.bounds.width + margin && ly < this.bounds.height + margin;
    this.setVisible(onThis);
    if (!onThis) return;
    this.el.style.transform = `translate3d(${(lx - TIP.x).toFixed(2)}px, ${(ly - TIP.y).toFixed(2)}px, 0)`;
  }

  private interpolate(now: number): Point {
    const t = now - INTERP_DELAY_MS;
    const fr = this.frames;
    if (!fr.length) return this.latest?.pos ?? this.pos;
    if (t <= fr[0].t) return fr[0].pos;
    for (let i = fr.length - 1; i > 0; i--) {
      const a = fr[i - 1];
      const b = fr[i];
      if (t >= a.t && t <= b.t) {
        const k = (t - a.t) / Math.max(1, b.t - a.t);
        return { x: a.pos.x + (b.pos.x - a.pos.x) * k, y: a.pos.y + (b.pos.y - a.pos.y) * k };
      }
    }
    return fr[fr.length - 1].pos;
  }

  private setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.el.classList.toggle('hidden', !v);
  }

  private setPresence(p: CursorPresence): void {
    if (p === this.presence) return;
    if (this.presence) this.el.classList.remove(`p-${this.presence}`);
    this.presence = p;
    this.el.classList.add(`p-${p}`);
    this.el.dataset.presence = p;
  }

  private applyState(f: CursorFrame): void {
    if (f.activity !== this.activity) {
      this.el.classList.remove(`act-${this.activity}`);
      this.activity = f.activity;
      this.el.classList.add(`act-${f.activity}`);
      this.applyColor(f.activity === 'driving' ? DRIVING_COLOR : this.tutorColor);
    }
    this.label.classList.toggle('pointing', f.labelKind === 'pointing');
    if (f.labelSeq !== this.lastLabelSeq) {
      this.lastLabelSeq = f.labelSeq;
      this.streamLabel(f.label, f.labelKind === 'pointing');
    }
  }

  /** Pointing labels type themselves in quickly; names and statuses just appear. */
  private streamLabel(text: string, animate: boolean): void {
    if (this.streamTimer) window.clearTimeout(this.streamTimer);
    this.label.classList.toggle('empty', !text);
    if (!animate || this.reducedMotion) {
      this.labelText.textContent = text;
      return;
    }
    this.labelText.textContent = '';
    let i = 0;
    const step = () => {
      i += 1;
      this.labelText.textContent = text.slice(0, i);
      if (i < text.length) this.streamTimer = window.setTimeout(step, 18 + Math.random() * 22);
    };
    step();
  }
}
