import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectSpecMarkdown } from './view-files.js';

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-view-spec-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('collectSpecMarkdown', () => {
  it('skips symlinked files and directories instead of reading outside the spec root', async () => {
    const base = await tempRoot();
    const specs = join(base, 'specs');
    const outside = join(base, 'outside');
    await mkdir(specs);
    await mkdir(outside);
    await writeFile(join(specs, 'safe.md'), '# Safe');
    await writeFile(join(outside, 'secret.md'), '# Secret');
    await symlink(join(outside, 'secret.md'), join(specs, 'file-link.md'));
    await symlink(outside, join(specs, 'dir-link'));

    const result = await collectSpecMarkdown(specs);
    expect(result.content).toContain('# Safe');
    expect(result.content).not.toContain('# Secret');
    expect(result.truncated).toBe(false);
  });

  it('stops before the configured byte ceiling', async () => {
    const base = await tempRoot();
    const specs = join(base, 'specs');
    await mkdir(specs);
    await writeFile(join(specs, 'a.md'), '12345');
    await writeFile(join(specs, 'b.md'), '67890');

    const result = await collectSpecMarkdown(specs, 8);
    expect(result.content).toBe('12345');
    expect(result.bytes).toBeLessThanOrEqual(8);
    expect(result.truncated).toBe(true);
  });
});
