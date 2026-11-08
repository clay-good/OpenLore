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
 *   2. `seedsFromFiles` + `narrowToChangedSymbols` (test-impact) → the production symbols that
 *      changed: exact where both revisions hash cleanly, file-level (disclosed) where they do not
 *      (change: add-symbol-content-hashes).
 *   3. `computeLandmarkSignals` → each symbol's hub/orchestrator/chokepoint labels.
 *   4. `analyzeChangeCoupling` → per-file churn + how much history exists.
 *   5. `labelChangeSignificance` (analyzer/change-significance) → one tier per symbol.
 *   6. `handleSelectTests` → the tests to run for the whole change set.
 *
 * Honest by construction: any file-level fallback is disclosed with its reason; truncation always
 * carries a receipt (omitted count + lowest tier reached) and never drops a higher tier for a lower
 * one. The cursor is the base ref, never wall-clock time.
 *
 * WITHHOLDING A LABEL WHOSE PREMISE DOES NOT HOLD (change: fix-briefing-since-ranking-and-cost).
 * `surprising-change` asserts "a hub whose file RARELY CHANGED BEFORE". Two cases make that premise
 * vacuous rather than true, and in both the label is withheld (the symbol still ranks, one tier
 * lower, with the withholding stated per entry and counted in `withholding`):
 *   1. Repo-wide: fewer than two commits of pre-base history — no "before" at all (pre-existing).
 *   2. PER FILE: the file is ADDED (or renamed into its path) in the briefed range and has no
 *      pre-base churn at that path. It did not exist before, so "rarely changed before" is not a
 *      fact about it — a brand-new file's zero churn must not be read as decades of stability.
 * And `surprising-change` / `hub-change` / `chokepoint-change` all assert the symbol is a
 * repository hub. A function lexically NESTED inside another function, every one of whose callers
 * lies inside that enclosing function, is a function-local helper: its fan-in is internal to one
 * body, so the hub-derived tiers are withheld and the significance belongs to the enclosing symbol
 * (which is briefed on its own merits). This keeps a one-line local arrow in a new parser out of
 * the headline without dropping it from the briefing.
 */

import { validateDirectory, readCachedContext, diagnoseIndexUnservable } from './utils.js';
import { seedsFromFiles, handleSelectTests, narrowToChangedSymbols } from './test-impact.js';
import {
  carriedCaveat,
  changedSymbolIds,
  granularityCaveat,
  importsAddedCaveat,
  noChangeClaim,
  type CarriedSymbol,
  type DiffEntry,
  type SymbolChangedSet,
} from '../symbol-changed-set.js';
import { isCodeNode, isExcludedPath } from './code-node.js';
import { computeLandmarkSignals } from '../../analyzer/landmark-signals.js';
import { analyzeChangeCoupling } from '../../provenance/change-coupling.js';
import { assembleBoundary, computeStaleness } from './confidence-boundary.js';
import {
  labelChangeSignificance,
  tierCounts,
  TIER_RANK,
  TIERS_BY_RANK,
  type ChangedSymbolFacts,
  type LabeledChange,
  type SignificanceTier,
} from '../../analyzer/change-significance.js';
import type { FunctionNode, SerializedCallGraph } from '../../analyzer/call-graph.js';

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
  if (!ctx) return await diagnoseIndexUnservable(absDir);
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const maxResults = Math.max(1, Math.min(input.maxResults ?? MAX_RESULTS_DEFAULT, MAX_RESULTS_CAP));
  const baseRefInput = input.baseRef && input.baseRef.length > 0 ? input.baseRef : 'auto';

  // ── 1. Changed files since the base ref ─────────────────────────────────────
  // Resolve-or-disclose through the one shared helper (fix-cli-conclusion-honesty):
  // it returns the ref git actually diffs against (post main → master → HEAD~1
  // fallback) AND whether the caller's explicit ref was genuinely unresolvable — so a
  // typo'd `--base` is disclosed rather than silently briefing against a base the
  // caller never asked for. The `auto` default explicitly requests the fallback chain.
  let resolvedBase: string;
  let requestedRefUnresolved: boolean;
  let changedFiles: string[];
  let diffEntries: DiffEntry[];
  /** The analyzed root's path inside the work tree, for re-framing diff paths (`''` at the root). */
  let repoPrefix = '';
  /** Bound once the git-diff module is loaded below; the region filter needs it afterwards. */
  let reframeRepoPath: (repoRelPath: string, prefix: string) => string | null = p => p;
  try {
    const { getChangedFiles, resolveBaseRefDisclosed, getRepoPrefix, reframeRepoPath: reframe } = await import('../../drift/git-diff.js');
    reframeRepoPath = reframe;
    const base = await resolveBaseRefDisclosed(absDir, baseRefInput);
    resolvedBase = base.resolved;
    requestedRefUnresolved = base.fellBack;
    const diff = await getChangedFiles({ rootPath: absDir, baseRef: resolvedBase, includeUnstaged: true });
    diffEntries = diff.files;
    // Below the repository root, git returns repo-root-relative paths while the call
    // graph is analyzed-root-relative; re-frame so the changed-symbol join is correct
    // (no-op at the root). Files outside the analyzed subtree are dropped.
    const prefix = (await getRepoPrefix(absDir)) ?? '';
    repoPrefix = prefix;
    // Production code files only — tests/config/generated are not "changes that matter"
    // to rank; they still drive the tests-to-run selection below.
    changedFiles = diff.files
      .filter(f => !f.isTest)
      .map(f => reframeRepoPath(f.path, prefix))
      .filter((p): p is string => p !== null);
  } catch (err) {
    return { error: `git diff failed (base ${baseRefInput}): ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── 2. Changed production symbols ───────────────────────────────────────────
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
  let fileSymbols = seedsFromFiles(cg, scopedFiles)
    .filter(n => isCodeNode(n) && !isExcludedPath(n.filePath));
  if (input.filePattern) {
    fileSymbols = fileSymbols.filter(n => n.filePath.includes(input.filePattern!));
  }
  // Brief only the symbols that changed (change: add-symbol-content-hashes). A symbol kept by the
  // changed-set only because it references a changed one, or holds a dynamic-dispatch site, did not
  // change and is not briefed. A rename or move IS briefed — its id and every caller changed, and a
  // renamed hub is exactly what a returning reader must see — and the pair is named under `carried`.
  // A region scope narrows the receipt too: telling a reader scoped to `src/cli/` about fallbacks in
  // files they cannot see breaks the same denominators-match-the-briefing rule as the counts above.
  // Match the pattern in the briefing's own frame: diff paths are repository-relative, while the
  // pattern and the briefed symbols are analyzed-root relative, and below the repository root the
  // two differ (the same trap the size probe hit).
  const scopedEntries = input.filePattern
    ? diffEntries.filter(entry => (reframeRepoPath(entry.path, repoPrefix) ?? entry.path).includes(input.filePattern!))
    : diffEntries;
  const narrowed = await narrowToChangedSymbols(absDir, resolvedBase, scopedEntries, cg, fileSymbols);
  const carried: CarriedSymbol[] = narrowed.set?.carried ?? [];
  const changedSymbols = fileSymbols.filter(n => {
    const change = narrowed.set?.byFile.get(n.filePath);
    if (!change || change.granularity === 'file') return true;
    return changedSymbolIds(change).has(n.id);
  });
  const changeGranularity = narrowed.receipt;

  // ── 3. Structural labels (reused classifier, no new score) ──────────────────
  const landmarks = computeLandmarkSignals(cg);
  const labelsById = new Map(landmarks.map(l => [l.id, new Set(l.signals.map(s => s.label))]));

  // ── 4. Churn + history depth (reused change-coupling miner) ─────────────────
  // Mine churn strictly BEFORE the briefed range: passing the resolved base as the
  // start ref logs from that commit and its ancestors, so commits INSIDE base..HEAD
  // (the very change being briefed) never inflate `priorChurn`. Otherwise a dormant
  // hub hammered within the briefed range reads medium/high volatility and has its own
  // `surprising-change` tier withheld — the tier demoting itself as significance rises.
  // `includeCoupling: false`: this briefing reads ONLY `coupling.churn` and
  // `coupling.stats.commitsScanned`. The co-occurrence map is the one quadratic part of the
  // miner (O(files²) per commit) and was computed and thrown away on every call; opting out
  // skips it. `get_change_coupling` and the analyze-time snapshot still request it.
  const coupling = await analyzeChangeCoupling(absDir, { startRef: resolvedBase, includeCoupling: false });
  const churnByPath = new Map<string, number>();
  for (const [file, n] of coupling.churn) churnByPath.set(normPath(file), n);
  // "Rarely changed before" needs a non-degenerate history: a single (or zero)
  // commit BEFORE the range has no "before" to be rare within, so the surprise label
  // is withheld. commitsScanned now counts only the pre-base window (see startRef).
  const historyAvailable = coupling.stats.commitsScanned >= 2;

  // ── 4b. Per-file "did this file exist before?" gate ─────────────────────────
  // `churnByPath.get(...) ?? 0` alone cannot tell "absent from pre-base history" from
  // "existed and was never touched" — the first makes the surprise premise VACUOUS, the
  // second makes it TRUE. git's own status tells them apart: a file ADDED (or renamed into
  // its path) in the briefed range did not exist at the base. A re-added path that DOES
  // carry pre-base churn keeps the label — its "before" is real.
  const newPaths = new Set<string>();
  for (const entry of scopedEntries) {
    if (entry.status !== 'added' && entry.status !== 'renamed') continue;
    const local = normPath(reframeRepoPath(entry.path, repoPrefix) ?? entry.path);
    if (!churnByPath.has(local)) newPaths.add(local);
  }

  // ── 4c. Function-local helpers (not repository hubs) ────────────────────────
  // Only hub-labelled symbols can earn a hub-derived tier, so only they are probed.
  const hubCandidates = changedSymbols.filter(n => (labelsById.get(n.id) ?? new Set()).has('hub'));
  const localHelpers = findFunctionLocalHelpers(cg, hubCandidates);

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
  // The labeler is a pure function of its facts plus one `historyAvailable` flag, so the
  // per-file gate is applied by labeling the two buckets separately: symbols whose file has
  // a real "before" with the repo-wide verdict, symbols in a brand-new file with the surprise
  // withheld. No new tier, no new threshold — the same withholding the shallow-history case
  // already uses, narrowed to the file it is a fact about.
  const eligible = facts.filter(f => !newPaths.has(normPath(f.filePath)));
  const newFileFacts = facts.filter(f => newPaths.has(normPath(f.filePath)));
  // The counterfactual: what the new-file symbols WOULD have been tiered without the gate.
  // Only a symbol that would genuinely have earned `surprising-change` has a label withheld
  // — a leaf that was never in the running is not told a label was taken from it.
  const counterfactual = new Map(
    labelChangeSignificance(newFileFacts, { historyAvailable }).map(c => [c.id, c.tier]),
  );
  const labeled: BriefedChange[] = [
    ...labelChangeSignificance(eligible, { historyAvailable }),
    ...labelChangeSignificance(newFileFacts, { historyAvailable: false }),
  ].map(c => {
    const withheld: WithheldLabel[] = [];
    let tier = c.tier;
    if (counterfactual.get(c.id) === 'surprising-change' && tier !== 'surprising-change') {
      withheld.push({
        label: 'surprising-change',
        reason: `${c.file} is added (or renamed into this path) since ${resolvedBase} and has no pre-base history at this path — "rarely changed before" is not a fact about it, so its zero prior churn cannot earn the surprise label. Ranked ${tier} on its structural labels alone.`,
      });
    }
    const enclosing = localHelpers.get(c.id);
    if (enclosing && TIER_RANK[tier] > TIER_RANK['ordinary-change']) {
      withheld.push({
        label: tier,
        reason: `${c.name} is lexically nested inside ${enclosing} and every one of its callers lies inside that function — a function-local helper, not a repository hub. Its hub-derived tier is withheld; the significance belongs to the enclosing symbol. Its graph labels and fan-in are kept below as evidence.`,
      });
      tier = 'ordinary-change';
    }
    return { ...c, tier, ...(withheld.length > 0 ? { withheld } : {}) };
  });
  // One re-sort after the overrides, with the labeler's own comparator (tier desc, fan-in
  // desc, then file+name) so the ranking stays byte-stable for a fixed input.
  labeled.sort((a, b) =>
    TIER_RANK[b.tier] - TIER_RANK[a.tier]
    || b.evidence.fanIn - a.evidence.fanIn
    || a.file.localeCompare(b.file)
    || a.name.localeCompare(b.name));
  const counts = tierCounts(labeled);
  const withholding = {
    surpriseWithheldForNewFiles: labeled.filter(c => c.withheld?.some(w => w.label === 'surprising-change' && /added \(or renamed/.test(w.reason))).length,
    hubTierWithheldForFunctionLocalHelpers: labeled.filter(c => localHelpers.has(c.id) && c.withheld).length,
    newFilesWithoutPriorHistory: [...newPaths].sort().slice(0, MAX_CHANGED_FILES),
  };

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
  const testsToRun = await selectTestsSummary(absDir, resolvedBase, narrowed.set);

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
        ? diffEntries.length === 0
          ? `Nothing changed since ${resolvedBase}: the diff is empty.`
          : `No production code changed since ${resolvedBase} (the diff touched only tests/config/non-code files) — "nothing changed", NOT "nothing significant".`
        : changeGranularity && (fileSymbols.length > 0 || changeGranularity.changedSymbolsFound > 0)
          ? `Nothing was briefed against ${resolvedBase}: ${noChangeClaim(changeGranularity).text}`
          : 'The changed file(s) contain no analyzed production symbol (not yet analyzed, or only tests/generated) — "nothing matched", NOT "nothing significant".';
    }
  }

  const granularityNote = changeGranularity && granularityCaveat(changeGranularity);
  const importsNote = changeGranularity && importsAddedCaveat(changeGranularity);
  const caveats: string[] = [
    ...(granularityNote ? [granularityNote] : []),
    ...(importsNote ? [importsNote] : []),
    ...(carriedCaveat(carried) ? [carriedCaveat(carried)!] : []),
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
  if (withholding.surpriseWithheldForNewFiles > 0) {
    caveats.push(`${withholding.surpriseWithheldForNewFiles} changed symbol(s) live in ${newPaths.size} file(s) added (or renamed into their path) since ${resolvedBase} with no pre-base history there: the surprising-change label is WITHHELD for them ("rarely changed before" is vacuous for a file that did not exist) and they rank one tier lower on their structural labels alone. Each entry states this under \`withheld\`.`);
  }
  if (withholding.hubTierWithheldForFunctionLocalHelpers > 0) {
    caveats.push(`${withholding.hubTierWithheldForFunctionLocalHelpers} changed symbol(s) are functions nested inside another function with every caller inside it — function-local helpers, not repository hubs. Their hub-derived tier is WITHHELD (they rank ordinary-change) and the significance is attributed to the enclosing symbol; their hub labels and fan-in are still reported as evidence.`);
  }
  if (counts['surprising-change'] > 0) {
    caveats.push('The surprising-change signal uses per-file churn matched by exact path. A rename INSIDE the briefed range is detected from git status and has the label withheld, but a rename that happened BEFORE the base ref still reads as low churn at its new path and can be over-flagged surprising. Confirm against the file\'s rename history.');
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
    ...(changeGranularity ? { changeGranularity } : {}),
    ...(carried.length > 0 ? { carried } : {}),
    tierCounts: counts,
    briefing: returned,
    truncation,
    regions,
    testsToRun,
    withholding,
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

/** A label this briefing refused to apply, with the premise that did not hold. */
interface WithheldLabel {
  label: SignificanceTier;
  reason: string;
}

/** A labeled change plus any label this briefing withheld from it. */
type BriefedChange = LabeledChange & { withheld?: WithheldLabel[] };

/**
 * Candidate id → enclosing function id, for every candidate that is a FUNCTION-LOCAL HELPER:
 * lexically nested inside another indexed function in the same file (strict span containment,
 * smallest container wins) AND called only from inside that enclosing function's span.
 *
 * Deliberately conservative — a nested function with even one caller outside its parent, or with
 * no caller at all, is NOT reported, so the hub-derived tier is only ever withheld from a symbol
 * whose whole fan-in is internal to one body. Costs one pass over the nodes of the candidates'
 * files plus one pass over the edges; no git, no re-parse.
 */
function findFunctionLocalHelpers(cg: SerializedCallGraph, candidates: FunctionNode[]): Map<string, string> {
  const out = new Map<string, string>();
  if (candidates.length === 0) return out;
  const files = new Set(candidates.map(n => n.filePath));
  const byFile = new Map<string, FunctionNode[]>();
  for (const n of cg.nodes) {
    if (n.isExternal || !files.has(n.filePath)) continue;
    const arr = byFile.get(n.filePath);
    if (arr) arr.push(n); else byFile.set(n.filePath, [n]);
  }
  const span = (n: FunctionNode) => n.endIndex - n.startIndex;
  const enclosingOf = new Map<string, FunctionNode>();
  for (const c of candidates) {
    let best: FunctionNode | undefined;
    for (const o of byFile.get(c.filePath) ?? []) {
      if (o.id === c.id) continue;
      // Strictly larger container: AST spans are properly nested, so a strictly wider span
      // that covers the candidate is an ancestor. Equal spans (a collapsed double-match) are
      // not containment and are skipped.
      if (o.startIndex <= c.startIndex && o.endIndex >= c.endIndex && span(o) > span(c)) {
        if (!best || span(o) < span(best)) best = o;
      }
    }
    if (best) enclosingOf.set(c.id, best);
  }
  if (enclosingOf.size === 0) return out;

  const nodeById = new Map(cg.nodes.map(n => [n.id, n]));
  const callersById = new Map<string, Set<string>>();
  for (const e of cg.edges) {
    if (!enclosingOf.has(e.calleeId)) continue;
    const set = callersById.get(e.calleeId);
    if (set) set.add(e.callerId); else callersById.set(e.calleeId, new Set([e.callerId]));
  }
  for (const [id, encl] of enclosingOf) {
    const callers = callersById.get(id);
    if (!callers || callers.size === 0) continue; // no caller → no hub tier to withhold anyway
    const allInside = [...callers].every(cid => {
      const caller = nodeById.get(cid);
      return !!caller
        && caller.filePath === encl.filePath
        && caller.startIndex >= encl.startIndex
        && caller.endIndex <= encl.endIndex;
    });
    if (allInside) out.set(id, encl.id);
  }
  return out;
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

function buildTruncationReceipt(returned: BriefedChange[], omitted: BriefedChange[]): TruncationReceipt {
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
  /** The changed-set this briefing already computed for the same base ref and diff. */
  changedSet?: SymbolChangedSet,
): Promise<{ count: number; files: string[]; note?: string; truncatedAtDepth?: number; soundness?: unknown }> {
  try {
    const result = (await handleSelectTests({ directory: absDir, diffRef: baseRef }, { changedSet })) as {
      selectedTests?: Array<{ file: string }>;
      error?: string;
      truncatedAtDepth?: number;
      soundness?: unknown;
    };
    if (result.error) return { count: 0, files: [], note: `test selection unavailable: ${result.error}` };
    const tests = result.selectedTests ?? [];
    const files = [...new Set(tests.map(t => t.file))].sort();
    return {
      count: tests.length,
      files: files.slice(0, MAX_TEST_FILES),
      ...(result.truncatedAtDepth !== undefined ? { truncatedAtDepth: result.truncatedAtDepth } : {}),
      ...(result.soundness !== undefined ? { soundness: result.soundness } : {}),
      ...(files.length > MAX_TEST_FILES ? { note: `${files.length} test files reach the change set; showing the first ${MAX_TEST_FILES}.` } : {}),
    };
  } catch (err) {
    return { count: 0, files: [], note: `test selection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
