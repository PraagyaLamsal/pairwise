import type { Rect } from '@shared/geometry';
import type { WindowInfo } from '../platform/types';

/** a − b as up to four rectangles. */
export function subtractRect(a: Rect, b: Rect): Rect[] {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return [a];
  const out: Rect[] = [];
  if (y1 > a.y) out.push({ x: a.x, y: a.y, width: a.width, height: y1 - a.y }); // above
  if (y2 < a.y + a.height) out.push({ x: a.x, y: y2, width: a.width, height: a.y + a.height - y2 }); // below
  if (x1 > a.x) out.push({ x: a.x, y: y1, width: x1 - a.x, height: y2 - y1 }); // left
  if (x2 < a.x + a.width) out.push({ x: x2, y: y1, width: a.x + a.width - x2, height: y2 - y1 }); // right
  return out.filter((r) => r.width > 0.5 && r.height > 0.5);
}

export interface VeilMatch {
  name: string;
  bundleId?: string;
}

export interface VeiledRegion {
  app: string;
  /** The whole window (for the outline the student sees). */
  window: Rect;
  /** The parts actually visible (what gets painted black in frames). */
  visible: Rect[];
}

const NOTIFICATIONS = /^(com\.apple\.notificationcenterui|com\.apple\.UserNotificationCenter)$/;

export function isVeiled(w: WindowInfo, apps: VeilMatch[], hideNotifications: boolean): boolean {
  if (hideNotifications && ((w.bundleId && NOTIFICATIONS.test(w.bundleId)) || /^notification ?cent(er|re)$/i.test(w.app))) return true;
  return apps.some((a) => (a.bundleId && w.bundleId ? a.bundleId === w.bundleId : a.name.trim().toLowerCase() === w.app.trim().toLowerCase()));
}

/**
 * Which parts of veiled windows are on screen. `windows` is front-to-back (as macOS lists them).
 * A veiled window is clipped by ordinary windows in front of it — except windows the size of a
 * whole display, which may be transparent overlays (other screen tools); those never "cover" a
 * veiled window, so in doubt more is hidden, not less. Pairwise's own windows are ignored.
 */
export function veiledRegions(windows: WindowInfo[], opts: { apps: VeilMatch[]; hideNotifications: boolean; ownPid: number; displays: Rect[]; margin?: number }): VeiledRegion[] {
  const margin = opts.margin ?? 6;
  const list = windows.filter((w) => w.pid !== opts.ownPid && w.bounds.width > 2 && w.bounds.height > 2);
  const fullScreenish = (r: Rect) => opts.displays.some((d) => r.width * r.height >= d.width * d.height * 0.98 && r.x <= d.x + 2 && r.y <= d.y + 2);
  const out: VeiledRegion[] = [];
  list.forEach((w, i) => {
    if (!isVeiled(w, opts.apps, opts.hideNotifications)) return;
    const win = { x: w.bounds.x - margin, y: w.bounds.y - margin, width: w.bounds.width + margin * 2, height: w.bounds.height + margin * 2 };
    let parts: Rect[] = [win];
    for (const front of list.slice(0, i)) {
      if (isVeiled(front, opts.apps, opts.hideNotifications) || fullScreenish(front.bounds)) continue;
      // Shrink the occluder a little so edges near the veiled window stay covered.
      const b = { x: front.bounds.x + 2, y: front.bounds.y + 2, width: front.bounds.width - 4, height: front.bounds.height - 4 };
      parts = parts.flatMap((p) => subtractRect(p, b));
      if (!parts.length) break;
    }
    if (parts.length) out.push({ app: w.app, window: w.bounds, visible: parts });
  });
  return out;
}
