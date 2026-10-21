// Debugging sticky ink: replays looks dumped by scripts/debug/sticky-dump.mjs through the real
// tracker (Node 22.18+ runs this TypeScript directly).
//   node scripts/debug/replay-track.mts <dump dir>              every look in order, as the engine took them
//   node scripts/debug/replay-track.mts <dump dir> <ref> <cur>  one judge() of look <cur> against look <ref>
// To see inside judge() (per-anchor scores along the search), add logging to the copy it loads.
// The first dumped look starts the tracker afresh (the engine had seen the group before), so
// the sequence's first verdict differs from the dump's; the ones after it should match.
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Gray, PxBox } from '../../src/renderer/engine/ink-track.ts';

// The project isn't an ES module package: load the tracker from an .mts copy.
const copy = join(mkdtempSync(join(tmpdir(), 'pw-track-')), 'ink-track.mts');
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'engine', 'ink-track.ts'), copy);
const { InkTracker, judge } = (await import(pathToFileURL(copy).href)) as typeof import('../../src/renderer/engine/ink-track.ts');

interface Look {
  t: number;
  again?: boolean;
  w: number;
  h: number;
  gray?: string;
  mask?: string;
  groups?: { key: string; boxes: PxBox[]; ids: string[]; parked: { id: string; box: PxBox }[]; away: boolean }[];
  results: unknown[];
}

const [dir, refArg, curArg] = process.argv.slice(2);
const looks: Look[] = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).frames;
const load = (i: number): { g: Gray; m: Uint8Array } => {
  const f = looks[i];
  if (!f.gray || !f.mask) throw new Error(`look ${i} was a shortcut (screen unchanged): no image`);
  return { g: { width: f.w, height: f.h, data: new Uint8Array(readFileSync(join(dir, f.gray))) }, m: new Uint8Array(readFileSync(join(dir, f.mask))) };
};

if (refArg != null && curArg != null) {
  const ref = load(Number(refArg));
  const cur = load(Number(curArg));
  const boxes = looks[Number(curArg)].groups![0].boxes;
  console.log(JSON.stringify(judge(ref.g, ref.m, cur.g, cur.m, boxes)));
} else {
  const tracker = new InkTracker();
  looks.forEach((f, i) => {
    if (f.again) {
      const r = (f.results as { key: string }[]).map((x) => ({ key: x.key, ...tracker.again(x.key) }));
      console.log(i, f.t, 'again', JSON.stringify(r), '| engine said', JSON.stringify(f.results));
      return;
    }
    const { g, m } = load(i);
    const r = f.groups!.map((x) => ({ key: x.key, ...tracker.step(x.key, g, m, x.boxes, x.ids, x.parked, x.away) }));
    console.log(i, f.t, JSON.stringify(r), '| engine said', JSON.stringify(f.results));
  });
}
