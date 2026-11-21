import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { resolveOpenspecDir } from './openspec-dir.js';

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
});
