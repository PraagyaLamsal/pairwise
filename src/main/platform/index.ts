import type { AutoPauseMedia } from '@shared/settings';
import type { RunningApp } from '@shared/ipc';
import { env } from '../env';
import { ElectronDisplayService, FakeDisplayService } from './displays';
import { AllowAllPermissions, MacPermissions } from './permissions';
import { FakeHooks, UiohookInput } from './hooks';
import { RecordingDriver, RobotDriver } from './driver';
import { FakeWindowLister, GetWindowsLister } from './windows';
import { KeyOnlyMedia, MacMedia } from './media';
import type { Platform } from './types';

export * from './types';

/**
 * Builds the OS integration layer. On macOS everything is real. With PAIRWISE_FAKE_PLATFORM=1
 * the parts that would touch the user's machine (input hooks, synthetic input, window list,
 * permissions) are replaced with recording fakes so tests can drive and assert on them.
 */
export function createPlatform(mediaMode: () => AutoPauseMedia): Platform {
  const displays = env.fakeDisplays ? new FakeDisplayService(env.fakeDisplays) : new ElectronDisplayService();

  if (env.fakePlatform) {
    const hooks = new FakeHooks();
    const driver = new RecordingDriver();
    const windows = new FakeWindowLister(process.env.PAIRWISE_FAKE_WINDOWS);
    return {
      kind: 'fake',
      displays,
      permissions: new AllowAllPermissions(() => ({ hooks: true, input: true, windows: true }), 'fake'),
      hooks,
      driver,
      windows,
      media: new KeyOnlyMedia(driver, mediaMode),
      runningApps: async () => uniqueApps((await windows.list()).map((w) => ({ name: w.app, bundleId: w.bundleId }))),
      frontmostApp: async () => null,
    };
  }

  const hooks = new UiohookInput();
  const driver = new RobotDriver();
  const windows = new GetWindowsLister();
  const native = () => ({ hooks: hooks.available, input: driver.available, windows: windows.available });

  return {
    kind: env.isMac ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
    displays,
    permissions: env.isMac ? new MacPermissions(native) : new AllowAllPermissions(native),
    hooks,
    driver,
    windows,
    media: env.isMac ? new MacMedia(driver, mediaMode) : new KeyOnlyMedia(driver, mediaMode),
    runningApps: async () => uniqueApps((await windows.list()).map((w) => ({ name: w.app, bundleId: w.bundleId }))),
    frontmostApp: async () => {
      try {
        const mod = (await import('get-windows')) as unknown as {
          activeWindow(o?: unknown): Promise<{ owner: { name: string; bundleId?: string } } | undefined>;
        };
        const w = await mod.activeWindow({ accessibilityPermission: false, screenRecordingPermission: false });
        return w ? { name: w.owner.name, bundleId: w.owner.bundleId } : null;
      } catch {
        return null;
      }
    },
  };
}

function uniqueApps(apps: RunningApp[]): RunningApp[] {
  const seen = new Map<string, RunningApp>();
  for (const a of apps) if (a.name && !seen.has(a.bundleId ?? a.name)) seen.set(a.bundleId ?? a.name, a);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
