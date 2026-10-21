import { namesControl } from '../../vision/snap';
import { ipcMain } from 'electron';
import { inflateRect, rectContains, type Point, type Rect } from '@shared/geometry';
import { inkId, type InkItem, type StepCardState } from '@shared/ink';
import type { EncodedFrame } from '@shared/ipc';
import type { MouseEvt } from '../../platform/types';
import type { TutorSession } from '../tutor';
import { buildInk, pointTip } from '../marks';
import { logger } from '../../log';

const log = logger('steps');

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

type Expect = 'click' | 'hover' | 'screen' | 'manual';

interface Watch {
  id: string;
  expect: Expect;
  rect: Rect | null;
  doneWhen: string;
  displayId: string;
  startedAt: number;
  ringId: string | null;
  resolve: (how: { done: boolean; how: string }) => void;
  cleanup: (() => void)[];
}

/**
 * Step-by-step guidance ("how do I…"): a small checklist on screen, then one step at a time —
 * point at exactly what to click, wait, detect that the student did it (a click inside the
 * target, a hover, or the screen showing the expected result), tick it off and let the tutor
 * continue. Steps the app can't observe ("type your name") wait for the student to say done.
 */
export class StepsFeature {
  private card: StepCardState | null = null;
  private watch: Watch | null = null;
  private seq = 0;

  /** A step is being watched (the tutor is waiting for the student to do it). */
  get watching(): boolean {
    return this.watch !== null;
  }

  constructor(private readonly s: TutorSession) {
    ipcMain.on('overlay:dismissCard', (_e, m: { kind: string }) => {
      if (m.kind === 'step') this.hideCard();
    });
    s.on('ended', () => {
      this.finishWatch({ done: false, how: 'session ended' });
      this.card = null;
    });
    this.register();
  }

  private register(): void {
    const t = this.s.tools;

    t.register('show_steps', async (args) => {
      const steps = (Array.isArray(args.steps) ? args.steps : []).map((x) => str(x)).filter(Boolean).slice(0, 15);
      if (!steps.length) return { response: { ok: false, error: 'No steps given.' } };
      const display = this.s.visual.displayFor(args);
      this.card = {
        id: `steps-${++this.seq}`,
        title: str(args.title) || 'Steps',
        steps: steps.map((text, i) => ({ text, status: i === 0 ? 'active' : 'pending' })),
        anchor: { x: display.workArea.x + display.workArea.width - 18, y: display.workArea.y + 52 },
        displayId: display.id,
      };
      this.pushCard();
      return { response: { ok: true, steps: steps.length } };
    });

    t.register('guide_step', async (args, _call, signal) => {
      const expect = (['click', 'hover', 'screen', 'manual'].includes(str(args.expect)) ? str(args.expect) : 'click') as Expect;
      const target = str(args.target);
      const step = num(args.step);
      const label = str(args.label) || str(args.instruction).slice(0, 24) || 'here';
      if (step) this.setActive(step);
      // A new step replaces any step still being watched.
      this.finishWatch({ done: false, how: 'replaced by the next step' });

      const display = this.s.visual.displayFor(args);
      const approx = this.s.visual.approxPoint(args, display);
      const at = this.s.visual.speechTime();
      if (approx) this.s.cursor.schedule([{ kind: 'fly', to: approx.global, label }], at, label, 60_000);
      let rect: Rect | null = null;
      if (target) {
        const [r] = await this.s.visual.grounder.locate(display.id, [{ id: 'g', description: target, approx: approx?.norm, control: namesControl(target) }], this.s.modelFrame, signal);
        if (r?.found && r.rect) rect = r.rect;
      }
      if (signal.aborted) return { response: { ok: false } };
      if (!rect && expect !== 'manual' && expect !== 'screen') {
        return { response: { ok: false, found: false, note: `Couldn't find "${target}". Describe where it is in words, and ask them to say "done" when they've done it.` } };
      }
      let ringId: string | null = null;
      if (rect) {
        const tip = pointTip(rect);
        const c = this.s.cursor;
        c.cancelFuture(Date.now());
        c.schedule([{ kind: 'fly', to: tip, label }], Math.max(Date.now(), at), label, 60_000);
        // A ring that keeps breathing around the target until the step is done.
        const ring: InkItem = {
          id: inkId('step'),
          author: 'tutor',
          kind: 'ring',
          color: this.s.settings.tutorColor,
          surface: 'screen',
          rect,
          revealAt: Math.max(Date.now(), at) + 250,
          drawMs: 900,
          fadeAt: null,
          seed: 3,
          group: 'guide',
          label: target,
        };
        ringId = ring.id;
        this.s.addInk([ring]);
      }
      if (expect === 'manual') {
        return { response: { ok: true, waiting_for: 'the student to say they are done (the app cannot see this step)' } };
      }
      this.s.setActivity('waiting');
      const result = await this.watchFor(expect, rect, str(args.done_when), display.id, ringId, signal);
      if (signal.aborted) return { response: { ok: false } };
      if (result.done) this.onStepDone(step, rect);
      // Show the tutor the new screen right away.
      void this.s.sendQuestionFrame();
      return {
        response: result.done ? { done: true, how: result.how } : { done: false, how: result.how, note: 'Ask if they are stuck, or describe the step differently.' },
        scheduling: 'WHEN_IDLE',
      };
    });
  }

  private watchFor(expect: Expect, rect: Rect | null, doneWhen: string, displayId: string, ringId: string | null, signal: AbortSignal): Promise<{ done: boolean; how: string }> {
    return new Promise((resolve) => {
      const w: Watch = { id: `w${++this.seq}`, expect, rect, doneWhen, displayId, startedAt: Date.now(), ringId, resolve, cleanup: [] };
      this.watch = w;
      const hooks = this.s.deps.platform.hooks;
      const hit = rect ? inflateRect(rect, Math.max(8, Math.min(18, rect.height * 0.3))) : null;

      if (expect === 'click' && hooks.running && hit) {
        const onDown = (e: MouseEvt) => {
          if (rectContains(hit, { x: e.x, y: e.y })) this.finishWatch({ done: true, how: 'clicked the target' });
        };
        hooks.on('mousedown', onDown);
        w.cleanup.push(() => hooks.off('mousedown', onDown));
      }
      if ((expect === 'hover' || (expect === 'click' && !hooks.running)) && hit) {
        // Without global hooks (no Accessibility yet) a click can't be seen; the pointer can.
        let since = 0;
        const timer = setInterval(() => {
          const p = this.s.deps.platform.displays.cursor();
          if (rectContains(hit, p)) {
            if (!since) since = Date.now();
            if (Date.now() - since > (expect === 'hover' ? 350 : 900)) this.finishWatch({ done: true, how: expect === 'hover' ? 'hovered the target' : 'moved onto the target' });
          } else since = 0;
        }, 100);
        w.cleanup.push(() => clearInterval(timer));
      }
      if (expect === 'screen' || expect === 'click') {
        // The screen changing to what the tutor described also completes a step.
        let checking = false;
        let lastCheck = 0;
        const onFrame = (f: EncodedFrame) => {
          if (f.ref.displayId !== displayId || checking || Date.now() - w.startedAt < 900) return;
          if (Date.now() - lastCheck < 2500) return;
          if (expect === 'click' && !doneWhen) return;
          checking = true;
          lastCheck = Date.now();
          void this.screenShows(f, doneWhen).then((yes) => {
            checking = false;
            if (yes && this.watch === w) this.finishWatch({ done: true, how: `the screen now shows ${doneWhen || 'the change'}` });
          });
        };
        this.s.on('frameSent', onFrame);
        w.cleanup.push(() => this.s.off('frameSent', onFrame));
      }
      const timeout = setTimeout(() => this.finishWatch({ done: false, how: 'timed out after 2 minutes' }), 120_000);
      w.cleanup.push(() => clearTimeout(timeout));
      signal.addEventListener('abort', () => this.watch === w && this.finishWatch({ done: false, how: 'cancelled' }));
    });
  }

  /** Is the expected result visible? (vision model yes/no; without a key: any change counts) */
  private async screenShows(f: EncodedFrame, doneWhen: string): Promise<boolean> {
    if (!doneWhen || !this.s.rest.hasKey || this.s.demoMode()) return f.changeScore > 0.02;
    try {
      const r = await this.s.rest.generateJson<{ yes?: boolean }>(
        this.s.settings.models.vision,
        {
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType: f.mime, data: Buffer.from(f.data).toString('base64') } }, { text: `Does this screenshot clearly show: ${doneWhen}? Answer as JSON {"yes": true|false}.` }] }],
          generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, temperature: 0 },
        },
        { timeoutMs: 8000, inputModality: 'IMAGE' },
      );
      return r.yes === true;
    } catch (e) {
      log.debug('screen check failed', e);
      return false;
    }
  }

  private finishWatch(result: { done: boolean; how: string }): void {
    const w = this.watch;
    if (!w) return;
    this.watch = null;
    for (const c of w.cleanup) c();
    if (w.ringId) this.s.ink.fade({ ids: [w.ringId] });
    // Done waiting: the cursor stays put but steps back (dims) instead of holding its label.
    this.s.cursor.relax();
    if (this.s.snapshot.activity === 'waiting') this.s.setActivity('idle');
    log.info(`step ${result.done ? 'done' : 'not done'}: ${result.how}`);
    w.resolve(result);
  }

  private onStepDone(step: number | undefined, rect: Rect | null): void {
    if (rect) {
      // A small badge on the target's top-right corner (beside it would cover the next button).
      const p: Point = { x: rect.x + rect.width - 2, y: rect.y - 2 };
      const ink = buildInk([{ kind: 'check', at: p }], this.s.activeDisplay().bounds, { color: '#34D399', author: 'tutor', surface: 'screen', group: 'guide' });
      for (const it of ink) it.fontSize = 20;
      for (const it of ink) {
        it.revealAt = Date.now();
        it.fadeAt = Date.now() + 1600;
      }
      this.s.addInk(ink);
    }
    if (this.card && step) {
      this.card.steps = this.card.steps.map((st, i) => (i < step ? { ...st, status: 'done' } : i === step ? { ...st, status: 'active' } : st));
      this.pushCard();
      if (this.card.steps.every((st) => st.status === 'done')) {
        setTimeout(() => this.s.visual.celebrate('done!'), 300);
        setTimeout(() => this.hideCard(), 3500);
      }
    }
    if (this.s.settings.sounds) this.s.deps.engine.command({ type: 'chime', kind: 'grant' });
  }

  private setActive(step: number): void {
    if (!this.card) return;
    this.card.steps = this.card.steps.map((st, i) => (i < step - 1 ? { ...st, status: 'done' } : i === step - 1 ? { ...st, status: 'active' } : { ...st, status: st.status === 'done' ? 'done' : 'pending' }));
    this.pushCard();
  }

  private pushCard(): void {
    this.s.ui.stepCard = this.card ?? undefined;
    this.s.pushUi();
  }

  private hideCard(): void {
    this.card = null;
    this.s.ui.stepCard = undefined;
    this.s.pushUi();
  }
}
