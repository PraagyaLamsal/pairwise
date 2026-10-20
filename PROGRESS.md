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
| Labeled cursor (name pill) that follows you, glides to targets on an arc, parks, flies home | ✅ | e2e reads the cursor tip from the engine *and* from the overlay's DOM; unit tests for flight → park → return, and a new flight during the flight home (bug found + fixed) |
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

## Final verification
The full run on 2026-10-20 started from a clean build, with dist/ and debug output removed.

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ no errors |
| `npm test` (vitest) | ✅ 12 files, **96/96** tests |
| `npm run test:e2e` | ✅ **12/12** runs: 01-shell, 02-voice, 03-pointing at 1× and 2×, 04-ask-steps, 05-calibration at 1× and 2×, 06-course, 07-takeover, 08-veil, 09-whiteboard, 10-notes |
| Pointing accuracy, 1× run (OCR grounder) | Built-in @1×: 9/9. Studio Display @2×: 9/9. Mean error 0.2 px. 0 found off target |
| Pointing accuracy, 2× run (OCR grounder) | Built-in Retina @2×: 9/9. Studio Display @2×: 8/9 (one label not read by Tesseract). Mean error 0.0 px. 0 found off target |
| Packaged app | The `dist:mac` build was made earlier this phase (arm64 `.app`, Info.plist and usage strings checked). Packaged Linux smoke test: indexing, a live session and search all worked |

Not verifiable from the sandbox: everything marked 🍎, as listed in BLOCKERS.md B-5.
