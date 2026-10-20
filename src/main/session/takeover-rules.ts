import type { Point } from '@shared/geometry';

/**
 * Takeover safety rules, kept pure so they're easy to test:
 *  - which actions count as "risky" (need the student's explicit OK on screen, every time),
 *  - which input events are our own synthetic ones (so only the student's real mouse/keys
 *    reclaim control),
 *  - reading a spoken yes/no for consent.
 */

export interface ControlAction {
  type: 'click' | 'double_click' | 'right_click' | 'move' | 'type' | 'key' | 'scroll' | 'drag';
  target?: string;
  text?: string;
  keys?: string[];
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  to_target?: string;
}

const RISKY_WORDS =
  /\b(submit|send|post|publish|share|reply|delete|remove|erase|trash|discard|overwrite|replace all|format|wipe|reset|uninstall|install|buy|purchase|pay|checkout|order|subscribe|sign out|log ?out|deactivate|close account|transfer|confirm|run|execute|compile and run|deploy|commit|push|merge|rebase|force|grade|hand ?in|turn in|upload)\b/i;
const SHELL_COMMAND = /(^|\s)(sudo|rm|mv|cp|chmod|chown|git|npm|pip|brew|curl|wget|python3?|node|java|gcc|make|kill|killall|shutdown|reboot|dd|mkfs|ssh|scp)\b|[|&;>]/;
const TERMINALS = /^(terminal|iterm2?|warp|ghostty|kitty|alacritty|hyper|wezterm|tabby)$/i;

export interface RiskContext {
  /** Text typed earlier in the same control call (an Enter after it may run it). */
  typedBefore?: string;
  frontApp?: string;
  explain?: string;
}

/** "the \"Submit\" button" → "Submit button" (for the consent card). */
export function prettyTarget(desc: string): string {
  return desc
    .trim()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/g, '$1')
    .replace(/\s+/g, ' ');
}

/** Why an action needs the student's explicit OK, or null when it doesn't. */
export function riskOf(a: ControlAction, ctx: RiskContext = {}): string | null {
  const target = a.target ?? '';
  const keys = (a.keys ?? []).map((k) => k.toLowerCase());
  const has = (k: string) => keys.includes(k);
  const cmd = has('cmd') || has('command') || has('meta') || has('ctrl') || has('control');
  const isEnter = has('enter') || has('return');
  const terminal = ctx.frontApp ? TERMINALS.test(ctx.frontApp.trim()) : false;
  switch (a.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
      if (RISKY_WORDS.test(target)) return `${a.type === 'click' ? 'click' : a.type.replace('_', '-')} ${prettyTarget(target)}`;
      return null;
    case 'drag':
      if (/\btrash|bin|delete\b/i.test(a.to_target ?? '')) return `drag ${prettyTarget(target) || 'it'} to ${prettyTarget(a.to_target ?? '')}`;
      return null;
    case 'type':
      // Typing a shell command is fine by itself; running it (Enter) is what needs asking.
      if (a.text && /\n/.test(a.text) && (terminal || SHELL_COMMAND.test(a.text))) return `run “${a.text.trim().slice(0, 60)}”`;
      return null;
    case 'key':
      if (isEnter && cmd) return 'press ⌘/Ctrl+Return (usually sends or submits)';
      if (isEnter && (terminal || (ctx.typedBefore && SHELL_COMMAND.test(ctx.typedBefore)))) return `run ${ctx.typedBefore ? `“${ctx.typedBefore.trim().slice(0, 60)}”` : 'the command in the terminal'}`;
      if (isEnter && RISKY_WORDS.test(ctx.explain ?? '')) return `press Return to ${(RISKY_WORDS.exec(ctx.explain ?? '')?.[0] ?? 'confirm').toLowerCase()}`;
      if ((has('backspace') || has('delete')) && cmd) return 'delete (⌘/Ctrl+Delete)';
      if (has('q') && cmd) return 'quit the app (⌘Q)';
      return null;
    default:
      return null;
  }
}

/**
 * Remembers what we just did with the real mouse/keyboard, so the global hooks can tell our
 * synthetic events from the student's own. Anything that isn't ours reclaims control at once.
 */
export class SyntheticTracker {
  private moves: { p: Point; t: number }[] = [];
  private keysUntil = 0;
  private buttonsUntil = 0;

  noteMove(p: Point, t = Date.now()): void {
    this.moves.push({ p: { ...p }, t });
    if (this.moves.length > 64) this.moves.splice(0, this.moves.length - 64);
  }

  /** We're about to post key events for the next `ms` milliseconds. */
  noteKeys(ms: number, t = Date.now()): void {
    this.keysUntil = Math.max(this.keysUntil, t + ms + 120);
  }

  noteButtons(ms: number, t = Date.now()): void {
    this.buttonsUntil = Math.max(this.buttonsUntil, t + ms + 120);
  }

  /** A mouse move at `p` is ours if we put the pointer (within a few px of) there just now. */
  isOurMove(p: Point, t = Date.now()): boolean {
    for (let i = this.moves.length - 1; i >= 0; i--) {
      const m = this.moves[i];
      if (t - m.t > 600) break;
      if (Math.abs(m.p.x - p.x) <= 3 && Math.abs(m.p.y - p.y) <= 3) return true;
    }
    return false;
  }

  /** Where we last put the pointer (to ignore sub-pixel jitter around it). */
  get lastMove(): Point | null {
    return this.moves.length ? this.moves[this.moves.length - 1].p : null;
  }

  isOurKey(t = Date.now()): boolean {
    return t <= this.keysUntil;
  }

  isOurButton(t = Date.now()): boolean {
    return t <= this.buttonsUntil;
  }

  reset(): void {
    this.moves = [];
    this.keysUntil = 0;
    this.buttonsUntil = 0;
  }
}

/** A spoken answer to "can I take over?" — 'yes', 'no' or null (not an answer). */
export function spokenConsent(text: string): 'yes' | 'no' | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  if (/ (no|nope|nah|don't|do not|not now|not yet|stop|wait|hold on|i'll do it|let me do it|let me try|i got it|i've got it) /.test(t)) return 'no';
  if (/ (yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|go for it|please do|you can|you may|show me|take over|take it|drive|alright|all right|fine) /.test(t)) return 'yes';
  return null;
}
