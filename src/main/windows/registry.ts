import { join } from 'node:path';
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import type { EventChannel, EventMap, WindowRole } from '@shared/ipc';
import { env } from '../env';

const PRELOAD = join(__dirname, '../preload/index.js');

/** Keeps track of every window by role so services can broadcast typed events. */
class WindowRegistry {
  private readonly byRole = new Map<WindowRole, Set<BrowserWindow>>();

  add(role: WindowRole, win: BrowserWindow): void {
    const set = this.byRole.get(role) ?? new Set<BrowserWindow>();
    set.add(win);
    this.byRole.set(role, set);
    win.on('closed', () => set.delete(win));
  }

  windows(role: WindowRole): BrowserWindow[] {
    return [...(this.byRole.get(role) ?? [])].filter((w) => !w.isDestroyed());
  }

  send<K extends EventChannel>(role: WindowRole | WindowRole[], channel: K, payload: EventMap[K]): void {
    const roles = Array.isArray(role) ? role : [role];
    for (const r of roles) for (const w of this.windows(r)) if (!w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  }

  sendTo<K extends EventChannel>(win: BrowserWindow | undefined | null, channel: K, payload: EventMap[K]): void {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }

  broadcast<K extends EventChannel>(channel: K, payload: EventMap[K]): void {
    for (const set of this.byRole.values()) for (const w of set) if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

export const registry = new WindowRegistry();

export function createWindow(
  role: WindowRole,
  options: BrowserWindowConstructorOptions,
  extraArgs: string[] = [],
): BrowserWindow {
  const win = new BrowserWindow({
    ...options,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: [`--pw-role=${role}`, ...extraArgs],
      ...options.webPreferences,
    },
  });
  registry.add(role, win);
  return win;
}

/**
 * Destroying a window while its page is still loading can crash Chromium (seen with rapid
 * start/end). Hide immediately, destroy once loading has settled.
 */
export function safeDestroy(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  try {
    win.hide();
  } catch {
    /* ignore */
  }
  const wc = win.webContents;
  const kill = () => setImmediate(() => !win.isDestroyed() && win.destroy());
  if (!wc.isDestroyed() && wc.isLoading()) {
    const timer = setTimeout(kill, 3000);
    const done = () => {
      clearTimeout(timer);
      kill();
    };
    wc.once('did-finish-load', done);
    wc.once('did-fail-load', done);
  } else kill();
}

/** Loads a renderer page from the Vite dev server in development or the built files otherwise. */
export function loadPage(win: BrowserWindow, page: WindowRole, query: Record<string, string> = {}): Promise<void> {
  const qs = new URLSearchParams(query).toString();
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (env.isDev && devUrl) return win.loadURL(`${devUrl}/${page}/index.html${qs ? `?${qs}` : ''}`);
  return win.loadFile(join(__dirname, `../renderer/${page}/index.html`), { query });
}
