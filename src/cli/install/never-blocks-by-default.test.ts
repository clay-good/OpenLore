/**
 * `openlore install` never installs a BLOCKING commit gate by default, and never prints a
 * summary that disagrees with the gate it installed (change: fix-install-never-blocks-by-default).
 *
 * The release blocker these pin: `openlore install --no-analyze` runs no `init`, so the repository
 * had no `.openlore/config.json`; the gate read that absence as "blocking review", installed a
 * blocking gate, printed "Commits will be gated until decisions are approved", and then printed
 * "Decision trail on — ... no commit is blocked by default" immediately after. A `git commit` with
 * one pending draft then exited 1, and both remedies the gate printed failed from that state.
 *
 * Governance in OpenLore is advisory evidence that never blocks by default
 * (openspec/specs/overview — the deterministic-substrate north star), so this is a correctness
 * bug in the gate, not a preference. A message that contradicts what the code did is the worst
 * part of it: a user cannot discover the problem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall, wireGovernanceGate } from './index.js';
import { resolveTrustedHookLauncher } from '../git-hooks.js';
import { OPENLORE_CONFIG_REL_PATH } from '../../constants.js';
import { getDefaultConfig } from '../../core/services/config-manager.js';
import { resolveAutopilotMode } from '../../core/decisions/autopilot.js';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

/** Same precondition as governance-gate.test.ts: a gate pins an external, immutable launcher. */
const launcherAvailable = (await resolveTrustedHookLauncher(tmpdir())) !== null;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Every line install wrote through the logger, as one string. */
function captureLog(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spies = (['info', 'success', 'warning', 'discovery', 'error'] as const).map((level) =>
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }) as never),
  );
  return { text: () => lines.join('\n'), restore: () => spies.forEach((s) => s.mockRestore()) };
}

describe.skipIf(!launcherAvailable)('install never installs a blocking gate by default', () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-nb-'));
    home = await mkdtemp(join(tmpdir(), 'openlore-nb-home-'));
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await writeFile(join(dir, 'package.json'), '{"name":"nb","version":"1.0.0"}\n');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'app.ts'), 'export function greet(n: string) { return n; }\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'initial'],
      { cwd: dir },
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('--no-analyze installs a gate that is non-blocking, with no config written', async () => {
    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home })).toBe(0);

    // A gate IS installed — the trail is the point of the command.
    expect(await readFile(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'))
      .toContain('openlore-decisions-hook');
    // And `--no-analyze` still performed no init: install does not create the config the
    // user declined, so the non-blocking default must not depend on that file existing.
    expect(await exists(join(dir, OPENLORE_CONFIG_REL_PATH))).toBe(false);
    // The mode the gate itself will resolve, read the way the hook reads it.
    // Read the way the HOOK reads it — that is the face that decides whether a commit blocks.
    expect(await resolveAutopilotMode(dir, null, { gateRunning: true }))
      .toMatchObject({ autopilot: true });
  });

  it('the printed summary agrees with the gate that was installed', async () => {
    const log = captureLog();
    try {
      expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home })).toBe(0);
      const text = log.text();
      // The headline claim is made, and it is now true.
      expect(text).toContain('no commit is blocked by default');
      // The two contradictions that used to be printed in the same run are gone.
      expect(text).not.toContain('Commits will be gated until decisions are approved');
      expect(text).not.toContain('installing the gate in blocking review mode');
    } finally {
      log.restore();
    }
  });

  it('a blocking gate is reported as blocking, never as non-blocking', async () => {
    // The one path that still blocks: the repository explicitly asked for it. The summary
    // must say THAT, and must not print the non-blocking sentence.
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(
      join(dir, OPENLORE_CONFIG_REL_PATH),
      JSON.stringify({ ...getDefaultConfig('nodejs', 'openspec'), governance: { autopilot: false } }, null, 2),
    );
    const log = captureLog();
    try {
      expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home })).toBe(0);
      const text = log.text();
      expect(text).toContain('BLOCKING review mode');
      expect(text).not.toContain('no commit is blocked by default');
    } finally {
      log.restore();
    }
    expect(await wireGovernanceGate(dir)).toMatchObject({ status: 'wired', autopilot: false });
  });

  it('the commit hook exits 0 with a pending draft under the default install', async () => {
    // The end of the reported repro: `openlore install --no-analyze`, record a decision, commit.
    // It exited 1 with raw JSON on stderr, and both printed remedies failed from that state.
    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home })).toBe(0);

    // One draft decision, pending consolidation — the exact state that gated the commit.
    await mkdir(join(dir, '.openlore', 'decisions'), { recursive: true });
    await writeFile(
      join(dir, '.openlore', 'decisions', 'pending.json'),
      JSON.stringify({
        decisions: [{
          id: 'd2e649a6',
          title: 'Use a repository class for users',
          rationale: 'keeps storage swappable',
          consequences: '',
          status: 'draft',
          recordedAt: new Date().toISOString(),
          affectedDomains: [],
          affectedFiles: [],
          syncedToSpecs: [],
        }],
      }, null, 2),
    );

    await writeFile(join(dir, 'src', 'app.ts'), 'export function greet(n: string) { return n; } // x\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    // Resolves, rather than throwing on a non-zero exit — the assertion IS the exit code.
    const committed = await execFileAsync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'test commit'],
      { cwd: dir },
    ).then(() => 0, (err: { code?: number }) => err.code ?? 1);
    expect(committed).toBe(0);
  });
});

describe('a destructive user-scope removal names what it touched', () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-unwire-'));
    home = await mkdtemp(join(tmpdir(), 'openlore-unwire-home-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('prints the absolute path and the all-repositories consequence', async () => {
    // This really happened during QA on a developer machine: a per-repo `install --uninstall`
    // stripped `mcpServers.openlore` from the GLOBAL `~/.claude.json`, unwiring every
    // repository, and said only "[did update] strip OpenLore entries from .claude.json" — no
    // path, no scope, no consequence. The install side had always been explicit.
    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home })).toBe(0);

    const log = captureLog();
    try {
      expect(await runInstall({ cwd: dir, analyze: false, home, uninstall: true })).toBe(0);
      const text = log.text();
      // The absolute path of the user-scope file, on the line that reports touching it.
      expect(text).toContain(`[user scope: ${join(home, '.claude.json')}]`);
      // And the consequence, stated plainly.
      expect(text).toContain('This affects ALL repositories, not just this one');
      expect(text).toContain(home);
      expect(text).toContain('--repo-only');
    } finally {
      log.restore();
    }
  });

  it('--repo-only leaves the user scope alone and says so', async () => {
    expect(await runInstall({ cwd: dir, agent: 'claude-code', analyze: false, home })).toBe(0);
    const log = captureLog();
    try {
      expect(await runInstall({ cwd: dir, analyze: false, home, uninstall: true, repoOnly: true })).toBe(0);
      const text = log.text();
      expect(text).not.toContain('This affects ALL repositories');
      expect(text).toContain('user-scope entries were left in place');
    } finally {
      log.restore();
    }
    // The global entry survives.
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toContain('openlore');
  });
});
