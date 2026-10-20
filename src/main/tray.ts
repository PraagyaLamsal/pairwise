import { join } from 'node:path';
import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { APP_NAME } from '@shared/app-info';
import type { Course } from '@shared/courses';
import type { SessionSnapshot, UsageSummary } from '@shared/session';
import { formatAccelerator } from '@shared/shortcuts';
import type { Settings } from '@shared/settings';
import { formatUsd } from '@shared/pricing';
import { env } from './env';

export interface TrayActions {
  startSession(courseId: string, resume?: boolean): void;
  endSession(): void;
  toggleMute(): void;
  toggleVision(): void;
  toggleWhiteboard(): void;
  openHub(tab?: string): void;
  quit(): void;
}

function iconPath(name: string): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'icons') : join(__dirname, '../../resources/icons');
  return join(base, name);
}

export function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Menu bar item: start/resume a course, live timer in the title, quick session controls. */
export class AppTray {
  private tray: Tray | null = null;
  private idleIcon = nativeImage.createEmpty();
  private liveIcon = nativeImage.createEmpty();
  private lastTitle = '';

  constructor(
    private readonly actions: TrayActions,
    private readonly data: () => { courses: Course[]; snapshot: SessionSnapshot; usage: UsageSummary; settings: Settings },
  ) {}

  create(): void {
    this.idleIcon = nativeImage.createFromPath(iconPath('trayTemplate.png'));
    this.liveIcon = nativeImage.createFromPath(iconPath('tray-liveTemplate.png'));
    if (env.isMac) {
      this.idleIcon.setTemplateImage(true);
      this.liveIcon.setTemplateImage(true);
    }
    this.tray = new Tray(this.idleIcon);
    this.tray.setToolTip(APP_NAME);
    this.refresh();
  }

  /** Rebuild the menu (cheap; called on state changes, not every second). */
  refresh(): void {
    if (!this.tray) return;
    const { courses, snapshot, usage, settings } = this.data();
    const live = snapshot.status !== 'idle' && snapshot.status !== 'error';
    const sc = (a: keyof Settings['shortcuts']) => formatAccelerator(settings.shortcuts[a], process.platform);
    const items: MenuItemConstructorOptions[] = [];

    if (live) {
      items.push(
        { label: `● ${snapshot.courseLabel ?? 'Session'} — ${formatClock(snapshot.elapsedMs)}`, enabled: false },
        { label: snapshot.vision === 'on' ? `${settings.tutorName} can see ${snapshot.visibleDisplayLabel ?? 'your screen'}` : 'Screen view paused', enabled: false },
        { type: 'separator' },
        { label: snapshot.muted ? 'Unmute microphone' : 'Mute microphone', accelerator: sc('toggleMute'), registerAccelerator: false, click: () => this.actions.toggleMute() },
        { label: snapshot.vision === 'on' ? 'Pause screen view' : 'Resume screen view', accelerator: sc('toggleVision'), registerAccelerator: false, click: () => this.actions.toggleVision() },
        { label: snapshot.whiteboard ? 'Close whiteboard' : 'Open whiteboard', click: () => this.actions.toggleWhiteboard() },
        { label: 'End session', accelerator: sc('toggleSession'), registerAccelerator: false, click: () => this.actions.endSession() },
      );
    } else {
      const startItems: MenuItemConstructorOptions[] = courses.length
        ? courses.map((c) => ({ label: `${c.code}${c.name ? ` · ${c.name}` : ''}`, click: () => this.actions.startSession(c.id) }))
        : [{ label: 'Add a course first…', click: () => this.actions.openHub('courses') }];
      items.push({ label: `${APP_NAME}`, enabled: false }, { label: 'Start session', submenu: startItems });
      const last = courses.find((c) => c.id === settings.lastCourseId) ?? courses[0];
      if (last) items.push({ label: `Resume ${last.code}`, accelerator: sc('toggleSession'), registerAccelerator: false, click: () => this.actions.startSession(last.id, true) });
    }

    items.push(
      { type: 'separator' },
      { label: `Open ${APP_NAME}…`, click: () => this.actions.openHub('courses') },
      { label: 'Settings…', accelerator: 'Command+,', registerAccelerator: false, click: () => this.actions.openHub('settings') },
      { label: `This month: ${formatUsd(usage.monthUsd)} of ${formatUsd(usage.limitUsd)}`, click: () => this.actions.openHub('usage') },
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, accelerator: 'Command+Q', registerAccelerator: false, click: () => this.actions.quit() },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.tray.setImage(live ? this.liveIcon : this.idleIcon);
    this.tick();
  }

  /** Per-second update of the menu-bar title (timer next to the icon on macOS). */
  tick(): void {
    if (!this.tray) return;
    const { snapshot } = this.data();
    const live = snapshot.status === 'live' || snapshot.status === 'reconnecting' || snapshot.status === 'connecting';
    const title = live ? ` ${formatClock(snapshot.elapsedMs)}${snapshot.muted ? ' · muted' : ''}` : '';
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      if (env.isMac) this.tray.setTitle(title, { fontType: 'monospacedDigit' });
      this.tray.setToolTip(live ? `${APP_NAME} — live${title}` : APP_NAME);
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
