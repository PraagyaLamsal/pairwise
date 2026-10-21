import type { IndexStatus } from '@shared/courses';
import { join } from 'node:path';
import { app, dialog, ipcMain, Notification, shell, type IpcMainInvokeEvent } from 'electron';
import { basename } from 'node:path';
import { APP_ID, APP_NAME, WHATS_NEW } from '@shared/app-info';
import type { InvokeChannel, InvokeMap, SendMap } from '@shared/ipc';
import { findConflicts } from '@shared/shortcuts';
import { displayForPoint } from '@shared/geometry';
import { env } from './env';
import { initLogFile, logger } from './log';
import { SettingsService } from './settings';
import { CourseStore } from './courses/store';
import { createPlatform } from './platform';
import { HotkeyService } from './hotkeys';
import { UsageMeter } from './usage';
import { EngineHost } from './windows/engine';
import { HudWindow } from './windows/hud';
import { HubWindow } from './windows/hub';
import { registry } from './windows/registry';
import { AppTray, type TrayActions } from './tray';
import { AppMenus } from './app-menu';
import { createSession } from './session';

const log = logger('app');

if (env.userDataDir) app.setPath('userData', env.userDataDir);
app.setName(APP_NAME);
if (process.platform === 'linux') {
  // Transparent overlays need these on Linux (CI / development only).
  app.commandLine.appendSwitch('enable-transparent-visuals');
}
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (env.e2e) {
  // Tests feed a prerecorded "student" through a fake microphone and never show permission UI.
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  if (process.env.PAIRWISE_FAKE_MIC_WAV) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.PAIRWISE_FAKE_MIC_WAV);
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(main).catch((e) => {
    log.error('fatal startup error', e);
    dialog.showErrorBox(`${APP_NAME} failed to start`, String(e instanceof Error ? e.stack : e));
    app.quit();
  });
}

async function main(): Promise<void> {
  const dataDir = app.getPath('userData');
  initLogFile(join(dataDir, 'logs'));
  log.info(`${APP_NAME} ${app.getVersion()} starting (${process.platform}, electron ${process.versions.electron})${env.fakePlatform ? ' [fake platform]' : ''}`);
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  // A normal Dock app (round 2): the Dock icon opens the hub, its menu starts a session.

  const settings = new SettingsService(dataDir);
  const courses = new CourseStore(dataDir);
  const platform = createPlatform(() => settings.get().autoPauseMedia);
  const usage = new UsageMeter(dataDir, () => settings.get().budget);
  const engine = new EngineHost();
  const hub = new HubWindow();
  const hotkeys = new HotkeyService(settings.get().shortcuts, platform.hooks);
  // The session bar opens on the display the student is working on, where they last put it.
  const hud = new HudWindow(() => {
    const s = settings.get();
    const display = displayForPoint(platform.displays.list(), platform.displays.cursor()) ?? platform.displays.primary();
    const saved = s.hudPositions?.[display.id];
    const fits = saved && saved.x >= display.bounds.x - 40 && saved.y >= display.bounds.y - 10 && saved.x < display.bounds.x + display.bounds.width - 60 && saved.y < display.bounds.y + display.bounds.height - 30;
    return { display, saved: fits ? saved : undefined };
  });

  // Global hooks need Accessibility on macOS; start them as soon as it is granted.
  const tryStartHooks = () => {
    if (platform.hooks.running) return;
    const p = platform.permissions.status();
    if (p.accessibility === 'granted' && platform.hooks.start()) hotkeys.attachHooks();
  };
  tryStartHooks();
  hotkeys.apply();

  const session = createSession({ settings, courses, platform, engine, hud, hotkeys, usage, hub });

  // Menu-bar icon, Dock menu and app menu share the same actions.
  const actions: TrayActions = {
    startSession: (courseId, resume) => void session.start({ courseId, resume }).then((r) => !r.ok && r.error && hub.open('courses')),
    endSession: () => void session.end(),
    toggleMute: () => void session.command({ type: 'toggleMute' }),
    toggleVision: () => void session.command({ type: 'toggleVision' }),
    toggleWhiteboard: () => void session.command({ type: 'toggleWhiteboard' }),
    openHub: (tab) => hub.open(tab),
    quit: () => app.quit(),
  };
  const tray = new AppTray(
    actions,
    () => ({ courses: courses.list(), snapshot: session.snapshot, usage: usage.summary(), settings: settings.get() }),
  );
  tray.create();
  const menus = new AppMenus(
    actions,
    () => ({ courses: courses.list(), snapshot: session.snapshot, settings: settings.get() }),
  );
  menus.refresh();

  // Fan-out of state changes ------------------------------------------------------
  let trayKey = '';
  let lastStatus: string = 'idle';
  session.on('snapshot', (s) => {
    tray.tick();
    // Starting a session gets the hub out of the way: the tutor should see the student's work,
    // and the HUD + tray carry the controls from here (D-016).
    if (s.status !== lastStatus) {
      if ((lastStatus === 'idle' || lastStatus === 'error') && (s.status === 'starting' || s.status === 'connecting' || s.status === 'live')) hub.hide();
      lastStatus = s.status;
    }
    const key = `${s.status}|${s.muted}|${s.vision}|${s.whiteboard}|${s.courseId}`;
    if (key !== trayKey) {
      trayKey = key;
      tray.refresh();
      menus.refresh();
    }
  });
  session.on('needCourse', () => hub.open('courses'));
  session.on('notesWritten', (file: string | null, courseId: string) => {
    registry.send(['hub'], 'session:notesWritten', { courseId, file });
    if (file) notifyNotesSaved(file, courseId);
  });

  /**
   * "Notes saved" in Notification Center when a session's notes land (they're written a moment
   * after it ends) — unless the course page is already in front of the student. Click: open them.
   */
  function notifyNotesSaved(file: string, courseId: string): void {
    if (!settings.get().notes.notify || hub.window?.isFocused()) return;
    const course = courses.get(courseId);
    const title = basename(file).replace(/^\d{4}-\d{2}-\d{2} \d{2}\.\d{2} /, '').replace(/\.md$/, '');
    const checks = courses.getResume(courseId)?.checks;
    const body = [course?.code, title, checks?.total ? `✓ ${checks.right} of ${checks.total} quick checks` : ''].filter(Boolean).join(' · ');
    if (env.e2e) ((globalThis as Record<string, unknown>).__notifications as unknown[] | undefined)?.push({ title: 'Session notes saved', body, file });
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: 'Session notes saved', body, silent: true });
      n.on('click', () => void shell.openPath(file));
      n.show();
    } catch (e) {
      log.debug('notification failed', e);
    }
  }
  session.on('openWhiteboard', () => session.openWhiteboard());
  session.coursework.brain.on('progress', (courseId: string, status: IndexStatus) => registry.broadcast('courses:indexProgress', { courseId, status }));
  courses.on('changed', (list) => {
    registry.broadcast('courses:changed', list);
    tray.refresh();
    menus.refresh();
  });
  settings.on('changed', (s) => {
    registry.broadcast('settings:changed', s);
    hotkeys.setBindings(s.shortcuts);
    tray.refresh();
    menus.refresh();
  });
  usage.on('changed', (u) => {
    registry.send(['hub', 'hud'], 'usage:changed', u);
  });

  // IPC ----------------------------------------------------------------------------
  const handle = <K extends InvokeChannel>(channel: K, fn: (e: IpcMainInvokeEvent, ...args: Parameters<InvokeMap[K]>) => ReturnType<InvokeMap[K]> | Promise<ReturnType<InvokeMap[K]>>) => {
    ipcMain.handle(channel, (e, ...args) => fn(e, ...(args as Parameters<InvokeMap[K]>)));
  };

  handle('app:info', () => ({
    appName: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    demo: session.demoMode(),
    keyUnreadable: settings.keyUnreadable,
    fakePlatform: env.fakePlatform,
    tutorName: settings.get().tutorName,
  }));
  handle('settings:get', () => settings.get());
  handle('settings:update', (_e, patch) => settings.update(patch));
  handle('settings:resetShortcuts', () => settings.resetShortcuts());
  handle('secrets:status', () => settings.apiKeyStatus());
  handle('secrets:setApiKey', async (_e, key) => session.validateAndStoreKey(key));
  handle('secrets:clearApiKey', () => {
    settings.clearApiKey();
    return settings.apiKeyStatus();
  });
  handle('courses:list', () => courses.list());
  handle('courses:create', (_e, input) => {
    const c = courses.create(input);
    if (c.folder) void session.indexCourse(c.id);
    return c;
  });
  handle('courses:update', (_e, id, patch) => {
    const before = courses.get(id);
    const c = courses.update(id, patch);
    if (patch.folder && patch.folder !== before?.folder) void session.indexCourse(id);
    return c;
  });
  handle('courses:delete', (_e, id) => courses.delete(id));
  handle('courses:pickFolder', async (e) => {
    const win = registry.windows('hub').find((w) => w.webContents === e.sender);
    const r = await (win
      ? dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose the course folder' })
      : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Choose the course folder' }));
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('courses:index', (_e, id) => session.indexCourse(id));
  handle('courses:files', (_e, id) => session.courseFiles(id));
  handle('courses:toggleAssignment', (_e, id, file) => {
    const c = courses.get(id);
    if (!c) throw new Error('No such course');
    const has = c.assignments.includes(file);
    return courses.update(id, { assignments: has ? c.assignments.filter((f) => f !== file) : [...c.assignments, file] });
  });
  handle('courses:search', (_e, id, q) => session.searchCourse(id, q));
  handle('courses:resume', (_e, id) => courses.getResume(id));
  handle('courses:openFolder', (_e, id) => {
    const c = courses.get(id);
    if (c?.folder) void shell.openPath(c.folder);
  });
  handle('session:start', (_e, req) => session.start(req));
  handle('session:end', () => session.end());
  handle('session:snapshot', () => session.snapshot);
  handle('session:command', (_e, cmd) => session.command(cmd));
  handle('session:recentNotes', (_e, courseId) => session.recentNotes(courseId));
  handle('permissions:status', () => {
    tryStartHooks();
    return platform.permissions.status();
  });
  handle('permissions:request', async (_e, kind) => {
    const r = await platform.permissions.request(kind);
    tryStartHooks();
    return r;
  });
  handle('permissions:openSettings', (_e, kind) => platform.permissions.openSettings(kind));
  handle('usage:summary', () => usage.summary());
  handle('diagnostics:pointingTest', () => session.runPointingTest());
  handle('diagnostics:previewInk', () => session.previewInk());
  handle('notes:open', (_e, file) => void shell.openPath(file));
  handle('windows:open', (_e, target, tab) => {
    if (target === 'whiteboard') session.openWhiteboard();
    else hub.open(tab);
  });
  handle('windows:close', (e) => {
    for (const role of ['hub', 'whiteboard'] as const) for (const w of registry.windows(role)) if (w.webContents === e.sender) w.close();
  });
  handle('hud:moveBy', (_e, dx, dy) => {
    const p = hud.moveBy(dx, dy);
    const b = hud.bounds();
    if (!p || !b) return;
    // Remembered for the display the bar now sits on.
    const d = displayForPoint(platform.displays.list(), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
    if (d) settings.update({ hudPositions: { [d.id]: p } });
  });
  handle('hud:setSize', (_e, w, h) => hud.setSize(w, h));
  handle('veil:runningApps', () => platform.runningApps());
  handle('shortcuts:conflicts', (_e, map) => findConflicts(map));
  handle('whiteboard:snapshot', () => session.saveWhiteboardSnapshot());
  handle('whiteboard:state', () => session.whiteboard.state());
  // A new student has just seen everything in onboarding: no "What's new" card for them.
  handle('onboarding:complete', () => settings.update({ onboardingComplete: true, whatsNewSeen: WHATS_NEW.id }));

  ipcMain.on('overlay:ready', (_e, m: SendMap['overlay:ready']) => session.overlays.markReady(m.displayId));
  ipcMain.on('overlay:hover', (_e, m: SendMap['overlay:hover']) => session.overlays.setHoverInteractive(m.displayId, m.interactive));
  ipcMain.on('overlay:uiRects', (_e, m: SendMap['overlay:uiRects']) => session.overlays.setUiRects(m.displayId, m.rects));
  ipcMain.on('hub:log', (_e, m: SendMap['hub:log']) => logger('hub')[m.level](m.message));

  let wrappedUp = false;
  app.on('before-quit', (e) => {
    // Quitting mid-session ends it properly first (notes, resume state), and session notes
    // still being written get a few seconds to finish.
    if (!wrappedUp && (session.isActive || session.notesWriting)) {
      e.preventDefault();
      wrappedUp = true;
      void (async () => {
        if (session.isActive) await Promise.race([session.end({ reason: 'quit' }), new Promise((r) => setTimeout(r, 4000))]).catch(() => undefined);
        if (session.notesWriting) await Promise.race([session.notesWriting, new Promise((r) => setTimeout(r, 8000))]);
      })().finally(() => app.quit());
      return;
    }
    (globalThis as { __quitting?: boolean }).__quitting = true;
    settings.flush();
    usage.flush();
  });
  app.on('will-quit', () => {
    hotkeys.dispose();
    platform.hooks.stop();
  });
  app.on('window-all-closed', () => {
    /* keep running: the menu-bar icon, the Dock icon and the hotkeys stay available */
  });
  app.on('second-instance', () => hub.open());
  app.on('activate', () => hub.open());

  // First launch → onboarding; afterwards the course picker (or Settings → Gemini if the saved
  // key was written by another build and has to be pasted again).
  if (!env.e2e || process.env.PAIRWISE_OPEN_HUB === '1') hub.open(!settings.get().onboardingComplete ? 'onboarding' : settings.keyUnreadable ? 'settings' : 'courses');

  if (env.e2e) {
    (globalThis as Record<string, unknown>).__pairwise = { session, courses, settings, platform, hotkeys, usage, hub, hud, engine, registry };
  }
  log.info('ready');
}
