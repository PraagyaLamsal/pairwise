import { box2dToGlobal, cropAround, inflateRect, rectCenter, yxToGlobal, type Box2D, type DisplayInfo, type Point, type Rect } from '@shared/geometry';
import { inkId, type InkItem } from '@shared/ink';
import { inkPenPoint } from '@shared/ink-geometry';
import type { EncodedFrame } from '@shared/ipc';
import type { TutorSession } from '../tutor';
import { buildInk, noteFont, pointTip, type MarkSpec } from '../marks';
import { BeatSync } from '../beat-sync';
import { GeminiBackend, Grounder, OcrBackend, type FrameSource, type GroundTarget, type GroundingBackend } from '../../vision/grounder';
import { ScreenReader } from '../../vision/reader';
import { decodeFrame, resizeFrame } from '../../vision/decode';
import { namesControl } from '../../vision/snap';
import { ExplanationPlanner, type PlannedBeat, type PlannedMark } from '../../vision/planner';
import type { CursorStep } from '../cursor';
import { env } from '../../env';
import { logger } from '../../log';

const log = logger('visual');

/** Lead so the pen touches down just as the words are heard. */
const SPEECH_LEAD_MS = 180;
const RING_MS = 2600;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

type MarkKind = MarkSpec['kind'];
const DRAWABLE = new Set<MarkKind>(['circle', 'underline', 'highlight', 'box', 'bracket', 'arrow', 'text', 'step', 'check', 'cross']);

/**
 * Phase 3: the tutor's cursor and pen. Grounds what the tutor talks about on a full-resolution
 * capture, then choreographs the cursor (swoop → trace each mark) so the ink appears exactly
 * when the matching words are heard. Also: screen reading, beat-planned explanations, clearing,
 * celebrations, the ink preview and the on-device pointing-accuracy test.
 */
export class VisualFeature {
  readonly grounder: Grounder;
  readonly reader: ScreenReader;
  readonly planner: ExplanationPlanner;
  private syncs: BeatSync[] = [];
  /** Tutor ink by the turn it belongs to (faded a while after that turn's speech ends). */
  private turnInk = new Map<string, string[]>();
  /** Copies of each recent turn's marks and when its speech started (to replay them together). */
  private replayable = new Map<string, InkItem[]>();
  private turnHeard = new Map<string, number>();
  private lastMark: Point | null = null;
  private seq = 0;

  constructor(private readonly s: TutorSession) {
    const frames: FrameSource = {
      capture: async (displayId, opts) => {
        const r = await s.deps.engine.request({
          type: 'captureNow',
          requestId: s.deps.engine.nextRequestId('g'),
          displayId,
          maxWidth: opts.maxWidth,
          quality: 0.88,
          kind: 'crop',
          crop: opts.crop,
        });
        return r.ok && r.frame ? r.frame : null;
      },
    };
    const gemini = new GeminiBackend(s.rest, () => s.settings.models.vision);
    const ocr = new OcrBackend(resizeFrame);
    const backend = (): GroundingBackend | null => {
      if (process.env.PAIRWISE_GROUNDER === 'ocr') return ocr;
      if (s.demoMode()) return process.env.PAIRWISE_GROUNDER === 'gemini' ? gemini : null;
      return gemini;
    };
    this.grounder = new Grounder(backend, frames, decodeFrame, () => {
      // The cursor's name/label bubble (below-right of the tip, not the tip itself, which may
      // sit on the very thing being grounded) and the overlays' cards, pills and toasts. The
      // HUD's window is mostly transparent, so its bounds would hide real UI.
      const p = s.cursor.position;
      return [{ x: p.x + 10, y: p.y + 18, width: 230, height: 34 }, ...s.overlays.uiRects()];
    });
    this.reader = new ScreenReader(s.rest, frames, () => s.settings.models.vision, process.platform === 'linux' || process.env.PAIRWISE_GROUNDER === 'ocr');
    this.planner = new ExplanationPlanner(s.rest, () => s.settings.models.vision);
    this.frames = frames;

    s.cursor.holdWhile = () => s.playback.playing || Boolean(s.turn);
    s.on('tutorWords', (text: string, position: number) => this.onTutorWords(text, position));
    s.on('interrupted', () => this.cancelPending('interrupted'));
    s.on('flushed', () => this.cancelPending('flushed'));
    s.on('turnComplete', (turnId: string) => this.onTurnComplete(turnId));
    s.on('turnStart', (turnId: string, heardAt: number) => {
      this.turnHeard.set(turnId, heardAt);
      if (this.turnHeard.size > 6) this.turnHeard.delete(this.turnHeard.keys().next().value as string);
    });
    s.on('replay', (turnId: string) => this.replayTurn(turnId));
    s.on('ended', () => this.reset());
    this.registerTools();
  }

  private readonly frames: FrameSource;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** The display a tool call refers to: its 1-based `display` arg, else the one being watched. */
  displayFor(args: Record<string, unknown>): DisplayInfo {
    const list = this.s.deps.platform.displays.list();
    const n = num(args.display);
    return (n ? list.find((d) => d.index === n) : undefined) ?? list.find((d) => d.id === this.s.activeDisplayId) ?? this.s.activeDisplay();
  }

  /** The model's own 0–1000 guess, mapped through the frame it last saw (same display only). */
  approxPoint(args: Record<string, unknown>, display: DisplayInfo): { norm: { x: number; y: number }; global: Point } | null {
    const x = num(args.x);
    const y = num(args.y);
    const f = this.s.modelFrame;
    if (x === undefined || y === undefined || !f || f.displayId !== display.id) return null;
    const nx = Math.min(1000, Math.max(0, x));
    const ny = Math.min(1000, Math.max(0, y));
    return { norm: { x: nx, y: ny }, global: { x: f.region.x + (nx / 1000) * f.region.width, y: f.region.y + (ny / 1000) * f.region.height } };
  }

  /** Wall-clock time for something the tutor asked for at the current point of its speech. */
  speechTime(): number {
    return this.s.clock.timeFor(this.s.clock.position) - SPEECH_LEAD_MS;
  }

  private group(): string {
    return this.s.turn?.id ?? this.s.lastTurnId ?? 'session';
  }

  private style() {
    return { color: this.s.settings.tutorColor, author: 'tutor' as const, surface: 'screen' as const, group: this.group(), font: noteFont(this.s.settings.noteStyle) };
  }

  /**
   * Draw ink with the cursor as the pen: swoop to each mark's start, trace it, next. Ink reveal
   * times are the trace start times, so cursor and ink can never drift apart.
   */
  play(items: InkItem[], at: number, finalLabel?: string, holdAfterMs = 3400): void {
    if (!items.length) return;
    const now = Date.now();
    const steps: CursorStep[] = [];
    for (const it of items) {
      const start = inkPenPoint(it, 0);
      if (start) steps.push({ kind: 'fly', to: start, maxMs: 750 });
      steps.push({ kind: 'trace', item: it });
    }
    const times = this.s.cursor.schedule(steps, Math.max(now, at), finalLabel, holdAfterMs);
    let k = 0;
    for (const it of items) {
      const hasFly = Boolean(inkPenPoint(it, 0));
      const trace = times[k + (hasFly ? 1 : 0)];
      k += hasFly ? 2 : 1;
      it.revealAt = trace ? trace.startAt : Math.max(now, at);
    }
    // Cursor hidden or driving: ink still appears on time, without the pen.
    if (!times.length || times.every((t) => t.endAt === t.startAt)) {
      let t = Math.max(now, at);
      for (const it of items) {
        it.revealAt = t;
        t += it.drawMs + 120;
      }
    }
    const g = items[0].group ?? this.group();
    const list = this.turnInk.get(g) ?? [];
    list.push(...items.map((i) => i.id));
    this.turnInk.set(g, list);
    const last = items[items.length - 1];
    this.lastMark = inkPenPoint(last, 1) ?? this.lastMark;
    this.s.addInk(items);
    const keep = this.replayable.get(g) ?? [];
    keep.push(...items.map((i) => ({ ...i })));
    this.replayable.set(g, keep);
    if (this.replayable.size > 4) this.replayable.delete(this.replayable.keys().next().value as string);
  }

  /**
   * "Say that again": the engine replays the turn's audio from the start; redraw the turn's
   * marks with the same timing relative to the speech, and the pen does it again.
   */
  replayTurn(turnId: string): void {
    const marks = this.replayable.get(turnId);
    const heardAt = this.turnHeard.get(turnId);
    if (!marks?.length || heardAt === undefined) return;
    this.cancelPending('replay');
    // Whatever of this turn is still on screen goes, so it can be drawn again.
    this.s.ink.fade({ group: turnId });
    const rate = this.s.settings.playbackRate || 1;
    const start = Date.now() + 140;
    const copies: InkItem[] = [];
    for (const m of [...marks].sort((a, b) => a.revealAt - b.revealAt)) {
      const want = start + Math.max(0, m.revealAt - heardAt) / rate;
      const it: InkItem = { ...m, id: inkId('rp'), fadeAt: null, group: `${turnId}-replay` };
      const p0 = inkPenPoint(it, 0);
      const steps: CursorStep[] = p0 ? [{ kind: 'fly', to: p0, maxMs: 600 }, { kind: 'trace', item: it }] : [{ kind: 'trace', item: it }];
      const times = this.s.cursor.schedule(steps, Math.max(Date.now(), want - (p0 ? 450 : 0)), undefined, 2600);
      it.revealAt = times.length ? times[times.length - 1].startAt : want;
      copies.push(it);
    }
    this.s.addInk(copies);
    const end = Math.max(...copies.map((c) => c.revealAt + c.drawMs));
    if (this.s.settings.inkFade === 'after-speech') this.s.ink.fade({ group: `${turnId}-replay` }, end + this.s.settings.inkFadeDelaySec * 1000 + 1500);
  }

  /** Student interrupted: drop marks and cursor moves that haven't started; keep what's drawn. */
  cancelPending(reason: string): void {
    const now = Date.now();
    const future = this.s.ink.all().filter((i) => i.author === 'tutor' && i.revealAt > now + 30).map((i) => i.id);
    if (future.length) this.s.ink.remove(future);
    for (const sync of this.syncs) sync.cancel();
    this.syncs = [];
    if (this.s.cursor.busyUntil > now) this.s.cursor.cancelFuture(now);
    if (future.length) log.debug(`cancelled ${future.length} pending marks (${reason})`);
  }

  clear(who: 'tutor' | 'student' | 'all'): number {
    return this.s.ink.fade(who === 'all' ? {} : { author: who });
  }

  private onTurnComplete(turnId: string): void {
    // Fade the tutor's marks for this turn a few seconds after the speech has finished.
    const s = this.s.settings;
    if (s.inkFade !== 'after-speech') return;
    const ids = this.turnInk.get(turnId);
    if (!ids?.length) return;
    const at = Date.now() + this.s.clock.remainingMs() + s.inkFadeDelaySec * 1000;
    const live = new Set(this.s.ink.all().map((i) => i.id));
    const still = ids.filter((id) => live.has(id));
    if (still.length) this.s.ink.fade({ ids: still }, at);
    this.turnInk.delete(turnId);
  }

  private onTutorWords(text: string, position: number): void {
    if (!this.syncs.length) return;
    for (const sync of this.syncs) sync.feed(text, position);
    const now = Date.now();
    this.syncs = this.syncs.filter((x) => {
      if (x.expired(now)) {
        x.flushRemaining(this.s.clock.position);
        return false;
      }
      return !x.done;
    });
  }

  private reset(): void {
    for (const sync of this.syncs) sync.cancel();
    this.syncs = [];
    this.turnInk.clear();
    this.lastMark = null;
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private registerTools(): void {
    const t = this.s.tools;

    t.register('point_at', async (args, _call, signal) => {
      const target = str(args.target);
      if (!target) return { response: { ok: false, error: 'Say what to point at.' } };
      const label = str(args.label) || undefined;
      const display = this.displayFor(args);
      const approx = this.approxPoint(args, display);
      const at = this.speechTime();
      // Start moving right away toward the tutor's own guess; refine when grounding lands.
      if (approx) this.s.cursor.schedule([{ kind: 'fly', to: approx.global, label }], at, label);
      const [r] = await this.grounder.locate(display.id, [{ id: 'p', description: target, approx: approx?.norm, control: namesControl(target) }], this.s.modelFrame, signal);
      if (signal.aborted) return { response: { ok: false } };
      if (!r?.found || !r.rect) {
        return { response: { ok: false, found: false, note: `Couldn't find "${target}" on screen. Describe where it is in words instead of saying "here".` } };
      }
      const tip = pointTip(r.rect);
      this.retarget(tip, label, at);
      const ring: InkItem = {
        id: inkId('ring'),
        author: 'tutor',
        kind: 'ring',
        color: this.s.settings.tutorColor,
        surface: 'screen',
        rect: r.rect,
        revealAt: Math.max(Date.now(), at) + 280,
        drawMs: 900,
        fadeAt: Math.max(Date.now(), at) + RING_MS,
        seed: 1,
        group: this.group(),
        label: target,
      };
      this.s.addInk([ring]);
      this.lastMark = tip;
      return { response: { ok: true, found: true } };
    });

    t.register('annotate', async (args, _call, signal) => {
      const raw = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [];
      const items = raw.filter((i) => i && DRAWABLE.has(str(i.kind) as MarkKind)).slice(0, 6);
      if (!items.length) return { response: { ok: false, error: 'No marks to draw.' } };
      if (args.clear_previous === true) this.clear('tutor');
      const display = this.displayFor(args);
      const at = this.speechTime();
      const targets: GroundTarget[] = [];
      items.forEach((it, i) => {
        const approx = this.approxPoint(it, display);
        const desc = str(it.target);
        const precise = it.kind === 'underline' || it.kind === 'highlight';
        if (desc && !Array.isArray(it.box)) targets.push({ id: `m${i}`, description: desc, approx: approx?.norm, precise, control: !precise && namesControl(desc) });
        const from = str(it.from);
        if (from && it.kind === 'arrow') targets.push({ id: `f${i}`, description: from });
      });
      const found = targets.length ? await this.grounder.locate(display.id, targets, this.s.modelFrame, signal) : [];
      if (signal.aborted) return { response: { ok: false } };
      const rectOf = (id: string) => found.find((f) => f.id === id && f.found)?.rect;
      const missing: string[] = [];
      const specs: MarkSpec[] = [];
      let prev: Rect | undefined;
      items.forEach((it, i) => {
        const kind = str(it.kind) as MarkKind;
        // `box` = [ymin, xmin, ymax, xmax] in the latest frame (demo script / tests).
        const box = Array.isArray(it.box) && it.box.length === 4 && this.s.modelFrame ? box2dToGlobal(this.s.modelFrame, it.box as Box2D) : undefined;
        const rect = rectOf(`m${i}`) ?? box;
        const approx = this.approxPoint(it, display);
        if (str(it.target) && !rect && !approx) {
          missing.push(str(it.target));
          return;
        }
        const r = rect ?? (approx ? { x: approx.global.x - 50, y: approx.global.y - 16, width: 100, height: 32 } : undefined);
        const fromRect = rectOf(`f${i}`);
        if (kind === 'text') {
          const note = str(it.text);
          if (!note) return;
          specs.push({ kind, text: note, rect: r ?? prev, at: !r && !prev && approx ? approx.global : undefined });
          if (!r && !prev && !approx) specs[specs.length - 1].at = rectCenter(display.workArea);
        } else if (r) {
          specs.push({ kind, rect: r, text: str(it.text) || undefined, num: num(it.number), from: fromRect ? rectCenter(fromRect) : undefined, label: str(it.target) || undefined });
          prev = r;
        }
      });
      const ink = buildInk(specs, display.bounds, this.style());
      this.play(ink, at);
      return { response: { ok: ink.length > 0, drawn: ink.length, ...(missing.length ? { not_found: missing, note: 'Describe those in words instead.' } : {}) } };
    });

    t.register('clear_drawings', async (args) => {
      const who = (['tutor', 'student', 'all'].includes(str(args.who)) ? str(args.who) : 'all') as 'tutor' | 'student' | 'all';
      return { response: { ok: true, cleared: this.clear(who) } };
    });

    t.register('read_screen', async (args, _call, signal) => {
      const region = str(args.region) || 'the main content';
      const display = this.displayFor(args);
      const approx = this.approxPoint(args, display);
      const crop = approx ? cropAround(display.bounds, approx.global, Math.min(display.bounds.width, 1100), Math.min(display.bounds.height, 640)) : undefined;
      this.s.cursor.setActivity('thinking', 'reading…');
      const r = await this.reader.read(display.id, region, crop);
      this.s.cursor.setActivity(this.s.snapshot.activity === 'speaking' ? 'speaking' : 'idle');
      if (signal.aborted) return { response: { ok: false } };
      return { response: r.ok ? { ok: true, text: r.text } : { ok: false, note: r.text || r.error || 'Could not read it.' } };
    });

    t.register('explain_on_screen', async (args, _call, signal) => {
      const question = str(args.question);
      const display = this.displayFor(args);
      const lines = num(args.lines) ?? 4;
      this.s.cursor.setActivity('thinking', 'sketching…');
      const frame = await this.frames.capture(display.id, { maxWidth: 2048 });
      if (!frame) return { response: { ok: false, note: 'Could not see the screen — explain in words.' } };
      let beats: PlannedBeat[];
      try {
        beats = this.planner.available ? (await this.planner.plan({ ...this.planContext(), frame, question, focus: str(args.focus) || undefined, lines }, signal)).beats : demoBeats(frame, question);
      } catch (e) {
        log.warn('explain_on_screen planning failed', e);
        beats = [];
      }
      this.s.cursor.setActivity(this.s.snapshot.activity === 'speaking' ? 'speaking' : 'idle');
      if (signal.aborted) return { response: { ok: false } };
      if (!beats.length) return { response: { ok: false, note: 'Could not plan the drawing. Explain in words and use point_at / annotate.' } };
      this.scheduleBeats(beats, frame, display);
      return {
        response: {
          ok: true,
          script: beats.map((b) => b.say),
          how: 'Say these lines now, in order, essentially word for word (small natural changes are fine). Each line\'s marks appear on the student\'s screen as you say it. Then check in with them.',
        },
        scheduling: 'WHEN_IDLE',
      };
    });

    t.register('celebrate', async (args) => {
      this.celebrate(str(args.message) || 'nice!');
      return { response: { ok: true } };
    });
  }

  /** Re-aim the pointing flight at the grounded tip (keeping its speech timing if not started). */
  private retarget(tip: Point, label: string | undefined, at: number): void {
    const c = this.s.cursor;
    const now = Date.now();
    if (c.busyUntil > now) {
      const startsLater = at > now + 40;
      c.cancelFuture(now);
      c.schedule([{ kind: 'fly', to: tip, label, maxMs: startsLater ? 1100 : 450 }], startsLater ? at : now, label);
    } else {
      c.schedule([{ kind: 'fly', to: tip, label }], Math.max(now, at), label);
    }
  }

  celebrate(text: string, at?: Point): void {
    if (!this.s.settings.celebrate) return;
    const p = at ?? this.lastMark ?? this.s.cursor.position;
    this.s.overlays.send('overlay:celebrate', { id: `cel-${++this.seq}`, at: p, text, startAt: Date.now() });
    if (this.s.settings.sounds) this.s.deps.engine.command({ type: 'chime', kind: 'celebrate' });
  }

  private planContext() {
    const s = this.s.settings;
    const c = this.s.course;
    const p = c?.profile;
    return {
      tutorName: s.tutorName,
      courseLine: c ? `${c.code}${c.name ? ` — ${c.name}` : ''}` : 'unknown',
      terms: p ? p.glossary.map((g) => g.term) : [],
      depth: s.explanationDepth,
      assignment: this.s.snapshot.assignment,
      studentMarks: this.s.ask.lastDescription ?? undefined,
    };
  }

  /** Turn planned beats into ink and arm a BeatSync that fires each beat as its line is spoken. */
  scheduleBeats(beats: PlannedBeat[], frame: EncodedFrame, display: DisplayInfo): void {
    const inkPerBeat = beats.map((b) => buildInk(b.marks.map((m) => planToSpec(m, frame)).filter((x): x is MarkSpec => x !== null), display.bounds, this.style()));
    const sync = new BeatSync(
      beats.map((b, i) => ({
        text: b.say,
        start: (pos: number) => {
          const ink = inkPerBeat[i];
          if (!ink.length) return;
          for (const it of ink) it.group = this.group();
          this.play(ink, this.s.clock.timeFor(pos) - SPEECH_LEAD_MS, beats[i].marks[0]?.label);
        },
      })),
    );
    this.syncs.push(sync);
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  /** A short scripted showcase of the cursor and every kind of mark (no API calls). */
  previewInk(): void {
    if (!this.s.isActive) return;
    const d = this.s.activeDisplay();
    const b = d.workArea;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const box = (dx: number, dy: number, w: number, h: number): Rect => ({ x: cx + dx, y: cy + dy, width: w, height: h });
    const specs: MarkSpec[] = [
      { kind: 'circle', rect: box(-330, -150, 220, 60), label: 'circle' },
      { kind: 'underline', rect: box(-330, -40, 300, 30) },
      { kind: 'highlight', rect: box(-330, 30, 260, 28) },
      { kind: 'arrow', rect: box(120, -120, 160, 50), text: 'look here!' },
      { kind: 'box', rect: box(120, 40, 200, 70) },
      { kind: 'step', at: { x: cx + 110, y: cy + 160 }, num: 1 },
      { kind: 'check', at: { x: cx + 180, y: cy + 165 } },
    ];
    const ink = buildInk(specs, d.bounds, { ...this.style(), group: 'preview' });
    this.play(ink, Date.now(), 'that\'s my pen!');
    const total = ink.reduce((a, i) => a + i.drawMs + 600, 0);
    setTimeout(() => this.celebrate('nice!', { x: cx, y: cy - 40 }), total);
    setTimeout(() => this.s.ink.fade({ group: 'preview' }), total + 4000);
  }
}

/** A planned mark (0–1000 of the planning frame) → a located mark in global DIP. */
export function planToSpec(m: PlannedMark, frame: EncodedFrame): MarkSpec | null {
  const rect = m.box_2d && m.box_2d.length === 4 ? box2dToGlobal(frame.ref, m.box_2d as Box2D) : undefined;
  const pt = m.point && m.point.length === 2 ? yxToGlobal(frame.ref, m.point as [number, number]) : undefined;
  switch (m.kind) {
    case 'text':
      return m.text ? { kind: 'text', text: m.text, rect: pt ? undefined : rect, at: pt } : null;
    case 'arrow':
      return rect || pt ? { kind: 'arrow', rect, from: rect ? pt : undefined, to: rect ? undefined : pt, text: m.text, label: m.label } : null;
    case 'step':
    case 'check':
    case 'cross':
      return { kind: m.kind, rect, at: pt, num: m.number, label: m.label };
    default:
      return rect ? { kind: m.kind, rect: rect.width < 4 || rect.height < 4 ? inflateRect(rect, 6) : rect, label: m.label } : null;
  }
}

/** Demo mode (no key): a fixed little explanation in the middle of the screen. */
function demoBeats(frame: EncodedFrame, _question: string): PlannedBeat[] {
  void frame;
  return [
    { say: 'In demo mode I can\'t read your screen, but this is how an explanation looks.', marks: [{ kind: 'circle', box_2d: [380, 330, 470, 560], label: 'this part' }] },
    { say: 'I mark the important part as I mention it,', marks: [{ kind: 'underline', box_2d: [520, 330, 560, 640] }] },
    { say: 'then connect it to the next idea.', marks: [{ kind: 'arrow', box_2d: [600, 600, 660, 720], point: [520, 760], text: 'next' }] },
  ];
}
