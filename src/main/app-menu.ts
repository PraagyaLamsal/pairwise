import { Menu, app, type MenuItemConstructorOptions } from 'electron';
import { APP_NAME } from '@shared/app-info';
import type { Course } from '@shared/courses';
import type { SessionSnapshot } from '@shared/session';
import type { Settings } from '@shared/settings';
import type { TrayActions } from './tray';
import { env } from './env';

/**
 * Pairwise is a normal Dock app (with its menu-bar icon too): clicking the Dock icon opens the
 * hub, the Dock menu starts or ends a session, and the app menu has the usual items (an Edit
 * menu, so copy and paste work in text fields; Settings… on ⌘,).
 */
export class AppMenus {
  constructor(
    private readonly actions: TrayActions,
    private readonly data: () => { courses: Course[]; snapshot: SessionSnapshot; settings: Settings },
  ) {}

  refresh(): void {
    const { courses, snapshot, settings } = this.data();
    const live = snapshot.status !== 'idle' && snapshot.status !== 'error';
    const last = courses.find((c) => c.id === settings.lastCourseId) ?? courses[0];
    const startItems: MenuItemConstructorOptions[] = courses.length
      ? courses.map((c) => ({ label: `${c.code}${c.name ? ` · ${c.name}` : ''}`, click: () => this.actions.startSession(c.id) }))
      : [{ label: 'Add a course first…', click: () => this.actions.openHub('courses') }];

    const session: MenuItemConstructorOptions[] = live
      ? [
          { label: `End session${snapshot.courseLabel ? ` (${snapshot.courseLabel})` : ''}`, accelerator: settings.shortcuts.toggleSession, registerAccelerator: false, click: () => this.actions.endSession() },
          { type: 'separator' },
          { label: snapshot.muted ? 'Unmute microphone' : 'Mute microphone', accelerator: settings.shortcuts.toggleMute, registerAccelerator: false, click: () => this.actions.toggleMute() },
          { label: snapshot.vision === 'on' ? 'Pause screen view' : 'Resume screen view', accelerator: settings.shortcuts.toggleVision, registerAccelerator: false, click: () => this.actions.toggleVision() },
          { label: snapshot.whiteboard ? 'Close whiteboard' : 'Open whiteboard', accelerator: settings.shortcuts.toggleWhiteboard, registerAccelerator: false, click: () => this.actions.toggleWhiteboard() },
        ]
      : [
          { label: 'Start session', submenu: startItems },
          ...(last ? [{ label: `Resume ${last.code}`, accelerator: settings.shortcuts.toggleSession, registerAccelerator: false, click: () => this.actions.startSession(last.id, true) } satisfies MenuItemConstructorOptions] : []),
        ];

    if (env.isMac) {
      const appMenu: MenuItemConstructorOptions[] = [
        {
          label: APP_NAME,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: 'Settings…', accelerator: 'Command+,', click: () => this.actions.openHub('settings') },
            { label: 'Setup & checks…', click: () => this.actions.openHub('diagnostics') },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        { label: 'Session', submenu: session },
        { role: 'windowMenu' },
      ];
      Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu));
      // The Dock menu (macOS adds Options and Quit underneath).
      const dock: MenuItemConstructorOptions[] = [...session, { type: 'separator' }, { label: `Open ${APP_NAME}`, click: () => this.actions.openHub('courses') }];
      app.dock?.setMenu(Menu.buildFromTemplate(dock));
    }
  }
}
