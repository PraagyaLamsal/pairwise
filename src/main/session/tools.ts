import type { FunctionCall, FunctionResponse } from '../gemini/live';
import { logger } from '../log';

const log = logger('tools');

type Schema = Record<string, unknown>;

const S = (description: string): Schema => ({ type: 'STRING', description });
const N = (description: string): Schema => ({ type: 'NUMBER', description });
const I = (description: string): Schema => ({ type: 'INTEGER', description });
const B = (description: string): Schema => ({ type: 'BOOLEAN', description });
const E = (values: string[], description: string): Schema => ({ type: 'STRING', format: 'enum', enum: values, description });
const OBJ = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'OBJECT', properties, required });
const ARR = (items: Schema, description: string): Schema => ({ type: 'ARRAY', items, description });

const APPROX = {
  x: N('Your rough estimate of the target centre, 0–1000 from the left edge of the latest screen frame. Optional; it lets the cursor start moving sooner.'),
  y: N('Your rough estimate of the target centre, 0–1000 from the top edge of the latest screen frame.'),
  display: I('1-based display number, only if the target is on a display other than the one you are watching.'),
};

const ANNOTATION_ITEM = OBJ(
  {
    kind: E(['circle', 'underline', 'highlight', 'box', 'arrow', 'text', 'step', 'check', 'cross', 'bracket'], 'What to draw.'),
    target: S('Exactly what on screen this marks, e.g. "the Run button in the VS Code toolbar" or "line 12: for i in range(n):". Needed for every kind except a free-floating text note.'),
    text: S('For text: a short handwritten note (at most ~5 words). For arrow: an optional note written at its tail.'),
    number: I('For step: the number in the badge.'),
    from: S('For arrow: what the arrow starts from (optional; default is a clear spot nearby).'),
    ...APPROX,
  },
  ['kind'],
);

/**
 * Function declarations for the Live model. gemini-3.8-live runs functions asynchronously by
 * default (NON_BLOCKING); the few whose result the tutor must have *before* it speaks are BLOCKING.
 */
export const TOOL_DECLARATIONS = [
  {
    name: 'point_at',
    description: 'Glide your cursor to one thing on the student\'s screen as you mention it ("this button", "line twelve", "that error"). Fast and light — use it constantly.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ target: S('Specific description of what to point at.'), label: S('2–4 word label shown beside your cursor, e.g. "Run button".'), ...APPROX }, ['target']),
  },
  {
    name: 'annotate',
    description: 'Draw one to three hand-drawn marks on the student\'s screen while you talk: circle, underline, highlight, box, arrow, a short note, a step number, a check or a cross.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ items: ARR(ANNOTATION_ITEM, 'Marks to draw, in order.'), clear_previous: B('Erase your earlier marks first.') }, ['items']),
  },
  {
    name: 'explain_on_screen',
    description:
      'For a visual explanation of what is on screen (walking through code, a slide, a diagram, an error): a vision model studies a full-resolution screenshot and returns a short script — lines to say, each with marks that appear exactly as you say it. When it arrives, say the lines in order, essentially word for word, then continue naturally. Say a few words while it prepares ("let me mark this up").',
    behavior: 'NON_BLOCKING',
    parameters: OBJ(
      {
        question: S('What the student needs explained, in their words plus any context.'),
        focus: S('Optional: the part of the screen to focus on, e.g. "the recursive call in fib()".'),
        lines: I('How many lines to plan, 2–6 (default 4).'),
      },
      ['question'],
    ),
  },
  {
    name: 'clear_drawings',
    description: 'Erase drawings on screen (yours, the student\'s, or all) — do this when you move on to a new point.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ who: E(['tutor', 'student', 'all'], 'Whose drawings to clear.') }),
  },
  {
    name: 'read_screen',
    description: 'Read text or code on the screen exactly, at full resolution. Use it before quoting code, reading an error, or whenever small text is hard to see. Returns the transcription.',
    behavior: 'BLOCKING',
    parameters: OBJ({ region: S('What to read, e.g. "the error in the terminal" or "the function on the left".'), ...APPROX }, ['region']),
  },
  {
    name: 'look_at_display',
    description: 'Switch which of the student\'s displays you are watching.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ display: I('1-based display number.') }, ['display']),
  },
  {
    name: 'show_steps',
    description: 'Show a small checklist on screen for a "how do I…" task (max 15 short steps). Then guide one step at a time with guide_step.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ title: S('Short title of the task.'), steps: ARR(S('One short step.'), 'Steps, each a few words.') }, ['title', 'steps']),
  },
  {
    name: 'guide_step',
    description:
      'Guide ONE step: point at exactly what to click or where to work, then wait. The app watches the screen and tells you (as this function\'s result) when the student has done it, so stop talking after giving the instruction. expect="click" for a button/menu/link/tab/field to click; "hover" for something revealed by hovering; "screen" when the step changes the screen in a way you can describe (e.g. a dialog opens); "manual" for work the app cannot detect (typing text, dragging a slider) — then ask them to say "done" when it looks right.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ(
      {
        step: I('1-based step number in the checklist (if one is shown).'),
        instruction: S('The one action, in a few words, e.g. "Click Run".'),
        target: S('What to click / where to work, described precisely.'),
        expect: E(['click', 'hover', 'screen', 'manual'], 'How the app can tell the step is done.'),
        done_when: S('For expect=screen: what the screen shows once it is done, e.g. "a Terminal window is open".'),
        label: S('2–3 word label for your cursor.'),
        ...APPROX,
      },
      ['instruction', 'target', 'expect'],
    ),
  },
  {
    name: 'search_course',
    description: 'Search this course\'s own material (slides, notes, transcripts, assignment specs). Use it before teaching course content so you use the professor\'s terms and methods and can cite the source.',
    behavior: 'BLOCKING',
    parameters: OBJ({ query: S('What to look for.') }, ['query']),
  },
  {
    name: 'cite',
    description: 'Show on screen which lecture or file a point comes from (a small card).',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ source: S('Citation label exactly as returned by search_course.'), snippet: S('A short quote or summary from that source.') }, ['source']),
  },
  {
    name: 'flag_out_of_scope',
    description: 'Tell the app the current question goes beyond what this course covers (shown to the student as a badge).',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ topic: S('The topic that is beyond scope.'), where: S('Where it is usually taught, if known (e.g. "COMP 2402").') }, ['topic']),
  },
  {
    name: 'think_deeply',
    description: 'Ask a stronger reasoning model to work something out carefully (a proof, a tricky trace, a subtle bug, a diagram plan). Keep the conversation going while it works; the answer arrives as the result.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ question: S('Exactly what to work out.'), use_screen: B('Include a full-resolution screenshot.') }, ['question']),
  },
  {
    name: 'request_control',
    description: 'Ask permission to take over the student\'s mouse and keyboard to demonstrate. The app shows them a prompt; the result says whether they allowed it. Wait for it.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ reason: S('Short reason shown to the student, e.g. "show you where the build settings are".') }, ['reason']),
  },
  {
    name: 'control',
    description:
      'While you have control: click, type, press keys or scroll on the student\'s computer, narrating briefly. They see everything and can take control back at any moment. Never submit, send, delete, buy, run commands or change settings without asking out loud first and hearing yes — the app also makes them confirm such actions.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ(
      {
        actions: ARR(
          OBJ(
            {
              type: E(['click', 'double_click', 'right_click', 'move', 'type', 'key', 'scroll', 'drag'], 'Action type.'),
              target: S('What to click/move to or type into, described precisely.'),
              text: S('For type: the text to type.'),
              keys: ARR(S('Key name, e.g. "cmd", "shift", "enter", "tab", "a".'), 'For key: keys pressed together.'),
              direction: E(['up', 'down', 'left', 'right'], 'For scroll.'),
              amount: I('For scroll: how far, 1–10.'),
              to_target: S('For drag: where to drop.'),
              ...APPROX,
            },
            ['type'],
          ),
          'Actions to perform in order (keep it to a few).',
        ),
        explain: S('One short sentence shown to the student about what you are doing.'),
      },
      ['actions'],
    ),
  },
  {
    name: 'release_control',
    description: 'Give control of the mouse and keyboard back to the student — do this as soon as the demonstration is done.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({}),
  },
  {
    name: 'celebrate',
    description: 'A small celebration on screen when the student gets something right or finishes a task.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ message: S('1–2 words, e.g. "nice!" or "nailed it".') }),
  },
  {
    name: 'draw_diagram',
    description: 'Draw a diagram on the whiteboard (opens it if needed): trees (recursion, BSTs), flowcharts, linked lists, arrays, graphs, memory boxes. Use it when there is nothing on screen to draw on.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ(
      {
        title: S('Short title written above the diagram.'),
        kind: E(['tree', 'flow', 'list', 'array', 'graph', 'boxes'], 'Layout to use.'),
        nodes: ARR(OBJ({ id: S('Unique id.'), label: S('Text in the node (short).'), note: S('Optional handwritten note beside it.'), highlight: B('Emphasize this node.') }, ['id', 'label']), 'Nodes.'),
        edges: ARR(OBJ({ from: S('Node id.'), to: S('Node id.'), label: S('Optional edge label.') }, ['from', 'to']), 'Edges (arrows).'),
        clear: B('Clear the whiteboard first.'),
      },
      ['kind', 'nodes'],
    ),
  },
  {
    name: 'whiteboard',
    description: 'Open, clear or close the whiteboard, or write/draw free-form on it. Coordinates are 0–1000 of the board.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({
      action: E(['open', 'close', 'clear', 'draw'], 'What to do.'),
      items: ARR(
        OBJ({ kind: E(['text', 'arrow', 'line', 'circle', 'box', 'underline', 'check', 'cross'], 'Mark.'), text: S('Text for text marks.'), x: N('0–1000'), y: N('0–1000'), x2: N('End x for arrows/lines/boxes.'), y2: N('End y for arrows/lines/boxes.') }, ['kind']),
        'Marks for action "draw".',
      ),
    }),
  },
  {
    name: 'save_note',
    description: 'Save something to the session notes: a key idea, a definition, a mistake to avoid, or something to review later.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ kind: E(['key_idea', 'definition', 'to_review', 'mistake'], 'Kind of note.'), text: S('The note, one or two sentences.') }, ['kind', 'text']),
  },
  {
    name: 'media',
    description: 'Pause or resume the lecture video or audio the student was watching.',
    behavior: 'NON_BLOCKING',
    parameters: OBJ({ action: E(['pause', 'resume'], 'What to do.') }, ['action']),
  },
] as const;

export type ToolName = (typeof TOOL_DECLARATIONS)[number]['name'];

export function toolBehavior(name: string): 'BLOCKING' | 'NON_BLOCKING' {
  return (TOOL_DECLARATIONS.find((t) => t.name === name)?.behavior ?? 'NON_BLOCKING') as 'BLOCKING' | 'NON_BLOCKING';
}

export interface ToolResult {
  response: Record<string, unknown>;
  /** SILENT: the model uses it without announcing. WHEN_IDLE: reacts after its current sentence. INTERRUPT: reacts now. */
  scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT';
}

export type ToolHandler = (args: Record<string, unknown>, call: FunctionCall, signal: AbortSignal) => Promise<ToolResult>;

/** Routes tool calls to feature handlers; supports cancellation (toolCallCancellation, interruptions). */
export class ToolDispatcher {
  private handlers = new Map<string, ToolHandler>();
  private running = new Map<string, { ctrl: AbortController; name: string }>();

  register(name: ToolName, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** Names of calls still running (e.g. a guide step waiting for the student). */
  pending(): string[] {
    return [...this.running.values()].map((r) => r.name);
  }

  async dispatch(call: FunctionCall): Promise<FunctionResponse | null> {
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return { id: call.id, name: call.name, response: { ok: false, error: `${call.name} isn't available in this session.` }, scheduling: 'SILENT' };
    }
    const ctrl = new AbortController();
    this.running.set(call.id, { ctrl, name: call.name });
    try {
      const r = await handler(call.args ?? {}, call, ctrl.signal);
      if (ctrl.signal.aborted) return null;
      return { id: call.id, name: call.name, response: r.response, scheduling: r.scheduling ?? 'SILENT' };
    } catch (e) {
      if (ctrl.signal.aborted) return null;
      log.warn(`tool ${call.name} failed`, e);
      return { id: call.id, name: call.name, response: { ok: false, error: (e as Error).message }, scheduling: 'SILENT' };
    } finally {
      this.running.delete(call.id);
    }
  }

  cancel(ids: string[]): void {
    for (const id of ids) this.running.get(id)?.ctrl.abort();
  }

  cancelAll(): void {
    for (const r of this.running.values()) r.ctrl.abort();
    this.running.clear();
  }
}

/** Schema Gemini receives: `tools: [{ functionDeclarations: [...] }]`. */
export function liveTools(available: (name: string) => boolean): Record<string, unknown>[] {
  return [{ functionDeclarations: TOOL_DECLARATIONS.filter((t) => available(t.name)) }];
}
