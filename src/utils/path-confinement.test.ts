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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeJoin, safeOpenspecDir, isConfinedPath } from './path-confinement.js';

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

describe('isConfinedPath', () => {
  it('is the non-throwing predicate form used by directory walkers', () => {
    expect(isConfinedPath(root, join(root, 'openspec/specs/core/spec.md'))).toBe(true);
    expect(isConfinedPath(root, join(root, 'openspec/escaping-spec.md'))).toBe(false);
    expect(isConfinedPath(root, join(outside, 'secret.md'))).toBe(false);
  });
});
