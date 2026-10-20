# Research notes: Tuple, heyclicky and the Gemini API (October 2026)

What was studied, how, and what Pairwise took from it. Observations are marked as such;
anything inferred is called an inference.

## How the research was done

| Target | What was examined | Tools |
|---|---|---|
| **Tuple 3.3.10** (macOS, Oct 8 2026) | The shipped app bundle from `tuple.app/download/mac`: resources, frameworks, Lottie files, the bundled React UI (`client-ui`), binary strings | REA `analyze_javascript_application` (CLI `rea-agents` 6.7.0) on the React bundle; 7-Zip, `strings` for the native parts |
| | docs.tuple.app: App Veil, paint, highlight click, text annotation, reactions, cursor colors, hotkeys, remote control | web |
| **HeyClicky 1.0.53** (macOS, Oct 2 2026) | The shipped DMG from heyclicky.com (GitHub release): resources, bundled demo videos, model-instruction files, binary strings | 7-Zip, `strings`, `ffmpeg` frame extraction |
| | heyclicky.com + full public changelog (v1.0 → v1.0.53) | web |
| **Clicky** (MIT, open-source predecessor of HeyClicky) | Complete Swift source: overlay, cursor animation, design tokens, element detection | normal source reading |
| **Gemini API** | Models page, Live API capabilities / session / tools pages, WebSocket reference, gemini-3.8-live model card, thinking, media resolution, image understanding, pricing | web |

The REA tools that run on your Mac (through the Claude desktop app) timed out from this session
(`binary_session` gave no response after 120 s), so the device-side Frida/Hopper workflows weren't
available. Static analysis was enough to understand the features. Pairwise contains **no code or
assets from Tuple or HeyClicky**; the only borrowed animation constants come from the MIT-licensed
Clicky source and are credited in `NOTICE.md`.

---

## Tuple — what matters for an AI pair

* **App Veil** (docs + binary): chosen apps' windows are hidden from the pair. On the sharer's own
  screen, veiled windows get a **dashed orange border**; a menu under the window can "Reveal This
  Window" (outline turns purple, label says "Visible"). Defaults: Messages, Keychain Access, plus
  Telegram and 1Password when installed. A separate "Hide all notifications" option. The binary has
  an `app.tuple.window-veil` XPC service and an `app-veil-wallpaper` asset. *Inference:* the pair
  sees a patterned placeholder rather than the window.
* **Paint**: every participant has one color for cursor, strokes, text and highlight clicks
  (11 swatches or Automatic). Strokes **fade after 2 s** by default, or persist until right-click;
  Shift = straight line; right-click clears.
* **Highlight click**: a pulsing indicator that lasts a few seconds — draws attention without
  getting in the way.
* **Text annotations** (with emoji picker) and **reactions**: small emoji plus full-screen Lottie
  reactions (`ship-it.json`, `table-flip.json`, `this-is-fine.json` ship in the bundle).
* **Remote control**: whoever controls has a colored ring around their avatar; cursors show name
  labels when someone joins, takes control or starts annotating.
* **Menu-bar popover** app with hotkeys for everything (MASShortcut framework), connect/disconnect
  tones, and "speaking while muted" notifications.

## HeyClicky — how the buddy points and draws

From the changelog (public) and the shipped binary's strings (observed):

* **Two-tier brain.** A realtime voice model handles the conversation. For anything about the
  screen it calls a `send_to_higher_model` tool; a frontier model looks at a screenshot and returns
  **"tag-first beat lines"**, one visual tag followed by the sentence to say with it, e.g.
  `[TARGET:120,210,40:add modifier] Click Add Modifier to open the list.`
  The voice model is told to "deliver it essentially as written, same lines, same order", and a
  `RealtimeWalkthroughSync` component (with `beatFractions`) reveals each beat's marks as that line
  is spoken.
* **Visual vocabulary** (regexes in the binary): `[POINT:x,y:label:screenN]`, `[HIGHLIGHT:…]` for a
  work area, `[SHAPE:line|arrow|circle|curve|polygon:…]` (circles given as center + a point on the
  ring's edge), `[TARGET:x,y,r:label]` and `[HOVER:x,y,r:label]` for steps the app can observe.
* **Walkthroughs** (v1.0.26, v1.0.48): "step-by-step guidance that detects clicks", up to 15 steps.
  A TARGET is used only when the next step is a click/hover the app can observe, recapture and
  continue from. For manual work (typing, dragging a slider) it highlights the area and says
  "when it looks right, say continue" instead of faking a target.
* **Spatial context**: hold the keys, circle something, ask. The app describes the gesture ("circled
  the …", "scribbled over the …") and harvests **accessibility text inside the highlighted region**
  so the model gets exact strings.
* **Look**: "hand-drawn, Excalidraw-style annotations" (v1.0.40, a `SketchStrokeGenerator`),
  highlights fade after 2 s (v1.0.31), cursor color picker, faces/characters per helper (v1.0.49).
  The bundled `clicky-spatial-demo.mp4` shows the student's stroke as a thick translucent marker
  with a small waveform under the cursor while listening.
* **Voice**: hold ⌃⌥ to talk (also used to draw), echo cancellation for barge-in (v1.0.24), voice
  speed 0.5–1.5× (v1.0.45).

From the open-source Clicky (MIT): the buddy is a 16 pt `#3380FF` triangle rotated −35° with a
glow, following the pointer at (+35, +25) on a spring (response 0.2 s, damping 0.6). It flies on a
quadratic Bézier (duration ∝ distance, 0.6–1.4 s, arc height min(d·0.2, 80)), faces its direction
of travel, scales up to 1.3× mid-flight, lands, streams a short label character by character
(30–60 ms each), holds ~3 s and flies back. Listening = 5-bar waveform, thinking = spinner.

## Gemini API facts the build depends on (checked 2026-10-19)

* **Models**: `gemini-3.8-live` (default Live model), `gemini-3.8-live-extended-thinking`,
  `gemini-3.8-flash` (stable; thinking low/medium/high, no "minimal"), `gemini-3.5-flash-lite`,
  `gemini-4-argon` (flagship reasoning), `gemini-embedding-001`. The Gemini 2.5 Computer Use model
  has been shut down.
* **Live API on 3.8**: omit `thinkingConfig` entirely; function calls are **NON_BLOCKING by
  default** (`behavior: BLOCKING` for synchronous), with response `scheduling` SILENT / WHEN_IDLE /
  INTERRUPT placed inside the `response` object; proactive audio is always on; affective dialog
  was removed; `turnCoverage` defaults to `TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO`.
* Audio in: 16-bit PCM 16 kHz (`audio/pcm;rate=16000`); out: 24 kHz. Frames: JPEG/PNG, **≤ 1 fps**.
  Context window 128k tokens. Connections last ~10 min (GoAway warns first); session resumption
  handles stay valid 2 h; `contextWindowCompression: { slidingWindow: {} }` removes the
  2-minute audio+video session cap.
* **`clientContent` interrupts any current generation** — context notes must not be sent while
  the tutor is talking.
* Server messages include `voiceActivity` (`ACTIVITY_START`/`ACTIVITY_END`),
  `interimInputTranscription`, `usageMetadata` with per-modality details.
* **Spatial output**: `box_2d` = `[ymin, xmin, ymax, xmax]` normalized 0–1000 (examples use
  gemini-3.8-flash). Image tokens on Gemini 3/4: low 280, medium 560, high 1120 (default), ultra-high
  2240. Video frames: 70 tokens each (280 at high).
* **Prices** (paid tier, per 1M tokens): 3.8 Live — input text $0.75, audio $3.00, image/video
  $1.00; output text $4.50, audio $12.00. 3.8 Flash — $0.75 / $3.75 until Dec 31 2026, then
  $1.50 / $7.50. 4 Argon — $2 / $10 until Nov 30 2026, then $4 / $20.

## What Pairwise adopted

| Idea | Source | In Pairwise |
|---|---|---|
| Voice model + stronger planner that returns marks *with* the lines to say, revealed as each line is spoken | HeyClicky beats | `explain_on_screen` tool → Flash plans beats on a full-res screenshot → the Live model narrates → ink is revealed when the audio reaches each line |
| Click-to-advance steps; "say continue" for steps the app can't observe | HeyClicky walkthroughs | `guide_step` with `expect: click / hover / screen / manual`, detected with global mouse hooks + screen-change checks |
| Buddy cursor that follows yours, swoops on an arc, streams a label | Clicky (MIT) | Overlay cursor engine, same feel, own drawing |
| Hand-drawn marks that fade after a while; Shift for straight lines; right-click clears | Tuple + HeyClicky | Ink renderer, configurable fade |
| Pulsing "look here" indicator | Tuple highlight click | `ring` ink kind / step targets |
| Veiled windows outlined in dashed orange on your own screen | Tuple App Veil | Same convention; pixels are blacked out before encoding |
| Hold ⌃⌥ to talk and draw | HeyClicky | Default "ask" chord |
| Emoji / full-screen reactions | Tuple | Celebration burst when you get something right |
