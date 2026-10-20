import type { Rect } from '@shared/geometry';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import type { DisplayInfo } from '@shared/geometry';
import type { EventChannel, EventMap, OverlayInit } from '@shared/ipc';
import { createWindow, loadPage, registry, safeDestroy } from './registry';
import { env } from '../env';
import { logger } from '../log';

const log = logger('overlays');

interface OverlayEntry {
  display: DisplayInfo;
  win: BrowserWindow;
  ready: boolean;
  queue: { channel: EventChannel; payload: unknown }[];
}

/**
 * One transparent, click-through, content-protected window per display. Every overlay renders
 * the same global scene translated by its display origin.
 */
export class OverlayManager extends EventEmitter {
  private readonly entries = new Map<string, OverlayEntry>();
  private initFor: (display: DisplayInfo) => OverlayInit;
  private interactive = new Set<string>();

  constructor(initFor: (display: DisplayInfo) => OverlayInit) {
    super();
    this.initFor = initFor;
  }

  get active(): boolean {
    return this.entries.size > 0;
  }

  displayIds(): string[] {
    return [...this.entries.keys()];
  }

  windowFor(displayId: string): BrowserWindow | undefined {
    return this.entries.get(displayId)?.win;
  }

  /** Create/position overlays for exactly these displays (adds, moves and removes as needed). */
  sync(displays: DisplayInfo[]): void {
    const wanted = new Set(displays.map((d) => d.id));
    for (const [id, entry] of this.entries) {
      if (!wanted.has(id)) {
        safeDestroy(entry.win);
        this.entries.delete(id);
      }
    }
    for (const d of displays) {
      const existing = this.entries.get(d.id);
      if (existing && !existing.win.isDestroyed()) {
        existing.display = d;
        existing.win.setBounds(d.bounds);
        if (existing.ready) registry.sendTo(existing.win, 'overlay:init', this.initFor(d));
        continue;
      }
      this.entries.set(d.id, this.create(d));
    }
  }

  private create(display: DisplayInfo): OverlayEntry {
    const win = createWindow(
      'overlay',
      {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        enableLargerThanScreen: true,
        roundedCorners: false,
        ...(env.isMac ? { type: 'panel' as const } : {}),
        webPreferences: { backgroundThrottling: false },
      },
      [`--pw-display=${display.id}`],
    );
    const entry: OverlayEntry = { display, win, ready: false, queue: [] };
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    // Our own ink must never appear in frames sent to the tutor.
    if (process.env.PAIRWISE_CAPTURE_OVERLAYS !== '1') win.setContentProtection(true);
    win.webContents.on('did-finish-load', () => {
      registry.sendTo(win, 'overlay:init', this.initFor(entry.display));
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('overlay renderer gone', details.reason);
      this.entries.delete(display.id);
      safeDestroy(win);
      this.emit('crashed', display.id);
    });
    void loadPage(win, 'overlay', { display: display.id }).catch(() => undefined).then(() => {
      if (win.isDestroyed()) return;
      win.setBounds(entry.display.bounds);
      win.showInactive();
    });
    return entry;
  }

  /** Called when an overlay renderer reports it has painted its first frame. */
  markReady(displayId: string): void {
    const e = this.entries.get(displayId);
    if (!e) return;
    e.ready = true;
    for (const q of e.queue.splice(0)) registry.sendTo(e.win, q.channel, q.payload as never);
    this.emit('ready', displayId);
  }

  allReady(): boolean {
    return [...this.entries.values()].every((e) => e.ready);
  }

  send<K extends EventChannel>(channel: K, payload: EventMap[K], displayId?: string): void {
    for (const [id, e] of this.entries) {
      if (displayId && id !== displayId) continue;
      if (e.ready) registry.sendTo(e.win, channel, payload);
      else if (channel !== 'overlay:cursor') e.queue.push({ channel, payload });
    }
  }

  /** Draw mode: the overlay(s) start receiving mouse input instead of passing it through. */
  setInteractive(displayIds: string[] | 'all', on: boolean): void {
    for (const [id, e] of this.entries) {
      const target = displayIds === 'all' || displayIds.includes(id);
      if (!target || e.win.isDestroyed()) continue;
      if (on) this.interactive.add(id);
      else this.interactive.delete(id);
      e.win.setIgnoreMouseEvents(!on, on ? undefined : { forward: true });
    }
  }

  /** Temporarily accept clicks while the pointer is over a card (consent buttons, step card). */
  private uiRectsByDisplay = new Map<string, Rect[]>();

  /** The overlays' own UI (cards, pills, toasts) in global DIP, as last reported. */
  uiRects(): Rect[] {
    return [...this.uiRectsByDisplay.entries()].filter(([id]) => this.entries.has(id)).flatMap(([, r]) => r);
  }

  setUiRects(displayId: string, rects: Rect[]): void {
    this.uiRectsByDisplay.set(displayId, Array.isArray(rects) ? rects.slice(0, 40) : []);
  }

  setHoverInteractive(displayId: string, on: boolean): void {
    const e = this.entries.get(displayId);
    if (!e || e.win.isDestroyed() || this.interactive.has(displayId)) return;
    e.win.setIgnoreMouseEvents(!on, on ? undefined : { forward: true });
  }

  async capture(displayId: string): Promise<Buffer | null> {
    const e = this.entries.get(displayId);
    if (!e || e.win.isDestroyed()) return null;
    const img = await e.win.webContents.capturePage();
    return img.toPNG();
  }

  destroyAll(): void {
    for (const e of this.entries.values()) safeDestroy(e.win);
    this.entries.clear();
    this.interactive.clear();
  }
}
