/**
 * Bare `openlore install` wires the USER scope, so every future repository reaches
 * OpenLore without another command (change: unify-onboarding-entrypoint).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall, resolveUserScopeRoot } from './index.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import type { ApplyContext } from './adapters/types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
}

describe('user-scope wiring', () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-us-repo-'));
    home = await mkdtemp(join(tmpdir(), 'openlore-us-home-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const install = (extra: Record<string, unknown> = {}) =>
    runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home, ...extra });

  it('writes the MCP server, hooks, permission, and instructions into the user scope', async () => {
    expect(await install()).toBe(0);

    const mcp = await readJson(join(home, '.claude.json'));
    const servers = mcp.mcpServers as Record<string, { args?: string[] }>;
    expect(servers.openlore).toBeDefined();
    expect(servers.openlore.args?.join(' ')).toContain('mcp');

    const settings = await readJson(join(home, '.claude', 'settings.json'));
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    const permissions = settings.permissions as { allow: string[] };
    expect(permissions.allow).toContain('Bash(openlore:*)');

    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain('OPENLORE');
  });

  it('still wires the repository it was run in', async () => {
    await install();
    expect(await exists(join(dir, '.mcp.json'))).toBe(true);
    expect(await exists(join(dir, 'CLAUDE.md'))).toBe(true);
    // The user scope never lands inside the repository, and vice versa.
    expect(await exists(join(dir, '.claude.json'))).toBe(false);
    expect(await exists(join(home, '.mcp.json'))).toBe(false);
  });

  it('is idempotent — a second install rewrites nothing', async () => {
    await install();
    const before = await readFile(join(home, '.claude.json'), 'utf8');
    const settingsBefore = await readFile(join(home, '.claude', 'settings.json'), 'utf8');
    expect(await install()).toBe(0);
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe(before);
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe(settingsBefore);
  });

  it('--repo-only writes no user-scope entry at all', async () => {
    expect(await install({ repoOnly: true })).toBe(0);
    expect(await exists(join(home, '.claude.json'))).toBe(false);
    expect(await exists(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(await exists(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(await exists(join(dir, '.mcp.json'))).toBe(true);
  });

  it('preserves unrelated user configuration byte-for-byte outside our keys', async () => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ numStartups: 42, projects: { '/somewhere': { allowedTools: [] } } }, null, 2) + '\n',
    );
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2) + '\n');

    await install();

    const mcp = await readJson(join(home, '.claude.json'));
    expect(mcp.numStartups).toBe(42);
    expect(mcp.projects).toEqual({ '/somewhere': { allowedTools: [] } });
    const settings = await readJson(join(home, '.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
  });

  it('--uninstall removes only OpenLore-managed entries, from both scopes', async () => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ numStartups: 7 }, null, 2) + '\n',
    );
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'mine' }] }] } }, null, 2) + '\n',
    );

    await install();
    expect(await install({ uninstall: true })).toBe(0);

    const mcp = await readJson(join(home, '.claude.json'));
    expect(mcp.mcpServers).toBeUndefined();
    expect(mcp.numStartups).toBe(7);

    const settings = await readJson(join(home, '.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
    const sessionStart = (settings.hooks as Record<string, unknown[]>).SessionStart;
    expect(sessionStart).toHaveLength(1);
    expect(JSON.stringify(sessionStart)).toContain('mine');
    expect(JSON.stringify(sessionStart)).not.toContain('openlore');
    expect((settings.permissions as { allow?: string[] } | undefined)?.allow ?? [])
      .not.toContain('Bash(openlore:*)');

    // The repository scope is cleaned in the same run.
    expect(await exists(join(dir, '.mcp.json'))).toBe(false);
  });

  it('never deletes the user config file even when our entries were all it held', async () => {
    await install();
    await install({ uninstall: true });
    // ~/.claude.json is Claude Code's own account state — ours to edit, never to remove.
    expect(await exists(join(home, '.claude.json'))).toBe(true);
  });

  it('--uninstall --repo-only leaves the user scope wired', async () => {
    await install();
    await install({ uninstall: true, repoOnly: true });
    const mcp = await readJson(join(home, '.claude.json'));
    expect((mcp.mcpServers as Record<string, unknown>).openlore).toBeDefined();
    expect(await exists(join(dir, '.mcp.json'))).toBe(false);
  });

  it('bare install (no --agent) writes the user scope even when only another agent is detected', async () => {
    // The promise is "install once, every repository works", so the user-scope
    // candidate set is CAPABILITY-driven. Detection answers a different question:
    // a repo containing a `.cursor/` marker short-circuits detect()'s ~/.claude
    // probe, and a detection-driven set would silently skip the user scope here.
    await mkdir(join(dir, '.cursor'), { recursive: true });

    expect(await runInstall({ cwd: dir, analyze: false, home })).toBe(0);

    const mcp = await readJson(join(home, '.claude.json'));
    expect((mcp.mcpServers as Record<string, unknown>).openlore).toBeDefined();
    // …and the detected agent is still wired for this repository.
    expect(await exists(join(dir, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('an adapter with no user scope is wired per-repo only, and the command still exits 0', async () => {
    expect(await runInstall({ cwd: dir, agent: 'cursor', analyze: false, home })).toBe(0);
    expect(await exists(join(home, '.cursor'))).toBe(false);
    expect(await exists(join(dir, '.cursor'))).toBe(true);
  });

  it('--dry-run previews the user scope without writing it', async () => {
    expect(await install({ dryRun: true })).toBe(0);
    expect(await exists(join(home, '.claude.json'))).toBe(false);
    expect(await exists(join(dir, '.mcp.json'))).toBe(false);
  });

  it('--dry-run plans each user-scope file exactly once, and plans it correctly', async () => {
    const ctx: ApplyContext = {
      root: home,
      scope: 'user',
      platform: process.platform,
      platformCommandRuntime: {
        nodeExecutable: process.execPath,
        npmExecPath: undefined,
        pathValue: process.env.PATH,
        cwd: process.cwd(),
      },
      instructionTemplate: '# test\n',
      dryRun: true,
      force: false,
    };
    const result = await claudeCodeAdapter.apply(ctx);

    const settingsPath = join(home, '.claude', 'settings.json');
    const forSettings = result.changes.filter(change => change.path === settingsPath);
    // One plan entry per file. Two would mean two writes of the same path, the
    // second describing a file that clobbers the first — and a dry-run that does
    // not describe the real outcome is worse than no dry-run.
    expect(forSettings).toHaveLength(1);
    // The single plan covers BOTH things that file carries in the user scope.
    expect(forSettings[0].summary).toContain('hooks');
    expect(forSettings[0].summary).toContain('Bash(openlore:*)');
    const preview = forSettings[0].preview ?? '';
    expect(preview).toContain('SessionStart');
    expect(preview).toContain('Bash(openlore:*)');
  });
});

describe('resolveUserScopeRoot', () => {
  it('prefers an explicit root, then OPENLORE_HOME', () => {
    expect(resolveUserScopeRoot('/explicit')).toBe('/explicit');
    const previous = process.env.OPENLORE_HOME;
    process.env.OPENLORE_HOME = '/from-env';
    try {
      expect(resolveUserScopeRoot()).toBe('/from-env');
    } finally {
      if (previous === undefined) delete process.env.OPENLORE_HOME;
      else process.env.OPENLORE_HOME = previous;
    }
  });

  it('refuses the real home under a test runner rather than editing it silently', () => {
    const previous = process.env.OPENLORE_HOME;
    delete process.env.OPENLORE_HOME;
    try {
      expect(() => resolveUserScopeRoot()).toThrow(/refusing to write user-scope configuration/);
    } finally {
      if (previous !== undefined) process.env.OPENLORE_HOME = previous;
    }
  });
});

describe('connect remove is repository-scoped by default', () => {
  it('leaves the user scope wired unless --user-scope is passed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openlore-cr-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'openlore-cr-home-'));
    try {
      await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home });

      // What `connect remove claude-code` now passes.
      await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home, uninstall: true, repoOnly: true });

      const mcp = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
      expect((mcp.mcpServers as Record<string, unknown>).openlore).toBeDefined();
      expect(await exists(join(dir, '.mcp.json'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
