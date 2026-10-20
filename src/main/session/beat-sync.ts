/**
 * Reveals each line's marks as the tutor actually says that line.
 *
 * explain_on_screen hands the Live model a short script; the model speaks it (usually close to
 * verbatim, sometimes with a few words of its own around it). We follow the model's output
 * transcription word by word, find where each line starts, and fire that beat at the audio
 * position where its first words were heard. When the model paraphrases and no line start can
 * be matched, beats fall back to firing by how much of the script has been spoken.
 */

export interface Beat {
  text: string;
  /** Fired once, with the audio position (24 kHz samples since flush) where the line starts. */
  start: (position: number) => void;
}

const normWords = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Transcript words trail the audio slightly; aim a little earlier (samples). */
const LAG = Math.round(0.3 * 24000);

export class BeatSync {
  private heard: { w: string; pos: number }[] = [];
  private next = 0;
  private searchFrom = 0;
  private readonly lens: number[];
  private readonly keys: string[][];
  private readonly createdAt = Date.now();
  private lastHeardAt = Date.now();
  private finished = false;

  constructor(private readonly beats: Beat[]) {
    this.keys = beats.map((b) => normWords(b.text).slice(0, 4));
    this.lens = beats.map((b) => normWords(b.text).length);
  }

  get done(): boolean {
    return this.finished || this.next >= this.beats.length;
  }

  /** Remaining beats that haven't fired. */
  get pending(): number {
    return Math.max(0, this.beats.length - this.next);
  }

  /** A chunk of the tutor's output transcript arrived; `position` = audio received so far. */
  feed(chunk: string, position: number): void {
    if (this.done) return;
    const words = normWords(chunk);
    if (!words.length) return;
    this.lastHeardAt = Date.now();
    // Spread the chunk's words over the audio that came with it (≈ 2.6 words/s → ~9k samples/word).
    const span = Math.min(words.length * 9000, position);
    words.forEach((w, i) => this.heard.push({ w, pos: Math.max(0, position - span + ((i + 1) / words.length) * span - LAG) }));
    this.advance(position);
  }

  private advance(position: number): void {
    while (!this.done) {
      const k = this.next;
      const key = this.keys[k];
      const idx = this.findKey(key);
      if (idx >= 0) {
        this.fire(this.heard[idx].pos);
        this.searchFrom = idx + Math.max(1, key.length - 1);
        continue;
      }
      // Fallback: the model is past where this line should have started.
      const spokenSinceStart = this.heard.length - (k === 0 ? 0 : this.searchFrom);
      const expected = k === 0 ? 10 : Math.max(4, Math.round(this.lens[k - 1] * 1.25));
      if (spokenSinceStart >= expected && this.heard.length) {
        this.fire(Math.max(0, position - LAG));
        this.searchFrom = this.heard.length;
        continue;
      }
      break;
    }
  }

  /**
   * Index of the heard word where this line starts: the line's first (or second) word, followed
   * by most of its next words in order, allowing one dropped/extra word between them.
   * Returns -1 when there is no match yet (including "not enough words heard to tell").
   */
  private findKey(key: string[]): number {
    if (!key.length) return -1;
    const need = key.length <= 2 ? key.length : Math.ceil(key.length * 0.75);
    for (let i = this.searchFrom; i < this.heard.length; i++) {
      const w = this.heard[i].w;
      if (w !== key[0] && w !== key[1]) continue;
      const skippedFirst = w !== key[0];
      let hits = skippedFirst ? 1 : 0; // a dropped first word still counts toward the line
      let j = i;
      for (let k = skippedFirst ? 1 : 0; k < key.length; k++) {
        if (j >= this.heard.length) return -1; // wait for more words
        let found = -1;
        for (let d = 0; d < 2 && j + d < this.heard.length; d++) {
          if (this.heard[j + d].w === key[k]) {
            found = j + d;
            break;
          }
        }
        if (found >= 0) {
          hits++;
          j = found + 1;
        }
      }
      if (hits >= need) return i;
    }
    return -1;
  }

  private fire(pos: number): void {
    const beat = this.beats[this.next];
    this.next += 1;
    try {
      beat.start(pos);
    } catch {
      /* a failing beat must not stop the others */
    }
  }

  /** The model never got to (the rest of) the script. */
  expired(now = Date.now()): boolean {
    if (this.done) return false;
    const idle = now - this.lastHeardAt;
    return (this.heard.length === 0 && now - this.createdAt > 30_000) || (this.heard.length > 0 && idle > 12_000);
  }

  /** Fire whatever is left (the turn ended before the transcript matched). */
  flushRemaining(position: number): void {
    while (!this.done) this.fire(position);
  }

  cancel(): void {
    this.finished = true;
  }
}
