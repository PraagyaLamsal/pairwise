import { net } from 'electron';
import { GEMINI_API_BASE, GEMINI_LIVE_PATH } from '@shared/app-info';
import type { IndexStatus, ResumeState, SearchHit } from '@shared/courses';
import type { DisplayInfo, FrameRef } from '@shared/geometry';
import type { CourseFile, EncodedFrame, PlaybackStatus, SendMap } from '@shared/ipc';
import type { UsageMetadata } from '@shared/pricing';
import type { Caption, SessionCommand, StartSessionRequest, TutorActivity } from '@shared/session';
import type { HubWindow } from '../windows/hub';
import { SessionController, type SessionDeps } from './controller';
import { captureSources } from './capture-sources';
import { LiveLink } from './live-link';
import { openingTurn, systemInstruction, type PromptContext } from './prompts';
import { ToolDispatcher, liveTools } from './tools';
import { SpeechClock } from './speech-clock';
import { VisualFeature } from './features/visual';
import { AskFeature } from './features/ask';
import { StepsFeature } from './features/steps';
import { runCalibration } from './features/calibrate';
import { CourseFeature } from './features/course';
import { TakeoverFeature } from './features/takeover';
import { VeilFeature } from './features/veil';
import { WhiteboardFeature } from './features/whiteboard';
import { NotesFeature } from './features/notes';
import { QuizFeature } from './features/quiz';
import type { CalReport } from '../vision/calibration';
import { GeminiRest } from '../gemini/rest';
import { liveUrl, type FunctionCall, type LiveSetup } from '../gemini/live';
import { MockLiveServer } from '../gemini/mock-live';
import { makeSynthesizer } from '../gemini/say';
import { env } from '../env';
import { logger } from '../log';

const log = logger('tutor');

/** Resumption handles stay valid ~2 h after a session ends; use a margin. */
const HANDLE_TTL_MS = 100 * 60 * 1000;

interface TurnState {
  id: string;
  /** 24 kHz samples of tutor audio received in this turn (for syncing drawings to speech). */
  samples: number;
  startedAt: number;
}

/**
 * The full tutoring session: voice + vision (phase 2) with hooks that later phases use for
 * pointing/drawing, course search, takeover, veil and notes.
 */
export class TutorSession extends SessionController {
  readonly rest: GeminiRest;
  readonly tools = new ToolDispatcher();
  link: LiveLink | null = null;
  mock: MockLiveServer | null = null;
  /** Latest frame captured per display. */
  readonly frames = new Map<string, EncodedFrame>();
  /** Latest frame the model has seen — its approximate x/y coordinates refer to this. */
  modelFrame: FrameRef | null = null;
  /** Recent frames sent to the Live model (diagnostics, tests, notes). */
  readonly sentFrames: FrameRef[] = [];
  activeDisplayId = '';
  promptCtx: PromptContext | null = null;
  turn: TurnState | null = null;
  lastTurnId = '';
  playback: PlaybackStatus = { playedSamples: 0, queuedSamples: 0, playing: false, at: 0, epoch: 0, level: 0 };
  private turnSeq = 0;
  private suppressedTurn = '';
  private pendingUsage: UsageMetadata | null = null;
  private studentCaption: Caption | null = null;
  private tutorCaption: Caption | null = null;
  private captionSeq = 0;
  studentSpeaking = false;
  spokeDuringAsk = false;
  pttHeld = false;
  /** Audio position ↔ wall clock, for drawing in time with the words. */
  readonly clock = new SpeechClock();
  /** When set, microphone chunks go here instead of to Live (hold-to-ask buffers its question). */
  audioSink: ((pcm: Uint8Array) => boolean) | null = null;
  readonly visual: VisualFeature;
  readonly ask: AskFeature;
  readonly steps: StepsFeature;
  /** Phase 4: course folder index, search_course / cite / flag_out_of_scope / think_deeply. */
  readonly coursework: CourseFeature;
  /** Phase 5: request_control / control / release_control, consent and instant reclaim. */
  readonly takeover: TakeoverFeature;
  /** Phase 6: App Veil (veiled windows blacked out in every frame, outlined on screen). */
  readonly veil: VeilFeature;
  /** Feature 11: the whiteboard window, diagrams drawn by the tutor's pen. */
  readonly whiteboard: WhiteboardFeature;
  /** Session notes written to the course folder at the end (save_note collects into them). */
  readonly sessionNotes: NotesFeature;
  /** "Show me": ask_to_point takes the student's click as their answer. */
  readonly quiz: QuizFeature;
  /** The notes for the last session, while they are being written (tests await it). */
  notesWriting: Promise<void> | null = null;
  private lastQuestionFrameAt = 0;
  private thinkingTimer: NodeJS.Timeout | null = null;
  private displayTimer: NodeJS.Timeout | null = null;
  private lastLevelsAt = 0;
  private lastLevels = { mic: -1, out: -1 };
  private levelsTimer: NodeJS.Timeout | null = null;
  private micLevel = 0;
  private warnedBudget = false;
  private detach: (() => void)[] = [];
  /** True while the server is generating a reply (from its first output until turnComplete/interrupted). */
  generating = false;
  /** Context notes waiting for a moment when sending them won't cut the tutor off. */
  private notes: string[] = [];
  private noteTimer: NodeJS.Timeout | null = null;
  private interimStudent = '';
  private explainedMediaPause = false;

  constructor(readonly full: SessionDeps & { hub: HubWindow }) {
    super(full);
    this.rest = new GeminiRest(
      () => this.deps.settings.getApiKey(),
      env.restBase ?? GEMINI_API_BASE,
      (model, usage, fallback) => {
        if (!this.demoMode()) this.deps.usage.record(model, usage, fallback);
      },
    );
    this.deps.hotkeys.on('ask', (phase: 'start' | 'end' | 'cancel') => {
      if (!this.isActive) return;
      if (phase === 'start') this.onAskStart('hold');
      else if (phase === 'end') void this.onAskEnd(false);
      else void this.onAskEnd(true);
    });
    this.registerCoreTools();
    this.visual = new VisualFeature(this);
    this.ask = new AskFeature(this);
    this.steps = new StepsFeature(this);
    this.coursework = new CourseFeature(this);
    this.takeover = new TakeoverFeature(this);
    this.veil = new VeilFeature(this);
    this.whiteboard = new WhiteboardFeature(this);
    this.sessionNotes = new NotesFeature(this);
    this.quiz = new QuizFeature(this);
  }

  demoMode(): boolean {
    return env.mockLive || !this.deps.settings.getApiKey();
  }

  get liveModel(): string {
    const s = this.settings;
    return s.useDeepLiveModel ? s.models.liveDeep : s.models.live;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  protected override async onStart(req: StartSessionRequest): Promise<void> {
    const demo = this.demoMode();
    const s = this.settings;
    this.update({ demo, status: 'connecting', model: demo ? 'demo' : this.liveModel });
    this.turn = null;
    this.frames.clear();
    this.modelFrame = null;
    this.warnedBudget = false;
    this.explainedMediaPause = false;

    // 1. engine: audio + capture
    await this.deps.engine.ensure();
    this.attachEngine();
    this.deps.engine.command({ type: 'startAudio', echoCancellation: true, playbackRate: s.playbackRate });
    this.deps.engine.command({ type: 'setMuted', muted: false });
    this.applyGate();

    const displays = this.deps.platform.displays.list();
    const active = this.activeDisplay();
    this.activeDisplayId = active.id;
    // App Veil is in place before the first frame can leave.
    await this.veil.start();
    try {
      const specs = await captureSources(displays);
      this.deps.engine.preferredDisplayId = active.id;
      this.deps.engine.command({
        type: 'startCapture',
        sources: specs,
        activeDisplayId: active.id,
        maxLiveWidth: s.liveMediaResolution === 'MEDIA_RESOLUTION_HIGH' ? 1600 : 1280,
        quality: 0.62,
      });
    } catch (e) {
      log.warn('screen capture unavailable', e);
      this.toast('Screen capture unavailable — check Screen Recording permission', 'warn', 5000);
    }

    // 2. prompt context
    const course = this.course!;
    const resume = req.resume ? this.deps.courses.getResume(course.id) : null;
    this.promptCtx = {
      settings: s,
      course,
      displays,
      activeDisplay: active,
      assignment: req.assignment,
      resume,
      hasCourseMaterial: Boolean(course.folder) && (this.coursework.brain.hasMaterial(course.id) || course.indexStatus.state !== 'error'),
      platform: process.platform,
    };

    this.coursework.refresh(course.id);

    // 3. Gemini Live (or the local demo tutor)
    let url: string;
    if (demo) {
      this.mock = new MockLiveServer(makeSynthesizer(), s.tutorName);
      url = await this.mock.start();
    } else {
      const key = this.deps.settings.getApiKey();
      url = env.liveUrl ? `${env.liveUrl}${env.liveUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : liveUrl(GEMINI_API_BASE, GEMINI_LIVE_PATH, key);
    }
    const link = new LiveLink(() => url, (handle) => this.buildSetup(handle), { online: () => net.isOnline() });
    this.link = link;
    this.attachLink(link);
    const fresh = resume?.liveHandle && Date.now() - resume.liveHandle.savedAt < HANDLE_TTL_MS && resume.liveHandle.model === this.liveModel ? resume.liveHandle.handle : undefined;
    await link.open(fresh);

    // 4. go live
    this.ui.visionDisplayId = active.id;
    this.ui.visionLabel = active.label;
    this.update({ status: 'live', visibleDisplayId: active.id, visibleDisplayLabel: displays.length > 1 ? active.label : 'your screen' });
    this.pushUi();
    if (s.sounds) this.deps.engine.command({ type: 'chime', kind: 'start' });
    link.sendContext(openingTurn(this.promptCtx), true);
    this.displayTimer = setInterval(() => this.trackActiveDisplay(), 400);
    await this.onLive(req);
  }

  /** Hook for later phases once the session is live. */
  protected async onLive(_req: StartSessionRequest): Promise<void> {}

  protected override async onEnd(reason: string): Promise<void> {
    if (this.displayTimer) clearInterval(this.displayTimer);
    this.displayTimer = null;
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    this.notes = [];
    this.generating = false;
    this.tools.cancelAll();
    this.commitUsage();
    // Notes: gathered now, written in the background (ending never waits for a summary); the
    // summary / open questions / to-review then go into the resume state for next time.
    const notesJob = this.sessionNotes.capture(this.snapshot.startedAt ?? Date.now());
    const courseId = this.course?.id;
    await this.beforeTeardown(reason);
    this.saveResume();
    if (notesJob && courseId) {
      const job = notesJob()
        .then((extra) => {
          const prev = this.deps.courses.getResume(courseId);
          if (extra && prev) this.deps.courses.saveResume({ ...prev, ...extra, savedAt: Date.now() });
          this.emit('notesWritten', extra?.lastNotesFile ?? null, courseId);
        })
        .catch((e) => log.warn('notes failed', e))
        .finally(() => {
          if (this.notesWriting === job) this.notesWriting = null;
        });
      this.notesWriting = job;
    }
    this.link?.close();
    this.link = null;
    await this.mock?.stop().catch(() => undefined);
    this.mock = null;
    if (this.settings.sounds) this.deps.engine.command({ type: 'chime', kind: 'end' });
    setTimeout(() => {
      this.deps.engine.command({ type: 'stopAudio' });
    }, 400);
    this.deps.engine.command({ type: 'stopCapture' });
    for (const d of this.detach.splice(0)) d();
    this.frames.clear();
    this.turn = null;
    this.studentCaption = null;
    this.tutorCaption = null;
    if (this.deps.platform.media.pausedByUs) void this.deps.platform.media.resume();
  }

  /** Hook for later phases (notes) — runs before the live link closes. */
  protected async beforeTeardown(_reason: string): Promise<void> {}

  buildSetup(handle?: string): LiveSetup {
    const s = this.settings;
    const ctx = this.promptCtx!;
    const deep = s.useDeepLiveModel;
    return {
      model: `models/${this.demoMode() ? 'demo-live' : this.liveModel}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } } },
        mediaResolution: s.liveMediaResolution,
        ...(deep ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
      },
      systemInstruction: { parts: [{ text: systemInstruction({ ...ctx, settings: s }) }] },
      // Quick checks turned off: the tutor doesn't get the tool at all.
      tools: liveTools((name) => this.tools.has(name) && !(name === 'ask_to_point' && s.quickChecks === 'off')),
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: s.talkMode === 'push-to-talk' ? 'START_SENSITIVITY_HIGH' : 'START_SENSITIVITY_LOW',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          prefixPaddingMs: 120,
          silenceDurationMs: 700,
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        turnCoverage: 'TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO',
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: handle ? { handle } : {},
      contextWindowCompression: { slidingWindow: {} },
    };
  }

  // ===========================================================================
  // Engine wiring (mic, playback, frames)
  // ===========================================================================

  private attachEngine(): void {
    const e = this.deps.engine;
    const on = <T>(ev: string, fn: (m: T) => void) => {
      e.on(ev, fn);
      this.detach.push(() => e.off(ev, fn));
    };
    on<SendMap['engine:audio']>('audio', (m) => {
      if (!this.link || this.snapshot.muted) return;
      if (this.settings.talkMode === 'push-to-talk' && !this.pttHeld) return;
      if (this.audioSink?.(m.pcm)) return;
      this.link.sendAudio(m.pcm);
    });
    on<SendMap['engine:micLevel']>('micLevel', (m) => {
      this.micLevel = m.level;
      this.pushLevels();
    });
    on<SendMap['engine:vad']>('vad', (m) => this.onLocalVad(m.speaking));
    on<PlaybackStatus>('playback', (p) => this.onPlayback(p));
    on<EncodedFrame>('frame', (f) => this.onFrame(f));
  }

  private onFrame(f: EncodedFrame): void {
    this.frames.set(f.ref.displayId, f);
    if (this.snapshot.vision !== 'on' || !this.link?.ready) return;
    if (f.ref.displayId !== this.activeDisplayId) return;
    this.link.sendVideo(f.data, f.mime);
    this.markFrameSent(f);
  }

  private markFrameSent(f: EncodedFrame): void {
    this.modelFrame = f.ref;
    this.sentFrames.push(f.ref);
    if (this.sentFrames.length > 50) this.sentFrames.splice(0, this.sentFrames.length - 50);
    this.emit('frameSent', f);
  }

  /** Grab a fresh frame now and send it (the moment a question starts). */
  async sendQuestionFrame(composite?: { color: string; strokes: { points: { x: number; y: number }[] }[] }, displayId = this.activeDisplayId): Promise<EncodedFrame | null> {
    if (this.snapshot.vision !== 'on' || !this.link?.ready) return null;
    const now = Date.now();
    if (!composite && now - this.lastQuestionFrameAt < 1500) return null;
    this.lastQuestionFrameAt = now;
    const r = await this.deps.engine.request({
      type: 'captureNow',
      requestId: this.deps.engine.nextRequestId('q'),
      displayId,
      maxWidth: 1920,
      quality: 0.7,
      kind: 'hires',
      composite,
    });
    if (!r.ok || !r.frame) return null;
    this.frames.set(r.frame.ref.displayId, r.frame);
    this.link?.sendVideo(r.frame.data, r.frame.mime);
    this.markFrameSent(r.frame);
    return r.frame;
  }

  private pushLevels(): void {
    const now = Date.now();
    if (now - this.lastLevelsAt < 50) {
      // Levels now arrive only when they change: never drop the last one (e.g. back to silence).
      if (!this.levelsTimer) {
        this.levelsTimer = setTimeout(() => {
          this.levelsTimer = null;
          this.pushLevels();
        }, 50 - (now - this.lastLevelsAt));
      }
      return;
    }
    const mic = this.snapshot.muted ? 0 : this.micLevel;
    const out = this.playback.playing ? Math.round(Math.min(1, this.playback.level * 4) * 50) / 50 : 0;
    this.cursor.setLevel(this.snapshot.activity === 'speaking' ? out : this.snapshot.activity === 'listening' ? mic : 0);
    // Silence stays silent: the pill isn't re-rendered twenty times a second with zeros.
    if (mic === this.lastLevels.mic && out === this.lastLevels.out) return;
    this.lastLevelsAt = now;
    this.lastLevels = { mic, out };
    this.deps.hud.window?.webContents.send('session:levels', { mic, out });
  }

  // ===========================================================================
  // Live wiring (tutor audio, transcripts, tools, usage)
  // ===========================================================================

  private attachLink(link: LiveLink): void {
    link.on('status', (st: string) => {
      if (!this.isActive) return;
      if (st === 'reconnecting') this.update({ status: 'reconnecting', reconnects: link.reconnects });
      else if (st === 'open' && this.snapshot.status === 'reconnecting') this.update({ status: 'live' });
    });
    link.on('fatal', (e: Error) => void this.end({ reason: 'connection lost', error: e.message }));
    link.on('reconnected', (downMs: number, fresh: boolean) => {
      // A real drop (not the routine ~10-minute GoAway handover): help her pick up the thread.
      if (fresh) this.note(`[The connection dropped and had to start over. Where you were: ${this.recentContext()}. Pick up from there briefly.]`);
      else if (downMs > 3000) this.note(`[The connection dropped for ${Math.round(downMs / 1000)} s and is back. Anything they said meanwhile was lost; check in briefly and carry on.]`);
    });
    link.on('audio', (pcm: Buffer) => {
      this.generating = true;
      this.onTutorAudio(pcm);
    });
    link.on('outputTranscript', (t: string) => {
      this.generating = true;
      this.appendTutorCaption(t);
    });
    link.on('interimTranscript', (t: string) => this.setInterimStudentCaption(t));
    link.on('inputTranscript', (t: string) => this.appendStudentCaption(t));
    link.on('interrupted', () => {
      this.generating = false;
      this.onInterrupted();
      this.flushNotesSoon();
    });
    link.on('turnComplete', () => {
      this.generating = false;
      this.onTurnComplete();
      this.flushNotesSoon();
    });
    link.on('toolCall', (calls: FunctionCall[]) => this.onToolCalls(calls));
    link.on('toolCancel', (ids: string[]) => this.tools.cancel(ids));
    link.on('usage', (u: UsageMetadata) => {
      this.pendingUsage = u;
      if (!this.turn) this.commitUsage();
    });
    link.on('voiceActivity', (kind: 'start' | 'end') => {
      if (kind === 'start') {
        // Server heard the student start talking: stop the tutor right away.
        if (this.playback.playing) this.flushTutor('server-vad');
        this.generating = false;
        this.setActivity('listening');
        this.flushNotesSoon();
      } else if (kind === 'end') this.setActivity('thinking');
    });
    link.on('resumption', () => undefined);
    link.on('error', (e: Error) => log.warn('live error', e.message));
  }

  private onTutorAudio(pcm: Buffer): void {
    if (!this.turn) {
      this.turnSeq += 1;
      this.turn = { id: `turn-${this.turnSeq}`, samples: 0, startedAt: Date.now() };
      this.closeStudentCaption();
      // When the first word of this turn will be heard (for "say that again" with the ink).
      this.emit('turnStart', this.turn.id, this.clock.timeFor(this.clock.position));
    }
    if (this.turn.id === this.suppressedTurn) return;
    this.turn.samples += pcm.length / 2;
    this.deps.engine.command({ type: 'play', pcm: new Uint8Array(pcm), turnId: this.turn.id });
    this.clock.onAudioSent(pcm.length / 2);
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
  }

  /** True while this turn's audio is being dropped (the student cut the tutor off). */
  get turnSuppressed(): boolean {
    return Boolean(this.turn && this.turn.id === this.suppressedTurn);
  }

  /** Stop the tutor's voice locally (barge-in) and ignore the rest of this turn's audio. */
  flushTutor(reason: string): void {
    this.deps.engine.command({ type: 'flush', reason });
    this.clock.onFlush();
    if (this.turn) this.suppressedTurn = this.turn.id;
    this.emit('flushed', reason);
  }

  private onInterrupted(): void {
    this.deps.engine.command({ type: 'flush', reason: 'interrupted' });
    this.clock.onFlush();
    if (this.tutorCaption) {
      this.tutorCaption = { ...this.tutorCaption, text: `${this.tutorCaption.text.trim()} —`, final: true };
      this.caption(this.tutorCaption);
      this.tutorCaption = null;
    }
    const id = this.turn?.id;
    if (this.turn) this.lastTurnId = this.turn.id;
    this.turn = null;
    this.emit('interrupted', id);
  }

  private onTurnComplete(): void {
    if (this.tutorCaption) {
      this.tutorCaption = { ...this.tutorCaption, final: true };
      this.caption(this.tutorCaption);
      this.tutorCaption = null;
    }
    this.closeStudentCaption();
    if (this.turn) {
      this.lastTurnId = this.turn.id;
      this.update({ canReplay: true });
      this.emit('turnComplete', this.turn.id);
    }
    this.turn = null;
    this.commitUsage();
    if (!this.playback.playing && this.snapshot.activity === 'thinking') this.setActivity('idle');
  }

  private async onToolCalls(calls: FunctionCall[]): Promise<void> {
    for (const call of calls) {
      // Remember where in the speech this call happened, so drawings appear in sync.
      (call as FunctionCall & { audioAt?: number; turnId?: string }).audioAt = this.turn?.samples ?? 0;
      (call as FunctionCall & { audioAt?: number; turnId?: string }).turnId = this.turn?.id ?? '';
      log.info(`tool ${call.name} ${JSON.stringify(call.args ?? {}).slice(0, 200)}`);
      void this.tools.dispatch(call).then((res) => {
        if (res) this.link?.sendToolResponses([res]);
      });
    }
  }

  private commitUsage(): void {
    const u = this.pendingUsage;
    this.pendingUsage = null;
    if (!u || this.demoMode()) return;
    this.deps.usage.record(this.liveModel, u, { input: 'AUDIO', output: 'AUDIO' });
    const sum = this.deps.usage.summary();
    if (sum.blocked && this.isActive) {
      this.toast('Monthly budget reached — ending the session', 'warn', 4000);
      setTimeout(() => void this.end({ reason: 'budget', error: 'Monthly budget reached. Raise the cap in Usage to keep going.' }), 2500);
    } else if (sum.warn && !this.warnedBudget) {
      this.warnedBudget = true;
      this.toast(`Heads up: ${Math.round(sum.percent)}% of this month's budget used`, 'warn', 4000);
    }
  }

  // ===========================================================================
  // Context notes ("[The student switched to display 2]" …)
  // ===========================================================================

  /**
   * Tell the tutor something about the session without asking for a reply. The Live API cancels
   * any reply in progress when client content arrives, so notes wait until the tutor is not
   * generating (or the student starts talking) and are sent together.
   */
  note(text: string): void {
    this.notes.push(text);
    this.flushNotesSoon();
  }

  private flushNotesSoon(): void {
    if (this.noteTimer || !this.notes.length) return;
    this.noteTimer = setTimeout(() => {
      this.noteTimer = null;
      if (!this.notes.length || !this.link?.ready) {
        if (this.notes.length && this.isActive) this.flushNotesSoon();
        return;
      }
      if (this.generating) {
        this.flushNotesSoon();
        return;
      }
      const text = this.notes.splice(0).join('\n');
      this.link.sendContext(text, false);
    }, 250);
  }

  // ===========================================================================
  // Captions
  // ===========================================================================

  private appendStudentCaption(t: string): void {
    if (!this.studentCaption) {
      this.captionSeq += 1;
      this.studentCaption = { id: `c${this.captionSeq}`, speaker: 'student', text: '', final: false, at: Date.now() };
    }
    this.interimStudent = '';
    this.studentCaption = { ...this.studentCaption, text: (this.studentCaption.text + t).replace(/\s+/g, ' ').trimStart() };
    this.caption(this.studentCaption);
    // What the student said so far this turn (spoken consent for takeover listens to this).
    this.emit('studentWords', this.studentCaption.text);
  }

  /** Interim (not yet final) words: shown after the final text, replaced by the next update. */
  private setInterimStudentCaption(t: string): void {
    if (!this.studentCaption) {
      this.captionSeq += 1;
      this.studentCaption = { id: `c${this.captionSeq}`, speaker: 'student', text: '', final: false, at: Date.now() };
    }
    this.interimStudent = t.replace(/\s+/g, ' ').trim();
    const shown = `${this.studentCaption.text} ${this.interimStudent}`.replace(/\s+/g, ' ').trimStart();
    this.caption({ ...this.studentCaption, text: shown });
    this.emit('studentWords', shown);
  }

  private closeStudentCaption(): void {
    if (!this.studentCaption) return;
    const text = this.studentCaption.text || this.interimStudent;
    this.interimStudent = '';
    this.studentCaption = { ...this.studentCaption, text, final: true };
    this.caption(this.studentCaption);
    this.studentCaption = null;
  }

  private appendTutorCaption(t: string): void {
    if (this.turn && this.turn.id === this.suppressedTurn) return;
    if (!this.tutorCaption) {
      this.closeStudentCaption();
      this.captionSeq += 1;
      this.tutorCaption = { id: `c${this.captionSeq}`, speaker: 'tutor', text: '', final: false, at: Date.now() };
    }
    this.tutorCaption = { ...this.tutorCaption, text: (this.tutorCaption.text + t).replace(/\s+/g, ' ').trimStart() };
    this.caption(this.tutorCaption);
    // Words + where the audio is up to: explain_on_screen reveals each line's marks from this.
    this.emit('tutorWords', t, this.clock.position);
  }

  /** Attach citations / scope flags to the tutor caption currently being spoken. */
  annotateCaption(patch: Partial<Pick<Caption, 'cites' | 'outOfScope'>>): void {
    const target = this.tutorCaption ?? [...this.transcript()].reverse().find((c) => c.speaker === 'tutor');
    if (!target) return;
    const next = { ...target, cites: patch.cites ? [...new Set([...(target.cites ?? []), ...patch.cites])] : target.cites, outOfScope: patch.outOfScope ?? target.outOfScope };
    if (this.tutorCaption && this.tutorCaption.id === target.id) this.tutorCaption = next;
    this.caption(next);
  }

  // ===========================================================================
  // Student activity, push-to-talk, activity state
  // ===========================================================================

  setActivity(a: TutorActivity): void {
    // Idle while a guided step is being watched means waiting for the student to do it.
    if (a === 'idle' && this.steps?.watching) a = 'waiting';
    if (this.snapshot.activity === a) return;
    this.update({ activity: a });
    this.cursor.setActivity(a === 'waiting' ? 'waiting' : a);
    if (a === 'thinking') {
      if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
      this.thinkingTimer = setTimeout(() => this.snapshot.activity === 'thinking' && this.setActivity('idle'), 6000);
    }
  }

  private onLocalVad(speaking: boolean): void {
    this.studentSpeaking = speaking;
    if (speaking) {
      if (this.pttHeld) this.spokeDuringAsk = true;
      this.setActivity('listening');
      void this.onStudentStartsTalking();
    } else if (this.snapshot.activity === 'listening') {
      this.setActivity('thinking');
    }
  }

  /** Student started a question: pause their media, show the tutor the latest screen. */
  protected async onStudentStartsTalking(): Promise<void> {
    void this.autoPauseMedia();
    if (!this.pttHeld) void this.sendQuestionFrame();
  }

  async autoPauseMedia(): Promise<void> {
    if (this.settings.autoPauseMedia === 'off' || this.deps.platform.media.pausedByUs) return;
    const videoLikely = await this.deps.engine.videoLikely();
    const front = await this.deps.platform.frontmostApp();
    const r = await this.deps.platform.media.pauseIfPlaying({ videoLikely, frontApp: front?.name });
    if (r.paused) {
      this.update({ mediaPausedByUs: true });
      // The bar shows a resume button from now on; the reason is worth saying once.
      if (!this.explainedMediaPause) this.toast(`Paused ${r.app ?? 'your video'} while you ask — ▶ in the session bar resumes it`, 'info', 3200);
      this.explainedMediaPause = true;
      this.note(`[The app paused the student's ${r.app ?? 'video'} while they ask. Use the media tool to resume it when they want.]`);
    }
  }

  async resumeMedia(): Promise<boolean> {
    const ok = await this.deps.platform.media.resume();
    this.update({ mediaPausedByUs: false });
    return ok;
  }

  private applyGate(): void {
    const open = this.settings.talkMode === 'hands-free' || this.pttHeld;
    this.deps.engine.command({ type: 'gate', open });
  }

  /**
   * The student started asking: holding the ask chord (talk + draw), or draw mode toggled on.
   * Everything they say and draw until they let go is sent as ONE question (see AskFeature).
   */
  onAskStart(via: 'hold' | 'toggle'): void {
    if (this.pttHeld) return;
    this.pttHeld = true;
    this.spokeDuringAsk = false;
    this.update({ pttHeld: true });
    this.applyGate();
    if (this.playback.playing) this.flushTutor('ask');
    this.visual.cancelPending('student asking');
    void this.autoPauseMedia();
    this.ask.begin(via);
    // The tutor gets a fresh full-detail look the moment a question starts.
    void this.sendQuestionFrame();
    this.emit('askStart');
  }

  /** Released the ask chord (or pressed Return / Esc in draw mode). */
  async onAskEnd(cancelled: boolean): Promise<void> {
    if (!this.pttHeld) return;
    this.pttHeld = false;
    this.update({ pttHeld: false });
    this.applyGate();
    if (cancelled) {
      this.ask.cancel();
      this.emit('askCancel');
      return;
    }
    const spoke = this.spokeDuringAsk || this.studentSpeaking;
    await this.ask.finish(spoke);
    this.emit('askEnd');
  }

  protected override onTalkModeChanged(): void {
    // The session bar's mic shows the mode (a key badge in hold-to-talk): no toast.
    this.applyGate();
  }

  protected override onVisionChanged(v: 'on' | 'paused'): void {
    this.deps.engine.command({ type: 'setLiveCapture', enabled: v === 'on' });
    this.note(v === 'on' ? '[The student turned screen sharing back on.]' : '[The student paused screen sharing. You cannot see their screen until they turn it back on.]');
  }

  private onPlayback(p: PlaybackStatus): void {
    const was = this.playback.playing;
    this.playback = p;
    this.clock.onPlayback(p);
    if (p.playing && !was) this.setActivity('speaking');
    if (!p.playing && was && !this.turn) this.setActivity(this.studentSpeaking ? 'listening' : 'idle');
    this.pushLevels();
    this.emit('playback', p);
  }

  private trackActiveDisplay(): void {
    if (!this.isActive) return;
    const d = this.activeDisplay();
    if (d.id === this.activeDisplayId) return;
    this.switchDisplay(d, 'pointer');
  }

  switchDisplay(d: DisplayInfo, why: 'pointer' | 'tutor'): void {
    this.activeDisplayId = d.id;
    this.deps.engine.preferredDisplayId = d.id;
    this.deps.engine.command({ type: 'setActiveDisplay', displayId: d.id });
    this.ui.visionDisplayId = d.id;
    this.ui.visionLabel = d.label;
    this.pushUi();
    this.update({ visibleDisplayId: d.id, visibleDisplayLabel: d.label });
    const n = this.deps.platform.displays.list().length;
    this.note(why === 'pointer' ? `[The student moved to display ${d.index} of ${n} (${d.label}). New frames show that display.]` : `[You are now looking at display ${d.index} (${d.label}).]`);
  }

  // ===========================================================================
  // Commands
  // ===========================================================================

  protected override async onCommand(cmd: SessionCommand): Promise<void> {
    switch (cmd.type) {
      case 'replay':
        this.replay();
        break;
      case 'toggleMedia':
        if (this.snapshot.mediaPausedByUs) await this.resumeMedia();
        else await this.autoPauseMedia();
        break;
      case 'sendText':
        this.link?.sendText(cmd.text);
        break;
      case 'pttDown':
        this.onAskStart('hold');
        break;
      case 'pttUp':
        await this.onAskEnd(false);
        break;
      case 'toggleWhiteboard':
        await this.whiteboard.toggle();
        break;
      case 'grantControl':
      case 'denyControl':
      case 'reclaim':
        this.takeover.command(cmd.type);
        break;
      case 'drawToggle':
        // Draw mode without holding keys (trackpads): press again (or Return) to send.
        if (this.pttHeld) await this.onAskEnd(false);
        else this.onAskStart('toggle');
        break;
      default:
        await this.onFeatureCommand(cmd);
    }
  }

  /** Hook for phases 4–6 (whiteboard, takeover, …). */
  protected async onFeatureCommand(cmd: SessionCommand): Promise<void> {
    log.debug('unhandled command', cmd.type);
  }

  replay(): void {
    this.deps.engine.command({ type: 'replay' });
    this.clock.onFlush();
    this.emit('replay', this.lastTurnId);
  }

  // ===========================================================================
  // Resume state
  // ===========================================================================

  /** The last few things said, in one line (for a tutor whose session had to start over). */
  private recentContext(): string {
    const said = this.transcript()
      .filter((c) => c.speaker !== 'system' && c.text.trim())
      .slice(-6)
      .map((c) => `${c.speaker === 'student' ? 'student' : 'you'}: "${c.text.replace(/\s+/g, ' ').trim().slice(0, 160)}"`);
    return said.length ? said.join('; ') : 'the session had just started';
  }

  protected saveResume(extra: Partial<ResumeState> = {}): void {
    const course = this.course;
    if (!course) return;
    const prev = this.deps.courses.getResume(course.id);
    const tail = this.transcript()
      .filter((c) => c.speaker !== 'system' && c.text.trim())
      .slice(-12)
      .map((c) => ({ speaker: c.speaker as 'student' | 'tutor', text: c.text }));
    const handle = this.link?.resumptionHandle;
    this.deps.courses.saveResume({
      courseId: course.id,
      savedAt: Date.now(),
      summary: prev?.summary ?? '',
      openQuestions: prev?.openQuestions ?? [],
      toReview: prev?.toReview ?? [],
      transcriptTail: tail.length ? tail : (prev?.transcriptTail ?? []),
      liveHandle: handle && !this.demoMode() ? { handle, savedAt: Date.now(), model: this.liveModel } : prev?.liveHandle,
      lastNotesFile: prev?.lastNotesFile,
      ...extra,
    });
  }

  // ===========================================================================
  // Tools available from phase 2
  // ===========================================================================

  private registerCoreTools(): void {
    this.tools.register('look_at_display', async (args) => {
      const n = Number(args.display);
      const d = this.deps.platform.displays.list().find((x) => x.index === n);
      if (!d) return { response: { ok: false, error: `There is no display ${n}.` } };
      this.switchDisplay(d, 'tutor');
      const f = await this.sendQuestionFrame(undefined, d.id);
      return { response: { ok: true, display: d.index, label: d.label, frame_sent: Boolean(f) }, scheduling: 'WHEN_IDLE' };
    });
    this.tools.register('media', async (args) => {
      if (args.action === 'resume') return { response: { ok: await this.resumeMedia() } };
      await this.autoPauseMedia();
      return { response: { ok: this.deps.platform.media.pausedByUs } };
    });
  }

  // ===========================================================================
  // API used by IPC (filled in by later phases)
  // ===========================================================================

  async validateAndStoreKey(key: string): Promise<{ ok: boolean; error?: string; models?: string[] }> {
    const k = key.trim();
    if (!k) return { ok: false, error: 'Paste a key first.' };
    const probe = new GeminiRest(() => k, env.restBase ?? GEMINI_API_BASE, () => undefined);
    try {
      const models = await probe.listModels();
      this.deps.settings.setApiKey(k);
      const missing = [this.settings.models.live, this.settings.models.vision].filter((m) => models.length && !models.includes(m));
      return { ok: true, models, ...(missing.length ? { error: `Saved. Note: ${missing.join(', ')} isn't listed for this key.` } : {}) };
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 0 || status === 408) {
        // Offline: store it anyway; it is validated on the first session.
        this.deps.settings.setApiKey(k);
        return { ok: true, error: 'Saved, but Gemini could not be reached to check it.' };
      }
      return { ok: false, error: status === 400 || status === 401 || status === 403 ? 'Google rejected that key.' : (e as Error).message };
    }
  }

  /** Re-read a course folder (the hub's refresh button, linking a folder). Returns at once. */
  indexCourse(id: string): IndexStatus {
    const c = this.deps.courses.get(id);
    if (!c) return { state: 'never', files: 0, chunks: 0, embedded: 0 };
    void this.coursework.brain.index(id);
    return { ...c.indexStatus, state: c.folder ? 'indexing' : 'never' };
  }

  courseFiles(id: string): CourseFile[] {
    const c = this.deps.courses.get(id);
    return c ? this.coursework.brain.files(c) : [];
  }

  searchCourse(id: string, q: string): SearchHit[] {
    return this.coursework.brain.searchKeywords(id, q, 8);
  }

  recentNotes(courseId: string): Promise<{ file: string; title: string; at: number }[]> {
    return this.sessionNotes.recent(courseId);
  }

  /** The last pointing-test report (Diagnostics, `npm run eval:grounding`). */
  lastCalibration: CalReport | null = null;

  /** Settings → Setup & checks → Pointing accuracy (see features/calibrate.ts). */
  async runPointingTest(): Promise<{ ok: boolean; error?: string; summary?: string }> {
    const r = await runCalibration(this);
    this.lastCalibration = r;
    if (!r.ok) return { ok: false, error: r.error };
    const mean = r.meanErrorPx === null ? 'n/a' : `${r.meanErrorPx.toFixed(1)} px`;
    return { ok: true, summary: `${r.hits}/${r.targets.length} targets hit · average error ${mean}${r.maxErrorPx !== null ? ` · worst ${Math.round(r.maxErrorPx)} px` : ''}` };
  }

  previewInk(): void {
    this.visual.previewInk();
  }

  openWhiteboard(): void {
    void this.whiteboard.open();
  }

  saveWhiteboardSnapshot(): void {}
}
