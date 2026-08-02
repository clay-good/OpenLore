/**
 * Walker corpus-boundary honesty (change: harden-walker-corpus-boundary).
 *
 * The file walker decides the analyzed corpus, and every downstream conclusion — dead code,
 * coverage gaps, blast radius — is only as honest as what the walker admits. These tests pin the
 * three ways the walker used to quietly serve a different corpus than it claimed:
 *
 *  - it stopped at `maxFiles` with no receipt, presenting a truncated prefix as the whole repo;
 *  - it pruned a directory before any file inside it was tested, so a documented `includePatterns`
 *    override under a skip/gitignored directory was a silent no-op;
 *  - it read only the root `.gitignore`, so files a nested `.gitignore` excludes entered the graph
 *    as analyzable source.
 *
 * Plus the two pure helpers the fixes lean on (POSIX normalization for the `ignore` package on
 * Windows, and the glob-free include-prefix).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileWalker, toPosixPath, includePatternPrefix } from './file-walker.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeRepo(prefix = 'ol-walk-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function write(repo: string, rel: string, content = 'export const x = 1;\n'): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('FileWalker — maxFiles truncation receipt', () => {
  it('carries a truncation marker (limit + where it stopped) when the cap is hit', async () => {
    const repo = makeRepo();
    for (let i = 0; i < 6; i++) write(repo, `f${i}.ts`);

    const result = await new FileWalker(repo, { maxFiles: 2 }).walk();

    expect(result.files.length).toBeLessThanOrEqual(2);
    expect(result.summary.truncated).toBeDefined();
    expect(result.summary.truncated?.limit).toBe(2);
    expect(typeof result.summary.truncated?.atPath).toBe('string');
  });

  it('does NOT mark truncation when the walk completes within the cap', async () => {
    const repo = makeRepo();
    write(repo, 'a.ts');
    write(repo, 'b.ts');

    const result = await new FileWalker(repo, { maxFiles: 100 }).walk();

    expect(result.files).toHaveLength(2);
    expect(result.summary.truncated).toBeUndefined();
  });

  it('does NOT mark truncation when the file count exactly equals the cap (a trailing empty dir is not overflow)', async () => {
    // The exact-fit boundary: one analyzable file fills a cap of 1, and a trailing sibling
    // directory holds nothing analyzable. Nothing was dropped — the corpus is complete, so it
    // must not be branded partial. `a/` sorts before the empty `b/`, which is the order that used
    // to trip a premature receipt.
    const repo = makeRepo();
    write(repo, 'a/only.ts');
    mkdirSync(join(repo, 'b'));

    const result = await new FileWalker(repo, { maxFiles: 1 }).walk();

    expect(result.files).toHaveLength(1);
    expect(result.summary.truncated).toBeUndefined();
  });

  it('bounds the post-cap probe: a huge trailing all-skipped subtree cannot make the walk re-scan the repo', async () => {
    // The cap fills inside subdir `a/` (a directory's files are always processed before its
    // parent's, so `a/` fills before the root files regardless of readdir order). The root then
    // holds >POST_CAP_PROBE_LIMIT non-source files that are all skipped by extension. Precise
    // truncation detection would scan every one looking for an overflow file; the probe bound stops
    // it, conservatively disclosing a partial corpus rather than re-walking the whole repository.
    const repo = makeRepo();
    write(repo, 'a/only.ts');
    for (let i = 0; i < 10_050; i++) writeFileSync(join(repo, `img${i}.png`), 'x');

    const started = Date.now();
    const result = await new FileWalker(repo, { maxFiles: 1 }).walk();

    expect(result.files).toHaveLength(1); // memory stays bounded at the cap
    expect(result.summary.truncated).toBeDefined(); // conservative disclosure, not silence
    expect(Date.now() - started).toBeLessThan(10_000); // bounded work, not a full re-scan
  }, 30_000);

  it('re-uses a walker instance cleanly without double-counting', async () => {
    const repo = makeRepo();
    write(repo, 'x.ts');
    write(repo, 'y.ts');

    const walker = new FileWalker(repo, { maxFiles: 100 });
    const first = await walker.walk();
    const second = await walker.walk();

    expect(first.files).toHaveLength(2);
    expect(second.files).toHaveLength(2);
    expect(second.summary.skippedCount).toBe(first.summary.skippedCount);
  });

  it('marks truncation when overflow files live in a sibling directory visited after the cap fills', async () => {
    // The false-negative guard: dir `a/` fills the cap, and admissible files remain in sibling
    // `b/` (processed later). The receipt must still fire — an under-disclosed partial corpus is
    // the exact failure the change prevents.
    const repo = makeRepo();
    write(repo, 'a/one.ts');
    write(repo, 'b/two.ts');
    write(repo, 'b/three.ts');

    const result = await new FileWalker(repo, { maxFiles: 1 }).walk();

    expect(result.files).toHaveLength(1);
    expect(result.summary.truncated).toBeDefined();
    expect(result.summary.truncated?.limit).toBe(1);
  });
});

describe('FileWalker — includePatterns override directory pruning', () => {
  it('admits files under a built-in skip directory (vendor) when included, siblings stay pruned', async () => {
    const repo = makeRepo();
    write(repo, 'index.ts');
    write(repo, 'vendor/mylib/keep.ts');
    write(repo, 'vendor/other/skip.ts');

    const result = await new FileWalker(repo, {
      includePatterns: ['vendor/mylib/**'],
    }).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('vendor/mylib/keep.ts');
    expect(paths.some((p) => p.endsWith('vendor/other/skip.ts'))).toBe(false);
    expect(paths).toContain('index.ts');
  });

  it('honors an include targeting a file inside a gitignored directory; the rest stays excluded', async () => {
    const repo = makeRepo();
    write(repo, '.gitignore', 'secret/\n');
    write(repo, 'secret/inc.ts');
    write(repo, 'secret/other.ts');

    const result = await new FileWalker(repo, {
      includePatterns: ['secret/inc.ts'],
    }).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('secret/inc.ts');
    expect(paths.some((p) => p.endsWith('secret/other.ts'))).toBe(false);
  });

  it('honors a leading-glob include pattern by descending into a pruned directory', async () => {
    // `**/*.ts` has no glob-free prefix, so it can match a file at any depth — the override must
    // force even a built-in skip directory (vendor) open, or the include is a silent no-op inside
    // every pruned tree.
    const repo = makeRepo();
    write(repo, 'top.ts');
    write(repo, 'vendor/keep.ts');

    const result = await new FileWalker(repo, { includePatterns: ['**/*.ts'] }).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('vendor/keep.ts');
    expect(paths).toContain('top.ts');
  });

  it('does not force-descend the whole tree for an ANCHORED root-only glob (/*.ts)', async () => {
    // `/*.ts` is anchored to the repo root, so it only matches root-level `.ts` — it must NOT
    // force a built-in skip directory open (that over-descent would walk node_modules etc.).
    const repo = makeRepo();
    write(repo, 'top.ts');
    write(repo, 'vendor/keep.ts');

    const result = await new FileWalker(repo, { includePatterns: ['/*.ts'] }).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('top.ts');
    expect(paths.some((p) => p.includes('vendor/'))).toBe(false);
  });

  it('leaves the pruning contract intact when no include patterns are set', async () => {
    const repo = makeRepo();
    write(repo, 'index.ts');
    write(repo, 'vendor/mylib/keep.ts');

    const result = await new FileWalker(repo).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    // vendor is a built-in skip directory — without an include it stays pruned.
    expect(paths.some((p) => p.includes('vendor/'))).toBe(false);
    expect(paths).toContain('index.ts');
  });
});

describe('FileWalker — nested .gitignore semantics', () => {
  it('excludes a file ignored only by a subdirectory .gitignore, counted under gitignore', async () => {
    const repo = makeRepo();
    write(repo, 'packages/app/index.ts');
    write(repo, 'packages/app/.gitignore', 'generated/\n');
    write(repo, 'packages/app/generated/gen.ts');

    const result = await new FileWalker(repo).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('packages/app/index.ts');
    expect(paths.some((p) => p.endsWith('generated/gen.ts'))).toBe(false);
    expect(Object.keys(result.summary.skippedReasons ?? {})).toContain('gitignore');
  });

  it('does not leak a nested .gitignore to a sibling directory', async () => {
    const repo = makeRepo();
    write(repo, 'packages/app/.gitignore', 'generated/\n');
    write(repo, 'packages/app/generated/gen.ts');
    write(repo, 'packages/lib/generated/keep.ts');

    const result = await new FileWalker(repo).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    // app's `generated/` rule must not affect lib's identically-named directory.
    expect(paths).toContain('packages/lib/generated/keep.ts');
    expect(paths.some((p) => p.endsWith('app/generated/gen.ts'))).toBe(false);
  });
});

describe('walker path helpers', () => {
  it('toPosixPath normalizes backslash separators (the ignore-package contract on Windows)', () => {
    expect(toPosixPath('packages\\app\\generated\\x.ts')).toBe('packages/app/generated/x.ts');
    expect(toPosixPath('already/posix.ts')).toBe('already/posix.ts');
    expect(toPosixPath('')).toBe('');
  });

  it('includePatternPrefix returns the glob-free leading directory', () => {
    expect(includePatternPrefix('vendor/mylib/**')).toBe('vendor/mylib');
    expect(includePatternPrefix('src/**/*.ts')).toBe('src');
    expect(includePatternPrefix('./bin/*.ts')).toBe('bin');
    expect(includePatternPrefix('foo.ts')).toBe('foo.ts');
    expect(includePatternPrefix('*.ts')).toBe('');
  });
});
