import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { Course, CourseChunk, IndexStatus, SearchHit } from '@shared/courses';
import type { CourseFile } from '@shared/ipc';
import type { CourseStore } from './store';
import type { GeminiRest } from '../gemini/rest';
import { readJson, writeJson } from '../store/json-store';
import { extractFile, looksLikeAssignment, SUPPORTED_EXT, CODE_EXT } from './extract';
import { toChunks } from './chunks';
import { Bm25, cosine, fuse } from './search';
import { buildProfile } from './profile';
import { logger } from '../log';

const log = logger('course-brain');

const INDEX_VERSION = 2;
// "Pairwise notes" is where session notes are written — not course material.
const SKIP_DIRS = new Set(['Pairwise notes', 'node_modules', '__pycache__', '.git', '.svn', 'venv', '.venv', 'env', 'site-packages', 'dist', 'build', 'target', '.idea', '.vscode', '.gradle', '.next', 'DerivedData']);
const MAX_FILES = 3000;
const MAX_EMBED = 4000;

interface FileEntry {
  size: number;
  mtimeMs: number;
  kind: CourseChunk['kind'] | 'unsupported';
  chunkIds: string[];
  error?: string;
}

interface StoredIndex {
  version: number;
  folder: string;
  files: Record<string, FileEntry>;
  chunks: CourseChunk[];
}

interface StoredVectors {
  model: string;
  dims: number;
  ids: string[];
  /** base64 of a Float32Array, ids.length × dims */
  data: string;
}

interface Loaded {
  folder: string;
  files: Record<string, FileEntry>;
  chunks: CourseChunk[];
  byId: Map<string, CourseChunk>;
  bm25: Bm25;
  vectors: Map<string, Float32Array>;
  vectorModel: string | null;
}

export interface BrainDeps {
  store: CourseStore;
  /** A REST client with a key, or null (offline / demo): BM25 only, heuristic profile. */
  rest: () => GeminiRest | null;
  models: () => { text: string; embedding: string };
}

/**
 * The course brain: reads the linked course folder (slides, PDFs, docs, notes, transcripts,
 * code, notebooks), keeps a local index under the app's data folder, and answers searches with
 * citations. Re-indexing only re-reads files whose size or modification time changed.
 *
 * Emits 'progress' (courseId, IndexStatus).
 */
export class CourseBrain extends EventEmitter {
  private loaded = new Map<string, Loaded>();
  private running = new Map<string, Promise<IndexStatus>>();
  private queryVecCache = new Map<string, Float32Array>();

  constructor(private readonly deps: BrainDeps) {
    super();
  }

  private indexFile(courseId: string): string {
    return join(this.deps.store.indexDir(courseId), 'index.json');
  }

  private vectorsFile(courseId: string): string {
    return join(this.deps.store.indexDir(courseId), 'vectors.json');
  }

  /** Read (or re-read) the course folder. Concurrent calls share one run. */
  index(courseId: string): Promise<IndexStatus> {
    const running = this.running.get(courseId);
    if (running) return running;
    const p = this.runIndex(courseId).finally(() => this.running.delete(courseId));
    this.running.set(courseId, p);
    return p;
  }

  isIndexing(courseId: string): boolean {
    return this.running.has(courseId);
  }

  private setStatus(courseId: string, status: IndexStatus): void {
    try {
      this.deps.store.update(courseId, { indexStatus: status });
    } catch {
      /* course deleted meanwhile */
    }
    this.emit('progress', courseId, status);
  }

  private async runIndex(courseId: string): Promise<IndexStatus> {
    const course = this.deps.store.get(courseId);
    if (!course?.folder) {
      const s: IndexStatus = { state: 'never', files: 0, chunks: 0, embedded: 0 };
      this.setStatus(courseId, s);
      return s;
    }
    const folder = course.folder;
    const t0 = Date.now();
    this.setStatus(courseId, { ...course.indexStatus, state: 'indexing', files: 0, error: undefined });
    try {
      await fs.access(folder);
    } catch {
      const s: IndexStatus = { ...course.indexStatus, state: 'error', error: `Can't open ${folder}` };
      this.setStatus(courseId, s);
      return s;
    }

    const prev = readJson<StoredIndex | null>(this.indexFile(courseId), null);
    const reuse = prev && prev.version === INDEX_VERSION && prev.folder === folder ? prev : null;
    const prevChunks = new Map((reuse?.chunks ?? []).map((c) => [c.id, c]));

    const found = await walk(folder);
    const files: Record<string, FileEntry> = {};
    const chunks: CourseChunk[] = [];
    const skipped: { file: string; reason: string }[] = [];
    let n = 0;
    for (const f of found) {
      const rel = relative(folder, f.path).split(sep).join('/');
      const ext = extname(rel).toLowerCase();
      if (!SUPPORTED_EXT.has(ext)) {
        files[rel] = { size: f.size, mtimeMs: f.mtimeMs, kind: 'unsupported', chunkIds: [] };
        continue;
      }
      const limit = ext === '.pdf' || ext === '.pptx' ? 80e6 : CODE_EXT.has(ext) ? 1.5e6 : 8e6;
      if (f.size > limit) {
        files[rel] = { size: f.size, mtimeMs: f.mtimeMs, kind: 'unsupported', chunkIds: [], error: 'too large' };
        skipped.push({ file: rel, reason: 'too large' });
        continue;
      }
      const old = reuse?.files[rel];
      if (old && old.size === f.size && Math.abs(old.mtimeMs - f.mtimeMs) < 1 && !old.error) {
        const cs = old.chunkIds.map((id) => prevChunks.get(id)).filter((c): c is CourseChunk => Boolean(c));
        files[rel] = old;
        chunks.push(...cs);
      } else {
        try {
          const ex = await extractFile(rel, await fs.readFile(f.path));
          const cs = toChunks(rel, ex);
          files[rel] = { size: f.size, mtimeMs: f.mtimeMs, kind: ex.kind, chunkIds: cs.map((c) => c.id) };
          chunks.push(...cs);
          if (!cs.length) skipped.push({ file: rel, reason: ex.kind === 'pdf' || ex.kind === 'slides' ? 'no text layer (scanned?)' : 'empty' });
        } catch (e) {
          files[rel] = { size: f.size, mtimeMs: f.mtimeMs, kind: 'unsupported', chunkIds: [], error: (e as Error).message.slice(0, 160) };
          skipped.push({ file: rel, reason: 'could not be read' });
          log.warn(`could not read ${rel}`, e);
        }
      }
      n++;
      if (n % 10 === 0) this.emit('progress', courseId, { state: 'indexing', files: n, chunks: chunks.length, embedded: 0 } satisfies IndexStatus);
    }

    // Assignment specs found by name are suggested once (the student can untick them).
    const suggested = Object.keys(files).filter((rel) => files[rel].kind === 'assignment' && looksLikeAssignment(rel));
    const assignments = course.assignments.length || course.indexStatus.state === 'ready' ? course.assignments.filter((a) => files[a]) : suggested;

    const stored: StoredIndex = { version: INDEX_VERSION, folder, files, chunks };
    writeJson(this.indexFile(courseId), stored);
    const loaded = this.makeLoaded(stored, this.readVectors(courseId));
    this.loaded.set(courseId, loaded);

    const embedded = await this.embedMissing(courseId, loaded).catch((e) => {
      log.warn('embedding failed (search falls back to keywords)', e);
      return loaded.vectors.size;
    });

    const indexedFiles = Object.values(files).filter((f) => f.kind !== 'unsupported' && f.chunkIds.length).length;
    const status: IndexStatus = { state: 'ready', files: indexedFiles, chunks: chunks.length, embedded, updatedAt: Date.now(), skipped: skipped.slice(0, 50) };
    try {
      this.deps.store.update(courseId, { assignments, indexStatus: status });
    } catch {
      /* deleted */
    }
    this.emit('progress', courseId, status);
    log.info(`indexed ${course.code}: ${indexedFiles} files, ${chunks.length} chunks, ${embedded} embedded in ${Date.now() - t0} ms`);

    // The course profile (glossary, topics, conventions) is rebuilt when the material changed.
    const changed = !reuse || Object.keys(files).some((rel) => reuse.files[rel]?.mtimeMs !== files[rel].mtimeMs) || Object.keys(reuse.files).length !== Object.keys(files).length;
    if (changed || !course.profile) {
      void buildProfile(this.deps.store.get(courseId) ?? course, chunks, this.deps.rest(), this.deps.models().text)
        .then((profile) => {
          if (this.deps.store.get(courseId)) this.deps.store.update(courseId, { profile });
        })
        .catch((e) => log.warn('profile failed', e));
    }
    return status;
  }

  private makeLoaded(s: StoredIndex, vec: StoredVectors | null): Loaded {
    const byId = new Map(s.chunks.map((c) => [c.id, c]));
    const vectors = new Map<string, Float32Array>();
    if (vec) {
      const all = new Float32Array(new Uint8Array(Buffer.from(vec.data, 'base64')).buffer);
      vec.ids.forEach((id, i) => {
        if (byId.has(id)) vectors.set(id, all.slice(i * vec.dims, (i + 1) * vec.dims));
      });
    }
    return { folder: s.folder, files: s.files, chunks: s.chunks, byId, bm25: new Bm25(s.chunks), vectors, vectorModel: vec?.model ?? null };
  }

  private readVectors(courseId: string): StoredVectors | null {
    const v = readJson<StoredVectors | null>(this.vectorsFile(courseId), null);
    return v && v.model === this.deps.models().embedding ? v : null;
  }

  private async embedMissing(courseId: string, l: Loaded): Promise<number> {
    const rest = this.deps.rest();
    if (!rest?.hasKey) return l.vectors.size;
    const model = this.deps.models().embedding;
    const todo = l.chunks.filter((c) => !l.vectors.has(c.id)).slice(0, Math.max(0, MAX_EMBED - l.vectors.size));
    if (!todo.length) return l.vectors.size;
    const dims = 768;
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      const vecs = await rest.embed(model, batch.map((c) => `${c.cite}\n${c.heading ?? ''}\n${c.text}`.slice(0, 2400)), 'RETRIEVAL_DOCUMENT', dims);
      vecs.forEach((v, k) => l.vectors.set(batch[k].id, Float32Array.from(v)));
      this.emit('progress', courseId, { state: 'indexing', files: Object.keys(l.files).length, chunks: l.chunks.length, embedded: l.vectors.size } satisfies IndexStatus);
    }
    l.vectorModel = model;
    const ids = [...l.vectors.keys()];
    const all = new Float32Array(ids.length * dims);
    ids.forEach((id, i) => all.set(l.vectors.get(id)!.subarray(0, dims), i * dims));
    writeJson(this.vectorsFile(courseId), { model, dims, ids, data: Buffer.from(all.buffer).toString('base64') } satisfies StoredVectors);
    return l.vectors.size;
  }

  private get(courseId: string): Loaded | null {
    const hit = this.loaded.get(courseId);
    if (hit) return hit;
    const s = readJson<StoredIndex | null>(this.indexFile(courseId), null);
    if (!s || s.version !== INDEX_VERSION) return null;
    const l = this.makeLoaded(s, this.readVectors(courseId));
    this.loaded.set(courseId, l);
    return l;
  }

  hasMaterial(courseId: string): boolean {
    return (this.get(courseId)?.chunks.length ?? 0) > 0;
  }

  chunks(courseId: string): CourseChunk[] {
    return this.get(courseId)?.chunks ?? [];
  }

  files(course: Course): CourseFile[] {
    const l = this.get(course.id);
    if (!l) return [];
    return Object.entries(l.files)
      .filter(([, f]) => f.kind !== 'unsupported' || f.error)
      .map(([path, f]) => ({ path, kind: f.kind, size: f.size, isAssignment: course.assignments.includes(path), indexed: f.chunkIds.length > 0 }))
      .sort((a, b) => Number(b.isAssignment) - Number(a.isAssignment) || a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  /** Keyword search only (instant; used by the hub's search box and as the offline path). */
  searchKeywords(courseId: string, query: string, k = 6): SearchHit[] {
    const l = this.get(courseId);
    if (!l) return [];
    return l.bm25.search(query, k).flatMap((h) => {
      const chunk = l.byId.get(h.id);
      return chunk ? [{ chunk, score: h.score, via: ['bm25' as const] }] : [];
    });
  }

  /** Hybrid search: BM25 + embeddings (when this course has vectors and a key is set). */
  async search(courseId: string, query: string, k = 6, opts: { preferFiles?: string[] } = {}): Promise<{ hits: SearchHit[]; coverage: 'strong' | 'weak' | 'none' }> {
    const l = this.get(courseId);
    if (!l || !query.trim()) return { hits: [], coverage: 'none' };
    const bm = l.bm25.search(query, 24);
    let dense: { id: string; score: number }[] = [];
    const rest = this.deps.rest();
    if (rest?.hasKey && l.vectors.size && l.vectorModel === this.deps.models().embedding) {
      try {
        let qv = this.queryVecCache.get(query);
        if (!qv) {
          const [v] = await rest.embed(l.vectorModel, [query], 'RETRIEVAL_QUERY', 768);
          qv = Float32Array.from(v);
          this.queryVecCache.set(query, qv);
          if (this.queryVecCache.size > 200) this.queryVecCache.delete(this.queryVecCache.keys().next().value as string);
        }
        // Ranks matter for fusion, not absolute similarity (which varies by model and length).
        dense = [...l.vectors.entries()].map(([id, v]) => ({ id, score: cosine(qv!, v) })).sort((a, b) => b.score - a.score).slice(0, 16);
      } catch (e) {
        log.debug('query embedding failed; keywords only', e);
      }
    }
    let hits = dense.length ? fuse(l.byId, bm, dense, k + 4) : bm.slice(0, k + 4).flatMap((h) => (l.byId.get(h.id) ? [{ chunk: l.byId.get(h.id)!, score: h.score, via: ['bm25' as const] }] : []));
    // In assignment mode the spec itself ranks first when it matches at all.
    if (opts.preferFiles?.length) hits = [...hits.filter((h) => opts.preferFiles!.includes(h.chunk.file)), ...hits.filter((h) => !opts.preferFiles!.includes(h.chunk.file))];
    hits = diversify(hits, k);
    const best = bm[0]?.score ?? 0;
    const ideal = l.bm25.idealScore(query);
    const denseBest = dense[0]?.score ?? 0;
    const coverage = denseBest > 0.72 || (ideal > 0 && best >= ideal * 0.55) ? 'strong' : best > 0 || denseBest > 0.6 ? 'weak' : 'none';
    // Nothing really matches: say so rather than handing the tutor the nearest unrelated passages.
    return { hits: coverage === 'none' ? [] : hits, coverage };
  }

  /** The chunk behind a citation label the tutor repeats back (exact, then loose match). */
  chunkByCite(courseId: string, cite: string): CourseChunk | undefined {
    const l = this.get(courseId);
    if (!l) return undefined;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const want = norm(cite);
    return l.chunks.find((c) => c.cite === cite) ?? l.chunks.find((c) => norm(c.cite) === want) ?? l.chunks.find((c) => norm(c.cite).includes(want) || want.includes(norm(c.cite)));
  }

  forget(courseId: string): void {
    this.loaded.delete(courseId);
  }
}

/** At most two chunks from the same file in the top results, so answers can cite broadly. */
function diversify(hits: SearchHit[], k: number): SearchHit[] {
  const per = new Map<string, number>();
  const out: SearchHit[] = [];
  const rest: SearchHit[] = [];
  for (const h of hits) {
    const n = per.get(h.chunk.file) ?? 0;
    if (n < 2) {
      out.push(h);
      per.set(h.chunk.file, n + 1);
    } else rest.push(h);
  }
  return [...out, ...rest].slice(0, k);
}

async function walk(root: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  const out: { path: string; size: number; mtimeMs: number }[] = [];
  const visit = async (dir: string, depth: number) => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(p);
          out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* vanished */
        }
        if (out.length >= MAX_FILES) return;
      }
    }
  };
  await visit(root, 0);
  return out;
}
