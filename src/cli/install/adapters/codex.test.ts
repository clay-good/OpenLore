import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter } from './codex.js';
import { runInstall } from '../index.js';
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
  // A root can be pushed twice (by the test and by context()); concurrent rm of one dir is EPERM on Windows.
  await Promise.all([...new Set(roots.splice(0))].map((root) => rm(root, { recursive: true, force: true })));
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

  it('wires the agent-loop moments in hooks.json, idempotently, and removes only them on uninstall', async () => {
    const ctx = await context();
    await mkdir(join(ctx.root, '.codex'), { recursive: true });
    const userPre = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] };
    await writeFile(join(ctx.root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [userPre] } }));
    await codexAdapter.apply(ctx);
    await codexAdapter.apply(ctx);
    const hooks = JSON.parse(await readFile(join(ctx.root, '.codex', 'hooks.json'), 'utf8')).hooks;
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0]).toEqual(userPre);
    expect(hooks.PreToolUse[1]).toMatchObject({ matcher: 'apply_patch', hooks: [{ type: 'command', timeout: 15 }] });
    expect(hooks.PreToolUse[1].hooks[0].command).toMatch(/hook before-edit --harness codex$/);
    expect(hooks.PostToolUse[0]).toMatchObject({ matcher: 'apply_patch|Bash' });
    expect(hooks.Stop[0].hooks[0].command).toMatch(/hook before-stop --harness codex$/);
    expect(hooks.SessionStart[0]).toMatchObject({ matcher: 'compact' });

    await codexAdapter.uninstall(ctx);
    const after = JSON.parse(await readFile(join(ctx.root, '.codex', 'hooks.json'), 'utf8')).hooks;
    expect(after).toEqual({ PreToolUse: [userPre] });
  });

  it('a user hook added inside an OpenLore group survives uninstall; a hooks file only OpenLore wrote is removed', async () => {
    const ctx = await context();
    await codexAdapter.apply(ctx);
    const path = join(ctx.root, '.codex', 'hooks.json');
    const doc = JSON.parse(await readFile(path, 'utf8'));
    const mine = { type: 'command', command: 'echo mine' };
    doc.hooks.Stop[0].hooks.push(mine);
    await writeFile(path, JSON.stringify(doc));
    await codexAdapter.uninstall(ctx);
    expect(JSON.parse(await readFile(path, 'utf8')).hooks).toEqual({ Stop: [{ hooks: [mine] }] });

    const other = await context();
    await codexAdapter.apply(other);
    const result = await codexAdapter.uninstall(other);
    await expect(readFile(join(other.root, '.codex', 'hooks.json'), 'utf8')).rejects.toThrow();
    expect(result.changes.some(c => c.kind === 'delete')).toBe(true);
  });

  it('a hooks.json event that is not a list is left alone with a warning', async () => {
    const ctx = await context();
    await mkdir(join(ctx.root, '.codex'), { recursive: true });
    await writeFile(join(ctx.root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: { odd: true } } }));
    const result = await codexAdapter.apply(ctx);
    const hooks = JSON.parse(await readFile(join(ctx.root, '.codex', 'hooks.json'), 'utf8')).hooks;
    expect(hooks.Stop).toEqual({ odd: true });
    expect(result.warnings.join('\n')).toContain('hooks.Stop is not a list');
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
    // Only the agent-loop moments: no second proposal hook.
    expect(JSON.parse(await readFile(join(project, '.codex', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit).toBeUndefined();
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
    // Only the agent-loop moments: no second proposal hook.
    expect(JSON.parse(await readFile(join(ctx.root, '.codex', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit).toBeUndefined();
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

  it('removes a stale project hook once the user scope carries the managed hook', async () => {
    const user = await mkdtemp(join(tmpdir(), 'openlore-codex-user-stale-'));
    const project = await mkdtemp(join(tmpdir(), 'openlore-codex-project-stale-'));
    roots.push(user, project);
    await codexAdapter.apply(await context(project));
    await codexAdapter.apply(await context(user));

    await codexAdapter.apply({ ...(await context(project)), userScopeRoot: user });

    const hooks = await readFile(join(project, '.codex', 'hooks.json'), 'utf8');
    expect(hooks).not.toContain('openlore-proposal-context-v1');
    expect(await readFile(join(user, '.codex', 'hooks.json'), 'utf8')).toContain('openlore-proposal-context-v1');
  });

  it('sees the user-scope hook under --repo-only and does not install a second one', async () => {
    const user = await mkdtemp(join(tmpdir(), 'openlore-codex-user-repo-only-'));
    const project = await mkdtemp(join(tmpdir(), 'openlore-codex-project-repo-only-'));
    roots.push(user, project);
    await codexAdapter.apply(await context(user));

    await runInstall({ cwd: project, agent: 'codex', repoOnly: true, home: user, analyze: false });

    // Only the agent-loop moments: no second proposal hook.
    expect(JSON.parse(await readFile(join(project, '.codex', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit).toBeUndefined();
  });
});
