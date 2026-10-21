import { inflateRect, rectContains, rectsIntersect, type Rect } from '@shared/geometry';
import type { InkItem } from '@shared/ink';
import { inkAnchor, inkCover } from '@shared/ink-geometry';
import type { TrackGroup, TrackResult } from '@shared/ipc';
import type { TutorSession } from '../tutor';
import { env, prefersReducedMotion } from '../../env';
import { logger } from '../../log';

const log = logger('sticky');

/** How often the screen is compared while marks are up (the capture stream runs at 4 fps)… */
const TICK_MS = 250;
/** …and half as often once nothing has moved for a while. */
const QUIET_AFTER_MS = 2000;
/** After a move, the old place stays masked a moment (the overlays may not have redrawn yet). */
const RECENT_MS = 700;
/** At most this many groups are followed (the newest). */
const MAX_GROUPS = 8;

/** A group of marks for the engine: its key and what each of its marks is about. */
export function trackGroups(items: InkItem[], display: Rect, now = Date.now()): TrackGroup[] {
  const byKey = new Map<string, TrackGroup>();
  for (const it of items) {
    // Fading marks (a cleared group among them) aren't followed.
    if (it.surface !== 'screen' || (it.fadeAt != null && it.fadeAt <= now)) continue;
    const key = it.group ?? it.id;
    const a = inkAnchor(it);
    if (!a || !rectsIntersect(a, display)) continue;
    const g = byKey.get(key) ?? { key, anchors: [], ids: [] };
    g.anchors.push(a);
    g.ids.push(it.id);
    byKey.set(key, g);
  }
  return [...byKey.values()].slice(-MAX_GROUPS);
}

/**
 * Sticky ink: marks stay with what they mark. While there are marks on the screen the student
 * is working on, the engine compares what's under them with how it looked a moment ago (no
 * pixels leave the engine for this). Scrolled: the marks move with it — and so do the turn's
 * marks still to come, and her cursor if it's pointing there. Gone (another app, a closed
 * tab): they clear, rather than point at the wrong thing.
 */
export class StickyInk {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private ticks = 0;
  /** Since when every group has been steady. */
  private quietSince = 0;
  private recent: { rect: Rect; until: number }[] = [];
  /** Screen captures include Pairwise's own windows everywhere but macOS: skip those pixels too. */
  private readonly overlaysCaptured = !env.isMac || process.env.PAIRWISE_CAPTURE_OVERLAYS === '1';

  constructor(private readonly s: TutorSession) {
    s.ink.on('op', () => this.wake());
    s.on('ended', () => this.sleep());
  }

  private get enabled(): boolean {
    // Paused vision means no looking at the screen at all, even locally.
    return this.s.isActive && this.s.settings.stickyInk && this.s.snapshot.vision === 'on';
  }

  private wake(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  private sleep(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.recent = [];
    this.quietSince = 0;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    if (!this.enabled) return this.sleep();
    const now = Date.now();
    if (this.quietSince && now - this.quietSince > QUIET_AFTER_MS && this.ticks++ % 2) return;
    const display = this.s.deps.platform.displays.byId(this.s.activeDisplayId);
    const items = this.s.ink.live('screen');
    const groups = display ? trackGroups(items, display.bounds, now) : [];
    if (!groups.length) return this.sleep();
    this.busy = true;
    try {
      const engine = this.s.deps.engine;
      const r = await engine.request({ type: 'trackInk', requestId: engine.nextRequestId('ink'), displayId: this.s.activeDisplayId, groups, masks: this.masks(items, now) }, 2000);
      if (!r.ok || !r.track || !this.enabled) return;
      for (const t of r.track) {
        const g = groups.find((x) => x.key === t.key);
        if (g) this.apply(t, g);
      }
      const quiet = r.track.every((t) => t.state === 'steady');
      if (!quiet) this.quietSince = 0;
      else if (!this.quietSince) this.quietSince = now;
    } catch (e) {
      log.warn('tracking failed', e);
    } finally {
      this.busy = false;
    }
  }

  /** Pixels to skip: the student's pointer, and where captures include them, Pairwise's own. */
  private masks(items: InkItem[], now: number): Rect[] {
    const p = this.s.deps.platform.displays.cursor();
    const out: Rect[] = [{ x: p.x - 4, y: p.y - 4, width: 26, height: 32 }];
    this.recent = this.recent.filter((r) => r.until > now);
    if (!this.overlaysCaptured) return out;
    // Her cursor where it is and where it just was (the captured frame lags a little).
    const c = this.s.cursor.currentFrame();
    for (let t = now - 450; t <= now; t += 75) {
      const p = t >= now ? c.pos : this.s.cursor.positionAt(t);
      out.push({ x: p.x - 6, y: p.y - 6, width: 34, height: 40 });
    }
    if (c.label) out.push({ x: c.pos.x + 8, y: c.pos.y + 16, width: 240, height: 36 });
    out.push(...this.s.overlays.uiRects());
    const hud = this.s.deps.hud.visible ? this.s.deps.hud.bounds() : null;
    if (hud) out.push(hud);
    for (const it of items) out.push(...inkCover(it));
    out.push(...this.recent.map((r) => r.rect));
    return out;
  }

  private filter(key: string): { group: string } | { ids: string[] } {
    return this.s.ink.all().some((i) => i.group === key) ? { group: key } : { ids: [key] };
  }

  private apply(t: TrackResult, g: TrackGroup): void {
    if (t.state === 'moved' && Math.abs(t.dy) >= 1) {
      const dy = Math.round(t.dy * 2) / 2;
      const now = Date.now();
      if (this.overlaysCaptured) {
        for (const it of this.s.ink.all()) if ((it.group ?? it.id) === t.key) for (const rect of inkCover(it)) this.recent.push({ rect, until: now + RECENT_MS });
      }
      const moved = this.s.ink.shift(this.filter(t.key), 0, dy, prefersReducedMotion() ? 0 : 140);
      this.s.visual.shiftWaiting(t.key, 0, dy);
      // Marks whose own line scrolled out of view (under a header, past the pane) go.
      const lost = (t.lost ?? []).map((k) => g.ids[k]).filter(Boolean);
      if (lost.length) this.s.ink.fade({ ids: lost });
      // Her cursor on one of these marks goes with it.
      const c = this.s.cursor.position;
      if (g.anchors.some((a) => rectContains(inflateRect(a, 40), c))) this.s.cursor.follow(0, dy);
      log.info(`marks ${t.key} moved ${dy} px with the screen (${moved.length})`);
    } else if (t.state === 'gone') {
      this.s.ink.fade(this.filter(t.key));
      this.s.visual.dropWaiting(t.key);
      log.info(`marks ${t.key} cleared: what they marked has gone`);
    }
  }
}
