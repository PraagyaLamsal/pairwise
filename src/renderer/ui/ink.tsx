import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/**
 * A marker loop that overshoots its start — the same gesture the tutor uses on screen. Squarish
 * (a superellipse), so around a card it hugs the edges instead of cutting across the corners
 * and through what's written there.
 */
export function ringPath(seed: number, w = 100, h = 100): string {
  const r = rng(seed);
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2 - 3;
  const ry = h / 2 - 3;
  const start = -2.4 + r() * 0.4;
  const sweep = Math.PI * 2 + 0.55 + r() * 0.25;
  const k = 2 / 4.5;
  const pts: string[] = [];
  const n = 72;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + sweep * t;
    const wobble = 1 + Math.sin(a * 2 + r() * 0.3) * 0.02 + (t > 0.85 ? (t - 0.85) * 0.22 : 0);
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const x = cx + Math.sign(c) * Math.pow(Math.abs(c), k) * rx * wobble;
    const y = cy + Math.sign(sn) * Math.pow(Math.abs(sn), k) * ry * wobble;
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

/**
 * Ada's ink loop around a card, drawn in the element's own pixels: a stretched viewBox with a
 * non-scaling stroke made Chromium apply the "draw in" dash in screen pixels against a length
 * in viewBox units, so only ~40 % of the loop was ever drawn.
 */
export function InkRing({ color = 'var(--tutor)', seed = 7, width = 2.6, style, animate = true }: { color?: string; seed?: number; width?: number; style?: CSSProperties; animate?: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      setSize((s) => (s && Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: Math.round(r.width), h: Math.round(r.height) }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const d = useMemo(() => (size ? ringPath(seed, size.w, size.h) : ''), [seed, size]);
  return (
    <svg ref={ref} className={animate ? 'ink-draw' : undefined} viewBox={size ? `0 0 ${size.w} ${size.h}` : undefined} style={{ position: 'absolute', inset: -8, width: 'calc(100% + 16px)', height: 'calc(100% + 16px)', overflow: 'visible', pointerEvents: 'none', ...style }} aria-hidden="true">
      {d && <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" pathLength={1} />}
    </svg>
  );
}
