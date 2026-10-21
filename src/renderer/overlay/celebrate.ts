import type { Point } from '@shared/geometry';
import type { Celebration } from '@shared/ink';
import { rng } from '../ui/ink-render';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
  shape: 0 | 1 | 2;
  delay: number;
}

interface Burst {
  id: string;
  at: Point;
  text: string;
  startAt: number;
  particles: Particle[];
}

const LIFE = 1500;

/** A small burst of confetti and a word that pops in — for when the student gets it right. */
export class Celebrations {
  private bursts: Burst[] = [];
  /** macOS "Reduce motion": just the word, fading in and out (no confetti, no pop). */
  reducedMotion = false;
  constructor(private colors: string[]) {}

  setColors(colors: string[]): void {
    this.colors = colors;
  }

  add(c: Celebration): void {
    const rand = rng(Math.floor(c.startAt) % 100000);
    const particles: Particle[] = [];
    for (let i = 0; i < (this.reducedMotion ? 0 : 42); i++) {
      const a = -Math.PI / 2 + (rand() - 0.5) * Math.PI * 1.1;
      const speed = 260 + rand() * 360;
      particles.push({
        x: 0,
        y: 0,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        rot: rand() * Math.PI * 2,
        vr: (rand() - 0.5) * 14,
        size: 4 + rand() * 4,
        color: this.colors[i % this.colors.length],
        shape: (i % 3) as 0 | 1 | 2,
        delay: rand() * 90,
      });
    }
    this.bursts.push({ id: c.id, at: c.at, text: c.text, startAt: c.startAt, particles });
  }

  get active(): boolean {
    return this.bursts.length > 0;
  }

  render(ctx: CanvasRenderingContext2D, now: number, dpr: number, font: string): void {
    this.bursts = this.bursts.filter((b) => now - b.startAt < LIFE + 400);
    for (const b of this.bursts) {
      const t = now - b.startAt;
      if (t < 0) continue;
      for (const p of b.particles) {
        const tt = Math.max(0, t - p.delay) / 1000;
        if (tt <= 0) continue;
        const drag = Math.exp(-tt * 1.6);
        const x = b.at.x + (p.vx * (1 - drag)) / 1.6;
        const y = b.at.y + (p.vy * (1 - drag)) / 1.6 + 420 * tt * tt;
        const alpha = Math.max(0, 1 - tt / (LIFE / 1000));
        if (alpha <= 0) continue;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        ctx.rotate(p.rot + p.vr * tt);
        ctx.fillStyle = p.color;
        if (p.shape === 0) ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        else if (p.shape === 1) {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2.6, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(0, -p.size / 2);
          ctx.lineTo(p.size / 2, p.size / 2);
          ctx.lineTo(-p.size / 2, p.size / 2);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      // the word ("nice!") pops above the burst, in the tutor's colour, no glow
      const pt = Math.min(1, t / 320);
      const pop = pt < 1 && !this.reducedMotion ? 1 + 0.18 * Math.sin(pt * Math.PI) : 1;
      const fade = t > LIFE - 450 ? Math.max(0, 1 - (t - (LIFE - 450)) / 450) : 1;
      ctx.save();
      ctx.globalAlpha = fade * Math.min(1, t / (this.reducedMotion ? 200 : 120));
      ctx.translate(b.at.x, b.at.y - 34 - (this.reducedMotion ? 6 : 12 * Math.min(1, t / 600)));
      ctx.scale(pop, pop);
      ctx.font = `700 26px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 2 * dpr;
      ctx.fillStyle = this.colors[0];
      ctx.fillText(b.text, 0, 0);
      ctx.restore();
    }
  }
}
