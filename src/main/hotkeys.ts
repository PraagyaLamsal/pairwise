import { EventEmitter } from 'node:events';
import { globalShortcut } from 'electron';
import { isChordOnly, parseAccelerator, type Modifier, type ShortcutAction } from '@shared/shortcuts';
import type { InputHooks, KeyEvt } from './platform/types';
import { logger } from './log';

const log = logger('hotkeys');

/** Actions that stay registered even when no session is running. */
const ALWAYS: ShortcutAction[] = ['toggleSession', 'toggleWhiteboard'];
const HOLD_ACTIVATE_MS = 140;
const MOD_KEYS = new Set(['Control', 'Alt', 'Shift', 'Command']);

/**
 * Global shortcuts. "Press" actions use Electron's globalShortcut; the hold-chord ("ask": hold
 * ⌃⌥ to talk and draw) needs key-up events, so it is detected from uiohook. Without uiohook
 * (no Accessibility permission yet) the chord falls back to a press-to-toggle shortcut.
 *
 * Emits: 'action' (ShortcutAction) · 'ask' ('start' | 'end' | 'cancel') · 'escape' · 'enter'
 */
export class HotkeyService extends EventEmitter {
  private bindings: Record<ShortcutAction, string>;
  private sessionActive = false;
  private registered: string[] = [];
  private failed: ShortcutAction[] = [];
  private held = new Set<Modifier>();
  private chordTimer: NodeJS.Timeout | null = null;
  private chordActive = false;
  private chordSpoiled = false;
  private fallbackAskOn = false;
  private hooksAttached = false;

  constructor(bindings: Record<ShortcutAction, string>, private readonly hooks: InputHooks) {
    super();
    this.bindings = { ...bindings };
  }

  /** Whether the hold chord works natively (else the toggle fallback is used). */
  get holdSupported(): boolean {
    return this.hooks.running;
  }

  get failedBindings(): ShortcutAction[] {
    return [...this.failed];
  }

  fallbackAskAccelerator(): string {
    return `${this.bindings.ask}+Space`;
  }

  setBindings(bindings: Record<ShortcutAction, string>): void {
    this.bindings = { ...bindings };
    this.apply();
  }

  setSessionActive(active: boolean): void {
    this.sessionActive = active;
    if (!active) this.resetChord();
    this.apply();
  }

  attachHooks(): void {
    if (this.hooksAttached) return;
    this.hooksAttached = true;
    this.hooks.on('keydown', (e: KeyEvt) => this.onKeyDown(e));
    this.hooks.on('keyup', (e: KeyEvt) => this.onKeyUp(e));
    this.apply();
  }

  apply(): void {
    for (const acc of this.registered) globalShortcut.unregister(acc);
    this.registered = [];
    this.failed = [];
    for (const [action, acc] of Object.entries(this.bindings) as [ShortcutAction, string][]) {
      if (!acc || isChordOnly(acc)) continue;
      if (!this.sessionActive && !ALWAYS.includes(action)) continue;
      this.register(acc, () => this.emit('action', action), action);
    }
    // Hold-to-ask fallback when global key-up events are unavailable.
    if (this.sessionActive && !this.hooks.running && isChordOnly(this.bindings.ask)) {
      this.register(this.fallbackAskAccelerator(), () => {
        this.fallbackAskOn = !this.fallbackAskOn;
        this.emit('ask', this.fallbackAskOn ? 'start' : 'end');
      }, 'ask');
    }
  }

  /** Temporarily capture Esc / Return (draw-toggle mode, takeover) when hooks are not running. */
  captureEscapeAndEnter(on: boolean): void {
    for (const key of ['Escape', 'Return']) {
      if (on) {
        if (!globalShortcut.isRegistered(key)) {
          globalShortcut.register(key, () => this.emit(key === 'Escape' ? 'escape' : 'enter'));
        }
      } else if (globalShortcut.isRegistered(key)) {
        globalShortcut.unregister(key);
      }
    }
  }

  private register(acc: string, fn: () => void, action: ShortcutAction): void {
    try {
      if (globalShortcut.register(acc, fn)) this.registered.push(acc);
      else {
        this.failed.push(action);
        log.warn(`shortcut ${acc} for ${action} is taken by another app`);
      }
    } catch (e) {
      this.failed.push(action);
      log.warn(`invalid accelerator ${acc} for ${action}`, e);
    }
  }

  // --- hold chord detection -------------------------------------------------

  private chordMods(): Set<Modifier> {
    return parseAccelerator(this.bindings.ask).modifiers;
  }

  private onKeyDown(e: KeyEvt): void {
    if (e.key === 'Escape') {
      if (this.chordActive) {
        this.chordActive = false;
        this.emit('ask', 'cancel');
      }
      this.emit('escape');
      return;
    }
    if (e.key === 'Enter') this.emit('enter');
    if (MOD_KEYS.has(e.key)) {
      this.held.add(e.key as Modifier);
    } else {
      // Any real key while the chord is down means "this is a shortcut, not a question".
      if (this.held.size > 0) this.chordSpoiled = true;
      if (this.chordActive) {
        this.chordActive = false;
        this.emit('ask', 'cancel');
      }
      if (this.chordTimer) {
        clearTimeout(this.chordTimer);
        this.chordTimer = null;
      }
      return;
    }
    if (!this.sessionActive || !isChordOnly(this.bindings.ask)) return;
    const want = this.chordMods();
    const exact = want.size === this.held.size && [...want].every((m) => this.held.has(m));
    if (exact && !this.chordActive && !this.chordTimer && !this.chordSpoiled) {
      this.chordTimer = setTimeout(() => {
        this.chordTimer = null;
        if (!this.chordSpoiled && this.sameAsChord()) {
          this.chordActive = true;
          this.emit('ask', 'start');
        }
      }, HOLD_ACTIVATE_MS);
    } else if (!exact && this.chordActive) {
      // Extra modifier pressed while asking: keep the question going (Shift = straight lines).
    }
  }

  private onKeyUp(e: KeyEvt): void {
    if (!MOD_KEYS.has(e.key)) return;
    this.held.delete(e.key as Modifier);
    const want = this.chordMods();
    if (want.has(e.key as Modifier)) {
      if (this.chordTimer) {
        clearTimeout(this.chordTimer);
        this.chordTimer = null;
      }
      if (this.chordActive) {
        this.chordActive = false;
        this.emit('ask', 'end');
      }
    }
    if (this.held.size === 0) this.chordSpoiled = false;
  }

  private sameAsChord(): boolean {
    const want = this.chordMods();
    return [...want].every((m) => this.held.has(m));
  }

  private resetChord(): void {
    if (this.chordTimer) clearTimeout(this.chordTimer);
    this.chordTimer = null;
    this.chordActive = false;
    this.chordSpoiled = false;
    this.fallbackAskOn = false;
    this.held.clear();
  }

  dispose(): void {
    this.resetChord();
    globalShortcut.unregisterAll();
    this.registered = [];
  }
}
