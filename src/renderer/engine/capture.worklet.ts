/// <reference lib="webworker" />
// Microphone capture: downsample whatever the device rate is to 16 kHz mono Int16 and post
// 40 ms chunks (640 samples) with their RMS level.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const OUT_RATE = 16000;
const CHUNK = 640;

class CaptureProcessor extends AudioWorkletProcessor {
  private ratio = sampleRate / OUT_RATE;
  private pos = 0; // fractional position in the input stream for the next output sample
  private prev = 0; // last input sample (for interpolation across blocks)
  private lp = 0; // one-pole low-pass state (anti-alias)
  private alpha: number;
  private buf = new Int16Array(CHUNK);
  private n = 0;
  private sumSq = 0;

  constructor() {
    super();
    // cutoff ≈ 7 kHz
    const rc = 1 / (2 * Math.PI * 7000);
    const dt = 1 / sampleRate;
    this.alpha = dt / (rc + dt);
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    // low-pass in place into a temp array
    const filtered = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      this.lp += this.alpha * (ch[i] - this.lp);
      filtered[i] = this.lp;
    }
    // resample: output sample k sits at input position pos + k*ratio (relative to block start)
    while (this.pos < filtered.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : filtered[i - 1];
      const b = filtered[i];
      const v = a + (b - a) * frac;
      const s = Math.max(-1, Math.min(1, v));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSq += s * s;
      if (this.n === CHUNK) {
        const rms = Math.sqrt(this.sumSq / CHUNK);
        this.port.postMessage({ pcm: this.buf.buffer, rms }, [this.buf.buffer]);
        this.buf = new Int16Array(CHUNK);
        this.n = 0;
        this.sumSq = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= filtered.length;
    this.prev = filtered[filtered.length - 1];
    return true;
  }
}

registerProcessor('pw-capture', CaptureProcessor);
