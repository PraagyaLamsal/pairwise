import type { Modality, UsageMetadata } from '@shared/pricing';
import { logger } from '../log';

const log = logger('gemini');

export interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface Content {
  role?: 'user' | 'model';
  parts: Part[];
}

export interface GenerateRequest {
  contents: Content[];
  systemInstruction?: { parts: Part[] };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
    thinkingConfig?: { thinkingLevel?: 'low' | 'medium' | 'high'; includeThoughts?: boolean };
    mediaResolution?: string;
  };
}

export interface GenerateResult {
  text: string;
  usage?: UsageMetadata;
  model: string;
  ms: number;
}

export type UsageSink = (model: string, usage: UsageMetadata, fallback: { input: Modality; output: Modality }) => void;

export class GeminiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Minimal REST client for generateContent / embeddings (stateless, nothing stored server-side). */
export class GeminiRest {
  constructor(
    private readonly apiKey: () => string,
    private readonly base: string,
    private readonly onUsage: UsageSink,
  ) {}

  get hasKey(): boolean {
    return Boolean(this.apiKey());
  }

  private async call<T>(path: string, body: unknown | null, timeoutMs: number, attempt = 0): Promise<T> {
    const key = this.apiKey();
    if (!key) throw new GeminiError('No Gemini API key configured', 401);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: body === null ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: body === null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
        } catch {
          /* not json */
        }
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1) ** 2));
          return this.call<T>(path, body, timeoutMs, attempt + 1);
        }
        throw new GeminiError(message || `HTTP ${res.status}`, res.status);
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof GeminiError) throw e;
      if ((e as Error).name === 'AbortError') throw new GeminiError(`Gemini request timed out after ${timeoutMs} ms`, 408);
      throw new GeminiError(`Network error talking to Gemini: ${(e as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(): Promise<string[]> {
    const r = await this.call<{ models?: { name: string }[] }>('/v1beta/models?pageSize=200', null, 10_000);
    return (r.models ?? []).map((m) => m.name.replace(/^models\//, ''));
  }

  async generate(model: string, req: GenerateRequest, opts: { timeoutMs?: number; inputModality?: Modality } = {}): Promise<GenerateResult> {
    const t0 = Date.now();
    const r = await this.call<{
      candidates?: { content?: { parts?: (Part & { thought?: boolean })[] }; finishReason?: string }[];
      usageMetadata?: UsageMetadata;
      promptFeedback?: { blockReason?: string };
    }>(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, req, opts.timeoutMs ?? 30_000);
    if (r.usageMetadata) this.onUsage(model, r.usageMetadata, { input: opts.inputModality ?? 'TEXT', output: 'TEXT' });
    if (r.promptFeedback?.blockReason) throw new GeminiError(`Request blocked: ${r.promptFeedback.blockReason}`, 400);
    const text = (r.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought && p.text)
      .map((p) => p.text)
      .join('');
    const ms = Date.now() - t0;
    log.debug(`${model} ${ms}ms`);
    return { text, usage: r.usageMetadata, model, ms };
  }

  async generateJson<T>(model: string, req: GenerateRequest, opts: { timeoutMs?: number; inputModality?: Modality } = {}): Promise<T> {
    const r = await this.generate(model, { ...req, generationConfig: { responseMimeType: 'application/json', ...req.generationConfig } }, opts);
    return parseJsonLoose<T>(r.text);
  }

  async embed(model: string, texts: string[], taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY', dims = 768): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const r = await this.call<{ embeddings?: { values: number[] }[] }>(
        `/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
        {
          requests: batch.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: dims,
          })),
        },
        60_000,
      );
      const approxTokens = batch.reduce((a, t) => a + Math.ceil(t.length / 4), 0);
      this.onUsage(model, { promptTokenCount: approxTokens }, { input: 'TEXT', output: 'TEXT' });
      for (const e of r.embeddings ?? []) out.push(e.values);
    }
    return out;
  }
}

/** Parses JSON that may be wrapped in ``` fences or have leading prose. */
export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new GeminiError(`Model did not return JSON: ${trimmed.slice(0, 120)}`, 502);
  }
}
