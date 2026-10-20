/**
 * Gemini API paid-tier prices in USD per 1M tokens, copied from
 * https://ai.google.dev/gemini-api/docs/pricing on 2026-10-19. Several prices change on a
 * fixed date, so each model has a dated schedule. Edit here if Google changes prices.
 */
export type Modality = 'TEXT' | 'AUDIO' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';

interface PriceRow {
  /** First day (UTC, inclusive) this row applies. */
  from: string;
  input: Partial<Record<Modality, number>> & { default: number };
  output: Partial<Record<Modality, number>> & { default: number };
}

export const PRICE_TABLE: Record<string, PriceRow[]> = {
  'gemini-3.8-live': [
    { from: '2026-01-01', input: { default: 0.75, TEXT: 0.75, AUDIO: 3.0, IMAGE: 1.0, VIDEO: 1.0 }, output: { default: 4.5, TEXT: 4.5, AUDIO: 12.0 } },
  ],
  'gemini-3.8-live-extended-thinking': [
    { from: '2026-01-01', input: { default: 0.75, TEXT: 0.75, AUDIO: 3.0, IMAGE: 1.0, VIDEO: 1.0 }, output: { default: 4.5, TEXT: 4.5, AUDIO: 12.0 } },
  ],
  'gemini-3.8-flash': [
    { from: '2026-01-01', input: { default: 0.75 }, output: { default: 3.75 } },
    { from: '2027-01-01', input: { default: 1.5 }, output: { default: 7.5 } },
  ],
  'gemini-3.6-flash': [
    { from: '2026-01-01', input: { default: 0.75 }, output: { default: 3.75 } },
    { from: '2027-01-01', input: { default: 1.5 }, output: { default: 7.5 } },
  ],
  'gemini-4-argon': [
    { from: '2026-01-01', input: { default: 2.0 }, output: { default: 10.0 } },
    { from: '2026-12-01', input: { default: 4.0 }, output: { default: 20.0 } },
  ],
  'gemini-3.5-flash-lite': [{ from: '2026-01-01', input: { default: 0.3 }, output: { default: 2.5 } }],
  // Embedding price not visible on the fetched page; this is the long-standing list price. Verify.
  'gemini-embedding-001': [{ from: '2025-01-01', input: { default: 0.15 }, output: { default: 0 } }],
  'gemini-embedding-2-preview': [{ from: '2026-01-01', input: { default: 0.2 }, output: { default: 0 } }],
};

/** Unknown models are priced like the most expensive Flash row so the budget errs on the safe side. */
const FALLBACK: PriceRow = { from: '2026-01-01', input: { default: 2.0, AUDIO: 3.0 }, output: { default: 12.0 } };

export function priceRowFor(model: string, at: Date = new Date()): PriceRow {
  const id = model.replace(/^models\//, '');
  const rows = PRICE_TABLE[id];
  if (!rows) return FALLBACK;
  const day = at.toISOString().slice(0, 10);
  let row = rows[0];
  for (const r of rows) if (r.from <= day) row = r;
  return row;
}

export interface ModalityCount {
  modality?: string;
  tokenCount?: number;
}

/** Shape of Gemini `usageMetadata` (both Live and generateContent). */
export interface UsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  responseTokenCount?: number;
  candidatesTokenCount?: number;
  toolUsePromptTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  promptTokensDetails?: ModalityCount[];
  responseTokensDetails?: ModalityCount[];
  candidatesTokensDetails?: ModalityCount[];
}

export interface CostBreakdown {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  byModality: Partial<Record<Modality, number>>;
}

const asModality = (m?: string): Modality => {
  const up = (m ?? 'TEXT').toUpperCase();
  return (['TEXT', 'AUDIO', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(up) ? up : 'TEXT') as Modality;
};

/**
 * Price one usage record. Uses the per-modality details when present; otherwise falls back to
 * the aggregate counts with the modality the caller says is typical for this call.
 */
export function costOf(
  model: string,
  usage: UsageMetadata,
  at: Date = new Date(),
  fallbackModality: { input: Modality; output: Modality } = { input: 'TEXT', output: 'TEXT' },
): CostBreakdown {
  const row = priceRowFor(model, at);
  const inPrice = (m: Modality) => row.input[m] ?? row.input.default;
  const outPrice = (m: Modality) => row.output[m] ?? row.output.default;
  const byModality: Partial<Record<Modality, number>> = {};
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const promptDetails = usage.promptTokensDetails?.filter((d) => (d.tokenCount ?? 0) > 0) ?? [];
  if (promptDetails.length) {
    for (const d of promptDetails) {
      const m = asModality(d.modality);
      const n = d.tokenCount ?? 0;
      usd += (n / 1e6) * inPrice(m);
      inputTokens += n;
      byModality[m] = (byModality[m] ?? 0) + n;
    }
  } else if (usage.promptTokenCount) {
    const n = usage.promptTokenCount;
    usd += (n / 1e6) * inPrice(fallbackModality.input);
    inputTokens += n;
    byModality[fallbackModality.input] = (byModality[fallbackModality.input] ?? 0) + n;
  }

  if (usage.toolUsePromptTokenCount) {
    usd += (usage.toolUsePromptTokenCount / 1e6) * inPrice('TEXT');
    inputTokens += usage.toolUsePromptTokenCount;
  }

  const respDetails = (usage.responseTokensDetails ?? usage.candidatesTokensDetails)?.filter((d) => (d.tokenCount ?? 0) > 0) ?? [];
  if (respDetails.length) {
    for (const d of respDetails) {
      const m = asModality(d.modality);
      const n = d.tokenCount ?? 0;
      usd += (n / 1e6) * outPrice(m);
      outputTokens += n;
      byModality[m] = (byModality[m] ?? 0) + n;
    }
  } else {
    const n = usage.responseTokenCount ?? usage.candidatesTokenCount ?? 0;
    if (n) {
      usd += (n / 1e6) * outPrice(fallbackModality.output);
      outputTokens += n;
      byModality[fallbackModality.output] = (byModality[fallbackModality.output] ?? 0) + n;
    }
  }

  if (usage.thoughtsTokenCount) {
    usd += (usage.thoughtsTokenCount / 1e6) * outPrice('TEXT');
    outputTokens += usage.thoughtsTokenCount;
  }

  return { usd, inputTokens, outputTokens, byModality };
}

export function formatUsd(v: number): string {
  if (v < 0.01) return v === 0 ? '$0.00' : '<$0.01';
  if (v < 10) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(0)}`;
}
