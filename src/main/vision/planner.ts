import type { EncodedFrame } from '@shared/ipc';
import type { GeminiRest } from '../gemini/rest';
import { logger } from '../log';

const log = logger('planner');

/** One mark in a planned beat, in the screenshot's own 0–1000 coordinates. */
export interface PlannedMark {
  kind: 'circle' | 'underline' | 'highlight' | 'box' | 'arrow' | 'text' | 'step' | 'check' | 'cross' | 'bracket';
  /** [ymin, xmin, ymax, xmax] of what the mark is about. */
  box_2d?: number[];
  /** [y, x] for arrow tails or free-standing notes/badges. */
  point?: number[];
  text?: string;
  number?: number;
  label?: string;
}

export interface PlannedBeat {
  say: string;
  marks: PlannedMark[];
}

export interface Plan {
  beats: PlannedBeat[];
  ms: number;
}

const MARK = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['circle', 'underline', 'highlight', 'box', 'arrow', 'text', 'step', 'check', 'cross', 'bracket'] },
    box_2d: { type: 'ARRAY', items: { type: 'INTEGER' }, description: '[ymin, xmin, ymax, xmax] 0-1000 of the thing this mark is about' },
    point: { type: 'ARRAY', items: { type: 'INTEGER' }, description: '[y, x] 0-1000: arrow tail, or where a free-standing note starts' },
    text: { type: 'STRING', description: 'For text marks: at most 5 words. For arrows: optional note at the tail.' },
    number: { type: 'INTEGER' },
    label: { type: 'STRING', description: 'What the mark points at, 2-4 words' },
  },
  required: ['kind'],
};

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    beats: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          say: { type: 'STRING', description: 'One or two short spoken sentences.' },
          marks: { type: 'ARRAY', items: MARK },
        },
        required: ['say', 'marks'],
      },
    },
  },
  required: ['beats'],
};

export interface PlanRequest {
  frame: EncodedFrame;
  question: string;
  focus?: string;
  lines: number;
  tutorName: string;
  courseLine: string;
  terms: string[];
  depth: 'brief' | 'standard' | 'deep';
  assignment?: string;
  /** What the student drew, if this follows a hold-to-ask question. */
  studentMarks?: string;
}

/**
 * explain_on_screen: a stronger look at a full-resolution screenshot that returns a short
 * spoken script where every line carries the marks to draw while it is said (HeyClicky's
 * "beat" idea, done with Gemini's native 0–1000 boxes).
 */
export class ExplanationPlanner {
  constructor(
    private readonly rest: GeminiRest,
    private readonly model: () => string,
  ) {}

  get available(): boolean {
    return this.rest.hasKey;
  }

  async plan(req: PlanRequest, signal?: AbortSignal): Promise<Plan> {
    const t0 = Date.now();
    const lines = Math.max(2, Math.min(6, req.lines || 4));
    const prompt = [
      `You are ${req.tutorName}, a tutor explaining something on a student's screen out loud while drawing on it with a marker. Course: ${req.courseLine}.`,
      req.terms.length ? `Use the course's own terms where they fit: ${req.terms.slice(0, 20).join('; ')}.` : '',
      `The student asks: "${req.question}"${req.focus ? ` (focus: ${req.focus})` : ''}.`,
      req.studentMarks ? `They marked: ${req.studentMarks}.` : '',
      `Write ${lines} beats. Each beat is what you SAY (one or two short, natural spoken sentences — no markdown, no lists, never read code symbols aloud letter by letter) plus the 0–2 marks you draw at that moment.`,
      'Marks must point at things actually visible in this screenshot. Give each mark a tight box_2d [ymin, xmin, ymax, xmax] (0–1000) around exactly the word, line, button or region it is about. Circles and boxes enclose it; underline/highlight a line of text; arrows point at it (optional point [y, x] for the tail); text is a short handwritten note (≤5 words) placed beside it; step is a numbered badge.',
      'Build the explanation step by step, beat by beat, from what they can see. The first beat orients them ("see this function?"), the last one lands the idea.',
      req.depth === 'brief' ? 'Keep it short.' : req.depth === 'deep' ? 'Go a little deeper with the reasoning.' : '',
      req.assignment ? `This is a graded assignment (${req.assignment}): explain concepts and point at relevant parts, but never give the solution or write their answer.` : '',
      'Never box anything inside black areas labelled "hidden by App Veil".',
    ]
      .filter(Boolean)
      .join('\n');
    const r = await this.rest.generateJson<{ beats?: PlannedBeat[] }>(
      this.model(),
      {
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: req.frame.mime, data: Buffer.from(req.frame.data).toString('base64') } }, { text: prompt }] }],
        generationConfig: { responseSchema: SCHEMA, thinkingConfig: { thinkingLevel: 'low' }, temperature: 0.4, maxOutputTokens: 2048 },
      },
      { timeoutMs: 25_000, inputModality: 'IMAGE' },
    );
    if (signal?.aborted) return { beats: [], ms: Date.now() - t0 };
    const beats = (r.beats ?? [])
      .filter((b) => typeof b?.say === 'string' && b.say.trim())
      .slice(0, 6)
      .map((b) => ({ say: b.say.trim(), marks: (b.marks ?? []).filter(validMark).slice(0, 3) }));
    log.info(`planned ${beats.length} beats in ${Date.now() - t0} ms`);
    return { beats, ms: Date.now() - t0 };
  }
}

function validMark(m: PlannedMark): boolean {
  if (!m || typeof m.kind !== 'string') return false;
  const okBox = Array.isArray(m.box_2d) && m.box_2d.length === 4 && m.box_2d.every((v) => Number.isFinite(v));
  const okPoint = Array.isArray(m.point) && m.point.length === 2 && m.point.every((v) => Number.isFinite(v));
  if (m.kind === 'text') return Boolean(m.text) && (okBox || okPoint);
  if (m.kind === 'arrow') return okBox || okPoint;
  return okBox || (okPoint && (m.kind === 'step' || m.kind === 'check' || m.kind === 'cross'));
}
