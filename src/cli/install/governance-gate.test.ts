/**
 * One entrypoint yields both faces: `openlore install` wires the decisions commit
 * gate in non-blocking autopilot mode (change: unify-onboarding-entrypoint).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall, wireGovernanceGate } from './index.js';
import { OPENLORE_CONFIG_REL_PATH } from '../../constants.js';
import { getDefaultConfig } from '../../core/services/config-manager.js';

const execFileAsync = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeConfig(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(dir, '.openlore'), { recursive: true });
  await writeFile(
    join(dir, OPENLORE_CONFIG_REL_PATH),
    JSON.stringify({ ...getDefaultConfig('nodejs', 'openspec'), ...overrides }, null, 2),
  );
}

describe('install wires the decision trail', () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-gate-'));
    home = await mkdtemp(join(tmpdir(), 'openlore-gate-home-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const initGit = async (): Promise<void> => {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
  };

  it('installs the pre-commit gate and turns autopilot on, so no commit blocks', async () => {
    await initGit();
    await writeConfig(dir);

    expect(await wireGovernanceGate(dir)).toBe('wired');

    const hook = await readFile(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('decisions');
    const config = JSON.parse(await readFile(join(dir, OPENLORE_CONFIG_REL_PATH), 'utf8'));
    expect(config.governance.autopilot).toBe(true);
  });

  it('respects an explicit autopilot:false — blocking review stays the configured mode', async () => {
    await initGit();
    await writeConfig(dir, { governance: { autopilot: false } });

    expect(await wireGovernanceGate(dir)).toBe('wired');

    const config = JSON.parse(await readFile(join(dir, OPENLORE_CONFIG_REL_PATH), 'utf8'));
    expect(config.governance.autopilot).toBe(false);
    expect(await exists(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(true);
  });

  it('skips quietly outside a git repository, and never fails the install', async () => {
    await writeConfig(dir);
    expect(await wireGovernanceGate(dir)).toBe('skipped');
    expect(await exists(join(dir, '.git'))).toBe(false);
  });

  it('skips when there is no config yet', async () => {
    await initGit();
    expect(await wireGovernanceGate(dir)).toBe('skipped');
  });

  it('bare install wires the gate, and --uninstall removes it', async () => {
    await initGit();
    await writeConfig(dir);

    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home })).toBe(0);
    expect(await exists(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(true);

    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home, uninstall: true })).toBe(0);
    const stillThere = await exists(join(dir, '.git', 'hooks', 'pre-commit'));
    if (stillThere) {
      expect(await readFile(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'))
        .not.toContain('openlore-decisions-hook');
    }
  });

  it('--dry-run writes no hook and no config change', async () => {
    await initGit();
    await writeConfig(dir);
    const before = await readFile(join(dir, OPENLORE_CONFIG_REL_PATH), 'utf8');

    expect(await runInstall({ cwd: dir, agent: 'claude-code', dryRun: true, home })).toBe(0);

    expect(await exists(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(await readFile(join(dir, OPENLORE_CONFIG_REL_PATH), 'utf8')).toBe(before);
  });
});
