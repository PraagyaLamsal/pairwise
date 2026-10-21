import { DEFAULT_MODELS, TUTOR_DEFAULT_NAME } from './app-info';
import { DEFAULT_SHORTCUTS, type ShortcutAction } from './shortcuts';

export type TalkMode = 'hands-free' | 'push-to-talk';
export type SpeakingSpeed = 'slower' | 'normal' | 'faster';
export type ExplanationDepth = 'brief' | 'standard' | 'deep';
/** How Ada writes notes on screen: typed in the system font (like Tuple) or handwritten. */
export type NoteStyle = 'typed' | 'handwritten';
export type InkFade = 'after-speech' | 'manual';
export type AutoPauseMedia = 'smart' | 'media-key' | 'off';
export type LiveMediaResolution = 'MEDIA_RESOLUTION_LOW' | 'MEDIA_RESOLUTION_MEDIUM' | 'MEDIA_RESOLUTION_HIGH';

export interface VeilApp {
  /** macOS bundle identifier when known (most reliable), else matched by name. */
  bundleId?: string;
  name: string;
}

export interface ModelSettings {
  live: string;
  liveDeep: string;
  vision: string;
  reasoning: string;
  text: string;
  embedding: string;
}

export interface Settings {
  version: number;
  tutorName: string;
  voice: string;
  speakingSpeed: SpeakingSpeed;
  /** Pitch-preserving playback rate applied locally (0.75–1.4). */
  playbackRate: number;
  explanationDepth: ExplanationDepth;
  talkMode: TalkMode;
  captions: boolean;
  tutorColor: string;
  studentInkColor: string;
  noteStyle: NoteStyle;
  inkFade: InkFade;
  inkFadeDelaySec: number;
  autoPauseMedia: AutoPauseMedia;
  celebrate: boolean;
  sounds: boolean;
  veil: {
    apps: VeilApp[];
    hideNotifications: boolean;
    showOutlines: boolean;
  };
  privacy: {
    /** Off by default: notes never contain screenshots unless this is enabled. */
    saveAnnotatedScreenshots: boolean;
  };
  notes: {
    enabled: boolean;
    includeTranscript: boolean;
  };
  budget: {
    monthlyLimitUsd: number;
    warnAtPercent: number;
    hardStop: boolean;
  };
  takeover: {
    enabled: boolean;
    typingCharsPerSecond: number;
    /** Control is revoked automatically after this many idle seconds. */
    autoRevokeSec: number;
  };
  shortcuts: Record<ShortcutAction, string>;
  models: ModelSettings;
  useDeepLiveModel: boolean;
  liveMediaResolution: LiveMediaResolution;
  onboardingComplete: boolean;
  lastCourseId?: string;
  /** Where the session bar was dragged to, per display (global DIP of its top-left corner). */
  hudPositions?: Record<string, { x: number; y: number }>;
  launchAtLogin: boolean;
}

export const DEFAULT_VEIL_APPS: VeilApp[] = [
  { bundleId: 'com.apple.MobileSMS', name: 'Messages' },
  { bundleId: 'com.apple.keychainaccess', name: 'Keychain Access' },
  { bundleId: 'com.apple.Passwords', name: 'Passwords' },
  { bundleId: 'com.1password.1password', name: '1Password' },
  { bundleId: 'com.bitwarden.desktop', name: 'Bitwarden' },
  { bundleId: 'ru.keepcoder.Telegram', name: 'Telegram' },
  { bundleId: 'org.whispersystems.signal-desktop', name: 'Signal' },
  { bundleId: 'net.whatsapp.WhatsApp', name: 'WhatsApp' },
  { bundleId: 'com.apple.mail', name: 'Mail' },
];

/**
 * 2 (round 2): captions off by default (a quieter screen), the cursor always stays put (the
 * follow option is gone), notes are typed unless the student picks handwriting, and the
 * session bar remembers a position per display.
 */
export const SETTINGS_VERSION = 2;

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    tutorName: TUTOR_DEFAULT_NAME,
    voice: 'Kore',
    speakingSpeed: 'normal',
    playbackRate: 1,
    explanationDepth: 'standard',
    talkMode: 'hands-free',
    captions: false,
    tutorColor: '#2F7BFF',
    studentInkColor: '#FF8A1F',
    noteStyle: 'typed',
    inkFade: 'after-speech',
    inkFadeDelaySec: 6,
    autoPauseMedia: 'smart',
    celebrate: true,
    sounds: true,
    veil: { apps: DEFAULT_VEIL_APPS.map((a) => ({ ...a })), hideNotifications: true, showOutlines: true },
    privacy: { saveAnnotatedScreenshots: false },
    notes: { enabled: true, includeTranscript: true },
    budget: { monthlyLimitUsd: 25, warnAtPercent: 80, hardStop: true },
    takeover: { enabled: true, typingCharsPerSecond: 18, autoRevokeSec: 45 },
    shortcuts: { ...DEFAULT_SHORTCUTS },
    models: { ...DEFAULT_MODELS },
    useDeepLiveModel: false,
    liveMediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
    onboardingComplete: false,
    launchAtLogin: false,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Deep-merge stored settings onto defaults, dropping unknown keys and wrong types. Keeps the
 * app working when the file was hand-edited or written by an older version.
 */
export function mergeSettings(stored: unknown, base: Settings = defaultSettings()): Settings {
  const merge = (def: unknown, val: unknown): unknown => {
    if (val === undefined) return def;
    if (isObject(def)) {
      if (!isObject(val)) return def;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(def)) out[k] = merge(def[k], val[k]);
      // optional keys that are absent from defaults but valid
      for (const k of ['lastCourseId', 'hudPositions']) if (k in val && !(k in def)) out[k] = val[k];
      return out;
    }
    if (Array.isArray(def)) return Array.isArray(val) ? val : def;
    if (def === undefined) return val;
    return typeof val === typeof def ? val : def;
  };
  const merged = merge(base, stored) as Settings;
  const from = isObject(stored) && typeof stored['version'] === 'number' ? stored['version'] : SETTINGS_VERSION;
  let positions: Settings['hudPositions'];
  if (isObject(stored) && from < 2) {
    // Round 2 declutter: captions start hidden (one tap or ⌃⌥T brings them back).
    merged.captions = false;
    const old = stored['hudPosition'];
    if (isObject(old) && typeof old['displayId'] === 'string' && typeof old['x'] === 'number' && typeof old['y'] === 'number') {
      positions = { [old['displayId']]: { x: old['x'], y: old['y'] } };
    }
  }
  if (isObject(stored) && isObject(stored['hudPositions'])) {
    const ok = Object.entries(stored['hudPositions']).filter(([, v]) => isObject(v) && Number.isFinite(v['x']) && Number.isFinite(v['y']));
    positions = { ...(positions ?? {}), ...Object.fromEntries(ok.map(([k, v]) => [k, { x: Number((v as { x: number }).x), y: Number((v as { y: number }).y) }])) };
  }
  if (positions) merged.hudPositions = positions;
  else delete merged.hudPositions;
  merged.version = SETTINGS_VERSION;
  merged.playbackRate = Math.min(1.4, Math.max(0.75, Number(merged.playbackRate) || 1));
  merged.inkFadeDelaySec = Math.min(60, Math.max(1, merged.inkFadeDelaySec));
  merged.budget.monthlyLimitUsd = Math.max(0, merged.budget.monthlyLimitUsd);
  if (isObject(stored) && typeof stored['lastCourseId'] === 'string') merged.lastCourseId = stored['lastCourseId'];
  return merged;
}

/** Apply a partial patch (from a settings UI) with the same validation as loading. */
export function patchSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
  const apply = (cur: unknown, p: unknown): unknown => {
    if (!isObject(p) || !isObject(cur)) return p === undefined ? cur : p;
    const out: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(p)) out[k] = isObject(v) && isObject(cur[k]) ? apply(cur[k], v) : v;
    return out;
  };
  return mergeSettings(apply(current, patch), defaultSettings());
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
