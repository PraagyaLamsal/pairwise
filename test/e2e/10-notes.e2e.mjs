// Phase 6 — session notes written to the course folder (summary, key ideas, definitions, to
// review, sources, the whiteboard diagram as an image), "say that again" with the ink redrawn in
// time with the speech, and picking up where the last session left off.
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, callTool, windowByRole, FAKE_DISPLAYS, openTargetWindow } from './harness.mjs';
import { makeCourseFolder } from '../fixtures/make-course.mjs';

const folder = await makeCourseFolder(mkdtempSync(join(tmpdir(), 'pw-e2e-notes-')));
const { app } = await launch({ PAIRWISE_MOCK_SCRIPT: 'none', PAIRWISE_GROUNDER: 'ocr' });
const S = (fn, arg) => main(app, fn, arg);

try {
  const id = await S((_e, f) => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false, inkFade: 'manual' });
    const c = p.courses.create({ code: 'COMP 1405', name: 'Intro to CS', folder: f });
    p.session.indexCourse(c.id);
    return c.id;
  }, folder);
  await waitFor(() => S((_e, i) => globalThis.__pairwise.courses.get(i).indexStatus.state === 'ready', id), { label: 'indexed', timeout: 60_000 });
  const d1 = FAKE_DISPLAYS[0];
  await openTargetWindow(app, { x: d1.bounds.x + 70, y: d1.bounds.y + 90, width: 860, height: 300, html: `<!doctype html><body style="margin:0;font:22px DejaVu Sans Mono;padding:24px;background:#fff">def <span data-t="f">factorial</span>(n):<br>&nbsp;&nbsp;&nbsp;&nbsp;if n == 0: return 1</body>` });

  let r = await S((_e, i) => globalThis.__pairwise.session.start({ courseId: i }), id);
  assert.ok(r.ok, r.error);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await waitFor(() => S(() => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays' });
  await S(() => globalThis.__pairwise.session.setMuted(true));

  // A short session: the student asks, the tutor explains with a mark, saves notes, cites, draws.
  await S(() => globalThis.__pairwise.session.mock.hear('why does factorial need an if statement?'));
  await sleep(300);
  await S(() =>
    globalThis.__pairwise.session.mock.speakNow({
      segments: [
        { say: 'Because every recursive function needs a stopping case, like this line right here at the top.' },
        { tool: 'annotate', args: { items: [{ kind: 'underline', target: 'the word "factorial"' }] } },
        { say: 'Without it, the calls never end.' },
      ],
    }),
  );
  await waitFor(() => S(() => globalThis.__pairwise.session.ink.all().some((i) => i.kind === 'underline')), { label: 'underline drawn', timeout: 15_000 });
  await waitFor(() => S(() => !globalThis.__pairwise.session.turn && !globalThis.__pairwise.session.playback.playing), { label: 'turn done', timeout: 20_000 });

  // "Say that again": audio replays and the underline is drawn again, at the same point in the speech.
  const before = await S(() => globalThis.__pairwise.session.ink.all().filter((i) => /-replay$/.test(i.group ?? '')).length);
  const t0 = Date.now();
  await S(() => globalThis.__pairwise.session.command({ type: 'replay' }));
  await waitFor(() => S(() => globalThis.__pairwise.session.ink.all().some((i) => /-replay$/.test(i.group ?? ''))), { label: 'replayed ink', timeout: 4000 });
  const rep = await S(() => globalThis.__pairwise.session.ink.all().find((i) => /-replay$/.test(i.group ?? '')));
  assert.equal(before, 0);
  assert.equal(rep.kind, 'underline');
  assert.ok(rep.revealAt > t0 + 300, `redrawn when its words come round again (+${rep.revealAt - t0} ms), not at once`);

  for (const n of [
    { kind: 'key_idea', text: 'A recursive function solves a smaller version of the same problem.' },
    { kind: 'definition', text: 'Stopping case — the input small enough to answer directly.' },
    { kind: 'to_review', text: 'Trace factorial(3) by hand.' },
  ]) assert.equal((await callTool(app, 'save_note', n)).response.ok, true);
  const s1 = await callTool(app, 'search_course', { query: 'stopping case' });
  await S(() => globalThis.__pairwise.session.mock.speakNow({ segments: [{ say: 'Your slides call it the stopping case.' }] }));
  await waitFor(() => S(() => globalThis.__pairwise.session.captions.some((c) => /slides call it/.test(c.text))), { label: 'caption' });
  await callTool(app, 'cite', { source: s1.response.results[0].source });
  await callTool(app, 'draw_diagram', { title: 'factorial(2)', kind: 'tree', nodes: [{ id: 'a', label: 'factorial(2)' }, { id: 'b', label: 'factorial(1)' }, { id: 'c', label: 'factorial(0)' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
  await waitFor(() => S(() => globalThis.__pairwise.session.whiteboard.diagrams.length === 1), { label: 'diagram snapshot', timeout: 25_000 });

  // --- end: notes are written into the course folder --------------------------------------------
  const tEnd = Date.now();
  await S(() => (globalThis.__notifications = []));
  await S(() => globalThis.__pairwise.session.end());
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'idle'), { label: 'ended' });
  const endMs = Date.now() - tEnd;
  assert.ok(endMs < 4000, `ending didn't wait for the notes (${endMs} ms)`);
  await S(async () => globalThis.__pairwise.session.notesWriting);
  const dir = join(folder, 'Pairwise notes');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 1, `one notes file (${files})`);
  const md = readFileSync(join(dir, files[0]), 'utf8');
  console.log(`notes: ${files[0]}\n${md.split('\n').slice(0, 14).join('\n')}`);
  assert.match(files[0], /^\d{4}-\d\d-\d\d \d\d\.\d\d Why does factorial need an if statement\.md$/);
  // …and a "Notes saved" notification says so (the course page isn't in front), opening them on click.
  const shown = await S(() => globalThis.__notifications);
  assert.equal(shown.length, 1, JSON.stringify(shown));
  assert.equal(shown[0].body, 'COMP 1405 · Why does factorial need an if statement');
  assert.equal(shown[0].file, join(dir, files[0]));
  for (const h of ['## Summary', '## Key ideas', '## Definitions', '## To review', '## Diagrams', '## Sources from your course', '## Conversation (condensed)']) assert.ok(md.includes(h), `notes have ${h}`);
  assert.match(md, /Trace factorial\(3\) by hand/);
  assert.match(md, /Lecture 05 - Recursion/);
  const img = /!\[[^\]]*\]\((images\/[^)]+)\)/.exec(md)[1];
  assert.ok(existsSync(join(dir, decodeURI(img))), 'diagram image saved next to the notes');
  // the hub lists it
  await S(() => globalThis.__pairwise.hub.open('courses'));
  const hub = await windowByRole(app, 'hub');
  await hub.waitForSelector('text=Why does factorial need an if statement', { timeout: 10_000 });
  await hub.locator('.detail').screenshot({ path: join(artifacts, 'p6-hub-notes.png') }).catch(() => undefined);
  // our notes are not course material
  await S((_e, i) => globalThis.__pairwise.session.indexCourse(i), id);
  await waitFor(() => S((_e, i) => globalThis.__pairwise.courses.get(i).indexStatus.state === 'ready', id), { label: 're-indexed' });
  assert.equal(await S((_e, i) => globalThis.__pairwise.courses.get(i).indexStatus.files, id), 9, 'notes folder is not indexed');

  // --- resume: the next session picks up where this one stopped ---------------------------------
  const resume = await S((_e, i) => globalThis.__pairwise.courses.getResume(i), id);
  assert.match(resume.summary, /factorial/);
  assert.ok(resume.toReview.some((t) => /Trace factorial/.test(t)));
  assert.ok(resume.lastNotesFile.endsWith('.md'));
  r = await S((_e, i) => globalThis.__pairwise.session.start({ courseId: i, resume: true }), id);
  assert.ok(r.ok, r.error);
  await waitFor(() => S(() => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live again' });
  await waitFor(() => S(() => globalThis.__pairwise.session.mock.stats.clientContents.length > 0), { label: 'opening turn sent' });
  const opening = await S(() => JSON.stringify(globalThis.__pairwise.session.mock.stats.clientContents[0]));
  assert.match(opening, /Last session with this student/);
  assert.match(opening, /Trace factorial/);
  await S(() => globalThis.__pairwise.session.end());

  console.log('phase 6 notes/replay/resume e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
