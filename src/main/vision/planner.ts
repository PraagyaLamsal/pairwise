import type { EncodedFrame } from '@shared/ipc';
import type { GeminiRest } from '../gemini/rest';
import { logger } from '../log';

const log = logger('planner');

/** One mark (or pointer gesture) in a planned beat, in the screenshot's own 0–1000 coordinates. */
export interface PlannedMark {
  kind: 'circle' | 'underline' | 'highlight' | 'box' | 'arrow' | 'text' | 'step' | 'check' | 'cross' | 'bracket' | 'hover' | 'follow_line' | 'sweep' | 'value';
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
    kind: { type: 'STRING', enum: ['hover', 'follow_line', 'sweep', 'value', 'circle', 'underline', 'highlight', 'box', 'arrow', 'text', 'step', 'check', 'cross', 'bracket'] },
    box_2d: { type: 'ARRAY', items: { type: 'INTEGER' }, description: '[ymin, xmin, ymax, xmax] 0-1000 of the thing this mark is about' },
    point: { type: 'ARRAY', items: { type: 'INTEGER' }, description: '[y, x] 0-1000: arrow tail, or where a free-standing note starts' },
    text: { type: 'STRING', description: 'For text marks: at most 5 words. For arrows: optional note at the tail. For value: the values, at most 24 characters.' },
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
  /** 'trace': step through code like a debugger, with the values after each line. */
  mode?: 'explain' | 'trace';
  /** For a trace: the input to run it with, e.g. "factorial(3)". */
  input?: string;
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
    const trace = req.mode === 'trace';
    const lines = trace ? Math.max(3, Math.min(10, req.lines || 6)) : Math.max(2, Math.min(6, req.lines || 4));
    const prompt = (trace ? tracePrompt(req, lines) : [
      `You are ${req.tutorName}, a tutor explaining something on a student's screen out loud while drawing on it with a marker. Course: ${req.courseLine}.`,
      req.terms.length ? `Use the course's own terms where they fit: ${req.terms.slice(0, 20).join('; ')}.` : '',
      `The student asks: "${req.question}"${req.focus ? ` (focus: ${req.focus})` : ''}.`,
      req.studentMarks ? `They marked: ${req.studentMarks}.` : '',
      `Write ${lines} beats. Each beat is what you SAY (one or two short, natural spoken sentences — no markdown, no lists, never read code symbols aloud letter by letter) plus the 0–2 things your cursor does at that moment.`,
      'Like a person pairing with them, use your cursor mostly as a pointer: "hover" rests it on the thing you mention, "follow_line" glides under one line of code or text while you read or explain it, "sweep" runs down a block of lines. Draw ink sparingly — at most one mark in the whole explanation unless marking really helps: circles and boxes enclose something; underline/highlight a line of text; arrows point at it (optional point [y, x] for the tail); text is a short typed note (≤5 words) placed beside it; step is a numbered badge.',
      'Everything must be about things actually visible in this screenshot. Give each one a tight box_2d [ymin, xmin, ymax, xmax] (0–1000) around exactly the word, line, button or block of lines it is about.',
      'Build the explanation step by step, beat by beat, from what they can see. The first beat orients them ("see this function?"), the last one lands the idea.',
      req.depth === 'brief' ? 'Keep it short.' : req.depth === 'deep' ? 'Go a little deeper with the reasoning.' : '',
      req.assignment ? `This is a graded assignment (${req.assignment}): explain concepts and point at relevant parts, but never give the solution or write their answer.` : '',
      'Never box anything inside black areas labelled "hidden by App Veil".',
    ])
      .filter(Boolean)
      .join('\n');
    const r = await this.rest.generateJson<{ beats?: PlannedBeat[] }>(
      this.model(),
      {
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: req.frame.mime, data: Buffer.from(req.frame.data).toString('base64') } }, { text: prompt }] }],
        // A trace's values have to be right: give it room to work them out.
        generationConfig: { responseSchema: SCHEMA, thinkingConfig: { thinkingLevel: trace ? 'medium' : 'low' }, temperature: trace ? 0.2 : 0.4, maxOutputTokens: trace ? 4096 : 2048 },
      },
      { timeoutMs: trace ? 40_000 : 25_000, inputModality: 'IMAGE' },
    );
    if (signal?.aborted) return { beats: [], ms: Date.now() - t0 };
    const beats = (r.beats ?? [])
      .filter((b) => typeof b?.say === 'string' && b.say.trim())
      .slice(0, trace ? 10 : 6)
      .map((b) => ({ say: b.say.trim(), marks: (b.marks ?? []).filter(validMark).slice(0, 3) }));
    log.info(`planned ${beats.length} beats in ${Date.now() - t0} ms`);
    return { beats, ms: Date.now() - t0 };
  }
}

/** The planning prompt for trace_code: execution order, one step per beat, values beside lines. */
function tracePrompt(req: PlanRequest, steps: number): string[] {
  return [
    `You are ${req.tutorName}, a tutor tracing code on a student's screen out loud, like a debugger: your cursor moves to each line as it runs, and the values right after it runs appear beside that line. Course: ${req.courseLine}.`,
    req.terms.length ? `Use the course's own terms where they fit: ${req.terms.slice(0, 20).join('; ')}.` : '',
    `The student asks: "${req.question}"${req.focus ? ` (focus: ${req.focus})` : ''}.`,
    req.input ? `Trace it with this input: ${req.input}.` : 'Pick a small, typical input and say which one in the first beat.',
    req.studentMarks ? `They marked: ${req.studentMarks}.` : '',
    `Write at most ${steps} beats, in the order the code runs. Each beat is what you SAY (one short spoken sentence — no markdown, never read symbols aloud) plus its marks:`,
    '- "follow_line" (or "hover" for a short line) with a tight box_2d [ymin, xmin, ymax, xmax] (0–1000) around the text of the line being run, and',
    '- "value" with the same box_2d and text = the values right after that line runs, e.g. "n = 3", "i = 2, total = 3", "3 == 0 → False", "returns 6" (at most 24 characters). When a line runs again, give it the new value; it replaces the old one.',
    "For recursion, show each call's argument on the way down and what each call returns on the way back up. For a loop, trace the first two or three iterations, then say where it ends up.",
    'The first beat says what you are tracing and with which input; the last one gives the result. The values must be exactly right: work the whole trace out carefully before you write it.',
    'Only use lines that are actually visible in this screenshot.',
    req.assignment ? `This is a graded assignment (${req.assignment}): trace the student's own code to help them see what it does, but never write the solution for them.` : '',
    'Never box anything inside black areas labelled "hidden by App Veil".',
  ];
}

function validMark(m: PlannedMark): boolean {
  if (!m || typeof m.kind !== 'string') return false;
  const okBox = Array.isArray(m.box_2d) && m.box_2d.length === 4 && m.box_2d.every((v) => Number.isFinite(v));
  const okPoint = Array.isArray(m.point) && m.point.length === 2 && m.point.every((v) => Number.isFinite(v));
  if (m.kind === 'hover' || m.kind === 'follow_line' || m.kind === 'sweep') return okBox;
  if (m.kind === 'value') return okBox && typeof m.text === 'string' && m.text.trim().length > 0;
  if (m.kind === 'text') return Boolean(m.text) && (okBox || okPoint);
  if (m.kind === 'arrow') return okBox || okPoint;
  return okBox || (okPoint && (m.kind === 'step' || m.kind === 'check' || m.kind === 'cross'));
}
