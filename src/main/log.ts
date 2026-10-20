import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

let logFile: string | null = null;
const ring: string[] = [];

export function initLogFile(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, `pairwise-${new Date().toISOString().slice(0, 10)}.log`);
  } catch {
    logFile = null;
  }
}

/** Never log secrets: keys, tokens and base64 payloads are redacted. */
export function redact(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, 'AIza…redacted')
    .replace(/([?&]key=)[^&\s"]+/g, '$1…redacted')
    .replace(/"data":"[A-Za-z0-9+/=]{200,}"/g, '"data":"…base64…"');
}

function write(level: Level, scope: string, parts: unknown[]): void {
  const msg = parts
    .map((p) => (p instanceof Error ? `${p.message}\n${p.stack ?? ''}` : typeof p === 'string' ? p : safeJson(p)))
    .join(' ');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(msg)}`;
  ring.push(line);
  if (ring.length > 500) ring.shift();
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (process.env.PAIRWISE_QUIET !== '1') console.log(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch {
      /* ignore */
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(...p: unknown[]): void;
  info(...p: unknown[]): void;
  warn(...p: unknown[]): void;
  error(...p: unknown[]): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (...p) => (process.env.PAIRWISE_DEBUG ? write('debug', scope, p) : undefined),
    info: (...p) => write('info', scope, p),
    warn: (...p) => write('warn', scope, p),
    error: (...p) => write('error', scope, p),
  };
}

export function recentLogLines(): string[] {
  return [...ring];
}
