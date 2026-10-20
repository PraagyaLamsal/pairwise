# Notices

Pairwise is original code. It contains **no code or assets from Tuple or HeyClicky**; those
products were studied from the outside (their public docs, shipped resources and behaviour — see
[docs/RESEARCH.md](docs/RESEARCH.md)) to learn what a great pairing call and pointing buddy feel
like, and every part of Pairwise was written from scratch.

## Clicky (MIT)

A handful of animation constants for the tutor's cursor were adapted from **Clicky**, the
open-source predecessor of HeyClicky, by Farza: the buddy's blue (`#3380FF`), its −35° resting
tilt, the follow offset and spring feel, the arcing Bézier flight (Clicky: 0.6–1.4 s, arc height
`min(distance × 0.2, 80)`; Pairwise tunes both), the landing pulse, and character-by-character
label streaming. The cursor is drawn and animated by Pairwise's own code
(`src/main/session/cursor.ts`, `src/renderer/overlay/cursor.ts`); no Clicky source was copied.

```
MIT License

Copyright (c) 2026 Farza

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Third-party packages shipped in the app

| Package | License | Used for |
|---|---|---|
| Electron | MIT | App shell |
| React, React DOM | MIT | Hub, HUD and whiteboard UI |
| Inter (via @fontsource-variable/inter) | SIL OFL 1.1 | Interface font |
| Caveat (via @fontsource/caveat) | SIL OFL 1.1 | The tutor's handwriting |
| perfect-freehand | MIT | Pressure-like stroke outlines for ink |
| uiohook-napi | MIT | Global hold-keys and instant takeover reclaim |
| @jitsi/robotjs | MIT | Mouse/keyboard for takeover (and pointer position on Linux) |
| get-windows | MIT | Window list for App Veil |
| pdfjs-dist | Apache-2.0 | Reading course PDFs |
| JSZip | MIT (dual MIT / GPL-3.0; used under MIT) | Reading PPTX/DOCX course files |
| ws | MIT | WebSocket (the local Live mock used by the demo tutor and tests) |

Gemini is a Google service used through its public API with the student's own key.
