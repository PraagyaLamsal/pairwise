import { inflateRect, rectContains, rectsIntersect, unionRects, type Rect } from '@shared/geometry';
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
/**
 * After a move, the way from the old place to the new stays masked a moment: the marks glide
 * there, and a capture can catch them anywhere along it (or not yet redrawn).
 */
const RECENT_MS = 700;
/** At most this many groups are followed (the newest). */
const MAX_GROUPS = 8;
/** Marks whose content went away are hidden this long, in case it comes back, then let go. */
const AWAY_MS = 90_000;

/**
 * Groups of marks for the engine: each one's key and what each of its marks is about. A group
 * whose content went away (`away`: its key → the marks hidden then) is looked for where it was.
 */
export function trackGroups(items: InkItem[], display: Rect, now = Date.now(), away?: ReadonlyMap<string, { ids: string[] }>): TrackGroup[] {
  const byKey = new Map<string, TrackGroup>();
  for (const it of items) {
    // Fading marks (a cleared group among them) aren't followed.
    if (it.surface !== 'screen' || (it.fadeAt != null && it.fadeAt <= now)) continue;
    const key = it.group ?? it.id;
    const a = inkAnchor(it);
    if (!a) continue;
    const g = byKey.get(key) ?? { key, anchors: [], ids: [], parked: [] };
    const gone = away?.get(key);
    if (gone) {
      if (!gone.ids.includes(it.id)) continue;
      g.away = true;
      g.anchors.push(a);
      g.ids.push(it.id);
    } else if (it.park?.on) {
      // A parked mark's line is out of view: it's looked for, not followed.
      g.parked!.push({ id: it.id, anchor: a });
    } else if (rectsIntersect(a, display)) {
      g.anchors.push(a);
      g.ids.push(it.id);
    } else continue;
    byKey.set(key, g);
  }
  // A group with nothing in view can't be followed (its parked marks stay as they are).
  return [...byKey.values()].filter((g) => g.anchors.length).slice(-MAX_GROUPS);
}

/**
 * Sticky ink: marks stay with what they mark. While there are marks on the screen the student
 * is working on, the engine compares what's under them with how it looked a moment ago (no
 * pixels leave the engine for this). Scrolled, or the window dragged: the marks move with it —
 * and so do the turn's marks still to come, and her cursor if it's pointing there. Gone
 * (another app, a closed tab): they hide rather than point at the wrong thing, and come back
 * if it does.
 */
export class StickyInk {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private ticks = 0;
  /** Since when every group has been steady. */
  private quietSince = 0;
  private recent: { rect: Rect; until: number }[] = [];
  /** Groups whose content went away (another app, a far scroll): when, and which marks were hidden. */
  private away = new Map<string, { since: number; ids: string[] }>();
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
    if (!this.s.isActive) this.away.clear();
  }

  /** Away too long: let those marks go. */
  private expireAway(now: number): void {
    for (const [key, a] of this.away) {
      if (now - a.since < AWAY_MS) continue;
      this.away.delete(key);
      this.s.ink.fade({ ids: a.ids });
      log.info(`marks ${key} let go: what they marked didn't come back`);
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    if (!this.enabled) return this.sleep();
    const now = Date.now();
    if (this.quietSince && now - this.quietSince > QUIET_AFTER_MS && this.ticks++ % 2) return;
    this.expireAway(now);
    const display = this.s.deps.platform.displays.byId(this.s.activeDisplayId);
    const items = this.s.ink.live('screen');
    const groups = display ? trackGroups(items, display.bounds, now, this.away) : [];
    for (const key of [...this.away.keys()]) if (!groups.some((g) => g.key === key)) this.away.delete(key);
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
      // Nothing moving, or only looking for what went away: half as often after a while (a look
      // for it can mean a search of the whole screen).
      const quiet = r.track.every((t) => t.state === 'steady' || (t.state === 'unsure' && this.away.has(t.key)));
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
    // (A little past each mark: a pill's soft edge spills over its box.)
    for (const it of items) out.push(...inkCover(it).map((r) => inflateRect(r, 2)));
    out.push(...this.recent.map((r) => r.rect));
    return out;
  }

  private filter(key: string): { group: string } | { ids: string[] } {
    return this.s.ink.all().some((i) => i.group === key) ? { group: key } : { ids: [key] };
  }

  private apply(t: TrackResult, g: TrackGroup): void {
    const dx = Math.round((t.dx ?? 0) * 2) / 2;
    if (t.state === 'moved' && (Math.abs(t.dy) >= 1 || Math.abs(dx) >= 1)) {
      const dy = Math.round(t.dy * 2) / 2;
      const now = Date.now();
      if (this.overlaysCaptured) {
        for (const it of this.s.ink.all()) {
          if ((it.group ?? it.id) !== t.key) continue;
          for (const rect of inkCover(it)) this.recent.push({ rect: inflateRect(unionRects([rect, { ...rect, x: rect.x + dx, y: rect.y + dy }])!, 2), until: now + RECENT_MS });
        }
      }
      const moved = this.s.ink.shift(this.filter(t.key), dx, dy, prefersReducedMotion() ? 0 : 140);
      this.s.visual.shiftWaiting(t.key, dx, dy);
      // Marks whose own line scrolled out of view (under a header, past the pane) are parked
      // until it's back; ones whose line came back into view show again.
      const lost = (t.lost ?? []).map((k) => g.ids[k]).filter(Boolean);
      if (lost.length) this.s.ink.park(lost, true);
      // Her cursor on one of these marks goes with it.
      const c = this.s.cursor.position;
      if (g.anchors.some((a) => rectContains(inflateRect(a, 40), c))) this.s.cursor.follow(dx, dy);
      log.info(`marks ${t.key} moved ${dx ? `${dx}, ` : ''}${dy} px with the screen (${moved.length})`);
    }
    if (t.back?.length) this.s.ink.park(t.back, false);
    if (t.forget?.length) this.s.ink.fade({ ids: t.forget });
    if (t.state === 'gone') {
      // Hidden, not cleared: if what they mark comes back (they switch back, or scroll back to
      // it) so do they. The rest of the turn's marks would land on nothing, so those go.
      const ids = g.ids.filter((id) => !this.s.ink.all().find((i) => i.id === id)?.park?.on);
      this.s.ink.park(ids, true);
      this.away.set(t.key, { since: Date.now(), ids });
      this.s.visual.dropWaiting(t.key);
      log.info(`marks ${t.key} hidden: what they marked has gone`);
    } else if (t.state === 'back') {
      const a = this.away.get(t.key);
      this.away.delete(t.key);
      const dy = Math.round(t.dy * 2) / 2;
      if (Math.abs(dy) >= 1 || Math.abs(dx) >= 1) {
        this.s.ink.shift(this.filter(t.key), dx, dy, 0);
        this.s.visual.shiftWaiting(t.key, dx, dy);
        // Her cursor, if it was resting among them, comes back with them.
        const c = this.s.cursor.position;
        if (g.anchors.some((r) => rectContains(inflateRect(r, 40), c))) this.s.cursor.follow(dx, dy);
      }
      if (a) this.s.ink.park(a.ids, false);
      log.info(`marks ${t.key} back with what they mark (${dx ? `${dx}, ` : ''}${dy} px)`);
    }
  }
}
