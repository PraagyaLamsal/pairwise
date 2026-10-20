import { describe, expect, it } from 'vitest';
import { BOARD, diagramInk, layoutDiagram, type DiagramSpec } from '../../src/main/session/diagram';

const inside = (r: { x: number; y: number; width: number; height: number }) => r.x >= 0 && r.y >= 0 && r.x + r.width <= BOARD.width && r.y + r.height <= BOARD.height;
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const tree: DiagramSpec = {
  kind: 'tree',
  title: 'fib(4)',
  nodes: ['fib(4)', 'fib(3)', 'fib(2)', 'fib(2) ', 'fib(1)', 'fib(1) ', 'fib(0)', 'fib(1)  ', 'fib(0) '].map((label, i) => ({ id: `n${i}`, label: label.trim() })),
  edges: [
    { from: 'n0', to: 'n1' },
    { from: 'n0', to: 'n2' },
    { from: 'n1', to: 'n3' },
    { from: 'n1', to: 'n4' },
    { from: 'n3', to: 'n7' },
    { from: 'n3', to: 'n8' },
    { from: 'n2', to: 'n5' },
    { from: 'n2', to: 'n6' },
  ],
};

describe('diagram layouts', () => {
  it('lays out a recursion tree level by level, parents over their children, nothing overlapping', () => {
    const placed = layoutDiagram(tree);
    const at = new Map(placed.map((p) => [p.node.id, p.rect]));
    expect(placed.every((p) => inside(p.rect))).toBe(true);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i].rect, placed[j].rect)).toBe(false);
    for (const e of tree.edges) expect(at.get(e.to)!.y).toBeGreaterThan(at.get(e.from)!.y);
    const cx = (id: string) => at.get(id)!.x + at.get(id)!.width / 2;
    expect(cx('n0')).toBeGreaterThan(cx('n1'));
    expect(cx('n0')).toBeLessThan(cx('n2'));
  });

  it('every kind stays on the board', () => {
    for (const kind of ['flow', 'list', 'array', 'graph', 'boxes'] as const) {
      const spec: DiagramSpec = { kind, nodes: ['head', '3', '7', '12', '42'].map((l, i) => ({ id: `${i}`, label: l })), edges: [0, 1, 2, 3].map((i) => ({ from: `${i}`, to: `${i + 1}` })) };
      const placed = layoutDiagram(spec);
      expect(placed.every((p) => inside(p.rect)), kind).toBe(true);
    }
  });

  it('draws in teaching order: title, then each node after the arrow that leads to it', () => {
    const ink = diagramInk(tree, { color: '#2F7BFF', accent: '#FFB224', group: 'g' });
    expect(ink[0]).toMatchObject({ kind: 'text', text: 'fib(4)' });
    const firstChildBox = ink.findIndex((i) => i.kind === 'box' && i.label === 'fib(3)');
    const arrowToIt = ink.findIndex((i) => i.kind === 'arrow');
    expect(arrowToIt).toBeGreaterThan(0);
    expect(arrowToIt).toBeLessThan(firstChildBox);
    expect(ink.filter((i) => i.kind === 'arrow')).toHaveLength(tree.edges.length);
    expect(ink.every((i) => i.surface === 'whiteboard' && i.drawMs > 0)).toBe(true);
  });

  it('linked lists end in None, arrays get indices and no arrows', () => {
    const list = diagramInk({ kind: 'list', nodes: [{ id: 'a', label: '3' }, { id: 'b', label: '7' }], edges: [{ from: 'a', to: 'b' }] }, { color: '#2F7BFF', accent: '#FFB224', group: 'g' });
    expect(list.some((i) => i.kind === 'text' && i.text === 'None')).toBe(true);
    const arr = diagramInk({ kind: 'array', nodes: [{ id: 'a', label: '3' }, { id: 'b', label: '7' }, { id: 'c', label: '9' }], edges: [{ from: 'a', to: 'b' }] }, { color: '#2F7BFF', accent: '#FFB224', group: 'g' });
    expect(arr.some((i) => i.kind === 'arrow')).toBe(false);
    expect(arr.filter((i) => i.kind === 'text' && /^\d$/.test(i.text ?? '') && i.fontSize === 16).map((i) => i.text)).toEqual(['0', '1', '2']);
  });
});
