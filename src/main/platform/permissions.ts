import { desktopCapturer, shell, systemPreferences } from 'electron';
import type { PermissionStatus } from '@shared/session';
import type { PermissionService } from './types';

type Kind = 'screen' | 'microphone' | 'accessibility';

const SETTINGS_URLS: Record<Kind, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

export interface NativeAvailability {
  hooks: boolean;
  input: boolean;
  windows: boolean;
}

/** macOS TCC permissions via Electron's systemPreferences (no native code needed). */
export class MacPermissions implements PermissionService {
  constructor(private readonly native: () => NativeAvailability) {}

  status(): PermissionStatus {
    return {
      platform: 'darwin',
      screen: systemPreferences.getMediaAccessStatus('screen') as PermissionStatus['screen'],
      microphone: systemPreferences.getMediaAccessStatus('microphone') as PermissionStatus['microphone'],
      accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
      native: this.native(),
    };
  }

  async request(kind: Kind): Promise<PermissionStatus> {
    if (kind === 'microphone') {
      await systemPreferences.askForMediaAccess('microphone');
    } else if (kind === 'accessibility') {
      // Shows the system "would like to control this computer" prompt once, then System Settings.
      systemPreferences.isTrustedAccessibilityClient(true);
    } else if (kind === 'screen') {
      // There is no direct prompt API; touching the capture API registers the app in the
      // Screen & System Audio Recording list and shows the system prompt the first time.
      try {
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      } catch {
        /* expected when not yet allowed */
      }
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') this.openSettings('screen');
    }
    return this.status();
  }

  openSettings(kind: Kind): void {
    void shell.openExternal(SETTINGS_URLS[kind]);
  }
}

/** Non-mac / fake: nothing to grant. */
export class AllowAllPermissions implements PermissionService {
  constructor(private readonly native: () => NativeAvailability, private readonly platformName: string = process.platform) {}

  status(): PermissionStatus {
    return {
      platform: this.platformName,
      screen: 'granted',
      microphone: 'granted',
      accessibility: 'granted',
      native: this.native(),
    };
  }

  async request(): Promise<PermissionStatus> {
    return this.status();
  }

  openSettings(): void {
    /* nothing to open */
  }
}
