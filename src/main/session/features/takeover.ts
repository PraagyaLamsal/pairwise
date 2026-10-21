import { ipcMain } from 'electron';
import { rectCenter, type Point, type Rect } from '@shared/geometry';
import { inkId, type ConsentCardState } from '@shared/ink';
import { formatAccelerator } from '@shared/shortcuts';
import type { KeyEvt, MouseEvt } from '../../platform/types';
import type { TutorSession } from '../tutor';
import { riskOf, spokenConsent, SyntheticTracker, type ControlAction } from '../takeover-rules';
import { logger } from '../../log';

const log = logger('takeover');

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

const CONSENT_MS = 20_000;
const ACTION_TYPES = new Set(['click', 'double_click', 'right_click', 'move', 'type', 'key', 'scroll', 'drag']);

type Decision = { allowed: boolean; how: string };

/**
 * Phase 5: the tutor demonstrates with the student's mouse and keyboard — only with consent,
 * always visibly, and the student can take it back instantly.
 *
 *  - request_control shows a consent card (button, ⌃⌥G, or saying "yes"/"no"); nothing happens
 *    without an explicit yes, and the ask expires after 20 s.
 *  - While driving: a glowing frame + "Ada is driving" banner on every display, the buddy rides
 *    the real pointer, and every action glides visibly.
 *  - Risky actions (submit, send, delete, run a command, buy …) need a separate yes on screen
 *    every time, whatever the tutor said.
 *  - Any real mouse movement, click, scroll or key press — or Esc — reclaims at once: the
 *    current action is aborted mid-way (mouse buttons released) and the tutor is told.
 *  - Control lapses after a quiet spell (Settings → takeover → auto-revoke).
 */
export class TakeoverFeature {
  private pending: { id: string; kind: ConsentCardState['kind']; resolve: (d: Decision) => void; timer: NodeJS.Timeout; since: number; base: string } | null = null;
  private lastStudentText = '';
  private driving = false;
  private actionCtrl: AbortController | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private buttonDown: 'left' | 'right' | null = null;
  private seq = 0;
  readonly tracker = new SyntheticTracker();
  private detachHooks: (() => void) | null = null;
  /** Last time the tutor did something with control (for auto-revoke). */
  private lastAction = 0;

  constructor(private readonly s: TutorSession) {
    ipcMain.on('overlay:consent', (_e, m: { id: string; decision: 'allow' | 'deny' }) => {
      if (this.pending && m.id === this.pending.id) this.decide({ allowed: m.decision === 'allow', how: m.decision === 'allow' ? 'clicked allow' : 'clicked not now' });
    });
    s.on('studentWords', (text: string) => {
      const before = this.lastStudentText;
      this.lastStudentText = text;
      if (!this.pending || this.pending.kind !== 'control') return;
      // Only words said since the card appeared count (the caption may hold earlier ones).
      const base = this.pending.base;
      const fresh = base && text.startsWith(base) ? text.slice(base.length) : before && text.startsWith(before) && base === before ? text.slice(before.length) : text;
      const v = spokenConsent(fresh);
      if (v) this.decide({ allowed: v === 'yes', how: `said "${fresh.trim().slice(-40)}"` });
    });
    s.on('ended', () => {
      this.decide({ allowed: false, how: 'session ended' });
      this.stopDriving('session ended', false);
    });
    this.register();
  }

  get isDriving(): boolean {
    return this.driving;
  }

  /** Session commands: ⌃⌥G / HUD buttons. */
  command(type: 'grantControl' | 'denyControl' | 'reclaim'): void {
    if (type === 'grantControl' && this.pending) this.decide({ allowed: true, how: 'pressed the allow shortcut' });
    else if (type === 'denyControl' && this.pending) this.decide({ allowed: false, how: 'declined' });
    else if (type === 'reclaim' && this.driving) this.reclaim('clicked take back');
  }

  // ---------------------------------------------------------------------------
  // Consent
  // ---------------------------------------------------------------------------

  private ask(kind: ConsentCardState['kind'], title: string, detail: string, action?: string, near?: Point): Promise<Decision> {
    this.decide({ allowed: false, how: 'replaced by a new request' });
    const id = `consent-${++this.seq}`;
    const hotkey = kind === 'control' ? formatAccelerator(this.s.settings.shortcuts.grantControl, process.platform) : undefined;
    // Keep the card off what it's asking about (the student should see the button in question).
    const display = near ? (this.s.deps.platform.displays.list().find((d) => near.x >= d.bounds.x && near.x < d.bounds.x + d.bounds.width && near.y >= d.bounds.y && near.y < d.bounds.y + d.bounds.height) ?? this.s.activeDisplay()) : this.s.activeDisplay();
    const anchor: 'top' | 'bottom' = near && near.y - display.bounds.y < display.bounds.height * 0.45 ? 'bottom' : 'top';
    this.s.ui.consent = { id, kind, title, detail, action, hotkey, expiresAt: Date.now() + CONSENT_MS, displayId: display.id, anchor };
    this.s.pushUi();
    if (kind === 'control') this.s.update({ driving: 'requested' });
    if (this.s.settings.sounds) this.s.deps.engine.command({ type: 'chime', kind: 'grant' });
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.decide({ allowed: false, how: 'no answer within 20 seconds' }), CONSENT_MS);
      this.pending = { id, kind, resolve, timer, since: Date.now(), base: this.lastStudentText };
    });
  }

  private decide(d: Decision): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (this.s.ui.consent?.id === p.id) {
      this.s.ui.consent = undefined;
      this.s.pushUi();
    }
    if (p.kind === 'control' && !this.driving) this.s.update({ driving: 'none' });
    log.info(`${p.kind}: ${d.allowed ? 'allowed' : 'denied'} (${d.how})`);
    p.resolve(d);
  }

  // ---------------------------------------------------------------------------
  // Driving
  // ---------------------------------------------------------------------------

  private startDriving(): void {
    this.driving = true;
    this.tracker.reset();
    const tutor = this.s.settings.tutorName;
    this.s.ui.driving = true;
    this.s.ui.drivingLabel = `${tutor} is driving`;
    this.s.pushUi();
    this.s.update({ driving: 'driving' });
    this.s.cursor.setDriving(true);
    this.s.visual.cancelPending('takeover');
    // The student must be able to take over with the very first real input event.
    const hooks = this.s.deps.platform.hooks;
    const onMove = (e: MouseEvt) => {
      if (!this.driving) return;
      const p = { x: e.x, y: e.y };
      if (this.tracker.isOurMove(p, e.time)) return;
      const last = this.tracker.lastMove;
      if (last && Math.abs(last.x - p.x) <= 2 && Math.abs(last.y - p.y) <= 2) return; // sub-pixel jitter
      this.reclaim('moved the mouse');
    };
    const onDown = (e: MouseEvt) => {
      if (this.driving && !this.tracker.isOurButton(e.time)) this.reclaim('clicked');
    };
    const onWheel = (e: MouseEvt) => {
      if (this.driving && !this.tracker.isOurButton(e.time)) this.reclaim('scrolled');
    };
    const onKey = (e: KeyEvt) => {
      if (!this.driving) return;
      if (e.key === 'Escape' || e.key === 'Esc') return this.reclaim('pressed Esc');
      if (!this.tracker.isOurKey(e.time)) this.reclaim('typed');
    };
    hooks.on('mousemove', onMove);
    hooks.on('mousedown', onDown);
    hooks.on('wheel', onWheel);
    hooks.on('keydown', onKey);
    this.detachHooks = () => {
      hooks.off('mousemove', onMove);
      hooks.off('mousedown', onDown);
      hooks.off('wheel', onWheel);
      hooks.off('keydown', onKey);
    };
    this.lastAction = Date.now();
    this.armIdle();
  }

  private armIdle(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      if (!this.driving || this.actionCtrl) return;
      const limit = Math.max(5, this.s.settings.takeover.autoRevokeSec) * 1000;
      if (Date.now() - this.lastAction > limit) {
        this.stopDriving('idle', true);
        this.s.note(`[Control went back to the student automatically after ${Math.round(limit / 1000)} s without any actions. Ask again if you still need it.]`);
      }
    }, 500);
  }

  /** The student took control back. Stops everything within this event. */
  reclaim(how: string): void {
    if (!this.driving) return;
    log.info(`student reclaimed control (${how})`);
    this.stopDriving(`student ${how}`, true);
    if (this.s.settings.sounds) this.s.deps.engine.command({ type: 'chime', kind: 'reclaim' });
    this.s.toast('You have control', 'success', 2200);
    this.s.note(`[The student took back control of the mouse and keyboard (${how}). Stop demonstrating — guide them with your cursor and words instead.]`);
  }

  private stopDriving(why: string, announce: boolean): void {
    if (!this.driving) return;
    this.driving = false;
    this.actionCtrl?.abort();
    this.actionCtrl = null;
    // Never leave a button held down.
    if (this.buttonDown) {
      try {
        this.s.deps.platform.driver.up(this.buttonDown);
      } catch {
        /* ignore */
      }
      this.buttonDown = null;
    }
    this.detachHooks?.();
    this.detachHooks = null;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.s.ui.driving = false;
    this.s.ui.drivingLabel = undefined;
    this.s.pushUi();
    this.s.update({ driving: 'none' });
    // Her cursor stays where she last drove to (the student's hand has moved on from there).
    this.s.cursor.setDriving(false, this.tracker.lastMove ?? undefined);
    if (announce) log.info(`control released: ${why}`);
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private register(): void {
    const t = this.s.tools;

    t.register('request_control', async (args, _call, signal) => {
      const reason = str(args.reason) || 'show you how';
      const s = this.s.settings;
      if (!s.takeover.enabled) return { response: { granted: false, note: 'Taking control is turned off in Settings. Guide them with your cursor instead.' } };
      if (this.driving) return { response: { granted: true, note: 'You already have control.' } };
      const p = this.s.deps.platform;
      if (!p.driver.available) return { response: { granted: false, note: 'Mouse/keyboard control is not available on this computer. Guide them instead.' } };
      if (!p.hooks.running && !p.hooks.start()) {
        return { response: { granted: false, note: 'Taking control needs the Accessibility permission (so the student can take it back instantly). Guide them instead, and mention they can enable it in Pairwise → Setup & checks.' } };
      }
      if (this.s.snapshot.assignment) {
        // Still allowed (e.g. to open a menu), but the rules of assignment mode apply to every action.
      }
      const d = await this.ask('control', `${s.tutorName} wants to show you`, reason.charAt(0).toUpperCase() + reason.slice(1));
      if (signal.aborted) return { response: { granted: false } };
      if (d.allowed) this.startDriving();
      return {
        response: d.allowed
          ? { granted: true, how: d.how, note: 'You have control now. Narrate briefly while you act; call release_control as soon as you are done. Before submitting, sending, deleting or running anything, ask out loud first.' }
          : { granted: false, how: d.how, note: 'They said no (or did not answer). Guide them with your cursor and words instead.' },
        scheduling: 'WHEN_IDLE',
      };
    });

    t.register('control', async (args, _call, signal) => {
      if (!this.driving) return { response: { ok: false, error: 'You do not have control. Call request_control first and wait for the answer.' } };
      const actions = (Array.isArray(args.actions) ? (args.actions as ControlAction[]) : []).filter((a) => a && ACTION_TYPES.has(a.type)).slice(0, 8);
      if (!actions.length) return { response: { ok: false, error: 'No actions given.' } };
      const explain = str(args.explain);
      if (explain) this.s.ui.drivingLabel = `${this.s.settings.tutorName}: ${explain.slice(0, 80)}`;
      this.s.pushUi();
      this.actionCtrl?.abort();
      const ctrl = new AbortController();
      this.actionCtrl = ctrl;
      signal.addEventListener('abort', () => ctrl.abort());
      const done: string[] = [];
      let typedBefore = '';
      try {
        for (const a of actions) {
          if (ctrl.signal.aborted || !this.driving) break;
          if (this.s.snapshot.assignment && (a.type === 'type' || (a.type === 'key' && (a.keys ?? []).some((k) => /^(v|x)$/i.test(k))))) {
            return { response: { ok: false, done, stopped: 'Assignment mode: you must not type or paste into their work. Explain what to type instead.' } };
          }
          const front = await this.s.deps.platform.frontmostApp().catch(() => null);
          const risk = riskOf(a, { typedBefore, frontApp: front?.name, explain });
          let at: Point | null = null;
          if (risk) {
            // Show exactly what would be clicked: pointer on it, a ring around it, then ask.
            let ring: string | null = null;
            if (a.target && (a.type === 'click' || a.type === 'double_click' || a.type === 'right_click')) {
              const found = await this.locateRect(a.target, ctrl.signal);
              if (found) {
                at = rectCenter(found);
                await this.glide(at, ctrl.signal);
                ring = inkId('ask');
                this.s.addInk([{ id: ring, author: 'tutor', kind: 'ring', color: '#E5484D', surface: 'screen', rect: found, revealAt: Date.now(), drawMs: 700, fadeAt: null, seed: 5, group: 'consent' }]);
              } else return { response: { ok: false, done, stopped: `Could not find ${a.target} on screen.` } };
            }
            const d = await this.ask('risky-action', 'Allow this action?', explain || `${this.s.settings.tutorName} wants to ${risk}.`, risk.charAt(0).toUpperCase() + risk.slice(1), at ?? undefined);
            if (ring) this.s.ink.fade({ ids: [ring] });
            if (!d.allowed || ctrl.signal.aborted || !this.driving) {
              return { response: { ok: false, done, stopped: `The student did not allow: ${risk} (${d.how}). Do not try again without asking out loud.` }, scheduling: 'WHEN_IDLE' };
            }
          }
          const r = await this.perform(a, ctrl.signal, at);
          if (r) done.push(r);
          if (a.type === 'type' && a.text) typedBefore += a.text;
          this.lastAction = Date.now();
          await sleep(220, ctrl.signal);
        }
      } finally {
        if (this.actionCtrl === ctrl) this.actionCtrl = null;
        this.lastAction = Date.now();
        if (this.driving) {
          this.s.ui.drivingLabel = `${this.s.settings.tutorName} is driving`;
          this.s.pushUi();
        }
      }
      if (!this.driving || ctrl.signal.aborted) return { response: { ok: false, done, stopped: 'The student took back control. Stop demonstrating.' }, scheduling: 'WHEN_IDLE' };
      // Let the tutor see the result of what it did.
      void this.s.sendQuestionFrame();
      return { response: { ok: true, done }, scheduling: 'WHEN_IDLE' };
    });

    t.register('release_control', async () => {
      const was = this.driving;
      this.decide({ allowed: false, how: 'released' });
      this.stopDriving('released by the tutor', true);
      if (was) this.s.toast('You have control', 'success', 2000);
      return { response: { ok: true } };
    });
  }

  /** Where an action's target is (grounded like point_at). */
  private async locateRect(desc: string | undefined, signal: AbortSignal): Promise<Rect | null> {
    if (!desc) return null;
    const display = this.s.visual.displayFor({});
    const [r] = await this.s.visual.grounder.locate(display.id, [{ id: 't', description: desc, control: true }], this.s.modelFrame, signal);
    if (!r?.found || !r.rect || r.via === 'approx') return null;
    return r.rect;
  }

  private async locate(desc: string | undefined, signal: AbortSignal): Promise<Point | null> {
    const r = await this.locateRect(desc, signal);
    return r ? rectCenter(r) : null;
  }

  /** Move the real pointer there visibly (a short eased glide), every step marked as ours. */
  private async glide(to: Point, signal: AbortSignal): Promise<void> {
    const d = this.s.deps.platform.driver;
    const from = d.mousePos();
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.min(28, Math.round(dist / 22)));
    const ms = Math.min(520, 160 + dist * 0.45);
    for (let i = 1; i <= steps; i++) {
      if (signal.aborted || !this.driving) return;
      const k = i / steps;
      const e = k * k * (3 - 2 * k);
      const p = { x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e) };
      this.tracker.noteMove(p);
      d.move(p);
      await sleep(ms / steps, signal);
    }
  }

  private async perform(a: ControlAction, signal: AbortSignal, at: Point | null = null): Promise<string | null> {
    const d = this.s.deps.platform.driver;
    switch (a.type) {
      case 'move':
      case 'click':
      case 'double_click':
      case 'right_click': {
        const p = at ?? (await this.locate(a.target, signal));
        if (signal.aborted) return null;
        if (a.target && !p) return `could not find ${a.target}`;
        if (p) await this.glide(p, signal);
        if (signal.aborted || !this.driving || a.type === 'move') return a.type === 'move' ? `moved to ${a.target ?? 'the pointer'}` : null;
        this.tracker.noteButtons(200);
        if (a.type === 'right_click') d.click('right');
        else d.click('left', a.type === 'double_click');
        return `${a.type.replace('_', ' ')} ${a.target ?? 'at the pointer'}`;
      }
      case 'drag': {
        const p = await this.locate(a.target, signal);
        const q = await this.locate(a.to_target, signal);
        if (!p || !q || signal.aborted) return `could not find ${!p ? a.target : a.to_target}`;
        await this.glide(p, signal);
        if (signal.aborted || !this.driving) return null;
        this.tracker.noteButtons(2000);
        d.down('left');
        this.buttonDown = 'left';
        await this.glide(q, signal);
        d.up('left');
        this.buttonDown = null;
        return `dragged ${a.target} to ${a.to_target}`;
      }
      case 'type': {
        const text = a.text ?? '';
        if (a.target) {
          const p = await this.locate(a.target, signal);
          if (p) {
            await this.glide(p, signal);
            this.tracker.noteButtons(200);
            d.click('left');
            await sleep(120, signal);
          }
        }
        const cps = Math.max(4, Math.min(60, this.s.settings.takeover.typingCharsPerSecond));
        let n = 0;
        for (const ch of text) {
          if (signal.aborted || !this.driving) break;
          this.tracker.noteKeys(1000 / cps + 60);
          d.typeChar(ch);
          n++;
          await sleep(1000 / cps, signal);
        }
        return `typed ${n === text.length ? `“${text.slice(0, 40)}”` : `${n} of ${text.length} characters (stopped)`}`;
      }
      case 'key': {
        const keys = (a.keys ?? []).map((k) => k.toLowerCase());
        const mods = keys.filter((k) => ['cmd', 'command', 'meta', 'ctrl', 'control', 'alt', 'option', 'opt', 'shift'].includes(k));
        const main = keys.filter((k) => !mods.includes(k));
        if (!main.length) return null;
        this.tracker.noteKeys(150 * main.length);
        for (const k of main) d.keyTap(k, mods);
        return `pressed ${keys.join('+')}`;
      }
      case 'scroll': {
        if (a.target) {
          const p = await this.locate(a.target, signal);
          if (p) await this.glide(p, signal);
        }
        const amt = Math.max(1, Math.min(10, a.amount ?? 3)) * 3;
        const dir = a.direction ?? 'down';
        this.tracker.noteButtons(300);
        d.scroll(dir === 'left' ? -amt : dir === 'right' ? amt : 0, dir === 'up' ? amt : dir === 'down' ? -amt : 0);
        return `scrolled ${dir}`;
      }
    }
    return null;
  }
}
