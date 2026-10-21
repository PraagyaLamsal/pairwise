// Phase 4 — the course brain, end to end: a generated course folder (slides PDF, PPTX with
// speaker notes, DOCX outline, Markdown, VTT/SRT transcripts, Python, a notebook and an
// assignment spec) is read and indexed; the hub shows what the tutor knows and can search it;
// in a session the tutor's search_course / cite / flag_out_of_scope / think_deeply work, the
// system prompt carries the course profile, and assignment mode changes the rules.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, windowByRole, callTool, captureOverlay, screenShot } from './harness.mjs';
import { makeCourseFolder, FACTS } from '../fixtures/make-course.mjs';

const folder = await makeCourseFolder(mkdtempSync(join(tmpdir(), 'pw-e2e-course-')));
const { app } = await launch({ PAIRWISE_MOCK_SCRIPT: 'none' });
const course = (id) => main(app, (_e, i) => globalThis.__pairwise.courses.get(i), id);
const setupText = () => main(app, () => globalThis.__pairwise.session.mock.stats.setups.slice(-1)[0]?.systemInstruction?.parts?.[0]?.text ?? '');

try {
  const id = await main(
    app,
    (_e, f) => {
      const p = globalThis.__pairwise;
      p.settings.update({ onboardingComplete: true, sounds: false });
      const c = p.courses.create({ code: 'COMP 1405', name: 'Introduction to Computer Science I', folder: f, term: 'Fall 2026' });
      p.session.indexCourse(c.id);
      return c.id;
    },
    folder,
  );

  // --- 1. the folder is read: every supported type, assignment spec suggested ----------------
  const t0 = Date.now();
  await waitFor(async () => (await course(id)).indexStatus.state === 'ready', { label: 'course indexed', timeout: 60_000 });
  const st = (await course(id)).indexStatus;
  console.log(`indexed ${st.files} files → ${st.chunks} passages in ${Date.now() - t0} ms (skipped: ${JSON.stringify(st.skipped ?? [])})`);
  assert.equal(st.files, 9, 'all nine supported files read');
  assert.ok(st.chunks >= 15, `passages (${st.chunks})`);
  assert.deepEqual((await course(id)).assignments, [FACTS.assignment], 'the assignment spec is suggested by its name');
  await waitFor(async () => (await course(id)).profile, { label: 'course profile', timeout: 20_000 });
  const profile = (await course(id)).profile;
  assert.ok(profile.topics.some((t) => /Recursion/.test(t.title)) && profile.topics.some((t) => /Loops/.test(t.title)), JSON.stringify(profile.topics));
  assert.ok(profile.conventions.some((c) => /Python/.test(c)), 'knows the course codes in Python');

  // --- 2. the hub shows what the tutor knows and can search the material --------------------
  await main(app, () => globalThis.__pairwise.hub.open('courses'));
  const hub = await windowByRole(app, 'hub');
  await hub.setViewportSize({ width: 1060, height: 900 }).catch(() => undefined);
  // Someone who used Pairwise before this version sees what's new, once.
  await hub.waitForSelector('.whats-new', { timeout: 10_000 });
  assert.equal(await hub.locator('.wn-item').count(), 4, 'four new things');
  await hub.locator('.whats-new').screenshot({ path: join(artifacts, 'p4-whats-new.png') });
  await hub.click('.whats-new button:has-text("Got it")');
  await waitFor(async () => (await hub.locator('.whats-new').count()) === 0, { label: 'the card goes away' });
  assert.equal(await main(app, () => globalThis.__pairwise.settings.get().whatsNewSeen), '2026-10-round-2', 'for good');
  await sleep(500);
  await hub.click('.course-tile >> nth=0').catch(() => undefined);
  await hub.waitForSelector('text=What Ada knows about this course', { timeout: 15_000 });
  await hub.waitForSelector('.file-row >> text=Lecture 05 - Recursion.pptx');
  await hub.fill('.search-try input', 'stopping case');
  await hub.press('.search-try input', 'Enter');
  await hub.waitForSelector('.hit-cite >> text=/Lecture 05 - Recursion/');
  await hub.locator('.detail').screenshot({ path: join(artifacts, 'p4-hub-course.png') }).catch(() => hub.screenshot({ path: join(artifacts, 'p4-hub-course.png') }));

  // --- 3. a session: the prompt carries the course; the tools answer with citations ---------
  let r = await main(app, (_e, i) => globalThis.__pairwise.session.start({ courseId: i }), id);
  assert.ok(r.ok, r.error);
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live' });
  await main(app, () => globalThis.__pairwise.session.setMuted(true));
  const sys = await setupText();
  assert.match(sys, /search_course/, 'told to search the course material');
  assert.match(sys, /Covered so far: .*Loops.*Recursion/, 'course topics in lecture order are in the prompt');
  assert.doesNotMatch(sys, /Assignment mode/);

  const s1 = await callTool(app, 'search_course', { query: 'what is the base case called in this course' });
  const res = s1.response;
  assert.equal(res.ok, true);
  assert.notEqual(res.coverage, 'none');
  assert.match(res.results[0].source, /Lecture 05 - Recursion/, JSON.stringify(res.results.map((x) => x.source)));
  assert.ok(res.results.some((x) => /stopping case/.test(x.excerpt)), 'the excerpt carries the course\'s own term');
  console.log(`search_course → ${res.results.map((x) => x.source).join(' | ')}`);
  const s2 = await callTool(app, 'search_course', { query: 'RecursionError maximum recursion depth exceeded' });
  assert.ok(s2.response.results.some((x) => x.source === 'Lecture 05 - Recursion at 12:30'), 'finds the moment in the lecture transcript');
  const s3 = await callTool(app, 'search_course', { query: 'eigenvalues of a hermitian matrix' });
  assert.equal(s3.response.coverage, 'none');
  assert.match(s3.response.note, /flag_out_of_scope/);

  // cite → a card on screen + a chip on the tutor's caption
  await main(app, () => globalThis.__pairwise.session.mock.speakNow({ segments: [{ say: 'In this course the base case is called the stopping case.' }] }));
  await waitFor(() => main(app, () => globalThis.__pairwise.session.captions.some((c) => c.speaker === 'tutor' && /stopping case/.test(c.text))), { label: 'tutor caption' });
  const c1 = await callTool(app, 'cite', { source: res.results[0].source });
  assert.equal(c1.response.shown, res.results[0].source);
  const ui = await main(app, () => globalThis.__pairwise.session.ui);
  assert.equal(ui.citation.cite, res.results[0].source);
  assert.match(ui.citation.snippet, /\S/);
  await waitFor(() => main(app, () => globalThis.__pairwise.session.captions.some((c) => c.cites?.length)), { label: 'citation chip on the caption' });
  await sleep(500);
  const ids = await main(app, () => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
  await screenShot(app, ids[0], join(artifacts, 'p4-citation-screen.png'));
  const hud = await windowByRole(app, 'hud');
  await hud.screenshot({ path: join(artifacts, 'p4-hud-cite.png') });

  // out of scope → a badge (and the caption says where it's taught)
  const f1 = await callTool(app, 'flag_out_of_scope', { topic: 'Inheritance', where: 'COMP 1406' });
  assert.equal(f1.response.ok, true);
  assert.match((await main(app, () => globalThis.__pairwise.session.ui)).outOfScope.topic, /Inheritance.*COMP 1406/);
  await sleep(400);
  await captureOverlay(app, ids[0], join(artifacts, 'p4-scope-overlay.png'));

  // think_deeply answers later (WHEN_IDLE) — demo mode explains what it would do
  const td = await callTool(app, 'think_deeply', { question: 'Why does factorial(3) return 6?' });
  assert.equal(td.response.ok, true);
  assert.equal(td.scheduling, 'WHEN_IDLE');

  // A scripted tutor turn: search, then cite the first source it got back.
  await main(app, () => {
    const s = globalThis.__pairwise.session;
    s.ui.citation = undefined;
    s.mock.queued.push({ segments: [{ say: 'Let me check your slides.' }, { tool: 'search_course', args: { query: 'accumulator pattern' } }, { say: 'Here it is.' }, { tool: 'cite', args: { source: '$first' } }] });
    s.command({ type: 'sendText', text: 'what is the accumulator pattern?' });
  });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.ui.citation?.cite), { label: 'tutor cited a source on its own', timeout: 15_000 });
  const auto = await main(app, () => globalThis.__pairwise.session.ui.citation.cite);
  assert.match(auto, /Loops/, `cited ${auto}`);

  await main(app, () => globalThis.__pairwise.session.end());
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.status === 'idle'), { label: 'ended' });

  // --- 4. assignment mode -------------------------------------------------------------------
  r = await main(app, (_e, o) => globalThis.__pairwise.session.start({ courseId: o.id, assignment: o.a }), { id, a: FACTS.assignment });
  assert.ok(r.ok, r.error);
  await waitFor(() => main(app, () => globalThis.__pairwise.session.snapshot.status === 'live'), { label: 'live (assignment)' });
  const sys2 = await setupText();
  assert.match(sys2, /Assignment mode/);
  assert.match(sys2, /never write their solution/);
  assert.equal(await main(app, () => globalThis.__pairwise.session.snapshot.assignment), FACTS.assignment);
  const s4 = await callTool(app, 'search_course', { query: 'stopping case recursion' });
  assert.equal(s4.response.results[0].source.startsWith('A3 - Recursion'), true, `the spec comes first (${s4.response.results[0].source})`);
  await main(app, () => globalThis.__pairwise.session.end());

  console.log('phase 4 course e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
