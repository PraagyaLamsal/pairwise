# Pairwise

**A live AI tutor that feels like a pair-programming call.** Pick a course, press **Start
session**, and Ada (the tutor) can see your screen, talk with you, point with her own cursor,
draw on top of anything, walk you through steps, and — only when you allow it — take the mouse
and keyboard to show you. She teaches from your course folder, using your professor's terms, and
writes session notes into that folder when you're done.

It feels like a Tuple call: Ada's cursor stays where she leaves it and fades back when she isn't
using it, she mostly *points* (resting on things, following a line as she reads it, running down
a list) and draws only when it helps — in Tuple's flat, round-ended brush, with typed notes. The
screen stays quiet: a small session pill and her dimmed cursor, nothing else, until something
happens. It's a normal Mac app you can keep in the Dock (`npm run app`), with a menu-bar icon too.

Ask what your code actually does and she **traces it like a debugger, on your own screen**: her
cursor steps through the lines as they run while she talks, and the values appear right after
each line (`n = 3`, `returns 6`), updating in place as a loop or a recursive call goes round.
And to check you've really got it, she sometimes asks you to **show her** — "click the line where
the recursion stops" — and knows whether you clicked the right spot. Her marks **stay with what
they mark**: scroll or move the window while she explains and they move with your code; switch
to another app and they hide instead of pointing at the wrong thing, and come back when you do.

Built for macOS (v1), structured so Windows/Linux can follow (`src/main/platform/`). Gemini only.

| | |
|---|---|
| Plan, stack and architecture | [PLAN.md](PLAN.md) |
| Every decision made without asking | [DECISIONS.md](DECISIONS.md) |
| Things only you can do (key, permissions, signing) | [BLOCKERS.md](BLOCKERS.md) |
| What was built and how each part was tested | [PROGRESS.md](PROGRESS.md) |
| How Tuple, HeyClicky and the Gemini API were studied | [docs/RESEARCH.md](docs/RESEARCH.md) |
| Credits | [NOTICE.md](NOTICE.md) |

---

## What it looks like

These are real captures of the app (Linux/Xvfb, with the scripted demo tutor), from the end-to-end
tests and `scripts/record-demos.mjs`. On a Mac the system fonts and window chrome differ; the
overlay, cursor and ink are the same.

| She traces your code like a debugger | She points like a person on a call |
|---|---|
| ![Ada steps through factorial(2): value chips appear after each line and update in place](docs/screenshots/demo-trace.gif) | ![Ada sweeps down the function, follows a line, then rests on Run](docs/screenshots/demo-gestures.gif) |
| **"Show me": she asks you to point at the answer** | **Her pen: Tuple's brush, a human hand, typed notes** |
| ![Ada asks where the recursion stops; the student clicks the line; nice!](docs/screenshots/demo-show-me.gif) | ![Ada circles Run, underlines the signature, and arrows the base case with a typed note](docs/screenshots/demo-pen.gif) |
| **Her marks stay with what they mark** | |
| ![Ada traces fib(3); the student scrolls down and back up, then drags the window by its title bar; the value chips move with their lines, and the first one hides under the header and comes back](docs/screenshots/demo-sticky.gif) | Scroll while she explains, or drag the window somewhere else, and her chips, circles and arrows come along with the code — the marks still to come land on the right lines too. A mark whose line goes under the header hides, and comes back with it. Switch to another app or tab and they hide until you come back. |

| | |
|---|---|
| ![A quiet session: a small pill and Ada's dimmed cursor](docs/screenshots/idle-session.png) | **A quiet screen, like a Tuple call.** In an idle session there's the session pill at the top and Ada's cursor, resting where she left it at 35 % — nothing else. It fades almost away when your pointer comes near, and never follows you. |
| ![Round 1: wide bar, banner, big step card, glowing cursor](docs/screenshots/declutter-before.png) ![Round 2: pill, quiet step card, flat cursor](docs/screenshots/declutter-after.png) | **The same moment, before and after round 2** (a guided step waiting for your click): the bar is a pill, the demo banner is a badge, the "can see" pill is the eye in the bar, the step list folds to one line after a moment, and the cursor and ring are flat, like Tuple's. |
| ![The session pill](docs/screenshots/hud-pill.png) ![The pill opened on hover](docs/screenshots/hud-open.png) | **The session pill** shows the timer, your mic, Ada's state, the eye (she can see this screen) and End. Hover it for everything else; drag it anywhere — it remembers the spot per display. |
| ![Ada circles the Submit button on a 2× display](docs/screenshots/circle-retina.png) | **Pointing at 2×, in Tuple's brush.** One flat colour, a constant-width round-ended stroke, no glow. The circle is fitted to the button's real edges, found by grounding on a full-resolution capture. |
| ![Every mark kind](docs/screenshots/pen-marks.png) | **Her pen.** Circles, underlines, highlights, arrows, boxes, checks, step badges and value chips, drawn at a human pace (each stroke eases in and out, slows into corners, and the pen lifts between strokes) and never twice the same. |
| ![A typed note while typing, then done](docs/screenshots/typed-note.png) | **Typed notes, like Tuple's text tool.** Letter by letter in the system font, with a caret and a dotted outline while she types. (Handwriting is a setting.) |
| ![Ada's cursor following a line](docs/screenshots/follow-line.png) ![Ada's cursor sweeping down a function](docs/screenshots/sweep.png) | **Her cursor as a pointer.** Most of the time she just points: she follows a line under the text as she reads it, runs down a block line by line, or rests on the thing she means — nothing drawn, no label. |
| ![Ada traces factorial(2): value chips after each line](docs/screenshots/trace.png) | **She traces your code like a debugger.** "What does this return?" — her cursor skims each line as it runs while she says what happens, and the values appear just after the line's end in small chips. When a line runs again (here the recursive call, `n = 2` → `n = 1`), its value updates in place. |
| ![Ada's circle and value chip on the code](docs/screenshots/sticky-before.png) ![After scrolling 60 px: both moved with their lines](docs/screenshots/sticky-after.png) | **Her marks stay with what they mark.** While marks are up, Pairwise watches what's under them (on your Mac; nothing extra is sent anywhere). Scroll and they glide to where their lines went, along with her cursor and the marks she hasn't drawn yet; drag the window somewhere else and they go with it. A mark whose line scrolls out of view hides, and comes back when you scroll back to it. Switch to another app or tab and they hide; come back, and so do they. A tooltip, your typing, or your pointer on a mark moves nothing. (Settings → Cursor & ink.) |
| ![Ada asks: click the line where the recursion stops](docs/screenshots/show-me-ask.png) ![The student's click, marked with their ring](docs/screenshots/show-me-answer.png) | **"Show me" questions.** To check you really get it, Ada asks you to point at the answer on your own screen ("click the line where the recursion stops"). Your next click is taken as the answer (it doesn't reach the app underneath), marked with your own ring, and she's told whether it was on the right line or how far off, then reacts. Esc skips. |
| ![Student circles a line while asking](docs/screenshots/draw-and-ask.png) | **Ask by drawing.** Hold ⌃⌥, talk, and circle something (a click is a dot). Your orange marks, a zoomed crop and your words go to her as one question. |
| ![One-line step card](docs/screenshots/step-line.png) | **Step by step.** She points at the next thing to click and waits until you do it; the checklist is one line until a step changes or you rest your pointer on it. |
| ![Pointing-accuracy test results](docs/screenshots/pointing-test.png) | **Pointing accuracy check** (Setup & checks). Labelled buttons on every display, each found on a real capture and scored in pixels. |
| ![A citation chip](docs/screenshots/citation-chip.png) ![A one-line caption](docs/screenshots/hud-caption.png) | **Citations and captions.** When she teaches from your course, the source shows as a small chip that goes away by itself. Captions (off by default) are one line under the pill. |
| ![What Ada knows about this course](docs/screenshots/course-knowledge.png) | **Course brain.** Summary, topics, the course's own terms, and a search box to test what she'd find. |
| ![Ada is driving, with the amber frame and banner](docs/screenshots/driving.png) | **She drives (with your permission).** An amber frame, an "Ada is driving" banner, and her cursor riding yours. Move the mouse or press Esc and control is yours again. |
| ![Allow this action? card pointing at Submit](docs/screenshots/risky-action.png) | **Risky actions ask first.** Submitting, sending, deleting or running anything gets a red card that points at exactly what would be clicked. |
| ![Student's view: Messages outlined as hidden](docs/screenshots/veil-student-view.png) ![Tutor's view: the veiled window is black](docs/screenshots/veil-tutor-view.png) | **App Veil.** What you see (left), and what Ada receives (right): the veiled window is black in every frame before anything leaves your Mac, even where it's partly covered. |
| ![Whiteboard with a call tree](docs/screenshots/whiteboard.png) | **Whiteboard.** Her cursor draws the diagram box by box as she explains. You can draw on it too. |
| ![Onboarding](docs/screenshots/onboarding.png) | **Onboarding.** API key, the three macOS permissions, and how you want to talk. |

---

## Setup

You need **macOS 14 or newer**, **Node.js 22+** and npm (`brew install node`). Nothing is
compiled on your Mac — the native pieces are prebuilt.

```sh
cd pairwise
npm install          # prints which native helpers loaded (all three should say ✓)
npm run app          # builds Pairwise.app, signs it, installs it in /Applications and opens it
```

Then right-click its Dock icon → **Options → Keep in Dock**. Clicking the Dock icon opens the
course window; its menu starts (or ends) a session. To update later:
`git pull && npm install && npm run app` (it quits the running copy first).

For development, `npm run dev` runs it from source instead (macOS then lists its permissions
under **Electron**, and it keeps its own copy of your key — see [BLOCKERS.md](BLOCKERS.md) B-8).

The first launch opens onboarding, which walks you through:

1. **A Gemini API key** — from <https://aistudio.google.com> → *Get API key* (the project with
   your credits). It's stored encrypted in your login keychain. No key? The app still runs with a
   **scripted demo tutor**, so you can try everything below except real understanding.
2. **Three macOS permissions** — Screen & System Audio Recording, Microphone, Accessibility,
   for **Pairwise**. After turning on Screen Recording, quit and reopen the app. After a rebuild
   macOS may ask again (the app is signed ad hoc). Details: [BLOCKERS.md](BLOCKERS.md) B-2, B-8.
3. **How you want to talk** — hands-free, or hold the ask keys (⌃⌥) while you speak.

If `npm run dev` ever says **"Error: Electron uninstall"**, run `npx install-electron --no` once.
That downloads the Electron app, which `npm install` now does for you.

Then add a course (COMP 1405 and COMP 1805 are one click away), **link its folder** (slides, PDFs,
notes, transcripts, assignment specs, code), and start a session.

### The app

```sh
npm run app                          # build → sign (ad hoc) → install → open
npm run app -- --no-open             # …without opening it
npm run app -- --reset-permissions   # also clear macOS's old permission entries for Pairwise
PAIRWISE_SIGN_IDENTITY="Pairwise Local" npm run app   # sign with your own certificate (B-8)
npm run dist:mac                     # unsigned DMGs (arm64 and x64) for sharing
```

`npm run app` builds for your Mac's chip, signs the app ad hoc (Apple Silicon only runs signed
code; no Apple account needed), and installs it in `/Applications` (or `~/Applications` if that
isn't writable). Signing it to share with others: BLOCKERS.md B-4.

It's light on your battery: when nothing is happening on screen the overlays draw no frames at
all and moving your mouse costs next to nothing. It follows macOS **Reduce motion**
(Accessibility → Display): Ada's cursor moves straight and quickly instead of swooping, rings
don't pulse, celebrations skip the confetti, and cards fade in instead of sliding.

### Tests

```sh
npm test             # unit + integration (vitest): geometry, Live protocol, grounding, beat sync,
                     # course brain, takeover rules, App Veil, diagrams, the brush and pen,
                     # cursor presence, gestures, settings migration, the app build steps …
npm run test:e2e     # the real app end to end (Playwright for Electron) against a local Gemini
                     # Live mock: shell, voice, pointing accuracy (1× and 2×), draw-and-ask,
                     # steps, calibration, course brain, takeover, App Veil, whiteboard, notes,
                     # the quiet screen, cursor gestures, code traces and sticky ink
                     # (1× and 2×), Reduce motion, and "Show me" questions
npm run eval:grounding   # with GEMINI_API_KEY set: the pointing-accuracy test using real Gemini
node scripts/record-demos.mjs   # re-record the animated demos above (Linux, needs ffmpeg)
```

The e2e suite is meant for Linux/CI (it runs inside a private Xvfb display). On a Mac it would
take over your screen for ~15 minutes; use the in-app checks instead (Setup & checks).

---

## Shortcuts (all editable in Settings → Shortcuts)

| | |
|---|---|
| **⌃⌥** (hold) | Ask: talk, and drag to circle/underline — release to send it all as one question |
| ⌃⌥D | Draw mode without holding keys (Return sends, Esc cancels, Shift = straight line) |
| ⌃⌥S | Start / end a session (last course) |
| ⌃⌥M | Mute / unmute |
| ⌃⌥V | Pause / resume what the tutor can see |
| ⌃⌥W | Whiteboard |
| ⌃⌥R | Say that again |
| ⌃⌥C | Clear drawings |
| ⌃⌥G | Allow the tutor to drive (when it asks) |
| ⌃⌥P | Pause / resume your video |
| ⌃⌥K | Hands-free ↔ hold-to-talk |
| ⌃⌥T | Captions on / off |
| ⌃⌥H | Show / hide the session bar |
| Esc / move the mouse | Take control back instantly |

---

## Demo script — try every feature

Run through this once with your key (the real tutor) — it takes about 15 minutes. Without a key
the demo tutor follows a script instead: the same features happen, in this order, each time you
say something or release the ask keys (the first one shows her pointing gestures, the second her
pen, the third a trace).

**Before you start:** add COMP 1405 and link a folder that has a few lecture slides/PDFs (the
generated test course works too: `node -e "import('./test/fixtures/make-course.mjs').then(m=>m.makeCourseFolder('/tmp/comp1405'))"`
then link `/tmp/comp1405`). Open some code or a slide on screen.

### 1. Session basics (a quiet screen)
1. Click **Start session** in the course window, or the Dock icon's menu → **Start session**,
   or ⌃⌥S. The window steps aside. All that's on screen is a small, half-transparent **session
   pill** at the top — the course dot and timer, your mic, Ada's state, an **eye** (she can see
   this screen) and **End** — and Ada's cursor, which appears beside yours with her name.
2. Hover the pill: it opens to all the controls (talk mode, draw, whiteboard, say that again,
   captions). Move away and it folds back. Drag it by its timer to wherever you like; it
   remembers the spot on that display.
3. Ada greets you. Her cursor says hello, then **stays where it is and fades** (35 %); move your
   pointer close to it and it almost disappears (12 %). It never follows you around.
4. Press ⌃⌥M (mute: the mic turns red) and again; press ⌃⌥V to pause her view (the eye turns
   amber) and again. No pop-ups — the pill shows it.
5. Want captions? ⌃⌥T (or **CC** in the open pill): one line of what she's saying, fading a few
   seconds after she stops.
6. *Two monitors?* Move your pointer to the other display — she says she's looking there now.

### 2. Voice and interruption
1. Ask "can you explain what a recursive function is?" and, while she's talking, say "wait —".
   She stops within a fraction of a second and listens.
2. Switch to hold-to-talk (open the pill → *Hands-free*, or ⌃⌥K). The mic shows a small ⌃⌥ badge;
   now nothing is sent unless you hold ⌃⌥.
3. Press ⌃⌥R — **Say that again** replays her last answer, and any marks she made are redrawn in
   time with the words.

### 3. Her cursor and pen
1. Ask "where's the run button?" — her cursor moves there like a hand on a mouse, a short label
   appears, and a **highlight click** (a dot that becomes a ring and fades, twice) marks it. Then
   her cursor stays right there and fades back.
2. Ask her to "walk me through this function line by line". Mostly she **points**: she runs her
   cursor down the function, **follows a line** under it as she reads it, rests on the thing she
   means. Nothing is drawn for that. When marking helps she draws — a **circle, underline,
   arrow or box** in Tuple's flat brush, every one a little different and drawn at a human pace
   — or **types a short note** letter by letter. All in time with her voice.
   *(Prefer handwriting? Settings → Cursor & ink → Ada writes notes → Handwritten.)*
3. Open some code (say a recursive `factorial`) and ask "what does `factorial(3)` return?". She
   **traces it**: her cursor steps onto each line as it runs while she says what happens, and the
   values appear in small chips right after each line — `n = 3`, `3 == 0 → False`,
   `3 * factorial(2)` — updating in place when the function is called again. *(In demo mode it's
   the third thing you say; without a key she can't read your code, so the chips land in the
   middle of the screen.)*
4. Say "quiz me on this". Now and then she checks your understanding by asking you to **show
   her**: a one-line question appears at the bottom ("Click the line where the recursion stops")
   and the screen gets a thin orange edge. Click the answer: your click is marked with your own
   ring, it doesn't reach the app underneath, and she tells you whether you got it. Esc skips.
   *(How often she asks: Settings → Tutor → Quick checks.)*
5. Ask "clear that" (or ⌃⌥C).
6. **Setup & checks → Pointing accuracy → Start test** (during a session): labelled buttons appear
   on every display, she finds each on a real screenshot and you see how many pixels off she was.
   **Settings → Cursor & ink → Preview on screen** shows every mark kind without using the API.

### 4. Ask by drawing
1. Hold **⌃⌥**, say "what does this do?", and **drag a circle** around a line of code. Let go.
   Your orange marks, a zoomed crop and your words go to her as one question; she answers about
   exactly what you circled.
2. Trackpad: ⌃⌥D, draw, press Return.
3. Play a lecture video (YouTube in Safari/Chrome, Music, Spotify, QuickTime…) and ask something —
   it **pauses** when you start asking (a ▶ appears in the session pill). Say "resume the video", or click the ▶.

### 5. Step by step
1. Ask "how do I run my Python file from the Terminal?". A checklist opens at the top right for a
   moment, then folds to one line ("1/3 · Open the Terminal"); rest your pointer on it to see the
   whole list. She points at exactly what to click and **waits**. Click it — the step ticks off,
   she continues. Steps she can't see ("type the command") wait for you to say "done". Finishing
   them all gets a little celebration. Anything on screen fades out of your way when your pointer
   comes near, and lets your clicks through.

### 6. Your course
1. Ask "what does my course call the base case?" — she searches your folder, answers in your
   professor's words, and a small **source chip** ("Lecture 05 - Recursion, slide 2") shows for a
   few seconds at the bottom left.
2. Ask about something beyond the course ("how does inheritance work?" in COMP 1405) — she says
   it isn't covered yet and a "Beyond this course" chip appears.
3. In the hub, open the course: **What Ada knows about this course** (summary, topics, the
   course's terms) and **Try a search**.
4. **Assignment mode:** mark a spec file as an assignment (or let it be detected: "A3…", "Lab 5…"),
   choose it in the dropdown next to Start session. Ask her to "just write the function for me" —
   she explains and hints instead, citing the spec and lectures.

### 7. She drives (with your permission)
1. Ask "can you show me where the Run button is in VS Code?". A card asks: **Let it drive**
   / Not now (or press ⌃⌥G, or just say "yes, go ahead").
2. While she drives: an amber frame around the screen, an "Ada is driving" banner, her cursor
   rides yours, and every move is a visible glide. Afterwards her cursor stays where she left it.
3. **Move your mouse** (or press Esc) — control comes back that instant, mid-action.
4. Let her drive again and ask her to submit something / run a command: a red **Allow this
   action?** card points at exactly what would be clicked. Cancel — nothing happens.

### 8. Whiteboard
1. Ask "can you draw the calls for factorial(3)?" — the whiteboard opens and her cursor flies onto
   it and draws the call tree box by box as she explains.
2. Draw on the board yourself (orange pen; eraser removes your strokes). ⌃⌥W hides/shows it.

### 9. Privacy
1. Open **Messages**: a thin dashed orange outline (labelled for a few seconds) says it's hidden
   from Ada. Ask her what's in that window — she can't see it (it's black in every frame before
   anything leaves your Mac). Hide the session pill (⌃⌥H) and a tiny eye stays in the corner, so
   you always know she can see the screen.
2. Settings → Privacy: choose which apps are veiled, notifications on/off, and whether notes may
   ever include screenshots (off by default).

### 10. Wrap up
1. Click **End**. A notes file appears in your course folder under **Pairwise notes/** — summary,
   key ideas, definitions, what to review, sources cited, the whiteboard diagram as an image and
   a condensed transcript. The hub lists it under *Session notes*.
2. Start again with **Pick up where we left off** — she recaps what you did last time.
3. **Usage** shows what each session cost and the month so far; set a monthly cap there (she warns
   at 80% and wraps up at 100%).

---

## Project layout

```
src/main/            Electron main process
  session/           the tutoring session: Live link, tools, cursor, ink, choreography
    features/        visual (point/annotate/explain), ask (draw-and-ask), steps, course,
                     takeover, veil, whiteboard, notes, calibrate
  courses/           course store + course brain (extract, chunks, search, profile)
  vision/            grounding (Gemini / OCR), control snapping, reader, planner, calibration
  gemini/            Live WebSocket client, REST client, local Live mock (demo + tests)
  platform/          everything OS-specific (displays, hooks, input driver, windows, media)
  windows/           hub, HUD, overlays, engine, whiteboard windows
src/renderer/        hub (React), HUD (React), overlay (canvas + DOM), engine (audio/capture),
                     whiteboard
src/shared/          types and pure logic shared by both sides (geometry, ink geometry, IPC)
test/                unit, integration, e2e (+ fixtures that generate a course folder)
```
