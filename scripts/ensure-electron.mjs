// Electron 44 no longer downloads its binary during `npm install`: it fetches it lazily the
// first time `require('electron')` runs. electron-vite only reads node_modules/electron/path.txt
// and fails with "Electron uninstall" when it's missing, so a fresh clone can't `npm run dev`.
// This makes sure the binary is there (run from postinstall and before dev/start/dist).
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export function electronReady() {
  try {
    const dir = dirname(require.resolve('electron/package.json'));
    const pathFile = join(dir, 'path.txt');
    if (!existsSync(pathFile)) return { ok: false, dir };
    return { ok: existsSync(join(dir, 'dist', readFileSync(pathFile, 'utf8').trim())), dir };
  } catch {
    return { ok: false, dir: null };
  }
}

export function ensureElectron({ quiet = false } = {}) {
  const state = electronReady();
  if (state.ok) return true;
  if (!state.dir) {
    console.error('Electron is not installed — run `npm install` first.');
    return false;
  }
  if (!quiet) console.log('Downloading the Electron app (one time, ~100 MB)…');
  const r = spawnSync(process.execPath, [join(state.dir, 'install.js')], { stdio: 'inherit' });
  if (r.status !== 0 || !electronReady().ok) {
    console.error('Electron download failed. Check your internet connection, then run: npx install-electron --no');
    return false;
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(ensureElectron() ? 0 : 1);
}
