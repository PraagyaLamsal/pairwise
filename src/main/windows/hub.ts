import { app, type BrowserWindow } from 'electron';
import { APP_NAME } from '@shared/app-info';
import { createWindow, loadPage, registry } from './registry';
import { env } from '../env';

/** Main app window: course picker, settings, onboarding, usage, diagnostics. */
export class HubWindow {
  private win: BrowserWindow | null = null;
  /** hide() called while the window was still loading: don't pop it up when it's ready. */
  private hiddenWhileLoading = false;

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  open(tab?: string): BrowserWindow {
    this.hiddenWhileLoading = false;
    const existing = this.window;
    if (existing) {
      if (tab) registry.sendTo(existing, 'hub:navigate', { tab });
      existing.show();
      existing.focus();
      if (env.isMac) app.focus({ steal: true });
      return existing;
    }
    this.win = createWindow('hub', {
      width: 1060,
      height: 720,
      minWidth: 860,
      minHeight: 600,
      show: false,
      title: APP_NAME,
      backgroundColor: '#0E1013',
      titleBarStyle: env.isMac ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 18, y: 18 },
      autoHideMenuBar: true,
    });
    this.win.once('ready-to-show', () => {
      if (this.hiddenWhileLoading) return;
      this.win?.show();
      if (env.isMac) app.focus({ steal: true });
    });
    void loadPage(this.win, 'hub', tab ? { tab } : {}).catch(() => undefined);
    return this.win;
  }

  hide(): void {
    this.hiddenWhileLoading = true;
    this.window?.hide();
  }

  close(): void {
    this.window?.close();
  }
}
