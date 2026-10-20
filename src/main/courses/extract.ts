import { basename, extname } from 'node:path';
import JSZip from 'jszip';
import type { CourseChunk } from '@shared/courses';

/**
 * Text extraction for the course brain. Each extractor returns sections that keep where they
 * came from (page, slide, timestamp, line range, heading) so every answer can cite its source
 * the way a student would look it up: "Lecture 5 – Recursion.pdf, slide 12".
 */

export interface Section {
  text: string;
  page?: number;
  slide?: number;
  /** Start time for transcripts, "mm:ss" or "h:mm:ss". */
  timestamp?: string;
  heading?: string;
  lines?: [number, number];
  /** Notebook cell index (1-based). */
  cell?: number;
}

export type FileKind = CourseChunk['kind'];

export interface Extracted {
  kind: FileKind;
  sections: Section[];
}

export const CODE_EXT = new Set(['.py', '.java', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.kt', '.swift', '.rb', '.php', '.scala', '.hs', '.ml', '.rkt', '.scm', '.lisp', '.clj', '.r', '.jl', '.m', '.sql', '.sh', '.lua', '.pl', '.asm', '.s', '.v', '.vhd', '.html', '.css']);
export const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.tex', '.org']);
export const SUPPORTED_EXT = new Set(['.pdf', '.pptx', '.docx', '.vtt', '.srt', '.ipynb', ...TEXT_EXT, ...CODE_EXT]);

/** Assignment specs by name: "A3", "Assignment 2", "hw4", "Lab 5", "project", "problem set". */
const ASSIGNMENT_RE = /(^|[\s_\-/(])(a\d{1,2}|assign(ment)?s?\s*[-_]?\d*|hw\s*[-_]?\d+|homework|lab\s*[-_]?\d+|project|problem[\s_-]?set|pset\s*\d*|tutorial\s*[-_]?\d+)($|[\s_\-.)/])/i;

export function looksLikeAssignment(relPath: string): boolean {
  return ASSIGNMENT_RE.test(relPath.toLowerCase());
}

/** Lecture number from a file name ("Lecture 05 - Recursion.pdf", "lec5.pptx", "week3/notes.md"). */
export function lectureNumber(relPath: string): number | undefined {
  const m = /(?:^|[^a-z])(?:lec(?:ture)?|week|wk|class|session|module|unit|chapter|ch)[\s_\-.]*0*(\d{1,2})(?!\d)/i.exec(relPath);
  return m ? Number(m[1]) : undefined;
}

export async function extractFile(relPath: string, data: Buffer): Promise<Extracted> {
  const ext = extname(relPath).toLowerCase();
  const assignment = looksLikeAssignment(relPath);
  const kindFor = (k: FileKind): FileKind => (assignment && k !== 'code' ? 'assignment' : k);
  switch (ext) {
    case '.pdf': {
      const r = await extractPdf(data);
      return { kind: kindFor(r.slides ? 'slides' : 'pdf'), sections: r.sections };
    }
    case '.pptx':
      return { kind: kindFor('slides'), sections: await extractPptx(data) };
    case '.docx':
      return { kind: kindFor('doc'), sections: await extractDocx(data) };
    case '.vtt':
    case '.srt':
      return { kind: 'transcript', sections: extractCaptions(data.toString('utf8')) };
    case '.ipynb':
      return { kind: kindFor('code'), sections: extractNotebook(data.toString('utf8')) };
    default:
      if (TEXT_EXT.has(ext)) return { kind: kindFor('notes'), sections: extractText(data.toString('utf8'), ext) };
      if (CODE_EXT.has(ext)) return { kind: 'code', sections: extractCode(data.toString('utf8')) };
      throw new Error(`Unsupported file type ${ext || basename(relPath)}`);
  }
}

// ---------------------------------------------------------------------------
// PDF (pdf.js, text layer). Landscape decks with little text per page are treated as slides.
// ---------------------------------------------------------------------------

interface PdfTextItem {
  str: string;
  transform: number[];
  hasEOL?: boolean;
  height?: number;
}

export async function extractPdf(data: Buffer): Promise<{ sections: Section[]; slides: boolean }> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument(o: Record<string, unknown>): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ view: number[]; getTextContent(): Promise<{ items: PdfTextItem[] }> }> }>; destroy(): Promise<void> };
  };
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  const pdf = await task.promise;
  const sections: Section[] = [];
  let landscape = 0;
  let chars = 0;
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const [x0, y0, x1, y1] = page.view;
      if (x1 - x0 > (y1 - y0) * 1.15) landscape++;
      const tc = await page.getTextContent();
      // Rebuild lines from positions (pdf.js items are runs; y decreases down the page).
      const lines: { y: number; parts: { x: number; s: string; h: number }[] }[] = [];
      for (const it of tc.items) {
        if (!it.str) continue;
        const x = it.transform[4];
        const y = it.transform[5];
        const h = Math.abs(it.transform[3]) || it.height || 10;
        let line = lines.find((l) => Math.abs(l.y - y) < h * 0.5);
        if (!line) {
          line = { y, parts: [] };
          lines.push(line);
        }
        line.parts.push({ x, s: it.str, h });
      }
      lines.sort((a, b) => b.y - a.y);
      const text = lines
        .map((l) =>
          l.parts
            .sort((a, b) => a.x - b.x)
            .map((p) => p.s)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean)
        .join('\n');
      chars += text.length;
      // The largest text on the page is usually its title.
      const tallest = lines.flatMap((l) => l.parts).sort((a, b) => b.h - a.h)[0];
      const heading = tallest ? lines.find((l) => l.parts.includes(tallest))?.parts.map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim().slice(0, 90) : undefined;
      if (text) sections.push({ text, page: n, heading });
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
  const slides = pdf.numPages > 0 && landscape / pdf.numPages > 0.6 && chars / Math.max(1, pdf.numPages) < 1400;
  if (slides) for (const s of sections) (s.slide = s.page), delete s.page;
  return { sections, slides };
}

// ---------------------------------------------------------------------------
// Office files (they are zip archives of XML)
// ---------------------------------------------------------------------------

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** Paragraph texts from DrawingML (<a:p> with <a:t> runs). */
function drawingParagraphs(xml: string): string[] {
  const out: string[] = [];
  for (const p of xml.match(/<a:p[ >][\s\S]*?<\/a:p>/g) ?? []) {
    const t = (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((x) => decodeXml(x.replace(/<\/?a:t>/g, ''))).join('');
    if (t.trim()) out.push(t.trim());
  }
  return out;
}

export async function extractPptx(data: Buffer): Promise<Section[]> {
  const zip = await JSZip.loadAsync(data);
  const num = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => num(a) - num(b));
  const sections: Section[] = [];
  for (const f of slides) {
    const n = num(f);
    const xml = await zip.file(f)!.async('string');
    // The title placeholder, when there is one.
    const titleShape = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph[^>]*type="(?:title|ctrTitle)"[\s\S]*?<\/p:sp>/.exec(xml)?.[0];
    const heading = titleShape ? drawingParagraphs(titleShape).join(' ') : undefined;
    const body = drawingParagraphs(xml);
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesFile ? drawingParagraphs(await notesFile.async('string')).filter((t) => !/^\d+$/.test(t)) : [];
    const text = [...body, ...(notes.length ? ['Speaker notes: ' + notes.join(' ')] : [])].join('\n');
    if (text.trim()) sections.push({ text, slide: n, heading: heading || body[0]?.slice(0, 90) });
  }
  return sections;
}

export async function extractDocx(data: Buffer): Promise<Section[]> {
  const zip = await JSZip.loadAsync(data);
  const xml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  const sections: Section[] = [];
  let heading: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (buf.join('').trim()) sections.push({ text: buf.join('\n'), heading });
    buf = [];
  };
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const text = (p.match(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>/g) ?? [])
      .map((x) => (x === '<w:tab/>' ? '\t' : decodeXml(x.replace(/<w:t(?: [^>]*)?>|<\/w:t>/g, ''))))
      .join('')
      .trim();
    if (!text) continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    if (/^(Heading|Title)\d*$/i.test(style) || /^heading/i.test(style)) {
      flush();
      heading = text.slice(0, 120);
      buf.push(text);
    } else buf.push(text);
  }
  flush();
  return sections;
}

// ---------------------------------------------------------------------------
// Plain text, captions, code, notebooks
// ---------------------------------------------------------------------------

export function extractText(src: string, ext = '.md'): Section[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const isHeading = (l: string) => (ext === '.tex' ? /^\\(chapter|section|subsection)\*?\{/.test(l) : /^#{1,4}\s+\S/.test(l));
  const headingText = (l: string) => (ext === '.tex' ? (/\{([^}]*)\}/.exec(l)?.[1] ?? l) : l.replace(/^#+\s*/, '')).trim();
  const sections: Section[] = [];
  let heading: string | undefined;
  let start = 1;
  let buf: string[] = [];
  const flush = (end: number) => {
    if (buf.join('').trim()) sections.push({ text: buf.join('\n').trim(), heading, lines: [start, end] });
    buf = [];
  };
  lines.forEach((l, i) => {
    // Setext headings (Title\n=====) too.
    const setext = ext !== '.tex' && /^(=|-){3,}\s*$/.test(lines[i + 1] ?? '') && l.trim() && !/^[-=]{3,}/.test(l);
    if (isHeading(l) || setext) {
      flush(i);
      heading = headingText(l);
      start = i + 1;
    }
    buf.push(l);
  });
  flush(lines.length);
  return sections;
}

const TS = /(\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?/;

function shortTime(t: string): string {
  const parts = t.replace(/[.,]\d+$/, '').split(':').map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** WebVTT / SRT → ~75-second windows of speech, each with its start time. */
export function extractCaptions(src: string): Section[] {
  const cues: { t: number; ts: string; text: string }[] = [];
  const blocks = src.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() && l.trim() !== 'WEBVTT' && !/^NOTE\b/.test(l));
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing < 0) continue;
    const start = TS.exec(lines[timing])?.[0];
    if (!start) continue;
    const text = lines
      .slice(timing + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const p = start.replace(/[.,]\d+$/, '').split(':').map(Number);
    const secs = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    // Auto-captions repeat the previous cue's tail; drop exact repeats.
    if (cues.length && cues[cues.length - 1].text === text) continue;
    cues.push({ t: secs, ts: shortTime(start), text });
  }
  const out: Section[] = [];
  let cur: { ts: string; t: number; parts: string[] } | null = null;
  for (const c of cues) {
    if (!cur || c.t - cur.t > 75) {
      if (cur) out.push({ text: cur.parts.join(' '), timestamp: cur.ts });
      cur = { ts: c.ts, t: c.t, parts: [] };
    }
    cur.parts.push(c.text);
  }
  if (cur) out.push({ text: cur.parts.join(' '), timestamp: cur.ts });
  return out;
}

/** Code: split at top-level definitions, else every ~60 lines; keeps line numbers. */
export function extractCode(src: string): Section[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const def = /^(def |class |async def |function |export (default )?(function|class|const)|public |private |protected |static |func |fn |pub fn |impl |struct |interface |\(define )/;
  const sections: Section[] = [];
  let start = 0;
  const push = (end: number) => {
    const text = lines.slice(start, end).join('\n');
    if (text.trim()) {
      const head = lines.slice(start, end).find((l) => def.test(l.trim()))?.trim();
      sections.push({ text, lines: [start + 1, end], heading: head?.slice(0, 80) });
    }
    start = end;
  };
  for (let i = 1; i < lines.length; i++) {
    const tooLong = i - start >= 60;
    if ((def.test(lines[i]) && i - start >= 5) || tooLong) push(i);
  }
  push(lines.length);
  return sections;
}

export function extractNotebook(src: string): Section[] {
  let nb: { cells?: { cell_type: string; source: string | string[] }[] };
  try {
    nb = JSON.parse(src);
  } catch {
    return [];
  }
  const sections: Section[] = [];
  let heading: string | undefined;
  (nb.cells ?? []).forEach((c, i) => {
    const text = (Array.isArray(c.source) ? c.source.join('') : c.source ?? '').trim();
    if (!text) return;
    if (c.cell_type === 'markdown') {
      const h = /^#+\s*(.+)$/m.exec(text)?.[1];
      if (h) heading = h.trim().slice(0, 90);
    }
    sections.push({ text: c.cell_type === 'code' ? `# code cell\n${text}` : text, cell: i + 1, heading });
  });
  return sections;
}
