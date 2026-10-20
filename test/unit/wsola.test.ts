import { describe, expect, it } from 'vitest';
import { Wsola, floatToPcm16, pcm16ToFloat } from '@shared/wsola';

const SR = 24000;

function sine(freq: number, secs: number): Float32Array {
  const n = Math.round(SR * secs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function stretch(input: Float32Array, rate: number): Float32Array {
  const w = new Wsola();
  w.rate = rate;
  // feed in 40 ms chunks like the network does
  for (let i = 0; i < input.length; i += 960) w.push(input.subarray(i, Math.min(input.length, i + 960)));
  w.drain();
  const out = new Float32Array(w.available);
  w.pull(out.length, out);
  return out;
}

function zeroCrossingHz(x: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  return crossings / ((to - from) / SR);
}

describe('WSOLA time-stretch', () => {
  it('speeds up without changing pitch', () => {
    const out = stretch(sine(220, 2), 1.25);
    expect(out.length / SR).toBeGreaterThan(1.5);
    expect(out.length / SR).toBeLessThan(1.75);
    const hz = zeroCrossingHz(out, SR * 0.2, SR * 1.4);
    expect(hz).toBeGreaterThan(212);
    expect(hz).toBeLessThan(228);
  });

  it('slows down without changing pitch', () => {
    const out = stretch(sine(330, 1), 0.8);
    expect(out.length / SR).toBeGreaterThan(1.17);
    expect(out.length / SR).toBeLessThan(1.33);
    const hz = zeroCrossingHz(out, SR * 0.1, SR * 1.1);
    expect(Math.abs(hz - 330)).toBeLessThan(10);
  });

  it('rate 1 reconstructs the signal (window sums to one)', () => {
    const input = sine(440, 0.5);
    const out = stretch(input, 1);
    // compare away from the edges
    let maxErr = 0;
    for (let i = 2000; i < 10000; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - input[i]));
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('round-trips PCM16 conversion', () => {
    const f = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const back = pcm16ToFloat(floatToPcm16(f));
    for (let i = 0; i < f.length; i++) expect(back[i]).toBeCloseTo(f[i], 3);
  });
});
