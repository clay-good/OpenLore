/**
 * upgrade-repo-only-wiring: after a successful upgrade, `openlore update` offers the
 * user-scope wiring once, on an interactive terminal only.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offerUserScopeWiring, type WiringOffer } from './update.js';
import { logger } from '../../utils/logger.js';

describe('openlore update: user-scope wiring offer', () => {
  let root: string;
  let repo: string;
  let home: string;
  const offer = (overrides: Partial<WiringOffer>): WiringOffer => ({
    rootPath: repo,
    home,
    isTTY: true,
    yes: false,
    confirm: vi.fn(async () => true),
    rewire: vi.fn(async () => 0),
    currentEntry: null,
    ...overrides,
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-update-offer-')));
    repo = join(root, 'repo');
    home = join(root, 'home');
    mkdirSync(repo);
    mkdirSync(home);
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({
      mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp'] } },
      _openlore: { managed: true, version: 1, paths: ['mcpServers.openlore'] },
    }));
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warning').mockImplementation(() => undefined);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes nothing on a non-interactive run, even with --yes', async () => {
    const o = offer({ isTTY: false, yes: true });
    expect(await offerUserScopeWiring(o)).toBe('not-offered');
    expect(o.confirm).not.toHaveBeenCalled();
    expect(o.rewire).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it('asks once on a terminal and writes nothing when declined', async () => {
    const o = offer({ confirm: vi.fn(async () => false) });
    expect(await offerUserScopeWiring(o)).toBe('declined');
    expect(o.confirm).toHaveBeenCalledTimes(1);
    expect(o.rewire).not.toHaveBeenCalled();
  });

  it('wires on agreement', async () => {
    const o = offer({});
    expect(await offerUserScopeWiring(o)).toBe('wired');
    expect(o.rewire).toHaveBeenCalledTimes(1);
  });

  it('accepts without asking under --yes', async () => {
    const o = offer({ yes: true });
    expect(await offerUserScopeWiring(o)).toBe('wired');
    expect(o.confirm).not.toHaveBeenCalled();
    expect(o.rewire).toHaveBeenCalledTimes(1);
  });

  it('does not offer when the user scope is already wired', async () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp'] } },
    }));
    const o = offer({});
    expect(await offerUserScopeWiring(o)).toBe('not-needed');
    expect(o.confirm).not.toHaveBeenCalled();
  });
});
