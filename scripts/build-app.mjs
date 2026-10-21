// npm run app — Pairwise as a real Mac app you can keep in the Dock:
//   1. builds the code (electron-vite),
//   2. packages Pairwise.app for this Mac's chip (electron-builder --mac dir),
//   3. signs it ad hoc (Apple Silicon only runs signed code; no Apple account needed),
//   4. installs it in /Applications (or ~/Applications when that isn't writable), quitting a
//      running copy first, and
//   5. opens it.
//
//   npm run app -- --no-open             build and install, don't open
//   npm run app -- --dry-run             print the steps without running them (any OS)
//   npm run app -- --reset-permissions   also clear macOS's old Screen Recording /
//                                        Accessibility / Microphone entries for Pairwise
//   PAIRWISE_SIGN_IDENTITY="Pairwise Local" npm run app
//                                        sign with your own certificate instead, so macOS
//                                        keeps its permissions across rebuilds (BLOCKERS B-8)
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const dry = flags.has('--dry-run');
const arch = process.env.PAIRWISE_ARCH === 'x64' || process.env.PAIRWISE_ARCH === 'arm64' ? process.env.PAIRWISE_ARCH : process.arch === 'arm64' ? 'arm64' : 'x64';
const identity = process.env.PAIRWISE_SIGN_IDENTITY?.trim() || '-';
const BUNDLE_ID = 'app.pairwise.tutor';
const APP = 'Pairwise.app';
const bin = (name) => join(root, 'node_modules', '.bin', name);

const quote = (a) => (/^[\w./:=@+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
function step(title) {
  console.log(`\n▸ ${title}`);
}
function run(cmd, argv, { hint, allowFail = false, capture = false } = {}) {
  console.log(`  $ ${[cmd, ...argv].map(quote).join(' ')}`);
  if (dry) return { status: 0, stdout: '' };
  const r = spawnSync(cmd, argv, { cwd: root, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    console.error(`\n✗ ${cmd} failed${r.status === null ? '' : ` (exit ${r.status})`}.${hint ? `\n  ${hint}` : ''}`);
    process.exit(1);
  }
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'darwin' && !dry) {
  console.error('`npm run app` builds and installs the macOS app, so it has to run on a Mac.');
  console.error('(Elsewhere you can still check the packaging: npx electron-builder --mac --dir -c.mac.identity=null)');
  process.exit(1);
}

step('Building the app code');
run(bin('electron-vite'), ['build']);

step(`Packaging ${APP} for ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}`);
// No signing inside electron-builder (that needs an Apple Developer ID); signed below instead.
run(bin('electron-builder'), ['--mac', 'dir', `--${arch}`, '--publish', 'never', '-c.mac.identity=null'], {
  hint: 'electron-builder downloads the Electron app for macOS the first time: check your internet connection.',
});

// electron-builder writes dist/mac-arm64/ (Apple Silicon) or dist/mac/ (Intel).
const dist = join(root, 'dist');
const candidates = dry
  ? [join(dist, arch === 'arm64' ? 'mac-arm64' : 'mac', APP)]
  : (existsSync(dist) ? readdirSync(dist) : [])
      .filter((d) => d.startsWith('mac') && (arch === 'arm64' ? d.includes('arm64') : !d.includes('arm64')))
      .map((d) => join(dist, d, APP))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const built = candidates[0];
if (!built) {
  console.error(`\n✗ Couldn't find the packaged ${APP} under dist/.`);
  process.exit(1);
}

step(identity === '-' ? 'Signing it (ad hoc: fine for your own Mac)' : `Signing it as "${identity}"`);
// Finder/quarantine metadata makes codesign refuse ("resource fork … not allowed").
run('xattr', ['-cr', built], { allowFail: true });
run('codesign', ['--force', '--deep', '--sign', identity, built], {
  hint: identity === '-' ? 'codesign comes with the Xcode command line tools: xcode-select --install' : `Is "${identity}" a code-signing certificate in your login keychain? (security find-identity -p codesigning)`,
});
run('codesign', ['--verify', '--deep', '--strict', built]);

step('Installing');
let apps = '/Applications';
try {
  if (!dry) accessSync(apps, constants.W_OK);
} catch {
  apps = join(homedir(), 'Applications');
  if (!dry) mkdirSync(apps, { recursive: true });
}
const dest = join(apps, APP);
// A running copy is asked to quit first (it ends a live session properly and saves its notes).
run('osascript', ['-e', `if application id "${BUNDLE_ID}" is running then tell application id "${BUNDLE_ID}" to quit`], { allowFail: true });
if (!dry) {
  for (let i = 0; i < 40; i++) {
    const r = spawnSync('pgrep', ['-f', `${APP}/Contents/MacOS/Pairwise`], { encoding: 'utf8' });
    if (r.status !== 0) break;
    await sleep(250);
  }
}
run('rm', ['-rf', dest]);
// ditto keeps the bundle's symlinks, permissions and signature intact.
run('ditto', [built, dest]);

if (flags.has('--reset-permissions')) {
  step('Clearing old permission entries for Pairwise (you will be asked again)');
  for (const service of ['ScreenCapture', 'Accessibility', 'Microphone', 'ListenEvent', 'AppleEvents']) run('tccutil', ['reset', service, BUNDLE_ID], { allowFail: true });
}

if (!flags.has('--no-open')) {
  step('Opening Pairwise');
  run('open', [dest]);
}

console.log(`
✓ Pairwise is installed: ${dest}

  Keep it in the Dock: right-click its Dock icon → Options → Keep in Dock.
  The first time (and after each rebuild with an ad-hoc signature) macOS asks again for
  Screen & System Audio Recording, Microphone and Accessibility for "Pairwise" — the
  onboarding window walks you through it. If a switch is on but doesn't take effect, select
  Pairwise in that list, press −, and allow it again (or run: npm run app -- --reset-permissions).
  Your Gemini key from \`npm run dev\` can't be read by the app: paste it once in Settings → Gemini.
`);
