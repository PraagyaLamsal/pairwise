// Runs the Playwright-for-Electron end-to-end tests inside a private Xvfb display.
//   node scripts/run-e2e.mjs [test-name-filter]
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] ?? '';
const display = `:${90 + Math.floor(Math.random() * 9)}`;

mkdirSync(join(root, 'test', 'artifacts'), { recursive: true });

let xvfb = null;
let compositor = null;
if (process.platform === 'linux' && !process.env.DISPLAY_OVERRIDE) {
  xvfb = spawn('Xvfb', [display, '-screen', '0', '2560x1440x24', '-ac', '+extension', 'RANDR', '+extension', 'Composite', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 900));
  process.env.DISPLAY = display;
  // Transparent overlays only blend with what's under them when a compositor runs (as on macOS).
  if (spawnSync('which', ['xcompmgr']).status === 0) {
    compositor = spawn('xcompmgr', ['-n'], { stdio: 'ignore', env: process.env });
    await new Promise((r) => setTimeout(r, 400));
  } else console.log('(xcompmgr not found: transparent overlays will occlude screen captures)');
}

const tests = readdirSync(join(root, 'test', 'e2e'))
  .filter((f) => f.endsWith('.e2e.mjs') && f.includes(filter))
  .sort();

/** Tests that run a second time with Chromium forced to 2× (real HiDPI). */
const HIDPI = ['03-pointing', '05-calibration'];

let failed = 0;
let runs = 0;
for (const t of tests) {
  const scales = HIDPI.some((h) => t.startsWith(h)) ? (process.env.E2E_SCALES ?? '1,2').split(',') : ['1'];
  for (const scale of scales) {
    runs += 1;
    const name = scale === '1' ? t : `${t} @2×`;
    console.log(`\n▶ ${name}`);
    const r = spawnSync(process.execPath, [join(root, 'test', 'e2e', t)], { stdio: 'inherit', env: { ...process.env, PAIRWISE_E2E_SCALE: scale }, timeout: 300_000 });
    if (r.status !== 0) {
      failed += 1;
      console.log(`✗ ${name} (exit ${r.status ?? r.signal})`);
    } else console.log(`✓ ${name}`);
  }
}

if (compositor) compositor.kill();
if (xvfb) xvfb.kill();
console.log(`\n${runs - failed}/${runs} e2e runs passed`);
process.exit(failed ? 1 : 0);
