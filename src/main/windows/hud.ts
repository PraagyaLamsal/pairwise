import type { BrowserWindow } from 'electron';
import type { DisplayInfo } from '@shared/geometry';
import { createWindow, loadPage, safeDestroy } from './registry';
import { env } from '../env';

const DEFAULT_SIZE = { width: 300, height: 50 };

/** The floating session bar (timer, mic, captions, controls). Sized to its content by the renderer. */
export class HudWindow {
  private win: BrowserWindow | null = null;
  private size = { ...DEFAULT_SIZE };

  constructor(private readonly placement: () => { display: DisplayInfo; saved?: { x: number; y: number } }) {}

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  show(): void {
    if (this.window) {
      this.window.showInactive();
      return;
    }
    const { display, saved } = this.placement();
    const pos = saved ?? {
      x: Math.round(display.workArea.x + (display.workArea.width - this.size.width) / 2),
      y: Math.round(display.workArea.y + 8),
    };
    this.win = createWindow('hud', {
      x: pos.x,
      y: pos.y,
      width: this.size.width,
      height: this.size.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: env.isMac ? false : true,
      acceptFirstMouse: true,
      roundedCorners: false,
      ...(env.isMac ? { type: 'panel' as const } : {}),
      webPreferences: { backgroundThrottling: false },
    });
    this.win.setAlwaysOnTop(true, 'floating');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    if (process.env.PAIRWISE_CAPTURE_OVERLAYS !== '1') this.win.setContentProtection(true);
    const win = this.win;
    void loadPage(win, 'hud').catch(() => undefined).then(() => {
      if (!win.isDestroyed() && win === this.win) win.showInactive();
    });
  }

  hide(): void {
    this.window?.hide();
  }

  toggle(): boolean {
    const w = this.window;
    if (!w) return false;
    if (w.isVisible()) w.hide();
    else w.showInactive();
    return w.isVisible();
  }

  get visible(): boolean {
    return Boolean(this.window?.isVisible());
  }

  setSize(width: number, height: number): void {
    const w = this.window;
    this.size = { width: Math.ceil(width), height: Math.ceil(height) };
    if (!w) return;
    const b = w.getBounds();
    // Keep the bar horizontally centred on where it was.
    const cx = b.x + b.width / 2;
    w.setBounds({ x: Math.round(cx - this.size.width / 2), y: b.y, width: this.size.width, height: this.size.height });
  }

  moveBy(dx: number, dy: number): { x: number; y: number } | null {
    const w = this.window;
    if (!w) return null;
    const b = w.getBounds();
    w.setBounds({ ...b, x: b.x + Math.round(dx), y: b.y + Math.round(dy) });
    return { x: b.x + Math.round(dx), y: b.y + Math.round(dy) };
  }

  bounds() {
    return this.window?.getBounds() ?? null;
  }

  destroy(): void {
    safeDestroy(this.window);
    this.win = null;
  }
}
