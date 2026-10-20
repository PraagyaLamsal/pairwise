import { execFile, execFileSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Synthesizer } from './mock-live';

/** Extracts the PCM payload (and sample rate) of a RIFF/WAVE file. */
export function wavToPcm(buf: Buffer): Buffer | null {
  return parseWav(buf)?.pcm ?? null;
}

export function parseWav(buf: Buffer): { pcm: Buffer; sampleRate: number; channels: number } | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let sampleRate = 0;
  let channels = 1;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
    }
    if (id === 'data') {
      // Streamed WAVs (espeak --stdout) may carry a 0xFFFFFFFF size.
      if (size === 0xffffffff || off + 8 + size > buf.length) size = buf.length - off - 8;
      return { pcm: buf.subarray(off + 8, off + 8 + size), sampleRate, channels };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Linear resample of 16-bit mono PCM. Good enough for a demo voice. */
export function resamplePcm16(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to || !from) return pcm;
  const n = pcm.length >> 1;
  const outN = Math.floor((n * to) / from);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = (i * from) / to;
    const k = Math.floor(pos);
    const f = pos - k;
    const a = pcm.readInt16LE(Math.min(n - 1, k) * 2);
    const b = pcm.readInt16LE(Math.min(n - 1, k + 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * f), i * 2);
  }
  return out;
}

let espeak: string | null | undefined;
function espeakPath(): string | null {
  if (espeak !== undefined) return espeak;
  try {
    espeak = execFileSync('which', ['espeak-ng'], { encoding: 'utf8' }).trim() || null;
  } catch {
    espeak = null;
  }
  return espeak;
}

/**
 * Demo-tutor voice, offline and free: macOS's built-in `say` (24 kHz 16-bit PCM), or espeak-ng
 * when it is installed (Linux / CI). Without either, the mock falls back to timed silence.
 */
export function makeSynthesizer(voice?: string): Synthesizer {
  if (process.platform === 'darwin') {
    return (text: string) =>
      new Promise((resolve) => {
        const file = join(tmpdir(), `pairwise-say-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
        const args = ['-o', file, '--file-format=WAVE', '--data-format=LEI16@24000', ...(voice ? ['-v', voice] : []), text];
        execFile('say', args, { timeout: 20_000 }, async (err) => {
          if (err) return resolve(null);
          try {
            resolve(wavToPcm(await readFile(file)));
          } catch {
            resolve(null);
          } finally {
            void unlink(file).catch(() => undefined);
          }
        });
      });
  }
  const bin = espeakPath();
  if (!bin) return async () => null;
  return (text: string) =>
    new Promise((resolve) => {
      execFile(bin, ['-v', 'en-us+f3', '-s', '168', '--stdout', text], { encoding: 'buffer', timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        const wav = parseWav(stdout as Buffer);
        resolve(wav ? resamplePcm16(wav.pcm, wav.sampleRate, 24000) : null);
      });
    });
}
