/**
 * upgrade-repo-only-wiring: `openlore doctor` notices a repository wired before user
 * scope shipped, and `doctor --fix` performs the user-scope install it names.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkInstallHealth, checkUserScopeWiring, planRemediations, runRemediation } from './doctor.js';
import { logger } from '../../utils/logger.js';

/** The June-era repo wiring found on a real machine. */
const JUNE_MCP = {
  mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp'] } },
  _openlore: { managed: true, version: 1, paths: ['mcpServers.openlore'] },
};
const JUNE_SETTINGS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'npx --yes openlore orient --json' }], _openlore: true }],
  },
};

describe('doctor: user-scope wiring', () => {
  let root: string;
  let repo: string;
  let home: string;
  const write = (path: string, doc: unknown): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  };
  const seedJuneRepo = (): void => {
    write(join(repo, '.mcp.json'), JUNE_MCP);
    write(join(repo, '.claude', 'settings.json'), JUNE_SETTINGS);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-user-scope-wiring-')));
    repo = join(root, 'repo');
    home = join(root, 'home');
    mkdirSync(repo);
    mkdirSync(home);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports nothing when neither scope is wired', async () => {
    expect(await checkUserScopeWiring(repo, home, null)).toBeNull();
  });

  it('warns on repo-only wiring and names the doctor --fix remedy', async () => {
    seedJuneRepo();
    const result = await checkUserScopeWiring(repo, home, null);
    expect(result?.status).toBe('warn');
    expect(result?.detail).toContain('.mcp.json, .claude/settings.json');
    expect(result?.detail).toContain('new repositories and worktrees will not reach OpenLore');
    expect(result?.fix).toContain('openlore doctor --fix');
    expect(result?.remediation).toEqual({ kind: 'rewire-user-scope', label: 'openlore install --user-only' });
  });

  it('recognises the hook marker alone as repo wiring', async () => {
    write(join(repo, '.claude', 'settings.json'), JUNE_SETTINGS);
    expect((await checkUserScopeWiring(repo, home, null))?.status).toBe('warn');
  });

  it('warns on an npx user-scope entry when this install writes the direct form', async () => {
    write(join(home, '.claude.json'), { mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp'] } } });
    const result = await checkUserScopeWiring(repo, home, '/opt/openlore/dist/cli/index.js');
    expect(result?.status).toBe('warn');
    expect(result?.detail).toContain('npx');
    expect(result?.remediation?.kind).toBe('rewire-user-scope');
  });

  it('accepts an npx user-scope entry when this install itself writes npx', async () => {
    write(join(home, '.claude.json'), { mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp'] } } });
    expect((await checkUserScopeWiring(repo, home, null))?.status).toBe('ok');
  });

  it('is ok for a current user-scope entry, even with repo wiring too', async () => {
    seedJuneRepo();
    const cli = join(root, 'index.js');
    writeFileSync(cli, '');
    write(join(home, '.claude.json'), { mcpServers: { openlore: { command: process.execPath, args: [cli, 'mcp'] } } });
    const result = await checkUserScopeWiring(repo, home, cli);
    expect(result?.status).toBe('ok');
    expect(result?.remediation).toBeUndefined();
  });

  it('shares Install health\'s remediation for a missing launcher, so --fix runs it once', async () => {
    write(join(home, '.claude.json'), { mcpServers: { openlore: { command: join(root, 'gone', 'node'), args: ['x.js', 'mcp'] } } });
    const wiring = await checkUserScopeWiring(repo, home, null);
    const health = await checkInstallHealth(home, '', 'linux');
    expect(wiring?.status).toBe('warn');
    expect(wiring?.detail).toContain('see Install health');
    expect(planRemediations([health, wiring!])).toHaveLength(1);
  });

  it('doctor --fix wires the user scope of a repo-only install', async () => {
    seedJuneRepo();
    const saved = process.env.OPENLORE_HOME;
    process.env.OPENLORE_HOME = home;
    for (const level of ['info', 'discovery', 'success', 'warning', 'section'] as const) {
      vi.spyOn(logger, level).mockImplementation(() => undefined);
    }
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const before = await checkUserScopeWiring(repo, home, null);
      await runRemediation(repo, before!.remediation!);
      const userMcp = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      expect(userMcp.mcpServers.openlore).toBeDefined();
      expect((await checkUserScopeWiring(repo, home, null))?.status).toBe('ok');
      // The user scope only: the repository's files are left exactly as they were.
      expect(JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8'))).toEqual(JUNE_MCP);
      expect(JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'))).toEqual(JUNE_SETTINGS);
      expect(readdirSync(repo).sort()).toEqual(['.claude', '.mcp.json']);
    } finally {
      if (saved === undefined) delete process.env.OPENLORE_HOME; else process.env.OPENLORE_HOME = saved;
      vi.restoreAllMocks();
    }
  });
});
