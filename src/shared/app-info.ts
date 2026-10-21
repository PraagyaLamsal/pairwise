/** Single place to rename the product. Also update `productName` in package.json. */
export const APP_NAME = 'Pairwise';
export const APP_ID = 'app.pairwise.tutor';
export const TUTOR_DEFAULT_NAME = 'Ada';
export const NOTES_FOLDER_NAME = `${APP_NAME} Sessions`;

/** Default model ids, verified against ai.google.dev on 2026-10-19 (see DECISIONS.md D-003). */
export const DEFAULT_MODELS = {
  live: 'gemini-3.8-live',
  liveDeep: 'gemini-3.8-live-extended-thinking',
  vision: 'gemini-3.8-flash',
  reasoning: 'gemini-4-argon',
  text: 'gemini-3.8-flash',
  embedding: 'gemini-embedding-001',
} as const;

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
export const GEMINI_LIVE_PATH =
  '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** Prebuilt Gemini voices (native-audio Live models accept these names). */
export const VOICES: { name: string; vibe: string }[] = [
  { name: 'Kore', vibe: 'Firm, clear' },
  { name: 'Puck', vibe: 'Upbeat' },
  { name: 'Charon', vibe: 'Informative' },
  { name: 'Aoede', vibe: 'Breezy' },
  { name: 'Leda', vibe: 'Youthful' },
  { name: 'Orus', vibe: 'Firm' },
  { name: 'Zephyr', vibe: 'Bright' },
  { name: 'Fenrir', vibe: 'Excitable' },
  { name: 'Achird', vibe: 'Friendly' },
  { name: 'Sulafat', vibe: 'Warm' },
  { name: 'Iapetus', vibe: 'Clear' },
  { name: 'Vindemiatrix', vibe: 'Gentle' },
  { name: 'Gacrux', vibe: 'Mature' },
  { name: 'Despina', vibe: 'Smooth' },
  { name: 'Schedar', vibe: 'Even' },
  { name: 'Umbriel', vibe: 'Easy-going' },
];

/**
 * The hub's one-time "What's new" card: shown once to someone who already used Pairwise (not on
 * a fresh install, where onboarding says it all). Bump `id` for the next set of notable changes.
 */
export const WHATS_NEW = {
  id: '2026-10-round-2',
  items: [
    { icon: 'pointer', title: 'She traces your code like a debugger', text: 'Her cursor steps through the lines as they run, and the values appear beside each one.' },
    { icon: 'check', title: '“Show me” questions', text: 'Now and then she asks you to click the answer on your screen, and tells you if you got it.' },
    { icon: 'pen', title: 'A quieter screen, like a Tuple call', text: 'Her cursor stays where she leaves it and fades back. She mostly points.' },
    { icon: 'sparkle', title: 'Her marks stay with what they mark', text: 'Scroll, and they move with the code. Switch away, and they wait until you’re back.' },
    { icon: 'file', title: 'Notes that keep score', text: 'Your quick checks go into the notes, and the ones you missed come back next time.' },
    { icon: 'bolt', title: 'Lighter and steadier', text: 'Half the CPU when idle, Reduce motion respected, and Wi-Fi drops ridden out.' },
  ],
} as const;
