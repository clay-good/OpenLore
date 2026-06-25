/**
 * `openlore blast-radius` — the pre-flight blast-radius guard's CLI + git-hook
 * surface (change: add-preflight-blast-radius-guard).
 *
 * Prints the conclusion-shaped structural briefing for the current diff (the
 * same briefing the `blast_radius` MCP tool returns), and can install an
 * ADVISORY pre-commit hook that emits it before every commit. Per the spec
 * (cli/PreflightHookIsOptInAndAdvisory, mcp-handlers/AdvisoryByDefault): the
 * hook is opt-in, advisory by default (exit 0), and only blocks a commit when
 * `.openlore/config.json` `blastRadius.block` names a high-risk pattern that the
 * diff actually triggers. Transient failures (no graph, not a repo) never block.
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { Command } from 'commander';
import { writeStdout } from '../output.js';
import { logger, configureLogger } from '../../utils/logger.js';
import { fileExists } from '../../utils/command-helpers.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { computeBlastRadius, type BlastRadiusBriefing } from '../../core/services/mcp-handlers/blast-radius.js';
import type { BlastRadiusBlockPattern } from '../../types/index.js';

const HOOK_MARKER = '# openlore-blast-radius-hook';

const HOOK_CONTENT = `${HOOK_MARKER}
# Advisory pre-flight blast-radius briefing before each commit.
# Advisory by default (exit 0); blocks only on a configured high-risk pattern.
if [ -f "./node_modules/.bin/openlore" ] && ./node_modules/.bin/openlore blast-radius --help 2>/dev/null | grep -q -- '--hook'; then
  ./node_modules/.bin/openlore blast-radius --hook 2>&1
  BLAST_EXIT=$?
elif [ -f "./dist/cli/index.js" ] && node ./dist/cli/index.js blast-radius --help 2>/dev/null | grep -q -- '--hook'; then
  node ./dist/cli/index.js blast-radius --hook 2>&1
  BLAST_EXIT=$?
else
  OPENLORE=$(command -v openlore 2>/dev/null)
  if [ -n "$OPENLORE" ] && "$OPENLORE" blast-radius --help 2>/dev/null | grep -q -- '--hook'; then
    "$OPENLORE" blast-radius --hook 2>&1
    BLAST_EXIT=$?
  else
    BLAST_EXIT=0
  fi
fi
if [ "$BLAST_EXIT" -ne 0 ]; then
  exit "$BLAST_EXIT"
fi
# end-openlore-blast-radius-hook
`;

export async function installBlastRadiusHook(rootPath: string): Promise<void> {
  const hooksDir = join(rootPath, '.git', 'hooks');
  const hookPath = join(hooksDir, 'pre-commit');

  if (!(await fileExists(join(rootPath, '.git')))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return;
  }

  await mkdir(hooksDir, { recursive: true });

  if (await fileExists(hookPath)) {
    const existing = await readFile(hookPath, 'utf-8');
    if (existing.includes(HOOK_MARKER)) {
      logger.success('Advisory blast-radius pre-commit hook already installed.');
      return;
    }
    // Coexist with any other openlore hook (e.g. the decisions gate): append our
    // block after stripping a trailing `exit 0` so it is not unreachable.
    const stripped = existing.trimEnd().replace(/\n*\nexit 0\s*$/, '');
    await writeFile(hookPath, stripped + '\n\n' + HOOK_CONTENT, 'utf-8');
  } else {
    await writeFile(hookPath, '#!/bin/sh\n\n' + HOOK_CONTENT, 'utf-8');
  }

  await chmod(hookPath, 0o755);
  logger.success('Advisory blast-radius pre-commit hook installed at .git/hooks/pre-commit');
  logger.discovery('It is advisory (never blocks). Set blastRadius.block in .openlore/config.json to block on a named high-risk pattern.');
}

export async function uninstallBlastRadiusHook(rootPath: string): Promise<void> {
  const hookPath = join(rootPath, '.git', 'hooks', 'pre-commit');
  if (!(await fileExists(hookPath))) {
    logger.discovery('No pre-commit hook found; nothing to uninstall.');
    return;
  }
  const existing = await readFile(hookPath, 'utf-8');
  const cleaned = existing.replace(
    new RegExp(`\\n*${HOOK_MARKER}[\\s\\S]*?# end-openlore-blast-radius-hook\\n*`, 'g'),
    '\n',
  );
  if (cleaned === existing) {
    logger.discovery('Blast-radius hook block not present; nothing to uninstall.');
    return;
  }
  await writeFile(hookPath, cleaned.trimEnd() + '\n', 'utf-8');
  logger.success('Removed the advisory blast-radius pre-commit hook block.');
}

/** Which configured block patterns the briefing actually triggers.
 * Reads the uncapped `*.orphaned` counts, never the display-capped `items` arrays —
 * a triggering issue could otherwise be sliced off and the block silently fail to fire.
 * `block` is defensively coerced to an array by the caller before this runs. */
export function triggeredBlockPatterns(
  briefing: BlastRadiusBriefing,
  block: readonly BlastRadiusBlockPattern[],
): BlastRadiusBlockPattern[] {
  const fired: BlastRadiusBlockPattern[] = [];
  for (const pattern of block) {
    if (pattern === 'orphans-anchored-memory' && briefing.memory.orphaned > 0) fired.push(pattern);
    if (pattern === 'orphans-anchored-decision' && briefing.decisions.orphaned > 0) fired.push(pattern);
  }
  return fired;
}

/** Compact human rendering of the briefing (to stderr for hook mode). */
function renderHuman(b: BlastRadiusBriefing): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('🛫 Pre-flight blast radius (advisory)');
  lines.push('   ' + b.headline);
  // Surface a silent base-ref fallback here too (not only in the JSON caveats), so a
  // typo'd --base never makes the human briefing misrepresent what it diffed.
  if (b.resolvedBaseRef !== b.baseRef) {
    lines.push(`   ⚠ base ref "${b.baseRef}" did not resolve — diffed against "${b.resolvedBaseRef}" instead.`);
  }
  if (b.impact.hubsTouched.length > 0) {
    lines.push('   Hubs: ' + b.impact.hubsTouched.map(h => `${h.symbol} (${h.fanIn} callers)`).join(', '));
  }
  if (b.impact.layersCrossed.length > 0) lines.push('   Layers crossed: ' + b.impact.layersCrossed.join(', '));
  if (b.impact.governingDecisions.length > 0) lines.push('   Governing decisions: ' + b.impact.governingDecisions.join('; '));
  if (b.tests.count > 0) {
    const top = b.tests.toRun.slice(0, 8).map(t => t.test).join(', ');
    lines.push(`   Tests to run (${b.tests.count}): ${top}${b.tests.count > 8 ? ', …' : ''}`);
  }
  for (const m of b.memory.willDrift) lines.push(`   ⚠ memory ${m.kind === 'memory-orphaned' ? 'ORPHANED' : 'drifted'}: ${m.message}`);
  const memTotal = b.memory.drifted + b.memory.orphaned;
  if (memTotal > b.memory.willDrift.length) lines.push(`   … and ${memTotal - b.memory.willDrift.length} more anchored memor${memTotal - b.memory.willDrift.length === 1 ? 'y' : 'ies'}`);
  for (const d of b.decisions.items) lines.push(`   ⚠ decision ${d.kind}: ${d.message}`);
  if (b.decisions.affected > b.decisions.items.length) lines.push(`   … and ${b.decisions.affected - b.decisions.items.length} more decision issue(s)`);
  const SPEC_SHOWN = 5;
  for (const s of b.specs.items.slice(0, SPEC_SHOWN)) lines.push(`   ⚠ spec ${s.kind}: ${s.message}`);
  if (b.specs.willGoStale > SPEC_SHOWN) lines.push(`   … and ${b.specs.willGoStale - SPEC_SHOWN} more spec issue(s)`);
  lines.push('');
  return lines.join('\n');
}

export interface BlastRadiusCliOptions {
  cwd?: string;
  base?: string;
  json?: boolean;
  hook?: boolean;
  installHook?: boolean;
  uninstallHook?: boolean;
}

export async function runBlastRadiusCli(opts: BlastRadiusCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.installHook) { await installBlastRadiusHook(cwd); return typeof process.exitCode === 'number' ? process.exitCode : 0; }
  if (opts.uninstallHook) { await uninstallBlastRadiusHook(cwd); return 0; }

  // Suppress the per-call "Successfully validated directory" chatter from the
  // composed handlers so the briefing (and --json) is the only thing on stdout.
  configureLogger({ quiet: true });
  let result: Awaited<ReturnType<typeof computeBlastRadius>>;
  try {
    result = await computeBlastRadius({ directory: cwd, baseRef: opts.base });
  } catch (err) {
    // Final advisory safety net: a throw from a composed handler (e.g.
    // validateDirectory on a bad path, corrupt config/JSON) must NEVER block a
    // commit. Treat it exactly like an `{error}` return — surface and exit 0.
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }

  if ('error' in result) {
    // Advisory: an infrastructure failure (no graph, not a repo) must NEVER block
    // a commit. Surface the reason and exit 0 in hook mode.
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error: result.error }, null, 2) + '\n');
    else logger.warning(`blast-radius: ${result.error}`);
    return 0;
  }

  if (opts.json) {
    await writeStdout(JSON.stringify(result, null, 2) + '\n');
  } else {
    // Hook mode prints to stderr so it never pollutes scripted stdout.
    const out = renderHuman(result);
    if (opts.hook) process.stderr.write(out + '\n');
    else await writeStdout(out + '\n');
  }

  if (opts.hook) {
    // Config read is also advisory-safe: a throw here (or a malformed `block`) must
    // never block a commit. `readOpenLoreConfig` already tolerates unparseable JSON
    // (returns null); we additionally coerce `block` to an array so a valid-JSON but
    // wrong-typed value (e.g. `"block": {}` or a bare string) cannot throw on iteration.
    let block: BlastRadiusBlockPattern[] = [];
    try {
      const config = await readOpenLoreConfig(cwd);
      const raw = config?.blastRadius?.block;
      block = Array.isArray(raw) ? raw : [];
    } catch { block = []; }
    const fired = triggeredBlockPatterns(result, block);
    if (fired.length > 0) {
      process.stderr.write(
        `\n⛔ blast-radius: commit blocked by configured high-risk pattern(s): ${fired.join(', ')}.\n` +
        `   Resolve the flagged risk, or commit with --no-verify to override.\n\n`,
      );
      return 1;
    }
  }
  return 0;
}

export const blastRadiusCommand = new Command('blast-radius')
  .description('Pre-flight structural blast-radius briefing for the current diff (advisory). Composes impact, test selection, and spec/memory drift.')
  .option('--base <ref>', 'Git ref to diff the working tree against (default HEAD)')
  .option('--json', 'Emit the briefing as JSON', false)
  .option('--hook', 'Hook mode: print to stderr and block only on a configured high-risk pattern', false)
  .option('--install-hook', 'Install the advisory pre-commit hook', false)
  .option('--uninstall-hook', 'Remove the advisory pre-commit hook', false)
  .action(async (opts: { base?: string; json?: boolean; hook?: boolean; installHook?: boolean; uninstallHook?: boolean }) => {
    const code = await runBlastRadiusCli({
      base: opts.base,
      json: opts.json,
      hook: opts.hook,
      installHook: opts.installHook,
      uninstallHook: opts.uninstallHook,
    });
    process.exit(code);
  });
