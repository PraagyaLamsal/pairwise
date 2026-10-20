import { app } from 'electron';

/**
 * Runtime switches. All default to "real" behaviour; the PAIRWISE_* variables exist so the
 * whole app can run end-to-end in CI / on Linux without macOS APIs or an API key.
 */
export const env = {
  isDev: !app.isPackaged,
  isMac: process.platform === 'darwin',
  /** Replace OS integrations (permissions, input hooks, input driver, window list) with fakes. */
  fakePlatform: process.env.PAIRWISE_FAKE_PLATFORM === '1',
  /** Force the scripted local mock tutor even if an API key exists. */
  mockLive: process.env.PAIRWISE_MOCK_LIVE === '1',
  /** Live WebSocket URL override (tests point this at test/mock-live). */
  liveUrl: process.env.PAIRWISE_LIVE_URL,
  /** REST base override for generateContent/embeddings (tests). */
  restBase: process.env.PAIRWISE_REST_BASE,
  /** JSON array of fake displays: [{"bounds":{...},"scaleFactor":2,"label":"..."}] */
  fakeDisplays: process.env.PAIRWISE_FAKE_DISPLAYS,
  /** Exposes extra IPC hooks used by the Playwright e2e tests. */
  e2e: process.env.PAIRWISE_E2E === '1',
  userDataDir: process.env.PAIRWISE_USER_DATA,
  apiKeyFromEnv: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
};
