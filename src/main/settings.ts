import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { defaultSettings, mergeSettings, patchSettings, type DeepPartial, type Settings } from '@shared/settings';
import { DEFAULT_SHORTCUTS } from '@shared/shortcuts';
import type { ApiKeyStatus } from '@shared/ipc';
import { DebouncedJsonFile, readJson } from './store/json-store';
import { env } from './env';
import { logger } from './log';

const log = logger('settings');

export class SettingsService extends EventEmitter {
  private current: Settings;
  private readonly file: DebouncedJsonFile<Settings>;
  private readonly secretFile: string;

  constructor(private readonly dataDir: string) {
    super();
    const path = join(dataDir, 'settings.json');
    this.current = mergeSettings(readJson<unknown>(path, {}));
    this.file = new DebouncedJsonFile<Settings>(path);
    this.secretFile = join(dataDir, 'secrets', 'gemini.key.enc');
  }

  get(): Settings {
    return this.current;
  }

  update(patch: DeepPartial<Settings>): Settings {
    this.current = patchSettings(this.current, patch);
    this.file.write(this.current);
    this.emit('changed', this.current);
    return this.current;
  }

  resetShortcuts(): Settings {
    return this.update({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  }

  flush(): void {
    this.file.flush();
  }

  // ---------------------------------------------------------------------------
  // API key. Stored encrypted with safeStorage (Keychain-backed on macOS). The
  // GEMINI_API_KEY environment variable is honoured for development.
  // ---------------------------------------------------------------------------

  getApiKey(): string {
    if (existsSync(this.secretFile)) {
      try {
        const buf = readFileSync(this.secretFile);
        if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
        return buf.toString('utf8').replace(/^plain:/, '');
      } catch (e) {
        log.warn('could not decrypt stored API key', e);
      }
    }
    return env.apiKeyFromEnv;
  }

  apiKeyStatus(): ApiKeyStatus {
    const stored = existsSync(this.secretFile);
    const key = this.getApiKey();
    return {
      hasKey: Boolean(key),
      source: stored ? 'keychain' : key ? 'env' : 'none',
      preview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : undefined,
    };
  }

  setApiKey(key: string): void {
    mkdirSync(join(this.dataDir, 'secrets'), { recursive: true });
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(this.secretFile, safeStorage.encryptString(key.trim()), { mode: 0o600 });
    } else {
      // Linux without a keyring (CI). Never the case on macOS.
      log.warn('safeStorage unavailable; storing key with file permissions only');
      writeFileSync(this.secretFile, `plain:${key.trim()}`, { mode: 0o600 });
    }
    this.emit('apiKeyChanged');
  }

  clearApiKey(): void {
    rmSync(this.secretFile, { force: true });
    this.emit('apiKeyChanged');
  }

  static defaults(): Settings {
    return defaultSettings();
  }
}
