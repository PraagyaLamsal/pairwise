import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { CourseChunk } from '@shared/courses';
import { lectureNumber, type Extracted, type Section } from './extract';

const TARGET = 1100;
const MAX = 1600;

/** "Lecture 05 - Recursion.pdf" → "Lecture 05 - Recursion" (what a student would call it). */
export function displayName(relPath: string): string {
  const base = basename(relPath, extname(relPath)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base || basename(relPath);
}

/** Human citation: "Lecture 5 – Recursion, slide 12" · "Notes.md — Base cases" · "Lecture 5 (video) at 12:34". */
export function citeFor(relPath: string, s: Pick<Section, 'page' | 'slide' | 'timestamp' | 'heading' | 'lines' | 'cell'>, kind: CourseChunk['kind']): string {
  const name = displayName(relPath);
  const ext = extname(relPath).toLowerCase();
  if (s.slide) return `${name}, slide ${s.slide}`;
  if (s.page) return `${name}, p. ${s.page}`;
  if (s.timestamp) return `${name} at ${s.timestamp}`;
  if (s.cell) return `${name}${ext}, cell ${s.cell}`;
  if (kind === 'code' && s.lines) return `${name}${ext}, lines ${s.lines[0]}–${s.lines[1]}`;
  if (s.heading && s.heading !== name) return `${name} — ${s.heading}`;
  return name;
}

/** Split long text at paragraph, then sentence, boundaries. */
function split(text: string): string[] {
  if (text.length <= MAX) return [text];
  const out: string[] = [];
  let cur = '';
  const pieces = text.split(/\n{2,}/).flatMap((p) => (p.length > MAX ? p.split(/(?<=[.!?])\s+(?=[A-Z(])/) : [p]));
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > TARGET) {
      out.push(cur);
      // A little overlap keeps a definition and its example together across a boundary.
      const tail = cur.slice(-160);
      cur = tail.includes(' ') ? tail.slice(tail.indexOf(' ') + 1) : '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > MAX) {
      out.push(cur.slice(0, TARGET));
      cur = cur.slice(TARGET - 120);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Sections → chunks with stable ids (same file + same text → same id, so re-indexing is cheap). */
export function toChunks(relPath: string, ex: Extracted): CourseChunk[] {
  const lecture = lectureNumber(relPath);
  const chunks: CourseChunk[] = [];
  // Slides with almost no text (a title, a picture) merge into the next one.
  const sections: Section[] = [];
  for (const s of ex.sections) {
    const prev = sections[sections.length - 1];
    if (prev && prev.slide && s.slide && prev.text.length < 60) {
      sections[sections.length - 1] = { ...s, text: `${prev.text}\n${s.text}`, slide: prev.slide, heading: prev.heading ?? s.heading };
      continue;
    }
    sections.push(s);
  }
  for (const s of sections) {
    const parts = split(s.text.trim());
    parts.forEach((text, i) => {
      const id = createHash('sha1').update(`${relPath}\n${s.slide ?? s.page ?? s.timestamp ?? s.cell ?? s.lines?.[0] ?? ''}\n${i}\n${text}`).digest('hex').slice(0, 16);
      chunks.push({
        id,
        file: relPath,
        cite: citeFor(relPath, s, ex.kind),
        lecture,
        page: s.page,
        slide: s.slide,
        timestamp: s.timestamp,
        heading: s.heading,
        text,
        kind: ex.kind,
      });
    });
  }
  return chunks;
}
