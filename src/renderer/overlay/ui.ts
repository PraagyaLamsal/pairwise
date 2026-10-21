import type { Point, Rect } from '@shared/geometry';
import type { CalibrationState } from '@shared/ipc';
import type { OverlayUiState } from '@shared/ink';
import { ipc } from '../ui/ipc';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** The student's pointer this close to a card or chip fades it (DIP). */
const SHY_PX = 56;
/** Resting the pointer on the step card this long opens it. */
const PEEK_MS = 700;
/** A step card opens for this long whenever its steps change. */
const STEP_OPEN_MS = 3200;
/** A veil outline's label shows for this long after the window is first hidden. */
const VEIL_LABEL_MS = 4000;

const CHECK = '<svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 10.4l3.4 3.4 7.4-7.6"/></svg>';
const EYE = '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.6 10s2.7-5.2 7.4-5.2 7.4 5.2 7.4 5.2-2.7 5.2-7.4 5.2S2.6 10 2.6 10Z"/><circle cx="10" cy="10" r="2.3"/></svg>';
const BOOK = '<svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.6c2.2-.9 4.2-.6 6 1v10c-1.8-1.6-3.8-1.9-6-1z M16 4.6c-2.2-.9-4.2-.6-6 1v10c1.8-1.6 3.8-1.9 6-1z"/></svg>';

/**
 * DOM layer of the overlay, kept as quiet as a Tuple call: nothing stands on screen in an idle
 * session. A step card is one line ("2/3 · Hover Debug") that opens for a moment when the step
 * changes; citations and badges are small chips that go away on their own; veiled windows get a
 * thin outline whose label shows only at first. Everything here fades almost away when the
 * student's pointer comes near and lets clicks through — except the consent card, which must be
 * clicked, and the driving frame and banner, which must stay obvious.
 */
export class OverlayUi {
  private root: HTMLDivElement;
  private state: OverlayUiState | null = null;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private displayId = '';
  private tutorName = 'Ada';
  private hoverCount = 0;
  private pointer: Point | null = null;
  private stepSig = '';
  private stepOpenUntil = 0;
  private peekSince = 0;
  private peeking = false;
  private veilSeen = new Map<string, number>();
  private shyFrame = 0;
  private peekTimer: number | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'ui-layer';
    parent.appendChild(this.root);
  }

  configure(displayId: string, bounds: Rect, tutorName: string): void {
    this.displayId = displayId;
    this.bounds = bounds;
    this.tutorName = tutorName;
    if (this.state) this.render(this.state);
  }

  /** Where the student's pointer is (global DIP), from the cursor frames. */
  setPointer(p: Point): void {
    this.pointer = p;
    if (!this.shyFrame) this.shyFrame = requestAnimationFrame(() => this.updateShy());
  }

  render(state: OverlayUiState): void {
    this.state = state;
    const now = Date.now();
    const b = this.bounds;
    const mine = (id?: string) => !id || id === this.displayId;
    const parts: string[] = [];

    if (state.driving) {
      parts.push(`<div class="drive-frame"></div>`);
      parts.push(`<div class="drive-banner"><span class="drive-dot"></span>${esc(state.drivingLabel ?? `${this.tutorName} is driving`)}<span class="drive-hint">move your mouse or press <b>Esc</b> to take over</span></div>`);
    }

    // The session bar's eye is the "can see" indicator; if the bar is hidden, a tiny one stays.
    if (state.sessionLive && state.hudHidden && mine(state.visionDisplayId) && state.visionDisplayId) {
      parts.push(`<div class="vision-dot ${state.visionPaused ? 'paused' : ''}" data-shy title="${state.visionPaused ? 'Screen view paused' : `${esc(this.tutorName)} can see this screen`}">${EYE}</div>`);
    }

    const seen = new Set<string>();
    for (const v of state.veilOutlines) {
      const x = v.rect.x - b.x;
      const y = v.rect.y - b.y;
      if (x > b.width || y > b.height || x + v.rect.width < 0 || y + v.rect.height < 0) continue;
      const key = v.app;
      seen.add(key);
      if (!this.veilSeen.has(key)) this.veilSeen.set(key, now);
      const fresh = now - (this.veilSeen.get(key) ?? now) < VEIL_LABEL_MS;
      parts.push(`<div class="veil-outline ${fresh ? 'fresh' : ''}" style="left:${x}px;top:${y}px;width:${v.rect.width}px;height:${v.rect.height}px"><span data-shy>Hidden from ${esc(this.tutorName)} · ${esc(v.app)}</span></div>`);
    }
    for (const k of [...this.veilSeen.keys()]) if (!seen.has(k)) this.veilSeen.delete(k);

    if (state.stepCard && mine(state.stepCard.displayId)) {
      const sc = state.stepCard;
      const sig = `${sc.id}|${sc.steps.map((s) => s.status).join(',')}`;
      if (sig !== this.stepSig) {
        this.stepSig = sig;
        this.stepOpenUntil = now + STEP_OPEN_MS;
      }
      const total = sc.steps.length;
      const activeIdx = sc.steps.findIndex((s) => s.status === 'active');
      const doneAll = sc.steps.every((s) => s.status === 'done');
      const current = activeIdx >= 0 ? sc.steps[activeIdx] : null;
      const open = this.peeking || now < this.stepOpenUntil;
      parts.push(`<div class="step-card ${open ? 'open' : ''}" data-shy data-card="step">
        <div class="step-line">${doneAll ? `<span class="step-num done">${CHECK}</span><span class="step-now">${esc(sc.title)} · done</span>` : `<span class="step-num">${activeIdx + 1}/${total}</span><span class="step-now">${esc(current?.text ?? sc.title)}</span>`}</div>
        <div class="step-all">
          <div class="step-title">${esc(sc.title)}</div>
          <ol>${sc.steps.map((s, i) => `<li class="${s.status}"><span class="num">${s.status === 'done' ? CHECK : i + 1}</span><span class="txt">${esc(s.text)}</span></li>`).join('')}</ol>
        </div>
      </div>`);
    } else this.stepSig = '';

    if (state.consent && mine(state.consent.displayId)) {
      const c = state.consent;
      const risky = c.kind === 'risky-action';
      const remaining = Math.max(0, c.expiresAt - now);
      parts.push(`<div class="consent ${risky ? 'risky' : ''} ${c.anchor === 'bottom' ? 'bottom' : ''} interactive" data-card="consent">
        <div class="consent-icon">${risky ? '!' : '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.4 10.6V4.8a1.2 1.2 0 0 1 2.4 0v4.6M9.8 9.2V3.8a1.2 1.2 0 0 1 2.4 0v5.4M12.2 9.2V5.2a1.2 1.2 0 0 1 2.4 0v6.4c0 3-2 5.2-5 5.2-2.2 0-3.4-1-4.6-2.8L3.4 11a1.2 1.2 0 0 1 1.9-1.4l2.1 2"/></svg>'}</div>
        <div class="consent-body">
          <div class="consent-title">${esc(c.title)}</div>
          <div class="consent-detail">${esc(c.detail)}</div>
          ${c.action ? `<div class="consent-action">${esc(c.action)}</div>` : ''}
          <div class="consent-buttons">
            <button class="allow" data-consent="allow">${risky ? 'Allow this action' : 'Let it drive'}${c.hotkey ? `<kbd>${esc(c.hotkey)}</kbd>` : ''}</button>
            <button class="deny" data-consent="deny">${risky ? 'Cancel' : 'Not now'}</button>
          </div>
        </div>
        <div class="consent-timer" style="animation-duration:${remaining}ms"></div>
      </div>`);
    }

    if (state.citation && mine(state.citation.displayId) && state.citation.until > now) {
      const ci = state.citation;
      parts.push(`<div class="citation" data-shy data-card="citation" title="${esc(ci.snippet)}"><span class="cite-icon">${BOOK}</span><span class="cite-src">${esc(ci.cite)}</span></div>`);
    }

    if (state.outOfScope && mine(state.outOfScope.displayId) && state.outOfScope.until > now) {
      parts.push(`<div class="scope-badge" data-shy>Beyond this course · ${esc(state.outOfScope.topic)}</div>`);
    }

    if (state.toast && state.toast.until > now && (state.toast.displayId ? mine(state.toast.displayId) : true)) {
      parts.push(`<div class="toast ${state.toast.tone}" data-shy>${esc(state.toast.text)}</div>`);
    }

    this.root.innerHTML = parts.join('');
    this.wire();
    this.scheduleExpiry(state);
    this.reportRects();
    this.updateShy();
  }

  /** Fade what the student's pointer comes close to; rest on the step card to open it. */
  private updateShy(): void {
    this.shyFrame = 0;
    const p = this.pointer;
    const b = this.bounds;
    const now = Date.now();
    let onCard = false;
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-shy]')) {
      const r = el.getBoundingClientRect();
      if (!p || r.width < 1) {
        el.classList.remove('shy');
        continue;
      }
      const x = p.x - b.x;
      const y = p.y - b.y;
      const near = x > r.left - SHY_PX && x < r.right + SHY_PX && y > r.top - SHY_PX && y < r.bottom + SHY_PX;
      const over = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      if (el.dataset.card === 'step' && over) onCard = true;
      el.classList.toggle('shy', near && !(el.dataset.card === 'step' && this.peeking));
    }
    // Resting on the step card opens it (full strength) until the pointer leaves it.
    if (onCard) {
      if (!this.peekSince) this.peekSince = now;
      if (!this.peeking && now - this.peekSince > PEEK_MS) {
        this.peeking = true;
        if (this.state) this.render(this.state);
        return;
      }
      // The pointer may rest without moving (no new frames): look again once the dwell is up.
      if (!this.peeking && !this.peekTimer) {
        this.peekTimer = window.setTimeout(() => {
          this.peekTimer = null;
          if (this.pointer) this.setPointer(this.pointer);
        }, PEEK_MS + 30);
      }
    } else {
      this.peekSince = 0;
      if (this.peeking) {
        this.peeking = false;
        if (this.state) this.render(this.state);
      }
    }
  }

  private rectTimers: number[] = [];
  /**
   * Tell main where this overlay's cards, chips and toasts are, so grounding never "finds" a
   * target in Pairwise's own UI where screen capture can't exclude overlays (Linux, and a safety
   * net on macOS). Measured after layout and again once entrance animations have settled.
   */
  private reportRects(): void {
    for (const t of this.rectTimers) window.clearTimeout(t);
    const send = () => {
      const b = this.bounds;
      const rects: Rect[] = [];
      for (const el of this.root.querySelectorAll<HTMLElement>('.ui-layer > *, .veil-outline > span')) {
        if (el.classList.contains('drive-frame') || el.classList.contains('veil-outline')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        rects.push({ x: b.x + r.x - 4, y: b.y + r.y - 4, width: r.width + 8, height: r.height + 8 });
      }
      ipc.send('overlay:uiRects', { displayId: this.displayId, rects });
    };
    this.rectTimers = [window.setTimeout(send, 0), window.setTimeout(send, 450)];
  }

  private expiryTimer: number | null = null;
  private scheduleExpiry(state: OverlayUiState): void {
    if (this.expiryTimer) window.clearTimeout(this.expiryTimer);
    const now = Date.now();
    const veilEnds = [...this.veilSeen.values()].map((t) => t + VEIL_LABEL_MS);
    const ends = [state.toast?.until, state.citation?.until, state.outOfScope?.until, state.stepCard ? this.stepOpenUntil : undefined, ...veilEnds].filter((v): v is number => typeof v === 'number' && v > now);
    if (!ends.length) return;
    const next = Math.min(...ends) - now + 30;
    this.expiryTimer = window.setTimeout(() => this.state && this.render(this.state), next);
  }

  private wire(): void {
    this.hoverCount = 0;
    ipc.send('overlay:hover', { displayId: this.displayId, interactive: false });
    for (const el of this.root.querySelectorAll<HTMLElement>('.interactive')) {
      el.addEventListener('mouseenter', () => {
        this.hoverCount += 1;
        ipc.send('overlay:hover', { displayId: this.displayId, interactive: true });
      });
      el.addEventListener('mouseleave', () => {
        this.hoverCount = Math.max(0, this.hoverCount - 1);
        if (!this.hoverCount) ipc.send('overlay:hover', { displayId: this.displayId, interactive: false });
      });
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-consent]')) {
      btn.addEventListener('click', () => {
        const id = this.state?.consent?.id;
        if (id) ipc.send('overlay:consent', { id, decision: btn.dataset.consent as 'allow' | 'deny' });
      });
    }
  }

  renderCalibration(cal: CalibrationState | null): void {
    let layer = document.querySelector<HTMLDivElement>('.calibration');
    if (!cal) {
      layer?.remove();
      return;
    }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'calibration';
      document.body.appendChild(layer);
    }
    // The targets themselves are real buttons in a capturable window under this overlay (the
    // overlay is hidden from capture). Here: only the verdicts, once grounding is done.
    const b = this.bounds;
    const html: string[] = [];
    if (cal.phase === 'done') {
      for (const r of cal.results) {
        const tgt = cal.targets.find((t) => t.id === r.id);
        if (!tgt) continue;
        const tx = tgt.rect.x - b.x;
        const ty = tgt.rect.y - b.y;
        if (tx < -50 || ty < -50 || tx > b.width || ty > b.height) continue;
        const good = r.errorPx !== null && r.errorPx <= 12;
        if (r.found) {
          const x = r.found.x - b.x;
          const y = r.found.y - b.y;
          html.push(`<div class="cal-found ${good ? 'good' : 'bad'}" style="left:${x}px;top:${y}px;width:${r.found.width}px;height:${r.found.height}px"></div>`);
          const cx = x + r.found.width / 2;
          const cy = y + r.found.height / 2;
          html.push(`<div class="cal-dot ${good ? 'good' : 'bad'}" style="left:${cx}px;top:${cy}px"></div>`);
        }
        html.push(`<div class="cal-tag ${r.found ? (good ? 'good' : 'bad') : 'miss'}" style="left:${tx + tgt.rect.width / 2}px;top:${ty + tgt.rect.height + 8}px">${esc(tgt.label)} · ${r.errorPx === null ? 'not found' : `${Math.round(r.errorPx)} px`}</div>`);
      }
      const errs = cal.results.map((r) => r.errorPx).filter((e): e is number => e !== null);
      const mean = errs.length ? errs.reduce((a, c) => a + c, 0) / errs.length : NaN;
      html.push(`<div class="cal-summary"><b>${errs.length}/${cal.targets.length}</b> found · average error <b>${Number.isFinite(mean) ? `${mean.toFixed(1)} px` : 'n/a'}</b></div>`);
    } else {
      html.push(`<div class="cal-summary pending"><span class="cal-spin"></span>${cal.phase === 'showing' ? 'Pointing test — hold still…' : 'Finding each button on a real screenshot…'}</div>`);
    }
    layer.innerHTML = html.join('');
  }
}
