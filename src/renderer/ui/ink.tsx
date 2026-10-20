import { useMemo, type CSSProperties } from 'react';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/** A marker loop that overshoots its start — the same gesture the tutor uses on screen. */
export function ringPath(seed: number, w = 100, h = 100): string {
  const r = rng(seed);
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2 - 3;
  const ry = h / 2 - 3;
  const start = -2.4 + r() * 0.4;
  const sweep = Math.PI * 2 + 0.55 + r() * 0.25;
  const pts: string[] = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + sweep * t;
    const wobble = 1 + Math.sin(a * 2 + r() * 0.3) * 0.025 + (t > 0.85 ? (t - 0.85) * 0.25 : 0);
    const x = cx + Math.cos(a) * rx * wobble;
    const y = cy + Math.sin(a) * ry * wobble;
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

export function underlinePath(seed: number, w = 100): string {
  const r = rng(seed);
  const y = 6;
  return `M2 ${y + r() * 1.2} C ${w * 0.3} ${y - 2.4 + r()}, ${w * 0.62} ${y + 2 + r()}, ${w - 2} ${y - 0.6 + r()}`;
}

export function InkRing({ color = 'var(--tutor)', seed = 7, width = 2.6, style, animate = true }: { color?: string; seed?: number; width?: number; style?: CSSProperties; animate?: boolean }) {
  const d = useMemo(() => ringPath(seed), [seed]);
  return (
    <svg className={animate ? 'ink-draw' : undefined} viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: -8, width: 'calc(100% + 16px)', height: 'calc(100% + 16px)', overflow: 'visible', pointerEvents: 'none', ...style }} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} />
    </svg>
  );
}

export function InkUnderline({ color = 'var(--tutor)', seed = 3, width = 2.4, style }: { color?: string; seed?: number; width?: number; style?: CSSProperties }) {
  const d = useMemo(() => underlinePath(seed), [seed]);
  return (
    <svg className="ink-draw" viewBox="0 0 100 12" preserveAspectRatio="none" style={{ position: 'absolute', left: -2, right: -2, bottom: -9, width: 'calc(100% + 4px)', height: 12, overflow: 'visible', pointerEvents: 'none', ...style }} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} />
    </svg>
  );
}
