import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const dryRun = (env: Record<string, string> = {}) =>
  execFileSync(process.execPath, [join(root, 'scripts', 'build-app.mjs'), '--dry-run'], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });

describe('npm run app (Dock app)', () => {
  it('builds for this chip, signs ad hoc, installs into Applications and opens it — in that order', () => {
    const out = dryRun({ PAIRWISE_ARCH: 'arm64' });
    const cmds = out.split('\n').filter((l) => l.trim().startsWith('$ ')).map((l) => l.trim().slice(2));
    const idx = (re: RegExp) => cmds.findIndex((c) => re.test(c));
    const build = idx(/electron-vite build$/);
    const pack = idx(/electron-builder --mac dir --arm64 .*-c\.mac\.identity=null/);
    const sign = idx(/^codesign --force --deep --sign - .*dist\/mac-arm64\/Pairwise\.app$/);
    const verify = idx(/^codesign --verify --deep --strict/);
    const quit = idx(/^osascript .*app\.pairwise\.tutor.* to quit/);
    const copy = idx(/^ditto .*dist\/mac-arm64\/Pairwise\.app \/Applications\/Pairwise\.app$/);
    const open = idx(/^open \/Applications\/Pairwise\.app$/);
    expect([build, pack, sign, verify, quit, copy, open].every((i) => i >= 0), cmds.join('\n')).toBe(true);
    expect(build < pack && pack < sign && sign < verify && verify < quit && quit < copy && copy < open).toBe(true);
    // Quitting only if it's running (a plain "tell application" would launch it).
    expect(cmds[quit]).toMatch(/if application id "app\.pairwise\.tutor" is running then/);
  });

  it('uses dist/mac for Intel and a real certificate when one is given', () => {
    const out = dryRun({ PAIRWISE_ARCH: 'x64', PAIRWISE_SIGN_IDENTITY: 'Pairwise Local' });
    expect(out).toMatch(/electron-builder --mac dir --x64/);
    expect(out).toMatch(/codesign --force --deep --sign 'Pairwise Local' .*dist\/mac\/Pairwise\.app/);
  });

  it('the packaged app is a normal Dock app (no LSUIElement) and the script is wired up', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    expect(yml).not.toMatch(/^\s*LSUIElement:/m);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.app).toBe('node scripts/build-app.mjs');
    const main = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8');
    expect(main).not.toMatch(/dock\?\.hide\(\)/);
  });
});
