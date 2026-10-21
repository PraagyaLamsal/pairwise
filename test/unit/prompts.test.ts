import { describe, expect, it } from 'vitest';
import { defaultSettings, patchSettings } from '../../src/shared/settings';
import { openingTurn, systemInstruction, type PromptContext } from '../../src/main/session/prompts';

const display = { id: 'd1', index: 1, label: 'Built-in Display', bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 }, scaleFactor: 2, primary: true };
const ctx = (patch = {}, extra: Partial<PromptContext> = {}): PromptContext => ({
  settings: patchSettings(defaultSettings(), patch),
  course: { id: 'c', code: 'COMP 1405', name: 'Intro to CS', color: '#2F7BFF', assignments: [], createdAt: 0 } as unknown as PromptContext['course'],
  displays: [display] as unknown as PromptContext['displays'],
  activeDisplay: display as unknown as PromptContext['activeDisplay'],
  hasCourseMaterial: false,
  platform: 'darwin',
  ...extra,
});

describe('the tutor prompt', () => {
  it('asks for quick checks as often as the student wants them', () => {
    expect(systemInstruction(ctx())).toMatch(/Now and then, check understanding with ask_to_point/);
    expect(systemInstruction(ctx({ quickChecks: 'often' }))).toMatch(/Check understanding often with ask_to_point/);
    const off = systemInstruction(ctx({ quickChecks: 'off' }));
    expect(off).not.toMatch(/ask_to_point/);
    expect(off).toMatch(/turned quick checks off/);
  });

  it('points traces at trace_code, not think_deeply', () => {
    const p = systemInstruction(ctx());
    expect(p).toMatch(/call trace_code/);
    expect(p).toMatch(/to show what code does step by step, use trace_code instead/);
  });

  it('offers a missed quick check again next time, unless checks are off', () => {
    const resume = { courseId: 'c', savedAt: 0, summary: 'We traced factorial.', openQuestions: [], toReview: ['Quick check to try again: “Click the base case”'], transcriptTail: [] };
    expect(openingTurn(ctx({}, { resume }))).toMatch(/try a missed quick check again/);
    expect(openingTurn(ctx({ quickChecks: 'off' }, { resume }))).not.toMatch(/quick check again/);
  });
});
