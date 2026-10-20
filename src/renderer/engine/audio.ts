import captureWorkletUrl from './capture.worklet.ts?worker&url';
import playbackWorkletUrl from './playback.worklet.ts?worker&url';
import { pcm16ToFloat } from '@shared/wsola';
import { ipc } from '../ui/ipc';

const log = (level: 'info' | 'warn' | 'error', message: string) => ipc.send('engine:log', { level, message });

/**
 * Microphone in (echo-cancelled, 16 kHz chunks to main) and tutor voice out (24 kHz PCM through
 * the playback worklet). Also: local voice-activity detection for snappy barge-in, mic level
 * for the UI, "say that again" replay and soft chimes.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private playbackNode: AudioWorkletNode | null = null;
  private outGain: GainNode | null = null;
  private muted = false;
  private gateOpen = true;
  private seq = 0;
  // VAD
  private noiseFloor = 0.004;
  private above = 0;
  private below = 0;
  private speaking = false;
  private playing = false;
  private lastLevelSent = 0;
  private duckTimer: number | null = null;
  // replay
  private turnId = '';
  private turnAudio: Float32Array[] = [];
  private lastTurnAudio: Float32Array[] = [];
  private epoch = 0;
  private rate = 1;

  async start(echoCancellation: boolean, playbackRate: number): Promise<void> {
    if (this.ctx) return;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(captureWorkletUrl);
    await this.ctx.audioWorklet.addModule(playbackWorkletUrl);

    // Output path first, so the tutor can talk even if the mic is unavailable.
    this.outGain = this.ctx.createGain();
    this.outGain.connect(this.ctx.destination);
    this.playbackNode = new AudioWorkletNode(this.ctx, 'pw-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.playbackNode.connect(this.outGain);
    this.playbackNode.port.onmessage = (e) => this.onPlayback(e.data);
    this.setRate(playbackRate);

    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      const src = this.ctx.createMediaStreamSource(this.mic);
      this.captureNode = new AudioWorkletNode(this.ctx, 'pw-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
      src.connect(this.captureNode);
      this.captureNode.port.onmessage = (e) => this.onMicChunk(e.data as { pcm: ArrayBuffer; rms: number });
      log('info', `audio started (${this.ctx.sampleRate} Hz, AEC ${echoCancellation ? 'on' : 'off'})`);
    } catch (e) {
      log('error', `microphone unavailable: ${(e as Error).message}`);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  stop(): void {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    void this.ctx?.close();
    this.ctx = null;
    this.captureNode = null;
    this.playbackNode = null;
    this.speaking = false;
    this.playing = false;
  }

  setMuted(m: boolean): void {
    this.muted = m;
  }

  /** Push-to-talk gate: audio only flows while open. */
  setGate(open: boolean): void {
    this.gateOpen = open;
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.playbackNode?.port.postMessage({ type: 'rate', rate });
  }

  play(pcm: Uint8Array, turnId: string): void {
    if (!this.playbackNode) return;
    if (turnId !== this.turnId) {
      if (this.turnAudio.length) this.lastTurnAudio = this.turnAudio;
      this.turnAudio = [];
      this.turnId = turnId;
    }
    const samples = pcm16ToFloat(pcm);
    this.turnAudio.push(samples);
    const copy = samples.slice();
    this.playbackNode.port.postMessage({ type: 'push', samples: copy }, [copy.buffer]);
  }

  flush(): void {
    this.epoch += 1;
    this.playbackNode?.port.postMessage({ type: 'flush', epoch: this.epoch });
    this.duck(1);
  }

  /** Replays the previous (or current, if finished) tutor turn locally — no API cost. */
  replay(): boolean {
    const audio = this.turnAudio.length ? this.turnAudio : this.lastTurnAudio;
    if (!audio.length || !this.playbackNode) return false;
    this.flush();
    for (const s of audio) {
      const copy = s.slice();
      this.playbackNode.port.postMessage({ type: 'push', samples: copy }, [copy.buffer]);
    }
    return true;
  }

  duck(level: number): void {
    this.playbackNode?.port.postMessage({ type: 'gain', level });
  }

  chime(kind: 'start' | 'end' | 'celebrate' | 'grant' | 'reclaim' | 'error'): void {
    const ctx = this.ctx;
    if (!ctx || !this.outGain) return;
    const notes: Record<string, [number, number][]> = {
      start: [[660, 0], [990, 0.09]],
      end: [[880, 0], [587, 0.1]],
      celebrate: [[784, 0], [988, 0.07], [1319, 0.14]],
      grant: [[523, 0], [784, 0.08]],
      reclaim: [[784, 0], [523, 0.08]],
      error: [[330, 0], [262, 0.12]],
    };
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, at] of notes[kind]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(0.08, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.32);
      o.connect(g).connect(this.outGain);
      o.start(t0 + at);
      o.stop(t0 + at + 0.35);
    }
  }

  private onMicChunk(m: { pcm: ArrayBuffer; rms: number }): void {
    const rms = m.rms;
    // adaptive noise floor
    if (rms < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.9 + rms * 0.1;
    else this.noiseFloor = this.noiseFloor * 0.998 + rms * 0.002;
    const threshold = this.playing ? Math.max(0.035, this.noiseFloor * 4.5) : Math.max(0.012, this.noiseFloor * 3);
    if (rms > threshold) {
      this.above += 1;
      this.below = 0;
    } else {
      this.below += 1;
      this.above = 0;
    }
    const live = !this.muted && this.gateOpen;
    if (!this.speaking && this.above >= 3 && live) this.setSpeaking(true);
    else if (this.speaking && (this.below >= 15 || !live)) this.setSpeaking(false);

    const now = performance.now();
    if (now - this.lastLevelSent > 50) {
      this.lastLevelSent = now;
      const level = live ? Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-5)) + 58) / 46)) : 0;
      ipc.send('engine:micLevel', { level, speaking: this.speaking });
    }
    if (!live) return;
    this.seq += 1;
    ipc.send('engine:audio', { pcm: new Uint8Array(m.pcm), seq: this.seq });
  }

  private setSpeaking(s: boolean): void {
    this.speaking = s;
    ipc.send('engine:vad', { speaking: s, at: Date.now() });
    // Optimistic barge-in: duck the tutor immediately; main confirms with a flush or restores.
    if (s && this.playing) {
      this.duck(0.22);
      if (this.duckTimer) window.clearTimeout(this.duckTimer);
      this.duckTimer = window.setTimeout(() => this.duck(1), 1200);
    }
  }

  private onPlayback(d: { played: number; received: number; playing: boolean; epoch: number; level: number }): void {
    this.playing = d.playing;
    ipc.send('engine:playback', { playedSamples: d.played, queuedSamples: d.received, playing: d.playing, at: Date.now(), epoch: d.epoch, level: d.level });
  }

  get currentRate(): number {
    return this.rate;
  }
}
