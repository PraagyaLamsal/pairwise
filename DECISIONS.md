# Decisions

Decisions made without asking (as requested), newest last. Each has the reason and what it
would take to change it.

### D-001 · Name: **Pairwise**, tutor **Ada**
`[APP NAME]` was open. "Pairwise" = pair programming + peer-to-AI; the tutor's default name is Ada
(Lovelace). Both live in `src/shared/app-info.ts` (+ `productName` in package.json); the tutor
name is also a setting.

### D-002 · Stack: Electron 44 + TypeScript + Vite + React, prebuilt native modules
See PLAN.md §1. Main reason: this project was built in a Linux sandbox, and Electron let every
phase run end-to-end here (Xvfb + Playwright + mock Gemini) with screenshot-reviewed visuals.
Native pieces use **prebuilt N-API** packages (`uiohook-napi`, `@jitsi/robotjs`, `get-windows`)
so nothing compiles on your Mac. Cost: ~150 MB app and higher idle memory than a Swift app.
Everything OS-specific is behind `src/main/platform/`, so a Windows build only needs that folder.

### D-003 · Gemini models (verified on ai.google.dev, 2026-10-19)
* Live: `gemini-3.8-live` (stable, async function calling, proactive audio, output/input
  transcription). Optional `gemini-3.8-live-extended-thinking` behind a setting.
* Pointing / reading small text: `gemini-3.8-flash`, `thinkingLevel: "low"` (minimal is not
  supported on 3.8 Flash).
* Deep reasoning & drawing plans: `gemini-4-argon` (thinking can't be disabled; medium default).
* Notes / course profile: `gemini-3.8-flash`. Embeddings: `gemini-embedding-001`.
All ids are settings, defaults in `app-info.ts`.

### D-004 · REST `generateContent` instead of the new Interactions API
Google labels generateContent "legacy" but "fully supported". The Interactions API *stores*
interactions by default; we send screenshots, so the stateless API is the privacy-safe choice.

### D-005 · Raw Live WebSocket client instead of the JS SDK
Small (~400 lines), uses Node's built-in WebSocket, exposes every documented field
(`activityHandling`, `turnCoverage`, `sessionResumption`, `contextWindowCompression`,
`toolResponse.scheduling`, GoAway) and can be pointed at the local mock server for tests.

### D-006 · Hold-to-ask chord ⌃⌥ = talk *and* draw
Requirement 4 says "hold a hotkey to enter draw mode … snapshot + strokes + what the student
said go to the AI as one question". heyclicky uses ⌃⌥ for push-to-talk, so one chord does both:
hold ⌃⌥, talk, drag to circle; release to send. `⌃⌥D` toggles draw mode for trackpad users who
can't hold keys while dragging. All shortcuts are editable in Settings → Shortcuts.

### D-007 · The tutor's cursor follows yours by default *(replaced in round 2 by D-029: it stays put)*
Like heyclicky/Clicky, the buddy sits just below-right of your pointer, swoops to targets on a
bezier arc when it explains something and flies back afterwards. "Stay put" is a setting.

### D-008 · Visual language: two inks *(the glow and marker look were replaced in round 2 by D-029/D-030)*
Tutor = blue (#2F7BFF, heyclicky-style glowing pointer and marker strokes), student = orange
(#FF8A1F). Both colors are settings. App chrome is quiet native dark UI so ink carries the
personality. The cursor animation constants (arc height ∝ distance, smoothstep easing, 1.3×
mid-flight scale pulse) are adapted from the MIT-licensed open-source Clicky (credited in
NOTICE.md); no code or assets were copied from the proprietary heyclicky or Tuple apps.

### D-009 · Reverse engineering scope
Both products were downloaded and studied statically: Tuple 3.3.10's bundle (its React UI via
REA's JavaScript analysis, Lottie files, strings) and HeyClicky 1.0.53's DMG (resources, model
instruction files, strings, demo-video frames), plus their docs/changelogs and the MIT Clicky
source. The device-side REA tools timed out, so no runtime tracing; static analysis was enough
to understand the features (docs/RESEARCH.md). Nothing proprietary was copied (NOTICE.md).

### D-010 · Overlays exist only during sessions
One transparent, click-through, content-protected window per display, created at session start
and destroyed at the end (they cost ~40 MB each). Content protection keeps our own ink out of
the frames the tutor sees. Windows are destroyed only after their page finished loading — a
fast start→end could otherwise crash Chromium (found by the e2e test).

### D-011 · Hold-to-ask buffers the question, then sends it as one burst
While the ask chord is held (or draw mode is on) the microphone is buffered locally instead of
streamed. On release the app sends, in order: the full-detail frame with the student's marks
composited in, a note describing the marks ("circled the area at box […]") with a zoomed crop,
then the trimmed speech at ~4× real time and `audioStreamEnd`. Streaming live would let the
server's VAD answer half a question while the student is still drawing. Long pauses are trimmed
so a mid-question pause can't end the turn early. Cost: ~0.3 s more latency than streaming.

### D-012 · Tool behaviour: non-blocking by default, blocking only for lookups
Gemini 3.8 Live functions are NON_BLOCKING by default; the tutor keeps talking while the app
grounds and draws. `read_screen` and `search_course` are BLOCKING because the model needs their
answer before it can say anything useful. Results come back with `scheduling` SILENT (most
marks), WHEN_IDLE (explain_on_screen scripts, step completion) or INTERRUPT (rare).

### D-013 · Context notes wait for a pause
`clientContent` interrupts a reply that is being generated, so notes the app wants the tutor to
know ("the student moved to display 2", "the video was paused") are queued and sent only when
the tutor is not generating. Audio and frames are never held back.

### D-014 · Pointing = a separate grounding call on a fresh full-resolution capture
The Live model sees a low-detail ≤1 fps stream, so it names the target ("the Submit button") and
gives a rough 0–1000 guess. The app captures the display at full resolution and asks
`gemini-3.8-flash` (thinking low) for a tight `box_2d`, with a zoomed second pass for small or
text targets; boxes map back through the frame's region to global points (pinned by unit tests).
Boxes for targets that name a control are snapped outward to the control's real edges, so a
circle around "the Submit button" encloses the button, not just its label. An OCR backend
(tesseract) implements the same interface for offline use and deterministic tests.

### D-015 · The cursor is the pen; ink is timed to the speech
Every mark is drawn by the tutor's cursor: it swoops to where the stroke starts and traces it.
Marks requested mid-sentence are revealed when the student *hears* that point of the sentence
(a clock that maps audio positions to wall time), not when the tool call arrives — tool calls
usually arrive ahead of the audio. For multi-step explanations (`explain_on_screen`) a planner
returns lines to say with marks for each; the Live model reads them and each line's marks
appear as its words are spoken (matched on the live transcript), like HeyClicky's beats.

### D-016 · The hub steps aside when a session starts
Starting a session hides the course window: the tutor should see the student's work, and the
HUD + menu-bar icon carry the controls. Reopen it from the menu-bar icon.

### D-017 · The tutor's cursor always carries a name pill *(replaced in round 2 by D-029: labels only on join, pointing and driving)*
The brief asks for a labeled cursor. The pill shows the tutor's name while following you and
switches to the label of what it is pointing at ("Submit", "click here") while pointing.

### D-018 · The pointing test uses a real window
Overlays are hidden from screen capture, so calibration targets drawn on them would be invisible
to the tutor. Settings → Setup & checks → Pointing accuracy opens a plain, click-through window
with labelled buttons on every display, grounds each one exactly like `point_at`, and draws the
verdict (box, centre, error in px) on the overlays. `npm run eval:grounding` runs the same check
with Gemini and writes a JSON report.

### D-019 · Linux test rig: compositor and real pointer
The e2e tests run under Xvfb with `xcompmgr` (transparent windows only blend over the desktop
with a compositor, as on macOS) and move the real X pointer with robotjs (xdotool's mousemove is
unreliable under Xvfb). OCR stands in for Gemini so pointing accuracy is checked against the
pixels of real windows at 1× and forced 2×.

### D-020 · The course brain is local: BM25 + optional Gemini embeddings
Each course folder is read into passages with human citations ("Lecture 05 - Recursion,
slide 2", "… at 12:30", "factorial.py, lines 1–7") and kept in the app's data folder (never in
your course folder). Search is BM25 — exact on course terms and code identifiers, works offline
— fused (reciprocal rank) with `gemini-embedding-001` similarity when a key is set. Re-reading
only touches changed files, so it runs at every session start. When nothing matches, the tool
says so instead of returning the nearest unrelated passage, and the tutor is told to say it's
beyond the course (`flag_out_of_scope`) or that their material didn't cover it.

### D-021 · A course profile in the system prompt
After indexing, Gemini Flash writes a short profile: summary, topics in lecture order, the
course's own terms with its definitions, conventions (language, notation) and what it says is
taught later. It goes into the Live system prompt so the tutor speaks the course's language
before it searches anything. Without a key a heuristic profile is built from file names,
headings and definition-like sentences.

### D-022 · Assignment mode
Picking an assignment spec when starting a session (specs are suggested from names like "A3",
"Assignment 2", "Lab 5") puts the spec first in searches and switches the tutor to hints-only
rules: explain concepts, point to lectures, ask guiding questions, never write or type the
solution. `think_deeply` gets the same rule. Takeover typing into files is blocked in this mode
(Phase 5).

### D-023 · Takeover safety model
Control is granted per request (card, ⌃⌥G or a spoken yes; 20 s timeout, silence = no) and lasts
until the tutor releases it, the student takes it back, or nothing happens for the auto-revoke
time (45 s default). Global hooks watch for the student's own input; the app remembers every
pointer position and key it synthesized, so only *real* input reclaims — on the first event, and
mid-action (typing stops, held buttons are released). Clicking things labelled submit / send /
delete / run / buy …, ⌘Return, Return in a terminal or after a shell command, ⌘Delete and ⌘Q need
a separate on-screen yes every time, regardless of what was said aloud: the pointer goes to the
target, a red ring marks it and the card sits away from it so the student sees exactly what
would happen. Clicking an IDE's "Run" counts as running code, so it asks too. Takeover is refused
when the global hooks can't run (no Accessibility permission), because instant reclaim couldn't
be guaranteed.

### D-024 · App Veil polls the window list and errs towards hiding more
The window list is read ~3 times a second, z-order aware (only the visible parts of a veiled
window are blacked out; windows in front of it stay visible). Windows the size of a whole display
never count as covering a veiled window (they may be transparent overlays from other tools),
Pairwise's own windows are ignored, and a veiled window that moved is covered at both its old and
new position for one cycle. The veil is in place before the first frame of a session is sent.
Limit: a veiled window that appears between two polls can be visible for up to ~350 ms.

### D-025 · The whiteboard is an ordinary window
So the tutor sees it in the same screen frames as everything else (no special channel), the
student can move/resize it, and screenshots of it go into the notes. The tutor's cursor flies
onto the board and draws each box and arrow in teaching order; the board's 1000 × 640 coordinate
space is letterboxed into the window and mapped to screen space for the pen. Diagrams come from
structure (`draw_diagram`: tree, flow, list, array, graph, boxes) rather than free coordinates,
so they're tidy whatever the model says.

### D-026 · Notes go into the course folder, written after the session ends
`<course folder>/Pairwise notes/<date time> <topic>.md` (+ `images/` for diagrams), or the app's
data folder when no folder is linked. Ending a session never waits for the summary: everything is
captured synchronously and written in the background (quitting the app waits up to ~12 s for it).
Gemini Flash writes the summary/key ideas/to-review when a key is set; otherwise a plain version
from what was asked, saved and cited. The notes folder is excluded from course indexing.
Screenshots appear in notes only if Settings → Privacy allows it (off by default).

### D-027 · Download Electron during install, not on first run
Electron 44 doesn't download its binary in `npm install` any more. It waits for the first
`require('electron')`, and `electron-vite dev` checks `path.txt` without triggering that
download. On a fresh Mac checkout this showed up as "Error: Electron uninstall".
`scripts/ensure-electron.mjs` now runs from `postinstall` and before `dev`/`start`, and it
downloads the binary if it's missing. This was found on the user's Mac. The sandbox had never
hit it because the e2e runs had already triggered the download.

## Round 2 (2026-10-21): feedback from the first real use on a Mac

### D-028 · OCR passes run with one OpenMP thread each
The offline grounder runs up to four tesseract passes at once. With tesseract's default OpenMP
threading they fought over the cores: on a 4-core machine a pass that takes 0.25 s alone stalled
for 30 s or more, so every OCR-grounded test found nothing (0/18 in the pointing check). Each
pass now runs with `OMP_THREAD_LIMIT=1` and the four finish together in ~0.3 s. This is the
offline fallback and the test stand-in for Gemini; Gemini grounding was not affected.

### D-029 · Ada's cursor stays where she leaves it (follow mode removed)
The owner found the follow-your-pointer buddy "violent". Like a person's cursor on a Tuple call,
it now appears once beside the student's pointer when the session starts (with her name), then
only moves when she moves it: to point, draw or gesture. It never follows and never flies home.
The `cursorBehavior` setting is gone (stay is the only behaviour; settings v2 drops the key).
*Presence:* while it moves or shows a label it is at full strength; 1.2 s after it stops it fades
to 35 % and hides its label; when the student's pointer comes within ~60 px (leaves at ~84 px)
it fades to 12 %. A pointing label stays up for its hold (2.6 s) and longer while she is still
talking. Main computes the presence (unit-testable) and sends it with each frame, together with
the student's pointer position, which the overlays also use for the proximity fade of cards.
*Labels:* her name only when she joins and "Ada is driving" while driving; a pointing label when
she points; no label after drawing or gesturing. After a takeover the cursor stays at the last
spot she drove to. *Look:* a flat arrow in her colour with a white edge and a small shadow (no
glow, no rotation or scaling in flight, no comet trail); flights use a gentler curve (arc
≤ 46 px) and a minimum-jerk speed profile, like a hand moving a mouse.

### D-030 · Tuple's paint for all ink
Measured from Tuple 3.3.10 (HANDOFF research): one flat colour, constant width, round caps and
joins, midpoint quadratic smoothing, no glow, no pressure. Pairwise now strokes every mark with
a 5.5 px brush (`BRUSH_WIDTH`), `lineCap = lineJoin = 'round'`, through the shared
`smoothPath()` (each segment curves to the midpoint of the next two points), with at most a
barely visible shadow (rgba 0,0,0,0.2, 1.5 px). A click without a drag, or a stroke with no
length, is a dot of the brush's diameter (student strokes keep single points now; the composite
frame sent to the tutor draws them too). Highlights are one flat translucent band (30 %) with
rounded ends inset so they land on the text's edges. `perfect-freehand` is no longer used.
*Highlight click:* `ring` is Tuple's: a small filled dot that turns into a ring, grows and thins
from 6 to 3 px as it fades, twice (0.9 s each, 0.42 s apart). A ring that stays (a guided step
waiting for a click) repeats the pair every 3.4 s instead of breathing.

### D-031 · Ada's notes are typed, like Tuple's text tool (handwriting is a setting)
Notes are typed letter by letter in the system font, semibold
(`-apple-system, 'SF Pro Text', 'Inter Variable'`), 19 px, in her colour, with a caret and a
dotted outline while typing that fade after it; no background or bubble. The cadence is a
deterministic per-seed plan (`typingPlan`): 45–110 ms per key, +40–120 ms after a space,
+110–280 ms after punctuation, the odd hesitation; capped at 3.8 s per note. While typing, the
cursor rests where it "clicked" to place the note. *Setting:* Settings → Cursor & ink →
"Ada writes notes: Typed (like Tuple) / Handwritten" (`noteStyle`, default typed); handwritten
notes use Caveat at 27 px as before (no halo or glow). *Width estimates:* the old 0.46 em/char
guess for Caveat was ~30 % too wide. `approxTextWidth()` now uses per-class advance widths
measured in Chromium for Inter 600 (a close stand-in for SF Pro Semibold) and Caveat 700, good
to a few percent on phrases; notes placement, diagram node sizes and the pen use it. Whiteboard
labels use the same fonts (smaller sizes for the system font) and type at 60 % of the note pace.

### D-032 · A quiet screen (Tuple-like declutter)
* **Session bar:** a small pill (course dot + timer, mic, Ada's state, the "can see" eye, End;
  a `demo` badge without a key) at 62 % opacity until hovered or something needs attention
  (asking, driving, connecting). Hovering ~0.15 s opens the full controls; it closes 0.65 s
  after the pointer leaves. Draggable; the position is remembered per display (`hudPositions`).
  The window is sized tightly so its transparent margin doesn't block clicks.
* **Privacy indicator:** the eye in the pill replaces the separate "Ada can see this screen"
  pill. If the bar is hidden (⌃⌥H) a tiny eye stays in the corner of that display.
* **Captions:** off by default (settings v2 turns them off once on upgrade). When on, one subtle
  line of Ada's current sentence under the pill, gone ~4 s after she stops.
* **Toasts:** none for mute, unmute or talk mode (the pill shows them: red mic, a key badge in
  hold-to-talk); "video paused" and "saving to notes" are explained once per session; warnings
  (budget, capture, connection) and "You have control" stay.
* **Step card:** one line ("1/3 · Click Run") at the top right. It opens to the full list for
  3.2 s whenever a step changes, or while the pointer rests on it for 0.7 s.
* **Citations and "beyond this course":** small chips that hide after 5–6 s.
* **App Veil outline:** 1.5 px dashed; its label shows for 4 s after the window is first veiled.
* **Proximity fade:** cards, chips and labels fade to 15 % when the student's pointer is within
  56 px, and every overlay stays click-through, except the consent card (it must be clicked) and
  the driving frame and banner (they must stay obvious).
* **Celebration:** 42 confetti instead of 110, and the word in her colour without a glow.
An idle session now shows the pill and Ada's dimmed cursor, nothing else (e2e 11).

### D-033 · A human pen: slower, eased, varied
* **Timing** (shared `penStateAt`, so the renderer and the cursor agree): each stroke takes
  260 ms (120 ms for later strokes of the same mark) + ~0.98 ms/px — about 30 % slower than
  round 1 — and follows a minimum-jerk profile (82 % min-jerk + 18 % linear, so the pen is
  already moving when it touches down). Arc length is weighted by local turning, so the pen
  slows into corners (~2.4× time per px at a sharp corner). Between strokes of one mark the pen
  lifts for 80–200 ms while the cursor travels to the next stroke. Marks take 0.42–1.9 s.
* **Variation** (from each item's seed, the same on every display): arrows bow 4–12 % of their
  length to a random side (1–3 % for diagram edges), heads 22–35° and 12–18 px, slightly
  lopsided, drawn as one "V" or two separate barbs; circles start mostly at the upper left, go
  either way round (65 % anticlockwise), overshoot 8–25°, tilt up to ±4° and wobble 1.5–3 % in
  radius, and still clear the target's corners (superellipse fit kept); underlines tilt up to
  ±1.5° (≤ 3.5 px), sag a little, vary ±4 % in length and sometimes hook; boxes start mostly at
  the top left, bow their sides and close past the start; checks and crosses vary in proportion.

### D-034 · Pointer-only gestures
A new Live tool, `move_cursor({ target, style: hover | follow_line | sweep, lines? })`, and the
same three as beat kinds in `explain_on_screen`. Grounding and own-UI exclusion are the same as
`point_at`. Nothing is drawn and no label shows. *follow_line* glides just under the line (the
tip never covers the letters) at ~190 px/s for 26 px text (scaled with the text size, 0.8–4.5 s);
*sweep* rests on each line of a block (one stop per ~28 px unless `lines` is given), just left of
where the lines start, ~0.64 s per line; *hover* rests on the target low and right of its middle
so its label stays readable. The system prompt now asks for frequent pointing and gestures and
sparing ink; the planner prompt allows at most one mark per explanation unless marking really
helps. The demo tutor has a "walk me through this" turn and its explanation leads with a sweep
and a line-follow.

### D-035 · A real Mac app in the Dock (`npm run app`)
`scripts/build-app.mjs` builds the code, packages `Pairwise.app` for the Mac's own chip with
`electron-builder --mac dir -c.mac.identity=null`, signs it ad hoc (`codesign --force --deep
--sign -`, after clearing extended attributes; Apple Silicon only runs signed code), verifies the
signature, quits a running copy if there is one (it ends a live session properly), replaces
`/Applications/Pairwise.app` (or `~/Applications` if `/Applications` isn't writable) with
`ditto`, and opens it. `LSUIElement` is gone and the Dock icon is no longer hidden: clicking it
opens the hub, its menu starts a session (per course, or "Resume <course>") or ends one, and the
app menu has Pairwise (Settings… ⌘,), Edit (copy and paste in fields), Session and Window. The
menu-bar icon stays. `PAIRWISE_SIGN_IDENTITY` signs with a stable self-signed certificate
instead, so macOS keeps permissions across rebuilds; `--reset-permissions` clears stale TCC
entries with `tccutil` (opt-in, as it changes system state). `npm run dist:mac` still makes the
unsigned DMGs. Building the `.app` in the cloud and signing it with `rcodesign` was skipped:
a downloaded app would be quarantined, and building locally is one command.

### D-036 · A key saved by another build is asked for again
`npm run dev` stores the key with Electron's keychain entry ("Electron Safe Storage"); the
packaged app has its own ("Pairwise Safe Storage") and can't decrypt it. The settings service
now reports such a key as `unreadable`; the hub opens on Settings → Gemini, explains why, and
the sidebar says the key needs pasting again. Until then the demo tutor runs.
