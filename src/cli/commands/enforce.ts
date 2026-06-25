/**
 * `openlore enforce` — the unified finding-enforcement gate (change:
 * add-finding-enforcement-policy).
 *
 * Collects governance findings from the installed sources, resolves each finding's
 * enforcement class through the single declared `.openlore/config.json`
 * `enforcement.policy` (with the legacy `blastRadius.block` / `impactCertificate.block`
 * sugar lowered onto it), and — in `--hook` mode — fails the commit ONLY when at
 * least one finding resolves to `blocking`. Findings are sorted by a stable key so
 * output is reproducible. Advisory by default: a repository that declares no policy
 * never blocks. An `off`-classed finding is still listed (silenced, not invisible).
 *
 * Sources:
 *   - stale-decision-reference — always (cheap: a pure walk of the decision graph
 *     + anchored references).
 *   - blast-radius orphan patterns — collected only when the repo configured the
 *     blast-radius guard (`blastRadius.block`) or named an orphan code in the policy,
 *     because the briefing is diff-heavy.
 *   - impact-certificate surfaces — collected only when the repo declared covering
 *     surfaces, for the same reason.
 *
 * Every source is advisory-safe: a throw degrades to a caveat and NEVER blocks a
 * commit. Deterministic, no LLM (north star `c6d1ad07`).
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { fileExists } from '../../utils/command-helpers.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import {
  effectivePolicy,
  normalizeEnforcementPolicy,
  unknownPolicyCodes,
  classifyFindings,
  type GovernanceFinding,
} from '../../core/services/mcp-handlers/enforcement-policy.js';
import { detectStaleDecisionReferences } from '../../core/services/mcp-handlers/stale-decision-reference.js';
import { computeBlastRadius, type BlastRadiusBriefing } from '../../core/services/mcp-handlers/blast-radius.js';
import { computeImpactCertificate, type ImpactCertificate } from '../../core/services/mcp-handlers/impact-certificate.js';
import type { OpenLoreConfig } from '../../types/index.js';

const HOOK_MARKER = '# openlore-enforcement-hook';

const HOOK_CONTENT = `${HOOK_MARKER}
# Unified finding-enforcement gate before each commit.
# Advisory by default (exit 0); blocks only on a finding the enforcement.policy maps to blocking.
if [ -f "./node_modules/.bin/openlore" ] && ./node_modules/.bin/openlore enforce --help 2>/dev/null | grep -q -- '--hook'; then
  ./node_modules/.bin/openlore enforce --hook 2>&1
  ENFORCE_EXIT=$?
elif [ -f "./dist/cli/index.js" ] && node ./dist/cli/index.js enforce --help 2>/dev/null | grep -q -- '--hook'; then
  node ./dist/cli/index.js enforce --hook 2>&1
  ENFORCE_EXIT=$?
else
  OPENLORE=$(command -v openlore 2>/dev/null)
  if [ -n "$OPENLORE" ] && "$OPENLORE" enforce --help 2>/dev/null | grep -q -- '--hook'; then
    "$OPENLORE" enforce --hook 2>&1
    ENFORCE_EXIT=$?
  else
    ENFORCE_EXIT=0
  fi
fi
if [ "$ENFORCE_EXIT" -ne 0 ]; then
  exit "$ENFORCE_EXIT"
fi
# end-openlore-enforcement-hook
`;

export async function installEnforcementHook(rootPath: string): Promise<void> {
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
      logger.success('Unified enforcement pre-commit hook already installed.');
      return;
    }
    // Coexist with any other openlore hook (decisions gate, blast-radius, impact-cert):
    // append our block after stripping a trailing `exit 0` so it is not unreachable.
    const stripped = existing.trimEnd().replace(/\n*\nexit 0\s*$/, '');
    await writeFile(hookPath, stripped + '\n\n' + HOOK_CONTENT, 'utf-8');
  } else {
    await writeFile(hookPath, '#!/bin/sh\n\n' + HOOK_CONTENT, 'utf-8');
  }
  await chmod(hookPath, 0o755);
  logger.success('Unified enforcement pre-commit hook installed at .git/hooks/pre-commit');
  logger.discovery('It is advisory (never blocks) until enforcement.policy in .openlore/config.json maps a finding code to "blocking".');
}

export async function uninstallEnforcementHook(rootPath: string): Promise<void> {
  const hookPath = join(rootPath, '.git', 'hooks', 'pre-commit');
  if (!(await fileExists(hookPath))) {
    logger.discovery('No pre-commit hook found; nothing to uninstall.');
    return;
  }
  const existing = await readFile(hookPath, 'utf-8');
  const cleaned = existing.replace(
    new RegExp(`\\n*${HOOK_MARKER}[\\s\\S]*?# end-openlore-enforcement-hook\\n*`, 'g'),
    '\n',
  );
  if (cleaned === existing) {
    logger.discovery('Enforcement hook block not present; nothing to uninstall.');
    return;
  }
  await writeFile(hookPath, cleaned.trimEnd() + '\n', 'utf-8');
  logger.success('Removed the unified enforcement pre-commit hook block.');
}

/** Whether the repo opted into a diff-heavy source (so the gate should run it). */
function blastRadiusInUse(config: OpenLoreConfig | null, policy: Record<string, string>): boolean {
  if (Array.isArray(config?.blastRadius?.block) && config!.blastRadius!.block!.length > 0) return true;
  return policy['orphans-anchored-memory'] !== undefined || policy['orphans-anchored-decision'] !== undefined;
}
function impactCertificateInUse(config: OpenLoreConfig | null): boolean {
  return Array.isArray(config?.impactCertificate?.surfaces) && config!.impactCertificate!.surfaces!.length > 0;
}

/**
 * Map a blast-radius briefing onto unified governance findings — one per orphan
 * pattern the briefing triggers. Reads the SAME uncapped `*.orphaned` counts the
 * legacy `blast-radius --hook` blocks on (`triggeredBlockPatterns`), so the gate
 * and the legacy hook block on exactly the same diffs. Pure; no I/O.
 */
export function blastRadiusFindings(b: BlastRadiusBriefing): GovernanceFinding[] {
  const out: GovernanceFinding[] = [];
  if (b.memory.orphaned > 0) {
    out.push({
      code: 'orphans-anchored-memory', severity: 'error', source: 'blast-radius',
      subject: 'anchored-memory',
      message: `the change orphans ${b.memory.orphaned} anchored memor${b.memory.orphaned === 1 ? 'y' : 'ies'}.`,
    });
  }
  if (b.decisions.orphaned > 0) {
    out.push({
      code: 'orphans-anchored-decision', severity: 'error', source: 'blast-radius',
      subject: 'anchored-decision',
      message: `the change orphans ${b.decisions.orphaned} anchored decision(s).`,
    });
  }
  return out;
}

/** The intrinsic severity a surface finding carries, mirroring the certificate's own convention. */
const SURFACE_SEVERITY: Record<string, string> = { info: 'info', warn: 'warn', critical: 'error' };

/**
 * Map an impact certificate onto unified governance findings — one per declared
 * surface severity the change opens a new path into. Reads the SAME
 * `newlyOpenedPaths[].surfaceSeverity` the legacy `impact-certificate --hook`
 * blocks on (`triggeredBlockSeverities`), grouped into the per-severity
 * `surface-<sev>` codes a policy can name, so the two block on identical diffs.
 * Deterministic: surfaces are sorted; the intrinsic severity reflects the actual
 * surface severity (info→info, warn→warn, critical→error). Pure; no I/O.
 */
export function impactCertificateFindings(cert: ImpactCertificate): GovernanceFinding[] {
  const bySeverity = new Map<string, Set<string>>();
  for (const p of cert.newlyOpenedPaths) {
    const set = bySeverity.get(p.surfaceSeverity) ?? new Set<string>();
    set.add(p.surface);
    bySeverity.set(p.surfaceSeverity, set);
  }
  const out: GovernanceFinding[] = [];
  for (const [sev, surfaces] of bySeverity) {
    const named = [...surfaces].sort();
    out.push({
      code: `surface-${sev}`, severity: SURFACE_SEVERITY[sev] ?? 'warn', source: 'impact-certificate',
      subject: named.join(','),
      message: `the change opens a new path into ${named.length} ${sev} surface(s): ${named.join(', ')}.`,
    });
  }
  return out;
}

/**
 * Collect governance findings from every in-scope source, mapping each native
 * finding onto the unified {@link GovernanceFinding} shape. Each source is
 * advisory-safe — a throw is recorded as a caveat and contributes no finding,
 * NEVER a block. Returns the findings plus any non-fatal source caveats.
 */
export async function collectGovernanceFindings(
  cwd: string,
  config: OpenLoreConfig | null,
  policy: Record<string, string>,
  baseRef?: string,
): Promise<{ findings: GovernanceFinding[]; caveats: string[] }> {
  const findings: GovernanceFinding[] = [];
  const caveats: string[] = [];

  // stale-decision-reference — always (cheap).
  try {
    for (const f of await detectStaleDecisionReferences(cwd)) {
      findings.push({
        code: f.code,
        severity: f.severity,
        source: 'stale-decision-reference',
        subject: `${f.referencingArtifact.kind}:${f.referencingArtifact.id}`,
        message: f.message,
      });
    }
  } catch (err) {
    caveats.push(`stale-decision-reference check unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // blast-radius orphan patterns — only when configured (diff-heavy).
  if (blastRadiusInUse(config, policy)) {
    try {
      const b = await computeBlastRadius({ directory: cwd, baseRef });
      if (!('error' in b)) findings.push(...blastRadiusFindings(b));
      else caveats.push(`blast-radius unavailable: ${b.error}`);
    } catch (err) {
      caveats.push(`blast-radius unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // impact-certificate surfaces — only when surfaces are declared (diff-heavy).
  if (impactCertificateInUse(config)) {
    try {
      const cert = await computeImpactCertificate({ directory: cwd, baseRef });
      if (!('error' in cert)) findings.push(...impactCertificateFindings(cert));
      else caveats.push(`impact-certificate unavailable: ${cert.error}`);
    } catch (err) {
      caveats.push(`impact-certificate unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { findings, caveats };
}

const ICON: Record<string, string> = { blocking: '⛔', advisory: '⚠', off: '🔇' };

export interface EnforceCliOptions {
  cwd?: string;
  base?: string;
  json?: boolean;
  hook?: boolean;
  installHook?: boolean;
  uninstallHook?: boolean;
}

export async function runEnforceCli(opts: EnforceCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.installHook) { await installEnforcementHook(cwd); return typeof process.exitCode === 'number' ? process.exitCode : 0; }
  if (opts.uninstallHook) { await uninstallEnforcementHook(cwd); return 0; }

  configureLogger({ quiet: true });
  let config: OpenLoreConfig | null = null;
  try { config = await readOpenLoreConfig(cwd); } catch { config = null; }
  const policy = effectivePolicy(config);
  const unknown = unknownPolicyCodes(normalizeEnforcementPolicy(config?.enforcement));

  let collected: Awaited<ReturnType<typeof collectGovernanceFindings>>;
  try {
    collected = await collectGovernanceFindings(cwd, config, policy, opts.base);
  } catch (err) {
    // Final advisory safety net: a throw must NEVER block a commit.
    collected = { findings: [], caveats: [`enforcement gate error: ${err instanceof Error ? err.message : String(err)}`] };
  } finally {
    configureLogger({ quiet: false });
  }

  const result = classifyFindings(collected.findings, policy);

  if (opts.json) {
    await writeStdout(JSON.stringify({
      gated: result.gated,
      blocking: result.blocking,
      advisory: result.advisory,
      off: result.off,
      unknownPolicyCodes: unknown,
      caveats: collected.caveats,
    }, null, 2) + '\n');
  } else {
    const out = renderHuman(result, unknown, collected.caveats);
    if (opts.hook) process.stderr.write(out + '\n');
    else await writeStdout(out + '\n');
  }

  if (opts.hook && result.gated) {
    process.stderr.write(
      `\n⛔ enforce: commit blocked by ${result.blocking.length} blocking finding(s).\n` +
      `   Resolve the flagged risk, set the code to advisory/off in enforcement.policy, or commit with --no-verify to override.\n\n`,
    );
    return 1;
  }
  return 0;
}

function renderHuman(
  result: ReturnType<typeof classifyFindings>,
  unknown: string[],
  caveats: string[],
): string {
  const lines: string[] = ['', '🛡 Enforcement gate' + (result.gated ? ' (BLOCKED)' : ' (advisory)')];
  if (result.classified.length === 0) {
    lines.push('   No governance findings.');
  } else {
    for (const f of result.classified) {
      lines.push(`   ${ICON[f.enforcementClass]} [${f.enforcementClass}] ${f.code} (${f.source}): ${f.message}`);
    }
  }
  if (unknown.length > 0) {
    lines.push(`   ℹ enforcement.policy names ${unknown.length} unrecognized code(s) — retained, no source emits them yet: ${unknown.join(', ')}`);
  }
  for (const c of caveats) lines.push(`   ⚠ ${c}`);
  lines.push('');
  return lines.join('\n');
}

export const enforceCommand = new Command('enforce')
  .description('Unified finding-enforcement gate (advisory): resolve every governance finding through enforcement.policy and block only on a finding mapped to "blocking".')
  .option('--base <ref>', 'Git ref to diff the working tree against for diff-based sources (default HEAD)')
  .option('--json', 'Emit the gate result as JSON', false)
  .option('--hook', 'Hook mode: print to stderr and exit 1 only on a blocking-classed finding', false)
  .option('--install-hook', 'Install the unified enforcement pre-commit hook', false)
  .option('--uninstall-hook', 'Remove the unified enforcement pre-commit hook', false)
  .action(async (opts: { base?: string; json?: boolean; hook?: boolean; installHook?: boolean; uninstallHook?: boolean }) => {
    const code = await runEnforceCli({
      base: opts.base, json: opts.json, hook: opts.hook,
      installHook: opts.installHook, uninstallHook: opts.uninstallHook,
    });
    process.exit(code);
  });
