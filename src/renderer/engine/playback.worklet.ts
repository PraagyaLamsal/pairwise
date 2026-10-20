/// <reference lib="webworker" />
// Gapless playback of the tutor's 24 kHz PCM: optional pitch-preserving speed change (WSOLA),
// resampling to the device rate, instant flush on interruption, smooth ducking, and position
// reports so drawings can be revealed in sync with the words.
import { Wsola } from '../../shared/wsola';

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const SRC_RATE = 24000;

class PlaybackProcessor extends AudioWorkletProcessor {
  private wsola = new Wsola(512, 96);
  private queue: Float32Array[] = []; // passthrough queue when rate == 1
  private queueOffset = 0;
  private rate = 1;
  private step = SRC_RATE / sampleRate; // source samples per output sample
  private srcPos = 0; // fractional read position into the source stream (relative to buffered)
  private cur = 0;
  private next = 0;
  private haveSamples = false;
  private gain = 1;
  private targetGain = 1;
  private received = 0; // source samples received since flush
  private played = 0; // source samples played since flush (speech-time, independent of rate)
  private lastInputAt = 0;
  private playing = false;
  private lastReport = 0;
  private epoch = 0;
  private levelAcc = 0;
  private levelN = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; samples?: Float32Array; rate?: number; level?: number; epoch?: number };
      if (m.type === 'push' && m.samples) {
        this.received += m.samples.length;
        this.lastInputAt = currentTime;
        if (this.rate === 1) this.queue.push(m.samples);
        else this.wsola.push(m.samples);
      } else if (m.type === 'flush') {
        this.queue = [];
        this.queueOffset = 0;
        this.blockLen = 0;
        this.blockIdx = 0;
        this.wsola.reset();
        this.received = 0;
        this.played = 0;
        this.haveSamples = false;
        this.epoch = m.epoch ?? this.epoch + 1;
        this.report(true);
      } else if (m.type === 'rate' && m.rate) {
        const next = Math.min(1.5, Math.max(0.7, m.rate));
        if (next !== 1 && this.rate === 1) {
          // move anything queued for passthrough into the stretcher, keeping order
          for (let i = 0; i < this.queue.length; i++) this.wsola.push(i === 0 ? this.queue[i].subarray(this.queueOffset) : this.queue[i]);
          this.queue = [];
          this.queueOffset = 0;
        }
        this.rate = next;
        this.wsola.rate = next;
      } else if (m.type === 'gain' && m.level !== undefined) {
        this.targetGain = m.level;
      }
    };
  }

  private block = new Float32Array(512);
  private blockLen = 0;
  private blockIdx = 0;

  private nextSource(): number | null {
    if (this.blockIdx < this.blockLen) return this.block[this.blockIdx++];
    this.blockIdx = 0;
    this.blockLen = 0;
    if (this.rate === 1 && this.wsola.available === 0) {
      while (this.queue.length && this.blockLen < this.block.length) {
        const head = this.queue[0];
        const take = Math.min(head.length - this.queueOffset, this.block.length - this.blockLen);
        this.block.set(head.subarray(this.queueOffset, this.queueOffset + take), this.blockLen);
        this.blockLen += take;
        this.queueOffset += take;
        if (this.queueOffset >= head.length) {
          this.queue.shift();
          this.queueOffset = 0;
        }
      }
    } else {
      if (this.wsola.available === 0 && this.wsola.pendingInput > 0 && currentTime - this.lastInputAt > 0.12) this.wsola.drain();
      this.blockLen = this.wsola.pull(this.block.length, this.block);
    }
    return this.blockIdx < this.blockLen ? this.block[this.blockIdx++] : null;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const left = out[0];
    let produced = 0;
    for (let i = 0; i < left.length; i++) {
      // advance the source cursor; fetch new source samples as needed
      while (this.srcPos >= 1 || !this.haveSamples) {
        const s = this.nextSource();
        if (s === null) break;
        if (!this.haveSamples) {
          this.cur = s;
          this.next = s;
          this.haveSamples = true;
          this.srcPos = 0;
        } else {
          this.cur = this.next;
          this.next = s;
          this.srcPos -= 1;
          this.played += this.rate;
        }
      }
      let v = 0;
      if (this.haveSamples && this.srcPos < 1) {
        v = this.cur + (this.next - this.cur) * this.srcPos;
        this.srcPos += this.step;
        produced++;
      } else if (this.haveSamples) {
        // underrun: hold silence until more arrives
        this.haveSamples = false;
      }
      this.gain += (this.targetGain - this.gain) * 0.004;
      v *= this.gain;
      left[i] = v;
      this.levelAcc += v * v;
      this.levelN++;
    }
    for (let c = 1; c < out.length; c++) out[c].set(left);
    const nowPlaying = produced > 0;
    if (nowPlaying !== this.playing) {
      this.playing = nowPlaying;
      this.report(true);
    } else if (currentTime - this.lastReport > 0.04) this.report(false);
    return true;
  }

  private report(force: boolean): void {
    if (!force && !this.playing) return;
    this.lastReport = currentTime;
    const level = this.levelN ? Math.sqrt(this.levelAcc / this.levelN) : 0;
    this.levelAcc = 0;
    this.levelN = 0;
    this.port.postMessage({ played: Math.round(this.played), received: this.received, playing: this.playing, epoch: this.epoch, level });
  }
}

registerProcessor('pw-playback', PlaybackProcessor);
