import { desktopCapturer, screen } from 'electron';
import type { DisplayInfo } from '@shared/geometry';
import type { CaptureSourceSpec } from '@shared/ipc';
import { env } from '../env';
import { logger } from '../log';

const log = logger('capture');

/**
 * Maps each display to a desktop-capture source. On macOS every display has its own source
 * (matched by display_id). With fake displays (CI) or when the platform only exposes one source
 * for the whole desktop (X11), each display is cropped out of that single source.
 */
export async function captureSources(displays: DisplayInfo[]): Promise<CaptureSourceSpec[]> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  if (!sources.length) throw new Error('No screen available to capture (Screen Recording permission?)');

  const matched = displays.map((d) => sources.find((s) => s.display_id === d.id));
  if (!env.fakeDisplays && matched.every(Boolean)) {
    return displays.map((d, i) => ({ displayId: d.id, sourceId: matched[i]!.id, bounds: d.bounds, scaleFactor: d.scaleFactor }));
  }

  // One source for the whole desktop: crop per display.
  const real = screen.getAllDisplays();
  const desk = {
    x: Math.min(...real.map((d) => d.bounds.x)),
    y: Math.min(...real.map((d) => d.bounds.y)),
    right: Math.max(...real.map((d) => d.bounds.x + d.bounds.width)),
    bottom: Math.max(...real.map((d) => d.bounds.y + d.bounds.height)),
  };
  const scale = real[0]?.scaleFactor ?? 1;
  const size = { width: Math.round((desk.right - desk.x) * scale), height: Math.round((desk.bottom - desk.y) * scale) };
  log.info(`single capture source for ${displays.length} display(s), desktop ${size.width}x${size.height}`);
  return displays.map((d) => ({
    displayId: d.id,
    sourceId: sources[0].id,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    sourceSize: size,
    cropFromSource: {
      x: Math.round((d.bounds.x - desk.x) * scale),
      y: Math.round((d.bounds.y - desk.y) * scale),
      width: Math.round(d.bounds.width * scale),
      height: Math.round(d.bounds.height * scale),
    },
  }));
}
