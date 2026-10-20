import type { WindowInfo, WindowLister } from './types';
import { logger } from '../log';

const log = logger('windows');

interface GetWindowsResult {
  id: number;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  owner: { name: string; processId: number; bundleId?: string; path?: string };
}

/**
 * On-screen windows with bounds and owning app (CGWindowList through get-windows' bundled
 * binary). Permission prompts are disabled: we only need bounds + owner, not titles.
 */
export class GetWindowsLister implements WindowLister {
  private mod: { openWindows(o?: unknown): Promise<GetWindowsResult[]> } | null = null;
  private loadFailed = false;
  private lastError = 0;

  get available(): boolean {
    return !this.loadFailed;
  }

  async list(): Promise<WindowInfo[]> {
    if (this.loadFailed) return [];
    try {
      if (!this.mod) this.mod = (await import('get-windows')) as unknown as { openWindows(o?: unknown): Promise<GetWindowsResult[]> };
      const wins = await this.mod.openWindows({ accessibilityPermission: false, screenRecordingPermission: false });
      return wins.map((w) => ({
        id: w.id,
        title: w.title ?? '',
        app: w.owner?.name ?? '',
        bundleId: w.owner?.bundleId,
        pid: w.owner?.processId,
        bounds: { ...w.bounds },
      }));
    } catch (e) {
      if (!this.mod) {
        this.loadFailed = true;
        log.warn('get-windows unavailable; App Veil cannot detect windows', e);
      } else if (Date.now() - this.lastError > 30_000) {
        this.lastError = Date.now();
        log.warn('window list failed', e);
      }
      return [];
    }
  }
}

/** Fake windows from PAIRWISE_FAKE_WINDOWS (JSON array of WindowInfo) — used by veil tests. */
export class FakeWindowLister implements WindowLister {
  readonly available = true;
  windows: WindowInfo[] = [];

  constructor(spec?: string) {
    if (spec) {
      try {
        this.windows = JSON.parse(spec) as WindowInfo[];
      } catch {
        this.windows = [];
      }
    }
  }

  async list(): Promise<WindowInfo[]> {
    return this.windows.map((w) => ({ ...w, bounds: { ...w.bounds } }));
  }
}
