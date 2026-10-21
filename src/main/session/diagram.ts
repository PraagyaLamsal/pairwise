import { rectCenter, type Point, type Rect } from '@shared/geometry';
import { inkId, seedFrom, type InkItem } from '@shared/ink';
import { approxTextWidth, drawDurationFor } from '@shared/ink-geometry';
import { edgePoint } from './marks';

/**
 * Whiteboard diagrams from a structure (what draw_diagram receives): recursion trees, flowcharts,
 * linked lists, arrays, graphs and memory boxes, laid out on a 1000 × 640 board and turned into
 * hand-drawn ink in teaching order (the order the tutor explains them in).
 */

export const BOARD = { width: 1000, height: 640 };

export type DiagramKind = 'tree' | 'flow' | 'list' | 'array' | 'graph' | 'boxes';

export interface DiagramNode {
  id: string;
  label: string;
  note?: string;
  highlight?: boolean;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramSpec {
  title?: string;
  kind: DiagramKind;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

interface Placed {
  node: DiagramNode;
  rect: Rect;
}

const TOP = 96; // below the title
const MARGIN = 40;

/** Text sizes on the board: typed (system font) labels are smaller than handwriting for the same weight. */
export function boardSizes(font: InkItem['font'] = 'system') {
  return font === 'hand' ? { title: 34, label: 22, small: 18, note: 20, edge: 18, index: 16 } : { title: 27, label: 18, small: 15, note: 16, edge: 15, index: 13 };
}

let FONT: InkItem['font'] = 'system';
let LABEL = boardSizes().label;

function nodeSize(label: string, size = LABEL): { w: number; h: number } {
  return { w: Math.min(260, Math.max(58, approxTextWidth(label, size, FONT) + 34)), h: Math.max(size * 1.9, 40) };
}

/** Roots first, then breadth-first (children in edge order). */
function bfsOrder(spec: DiagramSpec): { order: string[]; depth: Map<string, number>; children: Map<string, string[]> } {
  const ids = spec.nodes.map((n) => n.id);
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const hasParent = new Set<string>();
  for (const e of spec.edges) {
    if (!children.has(e.from) || !children.has(e.to) || e.from === e.to) continue;
    if (!children.get(e.from)!.includes(e.to)) children.get(e.from)!.push(e.to);
    hasParent.add(e.to);
  }
  const roots = ids.filter((id) => !hasParent.has(id));
  const depth = new Map<string, number>();
  const order: string[] = [];
  const queue = (roots.length ? roots : ids.slice(0, 1)).map((id) => ({ id, d: 0 }));
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (depth.has(id)) continue;
    depth.set(id, d);
    order.push(id);
    for (const c of children.get(id) ?? []) if (!depth.has(c)) queue.push({ id: c, d: d + 1 });
  }
  for (const id of ids) if (!depth.has(id)) (depth.set(id, 0), order.push(id)); // disconnected
  return { order, depth, children };
}

function layoutTree(spec: DiagramSpec): Placed[] {
  const { order, depth, children } = bfsOrder(spec);
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  // Leaves get consecutive slots; parents sit centred over their children (a tidy tree).
  const slot = new Map<string, number>();
  let next = 0;
  const visit = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    const kids = (children.get(id) ?? []).filter((c) => depth.get(c) === (depth.get(id) ?? 0) + 1 && !seen.has(c));
    if (!kids.length) slot.set(id, next++);
    else {
      kids.forEach((k) => visit(k, seen));
      const xs = kids.map((k) => slot.get(k)!).filter((v) => v !== undefined);
      slot.set(id, (Math.min(...xs) + Math.max(...xs)) / 2);
    }
  };
  const seen = new Set<string>();
  for (const id of order) if ((depth.get(id) ?? 0) === 0) visit(id, seen);
  for (const id of order) if (!slot.has(id)) slot.set(id, next++);
  const levels = Math.max(...[...depth.values()], 0) + 1;
  const slots = Math.max(1, next);
  const colW = (BOARD.width - 2 * MARGIN) / slots;
  const rowH = Math.min(130, (BOARD.height - TOP - MARGIN) / levels);
  return order.map((id) => {
    const n = byId.get(id)!;
    const { w, h } = nodeSize(n.label, slots > 6 ? 18 : LABEL);
    const cx = MARGIN + colW * (slot.get(id)! + 0.5);
    const cy = TOP + rowH * ((depth.get(id) ?? 0) + 0.5);
    return { node: n, rect: { x: cx - Math.min(w, colW - 10) / 2, y: cy - h / 2, width: Math.min(w, colW - 10), height: h } };
  });
}

function layoutFlow(spec: DiagramSpec): Placed[] {
  const { order, depth } = bfsOrder(spec);
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const levels = new Map<number, string[]>();
  for (const id of order) levels.set(depth.get(id) ?? 0, [...(levels.get(depth.get(id) ?? 0) ?? []), id]);
  const rows = levels.size;
  const rowH = Math.min(110, (BOARD.height - TOP - MARGIN) / Math.max(1, rows));
  const out: Placed[] = [];
  [...levels.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([d, ids]) => {
      const colW = (BOARD.width - 2 * MARGIN) / ids.length;
      ids.forEach((id, i) => {
        const n = byId.get(id)!;
        const { w, h } = nodeSize(n.label);
        const cx = MARGIN + colW * (i + 0.5);
        const cy = TOP + rowH * (d + 0.5);
        out.push({ node: n, rect: { x: cx - w / 2, y: cy - h / 2, width: w, height: h } });
      });
    });
  return out;
}

function layoutRow(spec: DiagramSpec, gap: number): Placed[] {
  const sizes = spec.nodes.map((n) => nodeSize(n.label));
  const total = sizes.reduce((a, s) => a + s.w, 0) + gap * Math.max(0, sizes.length - 1);
  const scale = Math.min(1, (BOARD.width - 2 * MARGIN) / Math.max(1, total));
  let x = (BOARD.width - total * scale) / 2;
  const cy = TOP + (BOARD.height - TOP) * 0.38;
  return spec.nodes.map((n, i) => {
    const w = sizes[i].w * scale;
    const h = sizes[i].h;
    const r = { x, y: cy - h / 2, width: w, height: h };
    x += w + gap * scale;
    return { node: n, rect: r };
  });
}

function layoutArray(spec: DiagramSpec): Placed[] {
  const n = Math.max(1, spec.nodes.length);
  const cell = Math.min(96, Math.max(46, ...spec.nodes.map((x) => approxTextWidth(x.label, LABEL, FONT) + 22)), (BOARD.width - 2 * MARGIN) / n);
  const x0 = (BOARD.width - cell * n) / 2;
  const cy = TOP + (BOARD.height - TOP) * 0.36;
  return spec.nodes.map((node, i) => ({ node, rect: { x: x0 + i * cell, y: cy - cell * 0.45, width: cell, height: cell * 0.9 } }));
}

function layoutGraph(spec: DiagramSpec): Placed[] {
  const n = spec.nodes.length;
  const c = { x: BOARD.width / 2, y: TOP + (BOARD.height - TOP) / 2 - 10 };
  const rx = Math.min(360, 120 + n * 30);
  const ry = Math.min(200, 90 + n * 18);
  return spec.nodes.map((node, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2;
    const { w, h } = nodeSize(node.label);
    const cx = n === 1 ? c.x : c.x + Math.cos(a) * rx;
    const cy = n === 1 ? c.y : c.y + Math.sin(a) * ry;
    return { node, rect: { x: cx - w / 2, y: cy - h / 2, width: w, height: h } };
  });
}

function layoutBoxes(spec: DiagramSpec): Placed[] {
  const n = Math.max(1, spec.nodes.length);
  const w = Math.min(420, Math.max(220, ...spec.nodes.map((x) => approxTextWidth(x.label, LABEL, FONT) + 40)));
  const h = Math.min(70, (BOARD.height - TOP - MARGIN) / n - 12);
  const x = (BOARD.width - w) / 2 - 80;
  return spec.nodes.map((node, i) => ({ node, rect: { x, y: TOP + i * (h + 12), width: w, height: h } }));
}

export function layoutDiagram(spec: DiagramSpec, font: InkItem['font'] = 'system'): Placed[] {
  FONT = font;
  LABEL = boardSizes(font).label;
  switch (spec.kind) {
    case 'tree':
      return layoutTree(spec);
    case 'flow':
      return layoutFlow(spec);
    case 'list':
      return layoutRow(spec, 70);
    case 'array':
      return layoutArray(spec);
    case 'graph':
      return layoutGraph(spec);
    case 'boxes':
      return layoutBoxes(spec);
    default:
      return layoutFlow(spec);
  }
}

/**
 * Ink for a diagram (board coordinates): title, then each node followed by the edge that leads
 * to it — the order you'd draw it on a whiteboard while explaining.
 */
export function diagramInk(spec: DiagramSpec, style: { color: string; accent: string; group: string; font?: InkItem['font'] }): InkItem[] {
  const font = style.font ?? 'system';
  const sz = boardSizes(font);
  const placed = layoutDiagram(spec, font);
  const rectOf = new Map(placed.map((p) => [p.node.id, p.rect]));
  const items: InkItem[] = [];
  const base = (kind: InkItem['kind'], extra: Partial<InkItem>): InkItem => {
    const id = inkId('wb');
    const it: InkItem = { id, author: 'tutor', kind, color: style.color, surface: 'whiteboard', revealAt: 0, drawMs: 0, fadeAt: null, seed: seedFrom(id), group: style.group, ...(kind === 'text' ? { font } : {}), ...extra };
    it.drawMs = drawDurationFor(it);
    return it;
  };
  if (spec.title) items.push(base('text', { text: spec.title, fontSize: sz.title, at: { x: MARGIN, y: 30 }, label: 'title' }));
  const drawnEdges = new Set<string>();
  const edgeInk = (e: DiagramEdge) => {
    const a = rectOf.get(e.from);
    const b = rectOf.get(e.to);
    if (!a || !b) return;
    const key = `${e.from}>${e.to}`;
    if (drawnEdges.has(key)) return;
    drawnEdges.add(key);
    if (spec.kind === 'array') return; // cells touch; no arrows
    const from = edgePoint(a, rectCenter(b), 4);
    const to = edgePoint(b, rectCenter(a), 6);
    items.push(base('arrow', { from, to, bend: spec.kind === 'graph' ? 0.12 : 0, label: e.label }));
    if (e.label) {
      const mid: Point = { x: (from.x + to.x) / 2 + 8, y: (from.y + to.y) / 2 - 16 };
      items.push(base('text', { text: e.label, fontSize: sz.edge, at: mid, color: style.accent }));
    }
  };
  placed.forEach((p, i) => {
    const r = p.rect;
    // Edges into this node from nodes already drawn come first ("…which calls…").
    for (const e of spec.edges) if (e.to === p.node.id && placed.slice(0, i).some((q) => q.node.id === e.from)) edgeInk(e);
    items.push(base('box', { rect: { x: r.x + 6, y: r.y + 6, width: r.width - 12, height: r.height - 12 }, label: p.node.label }));
    const size = spec.kind === 'tree' && placed.length > 6 ? sz.small : sz.label;
    items.push(base('text', { text: p.node.label, fontSize: size, align: 'center', at: { x: r.x + r.width / 2, y: r.y + r.height / 2 } }));
    if (spec.kind === 'array') items.push(base('text', { text: String(i), fontSize: sz.index, align: 'center', at: { x: r.x + r.width / 2, y: r.y + r.height + 16 }, color: style.accent }));
    if (p.node.highlight) items.push(base('circle', { rect: r, color: style.accent }));
    if (p.node.note) {
      const right = r.x + r.width + 16;
      const at = right + approxTextWidth(p.node.note, sz.note, font) < BOARD.width - 10 ? { x: right, y: r.y + r.height / 2 - sz.note * 0.6 } : { x: Math.max(10, r.x), y: r.y + r.height + 10 };
      items.push(base('text', { text: p.node.note, fontSize: sz.note, at, color: style.accent }));
    }
  });
  for (const e of spec.edges) edgeInk(e); // anything not drawn yet (cycles, back edges)
  if (spec.kind === 'list') {
    const last = placed[placed.length - 1];
    if (last && !/^(none|null|nil)$/i.test(last.node.label) && !spec.edges.some((e) => e.from === last.node.id)) {
      const from = { x: last.rect.x + last.rect.width, y: last.rect.y + last.rect.height / 2 };
      items.push(base('arrow', { from, to: { x: from.x + 50, y: from.y } }));
      items.push(base('text', { text: 'None', fontSize: sz.note, at: { x: from.x + 56, y: from.y - sz.note * 0.6 }, color: style.accent }));
    }
  }
  return items;
}

/** Free-form whiteboard marks (0–1000 on both axes, as the whiteboard tool documents). */
export function boardPoint(x: number, y: number): Point {
  return { x: (Math.min(1000, Math.max(0, x)) / 1000) * BOARD.width, y: (Math.min(1000, Math.max(0, y)) / 1000) * BOARD.height };
}
