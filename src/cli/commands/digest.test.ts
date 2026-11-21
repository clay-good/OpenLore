import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

  // Creating a symlink on Windows needs Developer Mode or admin rights.
  it.skipIf(process.platform === 'win32')('--save never writes through a digest.md symlinked out of the project', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-digest-link-'));
    const repo = join(root, 'repo');
    const victim = join(root, 'victim.txt');
    await writeFile(victim, 'original');
    await mkdir(join(repo, 'docs', 'specs', 'api'), { recursive: true });
    await writeFile(join(repo, 'docs', 'specs', 'api', 'spec.md'), SPEC);
    await mkdir(join(repo, '.openlore'), { recursive: true });
    await writeFile(join(repo, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0', projectType: 'unknown', openspecPath: 'docs',
      analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
      generation: { model: 'x', domains: 'auto' },
      createdAt: new Date().toISOString(), lastRun: null,
    }));
    await symlink(victim, join(repo, 'docs', 'digest.md'));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await digestCommand.parseAsync(['--save'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(await readFile(victim, 'utf8')).toBe('original');
  });
});
