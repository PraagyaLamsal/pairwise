import { extname } from 'node:path';
import type { Course, CourseChunk, CourseProfile } from '@shared/courses';
import type { GeminiRest } from '../gemini/rest';
import { displayName } from './chunks';
import { logger } from '../log';

const log = logger('course-profile');

/**
 * What the tutor should know about a course before the first question: what it covers so far
 * (in lecture order), its own terms and definitions, its notation/conventions and what it says
 * is taught later. Gemini writes it from a sample of the material; without a key, a heuristic
 * version is built from file names, headings and definition-like sentences.
 */
export async function buildProfile(course: Course, chunks: CourseChunk[], rest: GeminiRest | null, model: string): Promise<CourseProfile> {
  const heuristic = heuristicProfile(course, chunks);
  if (!rest?.hasKey || !chunks.length) return heuristic;
  try {
    const sample = sampleForProfile(chunks, 60_000);
    const r = await rest.generateJson<Partial<CourseProfile>>(
      model,
      {
        systemInstruction: {
          parts: [
            {
              text: 'You read a university course\'s material and write a compact profile that a tutor will rely on to teach the way THIS course does. Use only what the material says. Keep every string short.',
            },
          ],
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  `Course: ${course.code}${course.name ? ` — ${course.name}` : ''}${course.term ? ` (${course.term})` : ''}.`,
                  'Excerpts follow, each tagged with its source. Produce:',
                  '- summary: two sentences on what the course covers so far and its approach;',
                  '- topics: the topics in teaching order (lecture order), each with the source it comes from;',
                  '- glossary: up to 30 course-specific terms with the course\'s OWN short definition and source;',
                  '- conventions: notation, language/version, style rules, required methods (e.g. "loops over lists use for-each", "uses ⊆ for subset");',
                  '- laterTopics: things the material says are covered later or are out of scope.',
                  '',
                  sample,
                ].join('\n'),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          thinkingConfig: { thinkingLevel: 'low' },
          responseSchema: {
            type: 'OBJECT',
            properties: {
              summary: { type: 'STRING' },
              topics: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, source: { type: 'STRING' } }, required: ['title'] } },
              glossary: { type: 'ARRAY', items: { type: 'OBJECT', properties: { term: { type: 'STRING' }, definition: { type: 'STRING' }, source: { type: 'STRING' } }, required: ['term', 'definition'] } },
              conventions: { type: 'ARRAY', items: { type: 'STRING' } },
              laterTopics: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: ['summary', 'topics', 'glossary', 'conventions', 'laterTopics'],
          },
        },
      },
      { timeoutMs: 60_000 },
    );
    return {
      summary: String(r.summary ?? heuristic.summary).slice(0, 600),
      topics: (r.topics ?? []).slice(0, 60).map((t) => ({ title: String(t.title).slice(0, 100), source: String(t.source ?? '').slice(0, 100) })),
      glossary: (r.glossary ?? []).slice(0, 40).map((g) => ({ term: String(g.term).slice(0, 60), definition: String(g.definition).slice(0, 220), source: String(g.source ?? '').slice(0, 100) })),
      conventions: (r.conventions ?? []).slice(0, 16).map((c) => String(c).slice(0, 160)),
      laterTopics: (r.laterTopics ?? []).slice(0, 20).map((c) => String(c).slice(0, 120)),
      generatedAt: Date.now(),
      generatedBy: 'gemini',
    };
  } catch (e) {
    log.warn('Gemini profile failed; using the heuristic one', e);
    return heuristic;
  }
}

/** Headings + the first chunk of every file + definition-looking chunks, within a budget. */
export function sampleForProfile(chunks: CourseChunk[], budget: number): string {
  const byFile = new Map<string, CourseChunk[]>();
  for (const c of chunks) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const files = [...byFile.keys()].sort((a, b) => (byFile.get(a)![0].lecture ?? 999) - (byFile.get(b)![0].lecture ?? 999) || a.localeCompare(b, undefined, { numeric: true }));
  const parts: string[] = [];
  let used = 0;
  const add = (s: string) => {
    if (used + s.length > budget) return false;
    parts.push(s);
    used += s.length;
    return true;
  };
  // Pass 1: an outline of every file (title + headings).
  for (const f of files) {
    const cs = byFile.get(f)!;
    const heads = [...new Set(cs.map((c) => c.heading).filter(Boolean))].slice(0, 14);
    if (!add(`## ${displayName(f)} (${cs[0].kind})${heads.length ? `\nHeadings: ${heads.join(' · ')}` : ''}\n`)) break;
  }
  // Pass 2: definitions and the opening of each file.
  const defRe = /\b(is defined as|we define|definition|is called|refers to|means that|:=|denoted)\b/i;
  const picks = [...chunks.filter((c) => defRe.test(c.text)), ...files.map((f) => byFile.get(f)![0])];
  const seen = new Set<string>();
  for (const c of picks) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (!add(`[${c.cite}]\n${c.text.slice(0, 900)}\n`)) break;
  }
  return parts.join('\n');
}

const LANG: Record<string, string> = { '.py': 'Python', '.java': 'Java', '.c': 'C', '.cpp': 'C++', '.js': 'JavaScript', '.ts': 'TypeScript', '.rkt': 'Racket', '.scm': 'Scheme', '.hs': 'Haskell', '.ml': 'OCaml', '.go': 'Go', '.rs': 'Rust', '.kt': 'Kotlin', '.r': 'R', '.jl': 'Julia', '.ipynb': 'Python' };

export function heuristicProfile(course: Course, chunks: CourseChunk[]): CourseProfile {
  const byFile = new Map<string, CourseChunk[]>();
  for (const c of chunks) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const teaching = [...byFile.entries()].filter(([, cs]) => cs[0].kind !== 'code' && cs[0].kind !== 'assignment');
  // With numbered lectures/weeks around, unnumbered files (outline, syllabus) aren't topics.
  const numbered = teaching.filter(([, cs]) => typeof cs[0].lecture === 'number');
  const lectureFiles = (numbered.length >= 2 ? numbered : teaching)
    .sort((a, b) => (a[1][0].lecture ?? 999) - (b[1][0].lecture ?? 999) || a[0].localeCompare(b[0], undefined, { numeric: true }));
  const topics: CourseProfile['topics'] = [];
  for (const [f, cs] of lectureFiles) {
    const name = displayName(f).replace(/^(lecture|lec|week|wk|class)[\s_-]*\d+[\s_\-–—:.]*/i, '').trim();
    const title = name || cs[0].heading || displayName(f);
    // Slides and the lecture's transcript share a title: one topic.
    if (!topics.some((t) => t.title.toLowerCase() === title.toLowerCase())) topics.push({ title, source: displayName(f) });
  }
  const glossary: CourseProfile['glossary'] = [];
  const seen = new Set<string>();
  const patterns = [
    /\*\*([A-Za-z][\w\s-]{1,40})\*\*\s*[:—–-]\s*([^\n]{8,200})/g,
    /(?:^|\n)\s*(?:Definition|Def\.?)\s*[:.]?\s*(?:\(([^)]{2,40})\))?\s*([A-Z][^\n]{8,200})/g,
    /(?:^|[.\n]\s*)(?:An?|The)\s+([a-z][\w-]*(?:\s[a-z][\w-]*){0,3})\s+is\s+(?:defined as\s+)?(an?\s[^.\n]{8,180})\./g,
  ];
  for (const c of chunks) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(c.text)) && glossary.length < 30) {
        const term = (m[1] ?? '').trim();
        const def = (m[2] ?? '').trim();
        if (!term || !def || term.length > 40) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        glossary.push({ term, definition: def.slice(0, 200), source: c.cite });
      }
    }
  }
  const langs = new Map<string, number>();
  for (const f of byFile.keys()) {
    const l = LANG[extname(f).toLowerCase()];
    if (l) langs.set(l, (langs.get(l) ?? 0) + 1);
  }
  const conventions = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l]) => `Code examples are in ${l}`);
  const later = chunks
    .flatMap((c) => [...c.text.matchAll(/(?:covered|discussed|see|more on this|we will (?:see|cover|discuss))\s+(?:in\s+)?(?:a\s+)?(?:later|future|next)\s+(?:lecture|week|course|chapter)s?[^.\n]{0,80}/gi)].map((m) => m[0].trim()))
    .slice(0, 8);
  const lectures = lectureFiles.map(([, cs]) => cs[0].lecture).filter((n): n is number => typeof n === 'number');
  const span = lectures.length ? ` (lectures ${Math.min(...lectures)}–${Math.max(...lectures)})` : '';
  return {
    summary: `${course.code}${course.name ? ` — ${course.name}` : ''}: ${byFile.size} files of course material${span}${topics.length ? `, covering ${topics.slice(0, 6).map((t) => t.title).join(', ')}${topics.length > 6 ? ' and more' : ''}` : ''}.`,
    topics: topics.slice(0, 60),
    glossary,
    conventions,
    laterTopics: later,
    generatedAt: Date.now(),
    generatedBy: 'heuristic',
  };
}
