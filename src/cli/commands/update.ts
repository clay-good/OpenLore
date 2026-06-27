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
import { logger } from '../../utils/logger.js';
import { fetchLatestVersion, isNewer } from '../../core/services/update-notifier.js';

const require = createRequire(import.meta.url);

export type InstallMethod = 'homebrew' | 'npm-global' | 'npx' | 'unknown';

/**
 * Infer how the running openlore was installed from the path of the executing
 * module. Pure function of the path string so it is unit-testable.
 */
export function detectInstallMethod(modulePath: string): InstallMethod {
  const p = modulePath.toLowerCase();
  if (p.includes('/cellar/') || p.includes('/homebrew/') || p.includes('/linuxbrew/')) {
    return 'homebrew';
  }
  // npx caches under .../_npx/<hash>/node_modules/... (npm) — transient, auto-floats.
  if (p.includes('/_npx/') || p.includes('/npm-cache/_npx/')) return 'npx';
  // A global npm install lives under a global node_modules prefix.
  if (p.includes('/node_modules/openlore/') || p.includes('/lib/node_modules/')) {
    return 'npm-global';
  }
  return 'unknown';
}

/** The shell command that upgrades each install method (null = nothing to run). */
export function upgradeCommandFor(method: InstallMethod): { cmd: string; args: string[] } | null {
  switch (method) {
    case 'homebrew':
      return { cmd: 'brew', args: ['upgrade', 'openlore'] };
    case 'npm-global':
      return { cmd: 'npm', args: ['install', '-g', 'openlore@latest'] };
    default:
      return null;
  }
}

function runCommand(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

interface UpdateOpts {
  check?: boolean;
  dryRun?: boolean;
}

export async function runUpdate(opts: UpdateOpts): Promise<number> {
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

  const method = detectInstallMethod(fileURLToPath(import.meta.url));
  if (method === 'npx') {
    logger.info(
      'npx',
      'You run openlore via npx (`npx --yes openlore`), which already floats to the latest ' +
        'version on each run. Nothing to upgrade.'
    );
    return 0;
  }

  const upgrade = upgradeCommandFor(method);
  if (!upgrade) {
    logger.warning(
      `Could not determine how openlore was installed. Upgrade manually with one of:\n` +
        `  npm install -g openlore@latest\n` +
        `  brew upgrade openlore`
    );
    return 1;
  }

  const printable = `${upgrade.cmd} ${upgrade.args.join(' ')}`;
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
