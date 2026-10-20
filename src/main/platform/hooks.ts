import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { InputHooks, KeyEvt, MouseEvt } from './types';
import { logger } from '../log';

const log = logger('hooks');
const req = createRequire(__filename);

interface UiohookModule {
  uIOhook: EventEmitter & { start(): void; stop(): void };
  UiohookKey: Record<string, number>;
}

const MODIFIER_NAMES: Record<string, string> = {
  Ctrl: 'Control', CtrlRight: 'Control',
  Alt: 'Alt', AltRight: 'Alt',
  Shift: 'Shift', ShiftRight: 'Shift',
  Meta: 'Command', MetaRight: 'Command',
};

/** Global keyboard + mouse observation through uiohook-napi (prebuilt, N-API). */
export class UiohookInput extends EventEmitter implements InputHooks {
  private mod: UiohookModule | null = null;
  private keyNames = new Map<number, string>();
  private _running = false;

  constructor() {
    super();
    try {
      this.mod = req('uiohook-napi') as UiohookModule;
      for (const [name, code] of Object.entries(this.mod.UiohookKey)) {
        if (typeof code === 'number') this.keyNames.set(code, MODIFIER_NAMES[name] ?? (name === 'Enter' ? 'Enter' : name));
      }
    } catch (e) {
      log.warn('uiohook-napi unavailable; hold-to-talk falls back to toggle shortcuts', e);
      this.mod = null;
    }
  }

  get available(): boolean {
    return this.mod !== null;
  }

  get running(): boolean {
    return this._running;
  }

  start(): boolean {
    if (!this.mod || this._running) return this._running;
    const hook = this.mod.uIOhook;
    hook.on('keydown', (e: RawKey) => this.emit('keydown', this.key(e)));
    hook.on('keyup', (e: RawKey) => this.emit('keyup', this.key(e)));
    hook.on('mousemove', (e: RawMouse) => this.emit('mousemove', mouse(e)));
    hook.on('mousedown', (e: RawMouse) => this.emit('mousedown', mouse(e)));
    hook.on('wheel', (e: RawMouse) => this.emit('wheel', mouse(e)));
    try {
      hook.start();
      this._running = true;
      log.info('global input hooks started');
    } catch (e) {
      log.warn('could not start input hooks (Accessibility permission?)', e);
      hook.removeAllListeners();
      this._running = false;
    }
    return this._running;
  }

  stop(): void {
    if (!this.mod || !this._running) return;
    try {
      this.mod.uIOhook.stop();
    } catch {
      /* ignore */
    }
    this.mod.uIOhook.removeAllListeners();
    this._running = false;
  }

  private key(e: RawKey): KeyEvt {
    return {
      keycode: e.keycode,
      key: this.keyNames.get(e.keycode) ?? `Key${e.keycode}`,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
      time: Date.now(),
    };
  }
}

interface RawKey {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}
interface RawMouse {
  x: number;
  y: number;
  button?: unknown;
}

const mouse = (e: RawMouse): MouseEvt => ({ x: e.x, y: e.y, time: Date.now(), button: typeof e.button === 'number' ? e.button : undefined });

/** Test double: tests and the e2e harness emit events on it directly. */
export class FakeHooks extends EventEmitter implements InputHooks {
  private _running = false;
  readonly available = true;
  get running(): boolean {
    return this._running;
  }
  start(): boolean {
    this._running = true;
    return true;
  }
  stop(): void {
    this._running = false;
  }
}
