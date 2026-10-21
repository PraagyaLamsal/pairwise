# Blockers — things only you can do

Everything below is stubbed or mocked so the app still runs; these steps switch on the real
thing. None of them are needed to *try* the app: without a key it runs a scripted demo tutor.

### B-1 · Gemini API key (needed for the real tutor)
1. Go to https://aistudio.google.com → **Get API key** → create a key in the project that has
   your credits.
2. In Pairwise: **Settings → Gemini → Replace key**, paste, **Save** (or paste it during
   onboarding). It's stored encrypted in your login keychain.
   *Alternative for development:* `export GEMINI_API_KEY=…` before `npm run dev`.
   **Paste it once more in the app.** The Dock app (`npm run app`) has its own keychain entry,
   so it can't read a key saved by `npm run dev` (and the other way round). It notices, opens
   Settings → Gemini and says so; paste the key there once.
3. Optional: set a monthly cap in **Usage** (default $25).

### B-2 · macOS permissions (first launch walks you through these)
| Permission | Why | Where |
|---|---|---|
| Screen & System Audio Recording | the tutor sees your screen | System Settings → Privacy & Security → Screen & System Audio Recording → enable **Pairwise** (or **Electron** when running `npm run dev`) |
| Microphone | talking to the tutor | Privacy & Security → Microphone |
| Accessibility | hold-to-talk/draw keys, takeover, instant reclaim | Privacy & Security → Accessibility |

After enabling Screen Recording, quit and reopen the app (macOS requires it).
The Dock app (`npm run app`) is **Pairwise** in these lists. When running from source
(`npm run dev`), macOS attributes permissions to **Electron** (or your terminal app) instead —
grant them there. See B-8 for what happens after a rebuild.

### B-3 · Automation prompts for auto-pause (optional)
The first time Pairwise pauses Spotify/Music/QuickTime, macOS asks "Pairwise wants to control
…". Click **OK**. If you decline, browser videos still pause with the media key.

### B-4 · Code signing / notarization (only to share the app)
`npm run app` signs the app ad hoc, which is all your own Mac needs. `npm run dist:mac` builds
unsigned DMGs. To give the app to others you need an Apple Developer account ($99/yr) and to set
`CSC_LINK`/`APPLE_ID` for electron-builder (Developer ID signing + notarization).

### B-5 · Real-hardware checks I couldn't do from the sandbox
The sandbox has no Mac. Things verified only with fakes/mocks and worth a 10-minute check on
your machine (the README demo script walks through each):
* round 2: `npm run app` end to end (build, sign, install, open), the Dock icon opening the hub,
  the Dock menu (Start session / Resume / End), ⌘C/⌘V in the key field;
* round 2: the session pill opening on hover while Pairwise isn't the active app (macOS panels
  normally get mouse-over events; if it doesn't open, click it once), and dragging it;
* round 2: the feel of the idle cursor (35 %) and the proximity fade on a Retina screen;
* round 2: how often the real Gemini Live model uses `move_cursor` vs `annotate` (the prompt
  asks for gestures first; tell me if it still draws too much);
* polish: a real **trace** ("what does `factorial(3)` return?") — are the values right, and do
  the chips land just after your editor's lines? And a few **"Show me"** questions (Settings →
  Tutor → Quick checks sets how often);
* polish: the **"Notes saved"** notification after a session (System Settings → Notifications →
  Pairwise must allow it), **Reduce motion** with the system setting on, and Pairwise's CPU in
  Activity Monitor during an idle session;
* polish: a Wi-Fi drop mid-session (turn Wi-Fi off for ~20 s): the pill should say
  "reconnecting…" and the session continue;
* polish: **sticky ink** in your own editor and browser — ask for a trace, then scroll with the
  trackpad (the marks should catch up within about a quarter of a second), drag the editor
  window by its title bar (they should go with it), switch apps (they should hide after about a
  second) and switch back (they should come back). With marks up on a still screen, the "Pairwise Helper"
  processes in Activity Monitor should stay about as low as without marks (if not, turn it off
  in Settings → Cursor & ink and tell me);
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

### B-8 · The Dock app on your Mac (`npm run app`)
1. In the project folder: `git pull && npm install && npm run app`. It builds `Pairwise.app` for
   your chip, signs it ad hoc, puts it in `/Applications` (or `~/Applications` if that folder
   isn't writable) and opens it. It needs the Xcode command line tools for `codesign`
   (`xcode-select --install` if macOS asks).
2. **Keep it in the Dock:** right-click its Dock icon → **Options → Keep in Dock**.
3. **Permissions:** macOS asks for Screen & System Audio Recording, Microphone and
   Accessibility for **Pairwise** (not Electron) the first time. Onboarding walks you through it;
   quit and reopen after enabling Screen Recording.
4. **After each rebuild** the ad-hoc signature changes, and macOS may treat the new build as a
   different app: a switch can look on but not work. Either select Pairwise in that list, press
   **−**, and allow it again when asked, or run `npm run app -- --reset-permissions` (clears
   Pairwise's entries with `tccutil` so macOS asks fresh).
   *To keep permissions across rebuilds:* create a code-signing certificate once in **Keychain
   Access → Certificate Assistant → Create a Certificate…** (name it "Pairwise Local",
   Certificate Type **Code Signing**), then build with
   `PAIRWISE_SIGN_IDENTITY="Pairwise Local" npm run app`.
5. **API key:** paste it once in the app (B-1).
6. If macOS says the app "is damaged" or can't be opened (it shouldn't for a local build), run
   `xattr -cr /Applications/Pairwise.app` and open it again.
