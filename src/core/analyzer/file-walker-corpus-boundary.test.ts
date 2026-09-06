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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
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

  it('includePatternPrefix: ./, leading /, mid-segment glob, empty, whitespace, negation', () => {
    // Each drives a distinct force-descent decision, so a shift here silently changes which
    // directories the walker opens.
    expect(includePatternPrefix('./')).toBe('');
    expect(includePatternPrefix('/foo/bar/**')).toBe('foo/bar'); // single leading / stripped
    expect(includePatternPrefix('/*.ts')).toBe(''); // anchored root-only glob → no prefix
    expect(includePatternPrefix('a*/b')).toBe(''); // glob in first segment stops the walk
    expect(includePatternPrefix('   ')).toBe('   '); // NOT trimmed — pins current behavior
    expect(includePatternPrefix('!foo')).toBe(''); // '!' is a glob-class char → no prefix
  });

  it('toPosixPath handles mixed separators without touching forward slashes', () => {
    expect(toPosixPath('.\\a\\b')).toBe('./a/b');
    expect(toPosixPath('/abs\\path\\x.ts')).toBe('/abs/path/x.ts');
    expect(toPosixPath('a/b/c')).toBe('a/b/c');
  });
});

describe('FileWalker — includePatterns override nested exclusions', () => {
  it('overrides a NESTED .gitignore, not just the root one', async () => {
    // The fix must reach an include target under a subdirectory .gitignore. If nested-scope
    // exclusion were checked before the include, `inc.ts` would silently vanish.
    const repo = makeRepo();
    write(repo, 'packages/app/.gitignore', 'generated/\n');
    write(repo, 'packages/app/generated/inc.ts');
    write(repo, 'packages/app/generated/other.ts');

    const result = await new FileWalker(repo, {
      includePatterns: ['packages/app/generated/inc.ts'],
    }).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('packages/app/generated/inc.ts');
    expect(paths.some((p) => p.endsWith('generated/other.ts'))).toBe(false);
  });

  it('wins over an excludePatterns rule targeting the same subtree', async () => {
    // include and exclude naming the same subtree is the direct-conflict case; only the
    // explicitly-included file survives, its sibling stays excluded.
    const repo = makeRepo();
    write(repo, 'src/keep/inc.ts');
    write(repo, 'src/keep/other.ts');

    const result = await new FileWalker(repo, {
      excludePatterns: ['src/keep'],
      includePatterns: ['src/keep/inc.ts'],
    }).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('src/keep/inc.ts');
    expect(paths.some((p) => p.endsWith('keep/other.ts'))).toBe(false);
  });

  it('honors several include patterns at once, including a deep a/b/c/** prefix', async () => {
    // Each prefix must force its own branch of a pruned tree (vendor) open independently.
    const repo = makeRepo();
    write(repo, 'vendor/a/keep.ts');
    write(repo, 'vendor/a/skip.ts');
    write(repo, 'vendor/b/deep/x.ts');
    write(repo, 'vendor/b/shallow.ts');

    const result = await new FileWalker(repo, {
      includePatterns: ['vendor/a/keep.ts', 'vendor/b/deep/**'],
    }).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('vendor/a/keep.ts');
    expect(paths).toContain('vendor/b/deep/x.ts');
    expect(paths.some((p) => p.endsWith('vendor/a/skip.ts'))).toBe(false);
    expect(paths.some((p) => p.endsWith('vendor/b/shallow.ts'))).toBe(false);
  });
});

describe('FileWalker — nested .gitignore advanced semantics', () => {
  it('applies a same-file negation (!keep.log after *.log) inside a nested .gitignore', async () => {
    // Nested scopes carry full gitignore semantics within their own file, not just plain
    // excludes: `keep.log` survives the negation, `a.log` does not.
    const repo = makeRepo();
    write(repo, 'logs/.gitignore', '*.log\n!keep.log\n');
    write(repo, 'logs/a.log', 'x\n');
    write(repo, 'logs/keep.log', 'x\n');
    write(repo, 'logs/app.ts');

    const result = await new FileWalker(repo).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('logs/keep.log');
    expect(paths).toContain('logs/app.ts');
    expect(paths.some((p) => p.endsWith('logs/a.log'))).toBe(false);
  });

  it('stacks .gitignore scopes at two depths (grandparent + parent both active)', async () => {
    // The grandparent's `*.tmp` must still bite two levels down while the parent's `*.bak`
    // applies to its own subtree — a stack that replaced instead of appended would leak `z.tmp`.
    const repo = makeRepo();
    write(repo, 'a/.gitignore', '*.tmp\n');
    write(repo, 'a/b/.gitignore', '*.bak\n');
    write(repo, 'a/x.tmp', 'x\n');
    write(repo, 'a/keep.ts');
    write(repo, 'a/b/y.bak', 'x\n');
    write(repo, 'a/b/z.tmp', 'x\n');
    write(repo, 'a/b/keep2.ts');

    const result = await new FileWalker(repo).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths).toContain('a/keep.ts');
    expect(paths).toContain('a/b/keep2.ts');
    expect(paths.some((p) => p.endsWith('x.tmp'))).toBe(false);
    expect(paths.some((p) => p.endsWith('y.bak'))).toBe(false);
    expect(paths.some((p) => p.endsWith('z.tmp'))).toBe(false); // grandparent rule reaches here
  });
});

describe('FileWalker — truncation receipt details & interactions', () => {
  it('reports atPath as the directory where truncation occurred', async () => {
    // Both admissible files live in one subdir, so the stop location is deterministic under any
    // readdir order.
    const repo = makeRepo();
    write(repo, 'sub/a.ts');
    write(repo, 'sub/b.ts');

    const result = await new FileWalker(repo, { maxFiles: 1 }).walk();

    expect(result.files).toHaveLength(1);
    expect(result.summary.truncated?.atPath).toBe('sub');
  });

  it('still fires the receipt when includePatterns are active', async () => {
    // The include machinery adds negations and force-descent; a bug there could suppress the cap
    // check. Assert only count+flag; which two files survive is order-dependent.
    const repo = makeRepo();
    write(repo, 'keep/a.ts');
    write(repo, 'keep/b.ts');
    write(repo, 'keep/c.ts');

    const result = await new FileWalker(repo, {
      maxFiles: 2,
      includePatterns: ['**/*.ts'],
    }).walk();

    expect(result.files.length).toBeLessThanOrEqual(2);
    expect(result.summary.truncated).toBeDefined();
    expect(result.summary.truncated?.limit).toBe(2);
  });
});

describe('FileWalker — symlink × include × truncation cross-interactions', () => {
  // skipIf(win32): creating a symlink there needs elevated privileges or Developer Mode,
  // so this cannot build the premise it asserts about and would test a plain file instead.
  // What it guards is platform-independent and is exercised on Linux.
  it.skipIf(process.platform === 'win32')('does NOT let a broad include override symlink confinement', async () => {
    // `**/*.ts` force-descends every directory, but the out-of-root check runs AFTER the include
    // gate and must NOT be bypassed — the exact security hole the symlink work closed.
    const repo = makeRepo();
    const outside = makeRepo('ol-walk-out-');
    writeFileSync(join(outside, 'secret.ts'), 'export const leaked = 1;\n');
    write(repo, 'src/mine.ts');
    symlinkSync(outside, join(repo, 'vendored'));

    const result = await new FileWalker(repo, { includePatterns: ['**/*.ts'] }).walk();
    const paths = result.files.map((f) => toPosixPath(f.path));

    expect(paths.some((p) => p.endsWith('secret.ts'))).toBe(false);
    expect(paths).toContain('src/mine.ts');
    expect(Object.keys(result.summary.skippedReasons ?? {})).toContain('symlink:outside-root');
  });
  // skipIf(win32): creating a symlink there needs elevated privileges or Developer Mode,
  // so this cannot build the premise it asserts about and would test a plain file instead.
  // What it guards is platform-independent and is exercised on Linux.
  it.skipIf(process.platform === 'win32')('marks truncation when the cap fills from a directory reached via a symlink', async () => {
    // real dir and its symlink are both root entries; whichever readdir yields first indexes
    // `real/`, fills the cap of 1, and the second admissible file trips the receipt. Assert
    // count+flag only (atPath is order-dependent here).
    const repo = makeRepo();
    write(repo, 'real/a.ts');
    write(repo, 'real/b.ts');
    symlinkSync(join(repo, 'real'), join(repo, 'link'));

    const result = await new FileWalker(repo, { maxFiles: 1 }).walk();

    expect(result.files).toHaveLength(1);
    expect(result.summary.truncated).toBeDefined();
    expect(result.summary.truncated?.limit).toBe(1);
  });
});

describe('FileWalker — followed-symlink disclosure', () => {
  // skipIf(win32): creating a symlink there needs elevated privileges or Developer Mode,
  // so this cannot build the premise it asserts about and would test a plain file instead.
  // What it guards is platform-independent and is exercised on Linux.
  it.skipIf(process.platform === 'win32')('counts a followed symlinked directory AND a followed symlinked file', async () => {
    // The spec requires the followed count be disclosed. `.impl` is a dot-dir the walker skips on
    // its own, so the link is the only way in — one followed dir; the vendored file link is the
    // second.
    const repo = makeRepo();
    mkdirSync(join(repo, '.impl'));
    write(repo, '.impl/lib.ts');
    write(repo, 'index.ts');
    symlinkSync(join(repo, '.impl'), join(repo, 'src'));
    write(repo, 'shared/util.ts');
    symlinkSync(join(repo, 'shared', 'util.ts'), join(repo, 'app-util.ts'));

    const result = await new FileWalker(repo).walk();

    expect(result.summary.symlinkFollowed).toBe(2);
    expect(result.files.some((f) => f.path.endsWith('lib.ts'))).toBe(true);
  });

  it('leaves symlinkFollowed absent when no link was followed', async () => {
    const repo = makeRepo();
    write(repo, 'a.ts');

    const result = await new FileWalker(repo).walk();

    expect(result.summary.symlinkFollowed).toBeUndefined();
  });
});

describe('FileWalker — include-pattern zero-match detector', () => {
  it('reports an include pattern that matched no file, and omits ones that matched', async () => {
    const repo = makeRepo();
    write(repo, 'a.ts');

    const result = await new FileWalker(repo, {
      includePatterns: ['does/not/exist/**', 'a.ts'],
    }).walk();

    expect(result.summary.includePatternsUnmatched).toEqual(['does/not/exist/**']);
  });

  it('leaves includePatternsUnmatched absent when every include pattern matched', async () => {
    const repo = makeRepo();
    write(repo, 'src/a.ts');

    const result = await new FileWalker(repo, { includePatterns: ['src/**'] }).walk();

    expect(result.summary.includePatternsUnmatched).toBeUndefined();
  });

  it('does not flag an unmatched pattern when the walk was truncated (matches may lie past the cap)', async () => {
    // A truncated walk cannot prove a pattern matched nothing, so no-op detection is suppressed.
    const repo = makeRepo();
    write(repo, 'a.ts');
    write(repo, 'b.ts');

    const result = await new FileWalker(repo, {
      maxFiles: 1,
      includePatterns: ['zzz/**'],
    }).walk();

    expect(result.summary.truncated).toBeDefined();
    expect(result.summary.includePatternsUnmatched).toBeUndefined();
  });
});

describe('FileWalker — .openlore-ignore (root)', () => {
  it('honors a root .openlore-ignore, and lets includePatterns override it', async () => {
    const repo = makeRepo();
    write(repo, '.openlore-ignore', 'ignored.ts\n');
    write(repo, 'ignored.ts');
    write(repo, 'app.ts');

    const excluded = await new FileWalker(repo).walk();
    expect(excluded.files.map((f) => toPosixPath(f.path)).some((p) => p.endsWith('ignored.ts'))).toBe(
      false,
    );

    const overridden = await new FileWalker(repo, { includePatterns: ['ignored.ts'] }).walk();
    expect(overridden.files.map((f) => toPosixPath(f.path))).toContain('ignored.ts');
  });
});

describe('FileWalker — permission errors are disclosed distinctly', () => {
  // skipIf(win32): the premise is an UNREADABLE directory, and `chmod` cannot build one there —
  // Node maps a Windows chmod onto the read-only attribute, which is a no-op for a directory, so
  // the walk would list `secret/` normally and the test would assert against a fixture that never
  // denied anything. Denying it for real needs an ACL edit (`icacls`) whose outcome depends on the
  // runner's token. What is under test — that an EACCES/EPERM listing failure is disclosed as
  // `error:permission` rather than a bare read error — is platform-independent and is exercised on
  // the POSIX runners.
  it.skipIf(process.platform === 'win32')('records an unreadable directory under error:permission, not a bare error', async () => {
    // root bypasses filesystem permissions, so chmod 000 would not block the read there — the
    // assertion is only meaningful for a non-root user (the CI runner is non-root).
    if (process.getuid?.() === 0) return;
    const repo = makeRepo();
    mkdirSync(join(repo, 'secret'));
    write(repo, 'secret/x.ts');
    write(repo, 'ok.ts');
    chmodSync(join(repo, 'secret'), 0o000);
    try {
      const result = await new FileWalker(repo).walk();
      expect(Object.keys(result.summary.skippedReasons ?? {})).toContain('error:permission');
    } finally {
      chmodSync(join(repo, 'secret'), 0o755); // restore so afterEach cleanup can remove it
    }
  });
});
