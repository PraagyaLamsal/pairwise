import { EventEmitter } from 'node:events';
import { clampPointInside, displayForPoint, distance, type Point } from '@shared/geometry';
import type { CursorActivity, CursorCancel, CursorFlight, CursorFrame, CursorPresence, CursorTrace, InkItem } from '@shared/ink';
import { flightPoint, glidePoint, inkPenPoint, penStateAt } from '@shared/ink-geometry';
import type { DisplayService, InputHooks } from '../platform/types';

/**
 * Where the cursor first appears, relative to the student's pointer (DIP): close enough to read
 * as "Ada joined", far enough not to sit on what they're about to click.
 */
export const ARRIVE_OFFSET = { x: 44, y: 34 };
/** After this long without moving (and no label to show), the cursor dims. */
export const IDLE_AFTER_MS = 1200;
/** The student's pointer this close to the cursor fades it further (enter / leave, DIP). */
export const NEAR_PX = 60;
const NEAR_LEAVE_PX = 84;
/** How long the name label shows when the session starts (Tuple shows names on join). */
const JOIN_LABEL_MS = 2600;
const TICK_MS = 1000 / 60;
const SEND_EVERY_MS = 1000 / 60;

export type CursorMode = 'hidden' | 'parked' | 'timeline' | 'driving';

/**
 * A cursor flight: a gently curved path (a hand moving a mouse rarely goes dead straight), eased
 * with a minimum-jerk profile (see flightPoint). Long moves take longer, within limits.
 */
export function planFlight(from: Point, to: Point, startAt: number, label?: string, maxMs = 1200): CursorFlight {
  const d = distance(from, to);
  const duration = Math.round(Math.min(Math.max(d / 900, d < 60 ? 0.24 : 0.44), maxMs / 1000) * 1000);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const arc = Math.min(d * 0.1, 46);
  // Curve "upward" relative to the direction of travel (perpendicular, biased to screen-up).
  const nx = -(to.y - from.y) / (d || 1);
  const ny = (to.x - from.x) / (d || 1);
  const sign = ny > 0 ? -1 : 1;
  const ctrl = { x: mid.x + nx * arc * sign, y: mid.y + ny * arc * sign };
  return { from, ctrl, to, startAt, duration, label };
}

export { flightPoint };

type Segment =
  | { kind: 'flight'; startAt: number; endAt: number; flight: CursorFlight }
  | { kind: 'trace'; startAt: number; endAt: number; trace: CursorTrace; item?: InkItem }
  | { kind: 'hold'; startAt: number; endAt: number; at: Point };

/** One scheduled move for `schedule()`. Times are filled in by the engine. */
export type CursorStep =
  | { kind: 'fly'; to: Point; label?: string; maxMs?: number }
  | { kind: 'trace'; item: InkItem }
  /** A pointer-only gesture: the cursor glides along `path` (no ink), see glidePoint(). */
  | { kind: 'glide'; path: Point[]; ms: number; style: NonNullable<CursorTrace['style']> }
  | { kind: 'hold'; ms: number };

/**
 * The tutor's cursor. It stays where she leaves it, like a person's cursor on a pairing call:
 * it never follows the student's pointer and never flies "home". When it isn't moving it dims
 * (and dims further when the student's pointer comes close) so it never sits on top of their
 * work; it comes back to full strength the moment it moves.
 *
 * Physics runs here (one source of truth for every display); flights, traces and gestures are
 * scheduled on the shared wall clock and animated by the overlays themselves, so motion stays
 * smooth and in sync on every monitor. Frames (position, presence, label, the student's
 * pointer) go out whenever something changes, at most 60 Hz.
 *
 * Emits: 'frame' (CursorFrame) · 'flight' (CursorFlight) · 'trace' (CursorTrace) ·
 *        'cancel' (CursorCancel) · 'landed' (Point) · 'idle' (timeline finished)
 */
export class CursorEngine extends EventEmitter {
  private mode: CursorMode = 'hidden';
  private pos: Point = { x: 0, y: 0 };
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
  /** Until when the cursor counts as active after landing (its label is on show). */
  private activeUntil = 0;
  private holdAfterMs = 0;
  private near = false;
  private presenceNow: CursorPresence = 'active';
  private pendingLabel: string | null = null;
  /** While the tutor is talking, a pointing label stays up (she may still be referring to it). */
  holdWhile: () => boolean = () => false;

  constructor(
    private readonly displays: DisplayService,
    private readonly hooks: InputHooks,
    private readonly opts: { name: () => string },
  ) {
    super();
  }

  get position(): Point {
    return { ...this.pos };
  }

  get currentMode(): CursorMode {
    return this.mode;
  }

  /** active (moving or showing a label) · idle (dimmed) · near (the student's pointer is close). */
  get presence(): CursorPresence {
    return this.presenceNow;
  }

  /** When the scheduled timeline (flights + traces) ends; 0 if nothing is scheduled. */
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

  /** Appear beside the student's pointer, say hello with the name label, then stay there. */
  start(): void {
    this.mouse = this.displays.cursor();
    this.pos = this.arrivalPoint(this.mouse);
    this.segments = [];
    this.mode = 'parked';
    this.rot = -35;
    this.near = false;
    this.setLabel(this.opts.name(), 'name');
    this.activeUntil = Date.now() + JOIN_LABEL_MS;
    this.presenceNow = 'active';
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
    if (label !== undefined) {
      this.setLabel(label, 'status');
      // A status ("reading…") is worth seeing: show it where the cursor is.
      this.activeUntil = Math.max(this.activeUntil, Date.now() + IDLE_AFTER_MS);
    } else if (this.mode !== 'timeline' && this.labelKind === 'status') this.setLabel('', 'name');
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

  /** End a hold early (a guided step was done): dim after the usual short pause. */
  relax(): void {
    if (this.mode !== 'parked') return;
    this.activeUntil = Math.min(this.activeUntil, Date.now() + IDLE_AFTER_MS);
    this.holdAfterMs = 0;
    if (this.labelKind === 'pointing') this.setLabel('', 'name');
  }

  /**
   * Schedule a choreography: fly → trace an ink item → glide → … Starts at `startAt` (or when the
   * current timeline ends, whichever is later). After the last step the cursor stays where it
   * is; `finalLabel` shows there for `holdAfterMs` (longer while the tutor keeps talking).
   * Returns the absolute times of each step.
   */
  schedule(steps: CursorStep[], startAt = Date.now(), finalLabel?: string, holdAfterMs = 2600): { startAt: number; endAt: number }[] {
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
      } else if (step.kind === 'glide') {
        if (step.path.length < 2) continue;
        const end = step.path[step.path.length - 1];
        const trace: CursorTrace = { path: step.path.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })), style: step.style, startAt: t, duration: Math.max(1, Math.round(step.ms)), end };
        const seg: Segment = { kind: 'trace', startAt: t, endAt: t + trace.duration, trace };
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
    this.pendingLabel = finalLabel ?? null;
    this.holdAfterMs = finalLabel ? holdAfterMs : 0;
    // Labels show where they mean something (a pointing label on landing); never while moving.
    if (this.labelKind !== 'name' || this.label) this.setLabel('', 'name');
    this.presenceNow = 'active';
    this.send(true);
    return times;
  }

  /** Swoop to a global point now (or after what's scheduled). Resolves when the cursor lands. */
  flyTo(target: Point, label?: string, opts: { holdMs?: number } = {}): Promise<void> {
    if (this.mode === 'hidden' || this.mode === 'driving') return Promise.resolve();
    const [t] = this.schedule([{ kind: 'fly', to: target, label }], Date.now(), label, opts.holdMs ?? 2600);
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, t.endAt - Date.now()) + 10));
  }

  /** Nudge to a refined target (grounding finished after the cursor started moving). */
  settle(target: Point, label?: string): void {
    if (this.mode === 'hidden' || this.mode === 'driving') return;
    const now = Date.now();
    const last = this.segments[this.segments.length - 1];
    if (last && last.kind === 'flight' && last.endAt > now) {
      // Re-aim the flight in progress: start a short flight from where it is now.
      this.cancelFuture(now);
    }
    const from = this.positionAt(now);
    if (distance(from, target) < 2) return;
    this.schedule([{ kind: 'fly', to: target, label, maxMs: 420 }], now, label ?? this.pendingLabel ?? undefined);
  }

  /** Drop everything scheduled after `now` (interruption). Ink the overlays already drew stays. */
  cancelFuture(now = Date.now()): void {
    if (!this.segments.length) return;
    const p = this.positionAt(now);
    this.segments = [];
    this.pos = p;
    const msg: CursorCancel = { at: now, pos: p };
    this.emit('cancel', msg);
    if (this.mode === 'timeline') this.land(now, false);
    this.send(true);
  }

  /** Takeover: the cursor rides the real pointer; afterwards it stays where it last drove to. */
  setDriving(on: boolean, parkAt?: Point): void {
    if (on) {
      this.cancelFuture(Date.now());
      this.mode = 'driving';
      this.activity = 'driving';
      this.setLabel(`${this.opts.name()} is driving`, 'status');
    } else if (this.mode === 'driving') {
      this.mode = 'parked';
      this.activity = 'idle';
      if (parkAt) this.pos = { ...parkAt };
      this.setLabel('', 'name');
      this.activeUntil = Date.now() + IDLE_AFTER_MS;
    }
    this.send(true);
  }

  private arrivalPoint(mouse: Point): Point {
    const display = displayForPoint(this.displays.list(), mouse) ?? this.displays.list()[0];
    const p = { x: mouse.x + ARRIVE_OFFSET.x, y: mouse.y + ARRIVE_OFFSET.y };
    if (!display) return p;
    // Keep the whole cursor (and its label) on screen: flip to the other side near an edge.
    const b = display.bounds;
    if (p.x > b.x + b.width - 90) p.x = mouse.x - ARRIVE_OFFSET.x - 20;
    if (p.y > b.y + b.height - 50) p.y = mouse.y - ARRIVE_OFFSET.y - 20;
    return clampPointInside(p, { x: b.x + 4, y: b.y + 4, width: b.width - 8, height: b.height - 8 });
  }

  private segStart(s: Segment, fallback: Point): Point {
    if (s.kind === 'flight') return s.flight.from;
    if (s.kind === 'hold') return s.at;
    if (s.trace.path) return s.trace.path[0];
    return (s.item && inkPenPoint(s.item, 0)) ?? fallback;
  }

  private segPoint(s: Segment, t: number): Point {
    if (s.kind === 'flight') return flightPoint(s.flight, t).p;
    if (s.kind === 'hold') return s.at;
    const ms = Math.min(s.endAt, Math.max(s.startAt, t)) - s.startAt;
    if (s.trace.path) return glidePoint(s.trace.path, ms / Math.max(1, s.endAt - s.startAt), s.trace.style ?? 'glide');
    return (s.item && penStateAt(s.item, ms).pen) ?? s.trace.end;
  }

  /** The timeline ran out (or was cut short): stay right here. */
  private land(now: number, finished: boolean): void {
    this.segments = [];
    this.mode = 'parked';
    if (this.pendingLabel) this.setLabel(this.pendingLabel, 'pointing');
    else if (this.label) this.setLabel('', 'name');
    this.pendingLabel = null;
    this.activeUntil = now + Math.max(IDLE_AFTER_MS, this.holdAfterMs);
    if (finished) {
      this.emit('landed', this.pos);
      this.emit('idle');
    }
  }

  private computePresence(now: number): CursorPresence {
    if (this.mode === 'driving' || this.mode === 'timeline') return 'active';
    // The student's pointer next to the cursor: get out of the way (with a little hysteresis).
    const centre = { x: this.pos.x + 9, y: this.pos.y + 11 };
    const d = distance(this.mouse, centre);
    this.near = this.near ? d < NEAR_LEAVE_PX : d < NEAR_PX;
    if (this.near) return 'near';
    if (now < this.activeUntil) return 'active';
    // Still talking about what it points at: keep the label up a little longer.
    if (this.labelKind === 'pointing' && this.holdAfterMs > 0 && this.holdWhile()) {
      this.activeUntil = now + IDLE_AFTER_MS;
      return 'active';
    }
    return 'idle';
  }

  private tick(): void {
    const now = Date.now();
    // Polling the pointer is cheap and works the same with or without global input hooks.
    this.mouse = this.displays.cursor();

    if (this.mode === 'driving') {
      this.pos = { x: this.mouse.x, y: this.mouse.y };
      this.rot = -35;
    } else if (this.mode === 'timeline') {
      const last = this.segments[this.segments.length - 1];
      this.pos = this.positionAt(now);
      if (!last || now >= last.endAt) {
        this.land(now, true);
        this.presenceNow = this.computePresence(now);
        this.send(true);
        return;
      }
    }
    const presence = this.computePresence(now);
    if (presence !== this.presenceNow) {
      this.presenceNow = presence;
      // The label goes with the dim (the name only shows when she joins or drives).
      if (presence !== 'active' && this.label && this.labelKind !== 'status') this.setLabel('', 'name');
      this.send(true);
      return;
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
      glow: 0,
      visible: this.mode !== 'hidden',
      activity: this.activity,
      label: this.label,
      labelKind: this.labelKind,
      labelSeq: this.labelSeq,
      level: Math.round(this.level * 100) / 100,
      presence: this.presenceNow,
      mouse: { x: Math.round(this.mouse.x), y: Math.round(this.mouse.y) },
      t: Date.now(),
    };
  }

  private send(force: boolean): void {
    const f = this.frame();
    // The student's pointer only matters to the overlays at a couple of pixels' precision.
    const key = `${f.pos.x},${f.pos.y},${f.activity},${f.labelSeq},${f.visible},${this.mode},${f.level},${f.presence},${f.mouse.x >> 1},${f.mouse.y >> 1}`;
    if (!force && key === this.lastFrameKey) return;
    this.lastFrameKey = key;
    this.lastSent = Date.now();
    this.emit('frame', f);
  }
}
