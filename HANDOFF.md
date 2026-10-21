# Handoff: Pairwise round 2 (feedback from the first real use on a Mac)

This is the living plan for the next round of work. Read it fully before changing code, then
keep it current: tick items, add findings, record decisions in DECISIONS.md.

## Where things stand (2026-10-21)

* v0.1 is complete: all six build phases (see PROGRESS.md). The last full run on Linux/Xvfb:
  typecheck clean, **96/96** unit tests, **12/12** e2e runs (pointing + calibration at 1× and 2×).
* Since then only one fix landed: Electron 44 no longer downloads its binary in `npm install`.
  `scripts/ensure-electron.mjs` runs from `postinstall` and `predev`/`prestart` (DECISIONS D-027).
* The owner has run it on his Mac (macOS 27, Apple Silicon, Node 24) and loves it. He then asked
  for the changes below. **None of them are implemented yet.** Only research has started (below).

## The owner's requests (verbatim, 2026-10-20)

> 1) i dont like how adas cursor follows me so violently. her cursor should just stya in place when
> shes not moving it around. also when shes not using the cursor, keep it there but make its opacity
> lower so it doesnt obstruct / block anything on my screen
> 2) i want the exact same drawing on screen system as tuple, which includes the font/brush. the
> current brush used to draw feels weird and clicking once doesnt make a dot. if u get what i mean.
> just make it a flat brush, not a pressure based one or whatever.
> 3) i feel like the app is too cluttered/too many things on my screen. i really want it to be like
> tuple, because it has all of these features but it doesnt feel like ur screen has too many
> elements on it, or its blocking things etc.
> 4) i want adas handwriting and drawing to be slightly slower and more 'randomized', e.g meaning not
> every arrow she makes is the exact same, so it feels like a human.
> 5) i want ada to also someitmes move her cursor around without writing or saying anything on the
> screen. like, using her cursor as a pointer/aid sometimes, kinda like when someone uses it to
> scroll through lines or whatever.
> 6) can you make it into an app, instead of inthe terminal? so i can add it to my dock etc.
> 6) do a bunchhh of testing and repeating until you truly believe the new version hits all of
> these goals above

Then: "feel free to reverse engineer tuple using the REA skillset and tools."

## Standing rules (from the original brief, still in force)

* Install dev dependencies, build, run and test anything inside the project. Don't change system
  settings or touch files outside the project.
* Don't stop to ask questions. Make reasonable decisions and log them in DECISIONS.md.
* Things only the owner can do (API key, macOS permissions, paid sign-ups): stub or mock them, keep
  building, and list them in BLOCKERS.md with exact steps.
* Coordinates must land accurately on the real UI. Test this explicitly. The pointing and
  calibration e2e tests must keep passing at 1× and 2×.
* Commit and push only when the owner asks. He has asked for this round: push to
  `https://github.com/PraagyaLamsal/pairwise` (branch `main` is his; use a feature branch and open a
  PR, or push to `main` if he says so).
* No Tuple/HeyClicky code or assets in the repo. Measured behaviour and constants are fine
  (credited in NOTICE.md/RESEARCH.md); their GIFs, images, fonts and binaries are not.

## Research so far: how Tuple draws (evidence)

Sources: Tuple 3.3.10 for macOS (`tuple.app/download/mac`, extracted with 7-Zip). Docs GIFs:
`paint-tool.gif`, `text-annotation-tool.gif` and `highlight-click-tool.gif`, all at
`https://mintcdn.com/tuple-0f82e5be/O4IiteXcXoa48ycm/images/pairing-with-tuple/macos-interacting-with-a-shared-screen/`.
Docs pages: docs.tuple.app/pairing-with-tuple/collaborative-painting and
docs.tuple.app/pairing-with-tuple/interacting-with-a-shared-screen.

**Observed in the GIFs (frames extracted with PIL):**
* Paint strokes are **one solid flat colour** (the participant's colour; red/pink in the GIF) with
  **constant width**. There is no glow, no outline, no taper and no pressure. The ends are round,
  the curves smooth. The whole drawing fades out together a little after drawing stops. Measured
  width is about 4 px in a 682-px-wide GIF where the macOS arrow cursor is about 11 px tall, so
  roughly 6 pt on screen.
* **Text annotations** are typed text in the system font (SF Pro, semibold-looking) in the
  participant colour. There is no background, bubble or outline. While typing there is a dotted
  outline box with a caret; after commit it's just the text, which fades later.
* **Highlight click**: a small filled dot that becomes a thin ring in the participant colour,
  expands, and fades within about a second.

**Static analysis of the arm64 slice** (`scripts/research/tuple_calls.py` and
`scripts/research/tuple_disasm.py`, using Capstone and LIEF). The binary is stripped, so these
are call sites of imported APIs.
* CoreGraphics replay renderer (around `0x10052b7xx`): each stroke record carries its own
  `lineWidth` (loaded per stroke, then `CGContextSetLineWidth`), followed by
  `CGContextSetLineCap(ctx, 1)` and `CGContextSetLineJoin(ctx, 1)`. **1 means round cap and round
  join.** Points are stored normalised: the CTM is scaled by 1/width and 1/height.
* `SwiftUI.Path.addQuadCurve` is called with 0.5 factors (`0x10054a8a4`, `0x10054ab60`). *Inference:*
  midpoint quadratic smoothing. Each segment curves to the midpoint of the next two input points,
  using the point as its control. This matches the `quadCurves` and `beforeLast` fields of
  `StrokeGeometry` and "Smoother line drawing" in 2.4.0.
* The only `GraphicsContext.stroke(_:with:lineWidth:)` call (`0x100682a5c`) has
  `lineWidth = 6 − 3·t`, with opacity terms using 0.2 and 0.4. *Inference:* this is the
  highlight-click ring animation (the ring thins from 6 to 3 pt as it grows).
* Type names in the binary: `StrokeView`, `StrokeGeometry{quadCurves, beforeLast, lineWidth,
  _isFadingOut}`, `HighlightsView`, `HighlightCircleView`, `AnnotationNSTextView`,
  `LocalTextAnnotationView`, `TextBubble`, `AnnotationBackgroundView`, `AnnotationContourShape`.
  AppKit `systemFontOfSize:weight:` and `NSFontWeightSemibold` are imported.
* **Still open** (optional, if it changes a decision):
  * the exact paint line width constant;
  * the fade delay and duration;
  * the text point size.

  The REA server on the owner's Mac has no engine (no Java/Ghidra, no Hopper), and Tuple isn't
  installed there. The cloud sandbox couldn't download Ghidra or rizin, because GitHub release
  downloads were blocked. Capstone works. A next step would be to follow `StrokeGeometry`'s
  field offsets from its type metadata, or to find the `Font.system(size:weight:)` /
  `systemFontOfSize:weight:` call sites with the same script.

To reproduce: download the Tuple DMG from `https://tuple.app/download/mac` and extract it with
`7z x`. Then run
`python scripts/research/tuple_calls.py Tuple.app/Contents/MacOS/Tuple 'StrokeStyle|stroke_4with|addQuadCurve|CGContextSetLine'`.
Keep the Tuple bundle outside the repo.

## Plan (one task per request; check each off with its tests)

### 1. Ada's cursor stays where she leaves it, dimmed when idle
* `src/main/session/cursor.ts` defines the modes `hidden | follow | timeline | parked | driving`,
  with `FOLLOW_OFFSET` and a spring. A `cursorBehavior: 'follow' | 'stay'` setting already exists
  (`src/shared/settings.ts`, default `'follow'`).
* Make **stay the only behaviour** (or the default, migrated for existing installs):
  * Never follow the student's pointer and never fly "home".
  * At session start, park near the student's pointer once (or a calm corner of that display),
    then stay there.
  * After pointing or drawing, she stays at the last spot.
* **Idle look:** after about 1.2 s with no flight, trace or speech-linked motion, fade the cursor
  to about 35% opacity and hide the name label. If the student's pointer comes within about
  60 px, fade further to about 12%. Return to full opacity the moment she moves.
  `src/renderer/overlay/cursor.ts` renders the cursor and its label. The overlay needs the
  student's pointer position; main already tracks it.
* **Multi-display:** when she needs another display, she flies there. Keep the per-overlay
  hand-off working.
* Takeover (`driving`) is unchanged: while driving, her cursor is the real pointer.
* Tests: update `test/unit/cursor.test.ts` and any e2e that waits for "flies back to follow".
  Add a unit test that it stays put while the student's mouse moves, and one for the idle-opacity
  state. Add an e2e screenshot of the dimmed, parked cursor.

### 2. Tuple's flat brush and font for all ink
* `src/renderer/ui/ink-render.ts` uses `perfect-freehand` (variable width, `simulatePressure`, glow
  `9–10`, tapers) and Caveat for text. Replace it with:
  * a **constant-width** Canvas stroke, `lineCap = lineJoin = 'round'`;
  * midpoint quadratic smoothing;
  * no glow, at most a barely visible shadow;
  * the participant colour (student orange, Ada blue as now), about 5–6 px at 1×.
* A single click or a zero-length stroke must draw a **dot** (a filled circle of the brush
  diameter). Check `src/renderer/overlay/draw.ts` and the student-stroke capture code: they must
  not drop one-point strokes.
* Highlights (`kind: 'highlight'`): flat, translucent, the same colour, no glow.
* `ring` becomes Tuple's highlight click: a dot that becomes a thin ring, expands, fades in about
  0.9 s, and repeats at most twice.
* Text (`kind: 'text'`): **system font, semibold**:
  `-apple-system, 'SF Pro Text', 'Inter Variable', sans-serif`.
  * Size about 18–20 px, in Ada's colour, no background or outline.
  * Typed in letter by letter at a human cadence: about 45–110 ms per character, longer pauses
    after spaces and punctuation, plus a caret while typing.
  * Add a setting "Ada writes notes: Typed (like Tuple) / Handwritten" with Typed as the
    default, so the old handwriting stays available. Log this in DECISIONS.md.
* The same renderer draws the whiteboard (`src/renderer/whiteboard/main.tsx`, `whiteboard.css`
  uses Caveat). Use the same brush there. `diagram.ts` text-width estimates must change with the
  font.
* `approxTextWidth` in `src/shared/ink-geometry.ts` assumes Caveat. Update it, because grounding,
  placement and tests use it.
* Tests: unit tests for the single-point dot, the constant width, and the smoothing staying within
  ±1 px of the input. Review e2e screenshots at 1× and 2×.

### 3. Declutter (Tuple-like: lots of features, little on screen)
Current inventory (see `docs/screenshots/*.png`):
* HUD bar: wide, about 10 buttons, `src/renderer/hud/Hud.tsx`.
* "Demo tutor" note under the HUD.
* Caption box: two lines, on by default (`captions: true`).
* "Ada can see this screen" pill, bottom right (`src/renderer/overlay/ui.ts`).
* Toasts ("Microphone muted").
* Step card, top right.
* Citation card.
* Veil outlines with labels.
* Cursor name label always on.
* Glowing ink.

Target:
* **HUD:** a small pill. It shows:
  * the course dot and timer;
  * the mic state;
  * Ada's state (speaking waveform or thinking);
  * a "can see" eye, which replaces the separate pill and still meets the always-visible privacy
    indicator requirement;
  * End.

  Hovering expands it to the full controls. Make it draggable, remember its position per
  display, and dim it when it isn't hovered.
* **Captions:** off by default. When on, show a single subtle line of Ada's current sentence that
  fades after about 4 s. Migrate existing settings with a settings version bump.
* **Toasts:** only when they carry information the HUD doesn't already show. Mute and pause are
  visible in the HUD, so no toast for those.
* **Demo note:** a tiny badge in the HUD instead of a banner.
* **Step card:** a compact single line ("2/3 · Hover Debug"), expanding on hover.
* **Citation:** a small chip that auto-hides (about 5 s).
* **Veil outline:** thin and subtle, with the label only for a few seconds after it appears.
* **Proximity fade:** every overlay element (cards, chips, Ada's cursor) fades to about 15% when
  the student's pointer approaches, so nothing ever blocks their work. Overlays stay
  click-through except the interactive consent card.
* Keep everything the features need, especially the consent, risky-action and driving
  indicators (safety). They can be tidier, but must stay obvious.
* Tests: e2e screenshots of a typical session before and after. Assert the number of visible
  overlay elements in an idle session (for example, HUD pill + Ada's dim cursor only).

### 4. Slower, human-varied pen
* Shapes come from `inkShapes`, seeded, in `src/shared/ink-geometry.ts`. Timing comes from
  `drawDurationFor` (0.75 ms/px, clamped to 320–1300 ms; text 55 ms/char).
* About 30% slower overall. Use a minimum-jerk speed profile per stroke, slower into corners, and
  80–200 ms pen lifts between sub-strokes (the cursor still travels between them).
* Per-mark variation from the seed, so no two marks are the same:
  * **Arrow:** shaft bow ±(4–12%) of length, random side; head angle 22–35°; head length 10–18
    px; slightly asymmetric sides; the head is sometimes drawn in one stroke and sometimes as two.
  * **Circle:** random start angle (mostly upper left) and direction, 8–25° overshoot, tilt ±4°,
    low-frequency radius wobble of 1.5–3%. It must still enclose the target. Keep the
    superellipse fit and the tests in `test/unit/shared.test.ts` / `snap.test.ts`.
  * **Underline:** tilt ±1.5°, gentle curve, ±4% length, occasional end hook.
  * **Box, check and cross:** similar.
* Tests: generate 20 arrows or circles with different seeds and assert they differ (not the same
  polyline) while staying within the target tolerance. Add a timing test. Pointing and
  calibration e2e must still pass.

### 5. Pointer-only gestures
* Add cursor-only beats: `follow_line` (glide along a line of text at reading speed while she
  talks about it), `hover` (rest on a target with no ring and no label) and `sweep` (move down a
  list of lines).
* Expose them through a new Live tool, for example
  `move_cursor({ target | path, style: 'hover' | 'follow_line' | 'sweep' })`, and as beat kinds
  in `explain_on_screen` (`src/main/session/features/visual.ts`, `beat-sync.ts`, `prompts.ts`).
* Grounding and own-UI exclusion are the same as for `point_at`.
* Update `prompts.ts` so she uses gestures often and ink sparingly, which also helps item 3. Add
  them to the scripted demo tutor (`src/main/gemini/mock-live.ts`) so they show up without a key.
* Tests: e2e checks that the cursor visits the target line's x-range over time while no ink item
  is created. Unit-test the beat scheduling.

### 6. A real Mac app (Dock)
* Add `npm run app`, which runs on the owner's Mac:
  * `electron-vite build`;
  * `electron-builder --mac --dir --arm64|--x64` (host arch) with `mac.identity: null`;
  * then `codesign --force --deep --sign - dist/mac-*/Pairwise.app` (ad-hoc; Apple Silicon needs
    a valid signature);
  * copy it to `/Applications` (or `~/Applications` if that's not writable) and `open` it.
* `electron-builder.yml` currently has `LSUIElement: true`, and `src/main/index.ts:53` hides the
  Dock icon. Make Pairwise a normal Dock app (it keeps its menu-bar icon too):
  * clicking the Dock icon opens the hub (`app.on('activate')` already does);
  * the Dock menu offers Start session and Quit.
* The packaged app gets its own keychain entry. The key saved by the dev build ("Electron Safe
  Storage") won't decrypt, so catch that in `src/main/settings.ts` and ask for the key again.
  macOS permissions must be granted again for "Pairwise". Ad-hoc signatures change on every
  rebuild, so permissions reset after each `npm run app`. Document all of this in BLOCKERS.md and
  the README.
* Optional extra: build the `.app` in CI or the cloud and ad-hoc sign it with `rcodesign`
  (apple-codesign), so the owner can download a zip. The downloaded app would be quarantined and
  need "Open Anyway". Building locally is simpler.
* Test: `electron-builder --mac --dir` works on Linux (it did before). Check `Info.plist` (no
  `LSUIElement`), the icon, and the asar unpack of natives. A real launch needs the Mac:
  BLOCKERS.md item.

### 7. Test, review, iterate (the owner asked for "a bunchhh")
* After each item, run `npm run typecheck && npm test` and the relevant e2e, then **look at the
  screenshots** in `test/artifacts/`. Repeat until it's right.
* At the end, run the full `npm run test:e2e`. Update PROGRESS.md (a "Round 2" section), the
  README demo script and screenshots, and DECISIONS.md. Commit and push.

## Environment notes for the next session

* The e2e suite needs Linux with `Xvfb`, `xcompmgr`, `tesseract-ocr` and `xdotool`, plus
  Electron's runtime libraries (`libnss3`, `libgbm1`, `libasound2`, `libgtk-3-0`…). Install with
  apt if missing. `node scripts/run-e2e.mjs <filter>` runs a subset. `E2E_SCALES=1,2` is the
  default for 03/05.
* Fake platform and fake displays are used in tests (`PAIRWISE_FAKE_PLATFORM`, `FAKE_DISPLAYS`
  1× and 2×). `PAIRWISE_MOCK_LIVE` is the local Gemini Live mock; `PAIRWISE_MOCK_SCRIPT=none`
  gives scripted control from tests.
* `npm install` downloads Electron via `scripts/ensure-electron.mjs`.
* The owner runs it on macOS with `npm run dev` today. After item 6:
  `git pull && npm install && npm run app`.
