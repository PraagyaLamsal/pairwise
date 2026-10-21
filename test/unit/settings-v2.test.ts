import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, mergeSettings, patchSettings, SETTINGS_VERSION } from '../../src/shared/settings';

describe('settings v2 (round 2)', () => {
  it('fresh installs: captions off, typed notes, no follow option', () => {
    const s = defaultSettings();
    expect(s.version).toBe(2);
    expect(s.captions).toBe(false);
    expect(s.noteStyle).toBe('typed');
    expect('cursorBehavior' in s).toBe(false);
  });

  it('migrates a round-1 file: captions off once, follow dropped, HUD position kept for its display', () => {
    const v1 = { version: 1, captions: true, cursorBehavior: 'follow', tutorName: 'Ada', hudPosition: { x: 400, y: 30, displayId: '69733378' } };
    const s = mergeSettings(v1);
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.captions).toBe(false);
    expect((s as unknown as Record<string, unknown>).cursorBehavior).toBeUndefined();
    expect(s.hudPositions).toEqual({ '69733378': { x: 400, y: 30 } });
    // After the migration the student's own choice sticks.
    const on = patchSettings(s, { captions: true });
    expect(mergeSettings(JSON.parse(JSON.stringify(on))).captions).toBe(true);
  });

  it('remembers the session bar per display and ignores junk', () => {
    let s = patchSettings(defaultSettings(), { hudPositions: { a: { x: 10, y: 20 } } });
    s = patchSettings(s, { hudPositions: { b: { x: 900, y: 8 } } });
    expect(s.hudPositions).toEqual({ a: { x: 10, y: 20 }, b: { x: 900, y: 8 } });
    expect(mergeSettings({ version: 2, hudPositions: { a: { x: 'left' }, b: { x: 3, y: 4 } } }).hudPositions).toEqual({ b: { x: 3, y: 4 } });
  });
});

describe('API key saved by another build', () => {
  it('is reported as unreadable (so the hub asks for it again) instead of silently missing', async () => {
    vi.resetModules();
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`enc:${s}`),
      decryptString: (b: Buffer) => {
        const t = b.toString('utf8');
        if (!t.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
        return t.slice(4);
      },
    };
    vi.doMock('electron', () => ({ safeStorage, app: { isPackaged: true, getPath: () => tmpdir() } }));
    const { SettingsService } = await import('../../src/main/settings');
    const dir = mkdtempSync(join(tmpdir(), 'pw-key-'));
    mkdirSync(join(dir, 'secrets'));
    // Encrypted with a different keychain entry ("Electron Safe Storage" under npm run dev).
    writeFileSync(join(dir, 'secrets', 'gemini.key.enc'), Buffer.from([0x76, 0x31, 0x30, 0x9a, 0x11, 0x42, 0x07]));
    const prev = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY };
    const svc = new SettingsService(dir);
    expect(svc.getApiKey()).toBe('');
    const st = svc.apiKeyStatus();
    expect(st).toMatchObject({ hasKey: false, source: 'none', unreadable: true });
    expect(svc.keyUnreadable).toBe(true);
    // Pasting it again fixes it.
    svc.setApiKey('AIzaTEST1234');
    expect(svc.apiKeyStatus()).toMatchObject({ hasKey: true, source: 'keychain', preview: 'AIza…1234' });
    expect(svc.apiKeyStatus().unreadable).toBeUndefined();
    void prev;
    vi.doUnmock('electron');
  });
});
