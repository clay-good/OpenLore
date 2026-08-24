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
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', '.bin', 'openlore'),
      '#!/bin/sh\nif [ "$2" = "--help" ]; then echo --hook; fi\nexit 0\n',
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

    const preCommit = await readFile(join(root, '.githooks', 'pre-commit'), 'utf-8');
    expect(preCommit).toContain('# openlore-decisions-hook');
    expect(preCommit).toContain(process.execPath);
    expect(preCommit).not.toContain('./node_modules/.bin/openlore');
    expect(preCommit).not.toContain('./dist/cli/index.js');
    expect(await readFile(join(root, '.githooks', 'post-commit'), 'utf-8'))
      .toContain('# openlore-decisions-post-hook');

    await uninstallDecisionsHook(root);

    await expect(readFile(join(root, '.githooks', 'pre-commit'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(root, '.githooks', 'post-commit'), 'utf-8')).rejects.toThrow();
  });

  it('allows a commit when drift could not be checked and preserves the failure evidence', async () => {
    const root = await repository('openlore-drift-infrastructure-failure-');
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(
      join(localBin, 'openlore'),
      '#!/bin/sh\necho "No openlore configuration found" >&2\nexit 2\n',
      { mode: 0o755 },
    );
    await installDriftHook(root);

    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    const result = await execFileAsync(hookPath, [], { cwd: root });

    expect(result.stderr).toContain('No openlore configuration found');
    expect(result.stdout).toContain('Spec drift could not be checked (exit 2); the drift check will not block this commit.');
    expect(result.stdout).not.toContain('Spec drift detected!');
  });

  it('does not execute a repository-local binary even when one is present', async () => {
    const root = await repository('openlore-drift-found-');
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(
      join(localBin, 'openlore'),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"hasDrift":true,"summary":{"memoryDrifted":1,"memoryOrphaned":2},"issues":[]}\'\nexit 1\n',
      { mode: 0o755 },
    );
    await installDriftHook(root);

    const hook = await readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(hook).not.toContain(join(localBin, 'openlore'));
  });

  it('pins an external launcher and never uses repository-local or network-fetched code', async () => {
    const root = await repository('openlore-drift-local-binary-');
    await installDriftHook(root);

    const hook = await readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(hook).toContain(process.execPath);
    expect(hook).not.toContain('node_modules/.bin/openlore');
    expect(hook).not.toContain('npx');
    expect(hook).not.toMatch(/openlore drift[^\n]*2>\/dev\/null/);
  });

  it('does not let inherited errexit suppress an infrastructure-failure disclosure', async () => {
    const root = await repository('openlore-drift-errexit-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\nset -e\n', { mode: 0o755 });
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(join(localBin, 'openlore'), '#!/bin/sh\necho unavailable >&2\nexit 2\n', { mode: 0o755 });
    await installDriftHook(root);

    const result = await execFileAsync(hookPath, [], { cwd: root });
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toContain('could not be checked');
  });

  it('does not let a verifier launch failure escape inherited errexit', async () => {
    const root = await repository('openlore-drift-verifier-errexit-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\nset -e\n', { mode: 0o755 });
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(join(localBin, 'openlore'), '#!/bin/sh\necho unavailable >&2\nexit 2\n', { mode: 0o755 });
    await installDriftHook(root);

    const result = await execFileAsync(hookPath, [], { cwd: root, env: { ...process.env, PATH: localBin } });
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toContain('could not be checked');
  });

  it.each([
    ['', 'empty output'],
    ['not-json', 'malformed output'],
    ['{"hasDrift":false,"totalChangedFiles":1,"analyzedFiles":0,"filesOmitted":0,"specRelevantFiles":0}', 'a contradictory clean result'],
  ])('does not label an external exit 1 as drift for %s (%s)', async (output) => {
    const root = await repository('openlore-drift-exit-one-');
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(
      join(localBin, 'openlore'),
      `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit 1\n`,
      { mode: 0o755 },
    );
    await installDriftHook(root);

    const result = await execFileAsync(join(root, '.git', 'hooks', 'pre-commit'), [], { cwd: root });
    expect(result.stdout).toContain('could not be checked');
    expect(result.stdout).not.toContain('Spec drift detected!');
  });

  it('ignores a repository-local launcher that fabricates a clean truncated result', async () => {
    const root = await repository('openlore-drift-truncated-');
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(
      join(localBin, 'openlore'),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"hasDrift":false,"totalChangedFiles":150,"analyzedFiles":100,"filesOmitted":50,"specRelevantFiles":20}\'\n',
      { mode: 0o755 },
    );
    await installDriftHook(root);

    const result = await execFileAsync(join(root, '.git', 'hooks', 'pre-commit'), [], { cwd: root });
    expect(result.stdout).not.toContain('could not be fully checked (50 changed file(s) omitted)');
  });

  it('preserves a failure from hook content that precedes the appended drift block', async () => {
    const root = await repository('openlore-drift-preserve-prior-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\nfalse\n', { mode: 0o755 });
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(
      join(localBin, 'openlore'),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"hasDrift":false,"totalChangedFiles":1,"analyzedFiles":1,"filesOmitted":0,"specRelevantFiles":0}\'\n',
      { mode: 0o755 },
    );
    await installDriftHook(root);

    await expect(execFileAsync(hookPath, [], { cwd: root })).rejects.toMatchObject({ code: 1 });
  });

  it('updates an existing marked drift block when installation is rerun', async () => {
    const root = await repository('openlore-drift-upgrade-hook-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hookPath,
      '#!/bin/sh\n# openlore-drift-hook\necho old-hook\n# end-openlore-drift-hook\n',
      { mode: 0o755 },
    );
    await installDriftHook(root);

    const hook = await readFile(hookPath, 'utf-8');
    expect(hook).not.toContain('old-hook');
    expect((hook.match(/# openlore-drift-hook/g) ?? [])).toHaveLength(1);
    expect(hook).toContain('DRIFT_VERDICT=');
  });

  it('refuses to append after an unconditional terminal exit', async () => {
    const root = await repository('openlore-drift-terminal-exit-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\necho managed\nexit 0\n', { mode: 0o755 });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await installDriftHook(root);

    expect(await readFile(hookPath, 'utf-8')).not.toContain('# openlore-drift-hook');
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/unconditional exit.*manually/i));
  });

  it('refuses a terminal exit followed only by comments', async () => {
    const root = await repository('openlore-drift-terminal-exit-comment-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\necho managed\nexit 0 # success\n# managed footer\n', { mode: 0o755 });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await installDriftHook(root);

    expect(await readFile(hookPath, 'utf-8')).not.toContain('# openlore-drift-hook');
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/unconditional exit.*manually/i));
  });

  it('leaves malformed drift markers byte-identical on uninstall', async () => {
    const root = await repository('openlore-drift-malformed-uninstall-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    const original = '#!/bin/sh\n# openlore-drift-hook\necho user-owned\n';
    await writeFile(hookPath, original, { mode: 0o755 });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await uninstallDriftHook(root);

    expect(await readFile(hookPath, 'utf-8')).toBe(original);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/malformed or duplicate markers/i));
  });

  it('refuses to append shell syntax to a non-shell hook', async () => {
    const root = await repository('openlore-drift-nonshell-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await installDriftHook(root);

    expect(await readFile(hookPath, 'utf-8')).not.toContain('# openlore-drift-hook');
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/non-shell interpreter.*manually/i));
  });

  it.each([
    '#!/usr/bin/env node /tmp/bash\n',
    '#!/usr/bin/python /bin/sh\n',
  ])('does not accept a non-shell shebang merely because it later mentions a shell: %s', async (shebang) => {
    const root = await repository('openlore-drift-shebang-bypass-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, shebang, { mode: 0o755 });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await installDriftHook(root);

    expect(await readFile(hookPath, 'utf-8')).toBe(shebang);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/non-shell interpreter/i));
  });

  it('refuses to claim an update for malformed drift markers', async () => {
    const root = await repository('openlore-drift-malformed-marker-');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\n# openlore-drift-hook\necho incomplete\n', { mode: 0o755 });
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    await installDriftHook(root);

    expect(await readFile(hookPath, 'utf-8')).toContain('echo incomplete');
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/malformed or duplicate markers/i));
  });

  it('treats contradictory receipt counts as an invalid check result', async () => {
    const root = await repository('openlore-drift-invalid-receipt-');
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(
      join(localBin, 'openlore'),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"hasDrift":false,"totalChangedFiles":150,"analyzedFiles":0,"filesOmitted":0,"specRelevantFiles":1}\'\n',
      { mode: 0o755 },
    );
    await installDriftHook(root);

    const result = await execFileAsync(join(root, '.git', 'hooks', 'pre-commit'), [], { cwd: root });
    expect(result.stdout).toContain('could not be checked');
  });

  it('does not execute a repository-local launcher containing terminal control output', async () => {
    const root = await repository('openlore-drift-terminal-safety-');
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    const payload = JSON.stringify({
      hasDrift: true,
      summary: { gaps: 1 },
      issues: [{ severity: 'warning', kind: 'gap\nforged', filePath: 'src/evil\u001b]8;;x\u0007\rname.ts' }],
    });
    await writeFile(
      join(localBin, 'openlore'),
      `#!/bin/sh\nprintf '%s\\n' '${payload}'\nexit 1\n`,
      { mode: 0o755 },
    );
    await installDriftHook(root);

    const hook = await readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(hook).not.toContain(join(localBin, 'openlore'));
  });

  it('retains bounded process-tree termination for the pinned launcher', async () => {
    const root = await repository('openlore-drift-process-tree-');
    const localBin = join(root, 'node_modules', '.bin');
    await mkdir(localBin, { recursive: true });
    await writeFile(
      join(localBin, 'openlore'),
      [
        '#!/bin/sh',
        '( trap "" TERM; sleep 30 ) >/dev/null 2>&1 &',
        'echo $! > drift-descendant.pid',
        'awk \'BEGIN { for (i = 0; i < 600000; i++) print "xx" }\'',
        'wait',
      ].join('\n') + '\n',
      { mode: 0o755 },
    );
    await installDriftHook(root);

    const hook = await readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(hook).toContain('process.kill(-child.pid, signal)');
    expect(hook).toContain('SIGKILL');
    expect(hook).not.toContain(join(localBin, 'openlore'));
  }, 10_000);

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
