import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCourseFolder, FACTS } from '../fixtures/make-course.mjs';
import { extractFile, extractCaptions, extractCode, extractText, lectureNumber, looksLikeAssignment } from '../../src/main/courses/extract';
import { citeFor, toChunks } from '../../src/main/courses/chunks';
import { Bm25, tokenize } from '../../src/main/courses/search';
import { heuristicProfile } from '../../src/main/courses/profile';
import { CourseBrain } from '../../src/main/courses/brain';
import { CourseStore } from '../../src/main/courses/store';
import { excerpt } from '../../src/main/session/features/course';

let folder: string;
beforeAll(async () => {
  folder = await makeCourseFolder(mkdtempSync(join(tmpdir(), 'pw-course-')));
}, 30_000);

describe('extraction', () => {
  it('reads a slides PDF page by page (as slides)', async () => {
    const ex = await extractFile('Lecture 03 - Loops.pdf', readFileSync(join(folder, 'Lecture 03 - Loops.pdf')));
    expect(ex.kind).toBe('slides');
    expect(ex.sections).toHaveLength(3);
    expect(ex.sections[1].slide).toBe(2);
    expect(ex.sections[1].heading).toBe('The accumulator pattern');
    expect(ex.sections[1].text).toMatch(/total = total \+ x/);
  });

  it('reads PPTX slides with titles and speaker notes', async () => {
    const ex = await extractFile('Lecture 05 - Recursion.pptx', readFileSync(join(folder, 'Lecture 05 - Recursion.pptx')));
    expect(ex.kind).toBe('slides');
    expect(ex.sections.map((s) => s.slide)).toEqual([1, 2, 3]);
    expect(ex.sections[1].heading).toBe('Two parts of every recursive function');
    expect(ex.sections[1].text).toMatch(/stopping case/);
    expect(ex.sections[1].text).toMatch(/Speaker notes: In this course we say stopping case/);
  });

  it('reads DOCX by heading', async () => {
    const ex = await extractFile('Course Outline.docx', readFileSync(join(folder, 'Course Outline.docx')));
    expect(ex.kind).toBe('doc');
    const later = ex.sections.find((s) => s.heading === 'Not covered in this course');
    expect(later?.text).toMatch(/COMP 1406/);
  });

  it('reads captions into timed windows', () => {
    const s = extractCaptions(readFileSync(join(folder, 'transcripts', 'Lecture 05 - Recursion.vtt'), 'utf8'));
    expect(s.map((x) => x.timestamp)).toEqual(['0:01', '12:30']);
    expect(s[1].text).toMatch(/RecursionError/);
    const srt = extractCaptions(readFileSync(join(folder, 'transcripts', 'Lecture 03 - Loops.srt'), 'utf8'));
    expect(srt[0].timestamp).toBe('5:00');
  });

  it('splits code at definitions with line numbers, and markdown at headings', () => {
    const code = extractCode(readFileSync(join(folder, 'code', 'factorial.py'), 'utf8'));
    expect(code.map((c) => c.heading)).toEqual(['def factorial(n):', 'def total(values):']);
    expect(code[0].lines).toEqual([1, 7]);
    const md = extractText(readFileSync(join(folder, 'notes', 'week4-functions.md'), 'utf8'));
    expect(md.map((m) => m.heading)).toEqual(['Week 4: Functions', 'Return values', 'Scope']);
  });

  it('knows lectures and assignments by name', () => {
    expect(lectureNumber('Lecture 05 - Recursion.pptx')).toBe(5);
    expect(lectureNumber('week4-functions.md')).toBe(4);
    expect(lectureNumber('slides/lec12.pdf')).toBe(12);
    expect(lectureNumber('Course Outline.docx')).toBeUndefined();
    expect(looksLikeAssignment('A3 - Recursion.pdf')).toBe(true);
    expect(looksLikeAssignment('assignments/assignment2.pdf')).toBe(true);
    expect(looksLikeAssignment('labs/lab5.ipynb')).toBe(true);
    expect(looksLikeAssignment('Lecture 05 - Recursion.pptx')).toBe(false);
  });
});

describe('chunks and citations', () => {
  it('cites the way a student would look it up', () => {
    expect(citeFor('Lecture 05 - Recursion.pptx', { slide: 2 }, 'slides')).toBe('Lecture 05 - Recursion, slide 2');
    expect(citeFor('Course Outline.docx', { page: 3 }, 'doc')).toBe('Course Outline, p. 3');
    expect(citeFor('transcripts/Lecture 05 - Recursion.vtt', { timestamp: '12:30' }, 'transcript')).toBe('Lecture 05 - Recursion at 12:30');
    expect(citeFor('code/factorial.py', { lines: [1, 7] }, 'code')).toBe('factorial.py, lines 1–7');
    expect(citeFor('notes/week4-functions.md', { heading: 'Scope' }, 'notes')).toBe('week4-functions — Scope');
  });

  it('gives stable ids and splits long sections', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${'Recursion breaks a problem into smaller pieces. '.repeat(3)}`).join('\n\n');
    const a = toChunks('notes/long.md', { kind: 'notes', sections: [{ text: long, heading: 'Long' }] });
    const b = toChunks('notes/long.md', { kind: 'notes', sections: [{ text: long, heading: 'Long' }] });
    expect(a.length).toBeGreaterThan(3);
    expect(a.every((c) => c.text.length <= 1600)).toBe(true);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });
});

describe('search', () => {
  it('tokenizes words and code identifiers', () => {
    expect(tokenize('sumDigits(n) and is_palindrome')).toEqual(expect.arrayContaining(['sumdigits', 'sum', 'digit', 'is_palindrome', 'palindrome']));
    expect(tokenize('The loops are running')).toEqual(['loop', 'runn']);
  });

  it('ranks the right passage first', () => {
    const chunks = [
      { id: 'a', file: 'x', cite: 'Lecture 3, slide 2', heading: 'The accumulator pattern', text: 'Start an accumulator before the loop and update it inside.', kind: 'slides' as const },
      { id: 'b', file: 'y', cite: 'Lecture 5, slide 2', heading: 'Two parts', text: 'The stopping case answers small inputs directly; the recursive case calls itself.', kind: 'slides' as const },
      { id: 'c', file: 'z', cite: 'Outline', text: 'Python 3, problem solving, academic integrity.', kind: 'doc' as const },
    ];
    const bm = new Bm25(chunks);
    expect(bm.search('what is the stopping case in recursion')[0].id).toBe('b');
    expect(bm.search('accumulator')[0].id).toBe('a');
    expect(bm.search('quantum entanglement')).toEqual([]);
  });

  it('excerpts around the matching words', () => {
    const t = `${'Filler sentence about nothing. '.repeat(40)}The stopping case is where recursion ends. ${'More filler. '.repeat(40)}`;
    const e = excerpt(t, 'stopping case', 200);
    expect(e).toMatch(/stopping case/);
    expect(e.length).toBeLessThan(230);
  });
});

describe('CourseBrain (whole folder, offline)', () => {
  it('indexes every supported file, skips hidden/unsupported ones, searches with citations, and re-indexes incrementally', async () => {
    const data = mkdtempSync(join(tmpdir(), 'pw-data-'));
    const store = new CourseStore(data);
    const course = store.create({ code: 'COMP 1405', name: 'Intro to CS', folder });
    const brain = new CourseBrain({ store, rest: () => null, models: () => ({ text: 'm', embedding: 'e' }) });
    const progress: string[] = [];
    brain.on('progress', (_id, s) => progress.push(s.state));
    const status = await brain.index(course.id);
    expect(status.state).toBe('ready');
    expect(status.files).toBe(9);
    expect(progress[0]).toBe('indexing');
    const files = brain.files(store.get(course.id)!);
    expect(files.map((f) => f.path)).not.toContain('.hidden/secret.md');
    expect(files.map((f) => f.path)).not.toContain('photo.jpg');
    // Assignment specs found by name are suggested.
    expect(store.get(course.id)!.assignments).toEqual(expect.arrayContaining([FACTS.assignment]));

    const r = await brain.search(course.id, 'what does the course call the base case of a recursive function');
    expect(r.coverage).not.toBe('none');
    expect(r.hits[0].chunk.cite).toMatch(/Lecture 05 - Recursion/);
    expect(r.hits.some((h) => /stopping case/.test(h.chunk.text))).toBe(true);
    const acc = await brain.search(course.id, 'accumulator pattern loop total');
    expect(acc.hits[0].chunk.text).toMatch(/accumulator/i);
    const err = await brain.search(course.id, 'RecursionError maximum recursion depth');
    expect(err.hits.map((h) => h.chunk.cite)).toContain('Lecture 05 - Recursion at 12:30');
    const scope = await brain.search(course.id, 'object-oriented programming inheritance classes');
    expect(scope.hits[0].chunk.cite).toMatch(/Course Outline/);
    expect((await brain.search(course.id, 'eigenvalues of hermitian matrices')).coverage).toBe('none');
    // Assignment mode puts the spec first.
    const pref = await brain.search(course.id, 'stopping case', 5, { preferFiles: [FACTS.assignment] });
    expect(pref.hits[0].chunk.file).toBe(FACTS.assignment);
    expect(brain.chunkByCite(course.id, 'lecture 05 recursion slide 2')?.slide).toBe(2);

    // Profile without a key: topics in lecture order, the course's terms.
    const profile = heuristicProfile(store.get(course.id)!, brain.chunks(course.id));
    expect(profile.topics.map((t) => t.title).slice(0, 3)).toEqual(['Loops', 'functions', 'Recursion']);
    expect(profile.conventions.join(' ')).toMatch(/Python/);
    expect(profile.glossary.map((g) => g.term.toLowerCase())).toContain('parameter');

    // Change one file → only it is re-read; untouched chunks keep their ids.
    const before = new Map(brain.chunks(course.id).map((c) => [c.id, c.file]));
    const notes = join(folder, 'notes', 'week4-functions.md');
    writeFileSync(notes, `${readFileSync(notes, 'utf8')}\n## Default arguments\n\nA default argument gives a parameter a value when the caller leaves it out.\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(notes, later, later);
    const fresh = new CourseBrain({ store, rest: () => null, models: () => ({ text: 'm', embedding: 'e' }) });
    await fresh.index(course.id);
    const after = fresh.chunks(course.id);
    const kept = after.filter((c) => before.has(c.id)).length;
    expect(kept).toBeGreaterThan(before.size - 4);
    expect((await fresh.search(course.id, 'default argument')).hits[0].chunk.file).toBe('notes/week4-functions.md');
  }, 60_000);
});

import { buildProfile } from '../../src/main/courses/profile';
import type { GeminiRest } from '../../src/main/gemini/rest';

/** A stand-in for the Gemini REST client: bag-of-words "embeddings", canned profile JSON. */
function fakeRest() {
  const vocab = new Map<string, number>();
  const vec = (t: string) => {
    const v = new Array(768).fill(0);
    for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
      if (!vocab.has(w)) vocab.set(w, vocab.size % 768);
      v[vocab.get(w)!] += 1;
    }
    return v;
  };
  const calls = { embed: 0, generate: 0 };
  const rest = {
    hasKey: true,
    async embed(_m: string, texts: string[]) {
      calls.embed += texts.length;
      return texts.map(vec);
    },
    async generateJson() {
      calls.generate += 1;
      return { summary: 'Intro programming in Python 3.', topics: [{ title: 'Loops', source: 'Lecture 03 - Loops' }, { title: 'Recursion', source: 'Lecture 05 - Recursion' }], glossary: [{ term: 'stopping case', definition: 'the input small enough to answer directly', source: 'Lecture 05 - Recursion, slide 2' }], conventions: ['Python 3'], laterTopics: ['object-oriented programming (COMP 1406)'] };
    },
  } as unknown as GeminiRest;
  return { rest, calls };
}

describe('CourseBrain with Gemini', () => {
  it('embeds passages once, fuses keyword + vector rankings, and writes the profile with Gemini', async () => {
    const data = mkdtempSync(join(tmpdir(), 'pw-data-'));
    const store = new CourseStore(data);
    const course = store.create({ code: 'COMP 1405', name: 'Intro to CS', folder });
    const { rest, calls } = fakeRest();
    const brain = new CourseBrain({ store, rest: () => rest, models: () => ({ text: 'gemini-3.8-flash', embedding: 'gemini-embedding-001' }) });
    const st = await brain.index(course.id);
    expect(st.embedded).toBe(st.chunks);
    const r = await brain.search(course.id, 'stopping case recursion');
    expect(r.hits[0].via).toEqual(expect.arrayContaining(['bm25', 'embedding']));
    const embedded = calls.embed;
    // Re-index with nothing changed: no new embedding calls (vectors are kept on disk).
    const again = new CourseBrain({ store, rest: () => rest, models: () => ({ text: 'gemini-3.8-flash', embedding: 'gemini-embedding-001' }) });
    await again.index(course.id);
    expect(calls.embed).toBe(embedded + 0);
    const p = await buildProfile(store.get(course.id)!, brain.chunks(course.id), rest, 'gemini-3.8-flash');
    expect(p.generatedBy).toBe('gemini');
    expect(p.glossary[0].term).toBe('stopping case');
    expect(p.laterTopics[0]).toMatch(/COMP 1406/);
  }, 60_000);
});
