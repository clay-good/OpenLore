import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configuredSpecRoot, indexedSpecProvenanceAt, isUnderSpecRoot, specFileRel, specRootRelOrNull } from './spec-paths.js';

describe('spec paths', () => {
  it('builds a spec file path under the configured root', () => {
    expect(specFileRel('openspec', 'api')).toBe('openspec/specs/api/spec.md');
    expect(specFileRel('docs', 'api')).toBe('docs/specs/api/spec.md');
    expect(specFileRel('.', 'api')).toBe('specs/api/spec.md');
  });

  it('tells a path inside the configured spec root from one outside it', () => {
    expect(isUnderSpecRoot('docs/specs/api/spec.md', 'docs')).toBe(true);
    expect(isUnderSpecRoot('openspec/specs/api/spec.md', 'docs')).toBe(false);
    expect(isUnderSpecRoot('docsx/specs/api/spec.md', 'docs')).toBe(false);
    expect(isUnderSpecRoot('changes/x/proposal.md', '.')).toBe(true);
    expect(isUnderSpecRoot('src/index.ts', '.')).toBe(false);
  });

  // Creating a symlink on Windows needs Developer Mode or admin rights.
  it.skipIf(process.platform === 'win32')('a corpus symlinked from outside: readers get the in-project path, writers are refused', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openlore-spec-root-link-'));
    try {
      const root = join(scratch, 'repo');
      mkdirSync(join(scratch, 'shared', 'specs'), { recursive: true });
      mkdirSync(root);
      symlinkSync(join(scratch, 'shared'), join(root, 'openspec'));
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await expect(configuredSpecRoot(root)).rejects.toThrow();
      expect(await configuredSpecRoot(root, { readOnly: true })).toEqual({ absolute: join(root, 'openspec'), relative: 'openspec' });
    } finally {
      vi.restoreAllMocks();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('a spec root that cannot be resolved is null, and its text is never labeled reviewed', async () => {
    expect(await specRootRelOrNull('/no/such\0root')).toBeNull();
    expect(await indexedSpecProvenanceAt('/tmp', null, 'api', ['x'])).toBe('local-unreviewed');
  });
});
