import type { CourseChunk, SearchHit } from '@shared/courses';

/**
 * Local search over a course's chunks: BM25 (works offline, exact on course terms and code
 * identifiers) fused with embedding similarity when vectors exist (reciprocal-rank fusion).
 */

const STOP = new Set(
  'a an the and or but if then else of to in on at by for with from into onto over under is are was were be been being it its this that these those there here we you they he she i me my our your their what which who whom whose how why when where can could should would will shall may might must do does did done not no yes so than too very just also as about such each any all some more most other only own same both few many much via per vs etc let lets use using used'.split(' '),
);

/** Light stemming: plurals and common verb endings, kept conservative so code terms survive. */
function stem(w: string): string {
  if (w.length <= 4 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 5) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 5 && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.endsWith('es') && /(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/** Words + code identifiers (camelCase / snake_case split, but the whole identifier kept too). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[\p{L}\p{N}_]+(?:'[\p{L}]+)?/gu) ?? []) {
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const whole = raw.toLowerCase().replace(/'.*$/, '');
    if (parts.length > 1 && whole.length > 2) out.push(whole);
    for (const p of parts) {
      if (p.length < 2 && !/\d/.test(p)) continue;
      if (STOP.has(p)) continue;
      out.push(stem(p));
    }
  }
  return out;
}

/** Words that only frame a question ("what is X called in this course") — ignored in queries. */
const QUERY_STOP = new Set(['course', 'class', 'classe', 'called', 'mean', 'meaning', 'explain', 'say', 'tell', 'know', 'understand', 'question', 'professor', 'prof', 'thing', 'stuff', 'work']);

interface Doc {
  id: string;
  len: number;
  tf: Map<string, number>;
}

export class Bm25 {
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  constructor(
    chunks: CourseChunk[],
    private readonly k1 = 1.3,
    private readonly b = 0.72,
  ) {
    for (const c of chunks) {
      // Headings and file names count extra: "Lecture 5 – Recursion" should match "recursion".
      const tokens = [...tokenize(c.text), ...tokenize(c.heading ?? ''), ...tokenize(c.heading ?? ''), ...tokenize(c.cite)];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: c.id, len: tokens.length, tf });
    }
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string, k = 8): { id: string; score: number }[] {
    const all = [...new Set(tokenize(query))];
    const q = all.filter((t) => !QUERY_STOP.has(t)).length ? all.filter((t) => !QUERY_STOP.has(t)) : all;
    if (!q.length) return [];
    const N = this.docs.length;
    const scored: { id: string; score: number }[] = [];
    for (const d of this.docs) {
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
      }
      if (s > 0) scored.push({ id: d.id, score: s });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** The best score a query could plausibly get here (all its terms, rare): for "how well covered". */
  idealScore(query: string): number {
    const all = [...new Set(tokenize(query))];
    const q = all.filter((t) => !QUERY_STOP.has(t)).length ? all.filter((t) => !QUERY_STOP.has(t)) : all;
    const N = this.docs.length;
    return q.reduce((a, t) => {
      const df = this.df.get(t) ?? 0;
      return a + (df ? Math.log(1 + (N - df + 0.5) / (df + 0.5)) : 0);
    }, 0);
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

/** Reciprocal-rank fusion of BM25 and embedding rankings. */
export function fuse(chunks: Map<string, CourseChunk>, bm25: { id: string; score: number }[], dense: { id: string; score: number }[], k: number): SearchHit[] {
  const RRF = 60;
  const acc = new Map<string, { score: number; via: Set<'bm25' | 'embedding'> }>();
  bm25.forEach((h, i) => {
    const e = acc.get(h.id) ?? { score: 0, via: new Set() };
    e.score += 1 / (RRF + i);
    e.via.add('bm25');
    acc.set(h.id, e);
  });
  dense.forEach((h, i) => {
    const e = acc.get(h.id) ?? { score: 0, via: new Set() };
    e.score += 1 / (RRF + i);
    e.via.add('embedding');
    acc.set(h.id, e);
  });
  return [...acc.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, k)
    .flatMap(([id, e]) => {
      const chunk = chunks.get(id);
      return chunk ? [{ chunk, score: e.score, via: [...e.via] }] : [];
    });
}
