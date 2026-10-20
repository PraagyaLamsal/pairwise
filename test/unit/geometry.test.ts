import { describe, expect, it } from 'vitest';
import {
  box2dToGlobal,
  cropAround,
  displayForPoint,
  framePixelToGlobal,
  globalRectToCapturePixels,
  globalToBox2d,
  globalToDisplayLocal,
  globalToNorm,
  normToGlobal,
  numberDisplays,
  yxToGlobal,
  type DisplayInfo,
  type FrameRef,
} from '@shared/geometry';

/** A Retina laptop with an external 1x monitor to its LEFT (negative origin) and one above. */
const displays: DisplayInfo[] = numberDisplays([
  { id: 'laptop', bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 }, scaleFactor: 2, label: 'Built-in', index: 0, isPrimary: true },
  { id: 'left', bounds: { x: -1920, y: -98, width: 1920, height: 1080 }, workArea: { x: -1920, y: -98, width: 1920, height: 1080 }, scaleFactor: 1, label: 'Dell', index: 0, isPrimary: false },
  { id: 'top', bounds: { x: 200, y: -1440, width: 2560, height: 1440 }, workArea: { x: 200, y: -1440, width: 2560, height: 1440 }, scaleFactor: 2, label: 'Studio', index: 0, isPrimary: false },
]);

const frameFor = (d: DisplayInfo, kind: FrameRef['kind'] = 'live', pixelWidth = 1280): FrameRef => ({
  id: 'f',
  displayId: d.id,
  region: { ...d.bounds },
  pixelWidth,
  pixelHeight: Math.round((pixelWidth * d.bounds.height) / d.bounds.width),
  capturedAt: 0,
  kind,
});

describe('display numbering', () => {
  it('numbers displays left-to-right for the model', () => {
    expect(displays.map((d) => [d.id, d.index])).toEqual([
      ['left', 1],
      ['laptop', 2],
      ['top', 3],
    ]);
  });
});

describe('normalized model coordinates', () => {
  it('maps 0–1000 points onto each display, including negative origins', () => {
    const left = displays.find((d) => d.id === 'left')!;
    expect(normToGlobal(frameFor(left), 0, 0)).toEqual({ x: -1920, y: -98 });
    expect(normToGlobal(frameFor(left), 1000, 1000)).toEqual({ x: 0, y: 982 });
    expect(normToGlobal(frameFor(left), 500, 500)).toEqual({ x: -960, y: 442 });
    const top = displays.find((d) => d.id === 'top')!;
    expect(normToGlobal(frameFor(top), 250, 750)).toEqual({ x: 200 + 640, y: -1440 + 1080 });
  });

  it('round-trips global → normalized → global', () => {
    for (const d of displays) {
      const f = frameFor(d);
      for (const p of [
        { x: d.bounds.x + 13, y: d.bounds.y + 7 },
        { x: d.bounds.x + d.bounds.width / 3, y: d.bounds.y + d.bounds.height * 0.8 },
      ]) {
        const n = globalToNorm(f, p);
        const back = normToGlobal(f, n.x, n.y);
        expect(back.x).toBeCloseTo(p.x, 6);
        expect(back.y).toBeCloseTo(p.y, 6);
      }
    }
  });

  it('box_2d is [ymin, xmin, ymax, xmax] and tolerates swapped corners', () => {
    const laptop = displays.find((d) => d.id === 'laptop')!;
    const f = frameFor(laptop);
    const r = box2dToGlobal(f, [100, 200, 300, 400]);
    expect(r.x).toBeCloseTo(302.4, 6);
    expect(r.y).toBeCloseTo(98.2, 6);
    expect(r.width).toBeCloseTo(302.4, 6);
    expect(r.height).toBeCloseTo(196.4, 6);
    expect(box2dToGlobal(f, [300, 400, 100, 200])).toEqual(r);
    expect(globalToBox2d(f, r)).toEqual([100, 200, 300, 400]);
  });

  it('pointing format [y, x]', () => {
    const laptop = displays.find((d) => d.id === 'laptop')!;
    expect(yxToGlobal(frameFor(laptop), [500, 250])).toEqual({ x: 378, y: 491 });
  });

  it('crops map back exactly (zoom-in refinement)', () => {
    const laptop = displays.find((d) => d.id === 'laptop')!;
    const crop: FrameRef = { ...frameFor(laptop, 'crop', 1200), region: { x: 400, y: 300, width: 600, height: 400 }, pixelHeight: 800 };
    expect(normToGlobal(crop, 0, 0)).toEqual({ x: 400, y: 300 });
    expect(normToGlobal(crop, 500, 500)).toEqual({ x: 700, y: 500 });
    expect(framePixelToGlobal(crop, 600, 400)).toEqual({ x: 700, y: 500 });
  });
});

describe('capture pixels (HiDPI)', () => {
  it('converts a global rect to physical pixels of a Retina capture', () => {
    const laptop = displays.find((d) => d.id === 'laptop')!;
    expect(globalRectToCapturePixels(laptop, { x: 100, y: 50, width: 200, height: 100 })).toEqual({ x: 200, y: 100, width: 400, height: 200 });
    // When the stream is downscaled to 1512 px wide, the scale comes from the stream width.
    expect(globalRectToCapturePixels(laptop, { x: 100, y: 50, width: 200, height: 100 }, 1512)).toEqual({ x: 100, y: 50, width: 200, height: 100 });
  });

  it('handles displays with negative origins', () => {
    const left = displays.find((d) => d.id === 'left')!;
    expect(globalRectToCapturePixels(left, { x: -1920, y: -98, width: 10, height: 10 })).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});

describe('displays and overlays', () => {
  it('finds the display under a point and the nearest one for gaps', () => {
    expect(displayForPoint(displays, { x: -5, y: 10 })?.id).toBe('left');
    expect(displayForPoint(displays, { x: 10, y: 10 })?.id).toBe('laptop');
    expect(displayForPoint(displays, { x: 300, y: -10 })?.id).toBe('top');
    // gap below the left monitor
    expect(displayForPoint(displays, { x: -100, y: 1100 })?.id).toBe('left');
  });

  it('converts global points to overlay-local coordinates', () => {
    const left = displays.find((d) => d.id === 'left')!;
    expect(globalToDisplayLocal(left, { x: -960, y: 0 })).toEqual({ x: 960, y: 98 });
  });

  it('keeps crops inside the display', () => {
    const laptop = displays.find((d) => d.id === 'laptop')!;
    expect(cropAround(laptop.bounds, { x: 10, y: 10 }, 800, 600)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(cropAround(laptop.bounds, { x: 1500, y: 970 }, 800, 600)).toEqual({ x: 712, y: 382, width: 800, height: 600 });
  });
});
