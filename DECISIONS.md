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

### D-007 · The tutor's cursor follows yours by default
Like heyclicky/Clicky, the buddy sits just below-right of your pointer, swoops to targets on a
bezier arc when it explains something and flies back afterwards. "Stay put" is a setting.

### D-008 · Visual language: two inks
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

### D-017 · The tutor's cursor always carries a name pill
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
