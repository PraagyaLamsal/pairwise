import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Caption } from '@shared/session';
import type { ResumeState } from '@shared/courses';
import type { TutorSession } from '../tutor';
import { logger } from '../../log';

const log = logger('notes');

export const NOTES_DIR = 'Pairwise notes';

type NoteKind = 'key_idea' | 'definition' | 'to_review' | 'mistake';

export interface NotesDraft {
  title: string;
  summary: string;
  keyIdeas: string[];
  definitions: string[];
  mistakes: string[];
  toReview: string[];
  openQuestions: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** "2026-10-20 14.05 Recursion and the stopping case.md" (safe on every file system). */
export function notesFileName(at: Date, title: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  const clean = title.replace(/[\\/:*?"<>|#\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || 'Session';
  return `${stamp} ${clean}.md`;
}

/** Notes without a model: what was asked, what was saved, what was cited. */
export function heuristicDraft(courseCode: string, captions: Caption[], saved: { kind: NoteKind; text: string }[], outOfScope: string[]): NotesDraft {
  const student = captions.filter((c) => c.speaker === 'student' && c.text.trim().length > 6 && !/^\(/.test(c.text));
  const firstQ = student.find((c) => /\?|\b(how|what|why|when|which|can|does|is)\b/i.test(c.text))?.text ?? student[0]?.text ?? '';
  const topic = firstQ.replace(/^(so|um|uh|okay|ok|hey|hi)[, ]+/i, '').replace(/\?.*$/, '').slice(0, 60);
  const of = (k: NoteKind) => saved.filter((s) => s.kind === k).map((s) => s.text);
  const asked = student.slice(0, 5).map((c) => c.text.slice(0, 140));
  return {
    title: topic ? topic.charAt(0).toUpperCase() + topic.slice(1) : `${courseCode} session`,
    summary: asked.length ? `You asked about: ${asked.map((a) => `“${a}”`).join('; ')}.` : 'A short session.',
    keyIdeas: of('key_idea'),
    definitions: of('definition'),
    mistakes: of('mistake'),
    toReview: [...of('to_review'), ...outOfScope.map((t) => `${t} (beyond this course — ask your TA if it's needed)`)],
    openQuestions: student.length && captions[captions.length - 1]?.speaker === 'student' ? [student[student.length - 1].text.slice(0, 160)] : [],
  };
}

/**
 * Session notes, written into the course folder ("Pairwise notes/…") when a session ends: a
 * summary, key ideas, definitions, mistakes to avoid, things to review, the sources the tutor
 * cited, whiteboard diagrams as images and (optionally) a condensed transcript. Screenshots are
 * only included if the student turned that on in Settings → Privacy.
 */
export class NotesFeature {
  private saved: { kind: NoteKind; text: string; at: number }[] = [];
  /** Annotated question frames (only collected when Settings → Privacy allows it). */
  readonly screenshots: { data: Uint8Array; mime: string; at: number }[] = [];
  lastFile: string | null = null;

  constructor(private readonly s: TutorSession) {
    s.tools.register('save_note', async (args) => {
      const kind = (['key_idea', 'definition', 'to_review', 'mistake'].includes(str(args.kind)) ? str(args.kind) : 'key_idea') as NoteKind;
      const text = str(args.text).slice(0, 400);
      if (!text) return { response: { ok: false } };
      this.saved.push({ kind, text, at: Date.now() });
      this.s.toast(kind === 'to_review' ? `Added to review: ${text.slice(0, 60)}` : `Saved to notes: ${text.slice(0, 60)}`, 'success', 2200);
      return { response: { ok: true } };
    });
  }

  reset(): void {
    this.saved = [];
    this.screenshots.length = 0;
  }

  keepScreenshot(data: Uint8Array, mime: string): void {
    if (!this.s.settings.privacy.saveAnnotatedScreenshots) return;
    this.screenshots.push({ data, mime, at: Date.now() });
    if (this.screenshots.length > 6) this.screenshots.shift();
  }

  dirFor(courseId: string): string {
    const c = this.s.deps.courses.get(courseId);
    return c?.folder ? join(c.folder, NOTES_DIR) : join(this.s.deps.courses.notesDir(courseId));
  }

  /**
   * Take everything the notes need from the session that is ending (synchronously, before
   * teardown) and return a job that writes them — run in the background so ending a session
   * never waits for a summary. The job resolves to what the next session should know.
   */
  capture(startedAt: number): (() => Promise<Partial<ResumeState> | null>) | null {
    const course = this.s.course;
    if (!course || !this.s.settings.notes.enabled) return null;
    const captions = this.s.transcript().filter((c) => c.speaker !== 'system' && c.text.trim());
    const students = captions.filter((c) => c.speaker === 'student' && !/^\((demo|you spoke)/.test(c.text));
    // Diagrams belong to the session that drew them: take them out of the board's list.
    const diagrams = this.s.whiteboard.diagrams.splice(0).filter((d) => d.at >= startedAt - 1000);
    if (students.length === 0 && this.saved.length === 0 && diagrams.length === 0) {
      log.info('nothing worth noting this session');
      this.reset();
      return null;
    }
    const saved = [...this.saved];
    const screenshots = [...this.screenshots];
    const assignment = this.s.snapshot.assignment;
    const endedAt = Date.now();
    this.reset();
    return () => this.write({ course, captions, saved, screenshots, diagrams, startedAt, endedAt, assignment });
  }

  private async write(j: {
    course: NonNullable<TutorSession['course']>;
    captions: Caption[];
    saved: { kind: NoteKind; text: string; at: number }[];
    screenshots: { data: Uint8Array; mime: string; at: number }[];
    diagrams: { title: string; png: Buffer; at: number }[];
    startedAt: number;
    endedAt: number;
    assignment?: string;
  }): Promise<Partial<ResumeState> | null> {
    const { course, captions, startedAt } = j;
    const cites = [...new Set(captions.flatMap((c) => c.cites ?? []))];
    const outOfScope = [...new Set(captions.map((c) => c.outOfScope).filter((x): x is string => Boolean(x)))];
    let draft = heuristicDraft(course.code, captions, j.saved, outOfScope);
    if (this.s.rest.hasKey && !this.s.demoMode()) {
      try {
        draft = await this.summarize(captions, cites, draft, j.saved);
      } catch (e) {
        log.warn('Gemini notes failed; writing the simple version', e);
      }
    }
    const at = new Date(startedAt || Date.now());
    const dir = this.dirFor(course.id);
    const file = join(dir, notesFileName(at, draft.title));
    const imgDir = join(dir, 'images');
    const stem = notesFileName(at, draft.title).replace(/\.md$/, '');
    const images: { alt: string; rel: string }[] = [];
    try {
      await fs.mkdir(dir, { recursive: true });
      if (j.diagrams.length || j.screenshots.length) await fs.mkdir(imgDir, { recursive: true });
      for (const [i, d] of j.diagrams.entries()) {
        const name = `${stem} – diagram ${i + 1}.png`;
        await fs.writeFile(join(imgDir, name), d.png);
        images.push({ alt: d.title, rel: `images/${encodeURI(name)}` });
      }
      for (const [i, shot] of j.screenshots.entries()) {
        const name = `${stem} – screen ${i + 1}.${shot.mime === 'image/png' ? 'png' : 'jpg'}`;
        await fs.writeFile(join(imgDir, name), shot.data);
        images.push({ alt: 'What you asked about', rel: `images/${encodeURI(name)}` });
      }
      const minutes = Math.max(1, Math.round((j.endedAt - (startedAt || j.endedAt)) / 60000));
      await fs.writeFile(file, this.markdown(draft, { course: `${course.code}${course.name ? ` — ${course.name}` : ''}`, at, minutes, cites, images, captions, assignment: j.assignment }), 'utf8');
      this.lastFile = file;
      log.info(`notes written: ${file}`);
    } catch (e) {
      log.warn('could not write notes', e);
      return { summary: draft.summary, openQuestions: draft.openQuestions, toReview: draft.toReview };
    }
    return { summary: draft.summary.slice(0, 400), openQuestions: draft.openQuestions.slice(0, 5), toReview: draft.toReview.slice(0, 8), lastNotesFile: file };
  }

  private markdown(d: NotesDraft, m: { course: string; at: Date; minutes: number; cites: string[]; images: { alt: string; rel: string }[]; captions: Caption[]; assignment?: string }): string {
    const tutor = this.s.settings.tutorName;
    const when = m.at.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const L: string[] = [`# ${d.title}`, '', `*${m.course} · ${when} · ${m.minutes} min with ${tutor}${m.assignment ? ` · assignment: ${m.assignment}` : ''}*`, ''];
    const section = (h: string, xs: string[]) => {
      if (!xs.length) return;
      L.push(`## ${h}`, '', ...xs.map((x) => `- ${x}`), '');
    };
    L.push('## Summary', '', d.summary, '');
    section('Key ideas', d.keyIdeas);
    section('Definitions', d.definitions);
    section('Mistakes to avoid', d.mistakes);
    section('To review', d.toReview);
    section('Still open', d.openQuestions);
    if (m.images.length) {
      L.push('## Diagrams', '');
      for (const i of m.images) L.push(`![${i.alt}](${i.rel})`, '');
    }
    section('Sources from your course', m.cites);
    if (this.s.settings.notes.includeTranscript && m.captions.length) {
      L.push('## Conversation (condensed)', '');
      for (const c of m.captions.slice(-80)) L.push(`**${c.speaker === 'student' ? 'You' : tutor}:** ${c.text.replace(/\s+/g, ' ').trim()}`, '');
    }
    L.push('---', `*Written by Pairwise. Edit freely — it won't be overwritten.*`, '');
    return L.join('\n');
  }

  private async summarize(captions: Caption[], cites: string[], fallback: NotesDraft, savedNotes: { kind: NoteKind; text: string }[]): Promise<NotesDraft> {
    const transcript = captions
      .slice(-120)
      .map((c) => `${c.speaker === 'student' ? 'Student' : 'Tutor'}: ${c.text}`)
      .join('\n')
      .slice(-24_000);
    const saved = savedNotes.map((s) => `${s.kind}: ${s.text}`).join('\n');
    const r = await this.s.rest.generateJson<Partial<NotesDraft>>(
      this.s.settings.models.text,
      {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  'Write study notes for the student from this tutoring session, in second person ("you"), short and concrete, in the course\'s own terms.',
                  'title: 3–7 words naming what was worked on. summary: 2–3 sentences. keyIdeas, definitions (term — meaning), mistakes (things they got wrong, kindly phrased), toReview (what to practise next), openQuestions (anything left unanswered). Leave lists empty rather than padding them.',
                  saved ? `Notes the tutor saved during the session:\n${saved}` : '',
                  cites.length ? `Course sources cited: ${cites.join('; ')}` : '',
                  `Transcript:\n${transcript}`,
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          thinkingConfig: { thinkingLevel: 'low' },
          responseSchema: {
            type: 'OBJECT',
            properties: {
              title: { type: 'STRING' },
              summary: { type: 'STRING' },
              keyIdeas: { type: 'ARRAY', items: { type: 'STRING' } },
              definitions: { type: 'ARRAY', items: { type: 'STRING' } },
              mistakes: { type: 'ARRAY', items: { type: 'STRING' } },
              toReview: { type: 'ARRAY', items: { type: 'STRING' } },
              openQuestions: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: ['title', 'summary'],
          },
        },
      },
      { timeoutMs: 30_000 },
    );
    const list = (v: unknown, extra: string[] = []) => [...new Set([...(Array.isArray(v) ? v.map(String) : []), ...extra])].slice(0, 12);
    return {
      title: str(r.title) || fallback.title,
      summary: str(r.summary) || fallback.summary,
      keyIdeas: list(r.keyIdeas, fallback.keyIdeas),
      definitions: list(r.definitions, fallback.definitions),
      mistakes: list(r.mistakes, fallback.mistakes),
      toReview: list(r.toReview, fallback.toReview),
      openQuestions: list(r.openQuestions),
    };
  }

  /** Notes for the hub (newest first). */
  async recent(courseId: string): Promise<{ file: string; title: string; at: number }[]> {
    const dir = this.dirFor(courseId);
    try {
      const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
      const out = await Promise.all(
        names.map(async (n) => {
          const p = join(dir, n);
          const st = await fs.stat(p);
          const head = (await fs.readFile(p, 'utf8')).split('\n', 1)[0].replace(/^#\s*/, '').trim();
          return { file: p, title: head || n.replace(/\.md$/, ''), at: st.mtimeMs };
        }),
      );
      return out.sort((a, b) => b.at - a.at).slice(0, 20);
    } catch {
      return [];
    }
  }
}
