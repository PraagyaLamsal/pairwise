/**
 * Shortcuts use Electron accelerator syntax ("Control+Alt+S"). Hold-chords are modifier-only
 * accelerators ("Control+Alt") and are detected with uiohook (key down/up), because Electron's
 * globalShortcut only fires on press and cannot express "held".
 */
export type ShortcutAction =
  | 'ask'
  | 'drawToggle'
  | 'toggleSession'
  | 'toggleMute'
  | 'toggleVision'
  | 'toggleWhiteboard'
  | 'replay'
  | 'clearInk'
  | 'grantControl'
  | 'pauseResumeMedia'
  | 'toggleHud'
  | 'toggleCaptions'
  | 'toggleTalkMode';

export interface ShortcutSpec {
  action: ShortcutAction;
  label: string;
  description: string;
  kind: 'hold' | 'press';
  default: string;
}

export const SHORTCUTS: ShortcutSpec[] = [
  { action: 'ask', label: 'Ask (hold)', kind: 'hold', default: 'Control+Alt',
    description: 'Hold to talk. Drag while holding to circle, underline or scribble. Release to send it all as one question.' },
  { action: 'drawToggle', label: 'Draw mode', kind: 'press', default: 'Control+Alt+D',
    description: 'Toggle draw mode without holding keys (press again or Return to send, Esc to cancel).' },
  { action: 'toggleSession', label: 'Start / end session', kind: 'press', default: 'Control+Alt+S',
    description: 'Starts a session with the last course, or ends the current one.' },
  { action: 'toggleMute', label: 'Mute microphone', kind: 'press', default: 'Control+Alt+M',
    description: 'Mute or unmute your microphone.' },
  { action: 'toggleVision', label: 'Pause screen view', kind: 'press', default: 'Control+Alt+V',
    description: 'Stop or resume sending your screen to the tutor.' },
  { action: 'toggleWhiteboard', label: 'Whiteboard', kind: 'press', default: 'Control+Alt+W',
    description: 'Open or close the blank whiteboard.' },
  { action: 'replay', label: 'Say that again', kind: 'press', default: 'Control+Alt+R',
    description: 'Replay the last explanation (audio + drawings), no extra cost.' },
  { action: 'clearInk', label: 'Clear drawings', kind: 'press', default: 'Control+Alt+C',
    description: 'Clear all annotations on screen.' },
  { action: 'grantControl', label: 'Allow tutor to drive', kind: 'press', default: 'Control+Alt+G',
    description: 'Grant control when the tutor asks. Move the mouse or press Esc to take it back.' },
  { action: 'pauseResumeMedia', label: 'Pause / resume media', kind: 'press', default: 'Control+Alt+P',
    description: 'Pause or resume the video/audio that was playing.' },
  { action: 'toggleHud', label: 'Show / hide control bar', kind: 'press', default: 'Control+Alt+H',
    description: 'Show or hide the floating session bar.' },
  { action: 'toggleCaptions', label: 'Captions', kind: 'press', default: 'Control+Alt+T',
    description: 'Show or hide live captions.' },
  { action: 'toggleTalkMode', label: 'Hands-free ↔ push-to-talk', kind: 'press', default: 'Control+Alt+K',
    description: 'Switch between always listening and hold-to-talk.' },
];

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = Object.fromEntries(
  SHORTCUTS.map((s) => [s.action, s.default]),
) as Record<ShortcutAction, string>;

export const MODIFIERS = ['Command', 'Control', 'Alt', 'Shift'] as const;
export type Modifier = (typeof MODIFIERS)[number];

export interface ParsedAccelerator {
  modifiers: Set<Modifier>;
  key: string | null;
}

const MOD_ALIASES: Record<string, Modifier> = {
  command: 'Command', cmd: 'Command', super: 'Command', meta: 'Command',
  control: 'Control', ctrl: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  commandorcontrol: 'Command', cmdorctrl: 'Command',
};

export function parseAccelerator(acc: string): ParsedAccelerator {
  const modifiers = new Set<Modifier>();
  let key: string | null = null;
  for (const raw of acc.split('+').map((p) => p.trim()).filter(Boolean)) {
    const mod = MOD_ALIASES[raw.toLowerCase()];
    if (mod) modifiers.add(mod);
    else key = raw.length === 1 ? raw.toUpperCase() : raw;
  }
  return { modifiers, key };
}

export function isChordOnly(acc: string): boolean {
  const p = parseAccelerator(acc);
  return p.key === null && p.modifiers.size > 0;
}

const MAC_SYMBOLS: Record<Modifier, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
const MOD_ORDER: Modifier[] = ['Control', 'Alt', 'Shift', 'Command'];
const KEY_SYMBOLS: Record<string, string> = {
  Space: 'Space', Return: '↩', Enter: '↩', Escape: 'Esc', Backspace: '⌫', Tab: '⇥',
  Up: '↑', Down: '↓', Left: '←', Right: '→',
};

/** "Control+Alt+S" → "⌃⌥S" (mac) or "Ctrl+Alt+S" (others). */
export function formatAccelerator(acc: string, platform: string = 'darwin'): string {
  const { modifiers, key } = parseAccelerator(acc);
  const mods = MOD_ORDER.filter((m) => modifiers.has(m));
  if (platform === 'darwin') {
    return mods.map((m) => MAC_SYMBOLS[m]).join('') + (key ? (KEY_SYMBOLS[key] ?? key) : '');
  }
  const names: Record<Modifier, string> = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Command: 'Win' };
  return [...mods.map((m) => names[m]), ...(key ? [KEY_SYMBOLS[key] ?? key] : [])].join('+');
}

/** Normalize to canonical "Control+Alt+Shift+Command+Key" order so duplicates are detectable. */
export function normalizeAccelerator(acc: string): string {
  const { modifiers, key } = parseAccelerator(acc);
  return [...MOD_ORDER.filter((m) => modifiers.has(m)), ...(key ? [key] : [])].join('+');
}

/** Returns the actions whose bindings collide with another action's binding. */
export function findConflicts(map: Record<ShortcutAction, string>): ShortcutAction[] {
  const seen = new Map<string, ShortcutAction>();
  const conflicts = new Set<ShortcutAction>();
  for (const [action, acc] of Object.entries(map) as [ShortcutAction, string][]) {
    if (!acc) continue;
    const norm = normalizeAccelerator(acc);
    const prev = seen.get(norm);
    if (prev) {
      conflicts.add(prev);
      conflicts.add(action);
    } else seen.set(norm, action);
  }
  return [...conflicts];
}
