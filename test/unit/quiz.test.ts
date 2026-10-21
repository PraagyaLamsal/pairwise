import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { on() {} }, app: { isPackaged: false } }));
const { offTarget, ringStroke } = await import('../../src/main/session/features/quiz');

describe('"Show me" answers (ask_to_point)', () => {
  const line = { x: 100, y: 200, width: 180, height: 24 };

  it('a click on the answer counts, with a little slack for small targets', () => {
    expect(offTarget(line, { x: 150, y: 212 })).toBe(0);
    expect(offTarget(line, { x: 100 + 180 + 6, y: 212 })).toBe(0); // just past the end
    expect(offTarget(line, { x: 150, y: 200 - 6 })).toBe(0); // just above
    const tiny = { x: 300, y: 300, width: 10, height: 10 };
    expect(offTarget(tiny, { x: 314, y: 305 })).toBe(0); // 6 px slack minimum
  });

  it('a click elsewhere reports how far off it was', () => {
    // The next line down (24 px below): off by about a line.
    expect(offTarget(line, { x: 150, y: 248 })).toBe(Math.round(248 - (224 + 7.2)));
    expect(offTarget(line, { x: 600, y: 212 })).toBeGreaterThan(300);
    const d = offTarget(line, { x: 400, y: 400 });
    expect(d).toBeGreaterThan(Math.hypot(400 - 287, 400 - 231) - 1);
  });

  it('the click is drawn into the frame the tutor gets as a closed ring around it', () => {
    const r = ringStroke({ x: 50, y: 60 });
    expect(r.points.length).toBeGreaterThan(20);
    for (const p of r.points) expect(Math.hypot(p.x - 50, p.y - 60)).toBeCloseTo(14, 5);
    expect(r.points[0].x).toBeCloseTo(r.points[r.points.length - 1].x, 5);
  });
});

const { checksForNotes } = await import('../../src/main/session/features/quiz');

describe('quick checks in the session notes', () => {
  it('lists each check once, with tries, and keeps the missed ones to review', () => {
    const { lines, missed, right, total } = checksForNotes([
      { question: 'Click the line where the recursion stops', outcome: 'right' },
      { question: 'Click the button that runs the code', outcome: 'wrong' },
      { question: 'Click the button that runs the code', outcome: 'right' },
      { question: 'Click where n gets smaller', outcome: 'skipped' },
      { question: 'Click the base case', outcome: 'wrong' },
      { question: 'Point at anything', outcome: 'answered' },
    ]);
    // The score for the course page: 2 of 4 (the unchecked one doesn't count).
    expect([right, total]).toEqual([2, 4]);
    expect(lines).toEqual([
      '✓ Click the line where the recursion stops',
      '✓ Click the button that runs the code (second try)',
      '– Click where n gets smaller (skipped)',
      '✗ Click the base case — worth another look',
      '• Point at anything',
    ]);
    expect(missed).toEqual(['Quick check to try again: “Click where n gets smaller”', 'Quick check to try again: “Click the base case”']);
    expect(checksForNotes([])).toEqual({ lines: [], missed: [], right: 0, total: 0 });
  });

  it('a question asked again once they had it right is a new check, not another try', () => {
    const q = 'Click the line where the recursion stops';
    const { lines, right, total } = checksForNotes([
      { question: q, outcome: 'right' },
      { question: q, outcome: 'wrong' },
      { question: q, outcome: 'right' },
    ]);
    expect(lines).toEqual([`✓ ${q}`, `✓ ${q} (second try)`]);
    expect([right, total]).toEqual([2, 2]);
  });
});
