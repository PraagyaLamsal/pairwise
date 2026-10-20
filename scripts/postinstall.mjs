// Post-install sanity check. Never fails the install: it only reports which
// prebuilt native modules loaded, so a missing one is obvious before `npm run dev`.
import { createRequire } from 'node:module';
import { ensureElectron } from './ensure-electron.mjs';

const require = createRequire(import.meta.url);
const modules = [
  ['uiohook-napi', 'hold-to-talk / hold-to-draw hotkeys and instant takeover reclaim'],
  ['@jitsi/robotjs', 'AI takeover (mouse + keyboard) and media keys'],
  ['get-windows', 'App Veil window detection'],
];

const lines = [];
for (const [name, purpose] of modules) {
  try {
    require.resolve(name);
    lines.push(`  ✓ ${name.padEnd(16)} ${purpose}`);
  } catch {
    lines.push(`  ✗ ${name.padEnd(16)} missing — ${purpose} will be disabled`);
  }
}

const electronOk = ensureElectron();
lines.unshift(electronOk ? `  ✓ ${'electron'.padEnd(16)} the app itself` : `  ✗ ${'electron'.padEnd(16)} download failed — run: npx install-electron --no`);

console.log(`\nPairwise native modules (prebuilt, no compiler needed):\n${lines.join('\n')}`);
if (process.platform === 'darwin') {
  console.log('\nNext: npm run dev  — the onboarding window walks you through macOS permissions.\n');
}
