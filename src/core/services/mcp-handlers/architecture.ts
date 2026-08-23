/**
 * `check_architecture` MCP handler (spec-23).
 *
 * Two read-only modes over the opt-in architecture rules:
 *   - pre-edit ({ directory, from, to }): "may a file under `from` import `to`?" —
 *     a deterministic verdict + the governing rule + why, BEFORE the edit is made.
 *   - scan ({ directory }): the full current-violations report.
 *
 * Fully inert when no rules are declared. Offline and deterministic.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_DEPENDENCY_GRAPH,
} from '../../../constants.js';
import { validateDirectory } from './utils.js';
import { loadArchitectureRules } from '../../architecture/rules.js';
import type { ArchitectureRule } from '../../architecture/rules.js';
import { scanViolations, canImport } from '../../architecture/check.js';
import type { DependencyGraphResult } from '../../analyzer/dependency-graph.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { assessStalenessForAnalysis } from './confidence-boundary.js';
import type { DecisionConstraintState } from '../../decisions/constraint-ledger.js';

const VIOLATION_REPORT_CAP = 200;

export async function loadDepGraph(absDir: string): Promise<DependencyGraphResult | null> {
  try {
    const raw = await readFile(
      join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH),
      'utf-8',
    );
    return JSON.parse(raw) as DependencyGraphResult;
  } catch {
    return null;
  }
}

/** One-line human summary of a rule, for the report. */
function describeRule(rule: ArchitectureRule): string {
  switch (rule.kind) {
    case 'layers':
      return `layers (${rule.source}): ${Object.keys(rule.layers).join(' → ')}`;
    case 'forbidden':
      return `forbidden (${rule.source}): ${rule.from} ⇏ ${rule.to}${rule.reason ? ` — ${rule.reason}` : ''}`;
    case 'allowedOnly':
      return `allowedOnly (${rule.source}): ${rule.module} → [${rule.mayDependOn.join(', ')}]${rule.reason ? ` — ${rule.reason}` : ''}`;
  }
}

const INERT_NOTE =
  'No architecture rules declared. This guardrail is opt-in and inert: add a ' +
  '.openlore/architecture.json (layers / forbidden / allowedOnly) or an "Invariant:" ' +
  'marker in a synced ADR to enable it.';

const ACTIVE_NOTE =
  'Deterministic, advisory architecture guardrail. Rules are author-declared ' +
  '(.openlore/architecture.json + synced ADR "Invariant:" markers), never LLM-inferred. ' +
  'It complements, not replaces, CI linters.';

export interface CheckArchitectureArgs {
  directory: string;
  /** Pre-edit mode: the file that would gain the import (relative or absolute). */
  from?: string;
  /** Pre-edit mode: the target file path or exported symbol being imported. */
  to?: string;
}

export async function handleCheckArchitecture(args: CheckArchitectureArgs): Promise<unknown> {
  const absDir = await validateDirectory(args.directory);
  const config = await readOpenLoreConfig(absDir);
  const openspecPath = config?.openspecPath ?? 'openspec';
  const rules = await loadArchitectureRules(absDir, { openspecPath });
  const { loadDecisionConstraintState } = await import('../../decisions/constraint-ledger.js');
  let decisionConstraints: DecisionConstraintState | undefined;
  let decisionConstraintError: string | undefined;
  try {
    decisionConstraints = await loadDecisionConstraintState(absDir, openspecPath);
  } catch (error) {
    decisionConstraintError = error instanceof Error ? error.message : String(error);
  }
  const depGraph = await loadDepGraph(absDir);
  const graphFreshness = depGraph && rules.rules.length > 0
    ? await assessStalenessForAnalysis(
        absDir,
        join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR),
        Date.now(),
        false,
      )
    : undefined;
  const graphAssessmentComplete = rules.rules.length === 0
    || (Boolean(depGraph)
      && Boolean(graphFreshness?.indexCommit)
      && graphFreshness?.changedSourceFiles === 0);

  const preEdit = typeof args.from === 'string' && typeof args.to === 'string';

  // ---- Pre-edit verdict mode ----
  if (preEdit) {
    if (decisionConstraintError) {
      return {
        mode: 'pre-edit', rulesDeclared: rules.rules.length > 0, allowed: null,
        reason: 'decision constraint corpus is unavailable, so an allow verdict cannot be certified',
        assessmentComplete: false,
        decisionConstraintAssessment: { complete: false, caveat: decisionConstraintError },
      };
    }
    if (decisionConstraints && !decisionConstraints.violationAssessmentComplete) {
      return {
        mode: 'pre-edit',
        rulesDeclared: decisionConstraints.ledger.activeRuleCount > 0,
        allowed: null,
        reason: 'decision constraint assessment incomplete — repair the malformed authoritative policy before relying on an allow verdict',
        assessmentComplete: false,
        decisionEligibility: decisionConstraints.ledger,
        retiredDecisionRules: decisionConstraints.retiredRules,
        malformedDecisionConstraints: decisionConstraints.malformedFindings,
      };
    }
    if (rules.rules.length === 0) {
      return {
        mode: 'pre-edit',
        rulesDeclared: false,
        allowed: true,
        reason: 'no architecture rules declared — inert',
        note: INERT_NOTE,
        decisionEligibility: decisionConstraints?.ledger,
        retiredDecisionRules: decisionConstraints?.retiredRules,
        malformedDecisionConstraints: decisionConstraints?.malformedFindings,
        decisionConstraintAssessment: decisionConstraintError
          ? { complete: false, caveat: decisionConstraintError }
          : { complete: true },
      };
    }
    const verdict = canImport(args.from!, args.to!, rules, depGraph ?? undefined);
    return {
      mode: 'pre-edit',
      rulesDeclared: true,
      from: args.from,
      to: args.to,
      allowed: verdict.allowed ? (graphAssessmentComplete ? true : null) : false,
      rule: verdict.rule,
      resolvedTo: verdict.resolvedTo,
      reason: verdict.reason,
      warnings: rules.warnings.length ? rules.warnings : undefined,
      note: ACTIVE_NOTE,
      decisionEligibility: decisionConstraints?.ledger,
      retiredDecisionRules: decisionConstraints?.retiredRules,
      malformedDecisionConstraints: decisionConstraints?.malformedFindings,
      decisionConstraintAssessment: decisionConstraintError
        ? { complete: false, caveat: decisionConstraintError }
        : { complete: true },
      assessmentComplete: graphAssessmentComplete,
      graphFreshness: graphFreshness ? {
        indexCommit: graphFreshness.indexCommit,
        changedSourceFiles: graphFreshness.changedSourceFiles,
        complete: graphAssessmentComplete,
      } : undefined,
    };
  }

  // ---- Full scan mode ----
  if (decisionConstraintError && rules.rules.length === 0) {
    return {
      mode: 'scan', rulesDeclared: false, assessmentComplete: false,
      violationCount: null, violations: [],
      reason: 'decision constraint corpus is unavailable, so a clean scan cannot be certified',
      decisionConstraintAssessment: { complete: false, caveat: decisionConstraintError },
    };
  }
  if (decisionConstraints && !decisionConstraints.violationAssessmentComplete) {
    return {
      mode: 'scan',
      rulesDeclared: decisionConstraints.ledger.activeRuleCount > 0,
      assessmentComplete: false,
      violationCount: null,
      violations: [],
      reason: 'decision constraint assessment incomplete — malformed authoritative policy prevents a clean scan',
      decisionEligibility: decisionConstraints.ledger,
      retiredDecisionRules: decisionConstraints.retiredRules,
      malformedDecisionConstraints: decisionConstraints.malformedFindings,
    };
  }
  if (rules.rules.length === 0) {
    return {
      mode: 'scan',
      rulesDeclared: false,
      violationCount: 0,
      violations: [],
      note: INERT_NOTE,
      decisionEligibility: decisionConstraints?.ledger,
      retiredDecisionRules: decisionConstraints?.retiredRules,
      malformedDecisionConstraints: decisionConstraints?.malformedFindings,
      decisionConstraintAssessment: decisionConstraintError
        ? { complete: false, caveat: decisionConstraintError }
        : { complete: true },
    };
  }

  if (!depGraph) {
    return {
      error: 'No analysis found. Run analyze_codebase first.',
      decisionEligibility: decisionConstraints?.ledger,
      retiredDecisionRules: decisionConstraints?.retiredRules,
      malformedDecisionConstraints: decisionConstraints?.malformedFindings,
      decisionConstraintAssessment: decisionConstraintError
        ? { complete: false, caveat: decisionConstraintError }
        : { complete: true },
    };
  }

  const scan = scanViolations(depGraph, rules);
  const capped = scan.violations.slice(0, VIOLATION_REPORT_CAP);
  const assessmentComplete = !decisionConstraintError && graphAssessmentComplete;
  return {
    mode: 'scan',
    rulesDeclared: true,
    rulesApplied: scan.rulesApplied,
    ruleSummary: rules.rules.map(describeRule),
    violationCount: scan.violations.length,
    violations: capped,
    truncated: scan.violations.length > capped.length
      ? `showing first ${capped.length} of ${scan.violations.length}`
      : undefined,
    checkedEdges: scan.checkedEdges,
    assessmentComplete,
    graphFreshness: graphFreshness ? {
      indexCommit: graphFreshness.indexCommit,
      changedSourceFiles: graphFreshness.changedSourceFiles,
      complete: assessmentComplete,
    } : undefined,
    warnings: scan.warnings.length ? scan.warnings : undefined,
    decisionEligibility: decisionConstraints?.ledger,
    retiredDecisionRules: decisionConstraints?.retiredRules,
    malformedDecisionConstraints: decisionConstraints?.malformedFindings,
    note: ACTIVE_NOTE,
  };
}
