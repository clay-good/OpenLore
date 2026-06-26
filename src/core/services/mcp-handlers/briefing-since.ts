/**
 * Change significance briefing (change: add-change-significance-briefing) —
 * "a lot changed since I last looked; what actually matters?"
 *
 * Every other change-oriented tool OpenLore has is about YOUR OWN pending diff
 * (`blast_radius`, `change_impact_certificate`). This one answers the reviewer /
 * catch-up / onboarding question instead: given a base ref, what changed since it
 * and which of those changes is structurally load-bearing — ranked by labels the
 * analyzer already produces, never by a hidden weighted score.
 *
 * The pipeline is pure reuse:
 *   1. `getChangedFiles` (drift/git-diff) → the files changed since the base ref.
 *   2. `seedsFromFiles` (test-impact) → the changed production symbols (file-level
 *      granularity, the same primitive `select_tests`/`report_coverage_gaps` use).
 *   3. `computeLandmarkSignals` → each symbol's hub/orchestrator/chokepoint labels.
 *   4. `analyzeChangeCoupling` → per-file churn + how much history exists.
 *   5. `labelChangeSignificance` (analyzer/change-significance) → one tier per symbol.
 *   6. `handleSelectTests` → the tests to run for the whole change set.
 *
 * Honest by construction: file-level granularity is disclosed; the surprising-change
 * label is withheld when history is too shallow; truncation always carries a receipt
 * (omitted count + lowest tier reached) and never drops a higher tier for a lower
 * one. The cursor is the base ref, never wall-clock time.
 */

import { validateDirectory, readCachedContext } from './utils.js';
import { seedsFromFiles, handleSelectTests } from './test-impact.js';
import { isCodeNode, isExcludedPath } from './code-node.js';
import { computeLandmarkSignals } from '../../analyzer/landmark-signals.js';
import { analyzeChangeCoupling } from '../../provenance/change-coupling.js';
import { refExists } from '../../drift/git-diff.js';
import { assembleBoundary, computeStaleness } from './confidence-boundary.js';
import {
  labelChangeSignificance,
  tierCounts,
  TIERS_BY_RANK,
  type ChangedSymbolFacts,
  type LabeledChange,
  type SignificanceTier,
} from '../../analyzer/change-significance.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';

export interface BriefingSinceInput {
  directory: string;
  /**
   * The cursor: a git ref to brief changes SINCE (the last-reviewed commit, a PR
   * base, "where I was when I left"). Default "auto" → resolve main → master →
   * HEAD~1 → empty tree. Never wall-clock time.
   */
  baseRef?: string;
  /** Region scope — only brief changes whose file path contains this substring. */
  filePattern?: string;
  /** Bound on briefed symbols, highest-tier-first (default 50, capped 200). */
  maxResults?: number;
}

const MAX_RESULTS_DEFAULT = 50;
const MAX_RESULTS_CAP = 200;
/** Cap on the test-file list echoed in the briefing (the full count is always reported). */
const MAX_TEST_FILES = 50;
/** Cap on changed-file paths echoed (the full count is always reported). */
const MAX_CHANGED_FILES = 50;

/** Normalize a path for tolerant churn lookup (git and node paths are repo-relative). */
function normPath(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * Produce a ranked, labeled catch-up briefing of what changed since a base ref.
 * Read-only, deterministic, offline. Returns `unknown` (additive-by-cast),
 * conclusion-shaped (a ranked tier list + receipts), never a diff or a graph.
 */
export async function handleBriefingSince(input: BriefingSinceInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const maxResults = Math.max(1, Math.min(input.maxResults ?? MAX_RESULTS_DEFAULT, MAX_RESULTS_CAP));
  const baseRefInput = input.baseRef && input.baseRef.length > 0 ? input.baseRef : 'auto';

  // ── 1. Changed files since the base ref ─────────────────────────────────────
  let resolvedBase: string;
  let changedFiles: string[];
  try {
    const { getChangedFiles } = await import('../../drift/git-diff.js');
    const diff = await getChangedFiles({ rootPath: absDir, baseRef: baseRefInput, includeUnstaged: true });
    resolvedBase = diff.resolvedBase;
    // Production code files only — tests/config/generated are not "changes that matter"
    // to rank; they still drive the tests-to-run selection below.
    changedFiles = diff.files.filter(f => !f.isTest).map(f => f.path);
  } catch (err) {
    return { error: `git diff failed (base ${baseRefInput}): ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── Honesty: detect a SILENT base-ref fallback ──────────────────────────────
  // `resolveBaseRef` (inside getChangedFiles) returns an explicit ref verbatim when
  // it verifies, and SILENTLY substitutes main → master → HEAD~1 → empty-tree when it
  // does not — so `resolvedBase !== baseRefInput` is exactly "a fallback happened".
  // We additionally confirm the requested ref is genuinely unresolvable, so a valid
  // base that simply isn't a commit (e.g. the empty-tree SHA, which resolves to
  // itself) is never mis-flagged. Briefing against a base the caller never asked for
  // (a typo'd `--base`) would make every number below authoritative-looking but wrong.
  const requestedRefUnresolved =
    baseRefInput !== 'auto' && resolvedBase !== baseRefInput && !(await refExists(absDir, baseRefInput));

  // ── 2. Changed production symbols (file-level granularity) ──────────────────
  // A region scope (filePattern) narrows BOTH the briefed symbols and the file
  // count/sample, so the reported denominators match the scoped briefing.
  const scope: 'repo' | 'region' = input.filePattern ? 'region' : 'repo';
  const scopedFiles = input.filePattern
    ? changedFiles.filter(f => f.includes(input.filePattern!))
    : changedFiles;
  // Scope to hand-authored SOURCE CODE only — the same candidate set the significance-
  // ranking sibling `report_coverage_gaps` uses (`code-node.ts`). The tiers (call-graph
  // hub/orchestrator/chokepoint) and the tests-to-run are code concepts, so infrastructure
  // (IaC) resources and generated/vendored shims do not belong in this ranking; infra
  // change-impact has its own lens (`blast_radius` / `analyze_impact`). `seedsFromFiles`
  // already drops external + test nodes.
  let changedSymbols = seedsFromFiles(cg, scopedFiles)
    .filter(n => isCodeNode(n) && !isExcludedPath(n.filePath));
  if (input.filePattern) {
    changedSymbols = changedSymbols.filter(n => n.filePath.includes(input.filePattern!));
  }

  // ── 3. Structural labels (reused classifier, no new score) ──────────────────
  const landmarks = computeLandmarkSignals(cg);
  const labelsById = new Map(landmarks.map(l => [l.id, new Set(l.signals.map(s => s.label))]));

  // ── 4. Churn + history depth (reused change-coupling miner) ─────────────────
  const coupling = await analyzeChangeCoupling(absDir);
  const churnByPath = new Map<string, number>();
  for (const [file, n] of coupling.churn) churnByPath.set(normPath(file), n);
  // "Rarely changed before" needs a non-degenerate history: a single (or zero)
  // commit has no "before" to be rare within, so the surprise label is withheld.
  const historyAvailable = coupling.stats.commitsScanned >= 2;

  const facts: ChangedSymbolFacts[] = changedSymbols.map(n => {
    const labels = labelsById.get(n.id) ?? new Set<string>();
    return {
      id: n.id,
      name: n.name,
      filePath: n.filePath,
      fanIn: n.fanIn ?? 0,
      fanOut: n.fanOut ?? 0,
      isHub: labels.has('hub'),
      isOrchestrator: labels.has('orchestrator'),
      isChokepoint: labels.has('chokepoint'),
      churn: churnByPath.get(normPath(n.filePath)) ?? 0,
      ...(n.communityLabel ? { community: n.communityLabel } : {}),
    };
  });

  // ── 5. Label + rank (pure analyzer function) ────────────────────────────────
  const labeled = labelChangeSignificance(facts, { historyAvailable });
  const counts = tierCounts(labeled);

  // ── 6. Bounded briefing + truncation receipt (no silent cap) ────────────────
  // labeled is already sorted highest-tier-first, so slicing drops only the lowest
  // tiers — a surprising-change is never dropped in favor of an ordinary-change.
  const returned = labeled.slice(0, maxResults);
  const omittedItems = labeled.slice(maxResults);
  const truncation = buildTruncationReceipt(returned, omittedItems);

  // ── Region rollup over the returned set ─────────────────────────────────────
  const regionMap = new Map<string, number>();
  for (const c of returned) {
    const key = c.community ?? '(no community)';
    regionMap.set(key, (regionMap.get(key) ?? 0) + 1);
  }
  const regions = [...regionMap.entries()]
    .map(([community, count]) => ({ community, count }))
    .sort((a, b) => b.count - a.count || a.community.localeCompare(b.community));

  // ── Tests to run for the whole change set (reused select_tests) ─────────────
  const testsToRun = await selectTestsSummary(absDir, resolvedBase);

  // ── Honesty: a base ref that matched no production symbol is "nothing changed",
  // never the reassuring "nothing significant changed". ───────────────────────
  let note: string | undefined;
  if (changedSymbols.length === 0) {
    if (scope === 'region') {
      // A region scope that emptied the set is "nothing matched the filter", NOT
      // "nothing changed" — production code may well have changed elsewhere. Saying
      // "nothing changed" here would be a false all-clear.
      note = scopedFiles.length === 0
        ? `No changed file matched filePattern "${input.filePattern}" (production code may have changed elsewhere) — "nothing matched", NOT "nothing changed".`
        : `No changed production symbol matched filePattern "${input.filePattern}" — "nothing matched", NOT "nothing significant".`;
    } else {
      note = changedFiles.length === 0
        ? `No production code changed since ${resolvedBase} (the diff touched only tests/config/non-code files) — "nothing changed", NOT "nothing significant".`
        : 'The changed file(s) contain no analyzed production symbol (not yet analyzed, or only tests/generated) — "nothing matched", NOT "nothing significant".';
    }
  }

  const caveats: string[] = [
    'Changed symbols are at FILE granularity: every production function in a file changed since the base ref is briefed, even if that specific function was not edited.',
    'Significance is a tier label from existing classifiers (hub/orchestrator/chokepoint) plus raw evidence — not a weighted score. The caller makes the final judgment.',
    'Scope is hand-authored source code: infrastructure (IaC) resources and generated/vendored files are excluded (their change-impact has its own lens — blast_radius / analyze_impact). Non-code changed files still count toward changedFiles.',
  ];
  // The unresolved-ref disclosure leads the caveats — it changes which base every
  // number below was computed against, so it must not be buried.
  if (requestedRefUnresolved) {
    caveats.unshift(`Requested base ref "${baseRefInput}" could not be resolved; briefed against "${resolvedBase}" instead (git's silent fallback). Pass a ref that exists to target the base you meant.`);
  }
  if (!historyAvailable) {
    caveats.push(`Git history is too shallow (${coupling.stats.commitsScanned} commit(s) scanned) to establish "rarely changed before" — the surprising-change label is withheld and those hubs rank as hub-change.`);
  }
  // Surprise rests on per-file churn matched by exact path. git history does not
  // follow renames, so a just-renamed (or non-ASCII-path) hub can read low churn and
  // be over-flagged surprising-change. Only disclose when the signal is actually live.
  if (counts['surprising-change'] > 0) {
    caveats.push('The surprising-change signal uses per-file churn matched by exact path; git history does not follow renames, so a just-renamed file may read as low-churn and be over-flagged surprising. Confirm against its rename history.');
  }

  const staleness = await computeStaleness(absDir);
  const confidenceBoundary = assembleBoundary({ staleness, integrity: ctx?.integrity });

  return {
    baseRef: resolvedBase,
    ...(requestedRefUnresolved ? { baseRefFallback: { requested: baseRefInput, resolved: resolvedBase } } : {}),
    scope,
    ...(input.filePattern ? { filePattern: input.filePattern } : {}),
    changedFiles: scopedFiles.length,
    ...(scopedFiles.length > 0
      ? { changedFilesSample: [...scopedFiles].sort().slice(0, MAX_CHANGED_FILES) }
      : {}),
    changedSymbols: changedSymbols.length,
    tierCounts: counts,
    briefing: returned,
    truncation,
    regions,
    testsToRun,
    surprisingChange: {
      available: historyAvailable,
      ...(historyAvailable ? {} : { reason: `only ${coupling.stats.commitsScanned} commit(s) of history — no "before" to be rare within` }),
      historyCommitsScanned: coupling.stats.commitsScanned,
    },
    ...(note ? { note } : {}),
    caveats,
    confidenceBoundary,
  };
}

interface TruncationReceipt {
  bounded: boolean;
  returned: number;
  omitted: number;
  /** Lowest tier present in the RETURNED set (how deep the briefing reached). */
  lowestTierReached: SignificanceTier | null;
  /** Per-tier count of what was dropped (only ever lower tiers). */
  omittedByTier?: Record<string, number>;
}

function buildTruncationReceipt(returned: LabeledChange[], omitted: LabeledChange[]): TruncationReceipt {
  const lowestTierReached = returned.length
    ? [...returned].reduce<SignificanceTier>((lo, c) =>
        TIERS_BY_RANK.indexOf(c.tier) > TIERS_BY_RANK.indexOf(lo) ? c.tier : lo, returned[0].tier)
    : null;
  if (omitted.length === 0) {
    return { bounded: false, returned: returned.length, omitted: 0, lowestTierReached };
  }
  const omittedByTier: Record<string, number> = {};
  for (const c of omitted) omittedByTier[c.tier] = (omittedByTier[c.tier] ?? 0) + 1;
  return { bounded: true, returned: returned.length, omitted: omitted.length, lowestTierReached, omittedByTier };
}

/** Compact tests-to-run summary via the existing select_tests path. */
async function selectTestsSummary(
  absDir: string,
  baseRef: string,
): Promise<{ count: number; files: string[]; note?: string }> {
  try {
    const result = (await handleSelectTests({ directory: absDir, diffRef: baseRef })) as {
      selectedTests?: Array<{ file: string }>;
      error?: string;
    };
    if (result.error) return { count: 0, files: [], note: `test selection unavailable: ${result.error}` };
    const tests = result.selectedTests ?? [];
    const files = [...new Set(tests.map(t => t.file))].sort();
    return {
      count: tests.length,
      files: files.slice(0, MAX_TEST_FILES),
      ...(files.length > MAX_TEST_FILES ? { note: `${files.length} test files reach the change set; showing the first ${MAX_TEST_FILES}.` } : {}),
    };
  } catch (err) {
    return { count: 0, files: [], note: `test selection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
