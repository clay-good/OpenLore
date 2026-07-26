/**
 * A committed symlink in `openspec/specs/` must not become a WRITE target.
 *
 * `buildSpecMap` is the source of the `specPath` the decision syncer later reads,
 * appends a Decisions block to, and rewrites. A repo that commits
 * `openspec/specs/core/spec.md -> ~/.zshrc` therefore had OpenLore rewrite a file
 * outside the repo on `openlore decisions --sync` (which the pre-commit gate runs).
 * git checks such a symlink out on clone, so this needs no action from the victim.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpecMap } from './spec-mapper.js';

let base: string;
let root: string;

const SPEC_BODY = `# Core

## Purpose
Core domain.

## Source Files
- src/index.ts
`;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'openlore-specmap-')));
  root = join(base, 'repo');
  await mkdir(join(root, 'openspec', 'specs', 'honest'), { recursive: true });
  await mkdir(join(root, 'openspec', 'specs', 'hostile'), { recursive: true });
  await writeFile(join(root, 'openspec', 'specs', 'honest', 'spec.md'), SPEC_BODY);

  // The hostile commit: a spec.md that is really a link to a file outside the repo.
  await writeFile(join(base, 'victim.md'), SPEC_BODY);
  await symlink(join(base, 'victim.md'), join(root, 'openspec', 'specs', 'hostile', 'spec.md'));
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe('buildSpecMap path confinement', () => {
  it('maps the honest domain and drops the one whose spec.md escapes the root', async () => {
    const map = await buildSpecMap({ rootPath: root, openspecPath: join(root, 'openspec') });

    // Control: the walk really did run and find the legitimate spec. Without this,
    // a bug that returned nothing at all would look like a passing security test.
    expect(map.byDomain.has('honest')).toBe(true);
    expect(map.byDomain.has('hostile')).toBe(false);
  });
});
