# Progress

Legend: ✅ verified end-to-end here (Linux + Xvfb, fake platform, mock Gemini) · 🍎 needs a check
on a real Mac (see BLOCKERS.md B-5) · ⏳ not done yet

## Phase 1 — app shell ✅
| Feature | Status | How it was checked |
|---|---|---|
| Menu-bar app with course list, live timer in title, quick controls | ✅ 🍎 | tray menu built from state; macOS title rendering needs a Mac |
| Course picker (add/edit/delete, color, term, folder link, quick-add) | ✅ | `test/e2e/01-shell.e2e.mjs` drives the UI |
| Start / end session, session timer | ✅ | e2e: status → live, HUD timer ticks, End button, course session count |
| Global hotkeys (start/end, mute, …) | ✅ 🍎 | e2e emits hotkey actions; real key capture needs Accessibility on a Mac |
| Transparent click-through overlay on every display | ✅ 🍎 | e2e: two virtual displays → one overlay each at exact bounds, on top, non-focusable |
| Permissions onboarding (Screen Recording, Mic, Accessibility) | ✅ 🍎 | UI + live polling verified with the fake platform; real TCC states need a Mac |
| Rapid start→end without crashing | ✅ | found a Chromium crash in e2e; fixed with load-aware window teardown (D-010) |

Unit tests: geometry (multi-display, negative origins, HiDPI, crops), shortcuts, settings merge,
dated pricing — `npm test`.

## Phase 2 — screen capture + realtime voice ✅
Checked by `test/e2e/02-voice.e2e.mjs` (real app, local Live mock speaking the documented wire
protocol, Chromium fake microphone playing a recorded student question) and
`test/integration/live.test.ts`.

| Feature | Status | How it was checked |
|---|---|---|
| Live setup per Gemini docs (3.8 Live: no thinkingConfig, transcriptions, compression, VAD config, tools) | ✅ | e2e asserts the setup message the server received |
| Tutor voice plays gaplessly; live captions for both sides | ✅ | greeting caption + playback reported by the engine; HUD captions screenshot |
| Microphone → Live in hands-free mode (echo-cancelled, 16 kHz PCM) | ✅ 🍎 | fake mic WAV reaches the server, server VAD fires, student transcript arrives |
| Barge-in: the student cuts the tutor off mid-sentence | ✅ | speech injected while the tutor talks → server `interrupted` → local buffer flushed in ~240 ms, caption ends with "—" |
| Push-to-talk: audio only while the ask chord is held | ✅ | no chunks while released, ≥20 while held, `audioStreamEnd` on release when speech was heard |
| Change-driven frames, ≤ 1 fps | ✅ | ≤ 6 frames in 5 s while the HUD timer changes the screen |
| Full-detail frame the moment a question starts | ✅ | a `hires` frame goes out on ask |
| Multiple monitors | ✅ | frames map to the display under the pointer; pointer to display 2 → tutor watches display 2 and is told so; back again |
| HiDPI | ✅ 🍎 | display-2 crop is taken at full source resolution; 2× path checked again in the phase-3 accuracy test |
| Context notes never cut the tutor off | ✅ | notes are queued until the tutor isn't generating (`clientContent` cancels a reply in progress) |
| ~10-minute connection limit: GoAway → resume with the session handle | ✅ | e2e forces GoAway; reconnects in ~15 ms with the latest handle |

Found and fixed while testing: tool responses carried an undocumented top-level `scheduling`
field (now only inside `response`, as documented); a reconnect counter race; Chromium's cached
pointer position goes stale under X11 (pointer now read through XTest on Linux).

## Phase 3 — AI cursor, annotations, student drawing, step guidance ✅
Checked by `test/e2e/03-pointing.e2e.mjs` (run at 1× and forced 2×), `04-ask-steps.e2e.mjs`,
`05-calibration.e2e.mjs` (1× and 2×) and unit tests for the beat sync, speech clock, marks,
control snapping, OCR matching, circle geometry, cursor modes and calibration scoring. Pointing
accuracy is measured against the pixels of real windows: OCR stands in for Gemini so the result
is deterministic (D-014, D-019).

| Feature | Status | How it was checked |
|---|---|---|
| Labeled cursor (name pill) that follows you, glides to targets on an arc, parks, flies home *(round 2: it stays where she leaves it instead — see Round 2)* | ✅ | e2e reads the cursor tip from the engine *and* from the overlay's DOM; unit tests for flight → park → return, and a new flight during the flight home (bug found + fixed) |
| `point_at` lands on the real UI | ✅ | tip inside the button every run: 1× and 2× (0–19 px from centre; wide buttons are pointed at near their start) |
| Circles enclose the target, underlines sit under the word | ✅ | rendered ink *pixels* measured: circle margins 9–16 px on every side, underline within 0–7 px of the word's ends, at 1× and 2× |
| Labels snap to the control ("the Submit button" → the button, not its text) | ✅ | grounded box = the button's rect ±1 px; unit-tested on synthetic outlined, filled and plain-text cases |
| Second display | ✅ | `point_at … display: 2` lands inside the button on display 2 |
| On-device pointing test (Setup & checks → Pointing accuracy) | ✅ 🍎 | 18/18 hit, mean error ≤ 1.1 px with OCR at 1× and 2×; with Gemini run `npm run eval:grounding` or the button on your Mac |
| Ink timed to speech | ✅ | a mark requested mid-sentence is revealed when that point of the audio is heard, not when the call arrives (e2e measures both) |
| `explain_on_screen`: lines + marks, each mark when its line is spoken | ✅ | e2e: three beats revealed in order, each after its line's first words were captioned |
| Every mark kind: circle, underline, highlight, box, arrow + note, text, step badge, check, cross | ✅ | ink preview e2e + screenshot review |
| Student draw-and-ask (hold ⌃⌥ or ⌃⌥D) → ONE question | ✅ | real pointer events on the overlay: composite frame, "circled the area at box […]" (box verified to map back onto the circled word), zoomed crop, buffered speech + `audioStreamEnd`, tutor answers |
| Auto-pause media when the student asks; resume on request | ✅ 🍎 | a moving "video" window is detected, one media key press on ask, one on `media resume`; Music/Spotify/Safari/Chrome AppleScript paths need a Mac |
| Step-by-step: checklist card, point → wait → detect → ✓ → next | ✅ | click elsewhere doesn't count, click on Run does; hover step via the real pointer; manual step waits for "done"; HUD shows "waiting for you" |
| HUD "asking" state | ✅ | orange pulse + "listening to your question" while the ask chord / draw mode is active |

Found and fixed while testing: the cursor snapped back to following the student when a new
flight replaced its flight home; OCR merged duplicate words badly across passes (now median of
every pass); our own step card and check marks were "found" as targets where captures include
overlays (overlays now report their UI rectangles, and the check badge sits on the target's
corner); the hub window covered the student's work after starting a session (it now steps
aside, D-016); the system prompt still named two tools that had been replaced by `guide_step`.

## Phase 4 — course brain ✅
Checked by `test/e2e/06-course.e2e.mjs` against a generated course folder that has every
supported file type (`test/fixtures/make-course.mjs`), and `test/unit/course-brain.test.ts`
(extraction per format, citations, chunking, tokenizer/BM25, incremental re-indexing, hybrid
search and the Gemini profile with a stand-in REST client).

| Feature | Status | How it was checked |
|---|---|---|
| Folder per course, read locally: PDF (slides or documents), PPTX (+ speaker notes), DOCX (by heading), Markdown/TXT/TeX, VTT/SRT transcripts, code, notebooks | ✅ | 9/9 fixture files → 21 passages in ~0.5 s; hidden folders and unsupported files skipped; scanned PDFs reported as "no text layer" |
| Citations the student can look up | ✅ | "Lecture 05 - Recursion, slide 2", "… at 12:30", "Course Outline — Not covered in this course", "factorial.py, lines 1–7" |
| `search_course` uses the course's own terms | ✅ | "what is the base case called in this course" → the slide that says "stopping case", first |
| `cite` shows the source on screen and on the caption | ✅ | citation card + chip under the tutor's caption (screenshots reviewed) |
| Out of scope | ✅ | unrelated queries return no passages and tell the tutor to say so / `flag_out_of_scope`; badge on screen ("Inheritance (usually COMP 1406)") |
| Course profile in the prompt | ✅ 🍎 | heuristic profile verified (topics in lecture order, Python convention, glossary); Gemini profile verified with a stand-in client — real output needs your key |
| Hybrid search with embeddings | ✅ 🍎 | fusion and "embed once, reuse on re-index" verified with a stand-in client |
| Incremental re-index at every session start | ✅ | editing one file re-reads only it; untouched passages keep their ids |
| Assignment mode | ✅ | spec suggested by name; starting with it puts the integrity rules in the prompt and the spec first in searches |
| `think_deeply` | ✅ 🍎 | returns WHEN_IDLE with course passages attached; the reasoning model itself needs your key |
| Hub: what the tutor knows + try a search | ✅ | profile card, topics/terms chips, search box showing cited hits |

## Phase 5 — takeover with consent and instant reclaim ✅
Checked by `test/e2e/07-takeover.e2e.mjs` (a recording input driver captures every synthetic
move/click/key; fake global hooks stand in for the student's own hand) and
`test/unit/takeover.test.ts` (risky-action rules, synthetic-event filter, spoken yes/no).

| Feature | Status | How it was checked |
|---|---|---|
| Per-moment consent: card with "Let it drive" / "Not now", ⌃⌥G, or saying yes/no; expires in 20 s | ✅ | all four paths; "Not now" and "no, let me try it myself" send nothing; `control` without consent is refused |
| Big "Ada is driving" indicator | ✅ | glowing frame on every display, banner, orange buddy riding the real pointer, HUD chip with Esc (screenshots reviewed) |
| Actions land on the real UI, visibly | ✅ 🍎 | click glides in ≥4 steps and lands inside the grounded button; real CGEvent input needs a Mac (B-5) |
| Any real mouse move / click / scroll / key, or Esc, reclaims instantly | ✅ 🍎 | reclaimed inside the same event; our own synthetic moves are ignored; typing stopped mid-word (buttons released); tutor told to stop |
| Never submit / send / delete / run without asking | ✅ | risky actions (Submit, Send, Delete, Run, ⌘Return, Return after a shell command, ⌘Q…) need their own yes every time: pointer on the target, red ring, card placed away from it; "Cancel" → nothing clicked |
| Assignment mode: no typing or pasting into their work | ✅ | refused with an explanation for the tutor |
| Idle auto-revoke, release_control, "turned off in Settings" | ✅ | revoked after the configured idle time; refusal is polite and explains |

## Phase 6 — App Veil, whiteboard, notes, QoL, polish ✅
Checked by `test/e2e/08-veil.e2e.mjs`, `09-whiteboard.e2e.mjs`, `10-notes.e2e.mjs`, and unit
tests for veil geometry and diagram layouts. QoL pieces built in Phase 1 (shortcut editor,
onboarding, usage meter + cap, settings for voice/speed/depth, celebrations) are exercised by
`01-shell` and the later suites.

| Feature | Status | How it was checked |
|---|---|---|
| App Veil: veiled apps blacked out before frames leave | ✅ 🍎 | the frames the Live server actually received are decoded: the Messages window is black, the window in front of it stays visible (z-order), elsewhere untouched; grounding captures veiled too; follows a moved window; notification banners veiled; un-veiling takes effect at once. Real window detection (get-windows) needs a Mac |
| "Hidden from Ada · Messages" outline + "can see this screen" pill | ✅ | screenshots reviewed |
| Whiteboard: tutor's pen draws diagrams in teaching order | ✅ | the cursor is inside the board for >85 % of the drawing time; tree/flow/list/array/graph/boxes layouts stay on the board without overlaps (unit) |
| Student draws / erases on the board; toggle keeps the ink; clear | ✅ | real pointer events on the board window |
| Session notes in the course folder | ✅ 🍎 | `Pairwise notes/2026-10-20 13.40 Why does factorial need an if statement.md` with summary, key ideas, definitions, to review, sources, the diagram image and a condensed transcript; ending took < 4 s (notes written in the background); the notes folder is not indexed as course material; Gemini-written notes need your key |
| "Say that again" with the ink | ✅ | audio replays and the marks are redrawn at their point in the speech, not all at once |
| Resumable sessions | ✅ | "Pick up where we left off" sends last time's summary and to-review list in the opening turn |
| Quitting mid-session | ✅ | the session is ended properly first (notes + resume state) |
| Polish | ✅ | hub, HUD, overlays, whiteboard and cards reviewed from screenshots at 1× and 2×; HUD asking/driving states, citation card, consent cards placed away from what they ask about |

## Round 2 — feedback from the first real use on a Mac ✅
The owner's six requests (HANDOFF.md, verbatim) and how each was checked. Decisions: D-028 to
D-036. Everything below runs on Linux/Xvfb with the fake platform and the Live mock; 🍎 = also
worth a look on the Mac (BLOCKERS.md B-5, B-8).

| Request | Status | How it was checked |
|---|---|---|
| **1. Ada's cursor stays where she leaves it, dims when idle** | ✅ 🍎 | unit: stays put while the student's mouse wanders for 10 s, never flies home; presence active → idle (1.2 s) → near (pointer within 60 px) → active the moment it moves; label held while she's still talking; takeover parks at the last driven spot; mid-move positions are right (a bug found here, fixed). e2e 03 (1×, 2×): after pointing, the real pointer moves around and the cursor doesn't; the overlay DOM shows it at 35 % with no label, 12 % when the pointer comes close (screenshots `p3-*-cursor-idle/near-screen.png`) |
| **2. Tuple's drawing: flat brush, dots, font, highlight click** | ✅ | unit (`ink.test.ts`, with a recording canvas): a click is a dot of the brush's diameter, every mark is stroked at one width with round caps/joins and no glow, highlights are one flat band, midpoint smoothing stays within ±1 px of the polyline (5 mark kinds × 39 seeds), the ring starts as a dot and thins 6 → 3 px over two pulses then disappears, typed notes reveal exactly the planned characters at 45–110 ms per key (slower after spaces and punctuation), widths match Chromium's measurements of Inter 600 and Caveat 700. e2e 03: circles still enclose the button and underlines sit under the word, measured on rendered pixels at 1× and 2×; screenshots reviewed (`p3-preview.png`) |
| **3. A quiet, Tuple-like screen** | ✅ 🍎 | e2e 11: an idle session shows the session pill (252 px, 62 % opacity, collapsed, only mic / eye / End as buttons) and Ada's dimmed cursor, and *nothing else* on either display; hover opens it with all the controls; dragging remembers the spot per display; no toast for mute or talk mode; the step card is one line that opens when the step changes and fades to 15 % when the real pointer comes near; a citation is a chip that hides itself; captions are one line that fades ~4 s after Ada stops; hiding the pill leaves a tiny "can see" eye. Before/after screenshots: `docs/screenshots/declutter-before.png`, `idle-session.png` |
| **4. Slower, human, varied pen** | ✅ | unit: 20 circles all differ yet all clear the target (both directions occur); 20 arrows differ in bow (3.5–12.5 % of length), head angle and size, with one- and two-stroke heads; underlines vary but stay under the word; a circle takes 1.2–1.45× round 1's time; the pen starts and ends each stroke slowly (minimum jerk) and is slower at a box's corners than along its sides; an arrow's head comes after an 80–200 ms pen lift during which nothing is drawn. Existing circle-enclosure tests kept. A review sheet of marks with 6 seeds each was checked by eye |
| **5. The cursor as a pointer (no ink, no label)** | ✅ 🍎 | unit (`gestures.test.ts`): follow_line runs under the line at ~190 px/s, sweep stops on each line left of the text, hover rests below-right of the label, beats keep the order of gestures and marks and only marks become ink, the cursor visits the line left to right over time. e2e 12 (1×, 2×): grounded on a real line by OCR, the cursor (main *and* the drawn overlay) glides under "def factorial(n):" from start to end in ~1.5 s, rests on all four lines of the function in a sweep, hovers on Run; no ink, ring or label at any point. e2e 04: an explanation's first two lines sweep and follow (no ink), its last two lines draw, each when its words are heard |
| **6. A real Mac app (Dock)** | ✅ 🍎 | `npm run app` (scripts/build-app.mjs) builds, packages for the Mac's chip, signs ad hoc, installs into /Applications (or ~/Applications) and opens it; unit test pins the steps and their order from `--dry-run`. `electron-builder --mac dir --arm64 -c.mac.identity=null` run here: `Pairwise.app` with an arm64 executable, `icon.icns`, no `LSUIElement`, mic/Apple-events usage strings, and darwin-arm64 natives unpacked (uiohook, robotjs, universal get-windows). Dock menu + app menu built in main; a key saved by `npm run dev` is reported as unreadable and asked for again (unit test with a stand-in keychain). Signing and launching need the Mac (B-8) |

Also found and fixed this round: the OCR grounder's parallel tesseract passes stalled on a
4-core machine (D-028); the cursor engine reported the start of the *next* move while still
moving (main and overlay); the test harness's screen captures sometimes contained a stale copy
of the overlay.

## After round 2 — polish
| Feature | Status | How it was checked |
|---|---|---|
| **"Show me" questions** (`ask_to_point`, D-040) | ✅ 🍎 | unit (`quiz.test.ts`): a click on the answer counts (with slack for small targets), a wrong one reports how far off, the click is composited as a ring into the frame Ada gets. e2e 15 with real OS clicks: every display takes the answer with the question on screen and a target cursor, Ada waits, the right line counts as on target and is marked with the student's ring, a wrong click is 192 px off, a click on Run doesn't press Run (and the next normal click does), Esc skips and the screen goes back to normal; the session notes get a "Quick checks" list (✓, ✗, skipped, with tries) and a missed or skipped one goes to "To review" for next time |
| **Riding out a dropped connection** (D-042) | ✅ 🍎 | integration (`live.test.ts`) against the Live mock: the server goes away for 1.6 s and comes back — the link keeps trying, resumes the same conversation (same handle) and reports how long it was gone; while "offline" it makes no attempts at all and reconnects as soon as it's back online; it gives up only after its time limit. A connection that can't open now fails in ~0.25 s instead of 15 s (a bug found here). Real Wi-Fi drops are worth a try on the Mac |
| **Light on the battery** (D-038) | ✅ 🍎 | per-process CPU of an idle session measured under Xvfb: ~41 % → ~22 % of one core still, ~47 % → ~25 % with the mouse moving (overlays 4.5 % → 0.1 % each). e2e 11: an idle overlay asks for 0 animation frames in 2 s (it drew 120). The full suite passes with the changes (17/17); worth a look in Activity Monitor on the Mac |
| **Reduce motion** (D-039) | ✅ 🍎 | unit (`motion.test.ts`): straight flights ≤ 0.26 s, a still ring that doesn't keep waking the overlay, badges without pop or ripple, celebrations without confetti. e2e 14 (forced on): the overlay is in reduced-motion mode, pointing is one straight 260 ms move that still lands on the button, a celebration is only the word (58×19 px of colour) |
| **Trace code like a debugger** (`trace_code`): the cursor steps through the lines as they run, value chips appear after each line and update in place | ✅ 🍎 | unit (`trace.test.ts`): chip placement just after the line's end, centred, sized from the line, kept on screen; typed onto a growing pill in white monospace; a newer value on the same line replaces the old chip (fast fade) and only that one; where a line really ends, found from pixels (tight, short and long boxes, aligned comments, a neighbour's ascenders, our own cursor); the planner's trace mode (medium thinking, ≤ 10 steps, empty values dropped). e2e 13 (1×, 2×): a five-step trace of `factorial(2)` grounded on real code: one chip per step on the right line, 9–11 px after the text, drawn where planned (rendered pixels), `n = 2` → `n = 1` in place, every value typed by the cursor after its words are heard, the cursor skims each line first unless the speech has moved on, and the last value is done before Ada stops talking. Real Gemini traces need your key |

## Final verification
The full run on 2026-10-21 (round 2) started from a clean build, with out/ and dist/ removed.

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ no errors |
| `npm test` (vitest) | ✅ 16 files, **128/128** tests |
| `npm run test:e2e` | ✅ **15/15** runs: 01-shell, 02-voice, 03-pointing at 1× and 2×, 04-ask-steps, 05-calibration at 1× and 2×, 06-course, 07-takeover, 08-veil, 09-whiteboard, 10-notes, 11-declutter, 12-gestures at 1× and 2× |
| Pointing, 03 (1× / 2×) | tip inside the button every time (0–19 px from centre; wide buttons are pointed at near their start); circles clear the button by 10–19 px; underlines overhang the word by 4–13 px |
| Pointing accuracy, 1× run (OCR grounder) | Built-in @1×: 8/9 (one small label, "Opal", not read by Tesseract). Studio Display @2×: 9/9. Every target that was found was hit; mean error 1.2 px |
| Pointing accuracy, 2× run (OCR grounder) | Built-in Retina @2×: 9/9. Studio Display @2×: 9/9. Mean error 0.1 px, worst 0.6 px |
| Gestures, 12 (1× / 2×) | followed 211 of 225 px of a line in 1.5 s (2×: 131 of 143 px in 1.0 s), left to right; swept all four lines; hovered Run; no ink, ring or label |
| Packaged app | `electron-builder --mac dir --arm64 -c.mac.identity=null` (what `npm run app` runs before signing): arm64 `Pairwise.app`, `icon.icns`, no `LSUIElement`, usage strings, darwin-arm64 natives unpacked. Signing, installing and launching need the Mac (B-8) |

Not verifiable from the sandbox: everything marked 🍎, as listed in BLOCKERS.md B-5 and B-8.
