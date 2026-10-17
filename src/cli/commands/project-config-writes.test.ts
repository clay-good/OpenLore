/**
 * Read-modify-write commands edit the PROJECT `.openlore/config.json` only. User-wide
 * defaults (`OPENLORE_GLOBAL_CONFIG`) are layered under it on read, so a command that
 * read the merged view and wrote it back would copy user settings — an embedding API
 * key — into a file that may be committed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultConfig } from '../../core/services/config-manager.js';
import { OPENLORE_CONFIG_REL_PATH } from '../../constants.js';

vi.mock('./analyze.js', () => ({ analyzeCommand: { parseAsync: vi.fn(async () => undefined) } }));

const { embedCommand } = await import('./embed.js');
const { setupCommand } = await import('./setup.js');

const USER_EMBEDDING = { baseUrl: 'https://embed.example.com/v1', model: 'user-embed', apiKey: 'user-secret' };

describe('project config writes do not absorb user-wide defaults', () => {
  let root: string;
  let project: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-project-writes-'));
    project = join(root, 'project');
    await mkdir(join(project, '.openlore'), { recursive: true });
    await writeFile(join(project, OPENLORE_CONFIG_REL_PATH), JSON.stringify(getDefaultConfig('nodejs', 'openspec')));
    const userPath = join(root, 'user.json');
    await writeFile(userPath, JSON.stringify({ generation: { provider: 'openai', model: 'gpt-5' }, embedding: USER_EMBEDDING }));
    vi.stubEnv('OPENLORE_GLOBAL_CONFIG', userPath);
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  const projectFile = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(project, OPENLORE_CONFIG_REL_PATH), 'utf8')) as Record<string, unknown>;

  it('embed --local writes only the project file and no user secret', async () => {
    await embedCommand.parseAsync(['--local'], { from: 'user' });
    const written = await projectFile();
    expect(written.embedding).toEqual({ provider: 'local', model: expect.any(String) });
    expect(JSON.stringify(written)).not.toContain('user-secret');
    expect(written.generation).not.toHaveProperty('provider');
  });

  it('embed --off writes embedding: null so an inherited user embedding stays off', async () => {
    await embedCommand.parseAsync(['--off'], { from: 'user' });
    const written = await projectFile();
    expect(written.embedding).toBeNull();
    expect(JSON.stringify(written)).not.toContain('user-secret');
    const { readOpenLoreConfig } = await import('../../core/services/config-manager.js');
    expect(await readOpenLoreConfig(project)).not.toHaveProperty('embedding');
  });

  it('setup --panic writes only the project file and no user secret', async () => {
    await setupCommand.parseAsync(['--panic', 'off', '--dir', project], { from: 'user' });
    const written = await projectFile();
    expect(written.panicResponse).toEqual({ mode: 'off' });
    expect(written).not.toHaveProperty('embedding');
    expect(written.generation).not.toHaveProperty('provider');
  });
});
