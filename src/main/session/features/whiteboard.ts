import { ipcMain } from 'electron';
import type { Point, Rect } from '@shared/geometry';
import { inkId, type InkItem } from '@shared/ink';
import { drawDurationFor, inkPenPoint } from '@shared/ink-geometry';
import type { StudentStroke } from '@shared/ipc';
import type { TutorSession } from '../tutor';
import { InkManager } from '../ink';
import type { CursorStep } from '../cursor';
import { BOARD, boardPoint, diagramInk, type DiagramEdge, type DiagramKind, type DiagramNode } from '../diagram';
import { WhiteboardWindow } from '../../windows/whiteboard';
import { logger } from '../../log';

const log = logger('whiteboard');
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const KINDS = new Set<DiagramKind>(['tree', 'flow', 'list', 'array', 'graph', 'boxes']);

/**
 * Feature 11, the whiteboard: a separate window (an ordinary app window, so it is in the tutor's
 * screen frames) where the tutor draws diagrams with its pen — the cursor flies onto the board and
 * draws each box and arrow as it explains — and the student can draw too.
 */
export class WhiteboardFeature {
  readonly window = new WhiteboardWindow();
  readonly ink = new InkManager();
  /** PNG snapshots of finished diagrams (for the session notes). */
  readonly diagrams: { title: string; png: Buffer; at: number }[] = [];
  private seq = 0;

  constructor(private readonly s: TutorSession) {
    this.ink.on('op', (op) => this.window.send('whiteboard:ink', op));
    this.window.onClosed = () => this.s.update({ whiteboard: false });
    ipcMain.on('whiteboard:stroke', (_e, st: StudentStroke) => this.onStudentStroke(st));
    ipcMain.on('whiteboard:clear', () => this.clear());
    s.on('ended', () => {
      this.window.hide();
      this.s.update({ whiteboard: false });
    });
    this.register();
  }

  get isOpen(): boolean {
    return this.window.visible;
  }

  /** What the board shows now (sent on open, and fetched by the page when it loads). */
  state() {
    const s = this.s.settings;
    const title = this.s.course && this.s.isActive ? `${this.s.course.code} whiteboard` : 'Whiteboard';
    return { title, tutorName: s.tutorName, tutorColor: s.tutorColor, studentColor: s.studentInkColor, items: this.ink.live() };
  }

  async open(): Promise<void> {
    const displays = this.s.deps.platform.displays;
    const p = displays.cursor();
    const d = displays.list().find((x) => p.x >= x.bounds.x && p.x < x.bounds.x + x.bounds.width && p.y >= x.bounds.y && p.y < x.bounds.y + x.bounds.height) ?? displays.primary();
    await this.window.open(p, this.state(), d.workArea);
    this.s.update({ whiteboard: true });
    if (this.s.isActive) this.s.note('[The whiteboard is open on the student\'s screen. You see it in the screen frames; draw on it with draw_diagram or whiteboard.]');
  }

  close(): void {
    this.window.hide();
    this.s.update({ whiteboard: false });
  }

  async toggle(): Promise<void> {
    if (this.isOpen) this.close();
    else await this.open();
  }

  clear(): void {
    const ids = this.ink.all().map((i) => i.id);
    if (ids.length) this.ink.remove(ids);
  }

  /** Board → global DIP (the board is letterboxed into the window's content area). */
  private mapper(): ((p: Point) => Point) & { scale: number } | null {
    const cb = this.window.contentBounds();
    if (!cb) return null;
    const scale = Math.min(cb.width / BOARD.width, cb.height / BOARD.height);
    const ox = cb.x + (cb.width - BOARD.width * scale) / 2;
    const oy = cb.y + (cb.height - BOARD.height * scale) / 2;
    const f = ((p: Point) => ({ x: ox + p.x * scale, y: oy + p.y * scale })) as ((p: Point) => Point) & { scale: number };
    f.scale = scale;
    return f;
  }

  /** A screen-space twin of a board item, for the cursor to trace. */
  private toScreen(it: InkItem, map: ((p: Point) => Point) & { scale: number }): InkItem {
    const r = (rect?: Rect) => {
      if (!rect) return undefined;
      const a = map({ x: rect.x, y: rect.y });
      return { x: a.x, y: a.y, width: rect.width * map.scale, height: rect.height * map.scale };
    };
    return {
      ...it,
      id: `${it.id}~pen`,
      surface: 'screen',
      rect: r(it.rect),
      at: it.at ? map(it.at) : undefined,
      from: it.from ? map(it.from) : undefined,
      to: it.to ? map(it.to) : undefined,
      points: it.points?.map(map),
      fontSize: it.fontSize ? it.fontSize * map.scale : undefined,
    };
  }

  /**
   * Draw board items with the tutor's pen: the cursor swoops onto the board and traces each
   * one; each item appears exactly as the pen passes over it (timed to speech like screen ink).
   */
  play(items: InkItem[], at: number): number {
    if (!items.length) return at;
    const now = Date.now();
    const map = this.mapper();
    const start = Math.max(now, at);
    let end = start;
    if (map && this.s.isActive && this.s.cursor.currentMode !== 'hidden' && this.s.cursor.currentMode !== 'driving') {
      const twins = items.map((i) => this.toScreen(i, map));
      this.s.overlays.send('overlay:penItems', { items: twins });
      const steps: CursorStep[] = [];
      twins.forEach((tw) => {
        const p = inkPenPoint(tw, 0);
        if (p) steps.push({ kind: 'fly', to: p, maxMs: 520 });
        steps.push({ kind: 'trace', item: tw });
      });
      const times = this.s.cursor.schedule(steps, start, undefined, 2200);
      let k = 0;
      twins.forEach((tw, i) => {
        const hasFly = Boolean(inkPenPoint(tw, 0));
        const t = times[k + (hasFly ? 1 : 0)];
        k += hasFly ? 2 : 1;
        items[i].revealAt = t ? t.startAt : start;
        end = Math.max(end, t ? t.endAt : start);
      });
    } else {
      let t = start;
      for (const it of items) {
        it.revealAt = t;
        t += it.drawMs + 90;
      }
      end = t;
    }
    this.ink.add(items);
    return end;
  }

  private group(): string {
    return `wb-${++this.seq}`;
  }

  private onStudentStroke(st: StudentStroke): void {
    if (st.id?.startsWith('erase:')) {
      const id = st.id.slice(6);
      if (this.ink.all().some((i) => i.id === id && i.author === 'student')) this.ink.remove([id]);
      return;
    }
    if (!st.points?.length) return;
    const points = st.straight && st.points.length > 2 ? [st.points[0], st.points[st.points.length - 1]] : st.points;
    const id = inkId('ws');
    this.ink.add([{ id, author: 'student', kind: 'stroke', color: this.s.settings.studentInkColor, surface: 'whiteboard', points, revealAt: 0, drawMs: 1, fadeAt: null, seed: 3, group: 'student' }]);
  }

  /** Snapshot the board shortly after a diagram is finished (for the notes). */
  private keepSnapshot(title: string, when: number): void {
    setTimeout(async () => {
      const png = await this.window.snapshot().catch(() => null);
      if (png) this.diagrams.push({ title, png, at: Date.now() });
    }, Math.max(0, when - Date.now()) + 600);
  }

  private register(): void {
    const t = this.s.tools;

    t.register('draw_diagram', async (args) => {
      const kind = (KINDS.has(str(args.kind) as DiagramKind) ? str(args.kind) : 'flow') as DiagramKind;
      const nodes: DiagramNode[] = (Array.isArray(args.nodes) ? args.nodes : [])
        .map((n: Record<string, unknown>) => ({ id: str(n.id) || str(n.label), label: str(n.label) || str(n.id), note: str(n.note) || undefined, highlight: n.highlight === true }))
        .filter((n: DiagramNode) => n.id && n.label)
        .slice(0, 24);
      if (!nodes.length) return { response: { ok: false, error: 'No nodes to draw.' } };
      const edges: DiagramEdge[] = (Array.isArray(args.edges) ? args.edges : []).map((e: Record<string, unknown>) => ({ from: str(e.from), to: str(e.to), label: str(e.label) || undefined })).filter((e: DiagramEdge) => e.from && e.to).slice(0, 40);
      if (!this.isOpen) await this.open();
      if (args.clear !== false && this.ink.all().some((i) => i.author === 'tutor')) this.clear();
      await new Promise((r) => setTimeout(r, 120)); // let the window settle before mapping the pen
      const title = str(args.title);
      const items = diagramInk({ kind, nodes, edges, title: title || undefined }, { color: this.s.settings.tutorColor, accent: '#FFB224', group: this.group() });
      const end = this.play(items, this.s.visual.speechTime());
      this.keepSnapshot(title || `${kind} diagram`, end);
      log.info(`diagram ${kind}: ${nodes.length} nodes, ${edges.length} edges`);
      return { response: { ok: true, drawn: nodes.length, note: 'It appears on the whiteboard as you talk; explain it node by node.' } };
    });

    t.register('whiteboard', async (args) => {
      const action = str(args.action) || 'open';
      if (action === 'open') {
        await this.open();
        return { response: { ok: true } };
      }
      if (action === 'close') {
        this.close();
        return { response: { ok: true } };
      }
      if (action === 'clear') {
        this.clear();
        return { response: { ok: true } };
      }
      if (!this.isOpen) await this.open();
      const color = this.s.settings.tutorColor;
      const group = this.group();
      const items: InkItem[] = [];
      for (const m of (Array.isArray(args.items) ? args.items : []).slice(0, 16) as Record<string, unknown>[]) {
        const k = str(m.kind);
        const p = boardPoint(num(m.x) ?? 500, num(m.y) ?? 500);
        const q = boardPoint(num(m.x2) ?? (num(m.x) ?? 500) + 120, num(m.y2) ?? num(m.y) ?? 500);
        const id = inkId('wb');
        const base: InkItem = { id, author: 'tutor', kind: 'text', color, surface: 'whiteboard', revealAt: 0, drawMs: 0, fadeAt: null, seed: id.length * 7 + items.length, group };
        let it: InkItem | null = null;
        if (k === 'text' && str(m.text)) it = { ...base, kind: 'text', text: str(m.text).slice(0, 80), fontSize: 26, at: p };
        else if (k === 'arrow' || k === 'line') it = { ...base, kind: k, from: p, to: q, bend: k === 'arrow' ? 0.15 : 0 };
        else if (k === 'circle' || k === 'box' || k === 'underline') it = { ...base, kind: k, rect: { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), width: Math.max(20, Math.abs(q.x - p.x)), height: Math.max(k === 'underline' ? 8 : 20, Math.abs(q.y - p.y)) } };
        else if (k === 'check' || k === 'cross') it = { ...base, kind: k, at: p, fontSize: 30 };
        if (it) {
          it.drawMs = drawDurationFor(it);
          items.push(it);
        }
      }
      if (!items.length) return { response: { ok: false, error: 'Nothing to draw.' } };
      this.play(items, this.s.visual.speechTime());
      return { response: { ok: true, drawn: items.length } };
    });
  }
}
