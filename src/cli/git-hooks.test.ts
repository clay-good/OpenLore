import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEnforcementHook, uninstallEnforcementHook } from './commands/enforce.js';
import {
  installPreCommitHook as installDecisionsHook,
  runPostCommitDecisionCheck,
  uninstallPreCommitHook as uninstallDecisionsHook,
} from './commands/decisions.js';
import {
  installPreCommitHook as installDriftHook,
  uninstallPreCommitHook as uninstallDriftHook,
} from './commands/drift.js';
import { installBlastRadiusHook } from './commands/blast-radius.js';
import { installImpactCertificateHook } from './commands/impact-certificate.js';
import { installPostCommitHook as installRefreshStoriesHook } from './commands/refresh-stories.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const created: string[] = [];

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  created.push(root);
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('effective Git hook delivery', () => {
  it('wires Husky through its public script instead of its internal hooks directory', async () => {
    const root = await repository('openlore-husky-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@openlore.dev'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'OpenLore Test'], { cwd: root });
    await mkdir(join(root, '.husky', '_'), { recursive: true });
    await writeFile(
      join(root, '.husky', '_', 'pre-commit'),
      '#!/bin/sh\nsh "$(dirname "$0")/../pre-commit"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(root, '.husky', 'pre-commit'),
      '#!/bin/sh\nprintf ran > hook-ran\n',
      { mode: 0o755 },
    );

    await installEnforcementHook(root);

    expect(await readFile(join(root, '.husky', 'pre-commit'), 'utf-8'))
      .toContain('# openlore-enforcement-hook');
    expect(await readFile(join(root, '.husky', '_', 'pre-commit'), 'utf-8'))
      .not.toContain('# openlore-enforcement-hook');
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'exercise Husky hook'], { cwd: root });
    expect(await readFile(join(root, 'hook-ran'), 'utf-8')).toBe('ran');
  });

  it('warns instead of claiming a Husky install when the executable shim is missing', async () => {
    const root = await repository('openlore-husky-missing-shim-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root });
    await mkdir(join(root, '.husky'), { recursive: true });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});

    await installEnforcementHook(root);

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/husky.*executable shim.*initialize Husky/i));
    expect(success).not.toHaveBeenCalled();
  });

  it('warns with actionable Lefthook wiring and does not claim success', async () => {
    const root = await repository('openlore-lefthook-');
    await writeFile(join(root, 'lefthook.yml'), 'pre-commit:\n  commands: {}\n', 'utf-8');
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});

    await installEnforcementHook(root);

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/lefthook.*effective hooks directory.*openlore enforce --hook/i));
    expect(success).not.toHaveBeenCalled();
    await expect(readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8')).rejects.toThrow();
  });

  it.each(['lefthook.toml', join('.config', 'lefthook.jsonc')])(
    'recognizes %s as Lefthook-owned',
    async (configPath) => {
      const root = await repository('openlore-lefthook-variant-');
      await mkdir(join(root, '.config'), { recursive: true });
      await writeFile(join(root, configPath), '', 'utf-8');
      const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

      await installEnforcementHook(root);

      expect(warning).toHaveBeenCalledWith(expect.stringMatching(/lefthook owns/i));
      await expect(readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8')).rejects.toThrow();
    },
  );

  it('does not write when core.hooksPath explicitly disables hooks', async () => {
    const root = await repository('openlore-disabled-hooks-');
    const disabledPath = join(root, 'disabled-hooks');
    await writeFile(disabledPath, '', 'utf-8');
    await execFileAsync('git', ['config', 'core.hooksPath', disabledPath], { cwd: root });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});

    await installEnforcementHook(root);

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/hooks are disabled.*disabled-hooks/i));
    expect(success).not.toHaveBeenCalled();
  });

  it('installs both decisions hooks into a custom hooksPath', async () => {
    const root = await repository('openlore-decisions-hooks-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });

    await installDecisionsHook(root);

    expect(await readFile(join(root, '.githooks', 'pre-commit'), 'utf-8'))
      .toContain('# openlore-decisions-hook');
    expect(await readFile(join(root, '.githooks', 'post-commit'), 'utf-8'))
      .toContain('# openlore-decisions-post-hook');

    await uninstallDecisionsHook(root);

    await expect(readFile(join(root, '.githooks', 'pre-commit'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(root, '.githooks', 'post-commit'), 'utf-8')).rejects.toThrow();
  });

  it('runs the post-commit bypass check through its dedicated CLI behavior', async () => {
    const root = await repository('openlore-decisions-post-check-');
    const sentinel = join(root, '.git', 'OPENLORE_GATE_RAN');
    await writeFile(sentinel, '', 'utf-8');
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await runPostCommitDecisionCheck(root);
    await expect(readFile(sentinel, 'utf-8')).rejects.toThrow();

    await runPostCommitDecisionCheck(root);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/pre-commit gate was bypassed/i));
  });

  it('keeps decisions support setup while giving exact manual Lefthook wiring', async () => {
    const root = await repository('openlore-lefthook-decisions-');
    await writeFile(join(root, 'lefthook.yml'), 'pre-commit:\n  commands: {}\n', 'utf-8');
    await writeFile(join(root, 'AGENTS.md'), '# Agents\n', 'utf-8');
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await installDecisionsHook(root);

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/"openlore decisions --gate"/));
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/"openlore decisions --post-commit-check"/));
    expect(await readFile(join(root, '.gitignore'), 'utf-8')).toContain('.openlore/decisions/');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toContain('openlore-decisions-instructions');
  });

  it('does not claim the Husky post-commit companion is installed without its shim', async () => {
    const root = await repository('openlore-husky-partial-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root });
    await mkdir(join(root, '.husky', '_'), { recursive: true });
    await writeFile(join(root, '.husky', '_', 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await installDecisionsHook(root);

    expect(await readFile(join(root, '.husky', 'pre-commit'), 'utf-8'))
      .toContain('# openlore-decisions-hook');
    await expect(readFile(join(root, '.husky', 'post-commit'), 'utf-8')).rejects.toThrow();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/executable shim.*post-commit/i));
  });

  it('serializes concurrent installers so every gate marker survives', async () => {
    const root = await repository('openlore-concurrent-hooks-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });

    await Promise.all([
      installEnforcementHook(root),
      installDecisionsHook(root),
      installDriftHook(root),
      installBlastRadiusHook(root),
      installImpactCertificateHook(root),
      installRefreshStoriesHook(root),
    ]);

    const hook = await readFile(join(root, '.githooks', 'pre-commit'), 'utf-8');
    expect(hook).toContain('# openlore-enforcement-hook');
    expect(hook).toContain('# openlore-decisions-hook');
    expect(hook).toContain('# openlore-drift-hook');
    expect(hook).toContain('# openlore-blast-radius-hook');
    expect(hook).toContain('# openlore-impact-certificate-hook');
    const postHook = await readFile(join(root, '.githooks', 'post-commit'), 'utf-8');
    expect(postHook).toContain('# openlore-decisions-post-hook');
    expect(postHook).toContain('# openlore-refresh-hook');
  });

  it("serializes multiple contenders while reclaiming a dead owner's lock", async () => {
    const root = await repository('openlore-stale-hook-lock-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    const lock = join(root, '.githooks', 'pre-commit.openlore-lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, token: 'dead' }), 'utf-8');

    await Promise.all([
      installEnforcementHook(root),
      installDecisionsHook(root),
      installDriftHook(root),
      installBlastRadiusHook(root),
      installImpactCertificateHook(root),
    ]);

    const hook = await readFile(join(root, '.githooks', 'pre-commit'), 'utf-8');
    expect(hook).toContain('# openlore-enforcement-hook');
    expect(hook).toContain('# openlore-decisions-hook');
    expect(hook).toContain('# openlore-drift-hook');
    expect(hook).toContain('# openlore-blast-radius-hook');
    expect(hook).toContain('# openlore-impact-certificate-hook');
  });

  it('refuses to overwrite a symlinked hook target', async () => {
    const root = await repository('openlore-symlink-hook-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    await mkdir(join(root, '.githooks'), { recursive: true });
    await writeFile(join(root, 'outside-hook'), '#!/bin/sh\noriginal\n', 'utf-8');
    await symlink(join(root, 'outside-hook'), join(root, '.githooks', 'pre-commit'));
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await installEnforcementHook(root);

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/not a regular file/));
    expect(await readFile(join(root, 'outside-hook'), 'utf-8')).toBe('#!/bin/sh\noriginal\n');
  });

  it('refuses a dangling hooks-directory symlink with an actionable warning', async () => {
    const root = await repository('openlore-dangling-hooks-');
    const hooksPath = join(root, 'dangling-hooks');
    await symlink(join(root, 'missing-target'), hooksPath);
    await execFileAsync('git', ['config', 'core.hooksPath', hooksPath], { cwd: root });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await installEnforcementHook(root);

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/cannot be inspected safely/));
  });

  it('preserves boundary whitespace in Git paths while keeping logs single-line', async () => {
    const root = await repository('openlore-whitespace-hooks-');
    const relativeHooksPath = ' hooks with spaces ';
    await execFileAsync('git', ['config', 'core.hooksPath', relativeHooksPath], { cwd: root });
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});

    await installEnforcementHook(root);

    expect(await readFile(join(root, relativeHooksPath, 'pre-commit'), 'utf-8'))
      .toContain('# openlore-enforcement-hook');
    const message = String(success.mock.calls.at(-1)?.[0]);
    expect(message).not.toContain('\n');
    expect(message).toContain(' hooks with spaces ');
  });

  it('installs the drift gate into the same effective hooksPath', async () => {
    const root = await repository('openlore-drift-hooks-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });

    await installDriftHook(root);

    expect(await readFile(join(root, '.githooks', 'pre-commit'), 'utf-8'))
      .toContain('# openlore-drift-hook');

    await uninstallDriftHook(root);

    await expect(readFile(join(root, '.githooks', 'pre-commit'), 'utf-8')).rejects.toThrow();
  });

  it('preserves default install bytes and mode when targeting a custom hooksPath', async () => {
    const defaultRoot = await repository('openlore-default-hook-bytes-');
    const customRoot = await repository('openlore-custom-hook-bytes-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: customRoot });

    await installEnforcementHook(defaultRoot);
    await installEnforcementHook(customRoot);

    const defaultPath = join(defaultRoot, '.git', 'hooks', 'pre-commit');
    const customPath = join(customRoot, '.githooks', 'pre-commit');
    expect(await readFile(customPath)).toEqual(await readFile(defaultPath));
    expect((await stat(customPath)).mode & 0o777).toBe((await stat(defaultPath)).mode & 0o777);
    expect((await stat(customPath)).mode & 0o111).not.toBe(0);
  });

  it('uninstalls from the custom hooksPath without touching the legacy path', async () => {
    const root = await repository('openlore-custom-uninstall-');
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    await installEnforcementHook(root);

    await uninstallEnforcementHook(root);

    expect(await readFile(join(root, '.githooks', 'pre-commit'), 'utf-8'))
      .not.toContain('# openlore-enforcement-hook');
    await expect(readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8')).rejects.toThrow();
  });

  it('resolves the shared hooks directory from a linked worktree', async () => {
    const root = await repository('openlore-main-worktree-');
    await execFileAsync('git', ['config', 'user.email', 'test@openlore.dev'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'OpenLore Test'], { cwd: root });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: root });
    const linked = `${root}-linked`;
    created.push(linked);
    await execFileAsync('git', ['worktree', 'add', linked, '-b', 'linked-test'], { cwd: root });

    await installEnforcementHook(linked);

    expect(await readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8'))
      .toContain('# openlore-enforcement-hook');
  });

  it('honors an explicit GIT_DIR even when the working directory has no .git entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-git-dir-worktree-'));
    const gitDir = await mkdtemp(join(tmpdir(), 'openlore-explicit-git-dir-'));
    created.push(root, gitDir);
    await execFileAsync('git', ['init', '--bare'], { cwd: gitDir });
    const previousGitDir = process.env.GIT_DIR;
    const previousWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = gitDir;
    process.env.GIT_WORK_TREE = root;
    try {
      await installEnforcementHook(root);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousWorkTree;
    }

    expect(await readFile(join(gitDir, 'hooks', 'pre-commit'), 'utf-8'))
      .toContain('# openlore-enforcement-hook');
  });
});
