import { ipcMain } from 'electron';
import { globalToBox2d, inflateRect, rectContains, type Point, type Rect } from '@shared/geometry';
import { inkId, type InkItem } from '@shared/ink';
import type { TutorSession } from '../tutor';
import { namesControl } from '../../vision/snap';
import { logger } from '../../log';

const log = logger('quiz');

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** How long a question waits for the student's click. */
const ANSWER_WAIT_MS = 90_000;
/** The student's answer stays marked for a while (their highlight click). */
const ANSWER_RING_MS = 4200;

export interface AnswerResult {
  clicked: boolean;
  how: string;
  point?: Point;
  displayId?: string;
}

/**
 * How far a click is from the answer (global DIP): 0 inside it (with a little slack for small
 * targets, which are hard to hit exactly), else the distance to its nearest edge.
 */
export function offTarget(answer: Rect, p: Point): number {
  const slack = Math.max(6, Math.min(14, answer.height * 0.3));
  const r = inflateRect(answer, slack);
  if (rectContains(r, p)) return 0;
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.round(Math.hypot(dx, dy));
}

/** A small ring as a stroke around `p` (to composite into the frame the tutor gets). */
export function ringStroke(p: Point, r = 14): { points: Point[] } {
  return { points: Array.from({ length: 25 }, (_, i) => ({ x: p.x + r * Math.cos((i / 24) * Math.PI * 2), y: p.y + r * Math.sin((i / 24) * Math.PI * 2) })) };
}

/**
 * "Show me": Ada checks understanding by asking the student to point at something on their
 * screen ("click the line where the recursion stops"). The overlays take one click — it never
 * reaches the app underneath — mark it with the student's own highlight ring, and Ada gets
 * where they clicked, whether that's on the answer she had in mind (found on screen the same
 * way she finds what she points at), and a fresh frame with the click marked.
 */
export class QuizFeature {
  private pending: { resolve: (r: AnswerResult) => void; timer: NodeJS.Timeout } | null = null;

  constructor(private readonly s: TutorSession) {
    ipcMain.on('overlay:answer', (_e, m: { displayId: string; point: Point }) => {
      if (m && m.point && Number.isFinite(m.point.x) && Number.isFinite(m.point.y)) this.finish({ clicked: true, how: 'clicked', point: m.point, displayId: m.displayId });
    });
    ipcMain.on('overlay:answerCancel', () => this.finish({ clicked: false, how: 'skipped' }));
    s.deps.hotkeys.on('escape', () => this.pending && this.finish({ clicked: false, how: 'skipped' }));
    s.on('ended', () => this.finish({ clicked: false, how: 'session ended' }));
    this.register();
  }

  /** A question is waiting for the student's click. */
  get asking(): boolean {
    return this.pending !== null;
  }

  private register(): void {
    this.s.tools.register('ask_to_point', async (args, _call, signal) => {
      const question = str(args.question);
      if (!question) return { response: { ok: false, error: 'Say what they should point at.' } };
      // One question at a time: a new one replaces any still waiting.
      this.finish({ clicked: false, how: 'replaced by a new question' });
      const display = this.s.visual.displayFor(args);
      const answer = str(args.answer);
      let answerRect: Rect | null = null;
      if (answer) {
        const [r] = await this.s.visual.grounder.locate(display.id, [{ id: 'a', description: answer, control: namesControl(answer) }], this.s.modelFrame, signal);
        if (r?.found && r.rect && r.via !== 'approx') answerRect = r.rect;
      }
      if (signal.aborted) return { response: { ok: false } };
      // Her cursor steps back while they look, so it doesn't give the answer away.
      this.s.cursor.relax();
      const result = await this.waitForClick(question, signal);
      if (signal.aborted) return { response: { ok: false } };
      if (!result.clicked || !result.point) {
        return { response: { clicked: false, [result.how === 'timed out' ? 'timed_out' : 'skipped']: true, note: result.how === 'timed out' ? 'No answer yet. Ask whether they want a hint.' : 'They skipped it: give a hint, or show them.' }, scheduling: 'WHEN_IDLE' };
      }
      const p = result.point;
      this.markAnswer(p);
      const off = answerRect ? offTarget(answerRect, p) : null;
      // A fresh frame with their click drawn in, for the tutor to look at.
      const frame = await this.s.sendQuestionFrame({ color: this.s.settings.studentInkColor, strokes: [{ points: [p] }, ringStroke(p)] }, result.displayId ?? display.id);
      const ref = frame?.ref ?? this.s.modelFrame;
      const where = ref ? globalToBox2d(ref, { x: p.x, y: p.y, width: 0, height: 0 }).slice(0, 2) : undefined;
      log.info(`answer: ${off === null ? 'no answer to check against' : off === 0 ? 'on target' : `${off} px off`}`);
      return {
        response: {
          clicked: true,
          ...(where ? { at: { y: where[0], x: where[1] } } : {}),
          ...(off === null ? { checked: false } : { on_target: off === 0, ...(off ? { off_by_px: off } : {}) }),
          note: `Their click is marked with an orange ring in the frame just sent${off === null ? '; look at what is there' : ''}. React to it: if they got it, say so (celebrate); if not, give a hint and let them try again.`,
        },
        scheduling: 'WHEN_IDLE',
      };
    });
  }

  private waitForClick(question: string, signal: AbortSignal): Promise<AnswerResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish({ clicked: false, how: 'timed out' }), ANSWER_WAIT_MS);
      this.pending = { resolve, timer };
      this.setAnswerMode(true, question);
      this.s.setActivity('waiting');
      signal.addEventListener('abort', () => this.finish({ clicked: false, how: 'cancelled' }));
    });
  }

  /** The overlays take one click (instead of letting it through), with the question on screen. */
  private setAnswerMode(on: boolean, prompt = ''): void {
    this.s.overlays.setInteractive('all', on);
    this.s.overlays.send('overlay:answerMode', { active: on, prompt, color: this.s.settings.studentInkColor });
    // Esc skips (as a global shortcut only while asking; the overlays can't take key focus).
    if (!this.s.ask.isActive) this.s.deps.hotkeys.captureEscapeAndEnter(on);
  }

  /** Their answer, marked like a highlight click in their own colour. */
  private markAnswer(p: Point): void {
    const now = Date.now();
    const ring: InkItem = {
      id: inkId('ans'),
      author: 'student',
      kind: 'ring',
      color: this.s.settings.studentInkColor,
      surface: 'screen',
      at: p,
      rect: { x: p.x - 10, y: p.y - 10, width: 20, height: 20 },
      revealAt: now,
      drawMs: 900,
      fadeAt: now + ANSWER_RING_MS,
      seed: 5,
      group: 'answer',
      label: 'the student\'s answer',
    };
    this.s.addInk([ring]);
  }

  private finish(r: AnswerResult): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    this.setAnswerMode(false);
    if (this.s.snapshot.activity === 'waiting') this.s.setActivity('idle');
    p.resolve(r);
  }
}
