import type { Point, Rect } from './geometry';

/**
 * Everything drawn on the overlays. Geometry is in GLOBAL DIP coordinates and timing is in
 * epoch milliseconds, so every display's overlay renders exactly the same scene (translated by
 * its own origin) and animations stay in sync across monitors.
 */
export type InkKind =
  | 'arrow'
  | 'circle'
  | 'highlight'
  | 'underline'
  | 'box'
  | 'bracket'
  | 'text'
  | 'step'
  | 'stroke'
  | 'line'
  | 'check'
  | 'cross'
  | 'ring';

export type InkAuthor = 'tutor' | 'student';
export type InkSurface = 'screen' | 'whiteboard';

export interface InkItem {
  id: string;
  author: InkAuthor;
  kind: InkKind;
  color: string;
  surface: InkSurface;
  rect?: Rect;
  from?: Point;
  to?: Point;
  points?: Point[];
  at?: Point;
  text?: string;
  num?: number;
  fontSize?: number;
  /** Text: typed in the system font (default, like Tuple) or handwritten. */
  font?: 'system' | 'hand';
  /** Text: 'center' = `at` is the centre of the first line (diagram labels). */
  align?: 'center';
  width?: number;
  /** Arrow bend: -1..1 (0 = straight). */
  bend?: number;
  /** Epoch ms when drawing starts. */
  revealAt: number;
  /** How long the stroke takes to draw itself. */
  drawMs: number;
  /** Epoch ms when it starts fading out (null = keep). */
  fadeAt?: number | null;
  /** Deterministic jitter seed so all overlays draw the same wobble. */
  seed: number;
  /** Bulk-clear group (a step guide, a diagram, a student question). */
  group?: string;
  /** Short label for accessibility / notes. */
  label?: string;
}

export type CursorActivity = 'idle' | 'listening' | 'thinking' | 'speaking' | 'waiting' | 'driving';

/**
 * How present the tutor's cursor is: `active` while it moves or shows a label, `idle` (dimmed,
 * no label) when it is just resting where it was left, `near` (almost transparent) when the
 * student's pointer comes close, so it never sits on top of what they are doing.
 */
export type CursorPresence = 'active' | 'idle' | 'near';

export interface CursorFrame {
  /** Global DIP position of the cursor tip. */
  pos: Point;
  /** Rotation in degrees (-35 = classic pointer). */
  rot: number;
  scale: number;
  glow: number;
  visible: boolean;
  activity: CursorActivity;
  /** Text in the label pill; the tutor's name when idle. */
  label: string;
  labelKind: 'name' | 'pointing' | 'status';
  /** Monotonic counter: overlays re-run the label "stream in" animation when it changes. */
  labelSeq: number;
  /** 0..1 audio level for the waveform states. */
  level: number;
  presence: CursorPresence;
  /** The student's own pointer (global DIP): overlays fade what it comes close to. */
  mouse: Point;
  t: number;
}

export interface CursorFlight {
  from: Point;
  ctrl: Point;
  to: Point;
  startAt: number;
  duration: number;
  label?: string;
}

/**
 * The tutor's cursor drawing an ink item: from `startAt` for `duration` ms the cursor tip follows
 * the item's own stroke path, with the same timing the renderer uses to reveal the ink — so the
 * cursor really is the pen. Without an item, a pointer-only gesture: the tip glides along `path`
 * (following a line of text, sweeping down a list) and nothing is drawn.
 */
export interface CursorTrace {
  itemId?: string;
  path?: Point[];
  /** Gesture pacing: glide (ease in/out), read (steady, like following a line), sweep (line by line). */
  style?: 'glide' | 'read' | 'sweep';
  startAt: number;
  duration: number;
  /** Where the trace ends (global DIP), so overlays can park there without the item. */
  end: Point;
}

/** Drop scheduled cursor moves that haven't started yet (the tutor was interrupted). */
export interface CursorCancel {
  at: number;
  pos: Point;
}

export interface StepCardState {
  id: string;
  title: string;
  steps: { text: string; status: 'pending' | 'active' | 'done' }[];
  /** Global DIP anchor (top-right of the display the guide is on). */
  anchor: Point;
  displayId: string;
}

export interface ConsentCardState {
  id: string;
  kind: 'control' | 'risky-action';
  title: string;
  detail: string;
  /** For risky actions: what exactly will happen. */
  action?: string;
  hotkey?: string;
  expiresAt: number;
  displayId: string;
  /** Where the card sits: keep it off the thing it's asking about. */
  anchor?: 'top' | 'bottom';
}

export interface CitationCardState {
  id: string;
  cite: string;
  snippet: string;
  displayId: string;
  until: number;
}

export interface VeilOutline {
  rect: Rect;
  app: string;
}

export interface OverlayUiState {
  driving: boolean;
  drivingLabel?: string;
  visionDisplayId?: string;
  visionLabel?: string;
  visionPaused: boolean;
  sessionLive: boolean;
  stepCard?: StepCardState;
  consent?: ConsentCardState;
  citation?: CitationCardState;
  veilOutlines: VeilOutline[];
  toast?: { id: string; text: string; tone: 'info' | 'warn' | 'success'; until: number; displayId?: string };
  outOfScope?: { id: string; topic: string; until: number; displayId: string };
}

export interface Celebration {
  id: string;
  at: Point;
  text: string;
  startAt: number;
}

export interface DrawModeState {
  active: boolean;
  /** 'hold' while the ask chord is held, 'toggle' for the press-to-toggle draw mode. */
  via: 'hold' | 'toggle' | null;
  color: string;
  questionId?: string;
}

let idCounter = 0;
export function inkId(prefix = 'ink'): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
