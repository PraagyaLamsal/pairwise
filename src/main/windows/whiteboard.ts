import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { createWindow, loadPage, registry } from './registry';
import { env } from '../env';
import type { EventMap } from '@shared/ipc';

/** The whiteboard: an ordinary window (so the tutor sees it in the screen frames like any app). */
export class WhiteboardWindow {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  onClosed: () => void = () => undefined;

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  get visible(): boolean {
    return Boolean(this.window?.isVisible());
  }

  /** Open (or bring back) the board, centred on `near` (a global point) or the cursor's display. */
  async open(near?: { x: number; y: number }, init?: EventMap['whiteboard:init'], workArea?: Rectangle): Promise<BrowserWindow> {
    const existing = this.window;
    if (existing) {
      this.raise();
      await this.ready;
      if (init) registry.sendTo(existing, 'whiteboard:init', init);
      return existing;
    }
    const wa = workArea ?? screen.getDisplayNearestPoint(near ?? screen.getCursorScreenPoint()).workArea;
    const width = Math.min(1120, Math.round(wa.width * 0.72));
    const height = Math.min(760, Math.round(width * 0.68), wa.height - 60);
    const bounds: Rectangle = { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2 + 20), width, height };
    const win = createWindow('whiteboard', {
      ...bounds,
      minWidth: 520,
      minHeight: 360,
      show: false,
      title: 'Whiteboard',
      backgroundColor: '#111419',
      titleBarStyle: env.isMac ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 16, y: 16 },
      autoHideMenuBar: true,
      fullscreenable: true,
    });
    this.win = win;
    win.on('close', (e) => {
      // Closing hides it; the board's ink stays for this session.
      if (!win.isDestroyed() && !(globalThis as { __quitting?: boolean }).__quitting) {
        e.preventDefault();
        win.hide();
        this.onClosed();
      }
    });
    this.ready = new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
    void loadPage(win, 'whiteboard', {}).catch(() => undefined);
    await this.ready;
    win.setBounds(bounds);
    this.raise();
    if (init) registry.sendTo(win, 'whiteboard:init', init);
    return win;
  }

  /** Show it in front of whatever the student has open, without taking focus, so a new drawing is seen. */
  raise(): void {
    const w = this.window;
    if (!w) return;
    // On macOS this orders it to the front even while Pairwise isn't the active app.
    w.showInactive();
    w.moveTop();
  }

  hide(): void {
    this.window?.hide();
  }

  destroy(): void {
    const w = this.window;
    this.win = null;
    if (w) w.destroy();
  }

  send<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
    registry.sendTo(this.window, channel as never, payload as never);
  }

  /** Board area in global DIP: the content area (the toolbar floats over it). */
  contentBounds(): Rectangle | null {
    const w = this.window;
    return w && w.isVisible() ? w.getContentBounds() : null;
  }

  async snapshot(): Promise<Buffer | null> {
    const w = this.window;
    if (!w || !w.isVisible()) return null;
    const img = await w.webContents.capturePage();
    return img.isEmpty() ? null : img.toPNG();
  }
}
