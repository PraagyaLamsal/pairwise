import { useCallback, useEffect, useRef, useState } from 'react';
import type { Course } from '@shared/courses';
import type { EventChannel, EventMap } from '@shared/ipc';
import { IDLE_SNAPSHOT, type PermissionStatus, type SessionSnapshot, type UsageSummary } from '@shared/session';
import type { DeepPartial, Settings } from '@shared/settings';
import { ipc } from './ipc';

export function useIpcEvent<K extends EventChannel>(channel: K, fn: (p: EventMap[K]) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => ipc.on(channel, (p) => ref.current(p)), [channel]);
}

export function useSettings(): [Settings | null, (patch: DeepPartial<Settings>) => Promise<void>] {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    void ipc.invoke('settings:get').then(setS);
  }, []);
  useIpcEvent('settings:changed', setS);
  const update = useCallback(async (patch: DeepPartial<Settings>) => {
    setS(await ipc.invoke('settings:update', patch));
  }, []);
  return [s, update];
}

export function useCourses(): [Course[], () => Promise<void>] {
  const [list, setList] = useState<Course[]>([]);
  const reload = useCallback(async () => setList(await ipc.invoke('courses:list')), []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useIpcEvent('courses:changed', setList);
  return [list, reload];
}

export function useSnapshot(): SessionSnapshot {
  const [s, setS] = useState<SessionSnapshot>(IDLE_SNAPSHOT);
  useEffect(() => {
    void ipc.invoke('session:snapshot').then(setS).catch(() => undefined);
  }, []);
  useIpcEvent('session:snapshot', setS);
  return s;
}

export function useUsage(): UsageSummary | null {
  const [u, setU] = useState<UsageSummary | null>(null);
  useEffect(() => {
    void ipc.invoke('usage:summary').then(setU).catch(() => undefined);
  }, []);
  useIpcEvent('usage:changed', setU);
  return u;
}

/** Polls permission state (TCC changes don't emit events) while mounted. */
export function usePermissions(intervalMs = 1500): [PermissionStatus | null, () => Promise<void>] {
  const [p, setP] = useState<PermissionStatus | null>(null);
  const refresh = useCallback(async () => setP(await ipc.invoke('permissions:status')), []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);
  return [p, refresh];
}

/** Re-render every `ms` (live timers). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
