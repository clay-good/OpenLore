import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter } from './codex.js';
import type { ApplyContext } from './types.js';

const roots: string[] = [];

async function context(root?: string): Promise<ApplyContext> {
  const resolvedRoot = root ?? await mkdtemp(join(tmpdir(), 'openlore-codex-adapter-'));
  roots.push(resolvedRoot);
  return {
    root: resolvedRoot,
    scope: 'repo',
    platform: 'darwin',
    platformCommandRuntime: { nodeExecutable: process.execPath, pathValue: process.env.PATH },
    instructionTemplate: 'Use OpenLore.',
    dryRun: false,
    force: false,
    preset: 'substrate',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex install adapter', () => {
  it('registers MCP orientation and proposal hook while preserving user hooks', async () => {
    const ctx = await context();
    const hooksPath = join(ctx.root, '.codex', 'hooks.json');
    await mkdir(join(ctx.root, '.codex'), { recursive: true });
    const userHook = { matcher: 'other-event', hooks: [{ type: 'command', command: 'echo user' }] };
    await writeFile(hooksPath, JSON.stringify({ hooks: { UserPromptSubmit: [userHook] } }));

    const result = await codexAdapter.apply(ctx);
    const config = await readFile(join(ctx.root, '.codex', 'config.toml'), 'utf8');
    const hooks = JSON.parse(await readFile(hooksPath, 'utf8'));

    expect(result.conflict).toBe(false);
    expect(config).toContain('[mcp_servers.openlore]');
    expect(config).toContain('"mcp"');
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.hooks.UserPromptSubmit[0]).toEqual(userHook);
    expect(hooks.hooks.UserPromptSubmit[1].matcher).toBe('openlore-proposal-context-v1');
    expect(await codexAdapter.isConnected(ctx.root)).toBe(true);
  });

  it('removes only OpenLore-owned entries on uninstall', async () => {
    const ctx = await context();
    await mkdir(join(ctx.root, '.codex'), { recursive: true });
    const userHook = { matcher: 'other-event', hooks: [{ type: 'command', command: 'echo user' }] };
    await writeFile(join(ctx.root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [userHook] } }));
    await codexAdapter.apply(ctx);

    await codexAdapter.uninstall(ctx);

    const hooks = JSON.parse(await readFile(join(ctx.root, '.codex', 'hooks.json'), 'utf8'));
    const config = await readFile(join(ctx.root, '.codex', 'config.toml'), 'utf8');
    expect(hooks.hooks.UserPromptSubmit).toEqual([userHook]);
    expect(config).not.toContain('openlore managed');
    expect(await codexAdapter.isConnected(ctx.root)).toBe(false);
  });

  it('skips a duplicate project integration when the managed user hook is installed', async () => {
    const user = await mkdtemp(join(tmpdir(), 'openlore-codex-user-'));
    const project = await mkdtemp(join(tmpdir(), 'openlore-codex-project-'));
    roots.push(user, project);
    const userContext = await context(user);
    await codexAdapter.apply(userContext);
    const projectContext = {
      ...(await context(project)),
      userScopeRoot: user,
    };

    const result = await codexAdapter.apply(projectContext);

    expect(result.changes[0]?.summary).toContain('skipped duplicate project hook');
    await expect(readFile(join(project, '.codex', 'config.toml'), 'utf8')).rejects.toThrow();
  });

  it('adds project MCP when only the user-scope hook exists, without duplicating the hook', async () => {
    const user = await mkdtemp(join(tmpdir(), 'openlore-codex-user-partial-'));
    const project = await mkdtemp(join(tmpdir(), 'openlore-codex-project-partial-'));
    roots.push(user, project);
    await mkdir(join(user, '.codex'), { recursive: true });
    await writeFile(join(user, '.codex', 'hooks.json'), JSON.stringify({
      hooks: { UserPromptSubmit: [{
        matcher: 'openlore-proposal-context-v1',
        hooks: [{ type: 'command', command: 'openlore orient --proposal-only', timeout: 15 }],
      }] },
    }));

    const projectContext = {
      ...(await context(project)),
      userScopeRoot: user,
    };
    await codexAdapter.apply(projectContext);

    const config = await readFile(join(project, '.codex', 'config.toml'), 'utf8');
    expect(config).toContain('[mcp_servers.openlore]');
    await expect(readFile(join(project, '.codex', 'hooks.json'), 'utf8')).rejects.toThrow();
  });

  it.each([
    ['an inline table under [mcp_servers]', '[mcp_servers]\nopenlore = { command = "mine" }\n'],
    ['a quoted table key', '[mcp_servers."openlore"]\ncommand = "mine"\n'],
    ['a root dotted key', 'mcp_servers.openlore.command = "mine"\n'],
  ])('preserves a user-defined openlore server written as %s instead of appending a duplicate table', async (_label, original) => {
    const ctx = await context();
    await mkdir(join(ctx.root, '.codex'), { recursive: true });
    await writeFile(join(ctx.root, '.codex', 'config.toml'), original);

    const result = await codexAdapter.apply(ctx);

    const config = await readFile(join(ctx.root, '.codex', 'config.toml'), 'utf8');
    expect(config).toBe(original);
    expect(result.warnings.join('\n')).toContain('already defines mcp_servers.openlore');
  });

  it('does not append an array-of-tables hook over an inline hooks.UserPromptSubmit array', async () => {
    const ctx = await context();
    await mkdir(join(ctx.root, '.codex'), { recursive: true });
    const original = '[hooks]\nUserPromptSubmit = [{ matcher = "mine", hooks = [] }]\n';
    await writeFile(join(ctx.root, '.codex', 'config.toml'), original);

    const result = await codexAdapter.apply(ctx);

    const config = await readFile(join(ctx.root, '.codex', 'config.toml'), 'utf8');
    expect(config.startsWith(original)).toBe(true);
    expect(config).not.toContain('[[hooks.UserPromptSubmit]]');
    expect(config).toContain('[mcp_servers.openlore]');
    expect(result.warnings.join('\n')).toContain('defines hooks.UserPromptSubmit inline');
    await expect(readFile(join(ctx.root, '.codex', 'hooks.json'), 'utf8')).rejects.toThrow();
  });

  it('moves the managed hook out of hooks.json when config.toml gains hooks, so it fires once', async () => {
    const ctx = await context();
    await codexAdapter.apply(ctx);
    const configPath = join(ctx.root, '.codex', 'config.toml');
    const userHook = '[[hooks.UserPromptSubmit]]\nmatcher = "mine"\n';
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n${userHook}`);

    await codexAdapter.apply(ctx);
    const second = await codexAdapter.apply(ctx);

    const config = await readFile(configPath, 'utf8');
    const hooks = JSON.parse(await readFile(join(ctx.root, '.codex', 'hooks.json'), 'utf8'));
    expect(config).toContain('openlore-proposal-context-v1');
    expect(JSON.stringify(hooks)).not.toContain('openlore-proposal-context-v1');
    expect(second.changes.every((change) => change.kind === 'noop')).toBe(true);
  });
});
