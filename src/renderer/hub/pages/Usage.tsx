import { useState } from 'react';
import { formatUsd } from '@shared/pricing';
import { useSettings, useUsage } from '../../ui/hooks';
import { Group, Meter, Row, Select, TextField, Toggle } from '../../ui/kit';

function DayBars({ days }: { days: { day: string; usd: number }[] }) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const byDay = new Map(days.map((d) => [Number(d.day.slice(8, 10)), d.usd]));
  const max = Math.max(0.01, ...days.map((d) => d.usd));
  const w = 560;
  const h = 120;
  const bw = w / daysInMonth;
  return (
    <svg viewBox={`0 0 ${w} ${h + 18}`} width="100%" role="img" aria-label="Spend per day this month">
      {Array.from({ length: daysInMonth }, (_, i) => {
        const v = byDay.get(i + 1) ?? 0;
        const bh = v > 0 ? Math.max(2, (v / max) * h) : 0;
        const today = i + 1 === now.getUTCDate();
        return (
          <g key={i}>
            <rect x={i * bw + 2} y={h - bh} width={bw - 4} height={bh} rx={2} fill={today ? 'var(--tutor-hi)' : 'var(--tutor)'} opacity={v > 0 ? 0.9 : 0} />
            <rect x={i * bw + 2} y={h - 1} width={bw - 4} height={1} fill="var(--border-strong)" />
            {(i === 0 || (i + 1) % 5 === 0) && (
              <text x={i * bw + bw / 2} y={h + 14} textAnchor="middle" fontSize="10" fill="var(--text-3)">
                {i + 1}
              </text>
            )}
            {v > 0 && <title>{`${i + 1}: ${formatUsd(v)}`}</title>}
          </g>
        );
      })}
    </svg>
  );
}

export function Usage() {
  const usage = useUsage();
  const [s, update] = useSettings();
  const [limit, setLimit] = useState<string | null>(null);
  if (!usage || !s) return null;
  const monthName = new Date().toLocaleString(undefined, { month: 'long' });
  const commitLimit = () => {
    const v = Number(limit);
    if (Number.isFinite(v) && v >= 0) void update({ budget: { monthlyLimitUsd: v } });
    setLimit(null);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Usage</h1>
          <p>Every Gemini call is priced as it happens, from the token counts Google reports.</p>
        </div>
      </div>
      <div className="usage-grid">
        <div className="card">
          <h3>{monthName} so far</h3>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span className="big-number">{formatUsd(usage.monthUsd)}</span>
            <span className="muted">of {formatUsd(usage.limitUsd)} budget</span>
          </div>
          <div style={{ margin: '14px 0 6px' }}>
            <Meter value={usage.percent} warnAt={s.budget.warnAtPercent} />
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            {usage.blocked
              ? 'Budget reached — new sessions are blocked until next month or until you raise the cap.'
              : usage.warn
                ? `Over ${s.budget.warnAtPercent}% of your budget.`
                : `Today: ${formatUsd(usage.todayUsd)}${usage.sessionUsd ? ` · this session: ${formatUsd(usage.sessionUsd)}` : ''}`}
          </p>
          <div style={{ marginTop: 18 }}>
            <DayBars days={usage.byDay} />
          </div>
        </div>
        <div className="card">
          <h3>By model</h3>
          {usage.byModel.length === 0 ? (
            <p className="muted">Nothing yet this month.</p>
          ) : (
            <table className="table">
              <tbody>
                {usage.byModel.map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td>{formatUsd(m.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
            A typical hour of voice + screen costs well under a dollar with the default settings.
          </p>
        </div>
      </div>
      <div style={{ marginTop: 22 }}>
        <Group title="Budget">
          <Row title="Monthly cap (USD)" help="Counted against the calendar month in UTC.">
            <TextField value={limit ?? String(s.budget.monthlyLimitUsd)} onChange={setLimit} width={90} onEnter={commitLimit} />
            {limit !== null && (
              <button className="btn btn-secondary btn-s" onClick={commitLimit}>
                Save
              </button>
            )}
          </Row>
          <Row title="Warn me at">
            <Select
              value={String(s.budget.warnAtPercent)}
              onChange={(v) => void update({ budget: { warnAtPercent: Number(v) } })}
              options={[50, 70, 80, 90].map((n) => ({ value: String(n), label: `${n}%` }))}
              width={100}
            />
          </Row>
          <Row title="Stop sessions at the cap" help="Ends the session politely and blocks new ones until next month.">
            <Toggle checked={s.budget.hardStop} onChange={(hardStop) => void update({ budget: { hardStop } })} />
          </Row>
        </Group>
      </div>
    </div>
  );
}
