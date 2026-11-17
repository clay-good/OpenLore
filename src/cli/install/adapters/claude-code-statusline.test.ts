/**
 * Claude Code status-line wiring: OpenLore owns the single `statusLine` slot only when it is
 * empty, only in the user scope, and identifies its own entry by the `--installed-by-openlore`
 * marker so a moved CLI path is refreshed (install) or still removed (uninstall).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAdapter } from './claude-code.js';
import type { ApplyContext } from './types.js';

const dirs: string[] = [];
const SETTINGS = join('.claude', 'settings.json');

async function context(
  scope: 'user' | 'repo',
  platform: NodeJS.Platform = 'linux',
  nodeExecutable = '/usr/bin/node',
): Promise<ApplyContext> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-statusline-'));
  dirs.push(root);
  return {
    root,
    scope,
    platform,
    platformCommandRuntime: { nodeExecutable, pathValue: '', fileExists: () => true },
    instructionTemplate: 'Use OpenLore.',
    dryRun: false,
    force: false,
    preset: 'substrate',
  };
}

async function settings(ctx: ApplyContext): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(ctx.root, SETTINGS), 'utf8')) as Record<string, unknown>;
}

async function seed(ctx: ApplyContext, value: unknown): Promise<void> {
  await mkdir(join(ctx.root, '.claude'), { recursive: true });
  await writeFile(join(ctx.root, SETTINGS), JSON.stringify(value, null, 2) + '\n');
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Claude Code status line — install', () => {
  it('fills an empty user-scope slot with the marked command', async () => {
    const ctx = await context('user');
    const result = await claudeCodeAdapter.apply(ctx);
    expect(result.conflict).toBe(false);
    const statusLine = (await settings(ctx)).statusLine as { type: string; command: string };
    expect(statusLine.type).toBe('command');
    expect(statusLine.command).toMatch(/ statusline --installed-by-openlore$/);
    expect(result.changes.some((c) => c.summary.includes('OpenLore status line'))).toBe(true);
  });

  it('never writes the shared repo-scope settings file', async () => {
    const ctx = await context('repo');
    await claudeCodeAdapter.apply(ctx);
    expect((await settings(ctx)).statusLine).toBeUndefined();
  });

  it('never clobbers a custom status line, and says how to combine them', async () => {
    const ctx = await context('user');
    const custom = { type: 'command', command: '~/bin/my-statusline.sh', padding: 0 };
    await seed(ctx, { statusLine: custom });
    const result = await claudeCodeAdapter.apply(ctx);
    expect((await settings(ctx)).statusLine).toEqual(custom);
    const warning = result.warnings.find((w) => w.includes('custom statusLine'));
    expect(warning).toContain('`openlore statusline`');
    expect(warning).not.toContain('--installed-by-openlore');
  });

  it('treats a user script that calls the unmarked command as the user\'s own', async () => {
    const ctx = await context('user');
    const custom = { type: 'command', command: 'sh -c "openlore statusline; date"' };
    await seed(ctx, { statusLine: custom });
    await claudeCodeAdapter.apply(ctx);
    expect((await settings(ctx)).statusLine).toEqual(custom);
  });

  it('is byte-idempotent on re-install', async () => {
    const ctx = await context('user');
    await claudeCodeAdapter.apply(ctx);
    const before = await readFile(join(ctx.root, SETTINGS), 'utf8');
    const again = await claudeCodeAdapter.apply(ctx);
    expect(await readFile(join(ctx.root, SETTINGS), 'utf8')).toBe(before);
    expect(again.warnings.some((w) => w.includes('custom statusLine'))).toBe(false);
  });

  it('refreshes its own entry when the CLI path moved (platform or reinstall)', async () => {
    const ctx = await context('user');
    await seed(ctx, {
      statusLine: { type: 'command', command: '/old/node /old/dist/cli/index.js statusline --installed-by-openlore' },
    });
    const result = await claudeCodeAdapter.apply(ctx);
    const command = ((await settings(ctx)).statusLine as { command: string }).command;
    expect(command).not.toContain('/old/');
    expect(command).toMatch(/ statusline --installed-by-openlore$/);
    expect(result.warnings.some((w) => w.includes('custom statusLine'))).toBe(false);

    ctx.platform = 'win32';
    ctx.platformCommandRuntime = {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      pathValue: '',
      fileExists: () => true,
    };
    await claudeCodeAdapter.apply(ctx);
    expect(((await settings(ctx)).statusLine as { command: string }).command)
      .toMatch(/^"C:\\Program Files\\nodejs\\node\.exe" .* statusline --installed-by-openlore$/);
  });

  it('drops its own entry on a host whose paths cannot be quoted, keeping a custom one', async () => {
    const ctx = await context('user', 'win32', 'C:\\Users\\a$b\\nodejs\\node.exe');
    await seed(ctx, { statusLine: { type: 'command', command: 'npx --yes openlore statusline --installed-by-openlore' } });
    const result = await claudeCodeAdapter.apply(ctx);
    expect((await settings(ctx)).statusLine).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('status line was NOT wired'))).toBe(true);

    const custom = { type: 'command', command: 'mine.cmd' };
    await seed(ctx, { statusLine: custom });
    await claudeCodeAdapter.apply(ctx);
    expect((await settings(ctx)).statusLine).toEqual(custom);
  });

  it('refuses a malformed settings.json without writing a status line into it', async () => {
    const ctx = await context('user');
    await mkdir(join(ctx.root, '.claude'), { recursive: true });
    await writeFile(join(ctx.root, SETTINGS), '{ "statusLine": ');
    await claudeCodeAdapter.apply(ctx);
    expect(await readFile(join(ctx.root, SETTINGS), 'utf8')).toBe('{ "statusLine": ');
  });
});

describe('Claude Code status line — uninstall', () => {
  it('removes only the OpenLore-marked entry, even after its path moved', async () => {
    const ctx = await context('user');
    await claudeCodeAdapter.apply(ctx);
    const s = await settings(ctx);
    (s.statusLine as { command: string }).command = '/moved/node /moved/cli.js statusline --installed-by-openlore';
    s.theme = 'dark';
    await seed(ctx, s);
    await claudeCodeAdapter.uninstall(ctx);
    const after = await settings(ctx);
    expect(after.statusLine).toBeUndefined();
    expect(after.theme).toBe('dark');
  });

  it('keeps a custom status line', async () => {
    const ctx = await context('user');
    const custom = { type: 'command', command: 'openlore statusline' };
    await seed(ctx, { statusLine: custom });
    await claudeCodeAdapter.uninstall(ctx);
    expect((await settings(ctx)).statusLine).toEqual(custom);
  });

  it('removes it on a host whose paths can no longer be quoted', async () => {
    const ctx = await context('user', 'win32', 'C:\\Users\\a$b\\nodejs\\node.exe');
    await seed(ctx, {
      statusLine: { type: 'command', command: 'npx --yes openlore statusline --installed-by-openlore' },
      theme: 'dark',
    });
    await claudeCodeAdapter.uninstall(ctx);
    expect((await settings(ctx)).statusLine).toBeUndefined();
  });

  it('leaves a malformed settings.json untouched', async () => {
    const ctx = await context('user');
    await mkdir(join(ctx.root, '.claude'), { recursive: true });
    await writeFile(join(ctx.root, SETTINGS), 'not json');
    await claudeCodeAdapter.uninstall(ctx);
    expect(await exists(join(ctx.root, SETTINGS))).toBe(true);
    expect(await readFile(join(ctx.root, SETTINGS), 'utf8')).toBe('not json');
  });
});
