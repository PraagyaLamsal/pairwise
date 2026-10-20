import type { TalkMode } from './settings';

export type SessionStatus = 'idle' | 'starting' | 'connecting' | 'live' | 'reconnecting' | 'ending' | 'error';
export type TutorActivity = 'idle' | 'listening' | 'thinking' | 'speaking' | 'waiting';
export type DrivingState = 'none' | 'requested' | 'driving';

export interface SessionSnapshot {
  status: SessionStatus;
  courseId?: string;
  courseLabel?: string;
  courseColor?: string;
  startedAt?: number;
  /** Accumulated active ms (excludes pauses), plus now - resumedAt when running. */
  elapsedMs: number;
  muted: boolean;
  talkMode: TalkMode;
  pttHeld: boolean;
  vision: 'on' | 'paused';
  visibleDisplayId?: string;
  visibleDisplayLabel?: string;
  activity: TutorActivity;
  driving: DrivingState;
  mediaPausedByUs: boolean;
  whiteboard: boolean;
  captions: boolean;
  hudVisible: boolean;
  assignment?: string;
  costUsd: number;
  model?: string;
  /** True when no API key is configured and the scripted demo tutor is used. */
  demo: boolean;
  error?: string;
  notice?: string;
  reconnects: number;
  canReplay: boolean;
  /** Windows App Veil is hiding from the tutor right now. */
  veiledWindows: number;
}

export const IDLE_SNAPSHOT: SessionSnapshot = {
  status: 'idle',
  elapsedMs: 0,
  muted: false,
  talkMode: 'hands-free',
  pttHeld: false,
  vision: 'on',
  activity: 'idle',
  driving: 'none',
  mediaPausedByUs: false,
  whiteboard: false,
  captions: true,
  hudVisible: true,
  costUsd: 0,
  demo: false,
  reconnects: 0,
  canReplay: false,
  veiledWindows: 0,
};

export interface Caption {
  id: string;
  speaker: 'student' | 'tutor' | 'system';
  text: string;
  final: boolean;
  at: number;
  /** Optional chips rendered under a tutor caption. */
  cites?: string[];
  outOfScope?: string;
}

export type SessionCommand =
  | { type: 'toggleMute' }
  | { type: 'setMuted'; muted: boolean }
  | { type: 'toggleVision' }
  | { type: 'replay' }
  | { type: 'clearInk' }
  | { type: 'toggleTalkMode' }
  | { type: 'toggleWhiteboard' }
  | { type: 'grantControl' }
  | { type: 'denyControl' }
  | { type: 'reclaim' }
  | { type: 'toggleMedia' }
  | { type: 'toggleCaptions' }
  | { type: 'drawToggle' }
  | { type: 'toggleHud' }
  | { type: 'sendText'; text: string }
  | { type: 'pttDown' }
  | { type: 'pttUp' };

export interface StartSessionRequest {
  courseId: string;
  resume?: boolean;
  assignment?: string;
  whiteboard?: boolean;
}

export interface UsageSummary {
  monthKey: string;
  monthUsd: number;
  limitUsd: number;
  percent: number;
  todayUsd: number;
  sessionUsd: number;
  byModel: { model: string; usd: number; tokens: number }[];
  byDay: { day: string; usd: number }[];
  blocked: boolean;
  warn: boolean;
}

export interface PermissionStatus {
  platform: string;
  screen: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
  microphone: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
  accessibility: 'granted' | 'denied' | 'unknown';
  /** Whether native helpers loaded (hold-keys, takeover, veil). */
  native: { hooks: boolean; input: boolean; windows: boolean };
}
