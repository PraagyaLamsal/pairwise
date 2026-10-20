import type { EngineCommand } from '@shared/ipc';
import { ipc } from '../ui/ipc';
import { AudioEngine } from './audio';
import { ScreenCapture } from './capture';

const audio = new AudioEngine();
const capture = new ScreenCapture();

window.setInterval(() => capture.gc(), 10_000);

ipc.on('engine:command', (cmd: EngineCommand) => {
  void handle(cmd).catch((e) => ipc.send('engine:log', { level: 'error', message: `${cmd.type}: ${(e as Error).message}` }));
});

async function handle(cmd: EngineCommand): Promise<void> {
  switch (cmd.type) {
    case 'startAudio':
      await audio.start(cmd.echoCancellation, cmd.playbackRate);
      break;
    case 'stopAudio':
      audio.stop();
      break;
    case 'setMuted':
      audio.setMuted(cmd.muted);
      break;
    case 'gate':
      audio.setGate(cmd.open);
      break;
    case 'play':
      audio.play(cmd.pcm, cmd.turnId);
      break;
    case 'flush':
      audio.flush();
      break;
    case 'duck':
      audio.duck(cmd.level);
      break;
    case 'replay':
      audio.replay();
      break;
    case 'setRate':
      audio.setRate(cmd.rate);
      break;
    case 'chime':
      audio.chime(cmd.kind);
      break;
    case 'startCapture':
      await capture.start(cmd.sources, cmd.activeDisplayId, cmd.maxLiveWidth, cmd.quality);
      break;
    case 'stopCapture':
      capture.stop();
      break;
    case 'setActiveDisplay':
      await capture.setActive(cmd.displayId);
      break;
    case 'setVeil':
      capture.setVeil(cmd.rects);
      break;
    case 'setLiveCapture':
      capture.setLive(cmd.enabled);
      break;
    case 'captureNow': {
      const frame = await capture.captureNow(cmd);
      if (frame && cmd.kind !== 'crop') capture.markSent();
      ipc.send('engine:reply', { requestId: cmd.requestId, ok: Boolean(frame), frame: frame ?? undefined, error: frame ? undefined : 'capture failed' });
      break;
    }
  }
}

/** Main asks the engine whether a video seems to be playing (for auto-pause). */
(window as unknown as { pwVideoLikely: () => boolean }).pwVideoLikely = () => capture.videoLikely;

ipc.send('engine:ready', {});
