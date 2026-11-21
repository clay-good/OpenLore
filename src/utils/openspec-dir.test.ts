import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { confinedOpenspecRel, readerOpenspecDir, resolveOpenspecDir } from './openspec-dir.js';

afterEach(() => vi.restoreAllMocks());

describe('resolveOpenspecDir', () => {
  it('discloses an escaping openspecPath on stderr, never stdout, once', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const root = resolve('/tmp/openlore-openspec-dir-root');

    expect(resolveOpenspecDir(root, '../escape')).toBe(resolve(root, 'openspec'));
    expect(resolveOpenspecDir(root, '../escape')).toBe(resolve(root, 'openspec'));

    expect(out).not.toHaveBeenCalled();
    const warnings = err.mock.calls.map(([chunk]) => String(chunk)).filter(line => line.includes('../escape'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('resolves outside the project root');
  });

  // Creating a symlink on Windows needs Developer Mode or admin rights.
  it.skipIf(process.platform === 'win32')('readers keep the in-project path of a corpus symlinked from outside; writers are refused', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openlore-reader-root-'));
    try {
      const root = join(scratch, 'repo');
      mkdirSync(join(scratch, 'shared', 'specs'), { recursive: true });
      mkdirSync(root);
      symlinkSync(join(scratch, 'shared'), join(root, 'openspec'));
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(() => resolveOpenspecDir(root, undefined)).toThrow();
      expect(readerOpenspecDir(root, undefined)).toBe(join(root, 'openspec'));
      expect(confinedOpenspecRel(root, './openspec')).toBe('openspec');
      expect(confinedOpenspecRel(root, '../elsewhere')).toBe('openspec');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('a relative form of the spec root, for readers that pass it on', () => {
    const root = resolve('/tmp/openlore-openspec-rel');
    expect(confinedOpenspecRel(root, undefined)).toBe('openspec');
    expect(confinedOpenspecRel(root, './docs/')).toBe('docs');
    expect(confinedOpenspecRel(root, '.')).toBe('.');
  });
});
