/**
 * A new git worktree is seeded from its sibling checkout's verified index
 * (change: seed-worktree-index-from-sibling-checkout).
 *
 * Exercised on a real repository, a real analysis and a real `git worktree add`: the first
 * orient in the worktree answers from the seed with the `seeded` repair reason, a file the
 * worktree changed is the only one reported stale, and every unsafe seed is refused with
 * nothing copied, so the caller takes the ordinary cold build.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreInit } from '../../api/init.js';
import { openloreAnalyze } from '../../api/analyze.js';
import { dispatchTool } from '../services/tool-dispatch.js';
import { _resetRepairServiceForTesting, recordDetachedRepair } from '../services/cold-start-bootstrap.js';
import { seedFromSiblingCheckout, servingSeededIndex } from './seed-from-sibling.js';

const ANALYSIS = join('.openlore', 'analysis');

let base: string;
let main: string;
let worktrees = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
}

/** A fresh linked worktree of the main checkout, on its own branch. */
function addWorktree(): string {
  const path = join(base, `wt-${++worktrees}`);
  git(main, 'worktree', 'add', '-q', '-b', `branch-${worktrees}`, path);
  return realpathSync(path);
}

/** Run `mutate` against the main checkout's index, restoring it afterwards. */
async function withMainIndex(mutate: (analysisDir: string) => void, check: () => Promise<void>): Promise<void> {
  const analysisDir = join(main, ANALYSIS);
  const backup = join(base, 'index-backup');
  rmSync(backup, { recursive: true, force: true });
  cpSync(analysisDir, backup, { recursive: true });
  try {
    mutate(analysisDir);
    await check();
  } finally {
    rmSync(analysisDir, { recursive: true, force: true });
    cpSync(backup, analysisDir, { recursive: true });
  }
}

/** Nothing was published, and no staging directory was left behind. */
function expectUntouched(worktree: string): void {
  expect(existsSync(join(worktree, ANALYSIS))).toBe(false);
  const openlore = join(worktree, '.openlore');
  const left = existsSync(openlore) ? readdirSync(openlore).filter(name => name.startsWith('.analysis-seed-')) : [];
  expect(left).toEqual([]);
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-seed-')));
  main = join(base, 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  writeFileSync(join(main, 'src', 'tariff.ts'),
    'import { rate } from "./rate.js";\nexport function computeTariff(kwh: number): number { return kwh * rate(); }\n');
  writeFileSync(join(main, 'src', 'rate.ts'), 'export function rate(): number { return 0.12; }\n');
  writeFileSync(join(main, '.gitignore'), '.openlore/\n');
  git(main, 'init', '-q');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  await openloreInit({ rootPath: main });
  await openloreAnalyze({ rootPath: main });
}, 120_000);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  _resetRepairServiceForTesting();
  // A seeded worktree is itself a sibling with an index: remove each one, so every test sees
  // the main checkout as the only candidate.
  for (let n = 1; n <= worktrees; n++) {
    const path = join(base, `wt-${n}`);
    if (existsSync(path)) git(main, 'worktree', 'remove', '--force', path);
  }
});

describe('seeding a new worktree from a sibling checkout', () => {
  it('serves the first orient from the seed, with the repair reason `seeded`', async () => {
    const worktree = addWorktree();
    expect(existsSync(join(worktree, '.openlore'))).toBe(false);

    const seed = await seedFromSiblingCheckout(worktree);
    expect(seed).toMatchObject({ state: 'seeded', source: realpathSync(main) });
    expect(await servingSeededIndex(worktree)).toBe(true);

    recordDetachedRepair(worktree, 'seeded');
    const result = await dispatchTool('orient', { directory: worktree, task: 'compute tariff' }, worktree) as {
      notReady?: boolean;
      relevantFunctions?: Array<{ name: string }>;
      indexRepair?: { reason: string };
      indexStaleness?: unknown;
    };
    expect(result.notReady).toBeUndefined();
    expect(result.relevantFunctions?.map(fn => fn.name)).toContain('computeTariff');
    expect(result.indexRepair?.reason).toBe('seeded');
    // Nothing differs from the seed yet, so nothing is reported behind the working tree.
    expect(result.indexStaleness).toBeUndefined();
  });

  it('reports a file the worktree changed, and only that file, as behind the working tree', async () => {
    const worktree = addWorktree();
    writeFileSync(join(worktree, 'src', 'rate.ts'), 'export function rate(): number { return 0.15; }\n');

    expect((await seedFromSiblingCheckout(worktree)).state).toBe('seeded');
    const result = await dispatchTool('orient', { directory: worktree, task: 'compute tariff rate' }, worktree) as {
      relevantFiles?: string[];
      indexStaleness?: { staleFiles: string[] };
    };
    expect(result.relevantFiles).toEqual(expect.arrayContaining(['src/tariff.ts', 'src/rate.ts']));
    expect(result.indexStaleness?.staleFiles).toEqual(['src/rate.ts']);
  });

  it('stops reporting the seed once a rebuild publishes its own generation', async () => {
    const worktree = addWorktree();
    expect((await seedFromSiblingCheckout(worktree)).state).toBe('seeded');
    await openloreInit({ rootPath: worktree });
    await openloreAnalyze({ rootPath: worktree, force: true });
    expect(await servingSeededIndex(worktree)).toBe(false);
  }, 60_000);

  it('sweeps a staging copy whose writer died, and leaves a live peer\'s alone', async () => {
    const worktree = addWorktree();
    const openlore = join(worktree, '.openlore');
    mkdirSync(openlore);
    // A pid far above any real one is a dead writer; this process is a live one.
    const dead = join(openlore, '.analysis-seed-999999999-abandoned');
    const live = join(openlore, `.analysis-seed-${process.pid}-in-flight`);
    mkdirSync(dead);
    writeFileSync(join(dead, 'llm-context.json'), '{}');
    mkdirSync(live);
    expect(await seedFromSiblingCheckout(worktree)).toMatchObject({ state: 'seeded' });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    rmSync(live, { recursive: true, force: true });
  });

  it('never seeds a checkout that already has an index', async () => {
    expect(await seedFromSiblingCheckout(main)).toMatchObject({ state: 'not-seeded' });
  });

  it('refuses a sibling index whose artifacts do not match the manifest', async () => {
    const worktree = addWorktree();
    await withMainIndex(
      dir => writeFileSync(join(dir, 'llm-context.json'), `${readFileSync(join(dir, 'llm-context.json'), 'utf8')} `),
      async () => {
        expect(await seedFromSiblingCheckout(worktree)).toMatchObject({ state: 'not-seeded' });
        expectUntouched(worktree);
      },
    );
  });

  it('refuses a sibling index a build owns', async () => {
    const worktree = addWorktree();
    const runtime = join(main, '.openlore', 'runtime');
    mkdirSync(runtime, { recursive: true });
    const lock = join(runtime, '.analysis-owner.lock');
    writeFileSync(lock, JSON.stringify({ repository: main, pid: process.pid }));
    try {
      expect(await seedFromSiblingCheckout(worktree)).toMatchObject({ state: 'not-seeded', reason: 'a build owns the sibling index' });
      expectUntouched(worktree);
    } finally {
      unlinkSync(lock);
    }
  });

  it('refuses a sibling index that is mid-publish', async () => {
    const worktree = addWorktree();
    await withMainIndex(
      dir => writeFileSync(join(dir, 'generation.json'), JSON.stringify({ version: 1, state: 'publishing' })),
      async () => {
        expect(await seedFromSiblingCheckout(worktree)).toMatchObject({ state: 'not-seeded' });
        expectUntouched(worktree);
      },
    );
  });

  it.skipIf(process.platform === 'win32')('refuses a sibling index with a planted symlink', async () => {
    const worktree = addWorktree();
    const secret = join(base, 'secret.txt');
    writeFileSync(secret, 'not an artifact\n');
    await withMainIndex(
      dir => symlinkSync(secret, join(dir, 'vector-index', 'planted.json')),
      async () => {
        expect(await seedFromSiblingCheckout(worktree)).toMatchObject({ state: 'not-seeded' });
        expectUntouched(worktree);
      },
    );
  });

  it.skipIf(process.platform === 'win32')('refuses to write through a symlinked .openlore in the worktree', async () => {
    const worktree = addWorktree();
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(worktree, '.openlore'));
    expect(await seedFromSiblingCheckout(worktree)).toMatchObject({ state: 'not-seeded' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
