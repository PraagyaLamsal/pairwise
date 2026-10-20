// Audio fixtures for the e2e tests: a "student" WAV for Chromium's fake microphone and raw
// 16 kHz PCM speech to inject straight into the Live link.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './harness.mjs';

const dir = join(root, 'test', 'artifacts', 'audio');
mkdirSync(dir, { recursive: true });

function hasEspeak() {
  try {
    execFileSync('which', ['espeak-ng'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function readPcm(file) {
  const b = readFileSync(file);
  let off = 12;
  let rate = 22050;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    let size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12);
    if (id === 'data') {
      if (size === 0xffffffff || off + 8 + size > b.length) size = b.length - off - 8;
      const n = size >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return { samples: out, rate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('bad wav');
}

function resample(samples, from, to) {
  const outN = Math.floor((samples.length * to) / from);
  const out = new Float32Array(outN);
  for (let i = 0; i < outN; i++) {
    const p = (i * from) / to;
    const k = Math.floor(p);
    const f = p - k;
    out[i] = (samples[k] ?? 0) + ((samples[k + 1] ?? 0) - (samples[k] ?? 0)) * f;
  }
  return out;
}

/** Speech (espeak) or a speech-like noise burst, as Float32 at `rate`. */
export function speechSamples(text, rate = 16000) {
  if (hasEspeak()) {
    const f = join(dir, `say-${Buffer.from(text).toString('hex').slice(0, 24)}.wav`);
    if (!existsSync(f)) execFileSync('espeak-ng', ['-v', 'en-us', '-s', '165', '-w', f, text]);
    const { samples, rate: r } = readPcm(f);
    return resample(samples, r, rate);
  }
  const n = Math.round(rate * 1.6);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(i / 3.1) * 0.25 * (0.6 + Math.random() * 0.4) * (0.5 + 0.5 * Math.sin((i / rate) * 9));
  return out;
}

/** WAV for --use-file-for-fake-audio-capture: lead-in silence, a question, then a long pause (loops). */
export function studentMicWav(text = 'Why does my recursive function never stop?', leadSec = 2.5, tailSec = 12) {
  const rate = 48000;
  const speech = speechSamples(text, rate);
  const all = new Float32Array(Math.round(leadSec * rate) + speech.length + Math.round(tailSec * rate));
  all.set(speech, Math.round(leadSec * rate));
  const file = join(dir, 'student-mic.wav');
  writeFileSync(file, wav(all, rate));
  return { file, speechStartSec: leadSec, speechSec: speech.length / rate, loopSec: all.length / rate };
}

/** Raw 16 kHz little-endian PCM16 (base64) of `text` followed by silence — injected via main. */
export function speechPcmBase64(text, silenceSec = 1.2) {
  const s = speechSamples(text, 16000);
  const all = new Float32Array(s.length + Math.round(16000 * silenceSec));
  all.set(s, 0);
  const buf = Buffer.alloc(all.length * 2);
  all.forEach((v, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  return buf.toString('base64');
}
