import { EventEmitter } from 'node:events';
import { ipcMain, session, desktopCapturer, type BrowserWindow } from 'electron';
import type { EncodedFrame, EngineCommand, SendMap } from '@shared/ipc';
import { createWindow, loadPage, registry } from './registry';
import { logger } from '../log';

const log = logger('engine');

type Reply = SendMap['engine:reply'];

/**
 * The engine is a hidden renderer that owns everything that needs Web APIs: microphone capture
 * with echo cancellation, gapless playback of the tutor's voice, and screen capture streams.
 * Main talks to it with commands; requests that need an answer use a request id.
 */
export class EngineHost extends EventEmitter {
  private win: BrowserWindow | null = null;
  private ready = false;
  private readyWaiters: (() => void)[] = [];
  private pending = new Map<string, { resolve: (r: Reply) => void; timer: NodeJS.Timeout }>();
  private seq = 0;

  constructor() {
    super();
    ipcMain.on('engine:ready', () => {
      this.ready = true;
      for (const w of this.readyWaiters.splice(0)) w();
      log.info('engine ready');
    });
    ipcMain.on('engine:reply', (_e, r: Reply) => {
      const p = this.pending.get(r.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(r.requestId);
      p.resolve(r);
    });
    ipcMain.on('engine:audio', (_e, m: SendMap['engine:audio']) => this.emit('audio', m));
    ipcMain.on('engine:micLevel', (_e, m: SendMap['engine:micLevel']) => this.emit('micLevel', m));
    ipcMain.on('engine:vad', (_e, m: SendMap['engine:vad']) => this.emit('vad', m));
    ipcMain.on('engine:playback', (_e, m: SendMap['engine:playback']) => this.emit('playback', m));
    ipcMain.on('engine:frame', (_e, m: EncodedFrame) => this.emit('frame', m));
    ipcMain.on('engine:log', (_e, m: SendMap['engine:log']) => log[m.level](m.message));
  }

  async ensure(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      if (!this.ready) await new Promise<void>((r) => this.readyWaiters.push(r));
      return;
    }
    this.ready = false;
    this.installPermissionHandlers();
    this.win = createWindow('engine', {
      show: false,
      width: 320,
      height: 240,
      webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    this.win.on('closed', () => {
      this.win = null;
      this.ready = false;
    });
    this.win.webContents.on('render-process-gone', (_e, d) => {
      log.error('engine renderer gone', d.reason);
      this.emit('crashed', d.reason);
    });
    const waiter = new Promise<void>((r) => this.readyWaiters.push(r));
    await loadPage(this.win, 'engine');
    await waiter;
  }

  command(cmd: EngineCommand): void {
    if (!this.win || this.win.isDestroyed()) return;
    registry.sendTo(this.win, 'engine:command', cmd);
  }

  /** Send a command that the engine answers with `engine:reply`. */
  request(cmd: Extract<EngineCommand, { requestId: string }>, timeoutMs = 4000): Promise<Reply> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmd.requestId);
        resolve({ requestId: cmd.requestId, ok: false, error: 'engine timeout' });
      }, timeoutMs);
      this.pending.set(cmd.requestId, { resolve, timer });
      this.command(cmd);
    });
  }

  /** Whether the active display looks like it's playing a video (frame-diff motion analysis). */
  async videoLikely(): Promise<boolean> {
    if (!this.win || this.win.isDestroyed()) return false;
    try {
      return Boolean(await this.win.webContents.executeJavaScript('window.pwVideoLikely ? window.pwVideoLikely() : false', true));
    } catch {
      return false;
    }
  }

  nextRequestId(prefix = 'req'): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  destroy(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
  }

  private permissionsInstalled = false;

  private installPermissionHandlers(): void {
    if (this.permissionsInstalled) return;
    this.permissionsInstalled = true;
    const ses = session.defaultSession;
    // Our pages are local; allow mic + display capture for them only.
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const url = details.requestingUrl || wc.getURL();
      const local = url.startsWith('file://') || url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1');
      callback(local && ['media', 'display-capture', 'mediaKeySystem', 'clipboard-sanitized-write'].includes(permission));
    });
    ses.setPermissionCheckHandler((_wc, permission, origin) => {
      const local = origin.startsWith('file://') || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
      return local && ['media', 'display-capture'].includes(permission);
    });
    // getDisplayMedia fallback: hand over the screen the engine asked for, never a picker.
    ses.setDisplayMediaRequestHandler(
      (_req, callback) => {
        void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
          const wanted = sources.find((s) => s.display_id === this.preferredDisplayId) ?? sources[0];
          callback(wanted ? { video: wanted } : {});
        });
      },
      { useSystemPicker: false },
    );
  }

  preferredDisplayId = '';
}
