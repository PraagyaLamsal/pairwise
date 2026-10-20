import { BrowserWindow } from 'electron';
import type { DisplayInfo, Rect } from '@shared/geometry';
import type { CalibrationState } from '@shared/ipc';
import type { TutorSession } from '../tutor';
import { calibrationLayout, calibrationPage, scoreCalibration, type CalReport, type CalTarget } from '../../vision/calibration';
import { logger } from '../../log';

const log = logger('calibrate');

const COLORS = ['#3380FF', '#7C5CFF', '#14B8A6', '#F59E0B', '#EF4444', '#22C55E', '#EC4899', '#0EA5E9', '#A855F7'];

/**
 * Settings → Setup & checks → Pointing accuracy. Shows labelled buttons on every display, grounds
 * each one exactly like point_at does, and draws the verdict (found box, centre, error in px).
 */
export async function runCalibration(s: TutorSession, opts: { seed?: number; holdResultsMs?: number } = {}): Promise<CalReport> {
  const empty = (error: string): CalReport => ({ ok: false, error, targets: [], results: [], found: 0, hits: 0, meanErrorPx: null, maxErrorPx: null, perDisplay: [] });
  if (!s.isActive) return empty('Start a session first — the test uses the same screen capture as the tutor.');
  if (!s.visual.grounder.canSee) return empty('The pointing test needs a Gemini API key (Settings → Gemini).');
  const displays = s.deps.platform.displays.list();
  const seed = opts.seed ?? Date.now() % 100_000;
  const used = new Set<string>();
  const windows: BrowserWindow[] = [];
  const targets: CalTarget[] = [];
  const send = (state: CalibrationState | null) => s.overlays.send('overlay:calibration', state);
  try {
    for (const d of displays) {
      const items = calibrationLayout(d, seed + d.index * 7919, used);
      const { win, rects } = await openWindow(d, calibrationPage(items, `${s.settings.tutorName} pointing test · display ${d.index} — hold still`));
      windows.push(win);
      rects.forEach((rect, i) => targets.push({ id: `${d.id}#${i}`, label: items[i].label, rect, displayId: d.id, size: items[i].size }));
    }
    send({ targets: [], results: [], phase: 'showing' });
    await new Promise((r) => setTimeout(r, 700)); // let the capture stream catch up with the new windows
    send({ targets: [], results: [], phase: 'measuring' });
    const found = new Map<string, Rect | null>();
    await Promise.all(
      displays.map(async (d) => {
        const mine = targets.filter((t) => t.displayId === d.id);
        const res = await s.visual.grounder.locate(
          d.id,
          mine.map((t) => ({ id: t.id, description: `the button labelled "${t.label}"`, control: true })),
          null,
        );
        for (const r of res) found.set(r.id, r.found && r.rect && r.via !== 'approx' ? r.rect : null);
      }),
    );
    const score = scoreCalibration(targets, found, displays);
    const report: CalReport = { ok: true, backend: process.env.PAIRWISE_GROUNDER === 'ocr' ? 'ocr' : 'gemini', ...score };
    send({
      targets: targets.map((t, i) => ({ id: t.id, label: t.label, rect: t.rect, color: COLORS[i % COLORS.length] })),
      results: score.results.map((r) => ({ id: r.id, found: r.found, errorPx: r.errorPx })),
      phase: 'done',
    });
    log.info(`pointing test: ${score.hits}/${targets.length} hits, mean error ${score.meanErrorPx?.toFixed(1) ?? 'n/a'} px`);
    const hold = opts.holdResultsMs ?? 9000;
    setTimeout(() => {
      send(null);
      for (const w of windows) if (!w.isDestroyed()) w.destroy();
    }, hold);
    return report;
  } catch (e) {
    log.warn('pointing test failed', e);
    send(null);
    for (const w of windows) if (!w.isDestroyed()) w.destroy();
    return empty(`The test failed: ${(e as Error).message}`);
  }
}

/** A plain, capturable, click-through window over a display's work area with the targets. */
async function openWindow(d: DisplayInfo, html: string): Promise<{ win: BrowserWindow; rects: Rect[] }> {
  const wa = d.workArea;
  const win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    backgroundColor: '#eef1f6',
    enableLargerThanScreen: true,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  // Above the student's apps, below Pairwise's overlays (which sit at screen-saver level).
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  win.showInactive();
  await new Promise((r) => setTimeout(r, 250));
  const cb = win.getContentBounds();
  const local = JSON.parse(
    await win.webContents.executeJavaScript('JSON.stringify([...document.querySelectorAll("button")].map((b) => { const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }))'),
  ) as Rect[];
  return { win, rects: local.map((r) => ({ x: cb.x + r.x, y: cb.y + r.y, width: r.width, height: r.height })) };
}
