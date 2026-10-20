import { describe, expect, it } from 'vitest';
import { subtractRect, veiledRegions, isVeiled } from '../../src/main/session/veil-geometry';

const display = { x: 0, y: 0, width: 1440, height: 900 };
const win = (id: number, app: string, bounds: { x: number; y: number; width: number; height: number }, extra = {}) => ({ id, title: '', app, bounds, pid: 100 + id, ...extra });
const area = (rs: { width: number; height: number }[]) => rs.reduce((a, r) => a + r.width * r.height, 0);

describe('App Veil geometry', () => {
  it('subtracts rectangles', () => {
    expect(subtractRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 200, y: 0, width: 10, height: 10 })).toEqual([{ x: 0, y: 0, width: 100, height: 100 }]);
    const parts = subtractRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 25, y: 25, width: 50, height: 50 });
    expect(parts).toHaveLength(4);
    expect(area(parts)).toBe(100 * 100 - 50 * 50);
    expect(subtractRect({ x: 0, y: 0, width: 100, height: 100 }, { x: -10, y: -10, width: 200, height: 200 })).toEqual([]);
  });

  it('veils only the visible part of a veiled window (z-order), with a safety margin', () => {
    const msgs = win(1, 'Messages', { x: 100, y: 100, width: 400, height: 300 }, { bundleId: 'com.apple.MobileSMS' });
    const front = win(2, 'Safari', { x: 300, y: 250, width: 400, height: 300 });
    const r = veiledRegions([front, msgs], { apps: [{ name: 'Messages', bundleId: 'com.apple.MobileSMS' }], hideNotifications: false, ownPid: 1, displays: [display] });
    expect(r).toHaveLength(1);
    const visible = area(r[0].visible);
    const full = (400 + 12) * (300 + 12);
    // Overlap of the (6 px inflated) Messages window and the (2 px shrunk) window in front.
    expect(visible).toBe(full - (506 - 302) * (406 - 252));
    // A window *behind* doesn't reduce what's hidden.
    const behind = veiledRegions([msgs, front], { apps: [{ name: 'Messages' }], hideNotifications: false, ownPid: 1, displays: [display] });
    expect(area(behind[0].visible)).toBe(full);
  });

  it('never lets a full-screen (possibly transparent) window or Pairwise itself uncover a veiled one', () => {
    const msgs = win(1, 'Messages', { x: 100, y: 100, width: 400, height: 300 });
    const overlay = win(3, 'SomeOverlayTool', { x: 0, y: 0, width: 1440, height: 900 });
    const ours = { ...win(4, 'Pairwise', { x: 0, y: 0, width: 800, height: 600 }), pid: 1 };
    const r = veiledRegions([ours, overlay, msgs], { apps: [{ name: 'Messages' }], hideNotifications: false, ownPid: 1, displays: [display] });
    expect(area(r[0].visible)).toBe((400 + 12) * (300 + 12));
  });

  it('matches apps by bundle id or name, and notification banners', () => {
    expect(isVeiled(win(1, 'Messages', display, { bundleId: 'com.apple.MobileSMS' }), [{ name: 'Messages', bundleId: 'com.apple.MobileSMS' }], false)).toBe(true);
    expect(isVeiled(win(1, '1Password 8', display), [{ name: '1password 8' }], false)).toBe(true);
    expect(isVeiled(win(1, 'Safari', display), [{ name: 'Messages' }], false)).toBe(false);
    expect(isVeiled(win(1, 'Notification Center', display, { bundleId: 'com.apple.notificationcenterui' }), [], true)).toBe(true);
    expect(isVeiled(win(1, 'Notification Center', display, { bundleId: 'com.apple.notificationcenterui' }), [], false)).toBe(false);
  });
});
