import { describe, expect, it, vi } from 'vitest';
import type { Rect } from '../../src/shared/geometry';
import type { InkItem } from '../../src/shared/ink';
import type { EncodedFrame } from '../../src/shared/ipc';
import { chipBox, CHIP_FONT_SIZE, drawDurationFor, penStateAt, textAnchor } from '../../src/shared/ink-geometry';
import { buildInk, valuePosition } from '../../src/main/session/marks';
import { lineEnd, type Bitmap } from '../../src/main/vision/snap';

// visual.ts pulls in Electron through its feature imports; the pure helpers are what we test.
vi.mock('electron', () => ({ ipcMain: { on() {} }, app: { isPackaged: false }, nativeImage: {} }));
const { beatSequence, chainChips, demoTrace, endInGutter, replacedChips } = await import('../../src/main/session/features/visual');
const { gestureSteps } = await import('../../src/main/session/gestures');
const { ExplanationPlanner } = await import('../../src/main/vision/planner');
const { InkRenderer } = await import('../../src/renderer/ui/ink-render');

const display: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const style = { color: '#2F7BFF', author: 'tutor' as const, surface: 'screen' as const, group: 'g', font: 'system' as const };
const line: Rect = { x: 100, y: 200, width: 220, height: 24 };

function chipFor(text: string, endX?: number, rect = line): InkItem {
  const [it] = buildInk([{ kind: 'value', rect, text, endX }], display, style);
  return { ...it, revealAt: 1000 };
}

/** Records the pills and text a chip is drawn with. */
function chipCtx() {
  const fills: { color: string; rect: number[] }[] = [];
  const texts: { text: string; x: number; y: number; color: string; font: string }[] = [];
  let path: number[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetY: 0,
    font: '',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    save() {},
    restore() {},
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push(x, y);
    },
    arcTo(x1: number, y1: number, x2: number, y2: number) {
      path.push(x1, y1, x2, y2);
    },
    closePath() {},
    fill() {
      const xs = path.filter((_, i) => i % 2 === 0);
      const ys = path.filter((_, i) => i % 2 === 1);
      fills.push({ color: String(ctx.fillStyle), rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] });
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, color: String(ctx.fillStyle), font: ctx.font });
    },
    fillRect() {},
    measureText: (s: string) => ({ width: [...s].length * 0.602 * CHIP_FONT_SIZE }),
    setLineDash() {},
    stroke() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, texts, alpha: () => ctx.globalAlpha };
}

describe('value chips (trace_code)', () => {
  it('sit just after the end of the line, centred on it, in a monospaced pill', () => {
    const c = chipFor('n = 3', 262);
    expect(c.kind).toBe('text');
    expect(c.chip).toBe(true);
    expect(c.font).toBe('mono');
    expect(c.text).toBe('n = 3');
    const b = chipBox(c)!;
    expect(b.x).toBe(262 + 14);
    expect(Math.abs(b.y + b.height / 2 - (line.y + line.height / 2))).toBeLessThanOrEqual(1);
    expect(b.height).toBeGreaterThan(18);
    expect(b.height).toBeLessThan(26);
    // Without a measured end, the line box's right edge is the end.
    expect(chipBox(chipFor('n = 3'))!.x).toBe(line.x + line.width + 14);
    // Small code (a 12–14 px editor font): a smaller chip, never taller than the line.
    const small = buildInk([{ kind: 'value', rect: { x: 100, y: 200, width: 120, height: 16.5 }, text: 'n = 3' }], display, style)[0];
    expect(small.fontSize).toBe(10.5);
    expect(chipBox(small)!.height).toBeLessThanOrEqual(17);
    // Room runs out at the right of the screen: it stays on screen.
    const far = valuePosition({ x: 1200, y: 400, width: 230, height: 24 }, 'returns 6', display);
    expect(far.x + chipBox({ at: far, text: 'returns 6' })!.width).toBeLessThanOrEqual(display.width - 8);
  });

  it('is typed onto the pill key by key, quickly, and the pill grows with it', () => {
    const c = chipFor('i = 2, total = 3', 300);
    expect(c.drawMs).toBeGreaterThanOrEqual(260);
    expect(c.drawMs).toBeLessThanOrEqual(1600);
    expect(drawDurationFor(c)).toBe(c.drawMs);
    let prev = -1;
    for (let ms = 0; ms <= c.drawMs; ms += 40) {
      const n = penStateAt(c, ms).chars;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    expect(penStateAt(c, c.drawMs).chars).toBe([...c.text!].length);
    // The cursor "clicks" just left of the chip and stays there while it types.
    const a = textAnchor(c)!;
    const b = chipBox(c)!;
    expect(a.x).toBeLessThan(b.x);
    expect(a.y).toBeGreaterThan(b.y);
    expect(a.y).toBeLessThan(b.y + b.height);

    const mid = chipCtx();
    new InkRenderer().render(mid.ctx, [c], c.revealAt + c.drawMs * 0.5, 1);
    const half = penStateAt(c, c.drawMs * 0.5).chars;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan([...c.text!].length);
    expect(mid.fills[0].color).toBe('#2F7BFF');
    expect(mid.texts[0]).toMatchObject({ text: [...c.text!].slice(0, half).join(''), color: '#fff' });
    expect(mid.texts[0].font).toMatch(/monospace/);
    const done = chipCtx();
    new InkRenderer().render(done.ctx, [c], c.revealAt + c.drawMs + 500, 1);
    expect(done.texts[0].text).toBe('i = 2, total = 3');
    expect(done.fills[0].rect[2]).toBeGreaterThan(mid.fills[0].rect[2] + 10);
    expect(done.fills[0].rect[2]).toBeCloseTo(chipBox(c)!.width, 0);
  });

  it('a newer value on the same line replaces the old chip: it goes quickly, just before', () => {
    const old = { ...chipFor('n = 3', 262), revealAt: 1000 };
    const other = { ...chipFor('n = 3', 262, { ...line, y: 260 }), revealAt: 1000 };
    const next = { ...chipFor('n = 2', 262), revealAt: 5000 };
    const gone = replacedChips([old, other], [next], 4000);
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ id: old.id, fadeAt: 4940, fadeMs: 180 });
    // Not the other line's, not an older one, not one already fading earlier.
    expect(replacedChips([{ ...next, id: 'x', revealAt: 9000 }], [next], 4000)).toHaveLength(0);
    expect(replacedChips([{ ...old, fadeAt: 2000 }], [next], 4000)).toHaveLength(0);
    // A fast fade, not the usual one.
    const ctx = chipCtx();
    new InkRenderer().render(ctx.ctx, [gone[0]], 4940 + 90, 1);
    expect(ctx.texts.length).toBe(1);
  });
});

describe('"say that again" with a trace', () => {
  it('replayed chips update in place again, instead of piling up on the line', () => {
    const a = { ...chipFor('n = 2', 262), revealAt: 1000, fadeAt: null };
    const b = { ...chipFor('2 == 0 → False', 240, { ...line, y: 240 }), revealAt: 2000, fadeAt: null };
    const c = { ...chipFor('n = 1', 262), revealAt: 4000, fadeAt: null };
    chainChips([c, b, a]);
    expect(a).toMatchObject({ fadeAt: 3940, fadeMs: 180 });
    expect(b.fadeAt).toBeNull();
    expect(c.fadeAt).toBeNull();
  });
});

describe('where a line of code ends (from pixels)', () => {
  /** A white image with dark "glyph" runs, [x1, x2) on rows [y1, y2): strokes 2 px on, 2 off. */
  function bitmap(runs: [number, number, number, number][], w = 600, h = 120): Bitmap {
    const data = new Uint8Array(w * h * 4).fill(255);
    for (const [x1, x2, y1, y2] of runs) {
      for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) if (x % 4 < 2) data.set([30, 30, 30, 255], (y * w + x) * 4);
    }
    return { width: w, height: h, data };
  }
  // "def factorial(n):" as glyph runs separated by one-character spaces (10 px).
  const words: [number, number, number, number][] = [
    [40, 70, 44, 62],
    [80, 190, 44, 62],
  ];

  it('finds the end with a tight box, a short box and one that runs on past the text', () => {
    const img = bitmap(words);
    expect(lineEnd(img, { x1: 40, y1: 42, x2: 190, y2: 64 })).toBe(190);
    expect(lineEnd(img, { x1: 40, y1: 42, x2: 120, y2: 64 })).toBe(190); // box too short
    expect(lineEnd(img, { x1: 40, y1: 42, x2: 420, y2: 64 })).toBe(190); // box too long
  });

  it('keeps an aligned comment that starts inside the box, stops at a far one outside it', () => {
    const img = bitmap([...words, [250, 330, 44, 62], [520, 590, 44, 62]]);
    expect(lineEnd(img, { x1: 40, y1: 42, x2: 330, y2: 64 })).toBe(330);
    expect(lineEnd(img, { x1: 40, y1: 42, x2: 190, y2: 64 })).toBe(190);
  });

  it("doesn't take a window's edge for the line", () => {
    // The window ends at x = 400 and the desktop beyond it is grey.
    const edged = (runs: [number, number, number, number][]) => {
      const img = bitmap(runs);
      for (let y = 0; y < img.height; y++) for (let x = 400; x < img.width; x++) img.data.set([128, 128, 128, 255], (y * img.width + x) * 4);
      return img;
    };
    // A box over empty space: the pixels don't show the line, so there's no end to find.
    expect(lineEnd(edged([]), { x1: 160, y1: 42, x2: 330, y2: 64 })).toBeNull();
    // Text that runs up to the edge ends where the text does.
    expect(lineEnd(edged([[40, 70, 44, 62], [80, 392, 44, 62]]), { x1: 40, y1: 42, x2: 380, y2: 64 })).toBe(390);
  });

  it('keeps a selected word (a filled span inside the line)', () => {
    const img = bitmap([...words, [200, 260, 44, 62]]);
    // A selection behind "260…300": a blue fill the full height of the line.
    for (let y = 40; y < 66; y++) for (let x = 196; x < 264; x++) img.data.set([38, 79, 120, 255], (y * img.width + x) * 4);
    expect(lineEnd(img, { x1: 40, y1: 42, x2: 250, y2: 64 })).toBe(264);
  });

  it("ignores the next line's ascenders and Pairwise's own cursor", () => {
    // A longer line just below whose tall glyphs reach into the bottom of this line's box.
    const img = bitmap([...words, [40, 400, 62, 80], [196, 214, 40, 66]]);
    expect(lineEnd(img, { x1: 40, y1: 42, x2: 190, y2: 66 }, { ignore: [{ x1: 194, y1: 38, x2: 216, y2: 68 }] })).toBe(190);
  });
});

describe('planned traces', () => {
  const frame = { ref: { id: 'f', displayId: 'd1', region: { x: 0, y: 0, width: 1000, height: 800 }, pixelWidth: 2000, pixelHeight: 1600, capturedAt: 0, kind: 'hires' }, data: new Uint8Array(), mime: 'image/jpeg', changeScore: 0, veiled: [] } as unknown as EncodedFrame;

  it('a beat follows its line, then types the value where the line really ends', () => {
    const seq = beatSequence(
      [
        { kind: 'follow_line', box_2d: [250, 100, 280, 300] },
        { kind: 'value', box_2d: [250, 100, 280, 300], text: 'n = 3' },
      ],
      frame,
      display,
      style,
      (r) => r.x + 150,
    );
    expect(seq).toHaveLength(2);
    expect('gesture' in seq[0] && seq[0].gesture.style).toBe('follow_line');
    const chip = 'ink' in seq[1] ? seq[1].ink : null;
    expect(chip).toMatchObject({ kind: 'text', chip: true, text: 'n = 3' });
    expect(chip!.at!.x).toBe(100 + 150 + 14);
  });

  it('the demo trace updates a value in place on its last step', () => {
    const beats = demoTrace();
    expect(beats.length).toBeGreaterThanOrEqual(3);
    const values = beats.flatMap((b) => b.marks.filter((m) => m.kind === 'value'));
    expect(values.length).toBe(beats.length);
    expect(values[values.length - 1].box_2d).toEqual(values[0].box_2d);
    expect(values[values.length - 1].text).not.toBe(values[0].text);
  });

  it('asks the planner for a careful trace and keeps only valid steps', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const beats = Array.from({ length: 12 }, (_, i) => ({
      say: `Step ${i + 1}.`,
      marks: [
        { kind: 'follow_line', box_2d: [100 + i * 30, 100, 125 + i * 30, 400] },
        { kind: 'value', box_2d: [100 + i * 30, 100, 125 + i * 30, 400], text: i === 3 ? '' : `i = ${i}` },
      ],
    }));
    const rest = {
      hasKey: true,
      generateJson: async (_model: string, body: Record<string, unknown>) => {
        calls.push({ body });
        return { beats };
      },
    };
    const planner = new ExplanationPlanner(rest as never, () => 'vision-model');
    const plan = await planner.plan({ frame, question: 'what does it print?', lines: 8, tutorName: 'Ada', courseLine: 'COMP 1405', terms: [], depth: 'standard', mode: 'trace', input: 'n = 3' });
    expect(plan.beats).toHaveLength(10);
    expect(plan.beats[3].marks.map((m) => m.kind)).toEqual(['follow_line']); // the empty value is dropped
    const cfg = calls[0].body.generationConfig as { thinkingConfig: { thinkingLevel: string } };
    expect(cfg.thinkingConfig.thinkingLevel).toBe('medium');
    const prompt = JSON.stringify(calls[0].body.contents);
    expect(prompt).toContain('like a debugger');
    expect(prompt).toContain('n = 3');
    expect(prompt).toContain('at most 8 beats');
  });
});

describe('the end of a trace', () => {
  it("leaves her cursor in the gutter of the last line it ran, clear of the values", () => {
    const line = (y: number) => ({ x: 120, y, width: 200, height: 26 });
    const chip = (y: number) => ({ ink: { id: `c${y}`, author: 'tutor', kind: 'text', chip: true, text: 'n = 1', at: { x: 334, y: y + 2 }, color: '#2F7BFF', surface: 'screen', revealAt: 0, drawMs: 400, seed: 1 } as InkItem });
    const beats = endInGutter([
      { say: 'one', seq: [{ gesture: { style: 'run_line', rect: line(100) } }, chip(100)] },
      { say: 'two', seq: [{ gesture: { style: 'run_line', rect: line(140) } }, chip(140)] },
      { say: 'and that is it.', seq: [] },
    ]);
    // Added once, after the last value typed, on the last line that ran.
    const last = beats[1].seq[beats[1].seq.length - 1];
    expect('gesture' in last && last.gesture).toEqual({ style: 'gutter', rect: line(140) });
    expect(beats[0].seq).toHaveLength(2);
    const [fly] = gestureSteps({ style: 'gutter', rect: line(140) });
    expect(fly.kind).toBe('fly');
    const to = (fly as { to: { x: number; y: number } }).to;
    // Left of the text (the arrow's body, ~12 px wide, stays off it), level with the line.
    expect(to.x + 13).toBeLessThan(120);
    expect(to.y).toBeGreaterThan(140);
    expect(to.y).toBeLessThan(140 + 26);
  });
});
