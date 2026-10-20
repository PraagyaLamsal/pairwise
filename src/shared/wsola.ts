/**
 * Streaming WSOLA time-stretcher (Waveform Similarity Overlap-Add). Changes speaking speed
 * without changing pitch — used for the "speaking speed" setting on the tutor's voice.
 * Pure TypeScript so it runs inside an AudioWorklet and in unit tests.
 */
export class Wsola {
  readonly frame: number;
  readonly hop: number;
  readonly search: number;
  private readonly window: Float32Array;
  private input = new Float32Array(16384);
  private inStart = 0; // absolute index of input[0]
  private inLen = 0;
  private acc: Float32Array;
  private posIn = 0; // absolute nominal input position of the next frame
  private prevSel = -1;
  private out: Float32Array[] = [];
  private outOffset = 0;
  rate = 1;

  constructor(frame = 512, search = 128) {
    this.frame = frame;
    this.hop = frame / 2;
    this.search = search;
    this.window = new Float32Array(frame);
    for (let i = 0; i < frame; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
    this.acc = new Float32Array(frame);
  }

  reset(): void {
    this.inStart = 0;
    this.inLen = 0;
    this.acc.fill(0);
    this.posIn = 0;
    this.prevSel = -1;
    this.out = [];
    this.outOffset = 0;
  }

  /** Samples of output ready to pull. */
  get available(): number {
    let n = -this.outOffset;
    for (const b of this.out) n += b.length;
    return n;
  }

  /** Input samples buffered but not yet turned into output. */
  get pendingInput(): number {
    return Math.max(0, this.inStart + this.inLen - Math.floor(this.posIn));
  }

  push(samples: Float32Array): void {
    if (this.inLen + samples.length > this.input.length) {
      const bigger = new Float32Array(Math.max(this.input.length * 2, this.inLen + samples.length + 4096));
      bigger.set(this.input.subarray(0, this.inLen));
      this.input = bigger;
    }
    this.input.set(samples, this.inLen);
    this.inLen += samples.length;
    this.process();
  }

  /** Pads with silence so the last partial frame is emitted (end of an utterance). */
  drain(): void {
    if (this.pendingInput <= 0) return;
    this.push(new Float32Array(this.frame + this.search * 2));
  }

  pull(n: number, dest: Float32Array, destOffset = 0): number {
    let written = 0;
    while (written < n && this.out.length) {
      const head = this.out[0];
      const take = Math.min(n - written, head.length - this.outOffset);
      dest.set(head.subarray(this.outOffset, this.outOffset + take), destOffset + written);
      written += take;
      this.outOffset += take;
      if (this.outOffset >= head.length) {
        this.out.shift();
        this.outOffset = 0;
      }
    }
    return written;
  }

  private at(abs: number): number {
    const i = abs - this.inStart;
    return i >= 0 && i < this.inLen ? this.input[i] : 0;
  }

  private process(): void {
    const { frame, hop, search } = this;
    const end = this.inStart + this.inLen;
    while (Math.floor(this.posIn) + frame + search <= end) {
      const nominal = Math.floor(this.posIn);
      let best = nominal;
      if (this.prevSel >= 0 && this.rate !== 1) {
        const target = this.prevSel + hop;
        let bestScore = -Infinity;
        const lo = Math.max(this.inStart, nominal - search);
        const hi = nominal + search;
        for (let c = lo; c <= hi; c += 2) {
          let s = 0;
          for (let i = 0; i < hop; i += 2) s += this.at(c + i) * this.at(target + i);
          if (s > bestScore) {
            bestScore = s;
            best = c;
          }
        }
      }
      for (let i = 0; i < frame; i++) this.acc[i] += this.at(best + i) * this.window[i];
      this.out.push(this.acc.slice(0, hop));
      this.acc.copyWithin(0, hop);
      this.acc.fill(0, frame - hop);
      this.prevSel = best;
      this.posIn += hop * this.rate;
      // drop consumed input
      const keepFrom = Math.min(this.prevSel, Math.floor(this.posIn)) - search - 1;
      const drop = keepFrom - this.inStart;
      if (drop > 4096) {
        this.input.copyWithin(0, drop, this.inLen);
        this.inLen -= drop;
        this.inStart += drop;
      }
    }
  }
}

/** Int16 PCM (little-endian bytes) → Float32 samples in [-1, 1]. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const n = bytes.byteLength >> 1;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Float32 samples → Int16 PCM little-endian bytes. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}
