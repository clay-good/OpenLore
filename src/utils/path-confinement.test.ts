/**
 * Path confinement against an ANALYZED repository that ships hostile paths.
 *
 * Two vectors, both of which git will happily check out for a victim who clones:
 *   - `openspecPath` in the committed `.openlore/config.json` set to `../../..`
 *   - a committed SYMLINK inside `openspec/` pointing outside the repo
 *
 * The symlink cases are the ones a lexical-only check misses, and they were live:
 * `openspec/specs/<domain>/spec.md -> ~/.zshrc` was read, appended to and rewritten
 * by the decision syncer, and `openspec/decisions -> elsewhere` received ADRs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confinedAtomicWriteFile, readFileConfined, readFileConfinedWithStat, recoverConfinedAtomicWriteFile, safeJoin, safeOpenspecDir, isConfinedPath } from './path-confinement.js';

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'openlore-confine-')));
  root = join(base, 'repo');
  outside = join(base, 'victim');
  await mkdir(join(root, 'openspec', 'specs', 'core'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.md'), '# victim secret\n');
  await writeFile(join(root, 'openspec', 'specs', 'core', 'spec.md'), '# real spec\n');
  // The hostile commits.
  await symlink(join(outside, 'secret.md'), join(root, 'openspec', 'escaping-spec.md'));
  await symlink(outside, join(root, 'openspec', 'escaping-dir'));
  // A DANGLING link: the target does not exist yet. `realpath` throws ENOENT on it,
  // which is the same error a plain not-yet-created write target produces — conflating
  // the two let a write follow the link and land outside the root.
  await symlink(join(outside, 'not-created-yet.md'), join(root, 'openspec', 'dangling.md'));
  // `self -> .` lets a path reach a link through a directory whose LEXICAL dirname
  // differs from its REAL one — the difference `readlink` is relative to.
  await symlink('.', join(root, 'self'));
  await symlink(join('..', 'victim', 'escaped.md'), join(root, 'rel-escape.md'));
  // An existing directory symlink pointing outside, for the hop-budget case.
  await symlink(outside, join(root, 'dirlink'));
  // Legitimate in-root links, including through a symlinked directory.
  await mkdir(join(root, 'sub', 'sub2'), { recursive: true });
  await symlink(join('sub', 'sub2'), join(root, 'godeep'));
  await symlink(join('..', '..', 'inroot-notyet.md'), join(root, 'sub', 'sub2', 'rel'));
});

afterAll(async () => {
  if (root) await rm(join(root, '..'), { recursive: true, force: true });
});

describe('safeJoin', () => {
  it('allows a legitimate in-root path', () => {
    expect(safeJoin(root, 'openspec/specs/core/spec.md')).toBe(
      join(root, 'openspec/specs/core/spec.md'),
    );
  });

  it('blocks lexical traversal', () => {
    expect(() => safeJoin(root, '../victim/secret.md')).toThrow(/Path traversal blocked/);
  });

  it('blocks a SYMLINKED FILE that resolves outside the root', () => {
    // The path is lexically inside the repo; only canonicalization catches it.
    expect(() => safeJoin(root, 'openspec/escaping-spec.md')).toThrow(/Path escape blocked/);
  });

  it('blocks a write target under a SYMLINKED DIRECTORY that points outside', () => {
    // The file does not exist yet — this is the ADR-creation shape, where
    // confinement must be decided on the nearest existing ancestor.
    expect(() => safeJoin(root, 'openspec/escaping-dir/adr-0001-x.md')).toThrow(
      /Path escape blocked/,
    );
  });

  it('blocks a DANGLING symlink whose target does not exist yet', async () => {
    // The realistic payload is a dotfile that does not exist on the victim's machine
    // (`~/.zshenv`), so the write CREATES it — code execution on the next shell start.
    expect(() => safeJoin(root, 'openspec/dangling.md')).toThrow(/Path escape blocked/);
    // And prove the primitive: the file must not appear outside the root.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(outside, 'not-created-yet.md'))).toBe(false);
  });

  it('resolves a link target against its REAL directory, not its lexical one', () => {
    // `root/self -> .` + `root/rel-escape.md -> ../victim/escaped.md`. Lexically,
    // `self/rel-escape.md`'s dirname is `root/self`, so `../victim` looks in-root —
    // while the kernel resolves it from the real dir and lands outside. Blocked via
    // the padded path exactly as via the direct one.
    expect(() => safeJoin(root, 'rel-escape.md')).toThrow(/Path escape blocked/);
    expect(() => safeJoin(root, 'self/rel-escape.md')).toThrow(/Path escape blocked/);
    expect(() => safeJoin(root, 'self/self/self/rel-escape.md')).toThrow(/Path escape blocked/);
  });

  it('refuses rather than allows when the hop budget is exhausted', () => {
    // Depth is attacker-chosen, so exhaustion must fail CLOSED: returning the
    // un-canonicalized path would sail through the caller's startsWith check.
    const deep = (n: number): string => 'dirlink/' + 'x/'.repeat(n) + 'target.md';
    for (const n of [62, 63, 100, 200]) {
      expect(() => safeJoin(root, deep(n)), `depth ${n}`).toThrow(/Path escape blocked/);
    }
  });

  it('still allows a legitimate in-root link reached through a symlinked directory', () => {
    // The mirror of the lexical-dirname bug: resolving against the real directory
    // must not start REJECTING in-root links (it did, before the fix).
    expect(safeJoin(root, 'godeep/rel')).toBe(join(root, 'godeep/rel'));
    expect(safeJoin(root, 'sub/sub2/rel')).toBe(join(root, 'sub/sub2/rel'));
  });

  it('allows a not-yet-created write target inside the root', () => {
    expect(safeJoin(root, 'openspec/decisions/adr-0001-x.md')).toBe(
      join(root, 'openspec/decisions/adr-0001-x.md'),
    );
  });
});

describe('safeOpenspecDir', () => {
  it('passes through the default and a legitimate custom path', () => {
    expect(safeOpenspecDir(root, undefined)).toBe(join(root, 'openspec'));
    expect(safeOpenspecDir(root, '')).toBe(join(root, 'openspec'));
    expect(safeOpenspecDir(root, 'docs/specs')).toBe(join(root, 'docs/specs'));
  });

  it('falls back to the default when the repo config tries to escape', () => {
    // Fails soft rather than throwing: a poisoned value must not break the command,
    // it must simply not redirect it.
    expect(safeOpenspecDir(root, '../../../../etc')).toBe(join(root, 'openspec'));
    expect(safeOpenspecDir(root, '../victim')).toBe(join(root, 'openspec'));
  });

  it('neutralizes a symlinked openspec path', () => {
    expect(safeOpenspecDir(root, 'openspec/escaping-dir')).toBe(join(root, 'openspec'));
  });
});

describe('readFileConfined', () => {
  it('reads a stable in-root regular file through its confined descriptor', async () => {
    await expect(readFileConfined(root, 'openspec/specs/core/spec.md')).resolves.toBe('# real spec\n');
  });

  it('rejects an oversized file from descriptor metadata before returning content', async () => {
    await expect(readFileConfined(root, 'openspec/specs/core/spec.md', 2))
      .rejects.toThrow(/exceeds byte limit/);
  });

  it('returns UTF-8 content and post-read metadata from the confined descriptor', async () => {
    const result = await readFileConfinedWithStat(root, 'openspec/specs/core/spec.md');

    expect(result.content).toBe('# real spec\n');
    expect(result.stat.isFile()).toBe(true);
    expect(result.stat.size).toBe(Buffer.byteLength(result.content, 'utf-8'));
    expect(Number.isFinite(result.stat.mtimeMs)).toBe(true);
  });

  it('returns neither content nor metadata when the opened file changes during the read', async () => {
    const path = join(root, 'openspec', 'specs', 'core', 'changing.md');
    await writeFile(path, '# before\n');
    const probe = await open(path, 'r');
    const prototype = Object.getPrototypeOf(probe) as { readFile: (...args: unknown[]) => Promise<Buffer> };
    await probe.close();
    const originalReadFile = prototype.readFile;
    const readSpy = vi.spyOn(prototype, 'readFile').mockImplementationOnce(async function (
      this: { readFile: (...args: unknown[]) => Promise<Buffer> },
      ...args: unknown[]
    ) {
      const bytes = await originalReadFile.apply(this, args);
      await writeFile(path, '# after changed\n');
      return bytes;
    });

    try {
      await expect(readFileConfinedWithStat(root, 'openspec/specs/core/changing.md'))
        .rejects.toThrow(/changed during access/);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('refuses an escaping symlink before returning any bytes', async () => {
    await expect(readFileConfined(root, 'openspec/escaping-spec.md')).rejects.toThrow(/Path escape blocked/);
    await expect(readFileConfinedWithStat(root, 'openspec/escaping-spec.md')).rejects.toThrow(/Path escape blocked/);
  });
});

describe('confinedAtomicWriteFile expected identity', () => {
  it('recovers the original file after an interrupted conditional publication', async () => {
    const path = join(root, 'openspec', 'specs', 'core', 'recover-cas.md');
    const guard = join(root, 'openspec', 'specs', 'core', '.recover-cas.md.openlore-cas-backup.36b8f84d-0a96-4eeb-8694-73f7a330e775');
    await writeFile(path, '# original\n');
    await rename(path, guard);

    await recoverConfinedAtomicWriteFile(root, path);

    await expect(readFileConfined(root, 'openspec/specs/core/recover-cas.md'))
      .resolves.toBe('# original\n');
  });

  it('refuses to overwrite a regular file that changed after its confined read', async () => {
    const path = join(root, 'openspec', 'specs', 'core', 'cas.md');
    await writeFile(path, '# first\n');
    const snapshot = await readFileConfinedWithStat(root, 'openspec/specs/core/cas.md');
    await writeFile(path, '# concurrent user edit\n');

    await expect(confinedAtomicWriteFile(root, path, '# installer edit\n', {
      expectedIdentity: snapshot.stat,
    })).rejects.toThrow(/changed after it was read/);
    await expect(readFileConfined(root, 'openspec/specs/core/cas.md'))
      .resolves.toBe('# concurrent user edit\n');
  });

  it('preserves a replacement that lands during publication', async () => {
    const path = join(root, 'openspec', 'specs', 'core', 'cas-during-publish.md');
    await writeFile(path, '# first\n');
    const snapshot = await readFileConfinedWithStat(root, 'openspec/specs/core/cas-during-publish.md');
    const probe = await open(path, 'r');
    const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const originalSync = prototype.sync;
    const syncSpy = vi.spyOn(prototype, 'sync').mockImplementationOnce(async function (
      this: { sync: () => Promise<void> },
    ) {
      await originalSync.call(this);
      await writeFile(path, '# concurrent replacement\n');
    });
    try {
      await expect(confinedAtomicWriteFile(root, path, '# installer edit\n', {
        expectedIdentity: snapshot.stat,
      })).rejects.toThrow(/changed after it was read/);
      await expect(readFileConfined(root, 'openspec/specs/core/cas-during-publish.md'))
        .resolves.toBe('# concurrent replacement\n');
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('refuses to overwrite a file created after an absent read', async () => {
    const path = join(root, 'openspec', 'specs', 'core', 'created-concurrently.md');
    await writeFile(path, '# concurrent create\n');
    await expect(confinedAtomicWriteFile(root, path, '# installer create\n', {
      expectedIdentity: null,
    })).rejects.toThrow(/created after it was read/);
  });
});

describe('isConfinedPath', () => {
  it('is the non-throwing predicate form used by directory walkers', () => {
    expect(isConfinedPath(root, join(root, 'openspec/specs/core/spec.md'))).toBe(true);
    expect(isConfinedPath(root, join(root, 'openspec/escaping-spec.md'))).toBe(false);
    expect(isConfinedPath(root, join(outside, 'secret.md'))).toBe(false);
  });
});
