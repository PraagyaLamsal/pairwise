import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { costOf, type Modality, type UsageMetadata } from '@shared/pricing';
import type { UsageSummary } from '@shared/session';
import { DebouncedJsonFile, readJson } from './store/json-store';

interface MonthBucket {
  usd: number;
  byModel: Record<string, { usd: number; tokens: number }>;
  byDay: Record<string, number>;
}

interface UsageFile {
  months: Record<string, MonthBucket>;
}

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Prices every Gemini call (Live usageMetadata and REST responses) with the dated price table
 * and keeps per-month totals for the budget cap.
 */
export class UsageMeter extends EventEmitter {
  private data: UsageFile;
  private readonly file: DebouncedJsonFile<UsageFile>;
  private sessionUsd = 0;

  constructor(dataDir: string, private readonly limit: () => { monthlyLimitUsd: number; warnAtPercent: number; hardStop: boolean }) {
    super();
    const path = join(dataDir, 'usage.json');
    this.data = readJson<UsageFile>(path, { months: {} });
    if (!this.data.months) this.data.months = {};
    this.file = new DebouncedJsonFile<UsageFile>(path, 1000);
  }

  record(model: string, usage: UsageMetadata, fallback?: { input: Modality; output: Modality }, at = new Date()): number {
    const c = costOf(model, usage, at, fallback);
    if (c.usd <= 0 && c.inputTokens + c.outputTokens === 0) return 0;
    const mk = monthKey(at);
    const bucket = (this.data.months[mk] ??= { usd: 0, byModel: {}, byDay: {} });
    bucket.usd += c.usd;
    const m = (bucket.byModel[model] ??= { usd: 0, tokens: 0 });
    m.usd += c.usd;
    m.tokens += c.inputTokens + c.outputTokens;
    const dk = dayKey(at);
    bucket.byDay[dk] = (bucket.byDay[dk] ?? 0) + c.usd;
    this.sessionUsd += c.usd;
    this.file.write(this.data);
    this.emit('changed', this.summary());
    return c.usd;
  }

  resetSession(): void {
    this.sessionUsd = 0;
  }

  get sessionCost(): number {
    return this.sessionUsd;
  }

  summary(): UsageSummary {
    const { monthlyLimitUsd, warnAtPercent, hardStop } = this.limit();
    const mk = monthKey();
    const bucket = this.data.months[mk] ?? { usd: 0, byModel: {}, byDay: {} };
    const percent = monthlyLimitUsd > 0 ? (bucket.usd / monthlyLimitUsd) * 100 : 0;
    return {
      monthKey: mk,
      monthUsd: bucket.usd,
      limitUsd: monthlyLimitUsd,
      percent,
      todayUsd: bucket.byDay[dayKey()] ?? 0,
      sessionUsd: this.sessionUsd,
      byModel: Object.entries(bucket.byModel)
        .map(([model, v]) => ({ model, usd: v.usd, tokens: v.tokens }))
        .sort((a, b) => b.usd - a.usd),
      byDay: Object.entries(bucket.byDay)
        .map(([day, usd]) => ({ day, usd }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      blocked: hardStop && monthlyLimitUsd > 0 && bucket.usd >= monthlyLimitUsd,
      warn: monthlyLimitUsd > 0 && percent >= warnAtPercent,
    };
  }

  flush(): void {
    this.file.flush();
  }
}
