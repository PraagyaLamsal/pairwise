import { describe, expect, it } from 'vitest';
import { namesControl, snapToControl, type Bitmap } from '../../src/main/vision/snap';
import { circlePoints } from '../../src/shared/ink-geometry';

/** Tiny raster: fill, rect outlines, filled rects ("glyphs"). */
function canvas(w: number, h: number, bg: [number, number, number]): Bitmap & { fill(x: number, y: number, ww: number, hh: number, c: [number, number, number]): void; outline(x: number, y: number, ww: number, hh: number, c: [number, number, number], t?: number): void } {
  const data = new Uint8Array(w * h * 4);
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, bg);
  return {
    width: w,
    height: h,
    data,
    fill(x, y, ww, hh, c) {
      for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) set(xx, yy, c);
    },
    outline(x, y, ww, hh, c, t = 1) {
      for (let k = 0; k < t; k++) {
        for (let xx = x; xx < x + ww; xx++) {
          set(xx, y + k, c);
          set(xx, y + hh - 1 - k, c);
        }
        for (let yy = y; yy < y + hh; yy++) {
          set(x + k, yy, c);
          set(x + ww - 1 - k, yy, c);
        }
      }
    },
  };
}

/** Sparse fake glyphs inside a label box (vertical strokes). */
function label(c: ReturnType<typeof canvas>, x: number, y: number, w: number, h: number) {
  for (let xx = x; xx < x + w; xx += 4) c.fill(xx, y, 2, h, [20, 20, 20]);
}

describe('snapToControl', () => {
  it('grows a label box to the outlined button around it', () => {
    const c = canvas(400, 200, [238, 241, 245]);
    c.fill(100, 60, 120, 40, [255, 255, 255]);
    c.outline(100, 60, 120, 40, [136, 136, 153]);
    label(c, 128, 72, 64, 16);
    const r = snapToControl(c, { x1: 128, y1: 72, x2: 192, y2: 88 });
    expect(r).toEqual({ x1: 100, y1: 60, x2: 220, y2: 100 });
  });

  it('works for a filled button with no outline (blue button, white text)', () => {
    const c = canvas(400, 200, [255, 255, 255]);
    c.fill(50, 50, 140, 44, [51, 128, 255]);
    for (let xx = 80; xx < 160; xx += 5) c.fill(xx, 64, 2, 16, [255, 255, 255]);
    const r = snapToControl(c, { x1: 80, y1: 64, x2: 160, y2: 80 });
    expect(r).not.toBeNull();
    expect(r!.x1).toBeLessThanOrEqual(50);
    expect(r!.x2).toBeGreaterThanOrEqual(190);
    expect(r!.y1).toBeLessThanOrEqual(50);
    expect(r!.y2).toBeGreaterThanOrEqual(94);
  });

  it('leaves plain text alone (no control around it)', () => {
    const c = canvas(400, 200, [255, 255, 255]);
    label(c, 100, 40, 80, 16); // line above
    label(c, 100, 70, 80, 16); // the word
    label(c, 100, 100, 120, 16); // line below
    expect(snapToControl(c, { x1: 100, y1: 70, x2: 180, y2: 86 })).toBeNull();
  });

  it('does not jump to a far-away panel border', () => {
    const c = canvas(600, 400, [255, 255, 255]);
    c.outline(20, 20, 560, 360, [120, 120, 120]);
    label(c, 200, 190, 60, 16);
    expect(snapToControl(c, { x1: 200, y1: 190, x2: 260, y2: 206 })).toBeNull();
  });

  it('knows which descriptions name a control', () => {
    expect(namesControl('the "Submit" button')).toBe(true);
    expect(namesControl('the search field at the top')).toBe(true);
    expect(namesControl('the word "factorial" on line 1')).toBe(false);
    expect(namesControl('line 4, the recursive call')).toBe(false);
  });
});

/** Winding number test (the loop overlaps itself a little at the end, which is fine). */
function insideLoop(p: { x: number; y: number }, pts: { x: number; y: number }[]): boolean {
  let wn = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) {
      if (b.y > p.y && cross > 0) wn++;
    } else if (b.y <= p.y && cross < 0) wn--;
  }
  return wn !== 0;
}

describe('circlePoints', () => {
  const rects = [
    { x: 100, y: 100, width: 96, height: 37 },
    { x: 100, y: 100, width: 60, height: 60 },
    { x: 100, y: 100, width: 420, height: 22 },
    { x: 100, y: 100, width: 18, height: 18 },
    { x: 100, y: 100, width: 240, height: 120 },
  ];
  it('encloses every corner of the target, for any seed', () => {
    for (const r of rects) {
      for (let seed = 1; seed < 60; seed++) {
        const pts = circlePoints(r, seed * 7919);
        for (const corner of [
          { x: r.x, y: r.y },
          { x: r.x + r.width, y: r.y },
          { x: r.x, y: r.y + r.height },
          { x: r.x + r.width, y: r.y + r.height },
        ]) {
          expect(insideLoop(corner, pts), `corner ${JSON.stringify(corner)} of ${JSON.stringify(r)} seed ${seed}`).toBe(true);
        }
      }
    }
  });
  it('still hugs the target (no more than ~30 px of slack on wide things)', () => {
    for (const r of rects) {
      const pts = circlePoints(r, 12345);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const slackX = (Math.max(...xs) - Math.min(...xs) - r.width) / 2;
      const slackY = (Math.max(...ys) - Math.min(...ys) - r.height) / 2;
      expect(slackX).toBeLessThan(Math.max(30, r.width * 0.2));
      expect(slackY).toBeLessThan(Math.max(26, r.height * 0.45));
    }
  });
});

import { matchWords, ocrNorm, searchTerms, type OcrWord } from '../../src/main/vision/grounder';

describe('OCR matching', () => {
  const w = (text: string, x: number, y: number, line: string, width = text.length * 10): OcrWord => ({ text, x, y, w: width, h: 16, line });
  it('normalises punctuation around tokens', () => {
    expect(ocrNorm('(Run')).toBe('run');
    expect(ocrNorm('‘Submit')).toBe('submit');
    expect(ocrNorm('factorial(n):')).toBe('factorial(n');
  });
  it('finds quoted terms first and trims prefix matches to the matched characters', () => {
    expect(searchTerms('the word "factorial" on line 1')).toEqual(['factorial']);
    const words = [w('def', 10, 10, 'a'), w('factorial(n):', 50, 10, 'a', 130), w('return', 10, 60, 'b'), w('factorial(n', 80, 60, 'b', 110)];
    const hits = matchWords(words, 'the word "factorial" on line 1');
    expect(hits).toHaveLength(2);
    expect(hits[0].exact).toBe(false);
    expect(hits[0].x2).toBeCloseTo(50 + (130 * 9) / 13, 5);
  });
  it('matches multi-word terms only within one row of text', () => {
    // Different rows (or a column far off to the side) are not one phrase.
    expect(matchWords([w('Save', 10, 10, 'a'), w('as', 60, 40, 'b')], 'the "Save as" item')).toHaveLength(0);
    expect(matchWords([w('Save', 10, 10, 'a'), w('as', 160, 10, 'b')], 'the "Save as" item')).toHaveLength(0);
    expect(matchWords([w('Save', 10, 10, 'a'), w('as', 60, 10, 'a')], 'the "Save as" item')).toHaveLength(1);
    // Tesseract puts low-confidence symbols on lines of their own; side by side, it's one row.
    const code = [w('if', 10, 10, 'a'), w('n', 40, 10, 'a'), w('==', 62, 12, 'b', 20), w('0:', 92, 10, 'b', 18)];
    expect(matchWords(code, 'the line "if n == 0:"')).toHaveLength(1);
  });
});

import { mergeHits } from '../../src/main/vision/grounder';

describe('mergeHits', () => {
  it('folds the same word from several passes into a median box, keeps distinct words apart', () => {
    const m = mergeHits([
      { x1: 100, y1: 50, x2: 160, y2: 66, exact: true },
      { x1: 98, y1: 44, x2: 172, y2: 70, exact: false }, // swallowed the border
      { x1: 101, y1: 51, x2: 159, y2: 65, exact: true },
      { x1: 100, y1: 200, x2: 160, y2: 216, exact: false },
    ]);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ x1: 100, y1: 50, x2: 160, y2: 66, exact: true });
    expect(m[1].y1).toBe(200);
  });
});
