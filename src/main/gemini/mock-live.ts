import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { toolBehavior } from '../session/tools';
import { logger } from '../log';

const log = logger('mock-live');

/**
 * A local stand-in for the Gemini Live API that speaks the same wire protocol. It powers:
 *  - the demo tutor when no API key is configured (scripted lines, real tool calls, and real
 *    speech on macOS through `say`), and
 *  - the integration/e2e tests (scenarios + inspection of what the client sent).
 */

export type Segment =
  | { say: string }
  | { tool: string; args: Record<string, unknown> }
  | { pause: number };

export interface MockTurn {
  /** Text shown as the student's transcription for this turn (demo: what was "heard"). */
  heard?: string;
  segments: Segment[];
}

export type Synthesizer = (text: string) => Promise<Buffer | null>;

export interface MockStats {
  setups: Record<string, unknown>[];
  audioChunks: number;
  audioBytes: number;
  videoFrames: number;
  texts: string[];
  clientContents: unknown[];
  toolResponses: unknown[];
  audioStreamEnds: number;
  activityStarts: number;
  activityEnds: number;
  /** The last few video frames received (base64), for tests that check what left the machine. */
  recentVideo: { mime: string; data: string }[];
}

interface Conn {
  ws: WsSocket;
  speaking: boolean;
  speechMs: number;
  silenceMs: number;
  responding: { cancelled: boolean } | null;
  turnIndex: number;
  handleSeq: number;
  frames: number;
  /** BLOCKING tool calls the "model" is waiting on, by call id. */
  waiting: Map<string, (response: Record<string, unknown>) => void>;
  /** Names of NON_BLOCKING calls still open, by id (so late results can trigger follow-ups). */
  open: Map<string, string>;
  /** Result of the last BLOCKING call (scripted turns can refer to it). */
  lastResult?: Record<string, unknown> | null;
}

const SR_OUT = 24000;

/** Default demo script used when no key is configured. Coordinates are 0–1000 of the screen. */
export function demoScript(tutor: string): { greeting: MockTurn; turns: MockTurn[] } {
  return {
    greeting: {
      segments: [
        { say: `Hi! I'm ${tutor}. This is demo mode, so I'm following a script instead of really listening.` },
        { tool: 'point_at', args: { target: 'the middle of your screen', label: 'hi there!', x: 500, y: 420 } },
        { say: 'Hold Control and Option, then talk, or drag to circle something, and I\'ll show you what I can do.' },
      ],
    },
    turns: [
      {
        heard: '(demo) can you walk me through this?',
        segments: [
          { say: 'Sure. Most of the time I just use my cursor, like someone sitting next to you.' },
          { tool: 'move_cursor', args: { target: 'the block of lines in the middle', style: 'sweep', lines: 4, box: [360, 260, 600, 700] } },
          { say: 'I run down a block of lines to show you its shape,' },
          { tool: 'move_cursor', args: { target: 'one line in the middle', style: 'follow_line', box: [440, 260, 480, 700] } },
          { say: 'follow one line while I read it with you,' },
          { tool: 'move_cursor', args: { target: 'a spot on the right', style: 'hover', box: [520, 720, 560, 800] } },
          { say: 'or just rest on the thing I mean. And when I stop, my cursor stays put and fades back, out of your way.' },
        ],
      },
      {
        heard: '(demo) what can you draw?',
        segments: [
          { say: 'I mark things up while I explain them.' },
          { tool: 'annotate', args: { items: [{ kind: 'circle', target: 'an area near the top left', box: [140, 120, 260, 360] }] } },
          { say: 'Circles for the thing that matters,' },
          { tool: 'annotate', args: { items: [{ kind: 'arrow', target: 'the circled area', from_x: 560, from_y: 330, box: [140, 120, 260, 360] }, { kind: 'text', text: 'look here!', x: 575, y: 300 }] } },
          { say: 'arrows and little notes,' },
          { tool: 'annotate', args: { items: [{ kind: 'underline', target: 'a line of text', box: [520, 200, 560, 640] }, { kind: 'highlight', target: 'another line', box: [600, 200, 640, 560] }] } },
          { say: 'and underlines or highlights for the exact words.' },
        ],
      },
      {
        heard: '(demo) what does this code do?',
        segments: [
          { say: 'Let\'s trace it, one line at a time.' },
          { tool: 'trace_code', args: { question: 'what does this code do?', input: 'factorial(3)' } },
        ],
      },
      {
        heard: '(demo) what does my course say about this?',
        segments: [
          { say: 'Let me check your course material first.' },
          { tool: 'search_course', args: { query: 'recursion stopping case base case' } },
          { say: 'Here is where your course covers it.' },
          { tool: 'cite', args: { source: '$first' } },
          { say: 'I search your own slides and notes so I use your professor\'s words, and I show you the source.' },
        ],
      },
      {
        heard: '(demo) how do I do it step by step?',
        segments: [
          { tool: 'show_steps', args: { title: 'Run your Python file', steps: ['Open the Terminal', 'Go to your project folder', 'Type python3 main.py and press Return'] } },
          { say: 'For how-to questions I go one step at a time, and I wait for you to do each one.' },
          { tool: 'guide_step', args: { step: 1, instruction: 'Click here', target: 'the middle of the screen', expect: 'click', label: 'click here', x: 500, y: 520 } },
          { say: 'Try it: click where I am pointing.' },
        ],
      },
      {
        heard: '(demo) quiz me',
        segments: [
          { say: 'Quick check. Click on the middle of your screen, as if it were the answer.' },
          { tool: 'ask_to_point', args: { question: 'Click the middle of your screen', answer: 'the middle of your screen' } },
        ],
      },
      {
        heard: '(demo) did I get it right?',
        segments: [
          { say: 'Yes, that\'s exactly it!' },
          { tool: 'celebrate', args: { message: 'nice!' } },
          { say: 'When you get something right, I make a little fuss about it.' },
        ],
      },
      {
        heard: '(demo) can you show me?',
        segments: [
          { say: 'I can also take over the mouse to demonstrate, but only if you let me.' },
          { tool: 'request_control', args: { reason: 'show you where that setting lives' } },
          { say: 'Click let it drive, or say no — either way is fine.' },
        ],
      },
      {
        heard: '(demo) can you draw it out?',
        segments: [
          { say: 'When there\'s nothing on screen to draw on, I use the whiteboard.' },
          { tool: 'draw_diagram', args: { title: 'factorial(3)', kind: 'tree', nodes: [{ id: 'a', label: 'factorial(3)' }, { id: 'b', label: 'factorial(2)' }, { id: 'c', label: 'factorial(1)' }, { id: 'd', label: 'factorial(0) = 1' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }] } },
          { say: 'Each call waits for the one below it, until we reach the base case.' },
        ],
      },
    ],
  };
}

export class MockLiveServer {
  private wss: WebSocketServer | null = null;
  private conns = new Set<Conn>();
  readonly stats: MockStats = { setups: [], audioChunks: 0, audioBytes: 0, videoFrames: 0, texts: [], clientContents: [], toolResponses: [], audioStreamEnds: 0, activityStarts: 0, activityEnds: 0, recentVideo: [] };
  /** Queue of turns for tests; when empty the demo script cycles. */
  readonly queued: MockTurn[] = [];
  /**
   * What the "model" says when a NON_BLOCKING tool result arrives with WHEN_IDLE/INTERRUPT
   * scheduling (e.g. after guide_step reports the student clicked). Function: build from result.
   */
  readonly afterTool = new Map<string, (response: Record<string, unknown>) => MockTurn | null>();
  private script: { greeting: MockTurn; turns: MockTurn[] };
  goAwayAfterMs: number | null = null;
  /** false = only speak queued turns / speakNow (tests that drive the tutor themselves). */
  scripted = process.env.PAIRWISE_MOCK_SCRIPT !== 'none';

  constructor(
    private readonly synth: Synthesizer,
    tutorName = 'Ada',
    private readonly speed = 2,
  ) {
    this.script = demoScript(tutorName);
    if (this.scripted) {
      // Like the real model: say the script a walkthrough or trace hands back, line by line.
      const sayScript = (r: Record<string, unknown>): MockTurn | null => (Array.isArray(r.script) && r.script.length ? { segments: r.script.map((say) => ({ say: String(say) })) } : null);
      this.afterTool.set('explain_on_screen', sayScript);
      this.afterTool.set('trace_code', sayScript);
      // "Show me": react to where the student clicked.
      this.afterTool.set('ask_to_point', (r) => ({
        segments: !r.clicked
          ? [{ say: 'No problem, we can come back to that one.' }]
          : r.on_target === true
            ? [{ say: 'Yes, exactly there!' }, { tool: 'celebrate', args: { message: 'nice!' } }]
            : r.on_target === false
              ? [{ say: 'Not quite. Look a little closer to the middle, and try again.' }]
              : [{ say: 'Got it, I can see your click. In demo mode I can\'t check what is there, but with a key I\'d tell you if that was right.' }],
      }));
    }
  }

  async start(port = 0): Promise<string> {
    this.wss = new WebSocketServer({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => this.wss!.once('listening', () => r()));
    this.wss.on('connection', (ws) => this.onConnection(ws));
    const addr = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${addr.port}/ws/mock.BidiGenerateContent`;
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.ws.close(1001, 'server stopping');
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.wss = null;
  }

  /** Close every connection with a GoAway first (tests reconnection/resumption). */
  goAwayAll(): void {
    for (const c of this.conns) {
      this.send(c, { goAway: { timeLeft: '0.2s' } });
      setTimeout(() => c.ws.close(1000, 'GoAway'), 200);
    }
  }

  /** Pretend the student said `text` (input transcription only, no reply) — e2e scenarios. */
  hear(text: string): void {
    for (const c of this.conns) this.send(c, { serverContent: { inputTranscription: { text } } });
  }

  /** Make the tutor say/do something now (e2e scenarios). */
  speakNow(turn: MockTurn): void {
    for (const c of this.conns) void this.respond(c, turn);
  }

  private onConnection(ws: WsSocket): void {
    const c: Conn = { ws, speaking: false, speechMs: 0, silenceMs: 0, responding: null, turnIndex: 0, handleSeq: 0, frames: 0, waiting: new Map(), open: new Map() };
    this.conns.add(c);
    ws.on('message', (data) => this.onMessage(c, String(data)));
    ws.on('close', () => this.conns.delete(c));
  }

  private send(c: Conn, obj: unknown): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(obj));
  }

  private onMessage(c: Conn, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      c.ws.close(1007, 'invalid JSON');
      return;
    }
    if (msg.setup) {
      const setup = msg.setup as Record<string, unknown>;
      this.stats.setups.push(setup);
      if (!String(setup.model ?? '').startsWith('models/')) {
        c.ws.close(1007, 'model must be "models/{model}"');
        return;
      }
      this.send(c, { setupComplete: {} });
      c.handleSeq += 1;
      this.send(c, { sessionResumptionUpdate: { newHandle: `mock-handle-${c.handleSeq}`, resumable: true } });
      if (this.goAwayAfterMs) {
        const ms = this.goAwayAfterMs;
        setTimeout(() => {
          this.send(c, { goAway: { timeLeft: '0.5s' } });
          setTimeout(() => c.ws.close(1000, 'GoAway'), 500);
        }, ms);
      }
      return;
    }
    if (msg.realtimeInput) {
      const ri = msg.realtimeInput as Record<string, unknown>;
      if (ri.audio) this.onAudio(c, String((ri.audio as { data: string }).data));
      if (ri.video) {
        this.stats.videoFrames += 1;
        c.frames += 1;
        const v = ri.video as { mimeType?: string; data?: string };
        this.stats.recentVideo.push({ mime: v.mimeType ?? 'image/jpeg', data: v.data ?? '' });
        if (this.stats.recentVideo.length > 3) this.stats.recentVideo.shift();
      }
      if (typeof ri.text === 'string') {
        this.stats.texts.push(ri.text);
        void this.onUserTurn(c, ri.text);
      }
      if (ri.audioStreamEnd) {
        this.stats.audioStreamEnds += 1;
        if (c.speechMs > 250) this.endOfSpeech(c);
      }
      if (ri.activityStart) this.stats.activityStarts += 1;
      if (ri.activityEnd) this.stats.activityEnds += 1;
      return;
    }
    if (msg.clientContent) {
      this.stats.clientContents.push(msg.clientContent);
      const cc = msg.clientContent as { turnComplete?: boolean; turns?: { parts?: { text?: string }[] }[] };
      if (cc.turnComplete) {
        const text = cc.turns?.flatMap((t) => t.parts ?? []).map((p) => p.text ?? '').join(' ') ?? '';
        void this.onUserTurn(c, text, true);
      }
      return;
    }
    if (msg.toolResponse) {
      this.stats.toolResponses.push(msg.toolResponse);
      const frs = (msg.toolResponse as { functionResponses?: { id: string; name: string; response?: Record<string, unknown> }[] }).functionResponses ?? [];
      for (const fr of frs) {
        const response = fr.response ?? {};
        const waiter = c.waiting.get(fr.id);
        if (waiter) {
          c.waiting.delete(fr.id);
          waiter(response);
          continue;
        }
        const name = c.open.get(fr.id) ?? fr.name;
        c.open.delete(fr.id);
        const scheduling = String(response.scheduling ?? 'SILENT');
        const follow = this.afterTool.get(name);
        if (follow && (scheduling === 'WHEN_IDLE' || scheduling === 'INTERRUPT')) {
          const turn = follow(response);
          if (turn) {
            if (scheduling === 'INTERRUPT' && c.responding) {
              c.responding.cancelled = true;
              this.send(c, { serverContent: { interrupted: true } });
            }
            const run = () => void this.respond(c, turn);
            // WHEN_IDLE: wait for the current utterance to finish.
            if (scheduling === 'WHEN_IDLE' && c.responding) {
              const started = c.responding;
              const poll = setInterval(() => {
                if (c.responding !== started || started.cancelled) {
                  clearInterval(poll);
                  run();
                }
              }, 50);
            } else run();
          }
        }
      }
    }
  }

  /** Energy VAD on incoming 16 kHz PCM, like the real server's automatic activity detection. */
  private onAudio(c: Conn, b64: string): void {
    const buf = Buffer.from(b64, 'base64');
    this.stats.audioChunks += 1;
    this.stats.audioBytes += buf.length;
    const samples = buf.length / 2;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
      const v = buf.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, samples));
    const ms = (samples / 16000) * 1000;
    if (rms > 0.02) {
      c.silenceMs = 0;
      c.speechMs += ms;
      if (!c.speaking && c.speechMs > 120) {
        c.speaking = true;
        this.send(c, { voiceActivity: { type: 'ACTIVITY_START' } });
        if (c.responding) {
          c.responding.cancelled = true;
          c.responding = null;
          this.send(c, { serverContent: { interrupted: true } });
        }
      }
    } else if (c.speaking) {
      c.silenceMs += ms;
      if (c.silenceMs > 700) this.endOfSpeech(c);
    } else c.speechMs = Math.max(0, c.speechMs - ms);
  }

  private endOfSpeech(c: Conn): void {
    const secs = (c.speechMs / 1000).toFixed(1);
    c.speaking = false;
    c.speechMs = 0;
    c.silenceMs = 0;
    this.send(c, { voiceActivity: { type: 'ACTIVITY_END' } });
    void this.onUserTurn(c, `(you spoke for ${secs}s)`);
  }

  private nextTurn(c: Conn, input: string, isContext: boolean): MockTurn {
    const scenario = /__scenario:(\S+)/.exec(input)?.[1];
    if (scenario) return { segments: [{ say: `Running scenario ${scenario}.` }] };
    if (this.queued.length) return this.queued.shift()!;
    if (!this.scripted) return { segments: [] };
    if (isContext && /session (started|resumed)/i.test(input)) return this.script.greeting;
    // A student drawing comes with its box; circle it back so the demo feels responsive.
    const box = /box \[(\d+), ?(\d+), ?(\d+), ?(\d+)\]/.exec(input);
    if (box) {
      const b = box.slice(1, 5).map(Number);
      return {
        segments: [
          { say: 'Got it, you mean this part right here.' },
          { tool: 'annotate', args: { items: [{ kind: 'circle', target: 'what the student circled', box: b }] } },
          { say: 'In demo mode I can see where you drew, but I can\'t read it. With a Gemini key I\'d explain it.' },
        ],
      };
    }
    const t = this.script.turns[c.turnIndex % this.script.turns.length];
    c.turnIndex += 1;
    return t;
  }

  private async onUserTurn(c: Conn, input: string, isContext = false): Promise<void> {
    if (c.responding) {
      c.responding.cancelled = true;
      this.send(c, { serverContent: { interrupted: true } });
    }
    const turn = this.nextTurn(c, input, isContext);
    if (turn.heard && !isContext) this.send(c, { serverContent: { inputTranscription: { text: turn.heard } } });
    await this.respond(c, turn);
  }

  private async respond(c: Conn, turn: MockTurn): Promise<void> {
    const state = { cancelled: false };
    c.responding = state;
    await sleep(350); // "thinking"
    let toolSeq = 0;
    let outTokens = 0;
    for (let seg of turn.segments) {
      if (state.cancelled) return;
      if ('pause' in seg) {
        await sleep(seg.pause);
        continue;
      }
      if ('tool' in seg) {
        // "$first" = the first source the last blocking lookup returned (demo citations).
        if (seg.args.source === '$first') {
          const first = (c.lastResult?.results as { source?: string }[] | undefined)?.[0]?.source;
          if (!first) continue;
          seg = { ...seg, args: { ...seg.args, source: first } };
        }
        toolSeq += 1;
        const id = `mock-${Date.now().toString(36)}-${toolSeq}`;
        if (toolBehavior(seg.tool) === 'BLOCKING') {
          // Like the real API: a BLOCKING call pauses the model until the response arrives.
          const result = new Promise<Record<string, unknown> | null>((resolve) => {
            c.waiting.set(id, resolve);
            setTimeout(() => {
              if (c.waiting.delete(id)) resolve(null);
            }, 10_000);
          });
          this.send(c, { toolCall: { functionCalls: [{ id, name: seg.tool, args: seg.args }] } });
          c.lastResult = (await result) ?? null;
        } else {
          c.open.set(id, seg.tool);
          this.send(c, { toolCall: { functionCalls: [{ id, name: seg.tool, args: seg.args }] } });
          await sleep(60);
        }
        continue;
      }
      const pcm = (await this.synth(seg.say).catch(() => null)) ?? silence(seg.say);
      const words = seg.say.split(/\s+/);
      const chunkBytes = (SR_OUT * 2) / 10; // 100 ms
      const chunks = Math.max(1, Math.ceil(pcm.length / chunkBytes));
      let wordIdx = 0;
      for (let i = 0; i < chunks; i++) {
        if (state.cancelled) return;
        const part = pcm.subarray(i * chunkBytes, Math.min(pcm.length, (i + 1) * chunkBytes));
        this.send(c, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: part.toString('base64') } }] } } });
        const targetWords = Math.round(((i + 1) / chunks) * words.length);
        if (targetWords > wordIdx) {
          this.send(c, { serverContent: { outputTranscription: { text: `${wordIdx > 0 ? ' ' : ''}${words.slice(wordIdx, targetWords).join(' ')}` } } });
          wordIdx = targetWords;
        }
        outTokens += 2.5;
        await sleep(100 / this.speed);
      }
      this.send(c, { serverContent: { outputTranscription: { text: ' ' } } });
    }
    if (state.cancelled) return;
    this.send(c, { serverContent: { generationComplete: true } });
    this.send(c, {
      serverContent: { turnComplete: true },
      usageMetadata: {
        promptTokenCount: 1200 + c.frames * 70,
        responseTokenCount: Math.round(outTokens),
        totalTokenCount: 1200 + c.frames * 70 + Math.round(outTokens),
        promptTokensDetails: [
          { modality: 'TEXT', tokenCount: 1200 },
          { modality: 'IMAGE', tokenCount: c.frames * 70 },
        ],
        responseTokensDetails: [{ modality: 'AUDIO', tokenCount: Math.round(outTokens) }],
      },
    });
    if (c.responding === state) c.responding = null;
    log.debug('mock turn complete');
  }
}

/** Silence of roughly the time it takes to say `text` (no speech synthesizer available). */
function silence(text: string): Buffer {
  const secs = Math.max(0.6, text.split(/\s+/).length / 2.8);
  return Buffer.alloc(Math.round(secs * SR_OUT) * 2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
