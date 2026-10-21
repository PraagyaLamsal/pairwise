// Phase 2: screen capture + realtime voice. Runs the real app against the local Live mock
// (same wire protocol), with a fake microphone that plays a recorded student question.
import { join } from 'node:path';
import { launch, main, windowByRole, waitFor, sleep, artifacts, assert, FAKE_DISPLAYS, pointer } from './harness.mjs';
import { studentMicWav, speechPcmBase64 } from './audio-fixtures.mjs';

const mic = studentMicWav('Why does my recursive function never stop?', 3.5, 14);
const { app } = await launch({ PAIRWISE_FAKE_MIC_WAV: mic.file });
const stats = () => main(app, () => {
  const s = globalThis.__pairwise.session.mock?.stats;
  return s ? { ...s, setups: s.setups.length, clientContents: s.clientContents.length, toolResponses: s.toolResponses.length, texts: s.texts.length } : null;
});
const snap = () => main(app, () => globalThis.__pairwise.session.snapshot);
const transcript = () => main(app, () => globalThis.__pairwise.session.transcript());

/** Stream 16 kHz PCM into the live link as if it came from the microphone, in real time. */
async function injectSpeech(text) {
  const b64 = speechPcmBase64(text);
  await main(app, async (_e, data) => {
    const buf = Buffer.from(data, 'base64');
    const link = globalThis.__pairwise.session.link;
    for (let i = 0; i < buf.length; i += 1280) {
      link.sendAudio(new Uint8Array(buf.subarray(i, i + 1280)));
      await new Promise((r) => setTimeout(r, 38));
    }
  }, b64);
}

try {
  // Skip onboarding and add a course directly.
  const courseId = await main(app, () => {
    const p = globalThis.__pairwise;
    // Captions are off by default since round 2; this test looks at them.
    p.settings.update({ onboardingComplete: true, sounds: true, captions: true });
    return p.courses.create({ code: 'COMP 1405', name: 'Introduction to Computer Science I', term: 'Fall 2026' }).id;
  });
  const started = await main(app, (_e, id) => globalThis.__pairwise.session.start({ courseId: id }), courseId);
  assert.ok(started.ok, `session started (${started.error ?? ''})`);
  await waitFor(async () => (await snap()).status === 'live', { label: 'live' });
  const s0 = await snap();
  assert.equal(s0.demo, true, 'no key → demo tutor over the mock Live server');

  // --- setup message ---------------------------------------------------------------
  const setup = await main(app, () => globalThis.__pairwise.session.mock.stats.setups[0]);
  assert.match(setup.model, /^models\//);
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.ok(!('thinkingConfig' in setup.generationConfig), 'gemini-3.8-live: thinkingConfig omitted');
  assert.match(setup.systemInstruction.parts[0].text, /COMP 1405/);
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
  assert.ok(setup.contextWindowCompression?.slidingWindow, 'context window compression on (no 2-minute A/V cap)');
  assert.equal(setup.realtimeInputConfig.activityHandling, 'START_OF_ACTIVITY_INTERRUPTS');

  // --- greeting: tutor audio is played and captioned ----------------------------------
  await waitFor(async () => (await transcript()).some((c) => c.speaker === 'tutor' && /I'm Ada/.test(c.text)), { label: 'greeting caption', timeout: 20_000 });
  const sawPlayback = await waitFor(() => main(app, () => globalThis.__pairwise.session.playback.queuedSamples > 0 || globalThis.__pairwise.session.playback.playing), { label: 'tutor audio reached the speaker', timeout: 10_000 });
  assert.ok(sawPlayback);

  // --- microphone → Live (hands-free) ------------------------------------------------
  await waitFor(async () => (await stats()).audioChunks > 40, { label: 'mic audio streaming', timeout: 15_000 });
  // The fake mic says its question → server VAD → the student caption + a reply.
  await waitFor(async () => (await transcript()).some((c) => c.speaker === 'student' && c.text.length > 3), { label: 'student heard', timeout: 30_000 });

  // --- screen frames: change-driven, ≤ 1 fps, mapped to the active display --------------
  await waitFor(async () => (await stats()).videoFrames > 0, { label: 'frames sent', timeout: 15_000 });
  const f0 = (await stats()).videoFrames;
  await sleep(5000);
  const f1 = (await stats()).videoFrames;
  assert.ok(f1 - f0 <= 6, `frame rate ≤ 1 fps (${f1 - f0} in 5 s)`);
  const ref = await main(app, () => globalThis.__pairwise.session.modelFrame);
  const active = await main(app, () => globalThis.__pairwise.session.activeDisplay());
  assert.deepEqual(ref.region, active.bounds, 'frame covers exactly the active display');

  // --- multi-display + HiDPI: a full-detail frame of the Retina display ---------------
  const d2 = await main(app, () => globalThis.__pairwise.platform.displays.list().find((d) => d.scaleFactor === 2));
  const hires = await main(app, async (_e, id) => {
    const s = globalThis.__pairwise.session;
    const r = await s.deps.engine.request({ type: 'captureNow', requestId: s.deps.engine.nextRequestId('t'), displayId: id, maxWidth: 4096, quality: 0.8, kind: 'hires' });
    return r.frame ? { ref: r.frame.ref, bytes: r.frame.data.length } : null;
  }, d2.id);
  assert.ok(hires, 'captured the second display');
  assert.deepEqual(hires.ref.region, d2.bounds);
  // Full detail = every physical pixel the capture source has for this display. (Under Xvfb the
  // real screen is 1×; the HiDPI path is covered at 2× by the coordinate-accuracy e2e.)
  const realScale = await main(app, ({ screen }) => screen.getPrimaryDisplay().scaleFactor);
  assert.equal(hires.ref.pixelWidth, Math.round(d2.bounds.width * realScale), 'full-resolution crop of display 2');
  assert.equal(hires.ref.pixelHeight, Math.round(d2.bounds.height * realScale));

  // Moving the pointer to the other display switches what the tutor watches.
  pointer.move(FAKE_DISPLAYS[1].bounds.x + 300, 300);
  await waitFor(async () => (await snap()).visibleDisplayId === d2.id, { label: 'tutor follows pointer to display 2', timeout: 5000 });
  await waitFor(async () => (await stats()).clientContents >= 2, { label: 'display switch noted to the tutor', timeout: 8000 });
  pointer.move(600, 400);
  await waitFor(async () => (await snap()).visibleDisplayId !== d2.id, { label: 'and back to display 1', timeout: 5000 });

  // --- barge-in: the student talks over the tutor --------------------------------------
  await main(app, () => globalThis.__pairwise.session.setMuted(true)); // keep the looping fake mic out of it
  await sleep(600);
  await main(app, () => {
    const s = globalThis.__pairwise.session;
    s.mock.queued.push({ segments: [{ say: 'Recursion means a function calls itself on a smaller version of the same problem, and every recursive function needs a base case that stops it, otherwise it keeps calling itself forever until the stack overflows.' }] });
    s.command({ type: 'sendText', text: 'explain recursion' });
  });
  await waitFor(() => main(app, () => globalThis.__pairwise.session.playback.playing), { label: 'tutor is talking', timeout: 15_000 });
  await sleep(700);
  const flushedBefore = await main(app, () => globalThis.__pairwise.session.playback.epoch);
  const t0 = Date.now();
  const barge = injectSpeech('wait, what is a base case?');
  await waitFor(() => main(app, () => !globalThis.__pairwise.session.playback.playing), { label: 'tutor stopped talking', timeout: 6000 });
  const stopMs = Date.now() - t0;
  const epochAfter = await main(app, () => globalThis.__pairwise.session.playback.epoch);
  assert.ok(epochAfter > flushedBefore, 'playback buffer flushed');
  const cut = (await transcript()).filter((c) => c.speaker === 'tutor').pop();
  assert.match(cut.text, /—$/, 'interrupted caption ends with a dash');
  console.log(`barge-in: tutor stopped ${stopMs} ms after the student started talking`);
  await barge; // the rest of the injected question (and its trailing silence) has gone out
  await sleep(1500);

  // --- push-to-talk: audio flows only while the ask chord is held ----------------------
  await main(app, () => globalThis.__pairwise.session.setMuted(false));
  await main(app, () => globalThis.__pairwise.session.command({ type: 'toggleTalkMode' }));
  assert.equal((await snap()).talkMode, 'push-to-talk');
  await sleep(500);
  const a0 = (await stats()).audioChunks;
  await sleep(1500);
  const a1 = (await stats()).audioChunks;
  assert.ok(a1 - a0 <= 2, `no audio while not holding (${a1 - a0} chunks)`);
  const ends0 = (await stats()).audioStreamEnds;
  const framesBefore = (await stats()).videoFrames;
  await main(app, () => globalThis.__pairwise.session.setMuted(true)); // only the injected question below
  await main(app, () => globalThis.__pairwise.session.command({ type: 'pttDown' }));
  // Speak into the engine's mic path while holding (same route as real microphone chunks).
  const q = speechPcmBase64('how do I fix this error?', 0.3);
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
  }, q);
  const a2 = (await stats()).audioChunks;
  assert.ok(a2 - a1 <= 2, `the question is held back while the keys are down (${a2 - a1} chunks reached the server)`);
  const kinds = await main(app, (_e, n) => globalThis.__pairwise.session.sentFrames.slice(-n).map((f) => f.kind), 4);
  assert.ok(kinds.includes('hires'), `a full-detail frame goes out when the question starts (${kinds.join(',')})`);
  assert.ok((await stats()).videoFrames > framesBefore);
  await main(app, () => globalThis.__pairwise.session.command({ type: 'pttUp' }));
  await waitFor(async () => (await stats()).audioStreamEnds > ends0, { label: 'question sent on release', timeout: 8000 });
  const a3 = (await stats()).audioChunks;
  assert.ok(a3 - a2 >= 20, `released → the whole question arrives at once (${a3 - a2} chunks)`);
  console.log(`push-to-talk: 0 chunks while held, ${a3 - a2} sent on release + audioStreamEnd`);
  await main(app, () => globalThis.__pairwise.session.setMuted(false));
  await main(app, () => globalThis.__pairwise.session.command({ type: 'toggleTalkMode' }));

  // --- HUD: captions + levels -----------------------------------------------------------
  const hud = await windowByRole(app, 'hud');
  await hud.waitForSelector('.captions .cap.tutor', { timeout: 10_000 });
  await hud.screenshot({ path: join(artifacts, 'p2-hud-captions.png') });

  // --- reconnect: GoAway → resume with the latest handle --------------------------------
  await main(app, () => globalThis.__pairwise.session.mock.goAwayAll());
  await waitFor(async () => (await snap()).status === 'reconnecting' || (await snap()).reconnects > 0, { label: 'reconnecting', timeout: 8000 });
  await waitFor(async () => (await snap()).status === 'live', { label: 'live again', timeout: 15_000 });
  const second = await main(app, () => globalThis.__pairwise.session.mock.stats.setups[1]);
  assert.match(second.sessionResumption?.handle ?? '', /^mock-handle-/, 'resumed with the session handle');

  // --- end ------------------------------------------------------------------------------
  await main(app, () => globalThis.__pairwise.session.end());
  await waitFor(async () => (await snap()).status === 'idle', { label: 'ended' });
  console.log('phase 2 e2e: all checks passed');
} finally {
  await app.close().catch(() => undefined);
}
