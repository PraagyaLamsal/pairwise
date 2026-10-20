import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS, type WindowRole } from '../shared/ipc';

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const role = (arg('pw-role') ?? 'hub') as WindowRole;
const displayId = arg('pw-display') ?? '';

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const eventSet = new Set<string>(EVENT_CHANNELS);
const sendSet = new Set<string>(SEND_CHANNELS);

const api = {
  role,
  displayId,
  platform: process.platform,
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!invokeSet.has(channel)) return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel: string, payload: unknown): void {
    if (!sendSet.has(channel)) throw new Error(`IPC channel not allowed: ${channel}`);
    ipcRenderer.send(channel, payload);
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!eventSet.has(channel)) throw new Error(`IPC channel not allowed: ${channel}`);
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('pw', api);

export type PreloadApi = typeof api;
