# Pairwise — build plan

Pairwise is a menu-bar app that feels like a Tuple call where the person on the other end is an
AI tutor ("Ada" by default). Pick a course, press Start Session, and the tutor can see your
screen, talk with you, glide its own cursor to things, draw on top of anything, walk you through
steps, and (only when you allow it) take the mouse and keyboard to demonstrate.

`[APP NAME]` was left open, so the working name is **Pairwise** (pair-programming + peer-to-AI).
It lives in one constant (`src/shared/app-info.ts`) plus `package.json` → easy to rename.

---

## 1. Stack choice (and why)

**Electron 44 + TypeScript + Vite**, React 19 for the app windows, a hand-written Canvas2D/DOM
renderer for the overlay, and three *prebuilt* N-API native modules for the OS-level parts:

| Need | Implementation | Why |
|---|---|---|
| Menu bar app, windows, global shortcuts, permissions status | Electron built-ins (`Tray`, `globalShortcut`, `systemPreferences`, `safeStorage`) | No native code needed |
| Screen frames (multi-monitor, HiDPI) | Chromium desktop capture (ScreenCaptureKit on macOS) in a hidden engine renderer | Hardware-accelerated, per-display streams, overlay windows excluded via content protection |
| Mic in / voice out with echo cancellation | `getUserMedia` (AEC/NS/AGC) + AudioWorklets in the same engine renderer | Chromium's AEC uses our own playback as the reference → barge-in works without headphones |
| Transparent click-through overlay on every display | One frameless transparent `BrowserWindow` per display, `screen-saver` level, all Spaces | Proven pattern; renderer is ours so visuals are fully controllable |
| Hold-to-talk / hold-to-draw / instant reclaim | `uiohook-napi` (prebuilt darwin-arm64/x64) | Key-up events + physical mouse movement, which `globalShortcut` can't see |
| AI takeover (mouse, keys, scroll, media keys) | `@jitsi/robotjs` (prebuilt universal darwin) | CGEvent-based, no compile step |
| App Veil window rectangles | `get-windows` (prebuilt N-API, CGWindowList) | Bounds + owner bundle id for every on-screen window |

Why not native Swift (what Tuple and Clicky use)? A Swift app would be marginally lighter and
could use the Accessibility tree, but this project was built and tested in a Linux sandbox where
macOS SDKs don't exist. Electron let every phase be **run end-to-end here** (under Xvfb, with a
mock Gemini Live server and a fake platform layer), and let the overlay visuals be screenshot-
reviewed and iterated. All macOS-specific code sits behind `src/main/platform/` so a Windows build
(or a Swift helper for AX snapping / Vision OCR) can be added later without touching the rest.
The trade-off is recorded in DECISIONS.md.

**Nothing needs compiling on your Mac.** `npm install` pulls prebuilt binaries; `npm run dev`
runs it; `npm run dist:mac` packages a `.app`/`.dmg`.

---

## 2. Gemini usage (checked against ai.google.dev on 2026-10-19)

| Role | Model (configurable) | How |
|---|---|---|
| Live voice + screen frames | `gemini-3.8-live` (or `gemini-3.8-live-extended-thinking`) | Raw Live API WebSocket (`v1beta` BidiGenerateContent): 16 kHz PCM in, 24 kHz PCM out, JPEG frames ≤ 1 fps, input+output transcription, server VAD, function calling (async `NON_BLOCKING`), context-window compression + session resumption |
| Grounding (where exactly is "the Run button"?) and reading small text | `gemini-3.8-flash`, `thinkingLevel: low` | `generateContent` with a full-resolution screenshot, `box_2d` 0–1000 boxes, optional zoom-in second pass |
| Deep reasoning / planning a drawing | `gemini-4-argon` | Called by the tutor through a `think_deeply` tool for proofs, traces, diagrams; returns an explanation outline + drawing plan |
| Course profile, session notes | `gemini-3.8-flash` | Glossary, notation, topic map; end-of-session notes |
| Embeddings for course search | `gemini-embedding-001` | Hybrid with local BM25; BM25-only when offline |

`generateContent` (labelled "legacy" but "fully supported") is used instead of the new
Interactions API because it is stateless — the Interactions API stores requests by default, and we
send screenshots.

### Latency & cost strategy
* Frames are sent **only when the screen changes** (64×40 luminance diff), at most 1 fps, ~1280 px
  JPEG, `mediaResolution: MEDIUM`. When you start talking, press push-to-talk or finish a drawing,
  a fresh frame plus a **zoomed crop** of what you are pointing at is sent immediately.
* Precise pointing never relies on the low-res live frames: the tutor calls `point_at` /
  `annotate` with a *description* (+ an approximate point it can see). The cursor starts flying
  toward the approximate point at once while Flash grounds the description on a full-res capture,
  then the cursor settles on the exact target. Drawings are revealed when audio playback reaches
  the moment the tool call was made, so ink lands in sync with the words.
* Every `usageMetadata` message is priced (per-modality, dated price table) into a usage meter with
  a monthly cap. At 80 % you get a warning; at 100 % sessions end gracefully.

---

## 3. Architecture

```
┌──────────────────────────── main process (Node) ─────────────────────────────┐
│ Tray/menu bar · hotkeys (globalShortcut + uiohook) · windows · settings      │
│                                                                              │
│  SessionController ── LiveClient (WebSocket) ── tool dispatcher              │
│     │      │                │                       │                         │
│     │   FrameScheduler   UsageMeter          Grounder (Flash) · Reasoner     │
│     │      │ (veil rects)                    CourseBrain (ingest · index)    │
│     │   VeilService (get-windows)            TakeoverController (robotjs)    │
│     │                                        MediaController · NotesWriter   │
└─────┼────────────────────────────────────────────────────────────────────────┘
      │ IPC (typed channels, src/shared/ipc.ts)
 ┌────┴───────────┬───────────────────┬──────────────────┬──────────────────┐
 │ Engine (hidden)│ Overlay × N       │ HUD (floating)   │ Hub (React)      │
 │ mic → worklet  │ cursor, ink, draw │ timer, mic meter │ courses, settings│
 │ → 16k PCM      │ mode, step card,  │ captions, mute,  │ onboarding,      │
 │ speaker ← 24k  │ veil outlines,    │ mode, end        │ usage, shortcuts │
 │ screen streams │ driving banner    │                  │ whiteboard       │
 └────────────────┴───────────────────┴──────────────────┴──────────────────┘
```

* **Global coordinate space** = Electron screen DIPs (top-left origin, multi-display aware).
  Every frame sent to Gemini carries a `FrameRef` (display id + DIP rect + pixel size), so any
  0–1000 coordinate from any model maps back exactly. Each overlay renders the *global* scene
  translated by its display origin, so a cursor gliding between monitors just works.
* **Overlay windows are content-protected**, so our own ink is never in the frames the tutor sees;
  when the student draws, their strokes are composited onto the snapshot explicitly.

---

## 4. Privacy model
* The tutor only sees the screen **during a session**; capture stops instantly on End/Pause.
* **App Veil**: windows of chosen apps (Messages, Keychain Access, 1Password, Telegram … by
  default) and notification banners are painted black *on the frame canvas before encoding*, so
  nothing veiled ever leaves the machine. Veiled windows get a dashed orange outline locally so
  you know they're hidden.
* A persistent "Ada can see this screen" pill + menu-bar indicator while vision is on.
* Screenshots are never written to disk unless you enable "save annotated screenshots in notes".
* API key stored with `safeStorage` (macOS Keychain-backed encryption).

---

## 5. Phases & acceptance checks

| Phase | Done when |
|---|---|
| 1 Shell | Tray menu, course picker, Start/End session (+ hotkeys, timer), overlays on every display (incl. hot-plug), onboarding shows real permission states |
| 2 Capture + voice | Change-driven frames + hi-res on demand, multi-display/HiDPI mapping; Live session with hands-free & push-to-talk, barge-in, live captions; reconnect/resume |
| 3 Cursor + ink | Labeled cursor flies to grounded targets; hand-drawn arrows/circles/highlights/underlines/text/step badges/diagrams timed to speech; student draw mode → one question; auto-pause media; step-by-step guide that waits and checks; **coordinate accuracy test** |
| 4 Course brain | Folder ingestion (PDF, PPTX, DOCX, MD/TXT, VTT/SRT, code), hybrid search, citations, out-of-scope flag, course profile, assignment mode |
| 5 Takeover | Consent card, "Ada is driving" banner + screen glow, actions, reclaim on any mouse move/Esc within one event, risky-action gate |
| 6 Polish | App Veil, notes, replay, shortcut editor, usage meter + cap, resumable sessions, celebration, whiteboard, settings |

Each phase: run → test against the feature list → fix → update PROGRESS.md.

## 6. Testing strategy
* **Unit/integration (vitest)**: geometry, Live protocol client vs a mock Live server that speaks
  the documented wire protocol, orchestrator flows, grounding mapping, takeover state machine,
  veil masking (pixel-checked), ingestion of generated PDF/PPTX/DOCX fixtures, search, pricing.
* **E2E (Playwright `_electron` under Xvfb)**: launches the real app with a fake platform layer
  and the scripted mock tutor, drives a full session, asserts on state and takes screenshots that
  were reviewed for visual quality.
* **On your Mac (needs your key + permissions)**: the built-in *Diagnostics → Pointing accuracy*
  test shows targets on every display, asks Gemini to find them and reports pixel error.
