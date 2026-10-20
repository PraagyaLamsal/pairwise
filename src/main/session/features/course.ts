import type { SearchHit } from '@shared/courses';
import type { TutorSession } from '../tutor';
import { CourseBrain } from '../../courses/brain';
import { logger } from '../../log';

const log = logger('course');

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Trim an excerpt to whole sentences around where the query's words first appear. */
export function excerpt(text: string, query: string, max = 700): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const lower = t.toLowerCase();
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 3)
    .sort((a, b) => b.length - a.length);
  let idx = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0) {
      idx = i;
      break;
    }
  }
  let start = idx < 0 ? 0 : Math.max(0, idx - Math.floor(max * 0.25));
  if (start > 0) {
    const dot = t.lastIndexOf('. ', start);
    if (dot >= 0 && start - dot < 160) start = dot + 2;
  }
  let end = Math.min(t.length, start + max);
  if (end < t.length) {
    const dot = t.lastIndexOf('. ', end);
    if (dot > Math.max(idx, start + max * 0.5)) end = dot + 1;
  }
  return `${start > 0 ? '… ' : ''}${t.slice(start, end).trim()}${end < t.length ? ' …' : ''}`;
}

/**
 * Phase 4: the course brain inside a session — search_course (with citations), cite cards,
 * out-of-scope flags and think_deeply (a stronger model that sees the course material too).
 */
export class CourseFeature {
  readonly brain: CourseBrain;

  constructor(private readonly s: TutorSession) {
    this.brain = new CourseBrain({
      store: s.deps.courses,
      rest: () => (s.rest.hasKey && !s.demoMode() ? s.rest : null),
      models: () => ({ text: s.settings.models.text, embedding: s.settings.models.embedding }),
    });
    this.register();
  }

  /** At session start: catch up with files added since the last read (cheap when nothing changed). */
  refresh(courseId: string): void {
    const c = this.s.deps.courses.get(courseId);
    if (c?.folder) void this.brain.index(courseId);
  }

  private register(): void {
    const t = this.s.tools;

    t.register('search_course', async (args) => {
      const query = str(args.query);
      const course = this.s.course;
      if (!course) return { response: { ok: false } };
      if (!query) return { response: { ok: false, error: 'Say what to search for.' } };
      if (!course.folder) {
        return { response: { ok: true, results: [], note: 'No course folder is linked yet. Teach the standard first-year approach and say their class may use different notation.' } };
      }
      if (!this.brain.hasMaterial(course.id)) {
        return { response: { ok: true, results: [], note: this.brain.isIndexing(course.id) ? 'The course folder is still being read — answer from general knowledge for now and say so.' : 'The course folder has no readable material yet.' } };
      }
      const assignment = this.s.snapshot.assignment;
      this.s.cursor.setActivity('thinking', 'checking the course…');
      const { hits, coverage } = await this.brain.search(course.id, query, 5, { preferFiles: assignment ? [assignment] : undefined });
      this.s.cursor.setActivity(this.s.snapshot.activity === 'speaking' ? 'speaking' : 'idle');
      this.lastHits = hits;
      log.info(`search "${query}" → ${hits.length} hits (${coverage})`);
      return {
        response: {
          ok: true,
          coverage,
          results: hits.map((h) => ({ source: h.chunk.cite, ...(h.chunk.lecture ? { lecture: h.chunk.lecture } : {}), kind: h.chunk.kind, excerpt: excerpt(h.chunk.text, query) })),
          note:
            coverage === 'none'
              ? 'Nothing in the course material matches. If this is beyond the course, say so and call flag_out_of_scope; otherwise teach it the standard way and mention it was not in their material.'
              : coverage === 'weak'
                ? 'Only loosely related material. Use it if it fits; do not pretend the course covered more than it did.'
                : 'Teach it the way these sources do (same terms, notation and method) and call cite with the source you rely on.',
        },
      };
    });

    t.register('cite', async (args) => {
      const course = this.s.course;
      const source = str(args.source);
      if (!course || !source) return { response: { ok: false } };
      const chunk = this.brain.chunkByCite(course.id, source) ?? this.lastHits.find((h) => h.chunk.cite.toLowerCase().includes(source.toLowerCase()))?.chunk;
      const label = chunk?.cite ?? source;
      const snippet = str(args.snippet) || (chunk ? excerpt(chunk.text, source, 160) : '');
      this.s.ui.citation = { id: `cite-${Date.now()}`, cite: label, snippet: snippet.slice(0, 220), displayId: this.s.activeDisplayId, until: Date.now() + 9000 };
      this.s.pushUi();
      this.s.annotateCaption({ cites: [label] });
      return { response: { ok: true, shown: label, ...(chunk ? {} : { note: 'That source was not found in the course index; cite exactly what search_course returned.' }) } };
    });

    t.register('flag_out_of_scope', async (args) => {
      const topic = str(args.topic);
      if (!topic) return { response: { ok: false } };
      const where = str(args.where);
      this.s.ui.outOfScope = { id: `scope-${Date.now()}`, topic: where ? `${topic} (usually ${where})` : topic, until: Date.now() + 9000, displayId: this.s.activeDisplayId };
      this.s.pushUi();
      this.s.annotateCaption({ outOfScope: where ? `${topic} — usually ${where}` : topic });
      return { response: { ok: true } };
    });

    t.register('think_deeply', async (args, _call, signal) => {
      const question = str(args.question);
      if (!question) return { response: { ok: false } };
      this.s.cursor.setActivity('thinking', 'thinking it through…');
      try {
        const answer = await this.thinkDeeply(question, args.use_screen === true, signal);
        return { response: { ok: true, ...answer }, scheduling: 'WHEN_IDLE' };
      } catch (e) {
        log.warn('think_deeply failed', e);
        return { response: { ok: false, note: 'The deeper reasoning step failed; work it out step by step yourself, out loud.' }, scheduling: 'WHEN_IDLE' };
      } finally {
        this.s.cursor.setActivity(this.s.snapshot.activity === 'speaking' ? 'speaking' : 'idle');
      }
    });
  }

  private lastHits: SearchHit[] = [];

  private async thinkDeeply(question: string, useScreen: boolean, signal: AbortSignal): Promise<{ answer: string; sources?: string[] }> {
    const course = this.s.course;
    if (!this.s.rest.hasKey || this.s.demoMode()) {
      return { answer: 'Demo mode: with a Gemini key, a stronger reasoning model works this out here, using the course material, and you explain its answer step by step.' };
    }
    const hits = course && this.brain.hasMaterial(course.id) ? (await this.brain.search(course.id, question, 4)).hits : [];
    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
    if (useScreen) {
      const r = await this.s.deps.engine.request({ type: 'captureNow', requestId: this.s.deps.engine.nextRequestId('think'), displayId: this.s.activeDisplayId, maxWidth: 2048, quality: 0.85, kind: 'crop' });
      if (r.ok && r.frame) parts.push({ inlineData: { mimeType: r.frame.mime, data: Buffer.from(r.frame.data).toString('base64') } });
    }
    const assignment = this.s.snapshot.assignment;
    parts.push({
      text: [
        `Course: ${course ? `${course.code} ${course.name}` : 'unknown'}.`,
        course?.profile?.conventions.length ? `Course conventions: ${course.profile.conventions.join('; ')}.` : '',
        hits.length ? `Relevant course material:\n${hits.map((h) => `[${h.chunk.cite}]\n${h.chunk.text.slice(0, 1500)}`).join('\n\n')}` : '',
        assignment ? `IMPORTANT: this is for a graded assignment (${assignment}). Do not produce the solution; produce the reasoning a tutor needs to give hints and guiding questions.` : '',
        `Work this out carefully: ${question}`,
        'Reply with what a tutor should SAY, in plain spoken sentences (no markdown, no code blocks; describe code in words), at most 120 words, step by step. If course material was used, end with "Sources:" and the bracketed labels.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    if (signal.aborted) return { answer: '' };
    const r = await this.s.rest.generate(this.s.settings.models.reasoning, { contents: [{ role: 'user', parts }], generationConfig: { thinkingConfig: { thinkingLevel: 'medium' }, maxOutputTokens: 2048 } }, { timeoutMs: 60_000, inputModality: useScreen ? 'IMAGE' : 'TEXT' });
    const sources = [...r.text.matchAll(/\[([^\]]{3,120})\]/g)].map((m) => m[1]).filter((s) => hits.some((h) => h.chunk.cite === s));
    return { answer: r.text.replace(/\n?Sources:[\s\S]*$/i, '').trim(), ...(sources.length ? { sources } : {}) };
  }
}
