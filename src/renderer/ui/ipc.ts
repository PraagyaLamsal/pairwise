import type { EventChannel, EventMap, InvokeChannel, InvokeMap, SendChannel, SendMap, WindowRole } from '@shared/ipc';

interface PreloadApi {
  role: WindowRole;
  displayId: string;
  platform: string;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, payload: unknown): void;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    pw: PreloadApi;
  }
}

/** Fallback so pages can be opened in a plain browser for design work (no IPC). */
const stub: PreloadApi = {
  role: 'hub',
  displayId: '',
  platform: 'darwin',
  invoke: () => Promise.reject(new Error('IPC unavailable outside Electron')),
  send: () => undefined,
  on: () => () => undefined,
};

const api = (): PreloadApi => (typeof window !== 'undefined' && window.pw ? window.pw : stub);

export const ipc = {
  get role(): WindowRole {
    return api().role;
  },
  get displayId(): string {
    return api().displayId;
  },
  get platform(): string {
    return api().platform;
  },
  invoke<K extends InvokeChannel>(channel: K, ...args: Parameters<InvokeMap[K]>): Promise<Awaited<ReturnType<InvokeMap[K]>>> {
    return api().invoke(channel, ...args) as Promise<Awaited<ReturnType<InvokeMap[K]>>>;
  },
  send<K extends SendChannel>(channel: K, payload: SendMap[K]): void {
    api().send(channel, payload);
  },
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void {
    return api().on(channel, listener as (p: unknown) => void);
  },
};
