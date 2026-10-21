import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GONE_AFTER, InkTracker, judge, maskOf, movingAreas, type Gray, type PxBox } from '../../src/renderer/engine/ink-track';

type Glyph = [number, number, number, number];

/** Glyph runs from `x` to about `end` on the line at `y` (content coordinates, px). */
function glyphRun(rnd: () => number, y: number, x: number, end: number): Glyph[] {
  const out: Glyph[] = [];
  while (x < end) {
    const gw = 2 + Math.floor(rnd() * 3);
    const gh = 4 + Math.floor(rnd() * 4);
    out.push([x, y + (7 - gh), gw, gh]);
    x += gw + 1 + Math.floor(rnd() * 3) + (rnd() < 0.15 ? 5 : 0);
  }
  return out;
}

/** A seeded "screen of code": lines of glyph runs, rendered with sub-pixel vertical offsets. */
function codeScreen(seed: number, offset = 0, w = 360, h = 240, lineH = 12): Gray {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Glyph boxes in "content" coordinates (before scrolling), in px.
  const glyphs: Glyph[] = [];
  for (let line = 0; line < 60; line++) {
    const x = 8 + Math.floor(rnd() * 4) * 8;
    glyphs.push(...glyphRun(rnd, 6 + line * lineH, x, 60 + rnd() * 260));
  }
  return render(glyphs, offset, w, h);
}

/** Dark glyphs on a light page, scrolled by `offset` px (partly covered rows are blended). */
function render(glyphs: Glyph[], offset: number, w: number, h: number): Gray {
  const data = new Float32Array(w * h).fill(250);
  for (const [gx, gy, gw, gh] of glyphs) {
    const y1 = gy + offset;
    const y2 = y1 + gh;
    for (let py = Math.max(0, Math.floor(y1)); py < Math.min(h, Math.ceil(y2)); py++) {
      const cover = Math.min(py + 1, y2) - Math.max(py, y1);
      if (cover <= 0) continue;
      for (let px = gx; px < Math.min(w, gx + gw); px++) data[py * w + px] -= 220 * cover;
    }
  }
  return { width: w, height: h, data: Uint8Array.from(data, (v) => Math.max(0, Math.min(255, Math.round(v)))) };
}

/** Anchors: a few lines of the code (as a trace would mark), in px. */
const lines = (ys: number[], x = 6, w = 200): PxBox[] => ys.map((y) => ({ x, y: y - 2, w, h: 12 }));
const none = (img: Gray) => maskOf(img.width, img.height, []);

describe('sticky ink: following what the marks point at', () => {
  const ref = codeScreen(7);
  const anchors = lines([42, 54, 66, 78]);

  it('the same screen is steady', () => {
    expect(judge(ref, none(ref), codeScreen(7), none(ref), anchors).state).toBe('steady');
  });

  it('finds a scroll, up or down, whole or fractional pixels', () => {
    for (const d of [24, -36, 7, 6.25, 6.5, -10.25, 12.5, 90]) {
      const v = judge(ref, none(ref), codeScreen(7, d), none(ref), anchors);
      expect(v.state, `scrolled ${d}`).toBe('moved');
      // Half a pixel at half a pixel per DIP: within a DIP of the real scroll.
      expect(Math.abs(v.dy - d), `scrolled ${d} → ${v.dy}`).toBeLessThanOrEqual(0.5);
      expect(v.dx, `scrolled ${d}: nothing sideways`).toBe(0);
    }
  });

  it('a sub-pixel scroll is still there, or moved by at most half a pixel (never changed)', () => {
    for (const d of [0.25, 0.5, -0.5]) {
      const v = judge(ref, none(ref), codeScreen(7, d), none(ref), anchors);
      expect(['steady', 'moved'], `scrolled ${d}`).toContain(v.state);
      expect(Math.abs(v.dy - (v.state === 'moved' ? d : 0)), `scrolled ${d} → ${v.dy}`).toBeLessThanOrEqual(0.5);
    }
  });

  it('lines that scroll out of view under a header are lost; the rest still moves', () => {
    // A static header over the top of the pane, in both images.
    const header = (img: Gray) => {
      for (let y = 0; y < 40; y++) img.data.fill(200, y * img.width, (y + 1) * img.width);
      return img;
    };
    const a = header(codeScreen(7));
    const b = header(codeScreen(7, -24));
    // The first line (just under the header) goes under it; the other three come along.
    const v = judge(a, none(a), b, none(b), lines([42, 66, 78, 90]));
    expect(v.state).toBe('moved');
    expect(Math.abs(v.dy + 24)).toBeLessThanOrEqual(0.5);
    expect(v.lost).toEqual([0]);
  });

  it('a line half under the header comes back into view with the rest (not lost)', () => {
    const header = (img: Gray) => {
      for (let y = 0; y < 40; y++) img.data.fill(200, y * img.width, (y + 1) * img.width);
      return img;
    };
    // Scrolled so the first line is half under the header…
    const a = header(codeScreen(7, -8));
    // …then back down by 20: all of it shows again.
    const b = header(codeScreen(7, 12));
    const v = judge(a, none(a), b, none(b), lines([34, 46, 58, 70]));
    expect(v.state).toBe('moved');
    expect(Math.abs(v.dy - 20)).toBeLessThanOrEqual(0.5);
    expect(v.lost).toEqual([]);
  });

  it('follows a scroll back even when most of the group sits half under the header', () => {
    // (A long line half under a static header, a short one in view; scrolled back down 37.5 px.)
    const header = (img: Gray) => {
      for (let y = 0; y < 40; y++) img.data.fill(200, y * img.width, (y + 1) * img.width);
      return img;
    };
    const a = header(codeScreen(7, -60));
    const b = header(codeScreen(7, -22.5));
    const boxes = [{ x: 6, y: 34, w: 300, h: 12 }, { x: 6, y: 66, w: 80, h: 12 }];
    const v = judge(a, none(a), b, none(b), boxes);
    expect(v.state).toBe('moved');
    expect(Math.abs(v.dy - 37.5)).toBeLessThanOrEqual(0.5);
    expect(v.lost).toEqual([]);
  });

  it("a short line isn't taken for a longer one that starts the same way", () => {
    // `return a`, and five lines on `return n * factorial(n - 1)`: the box of the first covers
    // just its text, which is how the second begins. Scrolled up 17.5 px (half a pixel), which
    // puts the other marked line half under a static header.
    let s = 11;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const glyphs: Glyph[] = [];
    let short: Glyph[] = [];
    for (let line = 0; line < 30; line++) {
      const y = 6 + line * 12;
      if (line === 6) glyphs.push(...(short = glyphRun(rnd, y, 8, 60)));
      else if (line === 11) {
        const twin = short.map(([x, gy, gw, gh]): Glyph => [x, gy + 60, gw, gh]);
        glyphs.push(...twin, ...glyphRun(rnd, y, Math.max(...twin.map((g) => g[0] + g[2])) + 6, 300));
      } else glyphs.push(...glyphRun(rnd, y, 8 + Math.floor(rnd() * 4) * 8, 120 + rnd() * 180));
    }
    const header = (img: Gray) => {
      for (let y = 0; y < 40; y++) img.data.fill(200, y * img.width, (y + 1) * img.width);
      return img;
    };
    const a = header(render(glyphs, 0, 360, 240));
    const b = header(render(glyphs, -17.5, 360, 240));
    const end = Math.max(...short.map((g) => g[0] + g[2]));
    const boxes = [{ x: 6, y: 52, w: 300, h: 12 }, { x: 6, y: 76, w: end - 4, h: 12 }];
    const v = judge(a, none(a), b, none(b), boxes);
    expect(v.state).toBe('moved');
    expect(Math.abs(v.dy + 17.5), `moved ${v.dy}`).toBeLessThanOrEqual(0.5);
  });

  it('another screen altogether is changed', () => {
    const v = judge(ref, none(ref), codeScreen(99), none(ref), anchors);
    expect(v.state).toBe('changed');
  });

  it('a tooltip over one of the lines leaves the marks alone', () => {
    const cur = codeScreen(7);
    // A dark box over the second line (and a bit around it).
    for (let y = 48; y < 64; y++) for (let x = 20; x < 150; x++) cur.data[y * cur.width + x] = 40;
    expect(['steady', 'unsure']).toContain(judge(ref, none(ref), cur, none(cur), anchors).state);
  });

  it("the student's pointer over a line is masked out", () => {
    const cur = codeScreen(7);
    const pointer = { x: 60, y: 50, w: 12, h: 16 };
    for (let y = pointer.y; y < pointer.y + pointer.h; y++) for (let x = pointer.x; x < pointer.x + pointer.w - (y - pointer.y) / 2; x++) cur.data[y * cur.width + x] = 0;
    const one = judge(ref, none(ref), cur, none(cur), lines([54]));
    expect(one.state).not.toBe('steady'); // unmasked, the pointer counts as a change…
    expect(judge(ref, none(ref), cur, maskOf(cur.width, cur.height, [pointer]), lines([54])).state).toBe('steady'); // …masked, it doesn't
  });

  it('marks drawn into the capture are skipped (where the overlays are captured)', () => {
    // Linux captures include the ink: a chip drawn at the end of a line, at the same screen spot
    // in both images, while the code under it scrolled by 12 px.
    const chip = { x: 150, y: 52, w: 40, h: 12 };
    const paint = (img: Gray) => {
      for (let y = chip.y; y < chip.y + chip.h; y++) for (let x = chip.x; x < chip.x + chip.w; x++) img.data[y * img.width + x] = 90;
      return img;
    };
    const a = paint(codeScreen(7));
    const b = paint(codeScreen(7, 12));
    const m = maskOf(a.width, a.height, [{ x: chip.x - 2, y: chip.y - 2, w: chip.w + 4, h: chip.h + 4 }]);
    const v = judge(a, m, b, m, lines([42, 54, 66], 6, 190));
    expect(v.state).toBe('moved');
    expect(Math.abs(v.dy - 12)).toBeLessThanOrEqual(0.26);
  });

  it('a note on empty space is steady until something appears under it', () => {
    const blank = { width: 200, height: 120, data: new Uint8Array(200 * 120).fill(250) };
    const box = [{ x: 40, y: 40, w: 80, h: 20 }];
    expect(judge(blank, none(blank), { ...blank, data: blank.data.slice() }, none(blank), box).state).toBe('steady');
    expect(judge(blank, none(blank), codeScreen(3, 0, 200, 120), none(blank), box).state).toBe('changed');
  });

  it('a group is only cleared once it has stayed changed for a moment', () => {
    const t = new InkTracker();
    const m = none(ref);
    expect(t.step('g', ref, m, anchors).state).toBe('steady'); // remembers it
    // Scrolled by 24: moved, and the anchors move with it.
    const scrolled = codeScreen(7, 24);
    const r1 = t.step('g', scrolled, m, anchors);
    expect(r1.state).toBe('moved');
    const moved = anchors.map((b) => ({ ...b, y: b.y + r1.dy }));
    expect(t.step('g', codeScreen(7, 24), m, moved).state).toBe('steady');
    // Then another app comes to the front.
    const other = codeScreen(42);
    const states = Array.from({ length: GONE_AFTER }, () => t.step('g', other, m, moved).state);
    expect(states.slice(0, -1).every((s) => s === 'unsure')).toBe(true);
    expect(states[states.length - 1]).toBe('gone');
  });

  it('a partial change that holds still becomes the new normal (it can never add up to "gone")', () => {
    const t = new InkTracker();
    const m = none(ref);
    t.step('g', ref, m, anchors);
    // A tooltip comes up over two of the four lines and stays.
    const tip = (img: Gray) => {
      for (let y = 46; y < 70; y++) for (let x = 20; x < 210; x++) img.data[y * img.width + x] = 60;
      return img;
    };
    const states = Array.from({ length: 4 }, () => t.step('g', tip(codeScreen(7)), m, anchors).state);
    expect(states[0]).toBe('unsure');
    expect(states[states.length - 1]).toBe('steady');
    // Then the rest of the screen goes too: that's still noticed, and clears.
    const later = Array.from({ length: GONE_AFTER }, () => t.step('g', codeScreen(42), m, anchors).state);
    expect(later[later.length - 1]).toBe('gone');
  });

  it('an unchanged screen repeats the last verdict (and a change that stays still clears)', () => {
    const t = new InkTracker();
    const m = none(ref);
    expect(t.again('g').state).toBe('unsure'); // never seen
    t.step('g', ref, m, anchors);
    expect(t.again('g').state).toBe('steady');
    // Another app came up and then nothing moved: no new frames, but it still clears in time.
    expect(t.step('g', codeScreen(42), m, anchors).state).toBe('unsure');
    const rest = Array.from({ length: GONE_AFTER - 1 }, () => t.again('g').state);
    expect(rest).toEqual([...Array(GONE_AFTER - 2).fill('unsure'), 'gone']);
  });
});

describe('sticky ink: a scroll seen in steps', () => {
  it('keeps the marks on their lines through a scroll down and back, sampled mid-way', () => {
    const header = (img: Gray) => {
      for (let y = 0; y < 20; y++) img.data.fill(236, y * img.width, (y + 1) * img.width);
      return img;
    };
    const t = new InkTracker();
    const m = none(codeScreen(7));
    let boxes: PxBox[] = lines([90, 114], 6, 160);
    let marks = 0;
    const ease = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => {
      const k = (i + 1) / n;
      return a + (b - a) * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
    });
    const scrolls = [0, 0, ...ease(0, 60, 4), 60, 60, 60, ...ease(60, 22.5, 3), 22.5, 22.5, 22.5];
    for (const sc of scrolls) {
      const r = t.step('g', header(codeScreen(7, -sc)), m, boxes);
      if (r.state === 'moved') {
        marks += r.dy;
        boxes = boxes.map((b) => ({ ...b, y: b.y + r.dy }));
      }
      expect(r.state, `at ${sc}`).not.toBe('gone');
    }
    expect(Math.abs(marks + 22.5), `marks at ${marks}`).toBeLessThanOrEqual(1.5);
  });
});

describe('sticky ink: marks whose line scrolls out of view', () => {
  const header = (img: Gray) => {
    for (let y = 0; y < 40; y++) img.data.fill(200, y * img.width, (y + 1) * img.width);
    return img;
  };

  it('are parked, and come back when the group brings their line into view again', () => {
    const t = new InkTracker();
    const m = none(codeScreen(7));
    const all = lines([42, 90, 114]);
    t.step('g', header(codeScreen(7)), m, all, ['A', 'B', 'C']);
    // Scrolled up 24: A's line goes under the header.
    const r1 = t.step('g', header(codeScreen(7, -24)), m, all, ['A', 'B', 'C']);
    expect(r1.state).toBe('moved');
    expect(r1.lost).toEqual([0]);
    // (Main moves everything and parks A.)
    const moved = all.map((b) => ({ ...b, y: b.y + r1.dy }));
    const parked = [{ id: 'A', box: moved[0] }];
    const r2 = t.step('g', header(codeScreen(7, -24)), m, moved.slice(1), ['B', 'C'], parked);
    expect(r2.back).toBeUndefined(); // still under the header
    // Scrolled back down: A's line is in view again, where the group's move puts it.
    const r3 = t.step('g', header(codeScreen(7)), m, moved.slice(1), ['B', 'C'], parked);
    expect(r3.state).toBe('moved');
    expect(r3.back).toEqual(['A']);
  });

  it("are let go when there's nothing to recognise their line by", () => {
    const t = new InkTracker();
    const m = none(codeScreen(7));
    t.step('g', codeScreen(7), m, lines([42]), ['B']);
    const r = t.step('g', codeScreen(7), m, lines([42]), ['B'], [{ id: 'X', box: lines([90])[0] }]);
    expect(r.forget).toEqual(['X']);
  });
});

describe('sticky ink: a group whose content goes away', () => {
  it('is recognised when it comes back, where it was or scrolled', () => {
    const t = new InkTracker();
    const m = none(codeScreen(7));
    const boxes = lines([42, 66, 90]);
    t.step('g', codeScreen(7), m, boxes);
    // Another app: gone after a moment…
    const other = codeScreen(42);
    const gone = Array.from({ length: GONE_AFTER }, () => t.step('g', other, m, boxes, [], [], false).state);
    expect(gone[gone.length - 1]).toBe('gone');
    // …and while it stays away, nothing comes back.
    expect(t.step('g', other, m, boxes, [], [], true).state).toBe('unsure');
    expect(t.again('g').state).toBe('unsure');
    // Back, but scrolled by 30 px meanwhile: found, with how far it moved.
    const r = t.step('g', codeScreen(7, 30), m, boxes, [], [], true);
    expect(r.state).toBe('back');
    expect(Math.abs(r.dy - 30)).toBeLessThanOrEqual(0.5);
    // From then on it's followed as before.
    const moved = boxes.map((b) => ({ ...b, y: b.y + r.dy }));
    expect(t.step('g', codeScreen(7, 30), m, moved).state).toBe('steady');
  });

  it('an engine that never saw it has nothing to look for', () => {
    const t = new InkTracker();
    const m = none(codeScreen(7));
    expect(t.step('g', codeScreen(7), m, lines([42]), [], [], true).state).toBe('unsure');
  });
});

describe('sticky ink: a dragged window', () => {
  /** A window of code (`seed`, scrolled by `offset`) at (x, y) on a plain desktop. */
  function desktop(seed: number, x: number, y: number, offset = 0, w = 480, h = 320): Gray {
    const win = codeScreen(seed, offset, 280, 180);
    const data = new Uint8Array(w * h).fill(96);
    for (let r = 0; r < win.height; r++) {
      for (let c = 0; c < win.width; c++) {
        const X = x + c;
        const Y = y + r;
        if (X >= 0 && Y >= 0 && X < w && Y < h) data[Y * w + X] = win.data[r * win.width + c];
      }
    }
    return { width: w, height: h, data };
  }
  // Three lines of the window at (40, 50).
  const boxes = lines([92, 104, 116], 46, 200);
  const m = none(desktop(7, 40, 50));

  it('the marks go with it, sideways too', () => {
    const ref = desktop(7, 40, 50);
    for (const [dx, dy] of [[40, 25], [-30, 10], [60, 0], [-15, -35], [3, 2], [1, 0], [-1, 1]]) {
      const v = judge(ref, m, desktop(7, 40 + dx, 50 + dy), m, boxes);
      expect(v.state, `dragged ${dx},${dy}`).toBe('moved');
      expect(v.dx, `dragged ${dx},${dy} → ${v.dx},${v.dy}`).toBe(dx);
      expect(Math.abs(v.dy - dy), `dragged ${dx},${dy} → ${v.dx},${v.dy}`).toBeLessThanOrEqual(0.5);
    }
  });

  it("another window where it was isn't taken for it moving", () => {
    expect(judge(desktop(7, 40, 50), m, desktop(42, 40, 50), m, boxes).state).toBe('changed');
    expect(judge(desktop(7, 40, 50), m, desktop(42, 90, 70), m, boxes).state).toBe('changed');
  });

  it('is followed through a drag seen in steps, and lined up exactly once it stops', () => {
    const t = new InkTracker();
    let marks = boxes;
    t.step('g', desktop(7, 40, 50), m, marks);
    let x = 40;
    let y = 50;
    for (const [dx, dy] of [[12, 5], [25, 9], [18, 4]]) {
      x += dx;
      y += dy;
      const r = t.step('g', desktop(7, x, y), m, marks);
      expect(r.state, `dragged to ${x},${y}`).toBe('moved');
      marks = marks.map((b) => ({ ...b, x: b.x + (r.dx ?? 0), y: b.y + r.dy }));
    }
    for (let i = 0; i < 2; i++) {
      const r = t.step('g', desktop(7, x, y), m, marks);
      marks = marks.map((b) => ({ ...b, x: b.x + (r.dx ?? 0), y: b.y + r.dy }));
    }
    expect(marks[0].x).toBe(boxes[0].x + x - 40);
    expect(Math.abs(marks[0].y - (boxes[0].y + y - 50))).toBeLessThanOrEqual(0.5);
  });

  it('the last pixel of a drag, after a look caught it just short, is followed too', () => {
    // (Seen in the README demo: a look at 68, 39 of a 70, 40 drag, then the window still.)
    const t = new InkTracker();
    t.step('g', desktop(7, 40, 50), m, boxes);
    const r1 = t.step('g', desktop(7, 74, 69), m, boxes);
    expect([r1.state, r1.dx, r1.dy]).toEqual(['moved', 34, 19]);
    const marks = boxes.map((b) => ({ ...b, x: b.x + 34, y: b.y + 19 }));
    const r2 = t.step('g', desktop(7, 75, 70), m, marks);
    expect(r2.state).toBe('moved');
    expect(r2.dx).toBe(1);
    expect(Math.abs(r2.dy - 1)).toBeLessThanOrEqual(0.5);
  });

  it('a group that went away is found again in a window dragged elsewhere', () => {
    const t = new InkTracker();
    t.step('g', desktop(7, 40, 50), m, boxes);
    for (let i = 0; i < GONE_AFTER; i++) t.step('g', desktop(42, 40, 50), m, boxes);
    const r = t.step('g', desktop(7, 120, 90), m, boxes, [], [], true);
    expect(r.state).toBe('back');
    expect(r.dx).toBe(80);
    expect(Math.abs(r.dy - 40)).toBeLessThanOrEqual(0.5);
  });
});

describe('sticky ink: areas that never stop changing', () => {
  it('a video (cells changing in every sample) is skipped, a scroll (a burst) is not', () => {
    const W = 8;
    const H = 4;
    const frame = (cells: number[]) => {
      const m = new Uint8Array(W * H);
      for (const c of cells) m[c] = 1;
      return m;
    };
    const bounds = { x: 0, y: 0, width: 800, height: 400 };
    // Cells 5 and 6 change every time (a video); cell 1 changed once (part of a scroll).
    const history = [frame([5, 6, 1]), frame([5, 6]), frame([5, 6]), frame([5, 6]), frame([5])];
    const areas = movingAreas(history, W, H, bounds);
    expect(areas.map((r) => Math.round(r.x + 1))).toEqual([500, 600]);
    expect(movingAreas(history.slice(0, 3), W, H, bounds)).toEqual([]); // too soon to tell
  });
});

describe('sticky ink on real captures', () => {
  // Looks the engine took while the README's sticky scene scrolled (test/fixtures/sticky): the
  // first marked line had gone under the header, the second was half under it, and the third
  // (`return a`) is how a line five further on begins. The two scrolls were once taken for a
  // five-line jump the other way, and the last half pixel of one for a jump of 72 px.
  const dir = join(__dirname, '..', 'fixtures', 'sticky');
  const meta = JSON.parse(readFileSync(join(dir, 'big-scroll.json'), 'utf8')) as { width: number; height: number; cases: { name: string; ref: string; cur: string; boxes: PxBox[]; dy: number; settle?: boolean }[] };
  const look = (name: string) => ({
    g: { width: meta.width, height: meta.height, data: new Uint8Array(gunzipSync(readFileSync(join(dir, `${name}.gray.gz`)))) },
    m: new Uint8Array(gunzipSync(readFileSync(join(dir, `${name}.mask.gz`)))),
  });
  for (const c of meta.cases) {
    it(`${c.name}: moved ${c.dy} px`, () => {
      const ref = look(c.ref);
      const cur = look(c.cur);
      const v = judge(ref.g, ref.m, cur.g, cur.m, c.boxes);
      if (c.settle && v.state !== 'moved') expect(['steady', 'unsure']).toContain(v.state);
      else {
        expect(v.state).toBe('moved');
        expect(Math.abs(v.dy - c.dy), `moved ${v.dy}`).toBeLessThanOrEqual(0.5);
      }
    });
  }
});
