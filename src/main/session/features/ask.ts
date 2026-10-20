import { ipcMain } from 'electron';
import { displayForPoint, globalToBox2d, inflateRect, unionRects, type DisplayInfo, type FrameRef, type Rect } from '@shared/geometry';
import { inkId, type InkItem } from '@shared/ink';
import type { StudentStroke } from '@shared/ipc';
import type { TutorSession } from '../tutor';
import { classifyStroke, describeShape } from '../stroke-shape';
import { logger } from '../../log';

const log = logger('ask');

interface Chunk {
  pcm: Uint8Array;
  rms: number;
}

interface AskState {
  via: 'hold' | 'toggle';
  startedAt: number;
  strokes: StudentStroke[];
  audio: Chunk[];
  inkIds: string[];
  group: string;
}

export function rms16(pcm: Uint8Array): number {
  const n = pcm.byteLength >> 1;
  if (!n) return 0;
  const v = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = v.getInt16(i * 2, true) / 32768;
    s += x * x;
  }
  return Math.sqrt(s / n);
}

/**
 * Keep the speech of a buffered question and drop long silences (so a pause mid-question can't
 * make the server's VAD end the turn early when the audio is sent in a burst).
 * Chunks are 40 ms; keeps 160 ms before and 320 ms after each voiced chunk.
 */
export function trimSilence(chunks: Chunk[]): { kept: Chunk[]; voiced: number } {
  if (!chunks.length) return { kept: [], voiced: 0 };
  const sorted = chunks.map((c) => c.rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const threshold = Math.max(0.012, floor * 3);
  const voiced = chunks.map((c) => c.rms > threshold);
  // A real utterance has a few voiced chunks in a row.
  let runs = 0;
  let run = 0;
  for (const v of voiced) {
    run = v ? run + 1 : 0;
    if (run === 3) runs++;
  }
  const keep = chunks.map((_, i) => {
    for (let k = Math.max(0, i - 8); k <= Math.min(chunks.length - 1, i + 4); k++) if (voiced[k]) return true;
    return false;
  });
  return { kept: chunks.filter((_, i) => keep[i]), voiced: runs };
}

/**
 * Hold-to-ask (and draw mode): while the ask chord is held — or draw mode is toggled on — the
 * overlays accept drawing and the microphone is buffered. On release, the full-detail frame with
 * the student's marks composited in, a description of the marks (with a zoomed crop) and what
 * they said go to the tutor together, as one question.
 */
export class AskFeature {
  private active: AskState | null = null;
  private seq = 0;
  /** Words describing the last question's marks (explain_on_screen uses it). */
  lastDescription: string | null = null;
  private lateUntil = 0;
  private lateGroup = '';
  private fadeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly s: TutorSession) {
    ipcMain.on('overlay:stroke', (_e, st: StudentStroke) => this.onStroke(st));
    ipcMain.on('overlay:drawCommit', () => void (this.active && s.onAskEnd(false)));
    ipcMain.on('overlay:drawCancel', () => void (this.active && s.onAskEnd(true)));
    s.deps.hotkeys.on('enter', () => void (this.active?.via === 'toggle' && s.onAskEnd(false)));
    s.deps.hotkeys.on('escape', () => void (this.active && s.onAskEnd(true)));
    s.on('turnComplete', () => this.fadeStudentInkSoon(1500));
    s.on('ended', () => {
      this.active = null;
      s.audioSink = null;
    });
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  begin(via: 'hold' | 'toggle'): void {
    if (this.active) return;
    this.seq += 1;
    this.active = { via, startedAt: Date.now(), strokes: [], audio: [], inkIds: [], group: `ask-${this.seq}` };
    this.s.audioSink = (pcm) => {
      if (!this.active) return false;
      this.active.audio.push({ pcm, rms: rms16(pcm) });
      return true;
    };
    // A new question replaces the student's previous marks.
    this.s.ink.fade({ author: 'student' });
    this.setDrawMode(true, via);
  }

  private setDrawMode(on: boolean, via: 'hold' | 'toggle' | null): void {
    const color = this.s.settings.studentInkColor;
    this.s.overlays.setInteractive('all', on);
    this.s.overlays.send('overlay:drawMode', { active: on, via: on ? via : null, color });
    if (via === 'toggle' || !on) this.s.deps.hotkeys.captureEscapeAndEnter(on && !this.s.deps.hotkeys.holdSupported);
  }

  private onStroke(st: StudentStroke): void {
    const target = this.active ?? (Date.now() < this.lateUntil ? null : undefined);
    if (target === undefined) return;
    if (!st.points?.length) return;
    const points = st.straight && st.points.length > 2 ? [st.points[0], st.points[st.points.length - 1]] : st.points;
    const item: InkItem = {
      id: inkId('s'),
      author: 'student',
      kind: 'stroke',
      color: this.s.settings.studentInkColor,
      surface: 'screen',
      points,
      revealAt: 0,
      drawMs: 1,
      fadeAt: null,
      seed: 7,
      group: target?.group ?? this.lateGroup,
    };
    this.s.addInk([item]);
    if (target) {
      target.strokes.push({ ...st, points });
      target.inkIds.push(item.id);
    }
  }

  cancel(): void {
    const a = this.active;
    this.active = null;
    this.s.audioSink = null;
    this.setDrawMode(false, null);
    if (a) this.s.ink.fade({ group: a.group });
    log.info('ask cancelled');
  }

  async finish(spoke: boolean): Promise<void> {
    const a = this.active;
    if (!a) return;
    // Strokes still in flight (pointer released a moment after the keys) join this question.
    this.lateUntil = Date.now() + 250;
    this.lateGroup = a.group;
    await new Promise((r) => setTimeout(r, 80));
    this.active = null;
    this.s.audioSink = null;
    this.setDrawMode(false, null);

    const { kept, voiced } = trimSilence(a.audio);
    const speech = spoke || voiced > 0;
    const strokes = a.strokes;
    if (!strokes.length && !speech) {
      log.info('ask released with nothing said or drawn');
      return;
    }
    const link = this.s.link;
    if (!link?.ready) {
      this.s.toast('Not connected right now — try again in a moment', 'warn', 3000);
      return;
    }

    if (strokes.length) {
      const display = this.displayOf(strokes);
      const color = this.s.settings.studentInkColor;
      const composite = { color, strokes: strokes.map((st) => ({ points: st.points })) };
      const frame = await this.s.sendQuestionFrame(composite, display.id);
      if (frame) this.s.sessionNotes.keepScreenshot(frame.data, frame.mime);
      const desc = describeStrokes(strokes, frame?.ref ?? null);
      this.lastDescription = desc.text;
      const crop = desc.union ? await this.zoomCrop(display, desc.union, composite) : null;
      const note = `[The student held the ask keys and ${desc.text} on their screen (orange marks in the latest frame${crop ? '; a zoomed crop of what they marked is attached' : ''}).${speech ? ' Their spoken question follows.' : ' They did not say anything: tell them what they marked and help with it, or ask what they want to know.'}]`;
      link.sendContext(note, !speech, crop ? { mime: crop.mime, data: crop.data } : undefined);
      log.info(`question with ${strokes.length} mark(s): ${desc.text}${speech ? ' + speech' : ''}`);
    } else {
      this.lastDescription = null;
    }

    if (speech) {
      // Send the buffered question faster than real time (≈4×), then mark the end of the audio.
      for (let i = 0; i < kept.length; i += 4) {
        for (let j = i; j < Math.min(kept.length, i + 4); j++) link.sendAudio(kept[j].pcm);
        await new Promise((r) => setTimeout(r, 40));
      }
      link.audioStreamEnd();
      this.s.setActivity('thinking');
    }
    // Safety net: the student's marks don't linger forever if the tutor never answers.
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => this.s.ink.fade({ group: a.group }), 25_000);
  }

  private fadeStudentInkSoon(ms: number): void {
    const live = this.s.ink.live().filter((i) => i.author === 'student' && i.fadeAt == null);
    if (!live.length || this.active) return;
    this.s.ink.fade({ ids: live.map((i) => i.id) }, Date.now() + this.s.clock.remainingMs() + ms);
  }

  private displayOf(strokes: StudentStroke[]): DisplayInfo {
    const displays = this.s.deps.platform.displays.list();
    const counts = new Map<string, number>();
    for (const st of strokes) for (const p of st.points) {
      const d = displayForPoint(displays, p);
      if (d) counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return displays.find((d) => d.id === best) ?? this.s.activeDisplay();
  }

  private async zoomCrop(display: DisplayInfo, union: Rect, composite: { color: string; strokes: { points: { x: number; y: number }[] }[] }) {
    const pad = Math.max(90, Math.max(union.width, union.height) * 0.35);
    const crop = inflateRect(union, pad);
    const r = await this.s.deps.engine.request({
      type: 'captureNow',
      requestId: this.s.deps.engine.nextRequestId('ask'),
      displayId: display.id,
      maxWidth: 1280,
      quality: 0.82,
      kind: 'crop',
      crop,
      composite,
    });
    return r.ok && r.frame ? r.frame : null;
  }
}

/** "circled the area at box [ymin, xmin, ymax, xmax] and underlined …" (0–1000 of `ref`). */
export function describeStrokes(strokes: StudentStroke[], ref: FrameRef | null): { text: string; union: Rect | null } {
  const parts: string[] = [];
  const rects: Rect[] = [];
  for (const st of strokes) {
    const c = classifyStroke(st.points);
    rects.push(c.bounds);
    const where = ref ? ` the area at box [${globalToBox2d(ref, c.bounds).join(', ')}]` : '';
    parts.push(`${describeShape(c.shape)}${where}`);
  }
  const text = parts.length <= 1 ? (parts[0] ?? 'marked something') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return { text, union: unionRects(rects) };
}
