import { EventEmitter } from 'node:events';
import type { InkItem } from '@shared/ink';
import { shiftInk } from '@shared/ink-geometry';
import type { InkOp } from '@shared/ipc';

export const FADE_MS = 650;

/**
 * Source of truth for every annotation on screen (and on the whiteboard). Emits 'op' with the
 * InkOp to broadcast; keeps the live list so late-joining overlays (display hot-plug) and session
 * notes can be rebuilt from it.
 */
export class InkManager extends EventEmitter {
  private items = new Map<string, InkItem>();
  private gc: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.gc = setInterval(() => this.collect(), 1000);
  }

  all(): InkItem[] {
    return [...this.items.values()];
  }

  live(surface?: InkItem['surface']): InkItem[] {
    const now = Date.now();
    return this.all().filter((i) => (!surface || i.surface === surface) && (i.fadeAt == null || i.fadeAt + FADE_MS > now));
  }

  add(items: InkItem[]): void {
    if (!items.length) return;
    for (const it of items) this.items.set(it.id, it);
    this.emit('op', { op: 'add', items } satisfies InkOp);
  }

  update(items: InkItem[]): void {
    const changed = items.filter((i) => this.items.has(i.id));
    for (const it of changed) this.items.set(it.id, it);
    if (changed.length) this.emit('op', { op: 'update', items: changed } satisfies InkOp);
  }

  /**
   * Move matching items by (dx, dy) because what they mark moved (the student scrolled); drawn
   * ones glide there over `ms`.
   */
  shift(filter: { ids?: string[]; group?: string }, dx: number, dy: number, ms = 180): InkItem[] {
    const now = Date.now();
    const moved: InkItem[] = [];
    for (const [id, it] of this.items) {
      if (filter.ids && !filter.ids.includes(id)) continue;
      if (filter.group && it.group !== filter.group) continue;
      const next = shiftInk(it, dx, dy, now, ms);
      this.items.set(id, next);
      moved.push(next);
    }
    if (moved.length) this.emit('op', { op: 'update', items: moved } satisfies InkOp);
    return moved;
  }

  /**
   * Park marks (hide them, `on`) whose line scrolled out of view, or bring them back when it's
   * in view again. Parked marks keep moving with their group.
   */
  park(ids: string[], on: boolean): InkItem[] {
    const now = Date.now();
    const changed: InkItem[] = [];
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it || Boolean(it.park?.on) === on) continue;
      const next: InkItem = { ...it, park: { on, at: now } };
      this.items.set(id, next);
      changed.push(next);
    }
    if (changed.length) this.emit('op', { op: 'update', items: changed } satisfies InkOp);
    return changed;
  }

  /** Remove items immediately (scheduled marks that will never be drawn). */
  remove(ids: string[]): void {
    const gone = ids.filter((id) => this.items.delete(id));
    if (gone.length) this.emit('op', { op: 'remove', ids: gone } satisfies InkOp);
  }

  /** Start fading matching items now (or at `at`). */
  fade(filter: { ids?: string[]; group?: string; author?: InkItem['author'] }, at = Date.now()): number {
    let n = 0;
    for (const it of this.items.values()) {
      if (filter.ids && !filter.ids.includes(it.id)) continue;
      if (filter.group && it.group !== filter.group) continue;
      if (filter.author && it.author !== filter.author) continue;
      if (it.fadeAt != null && it.fadeAt <= at) continue;
      it.fadeAt = at;
      n++;
    }
    if (n) this.emit('op', { op: 'fade', ids: filter.ids, group: filter.group, author: filter.author, at } satisfies InkOp);
    return n;
  }

  clear(filter: { author?: InkItem['author']; group?: string } = {}): void {
    for (const [id, it] of this.items) {
      if (filter.author && it.author !== filter.author) continue;
      if (filter.group && it.group !== filter.group) continue;
      this.items.delete(id);
    }
    this.emit('op', { op: 'clear', ...filter } satisfies InkOp);
  }

  /** Remove fully faded items from memory (overlays drop them on their own). */
  private collect(): void {
    const now = Date.now();
    for (const [id, it] of this.items) if (it.fadeAt != null && it.fadeAt + FADE_MS + 500 < now) this.items.delete(id);
  }

  dispose(): void {
    if (this.gc) clearInterval(this.gc);
    this.gc = null;
    this.items.clear();
  }
}
