/**
 * One entrypoint yields both faces: `openlore install` wires the decisions commit
 * gate in non-blocking autopilot mode (change: unify-onboarding-entrypoint).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall, wireGovernanceGate } from './index.js';
import { resolveTrustedHookLauncher } from '../git-hooks.js';
import { OPENLORE_CONFIG_REL_PATH } from '../../constants.js';
import { getDefaultConfig } from '../../core/services/config-manager.js';

const execFileAsync = promisify(execFile);

/**
 * A commit gate must pin an EXTERNAL, immutable launcher — it must never execute
 * code the repository being committed to can change — so `installPreCommitHook`
 * refuses without a built `dist/`. The Linux unit job builds it first for exactly
 * this reason ("Build trusted hook launcher", .github/workflows/ci.yml); the
 * Windows job does not.
 *
 * Gated on that PRECONDITION rather than on the platform, so these tests run
 * wherever the launcher resolves and are honestly skipped where it cannot — on any
 * OS, including a developer machine that has not run `npm run build`.
 */
const launcherAvailable = (await resolveTrustedHookLauncher(tmpdir())) !== null;

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

describe.skipIf(!launcherAvailable)('install wires the decision trail', () => {
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

  it('still installs the gate when there is no config yet, in blocking review mode', async () => {
    // `openlore setup --tools claude` never runs init, and has always installed the
    // gate. A missing config only means there is nowhere to record the non-blocking
    // default — not that the gate should be skipped.
    await initGit();
    expect(await wireGovernanceGate(dir)).toBe('wired');
    expect(await exists(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(true);
    expect(await exists(join(dir, OPENLORE_CONFIG_REL_PATH))).toBe(false);
  });

  it('bare install wires the gate, and a whole-install uninstall removes it', async () => {
    await initGit();
    await writeConfig(dir);

    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home })).toBe(0);
    expect(await exists(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(true);

    expect(await runInstall({ cwd: dir, analyze: false, home, uninstall: true })).toBe(0);
    const stillThere = await exists(join(dir, '.git', 'hooks', 'pre-commit'));
    if (stillThere) {
      expect(await readFile(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'))
        .not.toContain('openlore-decisions-hook');
    }
  });

  it('an agent-scoped removal leaves the commit gate alone', async () => {
    // The gate belongs to `openlore install`, not to any one agent surface.
    // `connect remove cursor` has nothing to do with git hooks, and must not
    // delete a decisions gate the user may have installed by another route.
    await initGit();
    await writeConfig(dir);
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home });

    expect(await runInstall({ cwd: dir, agent: 'cursor', analyze: false, home, uninstall: true })).toBe(0);

    expect(await readFile(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'))
      .toContain('openlore-decisions-hook');
  });

  it('never downgrades a commit gate that is already installed', async () => {
    // An absent `governance.autopilot` means BLOCKING review. A later install run
    // (to change a preset, say) must not silently flip an existing gate to
    // auto-accept.
    await initGit();
    await writeConfig(dir);
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home });
    // Simulate a gate configured for blocking review before this feature existed.
    await writeConfig(dir);
    expect(JSON.parse(await readFile(join(dir, OPENLORE_CONFIG_REL_PATH), 'utf8')).governance)
      .toBeUndefined();

    expect(await wireGovernanceGate(dir)).toBe('wired');

    const config = JSON.parse(await readFile(join(dir, OPENLORE_CONFIG_REL_PATH), 'utf8'));
    expect(config.governance?.autopilot).not.toBe(true);
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

describe.skipIf(!launcherAvailable)('the gate reports honestly when it cannot be installed', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-gate-fail-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('does not read a SUCCESSFUL install as failed because an earlier step failed', async () => {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await writeConfig(dir);
    // The index build runs before the gate and reports its own failure by setting
    // the exit code. That must not be mistaken for the gate's outcome.
    process.exitCode = 1;

    expect(await wireGovernanceGate(dir)).toBe('wired');
    expect(await exists(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(true);
  });

  it('does not read a hook failure as success when an earlier step already failed', async () => {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await writeConfig(dir);
    // Make the hook path unwritable so installPreCommitHook fails, and set the
    // exit code first: a delta comparison would see "1 before, 1 after" and call
    // that success.
    await rm(join(dir, '.git', 'hooks'), { recursive: true, force: true });
    await writeFile(join(dir, '.git', 'hooks'), 'not a directory');
    process.exitCode = 1;

    expect(await wireGovernanceGate(dir)).toBe('skipped');
    // And the failure did not leak out as the command's exit code.
    expect(process.exitCode).toBe(1);
  });
});

describe('the trail is wired on a repository seeing OpenLore for the first time', () => {
  it('wires the gate AFTER the index build, which is what creates the config', async () => {
    // The ordering that matters: on a fresh repo `.openlore/config.json` does not
    // exist until the install's own index build runs `init`. Wiring the gate before
    // that meant the headline flow always reported "no config yet" and silently
    // skipped the decision trail — invisible to any test that pre-creates a config.
    const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    const analyzeBlock = source.slice(source.indexOf('const shouldAnalyze'));
    const buildAt = analyzeBlock.indexOf('await buildIndex(cwd)');
    const gateAt = analyzeBlock.indexOf('await wireGovernanceGate(cwd)');
    expect(buildAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(buildAt);
  });
});
