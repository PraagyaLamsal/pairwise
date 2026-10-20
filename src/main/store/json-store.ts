import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Read JSON, returning `fallback` when the file is missing or corrupt (corrupt files are kept as .bad). */
export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    try {
      renameSync(file, `${file}.bad-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return fallback;
  }
}

/** Atomic write: write to a temp file, then rename over the target. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/** Debounced writer so rapid updates (sliders, counters) do not hammer the disk. */
export class DebouncedJsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  private pending: T | null = null;

  constructor(private readonly file: string, private readonly delayMs = 250) {}

  write(value: T): void {
    this.pending = value;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending !== null) {
      writeJson(this.file, this.pending);
      this.pending = null;
    }
  }
}
