/**
 * `openlore impact-certificate` — the change-impact certificate's CLI + git-hook
 * surface (change: add-change-impact-certificate).
 *
 * Prints the conclusion-shaped impact certificate for the current diff (the same
 * artifact the `change_impact_certificate` MCP tool returns): blast radius, the
 * paths the change opens into each declared covering surface, drifted specs, and
 * the tests to run. It can install an ADVISORY pre-commit hook that emits the
 * certificate before every commit. Per the spec (cli/ImpactCertificateCommand,
 * mcp-handlers/AdvisoryByDefault): the hook is opt-in, advisory by default (exit 0),
 * and blocks only when `.openlore/config.json` `impactCertificate.block` names a
 * surface severity that the change actually opens a new path into. Infrastructure
 * failure (no graph, not a repo) NEVER blocks.
 */

import { Command } from 'commander';
import { writeStdout } from '../output.js';
import { logger, configureLogger } from '../../utils/logger.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import type { ImpactCertificate } from '../../core/services/mcp-handlers/impact-certificate.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';
import type { CoveringSurfaceSeverity } from '../../types/index.js';
import {
  displayHookPath,
  hookManagerWarning,
  isResolvedGitRepository,
  resolveGitHookTarget,
  resolveTrustedHookLauncher,
  renderTrustedHookCommand,
  updateHookFile,
} from '../git-hooks.js';

const HOOK_MARKER = '# openlore-impact-certificate-hook';

const renderHookContent = (command: string) => `${HOOK_MARKER}
# Advisory change-impact certificate before each commit.
# Advisory by default (exit 0); blocks only on a configured surface severity.
${command} 2>&1
CERT_EXIT=$?
if [ "$CERT_EXIT" -ne 0 ]; then
  exit "$CERT_EXIT"
fi
# end-openlore-impact-certificate-hook
`;

export async function installImpactCertificateHook(rootPath: string): Promise<void> {
  const target = await resolveGitHookTarget(rootPath, 'pre-commit');
  const hookPath = target.hookPath;

  if (!(await isResolvedGitRepository(rootPath, target))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return;
  }
  if (!target.canInstall) {
    logger.warning(hookManagerWarning(target, 'openlore impact-certificate --hook'));
    return;
  }
  const launcher = await resolveTrustedHookLauncher(rootPath);
  if (!launcher) { logger.error('Cannot pin an OpenLore installation outside this repository. Install OpenLore globally and retry.'); process.exitCode = 1; return; }
  const hookContent = renderHookContent(renderTrustedHookCommand(launcher, ['impact-certificate', '--hook']));
  let alreadyInstalled = false;
  const result = await updateHookFile(hookPath, (existing) => {
    if (existing?.includes(HOOK_MARKER)) { alreadyInstalled = true; const refreshed = existing.replace(/# openlore-impact-certificate-hook[\s\S]*?# end-openlore-impact-certificate-hook/, hookContent.trimEnd()); return refreshed === existing ? null : refreshed; }
    const stripped = existing?.trimEnd().replace(/\n*\nexit 0\s*$/, '');
    return stripped ? stripped + '\n\n' + hookContent : '#!/bin/sh\n\n' + hookContent;
  });
  if (result.status === 'unavailable') {
    logger.warning(`Cannot install the impact-certificate hook at ${displayHookPath(hookPath)}: ${result.reason}`);
    return;
  }
  if (alreadyInstalled) {
    logger.success('Advisory impact-certificate pre-commit hook already installed.');
    return;
  }
  logger.success(`Advisory impact-certificate pre-commit hook installed at ${displayHookPath(hookPath)}`);
  logger.discovery('It is advisory (never blocks). Set impactCertificate.block in .openlore/config.json to block on a surface severity (e.g. ["critical"]).');
}

export async function uninstallImpactCertificateHook(rootPath: string): Promise<void> {
  const { hookPath } = await resolveGitHookTarget(rootPath, 'pre-commit');
  let found = false;
  let blockFound = false;
  const result = await updateHookFile(hookPath, (existing) => {
    if (existing === null) return null;
    found = true;
    const cleaned = existing.replace(
      new RegExp(`\\n*${HOOK_MARKER}[\\s\\S]*?# end-openlore-impact-certificate-hook\\n*`, 'g'),
      '\n',
    );
    if (cleaned === existing) return null;
    blockFound = true;
    return cleaned.trimEnd() + '\n';
  });
  if (result.status === 'unavailable') {
    logger.warning(`Cannot uninstall the impact-certificate hook at ${displayHookPath(hookPath)}: ${result.reason}`);
  } else if (!found) {
    logger.discovery('No pre-commit hook found; nothing to uninstall.');
  } else if (!blockFound) {
    logger.discovery('Impact-certificate hook block not present; nothing to uninstall.');
  } else {
    logger.success('Removed the advisory impact-certificate pre-commit hook block.');
  }
}

/** The surfaces a newly-opened path reaches whose severity is in the configured block list.
 * Reads the certificate's structured paths, never prose — a triggering path cannot be sliced off. */
export function triggeredBlockSeverities(
  cert: ImpactCertificate,
  block: readonly CoveringSurfaceSeverity[],
): CoveringSurfaceSeverity[] {
  const blockSet = new Set(block);
  const fired = new Set<CoveringSurfaceSeverity>();
  for (const p of cert.newlyOpenedPaths) if (blockSet.has(p.surfaceSeverity)) fired.add(p.surfaceSeverity);
  return [...fired];
}

/** Compact human rendering of the certificate (to stderr in hook mode). */
function renderHuman(c: ImpactCertificate): string {
  const lines: string[] = ['', '📜 Change-impact certificate (advisory)', '   ' + c.headline];
  if (c.baseRefFallback) {
    lines.push(`   ⚠ base ref "${c.baseRefFallback.requested}" did not resolve — certified against "${c.baseRefFallback.resolved}" (--allow-base-fallback).`);
  }
  if (c.surfaces.length > 0) {
    lines.push('   Surfaces: ' + c.surfaces.map(s => `${s.name} (${s.resolvedSymbols} sym, ${s.severity})`).join(', '));
  }
  const bySurface = new Map<string, typeof c.newlyOpenedPaths>();
  for (const p of c.newlyOpenedPaths) (bySurface.get(p.surface) ?? bySurface.set(p.surface, []).get(p.surface)!).push(p);
  for (const [surface, paths] of bySurface) {
    const sev = paths[0].surfaceSeverity;
    lines.push(`   ${sev === 'critical' ? '⛔' : '⚠'} NEW path into "${surface}" (${sev}): ${paths[0].path.join(' → ')}${paths.length > 1 ? ` (+${paths.length - 1} more)` : ''}`);
  }
  if ('count' in c.tests && c.tests.count > 0) {
    const top = c.tests.toRun.slice(0, 8).map(t => t.test).join(', ');
    lines.push(`   Tests to run (${c.tests.count}): ${top}${c.tests.count > 8 ? ', …' : ''}`);
  }
  if ('truncatedAtDepth' in c.tests && c.tests.truncatedAtDepth !== undefined) {
    lines.push(`   ⚠ Test reachability was truncated at depth ${c.tests.truncatedAtDepth}; deeper tests may exist.`);
  }
  if ('soundness' in c.tests) {
    const soundness = c.tests.soundness as { caveats?: string[] } | undefined;
    for (const caveat of soundness?.caveats ?? []) {
      if (/substring fallback|may have widened/i.test(caveat)) lines.push(`   ⚠ ${caveat}`);
    }
  }
  if ('willGoStale' in c.specs && c.specs.willGoStale > 0) {
    lines.push(`   ⚠ ${c.specs.willGoStale} spec(s) may go stale`);
  }
  lines.push('');
  return lines.join('\n');
}

export interface ImpactCertificateCliOptions {
  cwd?: string;
  base?: string;
  change?: string;
  json?: boolean;
  hook?: boolean;
  save?: boolean;
  installHook?: boolean;
  uninstallHook?: boolean;
  allowBaseFallback?: boolean;
}

export async function runImpactCertificateCli(opts: ImpactCertificateCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.installHook) { await installImpactCertificateHook(cwd); return typeof process.exitCode === 'number' ? process.exitCode : 0; }
  if (opts.uninstallHook) { await uninstallImpactCertificateHook(cwd); return 0; }

  // Hook mode persists by default so the certificate decays and the spec-store
  // health check can re-fire it; an explicit --save forces it elsewhere too.
  const persist = opts.save || opts.hook;
  // The hook is advisory and must never block a commit — so a bogus --base there
  // falls back (disclosed) rather than erroring. A direct invocation stays fatal on
  // an unresolvable base (fix-cli-conclusion-honesty) unless --allow-base-fallback.
  const allowBaseFallback = opts.allowBaseFallback || opts.hook === true;
  configureLogger({ quiet: true });
  let result: ImpactCertificate | { error: string; baseUnresolved?: boolean };
  try {
    result = await dispatchTool('change_impact_certificate', {
      directory: cwd,
      baseRef: opts.base,
      change: opts.change,
      persist,
      allowBaseFallback,
    }, cwd) as ImpactCertificate | { error: string; baseUnresolved?: boolean };
  } catch (err) {
    // Final advisory safety net: a throw must NEVER block a commit.
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }

  if ('error' in result) {
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error: result.error }, null, 2) + '\n');
    else logger.warning(`impact-certificate: ${result.error}`);
    // A caller-supplied unresolvable base is a usage error, not infrastructure failure:
    // fail non-zero for a direct invocation so a typo'd ref can't yield a clean-looking
    // certificate. In hook mode allowBaseFallback is on, so this branch is unreachable there.
    if ('baseUnresolved' in result && result.baseUnresolved && !opts.hook) return 1;
    return 0; // infrastructure failure never blocks
  }

  if (opts.json) {
    await writeStdout(JSON.stringify(result, null, 2) + '\n');
  } else {
    const out = renderHuman(result);
    if (opts.hook) process.stderr.write(out + '\n');
    else await writeStdout(out + '\n');
  }

  if (opts.hook) {
    // Config read is advisory-safe: a throw or wrong-typed `block` must never block.
    let block: CoveringSurfaceSeverity[];
    try {
      const config = await readOpenLoreConfig(cwd);
      const raw = config?.impactCertificate?.block;
      block = Array.isArray(raw) ? raw.filter((s): s is CoveringSurfaceSeverity => s === 'info' || s === 'warn' || s === 'critical') : [];
    } catch { block = []; }
    const fired = triggeredBlockSeverities(result, block);
    if (fired.length > 0) {
      process.stderr.write(
        `\n⛔ impact-certificate: commit blocked — the change opens a new path into a ${fired.join('/')} surface.\n` +
        `   Confirm the new cross-boundary reach is intended, or commit with --no-verify to override.\n\n`,
      );
      return 1;
    }
  }
  return 0;
}

export const impactCertificateCommand = new Command('impact-certificate')
  .description('Change-impact certificate for the current diff (advisory): blast radius, newly-opened paths into declared covering surfaces, drifted specs, and tests to run.')
  .option('--base <ref>', 'Git ref to diff the working tree against (default HEAD)')
  .option('--change <id>', 'Change id to record on the certificate (spec-store context)')
  .option('--allow-base-fallback', 'Accept the disclosed main → master → HEAD~1 fallback when --base does not resolve, instead of erroring (direct invocation only; the hook always falls back)', false)
  .option('--json', 'Emit the certificate as JSON', false)
  .option('--hook', 'Hook mode: print to stderr, persist, and block only on a configured surface severity', false)
  .option('--save', 'Persist the certificate under .openlore/impact-certificates/ for later decay re-checks', false)
  .option('--install-hook', 'Install the advisory pre-commit hook', false)
  .option('--uninstall-hook', 'Remove the advisory pre-commit hook', false)
  .action(async (opts: { base?: string; change?: string; json?: boolean; hook?: boolean; save?: boolean; installHook?: boolean; uninstallHook?: boolean; allowBaseFallback?: boolean }) => {
    const code = await runImpactCertificateCli({
      base: opts.base, change: opts.change, json: opts.json, hook: opts.hook, save: opts.save,
      installHook: opts.installHook, uninstallHook: opts.uninstallHook, allowBaseFallback: opts.allowBaseFallback,
    });
    process.exit(code);
  });
