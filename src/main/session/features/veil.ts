import type { Rect } from '@shared/geometry';
import { intersectRect } from '@shared/geometry';
import type { TutorSession } from '../tutor';
import { veiledRegions } from '../veil-geometry';
import { logger } from '../../log';

const log = logger('veil');
const POLL_MS = 350;

/**
 * App Veil: windows of the apps the student chose (Messages, Passwords, 1Password … by default)
 * and notification banners are painted black on every frame inside the engine, before encoding,
 * so their pixels never leave the Mac. The student sees a dashed orange outline on those windows.
 *
 * The window list is polled a few times a second (z-order aware: only the visible parts are
 * blacked out). A window that moved since the last poll is covered at both its old and new
 * position for one cycle, so dragging a veiled window doesn't leak its edge.
 */
export class VeilFeature {
  private timer: NodeJS.Timeout | null = null;
  private prev = new Map<number, Rect>();
  private lastKey = '';
  private busy = false;
  /** Number of windows currently hidden (shown in the HUD tooltip / tests). */
  hidden = 0;

  constructor(private readonly s: TutorSession) {
    s.on('ended', () => this.stop());
  }

  async start(): Promise<void> {
    this.stop();
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.prev.clear();
    this.lastKey = '';
    this.hidden = 0;
    this.s.deps.engine.command({ type: 'setVeil', rects: [] });
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = this.s.settings.veil;
      const displays = this.s.deps.platform.displays.list();
      const windows = cfg.apps.length || cfg.hideNotifications ? await this.s.deps.platform.windows.list() : [];
      const regions = veiledRegions(windows, { apps: cfg.apps, hideNotifications: cfg.hideNotifications, ownPid: process.pid, displays: displays.map((d) => d.bounds) });
      const rects: Rect[] = regions.flatMap((r) => r.visible);
      // Moving windows: also cover where they just were.
      const now = new Map<number, Rect>();
      for (const w of windows) {
        const r = regions.find((x) => x.window === w.bounds);
        if (!r) continue;
        now.set(w.id, w.bounds);
        const before = this.prev.get(w.id);
        if (before && (before.x !== w.bounds.x || before.y !== w.bounds.y || before.width !== w.bounds.width || before.height !== w.bounds.height)) {
          rects.push({ x: before.x - 12, y: before.y - 12, width: before.width + 24, height: before.height + 24 });
        }
      }
      this.prev = now;
      const entries = displays.map((d) => ({ displayId: d.id, rects: rects.flatMap((r) => intersectRect(r, d.bounds) ?? []) }));
      const outlines = cfg.showOutlines ? regions.map((r) => ({ rect: r.window, app: r.app })) : [];
      const key = JSON.stringify([entries, outlines]);
      this.hidden = regions.length;
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.s.deps.engine.command({ type: 'setVeil', rects: entries.filter((e) => e.rects.length) });
      this.s.ui.veilOutlines = outlines;
      this.s.pushUi();
      this.s.update({ veiledWindows: regions.length });
      if (regions.length) log.debug(`veiling ${regions.map((r) => r.app).join(', ')}`);
    } catch (e) {
      log.warn('veil refresh failed', e);
    } finally {
      this.busy = false;
    }
  }
}
