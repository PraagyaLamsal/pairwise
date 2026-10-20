import { createRequire } from 'node:module';
import type { Point } from '@shared/geometry';
import type { InputDriver, MouseButton } from './types';
import { logger } from '../log';

const log = logger('driver');
const req = createRequire(__filename);

interface Robot {
  setMouseDelay(ms: number): void;
  setKeyboardDelay(ms: number): void;
  moveMouse(x: number, y: number): void;
  mouseToggle(down?: string, button?: string): void;
  mouseClick(button?: string, double?: boolean): void;
  scrollMouse(x: number, y: number): void;
  keyTap(key: string, modifier?: string | string[]): void;
  typeString(s: string): void;
  getMousePos(): { x: number; y: number };
}

/** robotjs key names for the keys the tutor may press. */
const KEY_MAP: Record<string, string> = {
  enter: 'enter', return: 'enter', tab: 'tab', escape: 'escape', esc: 'escape', space: 'space',
  backspace: 'backspace', delete: 'delete', up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown',
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6', f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12',
};
const MOD_MAP: Record<string, string> = {
  cmd: 'command', command: 'command', meta: 'command', super: 'command',
  ctrl: 'control', control: 'control', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift',
};

export function robotKey(key: string): string {
  const k = key.trim().toLowerCase();
  return KEY_MAP[k] ?? (k.length === 1 ? k : k);
}

export function robotModifiers(mods: string[] = []): string[] {
  return mods.map((m) => MOD_MAP[m.trim().toLowerCase()]).filter((m): m is string => Boolean(m));
}

/** Synthetic mouse/keyboard via @jitsi/robotjs (CGEvent on macOS, prebuilt universal binary). */
export class RobotDriver implements InputDriver {
  private robot: Robot | null = null;

  constructor() {
    try {
      this.robot = req('@jitsi/robotjs') as Robot;
      this.robot.setMouseDelay(0);
      this.robot.setKeyboardDelay(0);
    } catch (e) {
      log.warn('@jitsi/robotjs unavailable; takeover disabled', e);
    }
  }

  get available(): boolean {
    return this.robot !== null;
  }

  private r(): Robot {
    if (!this.robot) throw new Error('Input driver unavailable');
    return this.robot;
  }

  mousePos(): Point {
    return this.r().getMousePos();
  }

  move(p: Point): void {
    this.r().moveMouse(Math.round(p.x), Math.round(p.y));
  }

  down(button: MouseButton = 'left'): void {
    this.r().mouseToggle('down', button);
  }

  up(button: MouseButton = 'left'): void {
    this.r().mouseToggle('up', button);
  }

  click(button: MouseButton = 'left', double = false): void {
    this.r().mouseClick(button, double);
  }

  scroll(dx: number, dy: number): void {
    this.r().scrollMouse(Math.round(dx), Math.round(dy));
  }

  keyTap(key: string, modifiers: string[] = []): void {
    const mods = robotModifiers(modifiers);
    this.r().keyTap(robotKey(key), mods.length ? mods : undefined);
  }

  typeChar(ch: string): void {
    if (ch === '\n') this.r().keyTap('enter');
    else if (ch === '\t') this.r().keyTap('tab');
    else this.r().typeString(ch);
  }

  mediaPlayPause(): void {
    this.r().keyTap('audio_play');
  }
}

export type DriverAction =
  | { t: 'move'; p: Point }
  | { t: 'down' | 'up'; button: MouseButton }
  | { t: 'click'; button: MouseButton; double: boolean }
  | { t: 'scroll'; dx: number; dy: number }
  | { t: 'key'; key: string; modifiers: string[] }
  | { t: 'char'; ch: string }
  | { t: 'media' };

/** Records actions instead of performing them (tests, fake platform). */
export class RecordingDriver implements InputDriver {
  readonly available = true;
  readonly actions: DriverAction[] = [];
  private pos: Point = { x: 0, y: 0 };

  mousePos(): Point {
    return { ...this.pos };
  }
  move(p: Point): void {
    this.pos = { ...p };
    this.actions.push({ t: 'move', p: { ...p } });
  }
  down(button: MouseButton = 'left'): void {
    this.actions.push({ t: 'down', button });
  }
  up(button: MouseButton = 'left'): void {
    this.actions.push({ t: 'up', button });
  }
  click(button: MouseButton = 'left', double = false): void {
    this.actions.push({ t: 'click', button, double });
  }
  scroll(dx: number, dy: number): void {
    this.actions.push({ t: 'scroll', dx, dy });
  }
  keyTap(key: string, modifiers: string[] = []): void {
    this.actions.push({ t: 'key', key, modifiers });
  }
  typeChar(ch: string): void {
    this.actions.push({ t: 'char', ch });
  }
  mediaPlayPause(): void {
    this.actions.push({ t: 'media' });
  }
}
