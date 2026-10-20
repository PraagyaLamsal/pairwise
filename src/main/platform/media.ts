import { execFile } from 'node:child_process';
import type { AutoPauseMedia } from '@shared/settings';
import type { InputDriver, MediaControl, MediaPauseResult } from './types';
import { logger } from '../log';

const log = logger('media');

const BROWSERS = ['Google Chrome', 'Safari', 'Arc', 'Firefox', 'Microsoft Edge', 'Brave Browser', 'Opera', 'Vivaldi', 'Chromium', 'Dia', 'Zen'];

/** Players with a reliable AppleScript "player state" (pause/resume exactly what was playing). */
const SCRIPTABLE_PLAYERS: { app: string; isPlaying: string; pause: string; play: string }[] = [
  { app: 'Spotify', isPlaying: 'player state is playing', pause: 'pause', play: 'play' },
  { app: 'Music', isPlaying: 'player state is playing', pause: 'pause', play: 'play' },
  { app: 'TV', isPlaying: 'player state is playing', pause: 'pause', play: 'play' },
  { app: 'Podcasts', isPlaying: 'player state is playing', pause: 'pause', play: 'play' },
  { app: 'QuickTime Player', isPlaying: '(count of (documents whose playing is true)) > 0', pause: 'pause (documents whose playing is true)', play: 'play front document' },
  { app: 'VLC', isPlaying: 'playing', pause: 'play', play: 'play' },
];

/** Names of running .app bundles (from `ps`), so AppleScript never targets an app that isn't open. */
function runningAppNames(): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'comm='], { timeout: 1500, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const names = new Set<string>();
      if (!err) {
        for (const line of stdout.split('\n')) {
          const m = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(line);
          if (m) names.add(m[1]);
        }
      }
      resolve(names);
    });
  });
}

function osascript(script: string, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Auto-pause: scriptable players are paused through AppleScript (only if actually playing, and
 * never launching an app). Browser video uses the play/pause media key, but only when frame
 * analysis says video is likely playing — a blind media-key press would start Music.app.
 */
export class MacMedia implements MediaControl {
  private paused: { via: 'applescript'; app: string } | { via: 'media-key' } | null = null;

  constructor(private readonly driver: InputDriver, private readonly mode: () => AutoPauseMedia) {}

  get pausedByUs(): boolean {
    return this.paused !== null;
  }

  async pauseIfPlaying(hint: { videoLikely: boolean; frontApp?: string }): Promise<MediaPauseResult> {
    const mode = this.mode();
    if (mode === 'off' || this.paused) return { paused: false };

    if (mode === 'smart') {
      const running = await runningAppNames();
      for (const p of SCRIPTABLE_PLAYERS) {
        if (!running.has(p.app)) continue;
        try {
          const out = await osascript(
            `if application "${p.app}" is running then\n tell application "${p.app}"\n if ${p.isPlaying} then\n ${p.pause}\n return "paused"\n end if\n end tell\nend if\nreturn "no"`,
          );
          if (out === 'paused') {
            this.paused = { via: 'applescript', app: p.app };
            log.info(`paused ${p.app}`);
            return { paused: true, via: 'applescript', app: p.app };
          }
        } catch {
          /* app not scriptable / automation not allowed — try the next */
        }
      }
    }

    const browserFront = hint.frontApp ? BROWSERS.some((b) => hint.frontApp?.includes(b)) : true;
    if (hint.videoLikely && browserFront && this.driver.available) {
      this.driver.mediaPlayPause();
      this.paused = { via: 'media-key' };
      log.info('paused media via media key');
      return { paused: true, via: 'media-key' };
    }
    return { paused: false };
  }

  async resume(): Promise<boolean> {
    const p = this.paused;
    this.paused = null;
    if (!p) return false;
    if (p.via === 'media-key') {
      if (this.driver.available) this.driver.mediaPlayPause();
      return true;
    }
    const player = SCRIPTABLE_PLAYERS.find((s) => s.app === p.app);
    if (!player) return false;
    try {
      await osascript(`if application "${p.app}" is running then tell application "${p.app}" to ${player.play}`);
      return true;
    } catch (e) {
      log.warn('resume failed', e);
      return false;
    }
  }
}

/** Fake / non-mac: uses the media key on the same video heuristic so the flow is testable. */
export class KeyOnlyMedia implements MediaControl {
  private paused = false;
  constructor(private readonly driver: InputDriver, private readonly mode: () => AutoPauseMedia) {}
  get pausedByUs(): boolean {
    return this.paused;
  }
  async pauseIfPlaying(hint: { videoLikely: boolean }): Promise<MediaPauseResult> {
    if (this.mode() === 'off' || this.paused || !hint.videoLikely || !this.driver.available) return { paused: false };
    this.driver.mediaPlayPause();
    this.paused = true;
    return { paused: true, via: 'media-key' };
  }
  async resume(): Promise<boolean> {
    if (!this.paused) return false;
    this.paused = false;
    if (this.driver.available) this.driver.mediaPlayPause();
    return true;
  }
}
