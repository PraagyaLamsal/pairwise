import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { screen, type Display } from 'electron';
import { numberDisplays, type DisplayInfo, type Point, type Rect } from '@shared/geometry';
import { logger } from '../log';
import type { DisplayService } from './types';

const log = logger('displays');

/**
 * Global pointer position. macOS: Electron's screen API ([NSEvent mouseLocation], always current).
 * Linux/X11: Chromium only refreshes its cached pointer from X events it receives, and our
 * click-through overlays receive none, so it goes stale — query X directly through robotjs.
 */
let x11Pointer: (() => Point) | null | undefined;
export function pointerPosition(): Point {
  if (process.platform === 'linux') {
    if (x11Pointer === undefined) {
      try {
        const robot = createRequire(__filename)('@jitsi/robotjs') as { getMousePos(): Point };
        robot.getMousePos();
        x11Pointer = () => robot.getMousePos();
      } catch {
        x11Pointer = null;
      }
    }
    if (x11Pointer) return x11Pointer();
  }
  return screen.getCursorScreenPoint();
}

function fromElectron(d: Display, primaryId: number, i: number): DisplayInfo {
  return {
    id: String(d.id),
    bounds: { ...d.bounds },
    workArea: { ...d.workArea },
    scaleFactor: d.scaleFactor,
    label: d.label || (d.internal ? 'Built-in Display' : `Display ${i + 1}`),
    index: i + 1,
    isPrimary: d.id === primaryId,
  };
}

/** Real displays from Electron, re-emitting a debounced 'changed' on hot-plug or resolution changes. */
export class ElectronDisplayService extends EventEmitter implements DisplayService {
  private cache: DisplayInfo[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.refresh();
    const onChange = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.refresh();
        log.info('displays changed', this.cache.map((d) => `${d.label} ${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}x`));
        this.emit('changed', this.cache);
      }, 250);
    };
    screen.on('display-added', onChange);
    screen.on('display-removed', onChange);
    screen.on('display-metrics-changed', onChange);
  }

  private refresh(): void {
    const primaryId = screen.getPrimaryDisplay().id;
    this.cache = numberDisplays(screen.getAllDisplays().map((d, i) => fromElectron(d, primaryId, i)));
  }

  list(): DisplayInfo[] {
    return this.cache;
  }

  cursor(): Point {
    return pointerPosition();
  }

  primary(): DisplayInfo {
    return this.cache.find((d) => d.isPrimary) ?? this.cache[0];
  }

  byId(id: string): DisplayInfo | undefined {
    return this.cache.find((d) => d.id === id);
  }
}

/**
 * Virtual displays laid out inside one real X screen (CI / Linux). Lets the multi-monitor and
 * HiDPI paths run end-to-end: overlays are placed at these bounds and capture crops them out of
 * the single real screen source.
 */
export class FakeDisplayService extends EventEmitter implements DisplayService {
  private readonly displays: DisplayInfo[];

  constructor(spec: string) {
    super();
    const parsed = JSON.parse(spec) as { bounds: Rect; scaleFactor?: number; label?: string }[];
    this.displays = numberDisplays(
      parsed.map((p, i) => ({
        id: `fake-${i + 1}`,
        bounds: p.bounds,
        workArea: p.bounds,
        scaleFactor: p.scaleFactor ?? 1,
        label: p.label ?? `Fake Display ${i + 1}`,
        index: i + 1,
        isPrimary: i === 0,
      })),
    );
  }

  list(): DisplayInfo[] {
    return this.displays;
  }

  cursor(): Point {
    return pointerPosition();
  }

  primary(): DisplayInfo {
    return this.displays.find((d) => d.isPrimary) ?? this.displays[0];
  }

  byId(id: string): DisplayInfo | undefined {
    return this.displays.find((d) => d.id === id);
  }
}
