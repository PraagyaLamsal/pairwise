import type { Point, Rect } from '@shared/geometry';
import type { DrawModeState } from '@shared/ink';
import { ipc } from '../ui/ipc';

export interface LiveStroke {
  points: Point[];
  times: number[];
  straight: boolean;
}

/**
 * Student drawing input. Active only while main has made this overlay interactive (holding the
 * ask chord, or draw-toggle mode). Strokes are local (for instant feedback) until main echoes
 * them back as ink for every display.
 */
export class DrawInput {
  active = false;
  color = '#FF8A1F';
  current: LiveStroke | null = null;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private displayId = '';
  private shift = false;
  private hint: HTMLDivElement;
  private via: DrawModeState['via'] = null;

  constructor(private readonly surface: HTMLElement, private readonly onChange: () => void, private readonly surfaceKind: 'screen' | 'whiteboard' = 'screen') {
    this.hint = document.createElement('div');
    this.hint.className = 'draw-hint hidden';
    document.body.appendChild(this.hint);
    surface.addEventListener('pointerdown', (e) => this.down(e));
    surface.addEventListener('pointermove', (e) => this.move(e));
    surface.addEventListener('pointerup', (e) => this.up(e));
    surface.addEventListener('pointercancel', (e) => this.up(e));
    surface.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.active) ipc.send('overlay:drawCancel', {});
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') this.shift = true;
      if (!this.active) return;
      if (e.key === 'Escape') ipc.send('overlay:drawCancel', {});
      if (e.key === 'Enter') ipc.send('overlay:drawCommit', { via: 'toggle' });
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.shift = false;
    });
  }

  configure(displayId: string, bounds: Rect): void {
    this.displayId = displayId;
    this.bounds = bounds;
  }

  setMode(m: DrawModeState, hintText: string): void {
    this.active = m.active;
    this.color = m.color;
    this.via = m.via;
    document.body.classList.toggle('drawing', m.active);
    this.hint.textContent = hintText;
    this.hint.classList.toggle('hidden', !m.active);
    if (!m.active) {
      this.current = null;
      this.onChange();
    }
  }

  private toGlobal(e: PointerEvent): Point {
    return { x: e.clientX + this.bounds.x, y: e.clientY + this.bounds.y };
  }

  private down(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    this.surface.setPointerCapture(e.pointerId);
    const p = this.toGlobal(e);
    this.current = { points: [p], times: [performance.now()], straight: e.shiftKey || this.shift };
    this.onChange();
  }

  private move(e: PointerEvent): void {
    if (!this.active || !this.current) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    const straight = e.shiftKey || this.shift;
    this.current.straight = straight;
    for (const ce of events.length ? events : [e]) {
      const p = this.toGlobal(ce);
      if (straight) {
        this.current.points = [this.current.points[0], p];
        this.current.times = [this.current.times[0], performance.now()];
      } else {
        const last = this.current.points[this.current.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < 1.2) continue;
        this.current.points.push(p);
        this.current.times.push(performance.now());
      }
    }
    this.onChange();
  }

  private up(_e: PointerEvent): void {
    if (!this.current) return;
    const s = this.current;
    this.current = null;
    if (s.points.length === 1) s.points.push({ x: s.points[0].x + 0.5, y: s.points[0].y + 0.5 });
    ipc.send(this.surfaceKind === 'whiteboard' ? 'whiteboard:stroke' : 'overlay:stroke', {
      id: `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      points: s.points,
      times: s.times,
      straight: s.straight,
      displayId: this.displayId,
      surface: this.surfaceKind,
    });
    this.onChange();
    void this.via;
  }
}
