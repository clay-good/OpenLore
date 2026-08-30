/**
 * `openlore enforce` — the unified finding-enforcement gate (change:
 * add-finding-enforcement-policy).
 *
 * Collects governance findings from the installed sources, resolves each finding's
 * enforcement class through the single declared `.openlore/config.json`
 * `enforcement.policy` (with the legacy `blastRadius.block` / `impactCertificate.block`
 * sugar lowered onto it), and — in `--hook` mode — fails the commit ONLY when at
 * least one finding resolves to `blocking`. Findings are sorted by a stable key so
 * output is reproducible. Each source declares its default class; an `off`-classed
 * finding remains listed (silenced, not invisible).
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
 * Blocking and frozen sources fail closed when their assessment cannot be completed.
 * Deterministic, no LLM (north star `c6d1ad07`).
 */

import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR } from '../../constants.js';
import { gitPathArgs } from '../../utils/git-args.js';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { sanitizeForTerminal } from '../../utils/misc.js';
import { readOpenLoreConfigStrict } from '../../core/services/config-manager.js';
import {
  effectivePolicy,
  normalizeEnforcementPolicy,
  unknownPolicyCodes,
  classifyFindings,
  resolveEnforcementClass,
  type GovernanceFinding,
  CORPUS_INTENT_FINDING_CODES,
  ARCHITECTURE_FINDING_CODES,
} from '../../core/services/mcp-handlers/enforcement-policy.js';
import { applyEnforcementBaseline } from '../../core/services/mcp-handlers/enforcement-baseline.js';
import { detectStaleDecisionReferences } from '../../core/services/mcp-handlers/stale-decision-reference.js';
import {
  CORPUS_FINDING_CODES,
  detectCorpusIntegrity,
} from '../../core/decisions/corpus-integrity.js';
import { reviewCorpusIntent, type CorpusIntentFinding } from '../../core/drift/corpus-intent-review.js';
import {
  materializeOpenSpecCorpus,
  prepareOpenSpecCorpusSource,
  resolveBaseRefDisclosed,
} from '../../core/drift/git-diff.js';
import { computeBlastRadius, type BlastRadiusBriefing } from '../../core/services/mcp-handlers/blast-radius.js';
import { computeImpactCertificate, type ImpactCertificate } from '../../core/services/mcp-handlers/impact-certificate.js';
import {
  decisionConstraintViolationFindings,
  loadDecisionConstraintState,
  type DecisionConstraintState,
} from '../../core/decisions/constraint-ledger.js';
import {
  architectureViolationFindings,
  ARCHITECTURE_CODE_BY_KIND,
  loadDepGraph,
} from '../../core/services/mcp-handlers/architecture.js';
import { loadArchitectureRules } from '../../core/architecture/rules.js';
import { scanViolations } from '../../core/architecture/check.js';
import { assessStalenessForAnalysis } from '../../core/services/mcp-handlers/confidence-boundary.js';
import type { OpenLoreConfig } from '../../types/index.js';
import {
  displayHookPath,
  hookManagerWarning,
  isResolvedGitRepository,
  resolveGitHookTarget,
  resolveTrustedHookLauncher,
  renderTrustedHookCommand,
  updateHookFile,
} from '../git-hooks.js';

const HOOK_MARKER = '# openlore-enforcement-hook';
const execFileAsync = promisify(execFile);
const ENFORCEMENT_BASELINE_REPO_PATH = '.openlore/enforcement-baseline.jsonl';

const renderHookContent = (command: string) => `${HOOK_MARKER}
# Unified finding-enforcement gate before each commit.
# Advisory by default; fails closed for configured blocking/frozen policy and unverifiable execution.
${command} 2>&1
ENFORCE_EXIT=$?
if [ "$ENFORCE_EXIT" -ne 0 ]; then
  exit "$ENFORCE_EXIT"
fi
# end-openlore-enforcement-hook
`;

export async function installEnforcementHook(rootPath: string): Promise<void> {
  const target = await resolveGitHookTarget(rootPath, 'pre-commit');
  const hookPath = target.hookPath;

  if (!(await isResolvedGitRepository(rootPath, target))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return;
  }
  if (!target.canInstall) {
    logger.warning(hookManagerWarning(target, 'openlore enforce --hook'));
    return;
  }
  const launcher = await resolveTrustedHookLauncher(rootPath);
  if (!launcher) {
    logger.error('Cannot pin an OpenLore installation outside this repository. Install OpenLore globally and retry.');
    process.exitCode = 1;
    return;
  }
  const hookContent = renderHookContent(renderTrustedHookCommand(launcher, ['enforce', '--hook']));
  let alreadyInstalled = false;
  const result = await updateHookFile(hookPath, (existing) => {
    if (existing?.includes(HOOK_MARKER)) {
      alreadyInstalled = true;
      const refreshed = existing.replace(/# openlore-enforcement-hook[\s\S]*?# end-openlore-enforcement-hook/, hookContent.trimEnd());
      return refreshed === existing ? null : refreshed;
    }
    const stripped = existing?.trimEnd().replace(/\n*\nexit 0\s*$/, '');
    return stripped
      ? stripped + '\n\n' + hookContent
      : '#!/bin/sh\n\n' + hookContent;
  });
  if (result.status === 'unavailable') {
    logger.warning(`Cannot install the enforcement hook at ${displayHookPath(hookPath)}: ${result.reason}`);
    return;
  }
  if (alreadyInstalled) {
    logger.success('Unified enforcement pre-commit hook already installed.');
    return;
  }
  logger.success(`Unified enforcement pre-commit hook installed at ${displayHookPath(hookPath)}`);
  logger.discovery('It is advisory until enforcement.policy maps a finding code to "blocking" or "frozen". Initialize frozen codes with `openlore enforce` before relying on the hook.');
}

export async function uninstallEnforcementHook(rootPath: string): Promise<void> {
  const { hookPath } = await resolveGitHookTarget(rootPath, 'pre-commit');
  let hookFound = false;
  let blockFound = false;
  const result = await updateHookFile(hookPath, (existing) => {
    if (existing === null) return null;
    hookFound = true;
    const cleaned = existing.replace(
      new RegExp(`\\n*${HOOK_MARKER}[\\s\\S]*?# end-openlore-enforcement-hook\\n*`, 'g'),
      '\n',
    );
    if (cleaned === existing) return null;
    blockFound = true;
    return cleaned.trimEnd() + '\n';
  });
  if (result.status === 'unavailable') {
    logger.warning(`Cannot uninstall the enforcement hook at ${displayHookPath(hookPath)}: ${result.reason}`);
    return;
  }
  if (!hookFound) {
    logger.discovery('No pre-commit hook found; nothing to uninstall.');
  } else if (!blockFound) {
    logger.discovery('Enforcement hook block not present; nothing to uninstall.');
  } else {
    logger.success('Removed the unified enforcement pre-commit hook block.');
  }
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
  const memory = b.memory.orphanFindings ?? [];
  const decisions = b.decisions.orphanFindings ?? [];
  return [
    ...memory.map((finding) => ({
      code: 'orphans-anchored-memory', severity: 'error' as const, source: 'blast-radius',
      subject: finding.filePath,
      discriminator: finding.id,
      message: finding.message,
    })),
    ...decisions.map((finding) => ({
      code: 'orphans-anchored-decision', severity: 'error' as const, source: 'blast-radius',
      subject: finding.filePath,
      discriminator: finding.id,
      message: finding.message,
    })),
  ];
}

/** A partial drift pass may report findings, but it must never initialize or shrink orphan debt. */
export function blastRadiusAssessmentComplete(b: BlastRadiusBriefing): boolean {
  return b.driftAssessment?.complete === true;
}

/** The intrinsic severity a surface finding carries, mirroring the certificate's own convention. */
const SURFACE_SEVERITY: Record<string, GovernanceFinding['severity']> = {
  info: 'info',
  warn: 'warning',
  critical: 'error',
};

/**
 * Map an impact certificate onto unified governance findings — one per declared
 * surface severity the change opens a new path into. Reads the SAME
 * `newlyOpenedPaths[].surfaceSeverity` the legacy `impact-certificate --hook`
 * blocks on (`triggeredBlockSeverities`), grouped into the per-severity
 * `surface-<sev>` codes a policy can name, so the two block on identical diffs.
 * Deterministic: surfaces are sorted; the intrinsic severity reflects the actual
 * surface severity (info→info, warn→warning, critical→error). Pure; no I/O.
 */
export function impactCertificateFindings(cert: ImpactCertificate): GovernanceFinding[] {
  const unique = new Map<string, GovernanceFinding>();
  for (const path of cert.newlyOpenedPaths) {
    const discriminator = JSON.stringify(path.pathIds);
    const finding: GovernanceFinding = {
      code: `surface-${path.surfaceSeverity}`,
      severity: SURFACE_SEVERITY[path.surfaceSeverity] ?? 'warning',
      source: 'impact-certificate',
      subject: path.surface,
      discriminator,
      message: `the change opens a new path into the ${path.surfaceSeverity} surface ${path.surface}: ${path.path.join(' → ')}.`,
    };
    unique.set(`${finding.code}\0${finding.subject}\0${discriminator}`, finding);
  }
  return [...unique.values()].sort((a, b) => {
    const aKey = `${a.code}\0${a.subject}\0${a.discriminator}`;
    const bKey = `${b.code}\0${b.subject}\0${b.discriminator}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

/** Adapt source-rich corpus intent findings to the unified enforcement shape. */
export function corpusIntentGovernanceFindings(
  findings: readonly CorpusIntentFinding[],
): GovernanceFinding[] {
  return findings.map((finding) => ({
    code: finding.code,
    severity: 'warning',
    source: 'corpus-intent-review',
    subject: finding.artifact,
    message: finding.message,
    discriminator: JSON.stringify([
      finding.requirement ?? null,
      finding.baseValue ?? null,
      finding.headValue ?? null,
    ]),
  }));
}

async function collectCorpusIntentFindings(
  cwd: string,
  baseRef?: string,
): Promise<GovernanceFinding[]> {
  const requested = baseRef ?? 'HEAD';
  const resolution = await resolveBaseRefDisclosed(cwd, requested);
  if (resolution.fellBack) {
    throw new Error(
      `Base ref "${resolution.requested}" did not resolve; refusing to substitute ` +
      `"${resolution.resolved}".`,
    );
  }
  const baseSource = { kind: 'revision' as const, revision: resolution.resolved };
  const headSource = { kind: 'directory' as const, directory: cwd };
  const preparedBase = await prepareOpenSpecCorpusSource(cwd, baseSource);
  const preparedHead = await prepareOpenSpecCorpusSource(cwd, headSource);
  const base = await materializeOpenSpecCorpus({ rootPath: cwd, ...preparedBase });
  const head = await materializeOpenSpecCorpus({ rootPath: cwd, ...preparedHead });
  return corpusIntentGovernanceFindings(reviewCorpusIntent(base.files, head.files).findings);
}

function impactCertificateAssessmentComplete(cert: ImpactCertificate): boolean {
  if (cert.findings.some((finding) => finding.code === 'unresolved-added-call')) return false;
  return !cert.caveats.some((caveat) =>
    /not computed|not assessed|certificate lists the \d+ shortest/i.test(caveat));
}

/**
 * Collect governance findings from every in-scope source, mapping each native
 * finding onto the unified {@link GovernanceFinding} shape. Source failures are
 * recorded per code: advisory policies keep their historical fail-soft behavior,
 * while affected frozen codes preserve baseline bytes and fail closed.
 */
export async function collectGovernanceFindings(
  cwd: string,
  config: OpenLoreConfig | null,
  policy: Record<string, string>,
  baseRef?: string,
): Promise<{
  findings: GovernanceFinding[];
  caveats: string[];
  assessedCodes: Set<string>;
  failedCodes: Set<string>;
  decisionConstraints?: Pick<DecisionConstraintState, 'ledger' | 'retiredRules'>;
}> {
  const findings: GovernanceFinding[] = [];
  const caveats: string[] = [];
  const assessedCodes = new Set<string>();
  const failedCodes = new Set<string>();
  let decisionConstraints: Pick<DecisionConstraintState, 'ledger' | 'retiredRules'> | undefined;

  // stale-decision-reference — always (cheap).
  try {
    for (const f of await detectStaleDecisionReferences(cwd)) {
      findings.push({
        code: f.code,
        severity: f.severity,
        source: 'stale-decision-reference',
        subject: `${f.referencingArtifact.kind}:${f.referencingArtifact.id}`,
        message: f.message,
        discriminator: f.retiredDecision,
      });
    }
    assessedCodes.add('stale-decision-reference');
  } catch (err) {
    caveats.push(`stale-decision-reference check unavailable: ${err instanceof Error ? err.message : String(err)}`);
    failedCodes.add('stale-decision-reference');
  }

  // Decision-bound constraints — always load the declared eligibility corpus.
  // An active rule requires the whole stored dependency graph; malformed blocks
  // remain visible even when no graph is available.
  try {
    const state = await loadDecisionConstraintState(cwd, config?.openspecPath);
    decisionConstraints = { ledger: state.ledger, retiredRules: state.retiredRules };
    findings.push(...state.malformedFindings);
    assessedCodes.add('decision-constraint-malformed');
    if (!state.violationAssessmentComplete) {
      caveats.push('decision-constraint violation assessment incomplete: an authoritative constraint or lifecycle record is malformed');
      failedCodes.add('decision-constraint-violation');
    } else if (state.rules.length === 0) {
      assessedCodes.add('decision-constraint-violation');
    } else {
      const graph = await loadDepGraph(cwd);
      if (!graph) {
        caveats.push('decision-constraint check unavailable: no dependency graph; run openlore analyze');
        failedCodes.add('decision-constraint-violation');
      } else {
        findings.push(...decisionConstraintViolationFindings(graph, state));
        const freshness = await assessStalenessForAnalysis(
          cwd,
          join(cwd, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR),
          Date.now(),
          false,
        );
        if (!freshness.indexCommit || freshness.changedSourceFiles === null) {
          caveats.push('decision-constraint violation assessment incomplete: dependency graph freshness is unknown; run openlore analyze in this Git worktree');
          failedCodes.add('decision-constraint-violation');
        } else if (freshness.changedSourceFiles > 0) {
          caveats.push(`decision-constraint violation assessment incomplete: ${freshness.changedSourceFiles} graph-source file(s) changed since analysis; run openlore analyze`);
          failedCodes.add('decision-constraint-violation');
        } else {
          assessedCodes.add('decision-constraint-violation');
        }
      }
    }
  } catch (err) {
    caveats.push(`decision-constraint check unavailable: ${err instanceof Error ? err.message : String(err)}`);
    failedCodes.add('decision-constraint-malformed');
    failedCodes.add('decision-constraint-violation');
  }

  // Author-declared architecture rules — deterministic and opt-in. Decision-carried
  // constraints are excluded here because the lifecycle-aware source above owns them.
  try {
    const architectureRules = await loadArchitectureRules(cwd, { includeDecisions: false });
    if (architectureRules.warnings.length > 0) {
      caveats.push(...architectureRules.warnings.map(warning => `architecture rule warning: ${warning}`));
    }
    const activeArchitectureCodes = new Set(
      architectureRules.rules.map(rule => ARCHITECTURE_CODE_BY_KIND[rule.kind]),
    );
    if (architectureRules.assessmentComplete === false) {
      caveats.push('architecture rule assessment incomplete: config is malformed or unreadable');
      for (const code of ARCHITECTURE_FINDING_CODES) failedCodes.add(code);
    } else {
      for (const code of ARCHITECTURE_FINDING_CODES) {
        if (!activeArchitectureCodes.has(code)) assessedCodes.add(code);
      }
    }
    if (architectureRules.assessmentComplete === false) {
      // Never assess or reconcile frozen baselines from a partially parsed corpus.
    } else if (architectureRules.rules.length === 0) {
      for (const code of ARCHITECTURE_FINDING_CODES) assessedCodes.add(code);
    } else {
      const graph = await loadDepGraph(cwd);
      if (!graph) {
        caveats.push('architecture rule check unavailable: no dependency graph; run openlore analyze');
        for (const code of activeArchitectureCodes) failedCodes.add(code);
      } else {
        const scan = scanViolations(graph, architectureRules);
        findings.push(...architectureViolationFindings(scan.violations));
        if (!scan.assessmentComplete) {
          caveats.push(...scan.warnings
            .filter(warning => warning.includes('lower-confidence'))
            .map(warning => `architecture rule warning: ${warning}`));
        }
        const freshness = await assessStalenessForAnalysis(
          cwd,
          join(cwd, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR),
          Date.now(),
          false,
        );
        if (!freshness.indexCommit || freshness.changedSourceFiles !== 0) {
          caveats.push('architecture rule assessment incomplete: dependency graph is stale or its freshness is unknown; run openlore analyze');
          for (const code of activeArchitectureCodes) failedCodes.add(code);
        } else {
          for (const [kind, code] of Object.entries(ARCHITECTURE_CODE_BY_KIND)) {
            if (!activeArchitectureCodes.has(code)) continue;
            if (scan.incompleteKinds.includes(kind as keyof typeof ARCHITECTURE_CODE_BY_KIND)) {
              failedCodes.add(code);
            } else {
              assessedCodes.add(code);
            }
          }
        }
      }
    }
  } catch (err) {
    caveats.push(`architecture rule check unavailable: ${err instanceof Error ? err.message : String(err)}`);
    for (const code of ARCHITECTURE_FINDING_CODES) failedCodes.add(code);
  }

  // Governance-corpus integrity — always (bounded local artifact walk, no LLM).
  // Keep the legacy stale-decision source above for compatibility; this pass owns
  // the closed typed-edge contract and the corpus-* finding vocabulary.
  try {
    findings.push(...await detectCorpusIntegrity(cwd, { openspecPath: config?.openspecPath }));
    for (const code of CORPUS_FINDING_CODES) assessedCodes.add(code);
  } catch (err) {
    caveats.push(`corpus-integrity check unavailable: ${err instanceof Error ? err.message : String(err)}`);
    for (const code of CORPUS_FINDING_CODES) failedCodes.add(code);
  }

  // Corpus intent delta — always (bounded, deterministic comparison of the
  // selected base corpus with the working tree; no checkout or worktree).
  try {
    findings.push(...await collectCorpusIntentFindings(cwd, baseRef));
    for (const code of CORPUS_INTENT_FINDING_CODES) assessedCodes.add(code);
  } catch (err) {
    caveats.push(`corpus-intent review unavailable: ${err instanceof Error ? err.message : String(err)}`);
    for (const code of CORPUS_INTENT_FINDING_CODES) failedCodes.add(code);
  }

  // blast-radius orphan patterns — only when configured (diff-heavy).
  if (blastRadiusInUse(config, policy)) {
    try {
      const b = await computeBlastRadius({ directory: cwd, baseRef });
      if (!('error' in b)) {
        findings.push(...blastRadiusFindings(b));
        if (blastRadiusAssessmentComplete(b)) {
          assessedCodes.add('orphans-anchored-memory');
          assessedCodes.add('orphans-anchored-decision');
        } else {
          caveats.push('blast-radius orphan baseline was not reconciled because drift analysis was incomplete');
          failedCodes.add('orphans-anchored-memory');
          failedCodes.add('orphans-anchored-decision');
        }
      }
      else {
        caveats.push(`blast-radius unavailable: ${b.error}`);
        failedCodes.add('orphans-anchored-memory');
        failedCodes.add('orphans-anchored-decision');
      }
    } catch (err) {
      caveats.push(`blast-radius unavailable: ${err instanceof Error ? err.message : String(err)}`);
      failedCodes.add('orphans-anchored-memory');
      failedCodes.add('orphans-anchored-decision');
    }
  }

  // impact-certificate surfaces — only when surfaces are declared (diff-heavy).
  if (impactCertificateInUse(config)) {
    try {
      const cert = await computeImpactCertificate({ directory: cwd, baseRef });
      if (!('error' in cert)) {
        findings.push(...impactCertificateFindings(cert));
        if (impactCertificateAssessmentComplete(cert)) {
          assessedCodes.add('surface-info');
          assessedCodes.add('surface-warn');
          assessedCodes.add('surface-critical');
        } else {
          caveats.push('impact-certificate baseline was not reconciled because path assessment was incomplete');
          failedCodes.add('surface-info');
          failedCodes.add('surface-warn');
          failedCodes.add('surface-critical');
        }
      }
      else {
        caveats.push(`impact-certificate unavailable: ${cert.error}`);
        failedCodes.add('surface-info');
        failedCodes.add('surface-warn');
        failedCodes.add('surface-critical');
      }
    } catch (err) {
      caveats.push(`impact-certificate unavailable: ${err instanceof Error ? err.message : String(err)}`);
      failedCodes.add('surface-info');
      failedCodes.add('surface-warn');
      failedCodes.add('surface-critical');
    }
  }

  return { findings, caveats, assessedCodes, failedCodes, decisionConstraints };
}

const ICON: Record<string, string> = { blocking: '⛔', frozen: '❄', advisory: '⚠', off: '🔇' };

async function inspectWorktreeStatus(
  cwd: string,
  paths: readonly string[] = [],
): Promise<{ dirty: boolean; error?: string }> {
  try {
    // The assessment reads the working tree while Git commits the index. Any
    // unstaged/untracked path can therefore make the hook certify different bytes
    // than the commit, including config, specs, decision stores, and source files.
    const { stdout } = await execFileAsync('git', [
      'status', '--porcelain', '--untracked-files=all', ...(paths.length > 0 ? ['--', ...paths] : []),
    ], { cwd });
    return { dirty: stdout.split('\n').some((line) => line.startsWith('??') || (line.length >= 2 && line[1] !== ' ')) };
  } catch (error) {
    return { dirty: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function trustedBaselineAtHead(cwd: string): Promise<{ text?: string | null; error?: string }> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd });
    const { stdout } = await execFileAsync('git', gitPathArgs(
      'ls-tree', '-z', '--name-only', 'HEAD', '--', ENFORCEMENT_BASELINE_REPO_PATH,
    ), { cwd });
    if (stdout === '') return { text: null };
    if (stdout !== `${ENFORCEMENT_BASELINE_REPO_PATH}\0`) {
      return { error: `unexpected git tree result for ${ENFORCEMENT_BASELINE_REPO_PATH}` };
    }
    const baseline = await execFileAsync('git', ['show', `HEAD:${ENFORCEMENT_BASELINE_REPO_PATH}`], { cwd });
    return { text: baseline.stdout };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function candidateBaselineExists(cwd: string): Promise<boolean> {
  try {
    await lstat(join(cwd, ENFORCEMENT_BASELINE_REPO_PATH));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true; // Conservatively enter bounded baseline validation on any other path failure.
  }
}

export interface EnforceCliOptions {
  cwd?: string;
  base?: string;
  json?: boolean;
  hook?: boolean;
  agentHook?: boolean;
  installHook?: boolean;
  uninstallHook?: boolean;
}

export async function runEnforceCli(opts: EnforceCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.installHook) { await installEnforcementHook(cwd); return typeof process.exitCode === 'number' ? process.exitCode : 0; }
  if (opts.uninstallHook) { await uninstallEnforcementHook(cwd); return 0; }

  configureLogger({ quiet: true });
  let config: OpenLoreConfig | null = null;
  let configReadError: string | null = null;
  try {
    config = await readOpenLoreConfigStrict(cwd);
  } catch (error) {
    configReadError = error instanceof Error ? error.message : String(error);
  }
  const explicitPolicy = normalizeEnforcementPolicy(config?.enforcement);
  const policy = effectivePolicy(config);
  const unknown = unknownPolicyCodes(explicitPolicy);

  let collected: Awaited<ReturnType<typeof collectGovernanceFindings>>;
  try {
    collected = await collectGovernanceFindings(cwd, config, policy, opts.base);
  } catch (err) {
    // Final advisory safety net: a throw must NEVER block a commit.
    collected = {
      findings: [],
      caveats: [`enforcement gate error: ${err instanceof Error ? err.message : String(err)}`],
      assessedCodes: new Set(),
      failedCodes: new Set(Object.keys(policy)),
    };
  } finally {
    configureLogger({ quiet: false });
  }

  const classified = classifyFindings(collected.findings, policy);
  if (opts.agentHook) {
    const unavailable = configReadError !== null || collected.failedCodes.size > 0;
    if (configReadError) collected.caveats.push(`enforcement config unavailable: ${configReadError}`);
    const output = renderAgentHook(classified, collected.caveats, unavailable);
    process.stderr.write(sanitizeForTerminal(output + '\n', { keepNewlines: true }));
    const explicitlyBlocking = classified.blocking.some(
      (finding) => explicitPolicy[finding.code] === 'blocking',
    );
    return !unavailable && explicitlyBlocking ? 2 : 0;
  }
  const activeFrozenAssessment = collected.assessedCodes.size > 0 && Object.entries(policy)
    .some(([code, enforcementClass]) => enforcementClass === 'frozen' && collected.assessedCodes.has(code));
  const activeGatePolicy = Object.values(policy)
    .some((enforcementClass) => enforcementClass === 'blocking' || enforcementClass === 'frozen');
  // Source-declared defaults are policy too. A default-blocking source must
  // compare the working tree with the index even when the operator has not
  // repeated that default in .openlore/config.json.
  const activeGateAssessment = [...collected.assessedCodes]
    .some((code) => {
      const enforcementClass = resolveEnforcementClass(code, policy);
      return enforcementClass === 'blocking' || enforcementClass === 'frozen';
    });
  const failedGateCodes = [...collected.failedCodes]
    .filter((code) => {
      const cls = resolveEnforcementClass(code, policy);
      return cls === 'blocking' || cls === 'frozen';
    })
    .sort();
  const trustedBaseline = activeFrozenAssessment || opts.hook
    ? await trustedBaselineAtHead(cwd)
    : { text: undefined };
  const explicitGateOrConfig = activeGatePolicy || config !== null || configReadError !== null;
  const irrelevantNoPolicyAbsence = Boolean(
    trustedBaseline.error && !explicitGateOrConfig &&
    /not a git repository|needed a single revision|unknown revision|ambiguous argument ['"]?HEAD/i.test(trustedBaseline.error),
  );
  const trustedBaselineError = trustedBaseline.error && !irrelevantNoPolicyAbsence
    ? trustedBaseline.error
    : null;
  const baselineExistsInCandidate = opts.hook && trustedBaseline.text === null
    ? await candidateBaselineExists(cwd)
    : false;
  const trustedBaselineInput = trustedBaselineError
    ? ''
    : trustedBaseline.text === null && !activeFrozenAssessment && !baselineExistsInCandidate
      ? undefined
      : trustedBaseline.text;
  const reconciled = await applyEnforcementBaseline(
    cwd,
    classified,
    policy,
    collected.assessedCodes,
    opts.hook ? 'gate' : 'bootstrap',
    trustedBaselineInput,
  );
  const result = reconciled.gate;
  // Only a successful baseline match earns the public `frozen` label. Failed,
  // partial, or integrity-invalid assessments stay in the classified receipt but
  // never masquerade as known frozen debt.
  result.frozen = result.frozen.filter((finding) => finding.baselineState === 'frozen');
  if (configReadError) {
    result.gated = true;
    collected.caveats.push(`enforcement config unavailable: ${configReadError}`);
  }
  if (failedGateCodes.length > 0) {
    result.gated = true;
    collected.caveats.push(`frozen assessment failed or blocking source unavailable for ${failedGateCodes.join(', ')}; baseline bytes were preserved where applicable`);
  }
  if (trustedBaselineError) {
    result.gated = true;
    collected.caveats.push(`frozen baseline HEAD state unavailable: ${trustedBaselineError}`);
  }
  // Read the config from the working tree, but Git commits the index. Probe that
  // path even when the working-tree config is absent/valid so staged malformed
  // bytes cannot masquerade as the no-policy default.
  const configStatus = opts.hook
    ? await inspectWorktreeStatus(cwd, ['.openlore/config.json'])
    : { dirty: false };
  const configMismatch = configStatus.dirty;
  if (configMismatch) {
    result.gated = true;
    collected.caveats.push('enforcement config differs between the Git index and working tree');
  }
  const requiresFullWorktreeCheck = activeGatePolicy || activeGateAssessment || activeFrozenAssessment || failedGateCodes.length > 0 ||
    configReadError !== null || configMismatch;
  const worktreeStatus = opts.hook && requiresFullWorktreeCheck && !irrelevantNoPolicyAbsence
    ? await inspectWorktreeStatus(cwd)
    : { dirty: false };
  const baselineDirty = configMismatch || worktreeStatus.dirty;
  if (baselineDirty || worktreeStatus.error) result.gated = true;
  if (worktreeStatus.error) collected.caveats.push(`frozen baseline staging status unavailable: ${worktreeStatus.error}`);
  if (reconciled.baseline.caveat) collected.caveats.push(reconciled.baseline.caveat);

  if (opts.json) {
    await writeStdout(JSON.stringify({
      schemaVersion: 3,
      gated: result.gated,
      blocking: result.blocking,
      new: result.blocking.filter((finding) =>
        finding.enforcementClass === 'frozen' && finding.baselineState === 'new'),
      advisory: result.advisory,
      frozen: result.frozen,
      off: result.off,
      ratchet: {
        path: reconciled.baseline.path,
        initializedCodes: reconciled.baseline.initialized,
        frozenCount: reconciled.baseline.frozen,
        newCount: reconciled.baseline.new,
        retiredCount: reconciled.baseline.removed,
        baselineChanged: reconciled.baseline.written,
        requiresInitialization: reconciled.baseline.requiresInitialization ?? [],
        failedAssessmentCodes: failedGateCodes,
        unstaged: baselineDirty,
      },
      unknownPolicyCodes: unknown,
      decisionEligibility: collected.decisionConstraints
        ? {
            ...collected.decisionConstraints.ledger,
            retiredRules: collected.decisionConstraints.retiredRules,
          }
        : undefined,
      caveats: collected.caveats,
    }, null, 2) + '\n');
  } else {
    const showRatchetReceipt = activeFrozenAssessment || failedGateCodes.length > 0;
    const out = renderHuman(
      result,
      unknown,
      collected.caveats,
      reconciled.baseline,
      baselineDirty,
      showRatchetReceipt,
      collected.decisionConstraints,
    );
    const safeOut = sanitizeForTerminal(out + '\n', { keepNewlines: true });
    if (opts.hook) process.stderr.write(safeOut);
    else await writeStdout(safeOut);
  }

  if (opts.hook && result.gated) {
    process.stderr.write(
      `\n⛔ enforce: commit blocked by the configured enforcement policy.\n` +
      (reconciled.baseline.requiresInitialization?.length
        ? `   Run openlore enforce outside hook mode, review the new baseline, and stage it before committing.\n`
        : configReadError
          ? `   Repair or restore .openlore/config.json so the enforcement policy can be verified.\n`
          : failedGateCodes.length > 0
            ? `   Restore a complete assessment for ${failedGateCodes.join(', ')}; blocking/frozen sources were not treated as clean.\n`
        : trustedBaselineError
          ? `   Restore a readable Git HEAD so the committed frozen baseline can be verified.\n`
        : worktreeStatus.error
          ? `   Restore Git staging visibility and retry; the gate could not compare the index with the working tree.\n`
        : baselineDirty
          ? `   The working tree differs from the staged commit; stage the intended bytes or restore the working tree, then retry.\n`
          : `   Resolve the new finding, or intentionally change its enforcement.policy class to advisory/off.\n`) +
      `\n`,
    );
    return 1;
  }
  return 0;
}

function renderHuman(
  result: ReturnType<typeof classifyFindings>,
  unknown: string[],
  caveats: string[],
  baseline: Awaited<ReturnType<typeof applyEnforcementBaseline>>['baseline'],
  baselineDirty: boolean,
  showRatchetReceipt: boolean,
  decisionConstraints?: Pick<DecisionConstraintState, 'ledger' | 'retiredRules'>,
): string {
  const lines: string[] = ['', '🛡 Enforcement gate' + (result.gated ? ' (BLOCKED)' : ' (advisory)')];
  if (result.classified.length === 0) {
    lines.push('   No governance findings.');
  } else {
    for (const f of result.classified) {
      const label = f.enforcementClass === 'frozen'
        ? f.baselineState === 'new' ? 'frozen:new' : f.baselineState === 'frozen' ? 'frozen' : 'frozen:invalid'
        : f.enforcementClass;
      if (f.remediation) lines.push(`      Action: ${f.remediation}`);
      lines.push(`   ${ICON[f.enforcementClass]} [${label}] ${f.code} (${f.source}): ${f.message}`);
    }
  }
  if (baseline.initialized.length > 0) {
    lines.push(`   Ratchet: initialized ${baseline.initialized.join(', ')} at ${baseline.path}. Review and commit the baseline.`);
  }
  if (showRatchetReceipt || baseline.frozen > 0 || baseline.new > 0 || baseline.removed > 0 || baseline.requiresInitialization?.length) {
    const disposition = baseline.new > 0 ? `blocked on ${baseline.new} new finding(s)` : 'no new findings';
    lines.push(`   Ratchet: ${baseline.frozen} frozen, ${baseline.new} new, ${baseline.removed} retired → ${disposition}.`);
  }
  if (baselineDirty) lines.push('   ⚠ The working tree differs from the staged commit; frozen assessment cannot certify those different bytes.');
  if (unknown.length > 0) {
    lines.push(`   ℹ enforcement.policy names ${unknown.length} unrecognized code(s) — retained, no source emits them yet: ${unknown.join(', ')}`);
  }
  if (decisionConstraints) {
    const { ledger } = decisionConstraints;
    const adoption = ledger.adoption.ratio === null
      ? 'not applicable (0 authoritative)'
      : `${ledger.adoption.constrained}/${ledger.adoption.authoritative} (${(ledger.adoption.ratio * 100).toFixed(1)}%)`;
    const coverage = ledger.coverage.ratio === null
      ? `not applicable (0 eligible)`
      : `${ledger.coverage.constrainedEligible}/${ledger.coverage.eligible} (${(ledger.coverage.ratio * 100).toFixed(1)}%)`;
    lines.push(`   Decision constraint adoption: ${adoption}.`);
    lines.push(`   Decision constraint coverage: ${coverage}.`);
    lines.push(`   Decision eligibility unclassified: ${ledger.unclassifiedCount}.`);
    lines.push(`   Active decision rules: ${ledger.activeRuleCount}.`);
    if (ledger.coverageGaps.length > 0) {
      lines.push(`   Coverage gaps: ${ledger.coverageGaps.map((gap) => `${gap.decisionId} ${gap.title}`).join('; ')}.`);
    }
    if (decisionConstraints.retiredRules.length > 0) {
      lines.push(`   Retired decision rules: ${decisionConstraints.retiredRules.length}.`);
    }
  }
  for (const c of caveats) lines.push(`   ⚠ ${c}`);
  lines.push('');
  return lines.join('\n');
}

/** Concise Claude Code Stop-hook rendering: action first, one finding per line. */
export function renderAgentHook(
  result: ReturnType<typeof classifyFindings>,
  caveats: readonly string[],
  infrastructureUnavailable = false,
): string {
  const lines = ['OpenLore agent enforcement:'];
  for (const finding of result.classified) {
    const label = finding.enforcementClass === 'frozen' ? 'frozen:advisory' : finding.enforcementClass;
    const conclusion = `${finding.code}: ${finding.message}`;
    lines.push(`- [${label}] ${finding.remediation ? `${finding.remediation} — ${conclusion}` : conclusion}`);
  }
  if (result.classified.length === 0) lines.push('- No governance findings.');
  for (const caveat of caveats) lines.push(`- Caveat: ${caveat}`);
  if (infrastructureUnavailable) lines.push('- Caveat: enforcement was incomplete; the agent turn was not blocked.');
  return lines.join('\n');
}

export const enforceCommand = new Command('enforce')
  .description('Unified finding-enforcement gate: each source declares its default; frozen adopts existing debt and blocks only new findings.')
  .option('--base <ref>', 'Git ref to diff the working tree against for diff-based sources (default HEAD)')
  .option('--json', 'Emit the gate result as JSON', false)
  .option('--hook', 'Hook mode: exit 1 on blocking/new frozen findings, invalid config, incomplete frozen assessment, or unverifiable staged bytes', false)
  .option('--agent-hook', 'Agent-loop hook mode: exit 2 only on blocking findings; infrastructure failures exit 0', false)
  .option('--install-hook', 'Install the unified enforcement pre-commit hook', false)
  .option('--uninstall-hook', 'Remove the unified enforcement pre-commit hook', false)
  .action(async (opts: { base?: string; json?: boolean; hook?: boolean; agentHook?: boolean; installHook?: boolean; uninstallHook?: boolean }) => {
    const code = await runEnforceCli({
      base: opts.base, json: opts.json, hook: opts.hook, agentHook: opts.agentHook,
      installHook: opts.installHook, uninstallHook: opts.uninstallHook,
    });
    process.exit(code);
  });
