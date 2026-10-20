import { nativeImage } from 'electron';
import type { EncodedFrame } from '@shared/ipc';
import type { Bitmap } from './snap';

/** JPEG/PNG frame → raw pixels (BGRA) via Chromium's decoder. */
export function decodeFrame(frame: EncodedFrame): Bitmap | null {
  const img = nativeImage.createFromBuffer(Buffer.from(frame.data));
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  return { width, height, data: new Uint8Array(img.toBitmap()) };
}

/** Scale a frame by `factor` (PNG out, so OCR sees no new JPEG artefacts). */
export function resizeFrame(frame: EncodedFrame, factor: number): { data: Uint8Array; mime: string } | null {
  const img = nativeImage.createFromBuffer(Buffer.from(frame.data));
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const out = img.resize({ width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)), quality: 'best' });
  return { data: new Uint8Array(out.toPNG()), mime: 'image/png' };
}
