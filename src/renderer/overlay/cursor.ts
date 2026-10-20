import type { Point, Rect } from '@shared/geometry';
import type { CursorCancel, CursorFlight, CursorFrame, CursorTrace, InkItem } from '@shared/ink';
import { easeInOut, inkPenPoint } from '@shared/ink-geometry';

/** The pointer's tip inside its 28×28 box (the SVG draws the tip at 3,3). */
const TIP = { x: 3, y: 3 };
/** The arrowhead points up-left (−135°) at zero rotation, like a system pointer. */
const BASE_ANGLE = -135;
const INTERP_DELAY_MS = 22;
const TRAIL_MS = 170;

type Seg =
  | { kind: 'flight'; startAt: number; endAt: number; f: CursorFlight }
  | { kind: 'trace'; startAt: number; endAt: number; t: CursorTrace };

function flightAt(f: CursorFlight, now: number) {
  const lin = Math.min(1, Math.max(0, (now - f.startAt) / f.duration));
  const t = lin * lin * (3 - 2 * lin);
  const u = 1 - t;
  const p = {
    x: u * u * f.from.x + 2 * u * t * f.ctrl.x + t * t * f.to.x,
    y: u * u * f.from.y + 2 * u * t * f.ctrl.y + t * t * f.to.y,
  };
  const tx = 2 * u * (f.ctrl.x - f.from.x) + 2 * t * (f.to.x - f.ctrl.x);
  const ty = 2 * u * (f.ctrl.y - f.from.y) + 2 * t * (f.to.y - f.ctrl.y);
  const heading = (Math.atan2(ty, tx) * 180) / Math.PI;
  return { p, lin, heading };
}

function shortestAngle(from: number, to: number): number {
  let d = ((to - from + 540) % 360) - 180;
  if (d < -180) d += 360;
  return from + d;
}

/**
 * The tutor's buddy cursor: a small glowing arrowhead with a name pill, in the spirit of
 * heyclicky/Clicky. It follows the student's pointer on a spring (60 Hz frames from main,
 * interpolated here), swoops along scheduled Bézier flights, and becomes the pen while the tutor
 * draws (traces follow the ink's own stroke path with the renderer's easing).
 */
export class CursorView {
  readonly el: HTMLDivElement;
  private shape: HTMLDivElement;
  private label: HTMLDivElement;
  private labelText: HTMLSpanElement;
  private waveBars: HTMLSpanElement[] = [];
  private frames: CursorFrame[] = [];
  private segs: Seg[] = [];
  private rot = 0;
  private lastLabelSeq = -1;
  private streamTimer: number | null = null;
  private activity = '';
  private visible = false;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private latest: CursorFrame | null = null;
  private pos: Point = { x: -1000, y: -1000 };
  private parkedAt: Point | null = null;
  private tutorColor: string;
  private trailPts: { p: Point; t: number }[] = [];
  private mode: 'frames' | 'segment' | 'parked' = 'frames';

  constructor(
    root: HTMLElement,
    color: string,
    private readonly itemFor: (id: string) => InkItem | undefined,
  ) {
    this.tutorColor = color;
    this.el = document.createElement('div');
    this.el.className = 'buddy hidden';
    this.el.innerHTML = `
      <div class="buddy-shape">
        <svg class="buddy-tri" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
          <defs>
            <linearGradient id="buddy-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="var(--buddy-hi)"/>
              <stop offset="0.55" stop-color="var(--buddy)"/>
              <stop offset="1" stop-color="var(--buddy-lo)"/>
            </linearGradient>
            <linearGradient id="buddy-sheen" x1="0" y1="0" x2="0.6" y2="0.6">
              <stop offset="0" stop-color="#fff" stop-opacity="0.55"/>
              <stop offset="1" stop-color="#fff" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <path class="buddy-body" d="M3.2 3.2 L21.6 10.6 Q23.2 11.3 21.6 12.1 L14.2 15 Q13.5 15.3 13.2 16 L10.4 22.9 Q9.7 24.4 9.1 22.8 Z" fill="url(#buddy-grad)" stroke="rgba(255,255,255,0.96)" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="M5.4 5.4 L17.4 10.3 L12.2 12.4 L10.4 17.1 Z" fill="url(#buddy-sheen)"/>
        </svg>
        <span class="buddy-wave">${'<span></span>'.repeat(5)}</span>
        <span class="buddy-spin"></span>
      </div>
      <div class="buddy-label"><span class="buddy-label-text"></span><span class="buddy-label-wave">${'<span></span>'.repeat(4)}</span></div>`;
    root.appendChild(this.el);
    this.shape = this.el.querySelector('.buddy-shape') as HTMLDivElement;
    this.label = this.el.querySelector('.buddy-label') as HTMLDivElement;
    this.labelText = this.el.querySelector('.buddy-label-text') as HTMLSpanElement;
    this.waveBars = [...this.el.querySelectorAll<HTMLSpanElement>('.buddy-wave span'), ...this.el.querySelectorAll<HTMLSpanElement>('.buddy-label-wave span')];
    this.applyColor(color);
  }

  setBounds(b: Rect): void {
    this.bounds = b;
  }

  /** The tutor's ink color (amber is used automatically while driving). */
  setColor(color: string): void {
    this.tutorColor = color;
    this.applyColor(this.activity === 'driving' ? '#FFB224' : color);
  }

  private applyColor(color: string): void {
    this.el.style.setProperty('--buddy', color);
    this.el.style.setProperty('--buddy-hi', mix(color, '#ffffff', 0.5));
    this.el.style.setProperty('--buddy-lo', mix(color, '#000000', 0.22));
    this.el.style.setProperty('--buddy-glow', hexA(color, 0.8));
    this.el.style.setProperty('--buddy-glow-soft', hexA(color, 0.35));
  }

  pushFrame(f: CursorFrame): void {
    this.latest = f;
    this.frames.push(f);
    if (this.frames.length > 8) this.frames.shift();
    this.applyState(f);
  }

  startFlight(f: CursorFlight): void {
    // Start from where this overlay really drew the cursor (avoids a hop after a trace whose end
    // main could only approximate, e.g. handwriting width).
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

  /** Recent tip positions during a flight (the comet trail drawn on the ink canvas). */
  trail(now: number): { p: Point; a: number }[] {
    this.trailPts = this.trailPts.filter((q) => now - q.t < TRAIL_MS);
    return this.trailPts.map((q) => ({ p: q.p, a: 1 - (now - q.t) / TRAIL_MS }));
  }

  get animating(): boolean {
    return this.segs.length > 0 || this.trailPts.length > 0;
  }

  private positionAtTime(t: number): Point {
    let p = this.parkedAt ?? this.pos;
    for (const s of this.segs) {
      if (t < s.startAt) return s.kind === 'flight' ? s.f.from : this.tracePoint(s.t, s.startAt) ?? p;
      p = s.kind === 'flight' ? flightAt(s.f, Math.min(t, s.endAt)).p : (this.tracePoint(s.t, Math.min(t, s.endAt)) ?? s.t.end);
    }
    return p;
  }

  private tracePoint(t: CursorTrace, now: number): Point | null {
    const item = this.itemFor(t.itemId);
    const raw = Math.min(1, Math.max(0, (now - t.startAt) / Math.max(1, t.duration)));
    if (!item) return t.end;
    return inkPenPoint(item, easeInOut(raw));
  }

  /** Called every animation frame. */
  update(now: number): void {
    const f = this.latest;
    if (!f || !f.visible) {
      this.setVisible(false);
      return;
    }
    let pos: Point;
    let scale = 1;
    let glowBoost = 0;
    let targetRot = 0;
    let flying = false;
    let tracing = false;

    // Drop finished segments, remembering where the last one ended.
    while (this.segs.length && now > this.segs[0].endAt + 16) {
      const s = this.segs.shift()!;
      this.parkedAt = s.kind === 'flight' ? s.f.to : (this.tracePoint(s.t, s.endAt) ?? s.t.end);
      this.lastSegEnd = s.endAt;
      this.mode = 'parked';
    }
    const active = this.segs.find((s) => now >= s.startAt && now <= s.endAt + 16);
    if (active?.kind === 'flight') {
      const fp = flightAt(active.f, now);
      pos = fp.p;
      const pulse = Math.sin(fp.lin * Math.PI);
      scale = 1 + pulse * 0.3;
      glowBoost = pulse;
      targetRot = fp.lin < 0.96 ? fp.heading - BASE_ANGLE : 0;
      flying = true;
      this.mode = 'segment';
    } else if (active?.kind === 'trace') {
      pos = this.tracePoint(active.t, now) ?? active.t.end;
      tracing = true;
      glowBoost = 0.35;
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
    this.el.classList.toggle('flying', flying);
    this.el.classList.toggle('tracing', tracing);

    if (flying) this.trailPts.push({ p: pos, t: now });

    // Ease rotation (shortest path) so landing straightens smoothly.
    const goal = shortestAngle(this.rot, targetRot);
    this.rot += (goal - this.rot) * (flying ? 0.45 : 0.2);
    this.pos = pos;

    const lx = pos.x - this.bounds.x;
    const ly = pos.y - this.bounds.y;
    const margin = 140;
    const onThis = lx > -margin && ly > -margin && lx < this.bounds.width + margin && ly < this.bounds.height + margin;
    this.setVisible(onThis);
    if (!onThis) return;
    this.el.style.transform = `translate3d(${(lx - TIP.x).toFixed(2)}px, ${(ly - TIP.y).toFixed(2)}px, 0)`;
    this.shape.style.transform = `rotate(${this.rot.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
    this.shape.style.setProperty('--glow-boost', glowBoost.toFixed(3));

    // Waveform bars follow the audio level (listening: mic, speaking: tutor voice).
    const level = f.level;
    for (let i = 0; i < this.waveBars.length; i++) {
      const phase = now / 140 + i * 0.9;
      const profile = [0.45, 0.75, 1, 0.75, 0.45][i % 5];
      const idle = 0.24 + 0.1 * Math.sin(phase);
      const v = Math.min(1, idle + level * profile * (0.85 + 0.35 * Math.sin(phase * 1.7)));
      this.waveBars[i].style.transform = `scaleY(${v.toFixed(3)})`;
    }
  }

  private lastSegEnd: number | null = null;

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

  private applyState(f: CursorFrame): void {
    if (f.activity !== this.activity) {
      this.el.classList.remove(`act-${this.activity}`);
      this.activity = f.activity;
      this.el.classList.add(`act-${f.activity}`);
      this.applyColor(f.activity === 'driving' ? '#FFB224' : this.tutorColor);
    }
    this.label.classList.toggle('pointing', f.labelKind === 'pointing');
    this.label.classList.toggle('speaking', f.activity === 'speaking');
    if (f.labelSeq !== this.lastLabelSeq) {
      this.lastLabelSeq = f.labelSeq;
      this.streamLabel(f.label, f.labelKind !== 'name');
    }
  }

  /** Characters stream in with a little pop, like someone saying it (Clicky: 30–60 ms each). */
  private streamLabel(text: string, animate: boolean): void {
    if (this.streamTimer) window.clearTimeout(this.streamTimer);
    if (!animate) {
      this.labelText.textContent = text;
      this.label.classList.remove('pop');
      return;
    }
    this.labelText.textContent = '';
    this.label.classList.remove('pop');
    void this.label.offsetWidth;
    this.label.classList.add('pop');
    let i = 0;
    const step = () => {
      i += 1;
      this.labelText.textContent = text.slice(0, i);
      if (i < text.length) this.streamTimer = window.setTimeout(step, 30 + Math.random() * 30);
    };
    step();
  }
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const pb = parseInt(b.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const ch = (s: number) => [(s >> 16) & 255, (s >> 8) & 255, s & 255];
  const [r1, g1, b1] = ch(pa);
  const [r2, g2, b2] = ch(pb);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${m(r1, r2)}, ${m(g1, g2)}, ${m(b1, b2)})`;
}
