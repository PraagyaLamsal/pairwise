import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { on() {} } }));

import { BeatSync } from '../../src/main/session/beat-sync';
import { SpeechClock, SPEECH_RATE } from '../../src/main/session/speech-clock';
import { arrowTail, buildInk, edgePoint, notePosition, pointTip } from '../../src/main/session/marks';
import { classifyStroke } from '../../src/main/session/stroke-shape';
import { describeStrokes, rms16, trimSilence } from '../../src/main/session/features/ask';

const LINES = ['First we look at the base case.', 'Then the recursive call shrinks n.', 'Finally they multiply back up.'];

/** Feed a transcript one word at a time, ~9000 samples (0.375 s) of audio per word. */
function speakInto(sync: BeatSync, text: string, startWord = 0): number {
  const words = text.split(/\s+/).filter(Boolean);
  words.forEach((w, i) => sync.feed(w, (startWord + i + 1) * 9000));
  return startWord + words.length;
}

function syncWith(lines = LINES) {
  const fired: { beat: number; pos: number }[] = [];
  const sync = new BeatSync(lines.map((text, beat) => ({ text, start: (pos: number) => fired.push({ beat, pos }) })));
  return { sync, fired };
}

describe('BeatSync', () => {
  it('fires each line where its first word was heard (verbatim)', () => {
    const { sync, fired } = syncWith();
    speakInto(sync, LINES.join(' '));
    const lag = Math.round(0.3 * 24000);
    expect(fired).toEqual([
      { beat: 0, pos: 1 * 9000 - lag },
      { beat: 1, pos: 8 * 9000 - lag },
      { beat: 2, pos: 14 * 9000 - lag },
    ]);
    expect(sync.done).toBe(true);
  });

  it('copes with filler words and small changes around the lines', () => {
    const { sync, fired } = syncWith();
    speakInto(sync, "Okay so first we'll look at the base case. Right, um, then the recursive call shrinks n. And finally they all multiply back up.");
    expect(fired.map((f) => f.beat)).toEqual([0, 1, 2]);
    // Line 2 fires at "then" (word 12), not at the start of the turn.
    expect(fired[1].pos).toBeGreaterThan(10 * 9000);
  });

  it('matches a line whose first word was dropped', () => {
    const { sync, fired } = syncWith();
    speakInto(sync, 'We look at the base case.');
    expect(fired.map((f) => f.beat)).toEqual([0]);
  });

  it('does not fire a line before enough of it has been heard', () => {
    const { sync, fired } = syncWith();
    speakInto(sync, 'First we');
    expect(fired).toEqual([]);
  });

  it('falls back to pacing by length when the model paraphrases everything', () => {
    const { sync, fired } = syncWith();
    const n = speakInto(sync, 'so the idea here is that a function can keep calling itself');
    expect(fired.map((f) => f.beat)).toEqual([0]);
    speakInto(sync, 'until it reaches the simplest possible input which stops everything', n);
    expect(fired.map((f) => f.beat)).toEqual([0, 1]);
  });

  it('flushes what is left when the turn ends, and cancel stops it', () => {
    const a = syncWith();
    speakInto(a.sync, 'First we look at the base case.');
    a.sync.flushRemaining(99_000);
    expect(a.fired.map((f) => f.beat)).toEqual([0, 1, 2]);
    expect(a.fired[2].pos).toBe(99_000);
    const b = syncWith();
    b.sync.cancel();
    speakInto(b.sync, LINES.join(' '));
    expect(b.fired).toEqual([]);
  });
});

describe('SpeechClock', () => {
  it('maps audio positions to when they will be heard', () => {
    const c = new SpeechClock();
    c.onAudioSent(SPEECH_RATE * 3); // 3 s of speech received
    const now = 1_000_000;
    c.onPlayback({ playedSamples: SPEECH_RATE, queuedSamples: SPEECH_RATE * 2, playing: true, at: now, epoch: 1, level: 0.2 });
    expect(c.position).toBe(SPEECH_RATE * 3);
    expect(c.timeFor(SPEECH_RATE * 2, now)).toBe(now + 1000);
    expect(c.timeFor(SPEECH_RATE / 2, now)).toBe(now); // already heard
    expect(c.remainingMs(now)).toBe(2000);
    // Extrapolates between playback reports.
    expect(c.playedNow(now + 500)).toBe(SPEECH_RATE * 1.5);
    expect(c.timeFor(SPEECH_RATE * 2, now + 500)).toBe(now + 1000);
  });

  it('respects the playback speed and restarts on flush', () => {
    const c = new SpeechClock();
    c.setRate(2);
    c.onAudioSent(SPEECH_RATE * 4);
    c.onPlayback({ playedSamples: 0, queuedSamples: SPEECH_RATE * 4, playing: true, at: 0, epoch: 1, level: 0 });
    expect(c.timeFor(SPEECH_RATE * 2, 0)).toBe(1000);
    c.onFlush();
    expect(c.position).toBe(0);
    expect(c.remainingMs(10)).toBe(0);
  });

  it('never claims more was played than was received', () => {
    const c = new SpeechClock();
    c.onAudioSent(SPEECH_RATE);
    c.onPlayback({ playedSamples: SPEECH_RATE / 2, queuedSamples: SPEECH_RATE / 2, playing: true, at: 0, epoch: 1, level: 0 });
    expect(c.playedNow(10_000)).toBe(SPEECH_RATE);
  });
});

describe('marks', () => {
  const display = { x: 0, y: 0, width: 1440, height: 900 };
  const target = { x: 600, y: 400, width: 120, height: 40 };

  it('edgePoint lands on the (padded) boundary toward the given point', () => {
    const p = edgePoint(target, { x: 900, y: 420 }, 6);
    expect(p.x).toBeCloseTo(target.x + target.width + 6, 5);
    expect(p.y).toBeCloseTo(420, 5);
    const q = edgePoint(target, { x: 660, y: 100 }, 6);
    expect(q.y).toBeCloseTo(target.y - 6, 5);
  });

  it('arrow tails stay on screen and avoid other marks', () => {
    const t = arrowTail(target, display);
    expect(t.x).toBeGreaterThan(24);
    expect(t.y).toBeGreaterThan(24);
    expect(t.x < target.x || t.x > target.x + target.width || t.y < target.y || t.y > target.y + target.height).toBe(true);
    // Something already where the preferred (up-right) tail would go → pick another direction.
    const preferred = arrowTail(target, display);
    const avoid = [{ x: preferred.x - 60, y: preferred.y - 40, width: 120, height: 80 }];
    const other = arrowTail(target, display, avoid);
    expect(Math.hypot(other.x - preferred.x, other.y - preferred.y)).toBeGreaterThan(50);
    // Corner target: tail still inside the display.
    const corner = arrowTail({ x: 1380, y: 10, width: 50, height: 30 }, display);
    expect(corner.x).toBeLessThan(1440 - 24);
    expect(corner.y).toBeGreaterThan(24);
  });

  it("an arrow's tail keeps clear of Pairwise's own UI (the session pill)", () => {
    const style = { color: '#3380FF', author: 'tutor' as const, surface: 'screen' as const };
    const preferred = arrowTail(target, display);
    const pill = { x: preferred.x - 130, y: preferred.y - 22, width: 260, height: 44 };
    const [arrow] = buildInk([{ kind: 'arrow', rect: target }], display, { ...style, avoid: [pill] });
    const f = arrow.from!;
    expect(f.x > pill.x - 40 && f.x < pill.x + pill.width + 40 && f.y > pill.y - 20 && f.y < pill.y + pill.height + 20).toBe(false);
  });

  it('notes go right of the target, or left when there is no room', () => {
    expect(notePosition(target, 'base case', display).x).toBeGreaterThan(target.x + target.width);
    const edge = { x: 1300, y: 400, width: 120, height: 40 };
    expect(notePosition(edge, 'base case', display).x).toBeLessThan(edge.x);
  });

  it('an arrow with a note becomes arrow then text (written after the arrow)', () => {
    const ink = buildInk([{ kind: 'arrow', rect: target, text: 'look here' }], display, { color: '#3380FF', author: 'tutor', surface: 'screen' });
    expect(ink.map((i) => i.kind)).toEqual(['arrow', 'text']);
    expect(ink[0].drawMs).toBeGreaterThan(0);
    // The arrow head ends just outside the target, pointing at it.
    const to = ink[0].to!;
    expect(to.x >= target.x - 8 && to.x <= target.x + target.width + 8 && to.y >= target.y - 8 && to.y <= target.y + target.height + 8).toBe(true);
  });

  it('points near the start of wide targets and at the centre of small ones', () => {
    expect(pointTip({ x: 0, y: 0, width: 60, height: 20 })).toEqual({ x: 30, y: 10 });
    expect(pointTip({ x: 0, y: 0, width: 400, height: 20 })).toEqual({ x: 60, y: 10 });
  });
});

describe('student marks', () => {
  const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 48) => Array.from({ length: n + 4 }, (_, i) => ({ x: cx + Math.cos((i / n) * Math.PI * 2) * rx, y: cy + Math.sin((i / n) * Math.PI * 2) * ry }));
  it('classifies circles, underlines and arrows-ish lines', () => {
    expect(classifyStroke(ellipse(300, 200, 80, 30)).shape).toBe('circle');
    expect(classifyStroke(Array.from({ length: 30 }, (_, i) => ({ x: 100 + i * 8, y: 300 + Math.sin(i) * 2 }))).shape).toBe('underline');
    expect(classifyStroke([{ x: 10, y: 10 }, { x: 12, y: 11 }]).shape).toBe('dot');
  });

  it('describes marks with their box in the frame the tutor sees', () => {
    const ref = { region: { x: 0, y: 0, width: 1000, height: 500 } };
    const d = describeStrokes([{ id: 's', points: ellipse(300, 200, 80, 30), times: [], straight: false, displayId: 'd1', surface: 'screen' }] as never, ref as never);
    expect(d.text).toMatch(/^circled the area at box \[\d+, \d+, \d+, \d+\]$/);
    const [ymin, xmin, ymax, xmax] = /\[(.*)\]/.exec(d.text)![1].split(', ').map(Number);
    expect(xmin).toBeCloseTo(220, -1);
    expect(xmax).toBeCloseTo(380, -1);
    expect(ymin).toBeCloseTo(340, -1);
    expect(ymax).toBeCloseTo(460, -1);
  });
});

describe('buffered question audio', () => {
  const chunk = (amp: number) => {
    const b = new Uint8Array(1280);
    const v = new DataView(b.buffer);
    for (let i = 0; i < 640; i++) v.setInt16(i * 2, Math.round(Math.sin(i / 3) * amp * 32767), true);
    return { pcm: b, rms: rms16(b) };
  };
  it('rms16 measures level', () => {
    expect(chunk(0).rms).toBe(0);
    expect(chunk(0.5).rms).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });
  it('drops long silences but keeps speech with a little padding', () => {
    const chunks = [...Array(30)].map(() => chunk(0.001)).concat([...Array(10)].map(() => chunk(0.3)), [...Array(40)].map(() => chunk(0.001)), [...Array(8)].map(() => chunk(0.3)), [...Array(20)].map(() => chunk(0.001)));
    const { kept, voiced } = trimSilence(chunks);
    expect(voiced).toBe(2);
    // 18 voiced chunks + ≤ 8 before + ≤ 4 after each run.
    expect(kept.length).toBeGreaterThanOrEqual(18);
    expect(kept.length).toBeLessThanOrEqual(18 + 2 * 12);
  });
  it('reports no speech for a silent hold', () => {
    expect(trimSilence([...Array(50)].map(() => chunk(0.002))).voiced).toBe(0);
  });
});
