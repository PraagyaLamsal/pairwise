import { rectCenter, type DisplayInfo, type Rect } from '@shared/geometry';

/**
 * The on-device pointing-accuracy test. Labelled buttons are shown in a real (capturable) window
 * on every display — overlays are hidden from screen capture, so targets drawn there would be
 * invisible to the tutor — then each one is grounded on a fresh full-resolution capture exactly
 * the way the tutor's point_at is, and the error is measured against the button's true rect.
 */

export interface CalTarget {
  id: string;
  label: string;
  /** Global DIP rect of the button (measured from the window's DOM after layout). */
  rect: Rect;
  displayId: string;
  size: 's' | 'm' | 'l';
}

export interface CalResult {
  id: string;
  found: Rect | null;
  /** Distance from the true centre to the found centre (DIP), null when not found. */
  errorPx: number | null;
  /** The found centre is inside the true button. */
  hit: boolean;
}

export interface CalReport {
  ok: boolean;
  error?: string;
  backend?: string;
  targets: CalTarget[];
  results: CalResult[];
  found: number;
  hits: number;
  meanErrorPx: number | null;
  maxErrorPx: number | null;
  perDisplay: { displayId: string; label: string; scaleFactor: number; hits: number; total: number; meanErrorPx: number | null }[];
}

const WORDS = ['Maple', 'Harbor', 'Quartz', 'Lantern', 'Orbit', 'Pebble', 'Saffron', 'Tundra', 'Willow', 'Cobalt', 'Juniper', 'Meadow', 'Nimbus', 'Opal', 'Prism', 'Sierra', 'Thistle', 'Velvet', 'Zephyr', 'Ember'];

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Where the buttons go on one display: a jittered 3×3 grid, mixed sizes, unique labels. */
export function calibrationLayout(display: Pick<DisplayInfo, 'id' | 'workArea'>, seed: number, used = new Set<string>()): { label: string; size: 's' | 'm' | 'l'; x: number; y: number }[] {
  const rand = rng(seed);
  const wa = display.workArea;
  const out: { label: string; size: 's' | 'm' | 'l'; x: number; y: number }[] = [];
  const sizes: ('s' | 'm' | 'l')[] = ['s', 'm', 'l'];
  const marginX = Math.min(140, wa.width * 0.1);
  const marginY = Math.min(130, wa.height * 0.14);
  const cellW = (wa.width - 2 * marginX) / 3;
  const cellH = (wa.height - 2 * marginY) / 3;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let label = WORDS[Math.floor(rand() * WORDS.length)];
      for (let k = 0; used.has(label) && k < WORDS.length; k++) label = WORDS[(WORDS.indexOf(label) + 1) % WORDS.length];
      used.add(label);
      out.push({
        label,
        size: sizes[(row + col + Math.floor(rand() * 3)) % 3],
        // Local to the window (which covers the work area); centre of the button.
        x: Math.round(marginX + cellW * (col + 0.2 + rand() * 0.6)),
        y: Math.round(marginY + cellH * (row + 0.25 + rand() * 0.5)),
      });
    }
  }
  return out;
}

/** The page shown in each calibration window. */
export function calibrationPage(items: { label: string; size: 's' | 'm' | 'l'; x: number; y: number }[], title: string): string {
  const font = { s: 13, m: 16, l: 22 };
  const pad = { s: '5px 10px', m: '7px 14px', l: '10px 20px' };
  const buttons = items
    .map((it, i) => `<button data-i="${i}" style="left:${it.x}px;top:${it.y}px;font-size:${font[it.size]}px;padding:${pad[it.size]}">${it.label}</button>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;cursor:default;user-select:none}
body{background:radial-gradient(1200px 700px at 50% 40%,#f6f8fc,#e9edf5);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Inter",Arial,sans-serif}
.title{position:absolute;left:50%;top:22px;transform:translateX(-50%);padding:8px 16px;border-radius:999px;background:#1d2230;color:#e8ecf5;font-size:13px;letter-spacing:.01em;box-shadow:0 6px 18px rgba(0,0,0,.18)}
button{position:absolute;transform:translate(-50%,-50%);border:1px solid #9aa3b5;border-radius:8px;background:#fff;color:#111;font-family:inherit;box-shadow:0 1px 2px rgba(0,0,0,.06)}
</style></head><body><div class="title">${title}</div>${buttons}</body></html>`;
}

/** Score grounded boxes against the true rects. */
export function scoreCalibration(targets: CalTarget[], found: Map<string, Rect | null>, displays: Pick<DisplayInfo, 'id' | 'label' | 'scaleFactor'>[]): Omit<CalReport, 'ok' | 'backend'> {
  const results: CalResult[] = targets.map((t) => {
    const f = found.get(t.id) ?? null;
    if (!f) return { id: t.id, found: null, errorPx: null, hit: false };
    const a = rectCenter(t.rect);
    const b = rectCenter(f);
    const hit = b.x >= t.rect.x && b.x <= t.rect.x + t.rect.width && b.y >= t.rect.y && b.y <= t.rect.y + t.rect.height;
    return { id: t.id, found: f, errorPx: Math.hypot(a.x - b.x, a.y - b.y), hit };
  });
  const errs = (rs: CalResult[]) => rs.map((r) => r.errorPx).filter((e): e is number => e !== null);
  const mean = (v: number[]) => (v.length ? v.reduce((a, c) => a + c, 0) / v.length : null);
  const all = errs(results);
  return {
    targets,
    results,
    found: all.length,
    hits: results.filter((r) => r.hit).length,
    meanErrorPx: mean(all),
    maxErrorPx: all.length ? Math.max(...all) : null,
    perDisplay: displays.map((d) => {
      const rs = results.filter((r) => targets.find((t) => t.id === r.id)?.displayId === d.id);
      return { displayId: d.id, label: d.label, scaleFactor: d.scaleFactor, hits: rs.filter((r) => r.hit).length, total: rs.length, meanErrorPx: mean(errs(rs)) };
    }),
  };
}
