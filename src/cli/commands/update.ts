/**
 * `openlore update` — upgrade openlore to the latest published version
 * (change: add-zero-interaction-onboarding).
 *
 * The explicit companion to the passive update notifier. It detects HOW openlore
 * was installed (Homebrew / global npm / npx) and runs the correct upgrade, or
 * with --check just reports whether a newer version exists. Deterministic, no
 * LLM. The only network call is the npm dist-tag lookup (shared with the
 * notifier), and it fails soft.
 */

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import {
  formatPlatformCommand,
  resolvePlatformCommand,
  type PlatformCommandRuntime,
} from '../../utils/platform-command.js';
import { fetchLatestVersion, isNewer } from '../../core/services/update-notifier.js';
import { execFileGit as execFileAsync } from '../../utils/git-exec.js';

const require = createRequire(import.meta.url);

export type InstallMethod = 'homebrew' | 'npm-global' | 'npm-local' | 'npx' | 'unknown';

/**
 * Deterministic local evidence used to tell a global npm install apart from a
 * project-local one — the one distinction the module path alone cannot make
 * (a Windows global prefix and a project's `node_modules/openlore/` are
 * path-shaped alike). Every field is gathered from a local command or file read;
 * absent fields mean "no evidence", never "false".
 */
export interface InstallEvidence {
  /** Global `node_modules` root(s) from `npm root -g` (normalized). */
  npmGlobalRoots?: string[];
  /** True iff the project enclosing this install declares an `openlore` dependency. */
  declaredAsProjectDependency?: boolean;
}

/** Lowercase and collapse both path separators so Windows paths match POSIX ones. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Infer how the running openlore was installed from the executing module path
 * plus deterministic local evidence. Pure function of its inputs so it is
 * unit-testable; the impure evidence gathering lives in `gatherInstallEvidence`.
 *
 * Global-vs-local is decided by evidence, not a substring guess: a path under a
 * proven `npm root -g` (or a POSIX `lib/node_modules` global prefix) is global; a
 * `node_modules/openlore/` whose enclosing project declares the dependency is
 * local. Contradictory or absent evidence yields `'unknown'` — the command then
 * defers to the human rather than mutating the wrong install.
 */
export function detectInstallMethod(
  modulePath: string,
  evidence: InstallEvidence = {}
): InstallMethod {
  const p = normalizePath(modulePath);
  if (p.includes('/cellar/') || p.includes('/homebrew/') || p.includes('/linuxbrew/')) {
    return 'homebrew';
  }
  // npx caches under .../_npx/<hash>/node_modules/... (npm) — transient, auto-floats.
  if (p.includes('/_npx/') || p.includes('/npm-cache/_npx/')) return 'npx';

  // A POSIX global npm prefix always nests the package under `lib/node_modules`;
  // a proven `npm root -g` covers every platform (incl. the Windows prefix, which
  // has no `lib/` segment and so is indistinguishable from a project by path alone).
  const underGlobalRoot = (evidence.npmGlobalRoots ?? []).some(
    (root) => root && p.startsWith(normalizePath(root))
  );
  const looksGlobal = underGlobalRoot || p.includes('/lib/node_modules/');
  const looksLocal = evidence.declaredAsProjectDependency === true;

  // Contradictory evidence is disclosed, never guessed.
  if (looksGlobal && looksLocal) return 'unknown';
  if (looksGlobal) return 'npm-global';
  if (looksLocal) return 'npm-local';
  return 'unknown';
}

/**
 * Derive the project root that ENCLOSES this install (the directory containing
 * `node_modules/openlore/`) and report whether its `package.json` declares an
 * `openlore` dependency. Anchored to the install location, not `cwd`, so a global
 * openlore run inside a project that also depends on it locally is not misread as
 * local. Fail-soft: any read/parse problem is "no evidence".
 */
function enclosingProjectDeclaresOpenlore(modulePath: string): boolean {
  const norm = modulePath.replace(/\\/g, '/');
  const marker = '/node_modules/openlore/';
  const idx = norm.toLowerCase().indexOf(marker);
  if (idx < 0) return false;
  const projectRoot = norm.slice(0, idx);
  const pkgPath = `${projectRoot}/package.json`;
  try {
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const deps = pkg[field];
      if (deps && typeof deps === 'object' && 'openlore' in (deps as Record<string, unknown>)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** The global `node_modules` root reported by `npm root -g` ([] if npm is absent/slow). */
async function queryNpmGlobalRoots(
  platform: NodeJS.Platform,
  runtime: PlatformCommandRuntime,
): Promise<string[]> {
  try {
    const invocation = resolvePlatformCommand('npm', ['root', '-g'], platform, runtime);
    const { stdout } = await execFileAsync(invocation.command, invocation.args, {
      timeout: 3000,
      windowsHide: true,
    });
    const line = stdout.trim();
    return line ? [line] : [];
  } catch {
    // npm missing, offline, or timed out — the evidence is simply absent.
    return [];
  }
}

/**
 * Gather the deterministic local evidence `detectInstallMethod` needs. Impure
 * (one local subprocess + one file read), fail-soft, no network.
 */
export async function gatherInstallEvidence(
  modulePath: string,
  platform: NodeJS.Platform = process.platform,
  runtime: PlatformCommandRuntime = {},
): Promise<InstallEvidence> {
  return {
    npmGlobalRoots: await queryNpmGlobalRoots(platform, runtime),
    declaredAsProjectDependency: enclosingProjectDeclaresOpenlore(modulePath),
  };
}

/**
 * The shell command that upgrades each install method (null = nothing to run).
 * `npm-local` returns the per-project command, but `runUpdate` only PRINTS it —
 * a local dependency is never mutated for the user.
 */
export function upgradeCommandFor(
  method: InstallMethod,
  platform: NodeJS.Platform = process.platform,
  runtime: PlatformCommandRuntime = {},
): { cmd: string; args: string[] } | null {
  let command: { command: string; args: string[] } | null;
  switch (method) {
    case 'homebrew':
      command = resolvePlatformCommand('brew', ['upgrade', 'openlore'], platform, runtime);
      break;
    case 'npm-global':
      command = resolvePlatformCommand('npm', ['install', '-g', 'openlore@latest'], platform, runtime);
      break;
    case 'npm-local':
      command = resolvePlatformCommand('npm', ['install', 'openlore@latest'], platform, runtime);
      break;
    default:
      command = null;
  }
  return command ? { cmd: command.command, args: command.args } : null;
}

function runCommand(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

interface UpdateOpts {
  check?: boolean;
  dryRun?: boolean;
}

export async function runUpdate(
  opts: UpdateOpts,
  platform: NodeJS.Platform = process.platform,
  runtime: PlatformCommandRuntime = {},
): Promise<number> {
  const { version: current } = require('../../../package.json') as { version: string };

  logger.discovery('Checking npm for the latest openlore…');
  const latest = await fetchLatestVersion();
  if (!latest) {
    logger.warning('Could not reach the npm registry. Check your connection and try again.');
    return 1;
  }

  if (!isNewer(current, latest)) {
    logger.success(`openlore is up to date (${current}).`);
    return 0;
  }

  logger.info('Update', `${current} → ${latest}`);
  if (opts.check) return 0;

  const modulePath = fileURLToPath(import.meta.url);
  const method = detectInstallMethod(
    modulePath,
    await gatherInstallEvidence(modulePath, platform, runtime),
  );
  if (method === 'npx') {
    logger.info(
      'npx',
      'You run openlore via npx (`npx --yes openlore`), which already floats to the latest ' +
        'version on each run. Nothing to upgrade.'
    );
    return 0;
  }

  // A project-local dependency is never upgraded for the user — mutating the
  // project's lockfile is the user's call. Report the newer version and the
  // exact per-project command; run nothing global.
  if (method === 'npm-local') {
    const local = upgradeCommandFor(method, platform, runtime)!;
    logger.info(
      'Project dependency',
      `openlore is a project-local dependency here. Upgrade it in your project with:\n  ` +
        formatPlatformCommand({ command: local.cmd, args: local.args })
    );
    return 0;
  }

  const upgrade = upgradeCommandFor(method, platform, runtime);
  if (!upgrade) {
    logger.warning(
      `Could not determine how openlore was installed. Upgrade manually with one of:\n` +
        `  npm install -g openlore@latest\n` +
        `  brew upgrade openlore`
    );
    return 1;
  }

  const printable = formatPlatformCommand({ command: upgrade.cmd, args: upgrade.args });
  if (opts.dryRun) {
    logger.info('Would run', printable);
    return 0;
  }

  logger.discovery(`Upgrading: ${printable}`);
  const code = await runCommand(upgrade.cmd, upgrade.args);
  if (code === 0) {
    logger.success(`Upgraded openlore to ${latest}.`);
  } else {
    logger.error(`Upgrade command exited with code ${code}. Try running it yourself: ${printable}`);
  }
  return code;
}

export const updateCommand = new Command('update')
  .description('Upgrade openlore to the latest published version (detects npm / Homebrew / npx)')
  .option('--check', 'Only report whether a newer version exists; do not upgrade', false)
  .option('--dry-run', 'Print the upgrade command without running it', false)
  .addHelpText(
    'after',
    `
Examples:
  $ openlore update            Upgrade to the latest version
  $ openlore update --check    Report whether an update is available
  $ openlore update --dry-run  Show the upgrade command without running it

Disable the passive "update available" banner with OPENLORE_NO_UPDATE_NOTIFIER=1.
`
  )
  .action(async (opts: UpdateOpts) => {
    const code = await runUpdate(opts);
    if (code !== 0) process.exit(code);
  });
