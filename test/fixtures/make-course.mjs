// Builds a realistic course folder (COMP 1405-style) with every supported file type, generated
// fresh so tests never depend on binary blobs: slides PDF, PPTX with speaker notes, a DOCX course
// outline with headings, Markdown notes, a lecture transcript (VTT), an SRT, Python code, a
// Jupyter notebook and an assignment spec. Course-specific wording ("stopping case",
// "accumulator pattern") lets tests check the tutor finds the course's own terms.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const FACTS = {
  stoppingCase: 'stopping case',
  accumulator: 'accumulator pattern',
  laterTopic: 'object-oriented programming',
  assignment: 'A3 - Recursion.pdf',
};

async function pdf(file, pages, { landscape = true } = {}) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const p of pages) {
    const page = landscape ? doc.addPage([720, 405]) : doc.addPage([612, 792]);
    const { height } = page.getSize();
    page.drawText(p.title, { x: 40, y: height - 60, size: landscape ? 26 : 18, font: bold, color: rgb(0.1, 0.1, 0.2) });
    let y = height - (landscape ? 100 : 90);
    for (const line of p.lines) {
      page.drawText(line, { x: 48, y, size: landscape ? 15 : 11, font });
      y -= landscape ? 24 : 16;
    }
  }
  writeFileSync(file, await doc.save());
}

async function pptx(file, slides) {
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS();
  for (const s of slides) {
    const slide = p.addSlide();
    slide.addText(s.title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true, placeholder: 'title' });
    slide.addText(s.lines.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.6, y: 1.3, w: 8.8, h: 3.5, fontSize: 18 });
    if (s.notes) slide.addNotes(s.notes);
  }
  const buf = await p.write({ outputType: 'nodebuffer' });
  writeFileSync(file, buf);
}

async function docx(file, blocks) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
  const children = blocks.map((b) =>
    b.h ? new Paragraph({ heading: b.h === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2, children: [new TextRun(b.text)] }) : new Paragraph({ children: [new TextRun(b.text)] }),
  );
  const doc = new Document({ sections: [{ children }] });
  writeFileSync(file, await Packer.toBuffer(doc));
}

/** Create the folder; returns its path. */
export async function makeCourseFolder(root) {
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(join(root, 'transcripts'), { recursive: true });
  mkdirSync(join(root, 'code'), { recursive: true });
  mkdirSync(join(root, 'labs'), { recursive: true });
  mkdirSync(join(root, '.hidden'), { recursive: true });

  await pdf(join(root, 'Lecture 03 - Loops.pdf'), [
    { title: 'Lecture 3: Loops', lines: ['for loops repeat a block for each item', 'while loops repeat until a condition is false'] },
    { title: 'The accumulator pattern', lines: ['Start an accumulator before the loop: total = 0', 'Update it inside the loop: total = total + x', 'Use it after the loop. We call this the accumulator pattern.'] },
    { title: 'Off-by-one errors', lines: ['range(n) stops before n', 'Check the first and the last iteration by hand'] },
  ]);

  await pptx(join(root, 'Lecture 05 - Recursion.pptx'), [
    { title: 'Lecture 5: Recursion', lines: ['A function that calls itself', 'Solves a problem using a smaller version of itself'], notes: 'Remind them of the factorial example from the lab.' },
    {
      title: 'Two parts of every recursive function',
      lines: ['The stopping case: the input is small enough to answer directly', 'The recursive case: call yourself on a smaller input', 'Every call must make progress toward the stopping case'],
      notes: 'In this course we say stopping case, not base case, so students connect it to loop conditions.',
    },
    { title: 'Tracing factorial(3)', lines: ['factorial(3) waits for factorial(2)', 'factorial(2) waits for factorial(1)', 'factorial(1) returns 1 (stopping case)'] },
  ]);

  await docx(join(root, 'Course Outline.docx'), [
    { h: 1, text: 'COMP 1405 Course Outline' },
    { text: 'This course introduces programming in Python 3 with an emphasis on problem solving.' },
    { h: 2, text: 'Topics' },
    { text: 'Variables and expressions, conditionals, loops and the accumulator pattern, functions, lists, recursion, file input and output.' },
    { h: 2, text: 'Not covered in this course' },
    { text: 'Object-oriented programming (classes, inheritance) is covered in COMP 1406.' },
    { h: 2, text: 'Academic integrity' },
    { text: 'Assignments are individual work. You may discuss ideas but must write your own code.' },
  ]);

  writeFileSync(
    join(root, 'notes', 'week4-functions.md'),
    `# Week 4: Functions\n\nA **parameter**: the name in the function header that receives a value.\n\n## Return values\n\nA function returns a value with \`return\`. If there is no return statement, Python returns None.\n\n## Scope\n\nVariables created inside a function are local to that function.\n`,
  );

  writeFileSync(
    join(root, 'transcripts', 'Lecture 05 - Recursion.vtt'),
    `WEBVTT\n\n00:00:01.000 --> 00:00:06.000\nOkay everyone, today is recursion.\n\n00:12:30.000 --> 00:12:38.000\nIf you forget the stopping case your function calls itself forever\n\n00:12:38.000 --> 00:12:45.000\nand Python raises a RecursionError: maximum recursion depth exceeded.\n`,
  );
  writeFileSync(join(root, 'transcripts', 'Lecture 03 - Loops.srt'), `1\n00:05:00,000 --> 00:05:04,000\nThe accumulator starts at zero before the loop.\n\n2\n00:05:04,000 --> 00:05:09,000\nInside the loop we add each item to it.\n`);

  writeFileSync(
    join(root, 'code', 'factorial.py'),
    `def factorial(n):\n    """Return n! using recursion."""\n    if n == 0:  # stopping case\n        return 1\n    return n * factorial(n - 1)  # recursive case\n\n\ndef total(values):\n    acc = 0  # accumulator\n    for v in values:\n        acc = acc + v\n    return acc\n`,
  );

  writeFileSync(
    join(root, 'labs', 'lab5.ipynb'),
    JSON.stringify({
      cells: [
        { cell_type: 'markdown', source: ['# Lab 5: Recursion practice\n', 'Write `count_down(n)` that prints n down to 1.'] },
        { cell_type: 'code', source: ['def count_down(n):\n', '    pass\n'] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );

  await pdf(
    join(root, FACTS.assignment),
    [
      {
        title: 'Assignment 3: Recursion',
        lines: ['Due Friday, November 6 at 11:59 pm', 'Q1. Write sum_digits(n) recursively. Do not use loops.', 'Q2. Write is_palindrome(s) recursively.', 'Your functions must each have a stopping case.'],
      },
    ],
    { landscape: false },
  );

  writeFileSync(join(root, '.hidden', 'secret.md'), '# should never be indexed');
  writeFileSync(join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return root;
}
