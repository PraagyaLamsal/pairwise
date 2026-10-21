// Shared helpers for the Electron e2e tests (Playwright `_electron`, no browser download needed).
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const artifacts = join(root, 'test', 'artifacts');
mkdirSync(artifacts, { recursive: true });

/**
 * PAIRWISE_E2E_SCALE=2 runs the app with Chromium forced to 2× (real HiDPI: the 2560×1440 Xvfb
 * screen becomes 1280×720 DIP, every capture has 2 physical pixels per DIP).
 */
export const SCALE = Number(process.env.PAIRWISE_E2E_SCALE || 1);

/** Two virtual displays inside the Xvfb screen: a laptop panel and a smaller external. */
export const FAKE_DISPLAYS =
  SCALE === 2
    ? [
        { bounds: { x: 0, y: 0, width: 820, height: 560 }, scaleFactor: 2, label: 'Built-in Retina Display' },
        { bounds: { x: 820, y: 0, width: 460, height: 400 }, scaleFactor: 2, label: 'Studio Display' },
      ]
    : [
        { bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 1, label: 'Built-in Display' },
        { bounds: { x: 1440, y: 0, width: 1120, height: 700 }, scaleFactor: 2, label: 'Studio Display' },
      ];

export async function launch(extraEnv = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'pairwise-e2e-'));
  const app = await electron.launch({
    executablePath: join(root, 'node_modules', '.bin', 'electron'),
    args: ['--no-sandbox', ...(SCALE !== 1 ? [`--force-device-scale-factor=${SCALE}`] : []), join(root, 'out', 'main', 'index.js')],
    cwd: root,
    env: {
      ...process.env,
      PAIRWISE_E2E: '1',
      PAIRWISE_FAKE_PLATFORM: '1',
      PAIRWISE_USER_DATA: userData,
      PAIRWISE_OPEN_HUB: '1',
      PAIRWISE_CAPTURE_OVERLAYS: '1',
      PAIRWISE_QUIET: process.env.E2E_VERBOSE === '1' ? '0' : '1',
      // E2E_REAL_DISPLAYS=1 (on-device evals): use the machine's real screens.
      ...(process.env.E2E_REAL_DISPLAYS === '1' ? {} : { PAIRWISE_FAKE_DISPLAYS: JSON.stringify(FAKE_DISPLAYS) }),
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      ...extraEnv,
    },
    timeout: 60_000,
  });
  const verbose = process.env.E2E_VERBOSE === '1';
  app.process().stderr?.on('data', (d) => {
    const s = String(d);
    if (verbose || (/error|warn/i.test(s) && !/dbus|Fontconfig|GPU|gles|viz|ozone|libva|vaapi|Gtk:/i.test(s))) process.stderr.write(`[app] ${s}`);
  });
  if (verbose) app.process().stdout?.on('data', (d) => process.stdout.write(`[app] ${d}`));
  app.on('close', () => verbose && console.log('[app] closed'));
  return { app, userData };
}

/** Evaluate in the main process with access to the e2e hooks (`globalThis.__pairwise`). */
export function main(app, fn, arg) {
  return app.evaluate(fn, arg);
}

export async function windowByRole(app, role, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        const r = await w.evaluate(() => window.pw?.role);
        if (r === role) return w;
      } catch {
        /* window still loading */
      }
    }
    await sleep(150);
  }
  throw new Error(`no ${role} window after ${timeout} ms`);
}

export async function waitFor(fn, { timeout = 15_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The real X pointer (XTest via robotjs in the test process). xdotool's mousemove is unreliable
 * under Xvfb here, robotjs is not.
 */
let robot = null;
export const pointer = {
  move(x, y) {
    if (!robot) robot = createRequire(import.meta.url)('@jitsi/robotjs');
    robot.moveMouse(Math.round(x), Math.round(y));
  },
  pos() {
    if (!robot) robot = createRequire(import.meta.url)('@jitsi/robotjs');
    return robot.getMousePos();
  },
  click(button = 'left') {
    if (!robot) robot = createRequire(import.meta.url)('@jitsi/robotjs');
    robot.mouseClick(button);
  },
};

/** Capture an overlay window (transparent PNG) through the main process. */
export async function captureOverlay(app, displayId, file) {
  const b64 = await app.evaluate(async (_e, id) => {
    const buf = await globalThis.__pairwise.session.overlays.capture(id);
    return buf ? buf.toString('base64') : null;
  }, displayId);
  if (b64 && file) writeFileSync(file, Buffer.from(b64, 'base64'));
  return b64;
}

/**
 * A frameless "app" window with known UI at a known global position (the ground truth for the
 * pointing-accuracy tests). Elements carry data-t="name"; returns their global DIP rects.
 */
export async function openTargetWindow(app, { x, y, width, height, html }) {
  return app.evaluate(async ({ BrowserWindow }, o) => {
    const w = new BrowserWindow({ x: o.x, y: o.y, width: o.width, height: o.height, frame: false, show: true, resizable: false, backgroundColor: '#ffffff', webPreferences: { sandbox: true } });
    globalThis.__targets = [...(globalThis.__targets ?? []), w];
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(o.html)}`);
    w.setBounds({ x: o.x, y: o.y, width: o.width, height: o.height });
    await new Promise((r) => setTimeout(r, 400));
    const cb = w.getContentBounds();
    const els = JSON.parse(await w.webContents.executeJavaScript('JSON.stringify([...document.querySelectorAll("[data-t]")].map((e) => { const r = e.getBoundingClientRect(); return { t: e.dataset.t, x: r.x, y: r.y, width: r.width, height: r.height }; }))'));
    return { id: w.id, bounds: cb, els: Object.fromEntries(els.map((e) => [e.t, { x: cb.x + e.x, y: cb.y + e.y, width: e.width, height: e.height }])) };
  }, { x, y, width, height, html });
}

export async function closeTargetWindows(app) {
  await app.evaluate(() => {
    for (const w of globalThis.__targets ?? []) if (!w.isDestroyed()) w.destroy();
    globalThis.__targets = [];
  });
}

/**
 * Bounding box (global DIP) of the tutor's ink on an overlay, from its rendered pixels:
 * pixels close to `color` inside `region`, ignoring a box around the cursor.
 */
export async function inkPixelsBBox(app, displayId, color, region, ignore = null) {
  return app.evaluate(async ({ nativeImage }, o) => {
    const s = globalThis.__pairwise.session;
    const d = globalThis.__pairwise.platform.displays.byId(o.displayId);
    const png = await s.overlays.capture(o.displayId);
    if (!png) return null;
    const img = nativeImage.createFromBuffer(png);
    const size = img.getSize();
    const bmp = img.toBitmap(); // BGRA
    const sx = size.width / d.bounds.width;
    const sy = size.height / d.bounds.height;
    const hex = o.color.replace('#', '');
    const cr = parseInt(hex.slice(0, 2), 16), cg = parseInt(hex.slice(2, 4), 16), cb = parseInt(hex.slice(4, 6), 16);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0;
    const r = o.region;
    const px0 = Math.max(0, Math.floor((r.x - d.bounds.x) * sx)), px1 = Math.min(size.width, Math.ceil((r.x + r.width - d.bounds.x) * sx));
    const py0 = Math.max(0, Math.floor((r.y - d.bounds.y) * sy)), py1 = Math.min(size.height, Math.ceil((r.y + r.height - d.bounds.y) * sy));
    for (let py = py0; py < py1; py++) {
      for (let px = px0; px < px1; px++) {
        const i = (py * size.width + px) * 4;
        const a = bmp[i + 3];
        if (a < 150) continue;
        // un-premultiply
        const b = (bmp[i] * 255) / a, g = (bmp[i + 1] * 255) / a, rr = (bmp[i + 2] * 255) / a;
        if (Math.abs(rr - cr) > 60 || Math.abs(g - cg) > 60 || Math.abs(b - cb) > 60) continue;
        const gx = d.bounds.x + px / sx;
        const gy = d.bounds.y + py / sy;
        if (o.ignore && gx >= o.ignore.x && gy >= o.ignore.y && gx <= o.ignore.x + o.ignore.width && gy <= o.ignore.y + o.ignore.height) continue;
        n++;
        if (gx < x1) x1 = gx;
        if (gy < y1) y1 = gy;
        if (gx > x2) x2 = gx;
        if (gy > y2) y2 = gy;
      }
    }
    return n ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1, pixels: n, scale: sx } : { pixels: 0 };
  }, { displayId, color, region, ignore });
}

/** Call a tool exactly as if the Live model had (same dispatcher, same handlers). */
export async function callTool(app, name, args) {
  return app.evaluate(async (_e, o) => {
    const s = globalThis.__pairwise.session;
    const r = await s.tools.dispatch({ id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: o.name, args: o.args });
    return r;
  }, { name, args });
}

export { assert };

/**
 * What the student sees: the X screen cropped to a display with that display's overlay
 * composited on top (X11 root captures don't reliably include the transparent overlays).
 * For visual review of ink against real UI.
 */
export async function screenShot(app, displayId, file) {
  const b64 = await app.evaluate(async ({ desktopCapturer, screen, BrowserWindow }, id) => {
    const s = globalThis.__pairwise.session;
    const d = globalThis.__pairwise.platform.displays.byId(id);
    const sf = screen.getPrimaryDisplay().scaleFactor;
    const all = screen.getAllDisplays();
    const W = Math.max(...all.map((x) => x.bounds.x + x.bounds.width));
    const H = Math.max(...all.map((x) => x.bounds.y + x.bounds.height));
    // The X root capture sometimes already holds a stale copy of the overlays (compositor): hide
    // their content while grabbing the screen underneath, then lay the live overlay on top.
    const overlays = s.overlays.displayIds().map((oid) => s.overlays.windowFor(oid)).filter((w) => w && !w.isDestroyed());
    const vis = (v) => Promise.all(overlays.map((w) => w.webContents.executeJavaScript(`document.documentElement.style.visibility = '${v}'; new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`).catch(() => undefined)));
    await vis('hidden');
    await new Promise((r) => setTimeout(r, 120));
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(W * sf), height: Math.round(H * sf) } });
    await vis('visible');
    if (!src) return null;
    const k = src.thumbnail.getSize().width / W;
    const base = src.thumbnail.crop({ x: Math.round(d.bounds.x * k), y: Math.round(d.bounds.y * k), width: Math.round(d.bounds.width * k), height: Math.round(d.bounds.height * k) });
    const over = await s.overlays.capture(id);
    if (!over) return base.toPNG().toString('base64');
    const w = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } });
    await w.loadURL('about:blank');
    const out = await w.webContents.executeJavaScript(`(async () => {
      const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
      const a = await load('data:image/png;base64,${base.toPNG().toString('base64')}');
      const b = await load('data:image/png;base64,${over.toString('base64')}');
      const c = document.createElement('canvas'); c.width = a.width; c.height = a.height;
      const g = c.getContext('2d'); g.drawImage(a, 0, 0); g.drawImage(b, 0, 0, a.width, a.height);
      return c.toDataURL('image/png').split(',')[1];
    })()`);
    w.destroy();
    return out;
  }, displayId);
  if (b64 && file) writeFileSync(file, Buffer.from(b64, 'base64'));
  return b64;
}
