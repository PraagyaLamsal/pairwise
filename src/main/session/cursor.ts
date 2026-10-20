import { EventEmitter } from 'node:events';
import { clampPointInside, displayForPoint, distance, type Point } from '@shared/geometry';
import type { CursorActivity, CursorCancel, CursorFlight, CursorFrame, CursorTrace, InkItem } from '@shared/ink';
import { easeInOut, inkPenPoint } from '@shared/ink-geometry';
import type { DisplayService, InputHooks } from '../platform/types';

/**
 * Where the buddy sits relative to the student's pointer while following (DIP). Clicky (MIT)
 * uses (+35, +25): close enough to feel attached, far enough not to cover what you click.
 */
export const FOLLOW_OFFSET = { x: 30, y: 24 };
const TICK_MS = 1000 / 120;
const SEND_EVERY_MS = 1000 / 60;
/** Spring tuned like a lively UI spring: response ≈0.22 s, damping ratio ≈0.62. */
const OMEGA = (2 * Math.PI) / 0.22;
const ZETA = 0.62;

export type CursorMode = 'hidden' | 'follow' | 'timeline' | 'parked' | 'driving';

/** Quadratic-bezier flight like a swooping pointer: arc height ∝ distance, smoothstep easing. */
export function planFlight(from: Point, to: Point, startAt: number, label?: string, maxMs = 1200): CursorFlight {
  const d = distance(from, to);
  const duration = Math.round(Math.min(Math.max(d / 900, d < 60 ? 0.22 : 0.42), maxMs / 1000) * 1000);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const arc = Math.min(d * 0.2, 90);
  // Arc "upward" relative to travel direction (perpendicular, biased to screen-up).
  const nx = -(to.y - from.y) / (d || 1);
  const ny = (to.x - from.x) / (d || 1);
  const sign = ny > 0 ? -1 : 1;
  const ctrl = { x: mid.x + nx * arc * sign, y: mid.y + ny * arc * sign };
  return { from, ctrl, to, startAt, duration, label };
}

export function flightPoint(f: CursorFlight, now: number): { p: Point; t: number; rot: number; done: boolean } {
  const lin = Math.min(1, Math.max(0, (now - f.startAt) / f.duration));
  const t = lin * lin * (3 - 2 * lin);
  const u = 1 - t;
  const p = {
    x: u * u * f.from.x + 2 * u * t * f.ctrl.x + t * t * f.to.x,
    y: u * u * f.from.y + 2 * u * t * f.ctrl.y + t * t * f.to.y,
  };
  const tx = 2 * u * (f.ctrl.x - f.from.x) + 2 * t * (f.to.x - f.ctrl.x);
  const ty = 2 * u * (f.ctrl.y - f.from.y) + 2 * t * (f.to.y - f.ctrl.y);
  const rot = (Math.atan2(ty, tx) * 180) / Math.PI + 90;
  return { p, t: lin, rot, done: lin >= 1 };
}

type Segment =
  | { kind: 'flight'; startAt: number; endAt: number; flight: CursorFlight }
  | { kind: 'trace'; startAt: number; endAt: number; trace: CursorTrace; item: InkItem }
  | { kind: 'hold'; startAt: number; endAt: number; at: Point };

/** One scheduled move for `schedule()`. Times are filled in by the engine. */
export type CursorStep =
  | { kind: 'fly'; to: Point; label?: string; maxMs?: number }
  | { kind: 'trace'; item: InkItem }
  | { kind: 'hold'; ms: number };

/**
 * The tutor's cursor. Physics runs here (one source of truth for every display) and frames are
 * broadcast at 60 Hz while following; flights and traces are scheduled on the shared wall clock
 * and animated by the overlays themselves, so motion stays smooth and in sync on every monitor.
 *
 * Emits: 'frame' (CursorFrame) · 'flight' (CursorFlight) · 'trace' (CursorTrace) ·
 *        'cancel' (CursorCancel) · 'landed' (Point) · 'idle' (timeline finished)
 */
export class CursorEngine extends EventEmitter {
  private mode: CursorMode = 'hidden';
  private pos: Point = { x: 0, y: 0 };
  private vel: Point = { x: 0, y: 0 };
  private rot = -35;
  private mouse: Point = { x: 0, y: 0 };
  private segments: Segment[] = [];
  private activity: CursorActivity = 'idle';
  private label = '';
  private labelKind: CursorFrame['labelKind'] = 'name';
  private labelSeq = 0;
  private level = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastSent = 0;
  private lastFrameKey = '';
  private parkedSince = 0;
  private returnAfterMs: number | null = null;
  private mouseAtPark: Point = { x: 0, y: 0 };
  private pendingLabel: string | null = null;
  /** While the tutor is talking, parking doesn't time out (it may still refer to the spot). */
  holdWhile: () => boolean = () => false;

  constructor(
    private readonly displays: DisplayService,
    private readonly hooks: InputHooks,
    private readonly opts: { name: () => string; behavior: () => 'follow' | 'stay' },
  ) {
    super();
  }

  get position(): Point {
    return { ...this.pos };
  }

  get currentMode(): CursorMode {
    return this.mode;
  }

  /** When the scheduled timeline (flights + traces) ends; now if nothing is scheduled. */
  get busyUntil(): number {
    const last = this.segments[this.segments.length - 1];
    return last ? last.endAt : 0;
  }

  /** Position the cursor will have at time `t` given what is scheduled. */
  positionAt(t: number): Point {
    if (!this.segments.length) return { ...this.pos };
    let p = this.pos;
    for (const s of this.segments) {
      if (t < s.startAt) return this.segStart(s, p);
      p = this.segPoint(s, Math.min(t, s.endAt));
    }
    return p;
  }

  start(): void {
    this.mouse = this.displays.cursor();
    this.pos = { x: this.mouse.x + FOLLOW_OFFSET.x, y: this.mouse.y + FOLLOW_OFFSET.y };
    this.vel = { x: 0, y: 0 };
    this.segments = [];
    this.mode = 'follow';
    this.label = this.opts.name();
    this.labelKind = 'name';
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    this.send(true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.segments = [];
    this.mode = 'hidden';
    this.send(true);
  }

  setActivity(activity: CursorActivity, label?: string): void {
    if (activity === this.activity && label === undefined) return;
    this.activity = activity;
    if (label !== undefined) this.setLabel(label, 'status');
    else if (this.mode !== 'parked' && this.mode !== 'timeline' && this.labelKind !== 'name') this.setLabel(this.opts.name(), 'name');
    this.send(true);
  }

  setLevel(level: number): void {
    this.level = level;
  }

  setLabel(label: string, kind: CursorFrame['labelKind']): void {
    if (label === this.label && kind === this.labelKind) return;
    this.label = label;
    this.labelKind = kind;
    this.labelSeq += 1;
  }

  /**
   * Schedule a choreography: fly → trace an ink item → fly → … Starts at `startAt` (or when the
   * current timeline ends, whichever is later). Returns the absolute times of each step.
   */
  schedule(steps: CursorStep[], startAt = Date.now(), finalLabel?: string, holdAfterMs = 3200): { startAt: number; endAt: number }[] {
    if (this.mode === 'hidden' || this.mode === 'driving') return steps.map(() => ({ startAt, endAt: startAt }));
    const now = Date.now();
    let t = Math.max(startAt, now, this.busyUntil);
    let from = this.positionAt(t);
    const times: { startAt: number; endAt: number }[] = [];
    for (const step of steps) {
      if (step.kind === 'fly') {
        const display = displayForPoint(this.displays.list(), step.to);
        const to = display ? clampPointInside(step.to, display.bounds) : step.to;
        const flight = planFlight(from, to, t, step.label, step.maxMs);
        const seg: Segment = { kind: 'flight', startAt: t, endAt: t + flight.duration, flight };
        this.segments.push(seg);
        this.emit('flight', flight);
        times.push({ startAt: seg.startAt, endAt: seg.endAt });
        t = seg.endAt;
        from = to;
      } else if (step.kind === 'trace') {
        const duration = step.item.drawMs;
        const end = inkPenPoint(step.item, 1) ?? from;
        const trace: CursorTrace = { itemId: step.item.id, startAt: t, duration, end };
        const seg: Segment = { kind: 'trace', startAt: t, endAt: t + duration, trace, item: step.item };
        this.segments.push(seg);
        this.emit('trace', trace);
        times.push({ startAt: seg.startAt, endAt: seg.endAt });
        t = seg.endAt;
        from = end;
      } else {
        const seg: Segment = { kind: 'hold', startAt: t, endAt: t + step.ms, at: from };
        this.segments.push(seg);
        times.push({ startAt: seg.startAt, endAt: seg.endAt });
        t = seg.endAt;
      }
    }
    this.mode = 'timeline';
    // A new choreography replaces a flight home that was under way: land and park, don't follow.
    this.returning = false;
    this.pendingLabel = finalLabel ?? null;
    this.returnAfterMs = holdAfterMs;
    if (finalLabel === undefined && this.labelKind !== 'name') this.setLabel(this.opts.name(), 'name');
    this.send(true);
    return times;
  }

  /** Swoop to a global point now (or after what's scheduled). Resolves when the cursor lands. */
  flyTo(target: Point, label?: string, opts: { holdMs?: number } = {}): Promise<void> {
    if (this.mode === 'hidden' || this.mode === 'driving') return Promise.resolve();
    const [t] = this.schedule([{ kind: 'fly', to: target, label }], Date.now(), label, opts.holdMs ?? 3200);
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, t.endAt - Date.now()) + 10));
  }

  /** Nudge to a refined target (grounding finished after the cursor started moving). */
  settle(target: Point, label?: string): void {
    if (this.mode === 'hidden' || this.mode === 'driving') return;
    const now = Date.now();
    const last = this.segments[this.segments.length - 1];
    if (last && last.kind === 'flight' && last.endAt > now) {
      // Re-aim the flight in progress: start a short flight from where it is now.
      this.cancelFuture(now, false);
    }
    const from = this.positionAt(now);
    if (distance(from, target) < 2) return;
    this.schedule([{ kind: 'fly', to: target, label, maxMs: 420 }], now, label ?? this.pendingLabel ?? undefined);
  }

  /** Drop everything scheduled after `now` (interruption). Ink the overlays already drew stays. */
  cancelFuture(now = Date.now(), returnHome = true): void {
    if (!this.segments.length) return;
    const p = this.positionAt(now);
    this.segments = [];
    this.pos = p;
    const msg: CursorCancel = { at: now, pos: p };
    this.emit('cancel', msg);
    this.returning = false;
    if (this.mode === 'timeline') {
      this.mode = 'parked';
      this.parkedSince = now;
      this.mouseAtPark = { ...this.mouse };
    }
    if (returnHome) this.returnAfterMs = 600;
    this.send(true);
  }

  /** Fly back to the student's pointer and resume following. */
  returnToStudent(): void {
    if (this.mode === 'hidden' || this.mode === 'follow' || this.mode === 'driving') return;
    if (this.opts.behavior() === 'stay') {
      this.setLabel(this.opts.name(), 'name');
      this.send(true);
      return;
    }
    this.segments = [];
    const target = { x: this.mouse.x + FOLLOW_OFFSET.x, y: this.mouse.y + FOLLOW_OFFSET.y };
    this.setLabel(this.opts.name(), 'name');
    const flight = planFlight(this.pos, target, Date.now());
    this.segments.push({ kind: 'flight', startAt: flight.startAt, endAt: flight.startAt + flight.duration, flight });
    this.emit('flight', flight);
    this.mode = 'timeline';
    this.pendingLabel = null;
    this.returnAfterMs = null;
    this.returning = true;
    this.send(true);
  }

  private returning = false;

  /** Takeover: the buddy rides on the real pointer. */
  setDriving(on: boolean): void {
    if (on) {
      this.cancelFuture(Date.now(), false);
      this.mode = 'driving';
      this.activity = 'driving';
      this.setLabel(`${this.opts.name()} is driving`, 'status');
    } else if (this.mode === 'driving') {
      this.mode = 'follow';
      this.activity = 'idle';
      this.setLabel(this.opts.name(), 'name');
    }
    this.send(true);
  }

  private segStart(s: Segment, fallback: Point): Point {
    if (s.kind === 'flight') return s.flight.from;
    if (s.kind === 'hold') return s.at;
    return inkPenPoint(s.item, 0) ?? fallback;
  }

  private segPoint(s: Segment, t: number): Point {
    if (s.kind === 'flight') return flightPoint(s.flight, t).p;
    if (s.kind === 'hold') return s.at;
    const raw = Math.min(1, Math.max(0, (t - s.startAt) / Math.max(1, s.endAt - s.startAt)));
    return inkPenPoint(s.item, easeInOut(raw)) ?? s.trace.end;
  }

  private tick(): void {
    const now = Date.now();
    // Polling the pointer is cheap and works the same with or without global input hooks.
    this.mouse = this.displays.cursor();
    const dt = TICK_MS / 1000;

    if (this.mode === 'follow' || this.mode === 'driving') {
      const target = this.mode === 'driving' ? { x: this.mouse.x, y: this.mouse.y } : { x: this.mouse.x + FOLLOW_OFFSET.x, y: this.mouse.y + FOLLOW_OFFSET.y };
      if (this.mode === 'driving') {
        this.pos = target;
        this.vel = { x: 0, y: 0 };
      } else {
        const ax = OMEGA * OMEGA * (target.x - this.pos.x) - 2 * ZETA * OMEGA * this.vel.x;
        const ay = OMEGA * OMEGA * (target.y - this.pos.y) - 2 * ZETA * OMEGA * this.vel.y;
        this.vel.x += ax * dt;
        this.vel.y += ay * dt;
        this.pos.x += this.vel.x * dt;
        this.pos.y += this.vel.y * dt;
      }
      this.rot = -35;
    } else if (this.mode === 'timeline') {
      const last = this.segments[this.segments.length - 1];
      this.pos = this.positionAt(now);
      if (!last || now >= last.endAt) {
        this.segments = [];
        if (this.returning) {
          this.returning = false;
          this.mode = 'follow';
          this.vel = { x: 0, y: 0 };
          this.emit('idle');
          this.send(true);
        } else {
          this.mode = 'parked';
          this.parkedSince = now;
          this.mouseAtPark = { ...this.mouse };
          if (this.pendingLabel) this.setLabel(this.pendingLabel, 'pointing');
          this.pendingLabel = null;
          this.emit('landed', this.pos);
          this.emit('idle');
          this.send(true);
        }
      }
      return; // overlays animate scheduled motion themselves
    } else if (this.mode === 'parked') {
      // Come back to the student: they moved the mouse a lot, or the hold time ran out.
      const moved = distance(this.mouse, this.mouseAtPark);
      const held = now - this.parkedSince;
      const hold = this.holdWhile();
      if (this.opts.behavior() === 'follow' && ((moved > 220 && held > 1200) || (!hold && this.returnAfterMs !== null && held > this.returnAfterMs))) {
        this.returnAfterMs = null;
        this.returnToStudent();
      }
    }

    if (now - this.lastSent >= SEND_EVERY_MS) this.send(false);
    // Keep-alive so overlays that (re)load mid-session always have a current frame.
    if (now - this.lastSent >= 1000) this.send(true);
  }

  /** Current frame, for overlays that just became ready. */
  currentFrame(): CursorFrame {
    return this.frame();
  }

  private frame(): CursorFrame {
    return {
      pos: { x: Math.round(this.pos.x * 10) / 10, y: Math.round(this.pos.y * 10) / 10 },
      rot: this.rot,
      scale: 1,
      glow: this.activity === 'speaking' ? 1 : 0.7,
      visible: this.mode !== 'hidden',
      activity: this.activity,
      label: this.label,
      labelKind: this.labelKind,
      labelSeq: this.labelSeq,
      level: Math.round(this.level * 100) / 100,
      t: Date.now(),
    };
  }

  private send(force: boolean): void {
    const f = this.frame();
    const key = `${f.pos.x},${f.pos.y},${f.activity},${f.labelSeq},${f.visible},${this.mode},${f.level}`;
    if (!force && key === this.lastFrameKey) return;
    this.lastFrameKey = key;
    this.lastSent = Date.now();
    this.emit('frame', f);
  }
}
