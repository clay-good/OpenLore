import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestCommand } from './digest.js';

const SPEC = [
  '# Api', '', '## Purpose', '', 'Serves the API.', '', '## Requirements', '',
  '### Requirement: ListUsers', '', 'The system SHALL list users.', '',
  '#### Scenario: Lists', '', '- **WHEN** a client asks', '- **THEN** users are listed', '',
].join('\n');

let root: string;

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('openlore digest', () => {
  it('reads specs from, and saves digest.md to, the configured openspecPath', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-digest-'));
    await mkdir(join(root, 'docs', 'specs', 'api'), { recursive: true });
    await writeFile(join(root, 'docs', 'specs', 'api', 'spec.md'), SPEC);
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0', projectType: 'unknown', openspecPath: 'docs',
      analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
      generation: { model: 'x', domains: 'auto' },
      createdAt: new Date().toISOString(), lastRun: null,
    }));
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await digestCommand.parseAsync(['--save'], { from: 'user' });

    expect(process.exitCode).toBeUndefined();
    expect(await readFile(join(root, 'docs', 'digest.md'), 'utf8')).toContain('ListUsers');
    expect(existsSync(join(root, 'openspec'))).toBe(false);
  });
});
