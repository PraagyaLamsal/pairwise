// Phase 3 — the student's side and the choreography, end to end against the Live mock:
//  1. auto-pause: a "video" playing on screen is paused the moment the student starts asking
//  2. draw-and-ask: circle something on the overlay (real pointer events) while talking → ONE
//     question: composite frame + "circled the area at box […]" note + zoomed crop + the audio
//  3. step-by-step: checklist card, point → wait → the student clicks → ✓ → next step (hover)
//  4. speech-timed ink: a mark asked for mid-sentence appears when that point of the speech is heard
//  5. explain_on_screen: each planned line's marks appear as that line is spoken (BeatSync)
import { join } from 'node:path';
import { launch, main, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, openTargetWindow, callTool, captureOverlay, screenShot, pointer, windowByRole } from './harness.mjs';
import { speechPcmBase64 } from './audio-fixtures.mjs';

const { app } = await launch({ PAIRWISE_GROUNDER: 'ocr', PAIRWISE_MOCK_SCRIPT: 'none' });
const stats = () => main(app, () => globalThis.__pairwise.session.mock.stats);
const snap = () => main(app, () => globalThis.__pairwise.session.snapshot);
const inside = (p, r, m = 0) => p.x >= r.x - m && p.y >= r.y - m && p.x <= r.x + r.width + m && p.y <= r.y + r.height + m;

const IDE = `<!doctype html><html><body style="margin:0;font-family:DejaVu Sans,Arial,sans-serif;background:#fff;color:#111">
<div style="display:flex;gap:14px;padding:12px 16px;background:#eef1f5;border-bottom:1px solid #ccd">
  <button data-t="run" style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">Run</button>
  <button data-t="debug" style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">Debug</button>
  <span style="flex:1"></span>
  <button data-t="submit" style="font-size:20px;padding:6px 16px;border:1px solid #889;border-radius:6px;background:#fff">Submit</button>
</div>
<pre style="margin:0;padding:18px 22px;font:22px/1.6 DejaVu Sans Mono,monospace">
<span data-t="line1">def <span data-t="fact">factorial</span>(n):</span>
<span data-t="line2">    if n == 0:</span>
<span data-t="line3">        return 1</span>
<span data-t="line4">    return n * factorial(n - 1)</span></pre></body></html>`;

// A "lecture video": big blocks of colour changing every frame (real video moves at a large
// scale; per-pixel noise would average out in the motion detector's coarse grid).
const VIDEO = `<!doctype html><body style="margin:0;background:#000"><canvas id="c" width="8" height="5" style="width:100%;height:100%;image-rendering:pixelated"></canvas>
<script>const c=document.getElementById('c').getContext('2d');(function f(){for(let y=0;y<5;y++)for(let x=0;x<8;x++){c.fillStyle='hsl('+Math.floor(Math.random()*360)+',70%,'+(25+Math.floor(Math.random()*50))+'%)';c.fillRect(x,y,1,1);}requestAnimationFrame(f);})();</script></body>`;

async function overlayPage(displayId) {
  for (let i = 0; i < 50; i++) {
    for (const w of app.windows()) {
      const id = await w.evaluate(() => (window.pw?.role === 'overlay' ? window.pw.displayId : null)).catch(() => null);
      if (id === displayId) return w;
    }
    await sleep(100);
  }
  throw new Error(`no overlay page for ${displayId}`);
}

/** Speak into the engine's mic path (the same route as real microphone chunks). */
async function speak(text) {
  const pcm = speechPcmBase64(text, 0.3);
  await main(app, async (_e, data) => {
    const buf = Buffer.from(data, 'base64');
    const p = globalThis.__pairwise;
    p.session.setMuted(false);
    // Keep the looping fake microphone quiet at the engine so only this question is "heard"
    // (interleaved silent chunks would make it look like there was no sustained speech).
    p.engine.command({ type: 'setMuted', muted: true });
    for (let i = 0; i < buf.length; i += 1280) {
      p.engine.emit('audio', { pcm: new Uint8Array(buf.subarray(i, i + 1280)), seq: i });
      await new Promise((r) => setTimeout(r, 40));
    }
    p.session.setMuted(true);
  }, pcm);
}

try {
  const courseId = await main(app, () => {
    const p = globalThis.__pairwise;
    p.settings.update({ onboardingComplete: true, sounds: false, inkFade: 'manual', autoPauseMedia: 'smart' });
    return p.courses.create({ code: 'COMP 1405', name: 'Intro to CS' }).id;
  });
  const d1 = FAKE_DISPLAYS[0];
  const win = await openTargetWindow(app, { x: d1.bounds.x + 70, y: d1.bounds.y + 90, width: 860, height: 420, html: IDE });
  await openTargetWindow(app, { x: d1.bounds.x + 980, y: d1.bounds.y + 560, width: 400, height: 225, html: VIDEO });
  pointer.move(d1.bounds.x + 600, d1.bounds.y + 700);
  const started = await main(app, (_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, started.error);
  await waitFor(async () => (await snap()).status === 'live', { label: 'live' });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.overlays.allReady()), { label: 'overlays ready' });
  await main(app, () => globalThis.__pairwise.session.setMuted(true));
  const ids = await main(app, () => globalThis.__pairwise.platform.displays.list().map((d) => d.id));
  const hud = await windowByRole(app, 'hud');

  // --- 1. auto-pause the video when the student starts asking -------------------------------
  await waitFor(() => main(app, () => globalThis.__pairwise.engine.videoLikely()), { label: 'video playing detected', timeout: 15_000 });
  const media0 = await main(app, () => globalThis.__pairwise.platform.driver.actions.filter((a) => a.t === 'media').length);
  const ends0 = (await stats()).audioStreamEnds;
  const cc0 = (await stats()).clientContents.length;
  await main(app, () => globalThis.__pairwise.session.command({ type: 'drawToggle' }));
  await waitFor(async () => (await snap()).mediaPausedByUs, { label: 'video paused on ask', timeout: 6000 });
  const media1 = await main(app, () => globalThis.__pairwise.platform.driver.actions.filter((a) => a.t === 'media').length);
  assert.equal(media1 - media0, 1, 'one play/pause media key press');
  await waitFor(async () => (await hud.getAttribute('.hud', 'class')).includes('asking'), { label: 'HUD shows the asking state' });
  await hud.screenshot({ path: join(artifacts, 'p3-hud-asking.png') });

  // --- 2. draw-and-ask: circle "factorial" with real pointer events on the overlay ----------
  const ov = await overlayPage(ids[0]);
  await waitFor(() => ov.evaluate(() => document.body.classList.contains('drawing')), { label: 'overlay in draw mode' });
  const fact = win.els.fact;
  const cx = fact.x + fact.width / 2 - d1.bounds.x;
  const cy = fact.y + fact.height / 2 - d1.bounds.y;
  const rx = fact.width / 2 + 22;
  const ry = fact.height / 2 + 14;
  await ov.mouse.move(cx - rx, cy);
  await ov.mouse.down();
  for (let i = 1; i <= 44; i++) {
    const a = Math.PI + (i / 40) * Math.PI * 2;
    await ov.mouse.move(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  await ov.mouse.up();
  await waitFor(() => main(app, () => globalThis.__pairwise.session.ink.all().some((i) => i.author === 'student')), { label: 'student stroke echoed as ink' });
  await speak('what does this part do?');
  await captureOverlay(app, ids[0], join(artifacts, 'p3-student-circle.png'));
  await screenShot(app, ids[0], join(artifacts, 'p3-student-circle-screen.png'));
  await main(app, () => {
    globalThis.__pairwise.session.mock.queued.push({ segments: [{ say: 'That is the function definition — the name factorial and its parameter n.' }] });
  });
  await ov.keyboard.press('Enter'); // send
  await waitFor(async () => (await stats()).audioStreamEnds > ends0, { label: 'question audio sent with audioStreamEnd', timeout: 8000 });
  const notes = (await stats()).clientContents.slice(cc0);
  const ask = notes.find((c) => JSON.stringify(c).includes('circled'));
  assert.ok(ask, `a note describing the marks (${notes.map((n) => JSON.stringify(n).slice(0, 120)).join(' | ')})`);
  const parts = ask.turns[0].parts;
  const text = parts.find((p) => p.text).text;
  const m = /box \[(\d+), (\d+), (\d+), (\d+)\]/.exec(text);
  assert.ok(m, `the note carries the box (${text})`);
  // The box (0–1000 of the composite frame) maps back onto the circled word.
  const frame = await main(app, () => globalThis.__pairwise.session.sentFrames.filter((f) => f.kind === 'hires').slice(-1)[0]);
  const [ymin, xmin, ymax, xmax] = m.slice(1).map(Number);
  const boxG = { x: frame.region.x + (xmin / 1000) * frame.region.width, y: frame.region.y + (ymin / 1000) * frame.region.height, width: ((xmax - xmin) / 1000) * frame.region.width, height: ((ymax - ymin) / 1000) * frame.region.height };
  assert.ok(inside({ x: fact.x + fact.width / 2, y: fact.y + fact.height / 2 }, boxG), `described box ${JSON.stringify(boxG)} is around the circled word ${JSON.stringify(fact)}`);
  assert.ok(parts.some((p) => p.inlineData?.mimeType?.startsWith('image/')), 'a zoomed crop of the marks is attached');
  assert.ok(ask.turnComplete !== true, 'the note does not end the turn (the spoken question follows)');
  assert.ok(!(await hud.getAttribute('.hud', 'class')).includes('asking'), 'HUD leaves the asking state');
  await waitFor(() => main(app, () => globalThis.__pairwise.session.captions.some((c) => c.speaker === 'tutor' && /function definition/.test(c.text))), { label: 'tutor answers the question', timeout: 15_000 });

  // Resume the video on request (the media tool).
  const rs = await callTool(app, 'media', { action: 'resume' });
  assert.equal(rs.response.ok, true);
  assert.equal((await snap()).mediaPausedByUs, false);
  assert.equal((await main(app, () => globalThis.__pairwise.platform.driver.actions.filter((a) => a.t === 'media').length)) - media1, 1, 'resumed with one more media key press');
  await callTool(app, 'clear_drawings', { who: 'all' });
  await sleep(600);

  // --- 3. step-by-step guidance -------------------------------------------------------------
  await main(app, () => globalThis.__pairwise.platform.hooks.start());
  const sc = await callTool(app, 'show_steps', { title: 'Run your program', steps: ['Click Run', 'Hover Debug to see its shortcut', 'Type your input in the console'] });
  assert.equal(sc.response.steps, 3);
  const card = () => main(app, () => globalThis.__pairwise.session.ui.stepCard);
  assert.deepEqual((await card()).steps.map((s) => s.status), ['active', 'pending', 'pending']);
  // guide_step is non-blocking: kick it off and act like the student.
  await main(app, () => {
    const s = globalThis.__pairwise.session;
    globalThis.__step = s.tools.dispatch({ id: 'g1', name: 'guide_step', args: { step: 1, instruction: 'Click Run', target: 'the "Run" button', expect: 'click', label: 'click Run' } });
  });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.ink.all().some((i) => i.group === 'guide' && i.kind === 'ring')), { label: 'step ring drawn', timeout: 10_000 });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.cursor.currentMode === 'parked'), { label: 'cursor waiting on Run', timeout: 6000 });
  const tip = await main(app, () => globalThis.__pairwise.session.cursor.position);
  assert.ok(inside(tip, win.els.run), `cursor waits on Run (${JSON.stringify(tip)})`);
  assert.equal((await snap()).activity, 'waiting');
  await captureOverlay(app, ids[0], join(artifacts, 'p3-step-waiting.png'));
  await screenShot(app, ids[0], join(artifacts, 'p3-step-waiting-screen.png'));
  // A click somewhere else doesn't count; a click on Run does.
  const hooks = (x, y) => main(app, (_e, p) => globalThis.__pairwise.platform.hooks.emit('mousedown', { x: p.x, y: p.y, time: Date.now(), button: 1 }), { x, y });
  await hooks(win.els.submit.x + 10, win.els.submit.y + 10);
  await sleep(400);
  assert.equal(await main(app, () => globalThis.__pairwise.session.ui.stepCard.steps[0].status), 'active', 'a click elsewhere does not complete the step');
  const run = win.els.run;
  await hooks(run.x + run.width / 2, run.y + run.height / 2);
  const r1 = await main(app, async () => (await globalThis.__step).response);
  assert.equal(r1.done, true, JSON.stringify(r1));
  assert.match(r1.how, /clicked/);
  assert.deepEqual((await card()).steps.map((s) => s.status), ['done', 'active', 'pending']);
  assert.ok(await main(app, () => globalThis.__pairwise.session.ink.all().some((i) => i.kind === 'check')), 'a green check where they clicked');
  // Step 2: hover (the real pointer moves onto Debug).
  await main(app, () => {
    globalThis.__step = globalThis.__pairwise.session.tools.dispatch({ id: 'g2', name: 'guide_step', args: { step: 2, instruction: 'Hover Debug', target: 'the "Debug" button', expect: 'hover', label: 'hover here' } });
  });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.cursor.currentMode === 'parked'), { label: 'cursor waiting on Debug', timeout: 8000 });
  const dbg = win.els.debug;
  pointer.move(dbg.x + dbg.width / 2, dbg.y + dbg.height / 2);
  const r2 = await main(app, async () => (await globalThis.__step).response);
  assert.equal(r2.done, true, JSON.stringify(r2));
  assert.match(r2.how, /hover/);
  // Step 3 can't be observed: the tutor waits for the student to say done.
  const r3 = await callTool(app, 'guide_step', { step: 3, instruction: 'Type your input', expect: 'manual' });
  assert.match(r3.response.waiting_for, /say/);
  assert.deepEqual((await card()).steps.map((s) => s.status), ['done', 'done', 'active']);
  await captureOverlay(app, ids[0], join(artifacts, 'p3-step-card.png'));
  await screenShot(app, ids[0], join(artifacts, 'p3-step-card-screen.png'));
  pointer.move(d1.bounds.x + 600, d1.bounds.y + 700);
  await callTool(app, 'clear_drawings', { who: 'all' });
  await sleep(500);

  // --- 4. a mark asked for mid-sentence appears when that point of the speech is heard ------
  await main(app, () => {
    const s = globalThis.__pairwise.session;
    globalThis.__calls = [];
    const orig = s.tools.dispatch.bind(s.tools);
    s.tools.dispatch = (c) => {
      globalThis.__calls.push({ name: c.name, at: Date.now(), heardUntil: s.clock.timeFor(s.clock.position) });
      return orig(c);
    };
    s.mock.speakNow({
      segments: [
        { say: 'When you are happy with your answer, the button you want is this one up here on the right.' },
        { tool: 'annotate', args: { items: [{ kind: 'circle', target: 'the "Submit" button' }] } },
        { say: 'That sends it to the autograder.' },
      ],
    });
  });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.ink.all().some((i) => i.author === 'tutor' && i.kind === 'circle')), { label: 'circle scheduled', timeout: 15_000 });
  const call = await main(app, () => globalThis.__calls.find((c) => c.name === 'annotate'));
  const circle = await main(app, () => globalThis.__pairwise.session.ink.all().find((i) => i.author === 'tutor' && i.kind === 'circle'));
  assert.ok(call.heardUntil - call.at > 400, `the tool call arrived before its words were heard (${call.heardUntil - call.at} ms ahead)`);
  assert.ok(circle.revealAt >= call.heardUntil - 450, `the circle waits for the speech (reveal ${circle.revealAt - call.at} ms after the call, words heard at +${call.heardUntil - call.at} ms)`);
  assert.ok(circle.revealAt <= call.heardUntil + 2500, 'and is not late either');
  await waitFor(() => main(app, () => !globalThis.__pairwise.session.turn && !globalThis.__pairwise.session.playback.playing), { label: 'turn finished', timeout: 20_000 });
  await callTool(app, 'clear_drawings', { who: 'all' });
  await sleep(500);

  // --- 5. explain_on_screen: marks appear line by line as the script is spoken ----------------
  await main(app, () => {
    const s = globalThis.__pairwise.session;
    globalThis.__words = [];
    s.on('tutorWords', (t) => globalThis.__words.push({ t: Date.now(), text: t }));
    s.mock.afterTool.set('explain_on_screen', (r) => ({ segments: (r.script ?? []).map((say) => ({ say })) }));
    s.mock.speakNow({ segments: [{ tool: 'explain_on_screen', args: { question: 'how does it work?' } }] });
  });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.ink.all().filter((i) => i.author === 'tutor' && i.kind !== 'ring').length >= 3), { label: 'three beats drawn', timeout: 25_000 });
  await waitFor(() => main(app, () => !globalThis.__pairwise.session.turn && !globalThis.__pairwise.session.playback.playing), { label: 'explanation finished', timeout: 25_000 });
  const beats = await main(app, () => {
    const ink = globalThis.__pairwise.session.ink.all().filter((i) => i.author === 'tutor');
    const pick = (k) => ink.find((i) => i.kind === k)?.revealAt;
    return { circle: pick('circle'), underline: pick('underline'), arrow: pick('arrow'), words: globalThis.__words };
  });
  const firstSaid = (re) => beats.words.find((w) => re.test(w.text))?.t;
  const l2 = firstSaid(/\bmark\b|important/);
  const l3 = firstSaid(/connect|next idea/);
  assert.ok(beats.circle && beats.underline && beats.arrow, JSON.stringify(beats));
  assert.ok(beats.circle < beats.underline && beats.underline < beats.arrow, 'beats in order');
  assert.ok(l2 && beats.underline >= l2 - 900, `line 2's mark waits for line 2 (${beats.underline - l2} ms vs its caption)`);
  assert.ok(l3 && beats.arrow >= l3 - 900, `line 3's mark waits for line 3 (${beats.arrow - l3} ms vs its caption)`);
  await screenShot(app, ids[0], join(artifacts, 'p3-explain-screen.png'));

  // --- 6. the ink preview (Setup & checks → Preview): every kind of mark, drawn by the pen ----
  await callTool(app, 'clear_drawings', { who: 'all' });
  await main(app, () => { for (const w of globalThis.__targets ?? []) w.hide(); });
  await sleep(900);
  await main(app, () => globalThis.__pairwise.session.previewInk());
  await sleep(2600);
  await captureOverlay(app, ids[0], join(artifacts, 'p3-preview-mid-overlay.png'));
  await screenShot(app, ids[0], join(artifacts, 'p3-preview-mid.png'));
  await waitFor(() => main(app, () => globalThis.__pairwise.session.cursor.currentMode !== 'timeline'), { label: 'preview drawn', timeout: 20_000 });
  await sleep(400);
  await screenShot(app, ids[0], join(artifacts, 'p3-preview.png'));
  const kinds = await main(app, () => [...new Set(globalThis.__pairwise.session.ink.all().filter((i) => i.group === 'preview').map((i) => i.kind))]);
  for (const k of ['circle', 'underline', 'highlight', 'arrow', 'text', 'box', 'step', 'check']) assert.ok(kinds.includes(k), `preview draws a ${k} (${kinds.join(',')})`);

  console.log('phase 3 ask/steps/choreography e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
