import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveClient, type FunctionCall } from '../../src/main/gemini/live';
import { MockLiveServer } from '../../src/main/gemini/mock-live';
import { LiveLink } from '../../src/main/session/live-link';

/**
 * Protocol tests: our Live client against the local mock that implements the documented
 * BidiGenerateContent wire format (setup → setupComplete, realtimeInput audio/video/text,
 * serverContent audio + transcriptions, interruption, tool calls, usage, GoAway + resumption).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setup = (handle?: string) => ({
  model: 'models/gemini-3.8-live',
  generationConfig: { responseModalities: ['AUDIO' as const], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
  systemInstruction: { parts: [{ text: 'test' }] },
  tools: [{ functionDeclarations: [{ name: 'point_at', behavior: 'NON_BLOCKING' }] }],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  sessionResumption: handle ? { handle } : {},
  contextWindowCompression: { slidingWindow: {} },
});

/** 16 kHz PCM: a noisy "voice" burst (speech-like energy) followed by silence. */
function speech(ms: number, amp = 0.2): Uint8Array {
  const n = Math.round((16000 * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 3.1) * amp * 32767 * (0.6 + Math.random() * 0.4)), i * 2);
  return new Uint8Array(buf);
}
const silence = (ms: number) => new Uint8Array(Math.round((16000 * ms) / 1000) * 2);

async function stream(client: { sendAudio(p: Uint8Array): void }, pcm: Uint8Array) {
  for (let i = 0; i < pcm.length; i += 1280) {
    client.sendAudio(pcm.subarray(i, i + 1280));
    await sleep(8);
  }
}

let server: MockLiveServer;
let url: string;

beforeEach(async () => {
  server = new MockLiveServer(async () => null, 'Ada', 20);
  url = await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('LiveClient ↔ mock Live server', () => {
  it('completes setup with the documented message shape', async () => {
    const c = new LiveClient(url);
    await c.connect(setup());
    expect(c.ready).toBe(true);
    const s = server.stats.setups[0] as Record<string, unknown>;
    expect(s.model).toBe('models/gemini-3.8-live');
    expect((s.generationConfig as Record<string, unknown>).responseModalities).toEqual(['AUDIO']);
    expect(s.inputAudioTranscription).toEqual({});
    c.close();
  });

  it('rejects a malformed model name with a readable error', async () => {
    const c = new LiveClient(url);
    await expect(c.connect({ ...setup(), model: 'gemini-3.8-live' })).rejects.toThrow(/model/);
  });

  it('streams a spoken reply with captions and usage after an opening turn', async () => {
    const c = new LiveClient(url);
    await c.connect(setup());
    const audio: Buffer[] = [];
    const words: string[] = [];
    let usage: unknown = null;
    c.on('audio', (b: Buffer) => audio.push(b));
    c.on('outputTranscript', (t: string) => words.push(t));
    c.on('usage', (u: unknown) => (usage = u));
    const done = new Promise<void>((r) => c.once('turnComplete', () => r()));
    c.sendClientContent([{ role: 'user', parts: [{ text: '[Session started at 4:12 PM.] Greet them.' }] }], true);
    await done;
    expect(audio.length).toBeGreaterThan(3);
    expect(words.join('').trim()).toMatch(/^Hi! I'm Ada/);
    expect(usage).toMatchObject({ responseTokensDetails: [{ modality: 'AUDIO' }] });
    c.close();
  });

  it('hears the student (server VAD), transcribes and answers', async () => {
    const c = new LiveClient(url);
    await c.connect(setup());
    const events: string[] = [];
    c.on('voiceActivity', (k: string) => events.push(`vad-${k}`));
    c.on('inputTranscript', () => events.push('heard'));
    const replied = new Promise<void>((r) => c.once('turnComplete', () => r()));
    await stream(c, speech(900));
    await stream(c, silence(900));
    await replied;
    expect(events).toEqual(expect.arrayContaining(['vad-start', 'vad-end', 'heard']));
    expect(server.stats.audioChunks).toBeGreaterThan(20);
    c.close();
  });

  it('is interrupted when the student talks over the tutor', async () => {
    const c = new LiveClient(url);
    await c.connect(setup());
    server.queued.push({ segments: [{ say: 'This is a long explanation that keeps going for a while so the student can cut in and interrupt it right in the middle of the sentence.' }] });
    let interrupted = false;
    let audioAfter = 0;
    c.on('interrupted', () => (interrupted = true));
    c.on('audio', () => interrupted && audioAfter++);
    c.sendText('explain please');
    await new Promise<void>((r) => c.once('audio', () => r()));
    await stream(c, speech(500));
    await sleep(300);
    expect(interrupted).toBe(true);
    expect(audioAfter).toBe(0);
    c.close();
  });

  it('delivers tool calls and accepts scheduled tool responses', async () => {
    const c = new LiveClient(url);
    await c.connect(setup());
    server.queued.push({ segments: [{ say: 'See this?' }, { tool: 'point_at', args: { target: 'Run button', x: 120, y: 40 } }] });
    const call = await new Promise<FunctionCall>((r) => {
      c.on('toolCall', (calls: FunctionCall[]) => r(calls[0]));
      c.sendText('where is run');
    });
    expect(call.name).toBe('point_at');
    expect(call.args).toMatchObject({ target: 'Run button', x: 120 });
    c.sendToolResponses([{ id: call.id, name: call.name, response: { ok: true }, scheduling: 'SILENT' }]);
    await sleep(100);
    const fr = (server.stats.toolResponses[0] as { functionResponses: Record<string, unknown>[] }).functionResponses[0];
    expect(fr).toMatchObject({ id: call.id, name: 'point_at', response: { ok: true, scheduling: 'SILENT' } });
    // Only documented FunctionResponse fields go on the wire (unknown fields can fail the session).
    expect(Object.keys(fr).sort()).toEqual(['id', 'name', 'response']);
    c.close();
  });

  it('sends video frames as realtimeInput.video', async () => {
    const c = new LiveClient(url);
    await c.connect(setup());
    c.sendVideo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg');
    await sleep(100);
    expect(server.stats.videoFrames).toBe(1);
    c.close();
  });
});

describe('LiveLink reconnection', () => {
  it('reconnects after GoAway using the latest resumption handle', async () => {
    const link = new LiveLink(() => url, (h) => setup(h));
    const statuses: string[] = [];
    link.on('status', (s: string) => statuses.push(s));
    await link.open();
    expect(link.resumptionHandle).toBe('mock-handle-1');
    const reconnected = new Promise<void>((r) => link.once('reconnected', () => r()));
    server.goAwayAll();
    await reconnected;
    expect(statuses).toEqual(expect.arrayContaining(['connecting', 'open', 'reconnecting']));
    const second = server.stats.setups[1] as { sessionResumption?: { handle?: string } };
    expect(second.sessionResumption?.handle).toBe('mock-handle-1');
    expect(link.ready).toBe(true);
    link.close();
  });

  it('rides out a dropped connection: keeps trying until the server is back, then says how long it was gone', async () => {
    const port = Number(new URL(url).port);
    const link = new LiveLink(() => url, (h) => setup(h));
    await link.open();
    const back = new Promise<number>((r) => link.once('reconnected', (ms: number) => r(ms)));
    let fatal = false;
    link.on('fatal', () => (fatal = true));
    await server.stop(); // the Wi-Fi goes
    await sleep(1600);
    expect(link.status).toBe('reconnecting');
    server = new MockLiveServer(async () => null, 'Ada', 20);
    await server.start(port); // …and comes back
    const down = await back;
    expect(fatal).toBe(false);
    expect(down).toBeGreaterThan(1400);
    expect(link.ready).toBe(true);
    const resumed = server.stats.setups[0] as { sessionResumption?: { handle?: string } };
    expect(resumed.sessionResumption?.handle).toBe('mock-handle-1'); // the same conversation
    link.close();
  }, 20_000);

  it('waits while the Mac is offline instead of using up attempts', async () => {
    let online = true;
    const link = new LiveLink(() => url, (h) => setup(h), { online: () => online });
    await link.open();
    const setups = () => server.stats.setups.length;
    const before = setups();
    online = false;
    const back = new Promise<void>((r) => link.once('reconnected', () => r()));
    // An abrupt drop (no close handshake), like a network going away.
    for (const c of [...(server as unknown as { conns: Set<{ ws: { terminate(): void } }> }).conns]) c.ws.terminate();
    await sleep(1500);
    expect(setups()).toBe(before); // no attempts while offline
    online = true;
    await back;
    expect(setups()).toBe(before + 1);
    link.close();
  }, 20_000);

  it('gives up (and says so) only after the time limit', async () => {
    const link = new LiveLink(() => url, (h) => setup(h), { giveUpAfterMs: 1800 });
    await link.open();
    const t0 = Date.now();
    const gone = new Promise<number>((r) => link.once('fatal', () => r(Date.now() - t0)));
    await server.stop();
    const ms = await gone;
    expect(ms).toBeGreaterThan(900);
    expect(ms).toBeLessThan(3500);
    expect(link.status).toBe('closed');
    server = new MockLiveServer(async () => null, 'Ada', 20);
    await server.start();
  }, 20_000);

  it('falls back to a fresh session when the resume handle is rejected', async () => {
    // A server that refuses resumption: close on setup with a handle.
    const link = new LiveLink(() => url, (h) => (h === 'stale' ? { ...setup(h), model: 'bad' } : setup(h)));
    await link.open('stale');
    expect(link.ready).toBe(true);
    link.close();
  });
});
