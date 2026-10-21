import type { Course, IndexStatus, ResumeState, SearchHit } from './courses';
import type { DisplayInfo, FrameRef, Point, Rect } from './geometry';
import type {
  Celebration,
  CursorCancel,
  CursorFlight,
  CursorFrame,
  CursorTrace,
  DrawModeState,
  InkItem,
  OverlayUiState,
} from './ink';
import type {
  Caption,
  PermissionStatus,
  SessionCommand,
  SessionSnapshot,
  StartSessionRequest,
  UsageSummary,
} from './session';
import type { DeepPartial, Settings } from './settings';
import type { ShortcutAction } from './shortcuts';

export type WindowRole = 'hub' | 'hud' | 'overlay' | 'engine' | 'whiteboard';

export interface AppInfo {
  appName: string;
  version: string;
  platform: string;
  demo: boolean;
  /** A key is saved but this build can't decrypt it (see ApiKeyStatus.unreadable). */
  keyUnreadable?: boolean;
  fakePlatform: boolean;
  tutorName: string;
}

export interface CourseFile {
  path: string;
  kind: string;
  size: number;
  isAssignment: boolean;
  indexed: boolean;
}

export interface ApiKeyStatus {
  hasKey: boolean;
  source: 'keychain' | 'env' | 'none';
  preview?: string;
  /**
   * A key is saved but this copy of Pairwise can't decrypt it: it was saved by another build
   * (`npm run dev` uses Electron's keychain entry, the app its own). Paste it again.
   */
  unreadable?: boolean;
}

export interface RunningApp {
  name: string;
  bundleId?: string;
}

/** Request/response calls from any renderer to main. */
export interface InvokeMap {
  'app:info': () => AppInfo;
  'settings:get': () => Settings;
  'settings:update': (patch: DeepPartial<Settings>) => Settings;
  'settings:resetShortcuts': () => Settings;
  'secrets:status': () => ApiKeyStatus;
  'secrets:setApiKey': (key: string) => { ok: boolean; error?: string; models?: string[] };
  'secrets:clearApiKey': () => ApiKeyStatus;
  'courses:list': () => Course[];
  'courses:create': (input: { code: string; name: string; color?: string; folder?: string; term?: string }) => Course;
  'courses:update': (id: string, patch: Partial<Course>) => Course;
  'courses:delete': (id: string) => void;
  'courses:pickFolder': () => string | null;
  'courses:index': (id: string) => IndexStatus;
  'courses:files': (id: string) => CourseFile[];
  'courses:toggleAssignment': (id: string, file: string) => Course;
  'courses:search': (id: string, query: string) => SearchHit[];
  'courses:resume': (id: string) => ResumeState | null;
  'courses:openFolder': (id: string) => void;
  'session:start': (req: StartSessionRequest) => { ok: boolean; error?: string };
  'session:end': () => void;
  'session:snapshot': () => SessionSnapshot;
  'session:command': (cmd: SessionCommand) => void;
  'session:recentNotes': (courseId: string) => { file: string; title: string; at: number }[];
  'permissions:status': () => PermissionStatus;
  'permissions:request': (kind: 'screen' | 'microphone' | 'accessibility') => PermissionStatus;
  'permissions:openSettings': (kind: 'screen' | 'microphone' | 'accessibility') => void;
  'usage:summary': () => UsageSummary;
  'diagnostics:pointingTest': () => { ok: boolean; error?: string; summary?: string };
  'diagnostics:previewInk': () => void;
  'notes:open': (file: string) => void;
  'windows:open': (target: 'hub' | 'whiteboard', tab?: string) => void;
  'windows:close': () => void;
  'hud:moveBy': (dx: number, dy: number) => void;
  'hud:setSize': (w: number, h: number) => void;
  'veil:runningApps': () => RunningApp[];
  'shortcuts:conflicts': (map: Record<ShortcutAction, string>) => ShortcutAction[];
  'whiteboard:snapshot': () => void;
  'whiteboard:state': () => { title: string; tutorName: string; tutorColor: string; studentColor: string; items: InkItem[] };
  'onboarding:complete': () => Settings;
}

export type InvokeChannel = keyof InvokeMap;

/** Events main → renderers. */
export interface EventMap {
  'session:snapshot': SessionSnapshot;
  'session:caption': Caption;
  'session:levels': { mic: number; out: number };
  'settings:changed': Settings;
  'courses:changed': Course[];
  'courses:indexProgress': { courseId: string; status: IndexStatus };
  'usage:changed': UsageSummary;
  'hub:navigate': { tab: string };
  /** A session's notes (and the resume summary) are written: the course page refreshes. */
  'session:notesWritten': { courseId: string; file: string | null };
  'overlay:init': OverlayInit;
  'overlay:cursor': CursorFrame;
  'overlay:flight': CursorFlight;
  'overlay:trace': CursorTrace;
  'overlay:cursorCancel': CursorCancel;
  'overlay:ink': InkOp;
  'overlay:ui': OverlayUiState;
  'overlay:drawMode': DrawModeState;
  /** "Show me" (ask_to_point): the overlays take the student's next click as their answer. */
  'overlay:answerMode': { active: boolean; prompt: string; color: string };
  'overlay:celebrate': Celebration;
  'overlay:calibration': CalibrationState | null;
  'whiteboard:ink': InkOp;
  'whiteboard:init': { title: string; tutorName: string; tutorColor: string; studentColor: string; items: InkItem[] };
  /** Board-space ink re-expressed in screen space, only so the tutor's cursor can trace it. */
  'overlay:penItems': { items: InkItem[] };
  'whiteboard:drawMode': DrawModeState;
  'whiteboard:requestSnapshot': { requestId: string; maxWidth: number };
  'engine:command': EngineCommand;
}

export type EventChannel = keyof EventMap;

/** Fire-and-forget messages renderers → main. */
export interface SendMap {
  'overlay:ready': { displayId: string };
  'overlay:stroke': StudentStroke;
  'overlay:drawCommit': { via: 'toggle' | 'hold' };
  'overlay:drawCancel': Record<string, never>;
  /** The student's answer to ask_to_point: where they clicked (global DIP). */
  'overlay:answer': { displayId: string; point: { x: number; y: number } };
  'overlay:answerCancel': Record<string, never>;
  'overlay:consent': { id: string; decision: 'allow' | 'deny' };
  'overlay:dismissCard': { kind: 'citation' | 'step' | 'toast' | 'scope' };
  'overlay:hover': { displayId: string; interactive: boolean };
  /** Where the overlay's own UI (cards, pills, toasts) is, global DIP — never a grounding answer. */
  'overlay:uiRects': { displayId: string; rects: Rect[] };
  'whiteboard:stroke': StudentStroke;
  'whiteboard:snapshot': { requestId: string; jpeg: Uint8Array; width: number; height: number };
  'whiteboard:closed': Record<string, never>;
  'whiteboard:clear': Record<string, never>;
  'engine:ready': Record<string, never>;
  'engine:audio': { pcm: Uint8Array; seq: number };
  'engine:micLevel': { level: number; speaking: boolean };
  'engine:vad': { speaking: boolean; at: number };
  'engine:playback': PlaybackStatus;
  'engine:frame': EncodedFrame;
  'engine:reply': { requestId: string; ok: boolean; error?: string; frame?: EncodedFrame; frames?: EncodedFrame[]; track?: TrackResult[] };
  'engine:log': { level: 'info' | 'warn' | 'error'; message: string };
  'hub:log': { level: 'info' | 'warn' | 'error'; message: string };
}

export type SendChannel = keyof SendMap;

export interface OverlayInit {
  display: DisplayInfo;
  displays: DisplayInfo[];
  tutorName: string;
  tutorColor: string;
  studentColor: string;
  platform: string;
  reducedMotion: boolean;
}

export type InkOp =
  | { op: 'add'; items: InkItem[] }
  | { op: 'update'; items: InkItem[] }
  | { op: 'remove'; ids: string[] }
  | { op: 'fade'; ids?: string[]; group?: string; author?: 'tutor' | 'student'; at: number }
  | { op: 'clear'; author?: 'tutor' | 'student'; group?: string };

export interface StudentStroke {
  id: string;
  points: Point[];
  times: number[];
  /** Shift held → straight line. */
  straight: boolean;
  displayId: string;
  surface: 'screen' | 'whiteboard';
}

export interface PlaybackStatus {
  /** Samples (24 kHz) that have actually been played since the last flush. */
  playedSamples: number;
  /** Samples received since the last flush. */
  queuedSamples: number;
  playing: boolean;
  at: number;
  epoch: number;
  level: number;
}

export interface EncodedFrame {
  ref: FrameRef;
  /** JPEG bytes. */
  data: Uint8Array;
  mime: 'image/jpeg' | 'image/png';
  changeScore: number;
  /** Rects (global DIP) painted black by App Veil before encoding. */
  veiled: Rect[];
}

export interface CaptureSourceSpec {
  displayId: string;
  sourceId: string;
  bounds: Rect;
  scaleFactor: number;
  /** When one capture source spans several (fake) displays, crop this rect out of it (source pixels). */
  cropFromSource?: Rect;
  sourceSize?: { width: number; height: number };
}

/** Sticky ink: one group of marks for the engine to follow on screen (global DIP). */
export interface TrackGroup {
  key: string;
  /** What the marks are about: the content under and beside them. */
  anchors: Rect[];
  /** The mark each anchor belongs to. */
  ids: string[];
  /** Marks hidden because their line went out of view, with where their line would be now. */
  parked?: { id: string; anchor: Rect }[];
}

/** Where a group's content is now: still there, moved by `dy` (DIP, + = down), or gone. */
export interface TrackResult {
  key: string;
  state: 'steady' | 'moved' | 'gone' | 'unsure';
  dy: number;
  /** moved: anchors (indices) whose content didn't come along — it scrolled out of view. */
  lost?: number[];
  /** Parked marks whose line is back in view. */
  back?: string[];
  /** Parked marks the engine can't recognise again (let them go). */
  forget?: string[];
}

export type EngineCommand =
  | { type: 'startAudio'; echoCancellation: boolean; playbackRate: number }
  | { type: 'stopAudio' }
  | { type: 'setMuted'; muted: boolean }
  | { type: 'gate'; open: boolean }
  | { type: 'play'; pcm: Uint8Array; turnId: string }
  | { type: 'flush'; reason: string }
  | { type: 'duck'; level: number }
  | { type: 'replay' }
  | { type: 'setRate'; rate: number }
  | { type: 'chime'; kind: 'start' | 'end' | 'celebrate' | 'grant' | 'reclaim' | 'error' }
  | { type: 'startCapture'; sources: CaptureSourceSpec[]; activeDisplayId: string; maxLiveWidth: number; quality: number }
  | { type: 'stopCapture' }
  | { type: 'setActiveDisplay'; displayId: string }
  | { type: 'setVeil'; rects: { displayId: string; rects: Rect[] }[] }
  | { type: 'setLiveCapture'; enabled: boolean }
  /** Sticky ink: compare each group's anchors with how they looked (masks: pixels to skip). */
  | { type: 'trackInk'; requestId: string; displayId: string; groups: TrackGroup[]; masks: Rect[] }
  | {
      type: 'captureNow';
      requestId: string;
      displayId: string;
      maxWidth: number;
      quality: number;
      crop?: Rect;
      kind: 'hires' | 'crop' | 'live';
      composite?: { color: string; strokes: { points: Point[] }[] };
      format?: 'jpeg' | 'png';
    };

export interface CalibrationState {
  targets: { id: string; label: string; rect: Rect; color: string }[];
  results: { id: string; found: Rect | null; errorPx: number | null }[];
  phase: 'showing' | 'measuring' | 'done';
}

/** Allowed channels per direction — the preload refuses everything else. */
export const INVOKE_CHANNELS: InvokeChannel[] = [
  'app:info', 'settings:get', 'settings:update', 'settings:resetShortcuts', 'secrets:status', 'secrets:setApiKey',
  'secrets:clearApiKey', 'courses:list', 'courses:create', 'courses:update', 'courses:delete', 'courses:pickFolder',
  'courses:index', 'courses:files', 'courses:toggleAssignment', 'courses:search', 'courses:resume', 'courses:openFolder',
  'session:start', 'session:end', 'session:snapshot', 'session:command', 'session:recentNotes', 'permissions:status',
  'permissions:request', 'permissions:openSettings', 'usage:summary', 'diagnostics:pointingTest', 'diagnostics:previewInk',
  'notes:open', 'windows:open', 'windows:close', 'hud:moveBy', 'hud:setSize', 'veil:runningApps', 'shortcuts:conflicts',
  'whiteboard:snapshot', 'whiteboard:state', 'onboarding:complete',
];

export const EVENT_CHANNELS: EventChannel[] = [
  'session:snapshot', 'session:caption', 'session:levels', 'settings:changed', 'courses:changed', 'courses:indexProgress',
  'usage:changed', 'hub:navigate', 'session:notesWritten', 'overlay:init', 'overlay:cursor', 'overlay:flight', 'overlay:trace', 'overlay:cursorCancel', 'overlay:ink', 'overlay:ui',
  'overlay:drawMode', 'overlay:answerMode', 'overlay:celebrate', 'overlay:calibration', 'whiteboard:ink', 'whiteboard:init', 'overlay:penItems', 'whiteboard:drawMode',
  'whiteboard:requestSnapshot', 'engine:command',
];

export const SEND_CHANNELS: SendChannel[] = [
  'overlay:ready', 'overlay:stroke', 'overlay:drawCommit', 'overlay:drawCancel', 'overlay:answer', 'overlay:answerCancel', 'overlay:consent', 'overlay:dismissCard', 'overlay:hover',
  'overlay:uiRects', 'whiteboard:stroke', 'whiteboard:snapshot', 'whiteboard:closed', 'whiteboard:clear', 'engine:ready', 'engine:audio', 'engine:micLevel',
  'engine:vad', 'engine:playback', 'engine:frame', 'engine:reply', 'engine:log', 'hub:log',
];
