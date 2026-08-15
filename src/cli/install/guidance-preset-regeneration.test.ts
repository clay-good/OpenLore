/**
 * The managed guidance block follows the wired preset
 * (change: align-generated-guidance-with-installed-preset).
 *
 * Guidance and surface drifted apart because nothing tied them together across
 * reinstalls: a repo re-wired to a wider surface kept instructions written for
 * the old one. Naming the preset inside the block makes the tie structural — the
 * block's fingerprint changes with the preset, so a re-install rewrites it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from './index.js';
import { LEAN_DEFAULT_PRESET } from '../../constants.js';

let dir: string;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'openlore-guidance-install-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const readMd = () => readFile(join(dir, 'CLAUDE.md'), 'utf8');

describe('install regenerates guidance on preset change', () => {
  it('names the wired surface in the block', async () => {
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(await readMd()).toContain(`Wired MCP surface: \`${LEAN_DEFAULT_PRESET}\``);
  });

  it('rewrites the block when the preset widens', async () => {
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(await readMd()).toContain(`\`${LEAN_DEFAULT_PRESET}\``);

    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, preset: 'full' });
    const after = await readMd();
    expect(after).toContain('Wired MCP surface: `full`');
    expect(after).not.toContain(`Wired MCP surface: \`${LEAN_DEFAULT_PRESET}\``);
  });

  it('is idempotent when the preset is unchanged', async () => {
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, preset: 'navigation' });
    const first = await readMd();

    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, preset: 'navigation' });
    expect(await readMd()).toBe(first);
  });

  it('preserves hand-written content outside the block', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# my project\n\nHand-written notes that must survive.\n');
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, preset: 'full' });

    const md = await readMd();
    expect(md).toContain('# my project');
    expect(md).toContain('Hand-written notes that must survive.');
    expect(md).toContain('Wired MCP surface: `full`');
  });

  it('wires the same preset it claims in the guidance', async () => {
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, preset: 'navigation' });

    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8')) as {
      mcpServers: { openlore: { args: string[] } };
    };
    const wiredArgs = mcp.mcpServers.openlore.args;
    expect(wiredArgs).toContain('navigation');
    expect(await readMd()).toContain('Wired MCP surface: `navigation`');
  });

  it('states the orientation rule as a condition, not an absolute', async () => {
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    const md = await readMd();

    expect(md).not.toMatch(/ALWAYS call/i);
    expect(md).toContain('before touching a module you have not yet read in\nthis session');
  });
});
