import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAdapter } from './claude-code.js';
import { continueAdapter } from './continue.js';
import { cursorAdapter } from './cursor.js';
import type { ApplyContext } from './types.js';

const dirs: string[] = [];

async function context(platform: NodeJS.Platform): Promise<ApplyContext> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-platform-command-'));
  dirs.push(root);
  return {
    root,
    platform,
    platformCommandRuntime: {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      pathValue: '',
      fileExists: () => true,
    },
    instructionTemplate: 'Use OpenLore.',
    dryRun: false,
    force: false,
    preset: 'substrate',
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Windows-generated agent launch commands', () => {
  it('wraps the Claude Code MCP entry and both managed hooks', async () => {
    const ctx = await context('win32');
    expect((await claudeCodeAdapter.apply(ctx)).conflict).toBe(false);

    const mcp = JSON.parse(await readFile(join(ctx.root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', '--yes', 'openlore', 'mcp', '--preset', 'substrate'],
    });
    const settings = JSON.parse(await readFile(join(ctx.root, '.claude/settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command)
      .toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" --yes openlore orient --json');
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command)
      .toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" --yes openlore orient --inject');
  });

  it('wraps the Cursor MCP entry', async () => {
    const ctx = await context('win32');
    expect((await cursorAdapter.apply(ctx)).conflict).toBe(false);

    const mcp = JSON.parse(await readFile(join(ctx.root, '.cursor/mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', '--yes', 'openlore', 'mcp', '--preset', 'substrate'],
    });
  });

  it('wraps the Continue slash command', async () => {
    const ctx = await context('win32');
    expect((await continueAdapter.apply(ctx)).conflict).toBe(false);

    const config = JSON.parse(await readFile(join(ctx.root, '.continue/config.json'), 'utf8'));
    expect(config.slashCommands).toContainEqual({
      name: 'orient',
      description: 'Call openlore orient() for the current task context',
      run: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" --yes openlore orient --json',
    });
  });

  it.each(['darwin', 'linux'] as const)('preserves native generated commands on %s', async (platform) => {
    const ctx = await context(platform);
    expect((await claudeCodeAdapter.apply(ctx)).conflict).toBe(false);
    expect((await cursorAdapter.apply(ctx)).conflict).toBe(false);
    expect((await continueAdapter.apply(ctx)).conflict).toBe(false);

    const mcp = JSON.parse(await readFile(join(ctx.root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore.command).toBe('npx');
    const settings = JSON.parse(await readFile(join(ctx.root, '.claude/settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command)
      .toBe('npx --yes openlore orient --json');
    const cursor = JSON.parse(await readFile(join(ctx.root, '.cursor/mcp.json'), 'utf8'));
    expect(cursor.mcpServers.openlore.command).toBe('npx');
    const continueConfig = JSON.parse(await readFile(join(ctx.root, '.continue/config.json'), 'utf8'));
    expect(continueConfig.slashCommands[0].run).toBe('npx --yes openlore orient --json');
  });

  it('migrates managed commands across platforms and is byte-idempotent', async () => {
    const ctx = await context('linux');
    expect((await claudeCodeAdapter.apply(ctx)).conflict).toBe(false);
    const native = await readFile(join(ctx.root, '.mcp.json'), 'utf8');
    expect(native).toContain('"command": "npx"');

    ctx.platform = 'win32';
    expect((await claudeCodeAdapter.apply(ctx)).conflict).toBe(false);
    const windowsMcp = await readFile(join(ctx.root, '.mcp.json'), 'utf8');
    const windowsSettings = await readFile(join(ctx.root, '.claude/settings.json'), 'utf8');
    expect(windowsMcp).toContain('C:\\\\Program Files\\\\nodejs\\\\node.exe');
    expect(windowsSettings).toContain('C:\\\\Program Files\\\\nodejs\\\\node_modules\\\\npm\\\\bin\\\\npx-cli.js');

    const reapplied = await claudeCodeAdapter.apply(ctx);
    expect(reapplied.conflict).toBe(false);
    expect(await readFile(join(ctx.root, '.mcp.json'), 'utf8')).toBe(windowsMcp);
    expect(await readFile(join(ctx.root, '.claude/settings.json'), 'utf8')).toBe(windowsSettings);

    ctx.platform = 'linux';
    expect((await claudeCodeAdapter.uninstall(ctx)).conflict).toBe(false);
  });
});

/**
 * The direct form (change: fix-windows-console-flash-from-npx-shim). Every test above
 * runs from TypeScript source, where no built CLI sits beside the module, so all of them
 * exercise the `npx` FALLBACK. Injecting the entry is the only way to assert what a real,
 * built install actually writes — the shape users get.
 */
describe('a built install wires OpenLore\'s own CLI, never the npx shim', () => {
  const WIN_ENTRY = 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\openlore\\dist\\cli\\index.js';
  const POSIX_ENTRY = '/usr/local/lib/node_modules/openlore/dist/cli/index.js';

  async function builtContext(platform: NodeJS.Platform): Promise<ApplyContext> {
    const ctx = await context(platform);
    const posix = platform !== 'win32';
    ctx.platformCommandRuntime = {
      ...ctx.platformCommandRuntime,
      nodeExecutable: posix ? '/usr/local/bin/node' : 'C:\\Program Files\\nodejs\\node.exe',
      openloreCliEntry: posix ? POSIX_ENTRY : WIN_ENTRY,
    };
    return ctx;
  }

  it.each(['win32', 'linux'] as const)('wires every Claude Code surface directly on %s', async (platform) => {
    const ctx = await builtContext(platform);
    expect((await claudeCodeAdapter.apply(ctx)).conflict).toBe(false);

    const mcp = await readFile(join(ctx.root, '.mcp.json'), 'utf8');
    const settings = await readFile(join(ctx.root, '.claude/settings.json'), 'utf8');
    // The regression this whole change exists to prevent: npx resolves the target bin to
    // openlore.cmd, and a .cmd can only start through cmd.exe — one console window per
    // agent turn for the UserPromptSubmit hook.
    for (const written of [mcp, settings]) {
      expect(written).not.toContain('npx');
      expect(written).not.toContain('.cmd');
    }
    expect(JSON.parse(mcp).mcpServers.openlore.args[0]).toBe(platform === 'win32' ? WIN_ENTRY : POSIX_ENTRY);
    for (const key of ['SessionStart', 'UserPromptSubmit']) {
      expect(JSON.parse(settings).hooks[key][0].hooks[0].command).toContain('cli');
    }
  });

  it.each(['win32', 'linux'] as const)('wires Cursor and Continue directly on %s', async (platform) => {
    const ctx = await builtContext(platform);
    expect((await cursorAdapter.apply(ctx)).conflict).toBe(false);
    expect((await continueAdapter.apply(ctx)).conflict).toBe(false);

    for (const file of ['.cursor/mcp.json', '.continue/config.json']) {
      const written = await readFile(join(ctx.root, file), 'utf8');
      expect(written).not.toContain('npx');
      expect(written).not.toContain('.cmd');
    }
  });

  it('removes the entry it wrote even after the managed marker is gone', async () => {
    // `isOurMcpEntry` identifies a marker-less entry by its argv. The direct form dropped
    // the literal `openlore` argument the old check keyed on; without the path shape, every
    // entry written by this version would be stranded in the user scope.
    const ctx = await builtContext('linux');
    ctx.scope = 'user';
    expect((await claudeCodeAdapter.apply(ctx)).conflict).toBe(false);

    const mcpPath = join(ctx.root, '.claude.json');
    const parsed = JSON.parse(await readFile(mcpPath, 'utf8'));
    expect(parsed.mcpServers.openlore).toBeDefined();
    delete parsed._openlore; // any tool that rewrites this file and drops unknown keys
    await writeFile(mcpPath, JSON.stringify(parsed, null, 2));

    expect((await claudeCodeAdapter.uninstall(ctx)).conflict).toBe(false);
    expect(JSON.parse(await readFile(mcpPath, 'utf8')).mcpServers?.openlore).toBeUndefined();
  });
});
