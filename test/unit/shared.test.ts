import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS, findConflicts, formatAccelerator, isChordOnly, normalizeAccelerator, parseAccelerator } from '@shared/shortcuts';
import { defaultSettings, mergeSettings, patchSettings } from '@shared/settings';
import { costOf, priceRowFor } from '@shared/pricing';

describe('shortcuts', () => {
  it('parses and formats accelerators', () => {
    expect(parseAccelerator('Control+Alt+S')).toEqual({ modifiers: new Set(['Control', 'Alt']), key: 'S' });
    expect(formatAccelerator('Control+Alt+S', 'darwin')).toBe('⌃⌥S');
    expect(formatAccelerator('Alt+Control', 'darwin')).toBe('⌃⌥');
    expect(formatAccelerator('Control+Alt+S', 'win32')).toBe('Ctrl+Alt+S');
    expect(isChordOnly('Control+Alt')).toBe(true);
    expect(isChordOnly('Control+Alt+D')).toBe(false);
    expect(normalizeAccelerator('alt+ctrl+s')).toBe('Control+Alt+S');
  });

  it('defaults have no conflicts and conflicts are detected', () => {
    expect(findConflicts(DEFAULT_SHORTCUTS)).toEqual([]);
    const clash = { ...DEFAULT_SHORTCUTS, replay: 'Alt+Control+M' };
    expect(findConflicts(clash).sort()).toEqual(['replay', 'toggleMute']);
  });
});

describe('settings', () => {
  it('merges stored settings onto defaults and drops wrong types', () => {
    const merged = mergeSettings({ tutorName: 'Turing', playbackRate: 9, budget: { monthlyLimitUsd: 'lots' }, unknown: 1 });
    expect(merged.tutorName).toBe('Turing');
    expect(merged.playbackRate).toBe(1.4);
    expect(merged.budget.monthlyLimitUsd).toBe(defaultSettings().budget.monthlyLimitUsd);
    expect((merged as unknown as Record<string, unknown>).unknown).toBeUndefined();
  });

  it('patches nested values without losing siblings', () => {
    const s = patchSettings(defaultSettings(), { veil: { hideNotifications: false }, shortcuts: { replay: 'Control+Alt+Y' } });
    expect(s.veil.hideNotifications).toBe(false);
    expect(s.veil.apps.length).toBeGreaterThan(3);
    expect(s.shortcuts.replay).toBe('Control+Alt+Y');
    expect(s.shortcuts.toggleMute).toBe(DEFAULT_SHORTCUTS.toggleMute);
  });
});

describe('pricing', () => {
  it('applies dated price changes', () => {
    expect(priceRowFor('gemini-4-argon', new Date('2026-11-15')).input.default).toBe(2);
    expect(priceRowFor('gemini-4-argon', new Date('2026-12-02')).input.default).toBe(4);
    expect(priceRowFor('gemini-3.8-flash', new Date('2027-01-01')).output.default).toBe(7.5);
  });

  it('prices live usage per modality', () => {
    // 1 minute of audio in ≈ 1500 tokens, 30 s of audio out ≈ 750 tokens (25 tokens/s)
    const c = costOf('gemini-3.8-live', {
      promptTokenCount: 1500 + 280,
      responseTokenCount: 750,
      promptTokensDetails: [
        { modality: 'AUDIO', tokenCount: 1500 },
        { modality: 'IMAGE', tokenCount: 280 },
      ],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 750 }],
    });
    expect(c.usd).toBeCloseTo((1500 * 3 + 280 * 1 + 750 * 12) / 1e6, 9);
    expect(c.byModality.AUDIO).toBe(2250);
  });

  it('falls back to aggregate counts and charges thinking as output', () => {
    const c = costOf('gemini-3.8-flash', { promptTokenCount: 2000, candidatesTokenCount: 100, thoughtsTokenCount: 50 }, new Date('2026-10-19'));
    expect(c.usd).toBeCloseTo((2000 * 0.75 + 150 * 3.75) / 1e6, 9);
  });

  it('unknown models are priced conservatively', () => {
    expect(costOf('gemini-9-mystery', { promptTokenCount: 1e6 }).usd).toBeGreaterThanOrEqual(2);
  });
});
