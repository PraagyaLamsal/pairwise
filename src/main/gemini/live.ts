import { EventEmitter } from 'node:events';
import type { UsageMetadata } from '@shared/pricing';
import { logger, redact } from '../log';

const log = logger('live');

/** JSON shapes of the Live API (BidiGenerateContent, v1beta). Field names are the wire names. */
export interface LiveSetup {
  model: string;
  generationConfig?: {
    responseModalities?: ('AUDIO' | 'TEXT')[];
    speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName: string } }; languageCode?: string };
    mediaResolution?: string;
    temperature?: number;
    thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean };
  };
  systemInstruction?: { parts: { text: string }[] };
  tools?: Record<string, unknown>[];
  realtimeInputConfig?: {
    automaticActivityDetection?: {
      disabled?: boolean;
      startOfSpeechSensitivity?: 'START_SENSITIVITY_HIGH' | 'START_SENSITIVITY_LOW';
      endOfSpeechSensitivity?: 'END_SENSITIVITY_HIGH' | 'END_SENSITIVITY_LOW';
      prefixPaddingMs?: number;
      silenceDurationMs?: number;
    };
    activityHandling?: 'START_OF_ACTIVITY_INTERRUPTS' | 'NO_INTERRUPTION';
    turnCoverage?: 'TURN_INCLUDES_ONLY_ACTIVITY' | 'TURN_INCLUDES_ALL_INPUT' | 'TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO';
  };
  sessionResumption?: { handle?: string };
  contextWindowCompression?: { slidingWindow?: { targetTokens?: number }; triggerTokens?: number };
  inputAudioTranscription?: Record<string, unknown>;
  outputAudioTranscription?: Record<string, unknown>;
}

export interface FunctionCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface FunctionResponse {
  id: string;
  name: string;
  response: Record<string, unknown>;
  /**
   * How a NON_BLOCKING result is delivered: SILENT (use it later, say nothing), WHEN_IDLE (react
   * once the current utterance ends), INTERRUPT (react now). Sent inside `response`, as the Live
   * API docs show.
   */
  scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT';
}

export interface ContentPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface ServerMessage {
  setupComplete?: Record<string, never>;
  serverContent?: {
    modelTurn?: { parts?: (ContentPart & { thought?: boolean })[] };
    turnComplete?: boolean;
    generationComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string };
    interimInputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    waitingForInput?: boolean;
    interactionStatus?: string;
  };
  toolCall?: { functionCalls?: FunctionCall[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  usageMetadata?: UsageMetadata;
  voiceActivity?: { type?: string };
  error?: { message?: string };
}

/**
 * Events:
 *  open · setupComplete · audio(Buffer pcm24k) · inputTranscript(text) · interimTranscript(text) · outputTranscript(text)
 *  text(text) · interrupted · generationComplete · turnComplete · waitingForInput
 *  toolCall(FunctionCall[]) · toolCancel(ids) · goAway(ms) · resumption(handle)
 *  usage(UsageMetadata) · voiceActivity('start'|'end') · close({ code, reason }) · error(Error)
 */
export class LiveClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private setupDone = false;
  private closedByUs = false;
  private sentBytes = 0;

  constructor(private readonly url: string) {
    super();
  }

  get ready(): boolean {
    return this.setupDone && this.ws?.readyState === WebSocket.OPEN;
  }

  get bytesSent(): number {
    return this.sentBytes;
  }

  /** Opens the socket, sends `setup`, resolves on `setupComplete`. */
  connect(setup: LiveSetup, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error('Timed out connecting to Gemini Live')), timeoutMs);
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        clearTimeout(timer);
        fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.emit('open');
        this.sendRaw({ setup });
      };
      ws.onmessage = (ev) => {
        const msg = this.parse(ev.data);
        if (!msg) return;
        if (msg.setupComplete && !this.setupDone) {
          this.setupDone = true;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
          this.emit('setupComplete');
          return;
        }
        this.handle(msg);
      };
      ws.onerror = () => {
        // Node's WebSocket error event carries no detail; a close event usually follows with
        // it — but not when the connection never opened (refused, no network, DNS): fail fast
        // then instead of waiting out the timeout.
        if (this.setupDone) return;
        setTimeout(() => {
          if (settled) return;
          clearTimeout(timer);
          fail(new Error("Couldn't reach Gemini Live (network error)"));
        }, 250);
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        const info = { code: ev.code, reason: ev.reason || '' };
        if (!this.setupDone) fail(new Error(describeClose(info.code, info.reason)));
        this.setupDone = false;
        this.ws = null;
        if (!this.closedByUs) log.warn(`live socket closed ${info.code} ${redact(info.reason)}`);
        this.emit('close', { ...info, byUs: this.closedByUs });
      };
    });
  }

  close(): void {
    this.closedByUs = true;
    try {
      this.ws?.close(1000, 'client closed');
    } catch {
      /* ignore */
    }
  }

  // --- client → server ---------------------------------------------------------------

  sendAudio(pcm16k: Uint8Array): void {
    this.sendRaw({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(pcm16k).toString('base64') } } });
  }

  sendVideo(image: Uint8Array, mimeType = 'image/jpeg'): void {
    this.sendRaw({ realtimeInput: { video: { mimeType, data: Buffer.from(image).toString('base64') } } });
  }

  /** Text as if the student said it (triggers a response). */
  sendText(text: string): void {
    this.sendRaw({ realtimeInput: { text } });
  }

  /** Ordered context. turnComplete=false adds context without asking for a reply. */
  sendClientContent(turns: { role: 'user' | 'model'; parts: ContentPart[] }[], turnComplete: boolean): void {
    this.sendRaw({ clientContent: { turns, turnComplete } });
  }

  audioStreamEnd(): void {
    this.sendRaw({ realtimeInput: { audioStreamEnd: true } });
  }

  activityStart(): void {
    this.sendRaw({ realtimeInput: { activityStart: {} } });
  }

  activityEnd(): void {
    this.sendRaw({ realtimeInput: { activityEnd: {} } });
  }

  sendToolResponses(responses: FunctionResponse[]): void {
    if (!responses.length) return;
    this.sendRaw({
      toolResponse: {
        functionResponses: responses.map((r) => ({
          id: r.id,
          name: r.name,
          // The Live API reads `scheduling` from inside the response object (docs: live-tools).
          response: r.scheduling ? { ...r.response, scheduling: r.scheduling } : r.response,
        })),
      },
    });
  }

  private sendRaw(obj: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const s = JSON.stringify(obj);
    this.sentBytes += s.length;
    ws.send(s);
  }

  // --- server → client ---------------------------------------------------------------

  private parse(data: unknown): ServerMessage | null {
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
      return JSON.parse(text) as ServerMessage;
    } catch (e) {
      log.warn('unparseable live message', e);
      return null;
    }
  }

  private handle(msg: ServerMessage): void {
    if (msg.usageMetadata) this.emit('usage', msg.usageMetadata);
    if (msg.voiceActivity?.type === 'ACTIVITY_START') this.emit('voiceActivity', 'start');
    if (msg.voiceActivity?.type === 'ACTIVITY_END') this.emit('voiceActivity', 'end');
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interimInputTranscription?.text) this.emit('interimTranscript', sc.interimInputTranscription.text);
      if (sc.inputTranscription?.text) this.emit('inputTranscript', sc.inputTranscription.text);
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.thought) continue;
        if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
          this.emit('audio', Buffer.from(part.inlineData.data, 'base64'));
        } else if (part.text) this.emit('text', part.text);
      }
      if (sc.outputTranscription?.text) this.emit('outputTranscript', sc.outputTranscription.text);
      if (sc.interrupted) this.emit('interrupted');
      if (sc.generationComplete) this.emit('generationComplete');
      if (sc.waitingForInput) this.emit('waitingForInput');
      if (sc.turnComplete) this.emit('turnComplete');
    }
    if (msg.toolCall?.functionCalls?.length) this.emit('toolCall', msg.toolCall.functionCalls);
    if (msg.toolCallCancellation?.ids?.length) this.emit('toolCancel', msg.toolCallCancellation.ids);
    if (msg.goAway) this.emit('goAway', parseDuration(msg.goAway.timeLeft));
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) this.emit('resumption', msg.sessionResumptionUpdate.newHandle);
    if (msg.error) this.emit('error', new Error(msg.error.message ?? 'Live API error'));
  }
}

/** "12.5s" → 12500 */
export function parseDuration(d?: string): number {
  if (!d) return 0;
  const m = /^([\d.]+)s$/.exec(d.trim());
  return m ? Math.round(parseFloat(m[1]) * 1000) : 0;
}

export function describeClose(code: number, reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('api key') || r.includes('api_key') || code === 1008 && r.includes('key')) return 'Gemini rejected the API key. Check it in Settings → Gemini.';
  if (r.includes('not found') && r.includes('model')) return `The live model isn't available for this key (${reason}). Check Settings → Gemini → models.`;
  if (r.includes('quota') || r.includes('exhausted')) return 'Gemini quota exhausted for this key.';
  if (r.includes('permission')) return `Gemini refused the request: ${reason}`;
  if (code === 1006) return 'Could not reach Gemini (network).';
  return reason ? `Gemini closed the connection: ${reason}` : `Gemini closed the connection (code ${code}).`;
}

export function liveUrl(base: string, path: string, apiKey: string): string {
  const u = base.replace(/^http/, 'ws').replace(/\/$/, '');
  return `${u}${path}${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
}
