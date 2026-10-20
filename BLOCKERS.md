# Blockers — things only you can do

Everything below is stubbed or mocked so the app still runs; these steps switch on the real
thing. None of them are needed to *try* the app: without a key it runs a scripted demo tutor.

### B-1 · Gemini API key (needed for the real tutor)
1. Go to https://aistudio.google.com → **Get API key** → create a key in the project that has
   your credits.
2. In Pairwise: **Settings → Gemini → Replace key**, paste, **Save** (or paste it during
   onboarding). It's stored encrypted in your login keychain.
   *Alternative for development:* `export GEMINI_API_KEY=…` before `npm run dev`.
3. Optional: set a monthly cap in **Usage** (default $25).

### B-2 · macOS permissions (first launch walks you through these)
| Permission | Why | Where |
|---|---|---|
| Screen & System Audio Recording | the tutor sees your screen | System Settings → Privacy & Security → Screen & System Audio Recording → enable **Pairwise** (or **Electron** when running `npm run dev`) |
| Microphone | talking to the tutor | Privacy & Security → Microphone |
| Accessibility | hold-to-talk/draw keys, takeover, instant reclaim | Privacy & Security → Accessibility |

After enabling Screen Recording, quit and reopen the app (macOS requires it).
When running from source, macOS attributes permissions to **Electron** (or your terminal app) —
grant them there; the packaged app (`npm run dist:mac`) gets its own entries.

### B-3 · Automation prompts for auto-pause (optional)
The first time Pairwise pauses Spotify/Music/QuickTime, macOS asks "Pairwise wants to control
…". Click **OK**. If you decline, browser videos still pause with the media key.

### B-4 · Code signing / notarization (only to share the app)
`npm run dist:mac` builds an unsigned `.app`/`.dmg`, fine for your own Mac (right-click → Open
the first time). To distribute it you need an Apple Developer account ($99/yr) and to set
`CSC_LINK`/`APPLE_ID` for electron-builder.

### B-5 · Real-hardware checks I couldn't do from the sandbox
The sandbox has no Mac. Things verified only with fakes/mocks and worth a 10-minute check on
your machine (the README demo script walks through each):
* real Gemini Live audio (voice, interruption, captions) — needs B-1;
* ScreenCaptureKit capture with a Retina + external monitor;
* `Diagnostics → Pointing accuracy` with your key (reports pixel error per display);
* takeover via CGEvents (robotjs) and instant reclaim via uiohook — in particular that a
  trackpad nudge reclaims at once and that "scroll down" scrolls down (robotjs's scroll sign);
* App Veil window detection (get-windows) on your apps.

### B-6 · Optional: deeper runtime teardown of Tuple / HeyClicky
Both apps were downloaded and studied statically (bundle resources, the Tuple React UI through
REA's JavaScript analysis, strings, HeyClicky's demo videos — see docs/RESEARCH.md). The REA tools
that run on your Mac timed out from this session, so runtime tracing (Frida/Hopper) wasn't done.
Nothing in this build needs it.

### B-7 · Letting Pairwise read your course folders
Link each course's folder in **Courses → (course) → Link folder**. If the folder is in Documents,
Desktop, Downloads or iCloud Drive, macOS asks "Pairwise would like to access files in your …
folder" the first time — click **Allow**. (Under `npm run dev` the prompt names Electron or your
terminal.) Scanned PDFs without a text layer are listed as "no text layer"; export them with OCR
(Preview → Export as PDF doesn't add text; use your scanner app's OCR, or Adobe/`ocrmypdf`).
