import type { EventEmitter } from 'node:events';
import type { DisplayInfo, Point, Rect } from '@shared/geometry';
import type { PermissionStatus } from '@shared/session';
import type { RunningApp } from '@shared/ipc';

export interface WindowInfo {
  id: number;
  title: string;
  app: string;
  bundleId?: string;
  pid?: number;
  bounds: Rect;
}

export interface KeyEvt {
  keycode: number;
  /** Normalized key name: 'Escape', 'A', 'Control', 'Alt', 'Shift', 'Command', 'Enter', 'Space', … */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  time: number;
}

export interface MouseEvt {
  x: number;
  y: number;
  time: number;
  button?: number;
}

/** Global keyboard/mouse observation (uiohook). Emits 'keydown' | 'keyup' | 'mousemove' | 'mousedown' | 'wheel'. */
export interface InputHooks extends EventEmitter {
  readonly available: boolean;
  readonly running: boolean;
  start(): boolean;
  stop(): void;
}

export type MouseButton = 'left' | 'right' | 'middle';

/** Synthetic input for takeover (robotjs). Coordinates are global DIPs. */
export interface InputDriver {
  readonly available: boolean;
  mousePos(): Point;
  move(p: Point): void;
  down(button?: MouseButton): void;
  up(button?: MouseButton): void;
  click(button?: MouseButton, double?: boolean): void;
  scroll(dx: number, dy: number): void;
  keyTap(key: string, modifiers?: string[]): void;
  typeChar(ch: string): void;
  mediaPlayPause(): void;
}

export interface DisplayService extends EventEmitter {
  list(): DisplayInfo[];
  cursor(): Point;
  primary(): DisplayInfo;
  byId(id: string): DisplayInfo | undefined;
}

export interface PermissionService {
  status(): PermissionStatus;
  request(kind: 'screen' | 'microphone' | 'accessibility'): Promise<PermissionStatus>;
  openSettings(kind: 'screen' | 'microphone' | 'accessibility'): void;
}

export interface WindowLister {
  readonly available: boolean;
  list(): Promise<WindowInfo[]>;
}

export interface MediaPauseResult {
  paused: boolean;
  via?: 'applescript' | 'media-key';
  app?: string;
}

export interface MediaControl {
  /** Pause whatever is playing (if anything). `hint.videoLikely` comes from frame-diff motion analysis. */
  pauseIfPlaying(hint: { videoLikely: boolean; frontApp?: string }): Promise<MediaPauseResult>;
  resume(): Promise<boolean>;
  readonly pausedByUs: boolean;
}

export interface Platform {
  kind: 'mac' | 'linux' | 'windows' | 'fake';
  displays: DisplayService;
  permissions: PermissionService;
  hooks: InputHooks;
  driver: InputDriver;
  windows: WindowLister;
  media: MediaControl;
  runningApps(): Promise<RunningApp[]>;
  frontmostApp(): Promise<{ name: string; bundleId?: string } | null>;
}
