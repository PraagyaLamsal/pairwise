import { EventEmitter } from 'node:events';
import type { Course } from '@shared/courses';
import type { DisplayInfo } from '@shared/geometry';
import type { InkItem, OverlayUiState } from '@shared/ink';
import type { OverlayInit } from '@shared/ipc';
import { IDLE_SNAPSHOT, type Caption, type SessionCommand, type SessionSnapshot, type StartSessionRequest } from '@shared/session';
import type { Settings } from '@shared/settings';
import type { ShortcutAction } from '@shared/shortcuts';
import type { CourseStore } from '../courses/store';
import type { HotkeyService } from '../hotkeys';
import type { Platform } from '../platform';
import type { SettingsService } from '../settings';
import type { UsageMeter } from '../usage';
import type { EngineHost } from '../windows/engine';
import type { HudWindow } from '../windows/hud';
import { OverlayManager } from '../windows/overlays';
import { registry } from '../windows/registry';
import { CursorEngine } from './cursor';
import { InkManager } from './ink';
import { logger } from '../log';

const log = logger('session');

export interface SessionDeps {
  settings: SettingsService;
  courses: CourseStore;
  platform: Platform;
  engine: EngineHost;
  hud: HudWindow;
  hotkeys: HotkeyService;
  usage: UsageMeter;
}

/**
 * Owns one tutoring session end to end. Phase-specific features (voice, vision, ink, takeover,
 * course brain, notes …) hang off this controller and share its state and helpers.
 */
export class SessionController extends EventEmitter {
  readonly overlays: OverlayManager;
  readonly cursor: CursorEngine;
  readonly ink: InkManager;
  snapshot: SessionSnapshot = { ...IDLE_SNAPSHOT };
  course: Course | null = null;
  ui: OverlayUiState = { driving: false, visionPaused: false, sessionLive: false, veilOutlines: [] };
  protected runningSince = 0;
  protected tickTimer: NodeJS.Timeout | null = null;
  protected captions: Caption[] = [];

  constructor(readonly deps: SessionDeps) {
    super();
    this.overlays = new OverlayManager((d) => this.overlayInit(d));
    this.cursor = new CursorEngine(deps.platform.displays, deps.platform.hooks, { name: () => this.settings.tutorName });
    this.ink = new InkManager();

    this.cursor.on('frame', (f) => this.overlays.send('overlay:cursor', f));
    this.cursor.on('flight', (f) => this.overlays.send('overlay:flight', f));
    this.cursor.on('trace', (t) => this.overlays.send('overlay:trace', t));
    this.cursor.on('cancel', (c) => this.overlays.send('overlay:cursorCancel', c));
    this.ink.on('op', (op) => this.overlays.send('overlay:ink', op));
    this.overlays.on('ready', (displayId: string) => this.onOverlayReady(displayId));
    deps.platform.displays.on('changed', (ds: DisplayInfo[]) => {
      if (this.isActive) this.overlays.sync(ds);
    });
    deps.hotkeys.on('action', (a: ShortcutAction) => this.onShortcut(a));
  }

  get settings(): Settings {
    return this.deps.settings.get();
  }

  get isActive(): boolean {
    return this.snapshot.status !== 'idle' && this.snapshot.status !== 'error';
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(req: StartSessionRequest): Promise<{ ok: boolean; error?: string }> {
    if (this.isActive) {
      if (this.snapshot.courseId === req.courseId) return { ok: true };
      await this.end();
    }
    const course = this.deps.courses.get(req.courseId);
    if (!course) return { ok: false, error: 'That course no longer exists.' };
    const usage = this.deps.usage.summary();
    if (usage.blocked) {
      return { ok: false, error: `Monthly budget reached (${usage.monthUsd.toFixed(2)} of ${usage.limitUsd.toFixed(2)} USD). Raise the cap in Settings → Usage to continue.` };
    }

    this.course = course;
    this.captions = [];
    this.deps.usage.resetSession();
    this.deps.settings.update({ lastCourseId: course.id });
    const s = this.settings;
    this.update({
      ...IDLE_SNAPSHOT,
      status: 'starting',
      courseId: course.id,
      courseLabel: course.code,
      courseColor: course.color,
      startedAt: Date.now(),
      elapsedMs: 0,
      talkMode: s.talkMode,
      captions: s.captions,
      assignment: req.assignment,
      hudVisible: true,
      error: undefined,
    });
    log.info(`starting session for ${course.code}`);

    this.ui = { driving: false, visionPaused: false, sessionLive: true, veilOutlines: [] };
    this.overlays.sync(this.deps.platform.displays.list());
    this.deps.hud.show();
    this.cursor.start();
    this.deps.hotkeys.setSessionActive(true);
    this.runningSince = Date.now();
    this.tickTimer = setInterval(() => this.tick(), 1000);

    try {
      await this.onStart(req);
      if (this.snapshot.status === 'starting') this.update({ status: 'live' });
      this.pushUi();
      return { ok: true };
    } catch (e) {
      log.error('session start failed', e);
      const message = e instanceof Error ? e.message : String(e);
      await this.end({ reason: 'error', error: message });
      return { ok: false, error: message };
    }
  }

  async end(opts: { reason?: string; error?: string } = {}): Promise<void> {
    if (!this.isActive && this.snapshot.status !== 'error') return;
    const course = this.course;
    const durationMs = this.elapsed();
    this.update({ status: 'ending' });
    try {
      await this.onEnd(opts.reason ?? 'user');
    } catch (e) {
      log.error('error while ending session', e);
    }
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.cursor.stop();
    this.ink.clear();
    this.deps.hotkeys.setSessionActive(false);
    this.deps.hud.destroy();
    this.overlays.destroyAll();
    if (course) this.deps.courses.recordSession(course.id, durationMs);
    this.course = null;
    this.update({ ...IDLE_SNAPSHOT, status: opts.error ? 'error' : 'idle', error: opts.error, costUsd: this.deps.usage.sessionCost });
    if (opts.error) setTimeout(() => this.snapshot.status === 'error' && this.update({ status: 'idle' }), 8000);
    log.info(`session ended (${opts.reason ?? 'user'}) after ${Math.round(durationMs / 1000)}s`);
    this.emit('ended', opts.reason ?? 'user');
  }

  /** Hook for later phases: connect voice/vision etc. Throwing aborts the start. */
  protected async onStart(_req: StartSessionRequest): Promise<void> {}

  /** Hook for later phases: flush notes, close the live connection, … */
  protected async onEnd(_reason: string): Promise<void> {}

  // ---------------------------------------------------------------------------
  // Commands (HUD buttons, tray, shortcuts)
  // ---------------------------------------------------------------------------

  async command(cmd: SessionCommand): Promise<void> {
    if (!this.isActive) return;
    switch (cmd.type) {
      case 'toggleMute':
        this.setMuted(!this.snapshot.muted);
        break;
      case 'setMuted':
        this.setMuted(cmd.muted);
        break;
      case 'toggleVision':
        this.setVision(this.snapshot.vision === 'on' ? 'paused' : 'on');
        break;
      case 'toggleTalkMode': {
        const talkMode = this.snapshot.talkMode === 'hands-free' ? 'push-to-talk' : 'hands-free';
        this.deps.settings.update({ talkMode });
        this.update({ talkMode });
        this.onTalkModeChanged();
        break;
      }
      case 'toggleCaptions': {
        const captions = !this.snapshot.captions;
        this.deps.settings.update({ captions });
        this.update({ captions });
        break;
      }
      case 'toggleHud':
        this.update({ hudVisible: this.deps.hud.toggle() });
        break;
      case 'clearInk':
        this.ink.fade({});
        break;
      default:
        await this.onCommand(cmd);
    }
  }

  protected async onCommand(_cmd: SessionCommand): Promise<void> {}
  protected onTalkModeChanged(): void {}

  setMuted(muted: boolean): void {
    this.update({ muted });
    this.deps.engine.command({ type: 'setMuted', muted });
    this.toast(muted ? 'Microphone muted' : 'Microphone on', 'info');
  }

  setVision(vision: 'on' | 'paused'): void {
    this.update({ vision });
    this.ui.visionPaused = vision === 'paused';
    this.pushUi();
    this.onVisionChanged(vision);
  }

  protected onVisionChanged(_v: 'on' | 'paused'): void {}

  protected onShortcut(action: ShortcutAction): void {
    if (action === 'toggleSession') {
      if (this.isActive) void this.end();
      else {
        const id = this.settings.lastCourseId ?? this.deps.courses.list()[0]?.id;
        if (id) void this.start({ courseId: id, resume: true });
        else this.emit('needCourse');
      }
      return;
    }
    if (!this.isActive) {
      if (action === 'toggleWhiteboard') this.emit('openWhiteboard');
      return;
    }
    const map: Partial<Record<ShortcutAction, SessionCommand>> = {
      toggleMute: { type: 'toggleMute' },
      toggleVision: { type: 'toggleVision' },
      toggleWhiteboard: { type: 'toggleWhiteboard' },
      replay: { type: 'replay' },
      clearInk: { type: 'clearInk' },
      grantControl: { type: 'grantControl' },
      pauseResumeMedia: { type: 'toggleMedia' },
      toggleHud: { type: 'toggleHud' },
      toggleCaptions: { type: 'toggleCaptions' },
      toggleTalkMode: { type: 'toggleTalkMode' },
      drawToggle: { type: 'drawToggle' },
    };
    const cmd = map[action];
    if (cmd) void this.command(cmd);
  }

  // ---------------------------------------------------------------------------
  // State helpers shared with features
  // ---------------------------------------------------------------------------

  update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, elapsedMs: patch.elapsedMs ?? this.elapsed() };
    registry.send(['hub', 'hud', 'whiteboard'], 'session:snapshot', this.snapshot);
    this.emit('snapshot', this.snapshot);
  }

  elapsed(): number {
    if (!this.snapshot.startedAt) return 0;
    return Date.now() - this.snapshot.startedAt;
  }

  protected tick(): void {
    if (!this.isActive) return;
    this.update({ costUsd: this.deps.usage.sessionCost });
    this.onTick();
  }

  protected onTick(): void {}

  caption(c: Caption): void {
    const idx = this.captions.findIndex((x) => x.id === c.id);
    if (idx >= 0) this.captions[idx] = c;
    else this.captions.push(c);
    if (this.captions.length > 400) this.captions.splice(0, this.captions.length - 400);
    registry.send(['hud', 'whiteboard'], 'session:caption', c);
    this.emit('caption', c);
  }

  transcript(): Caption[] {
    return [...this.captions];
  }

  pushUi(): void {
    this.overlays.send('overlay:ui', this.ui);
  }

  toast(text: string, tone: 'info' | 'warn' | 'success' = 'info', ms = 2200, displayId?: string): void {
    this.ui.toast = { id: `t${Date.now()}`, text, tone, until: Date.now() + ms, displayId };
    this.pushUi();
  }

  addInk(items: InkItem[]): void {
    this.ink.add(items);
  }

  protected onOverlayReady(displayId: string): void {
    // A (re)created overlay must see the current scene.
    if (this.isActive) this.overlays.send('overlay:cursor', this.cursor.currentFrame(), displayId);
    const live = this.ink.live();
    if (live.length) this.overlays.send('overlay:ink', { op: 'add', items: live }, displayId);
    this.overlays.send('overlay:ui', this.ui, displayId);
  }

  overlayInit(display: DisplayInfo): OverlayInit {
    const s = this.settings;
    return {
      display,
      displays: this.deps.platform.displays.list(),
      tutorName: s.tutorName,
      tutorColor: s.tutorColor,
      studentColor: s.studentInkColor,
      platform: process.platform,
      reducedMotion: false,
    };
  }

  /** Display the tutor should look at: where the student's pointer is. */
  activeDisplay(): DisplayInfo {
    const displays = this.deps.platform.displays.list();
    const p = this.deps.platform.displays.cursor();
    return displays.find((d) => p.x >= d.bounds.x && p.y >= d.bounds.y && p.x < d.bounds.x + d.bounds.width && p.y < d.bounds.y + d.bounds.height) ?? this.deps.platform.displays.primary();
  }
}
