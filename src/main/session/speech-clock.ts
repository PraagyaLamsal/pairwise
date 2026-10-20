import type { PlaybackStatus } from '@shared/ipc';

export const SPEECH_RATE = 24000;

/**
 * Maps positions in the tutor's audio stream to wall-clock time, so a drawing requested while the
 * tutor says "…this line here…" is revealed when the speaker actually reaches those words.
 *
 * Positions are counted in 24 kHz source samples *sent to the engine since the last flush*, the
 * same counter the playback worklet reports as `playedSamples`.
 */
export class SpeechClock {
  private sent = 0;
  private status: PlaybackStatus = { playedSamples: 0, queuedSamples: 0, playing: false, at: 0, epoch: 0, level: 0 };
  private rate = 1;

  /** Called for every audio chunk handed to the engine. */
  onAudioSent(samples: number): void {
    this.sent += samples;
  }

  /** The engine flushed its buffer (interruption, replay): positions restart at zero. */
  onFlush(): void {
    this.sent = 0;
    this.status = { ...this.status, playedSamples: 0, queuedSamples: 0, playing: false, at: Date.now() };
  }

  onPlayback(p: PlaybackStatus): void {
    this.status = p;
  }

  setRate(rate: number): void {
    this.rate = rate > 0 ? rate : 1;
  }

  /** Position of the newest audio received so far — "where the tutor's speech is up to". */
  get position(): number {
    return this.sent;
  }

  /** Samples actually played, extrapolated from the last report while playing. */
  playedNow(now = Date.now()): number {
    const s = this.status;
    if (!s.playing) return Math.min(s.playedSamples, this.sent);
    const extra = ((now - s.at) / 1000) * SPEECH_RATE * this.rate;
    return Math.min(this.sent, s.playedSamples + Math.max(0, extra));
  }

  /** Wall-clock ms at which audio position `pos` will be heard (now, if it already was). */
  timeFor(pos: number, now = Date.now()): number {
    const played = this.playedNow(now);
    if (pos <= played) return now;
    return now + ((pos - played) / SPEECH_RATE / this.rate) * 1000;
  }

  /** Audio still to be played, in ms. */
  remainingMs(now = Date.now()): number {
    return Math.max(0, ((this.sent - this.playedNow(now)) / SPEECH_RATE / this.rate) * 1000);
  }
}
