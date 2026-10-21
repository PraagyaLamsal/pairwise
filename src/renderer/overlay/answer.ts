import type { Rect } from '@shared/geometry';
import { ipc } from '../ui/ipc';

/**
 * "Show me" (ask_to_point): while Ada waits for the student to point at the answer, the overlay
 * takes their next click instead of letting it through to the app underneath, with her question
 * in one line at the bottom of the screen. A right-click (or Esc, a global shortcut in main)
 * skips it.
 */
export class AnswerInput {
  active = false;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private displayId = '';
  private chip: HTMLDivElement;
  private text: HTMLSpanElement;

  constructor(private readonly surface: HTMLElement) {
    this.chip = document.createElement('div');
    this.chip.className = 'answer-hint hidden';
    this.chip.innerHTML = '<span class="ah-dot"></span><span class="ah-q"></span><span class="ah-esc">Esc to skip</span>';
    this.text = this.chip.querySelector('.ah-q') as HTMLSpanElement;
    document.body.appendChild(this.chip);
    surface.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      e.preventDefault();
      if (e.button === 0) ipc.send('overlay:answer', { displayId: this.displayId, point: { x: e.clientX + this.bounds.x, y: e.clientY + this.bounds.y } });
      else ipc.send('overlay:answerCancel', {});
    });
    surface.addEventListener('contextmenu', (e) => {
      if (this.active) e.preventDefault();
    });
  }

  configure(displayId: string, bounds: Rect): void {
    this.displayId = displayId;
    this.bounds = bounds;
  }

  setMode(m: { active: boolean; prompt: string; color: string }): void {
    this.active = m.active;
    document.body.classList.toggle('answering', m.active);
    if (m.active) this.text.textContent = m.prompt;
    this.chip.style.setProperty('--answer', m.color);
    this.chip.classList.toggle('hidden', !m.active);
  }
}
