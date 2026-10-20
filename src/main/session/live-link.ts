import { EventEmitter } from 'node:events';
import { LiveClient, type ContentPart, type FunctionResponse, type LiveSetup } from '../gemini/live';
import { logger } from '../log';

const log = logger('live-link');

const FORWARDED = [
  'audio', 'inputTranscript', 'interimTranscript', 'outputTranscript', 'text', 'interrupted', 'generationComplete',
  'turnComplete', 'waitingForInput', 'toolCall', 'toolCancel', 'usage', 'voiceActivity', 'error',
] as const;

export type LinkStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * One logical Live session across many WebSocket connections: connections last ~10 minutes, so
 * on GoAway (or an unexpected drop) we reconnect with the latest session-resumption handle and
 * the conversation continues where it was. Emits the LiveClient events plus 'status'.
 */
export class LiveLink extends EventEmitter {
  private client: LiveClient | null = null;
  private handle: string | undefined;
  private _status: LinkStatus = 'idle';
  private closing = false;
  private attempts = 0;
  reconnects = 0;

  constructor(
    private readonly url: () => string,
    private readonly setup: (handle?: string) => LiveSetup,
  ) {
    super();
  }

  get status(): LinkStatus {
    return this._status;
  }

  get resumptionHandle(): string | undefined {
    return this.handle;
  }

  get ready(): boolean {
    return this._status === 'open' && Boolean(this.client?.ready);
  }

  async open(resumeHandle?: string): Promise<void> {
    this.closing = false;
    this.handle = resumeHandle;
    this.setStatus('connecting');
    try {
      await this.connect();
    } catch (e) {
      if (resumeHandle) {
        // A stale handle (older than ~2 h) fails; start fresh instead.
        log.warn('resume handle rejected; starting a fresh session');
        this.handle = undefined;
        await this.connect();
      } else throw e;
    }
  }

  private async connect(): Promise<void> {
    const client = new LiveClient(this.url());
    for (const ev of FORWARDED) client.on(ev, (...args: unknown[]) => this.emit(ev, ...args));
    client.on('resumption', (h: string) => {
      this.handle = h;
      this.emit('resumption', h);
    });
    client.on('goAway', (ms: number) => {
      log.info(`GoAway (${ms} ms left) — reconnecting with resumption`);
      void this.reconnect('goaway');
    });
    client.on('close', (info: { code: number; reason: string; byUs: boolean }) => {
      if (client !== this.client) return;
      if (this.closing || info.byUs) {
        this.setStatus('closed');
        return;
      }
      void this.reconnect(`closed ${info.code}`);
    });
    await client.connect(this.setup(this.handle));
    const old = this.client;
    this.client = client;
    this.attempts = 0;
    this.setStatus('open');
    if (old && old !== client) old.close();
  }

  private reconnecting = false;

  private async reconnect(reason: string): Promise<void> {
    if (this.closing || this.reconnecting) return;
    this.reconnecting = true;
    this.reconnects += 1;
    this.setStatus('reconnecting');
    try {
      while (!this.closing) {
        const delay = this.attempts === 0 ? 0 : Math.min(8000, 500 * 2 ** (this.attempts - 1));
        this.attempts += 1;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        try {
          await this.connect();
          log.info(`reconnected after ${reason}`);
          this.emit('reconnected');
          return;
        } catch (e) {
          log.warn(`reconnect attempt ${this.attempts} failed`, e);
          if (this.attempts === 2) this.handle = this.handle ?? undefined;
          if (this.attempts >= 6) {
            this.setStatus('closed');
            this.emit('fatal', e instanceof Error ? e : new Error(String(e)));
            return;
          }
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  close(): void {
    this.closing = true;
    this.client?.close();
    this.client = null;
    this.setStatus('closed');
  }

  private setStatus(s: LinkStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.emit('status', s);
  }

  // --- pass-through senders (no-ops while reconnecting) --------------------------------
  sendAudio(pcm: Uint8Array): void {
    if (this.ready) this.client!.sendAudio(pcm);
  }
  sendVideo(img: Uint8Array, mime: string): void {
    if (this.ready) this.client!.sendVideo(img, mime);
  }
  sendText(text: string): void {
    if (this.ready) this.client!.sendText(text);
  }
  sendContext(text: string, turnComplete = false, image?: { mime: string; data: Uint8Array }): void {
    if (!this.ready) return;
    const parts: ContentPart[] = [{ text }];
    if (image) parts.push({ inlineData: { mimeType: image.mime, data: Buffer.from(image.data).toString('base64') } });
    this.client!.sendClientContent([{ role: 'user', parts }], turnComplete);
  }
  audioStreamEnd(): void {
    if (this.ready) this.client!.audioStreamEnd();
  }
  sendToolResponses(r: FunctionResponse[]): void {
    if (this.ready) this.client!.sendToolResponses(r);
  }
}
