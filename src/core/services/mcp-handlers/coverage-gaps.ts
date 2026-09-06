/**
 * Structural Test-Coverage Gap Report (change: add-test-coverage-gap-report) —
 * deterministic, graph-derived, no runtime.
 *
 * `select_tests` answers the FORWARD question — "I changed X, which tests reach
 * it?" — by walking the call graph backward from a change to the tests. This is
 * the exact INVERSE, run once over the whole graph: the set of production
 * functions in the backward-reachable set of NO test — i.e. no test transitively
 * reaches them — is the structurally-untested surface. Inverting the same
 * reachability that powers test selection yields coverage gaps for free, with no
 * test execution, no coverage instrumentation, and no working runtime.
 *
 * SOUNDNESS — gaps only, never "tested". A symbol with no reaching test
 * definitely has a coverage gap (the falsifiable, sound direction). The report
 * NEVER makes the unsound inverse claim that a symbol WITH a reaching test is
 * "tested": structural reachability from a test means a test CAN reach the code,
 * not that the test ASSERTS its behavior. Ranking reuses the existing
 * `landmark-signals` hub/chokepoint labels (no composite score, no new tuning
 * constant), so untested load-bearing code floats to the top.
 *
 * Distinct from `find_dead_code`: a gap node with no caller at all is ALSO dead
 * (find_dead_code's domain) and is labeled as such; an untested entry point or
 * framework-invoked handler is a real gap and is reported, labeled
 * untested-not-dead — the two conclusions stay separate.
 *
 * Distinct from `get_test_coverage`: that is a spec/domain tag-based report from
 * the test-generator; this is pure call-graph structural reachability.
 */

import { validateDirectory, readCachedContext } from './utils.js';
import { loadTraversalIndex } from './traversal.js';
import { deadCodeIds } from './reachability.js';
import { seedsFromSymbols, seedsFromFiles } from './test-impact.js';
import { computeLandmarkSignals, type LandmarkSignal } from '../../analyzer/landmark-signals.js';
import { isCodeNode, isExcludedPath } from './code-node.js';
import { assembleBoundary, computeStaleness, edgeBasisWithinSet, withheldOnPartialIndex } from './confidence-boundary.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';

export interface ReportCoverageGapsInput {
  directory: string;
  /** Limit reported gaps (default 100, capped 500). */
  maxResults?: number;
  /** Only report gaps whose file path contains this substring (region scope). */
  filePattern?: string;
  /**
   * Diff scope — restrict the report to gaps the change touches. Explicit symbols
   * take precedence; otherwise the working tree is diffed against `diffRef`
   * (default "HEAD" when `diffRef` is the empty string / a diff was requested).
   * Answers "is the risky part of THIS change untested?".
   */
  changedSymbols?: string[];
  diffRef?: string;
  /**
   * Restrict test-reachability to directly-resolved edges only, ignoring
   * synthesized dynamic-dispatch edges (mirrors select_tests/find_dead_code).
   * Default false — synthesized edges ARE traversed, so a function a test reaches
   * only through a callback/route is correctly counted as reachable-from-a-test
   * (and so NOT reported as a gap). Strict mode reports more gaps, more certainly.
   */
  directResolvedOnly?: boolean;
}

/** Hard cap on returned gaps — over-large requests are clamped, overflow reported. */
const MAX_RESULTS_CAP = 500;

interface CoverageGap {
  name: string;
  file: string;
  language: string;
  fanIn: number;
  /** Earned structural-interest labels (hub/chokepoint/orchestrator/entrypoint/volatile) — evidence, no score. */
  signals: LandmarkSignal[];
  /**
   * True when this gap is ALSO unreachable from any liveness root (find_dead_code's
   * domain) — a candidate-dead AND untested symbol. False/absent for a live-but-
   * untested symbol (e.g. an entry point invoked by a framework): untested-not-dead.
   */
  alsoFlaggedDead?: true;
  /**
   * WHY the symbol landed in the dead set (change: demote-dead-flagged-coverage-gaps).
   * Present exactly when `alsoFlaggedDead` is — the boolean's meaning is unchanged.
   *
   *   `no-callers`                    — fan-in zero: nothing in the graph calls it.
   *   `dead-via-unreachable-callers`  — fan-in above zero, yet still unreachable
   *                                     from any liveness root. Its callers are
   *                                     themselves unreachable, which is the
   *                                     signature of an INBOUND edge this analysis
   *                                     could not resolve (WebSocket/queue/DI
   *                                     dispatch), not evidence the code is unused.
   */
  deadReason?: DeadFlagReason;
}

/** Why a gap is also in the dead set. Closed set, derived — no new traversal. */
export type DeadFlagReason = 'no-callers' | 'dead-via-unreachable-callers';

/**
 * Report the structurally-untested surface: internal code in no test's reachable
 * set, ranked by significance. Read-only, deterministic, offline. Returns
 * `unknown` (additive-by-cast), conclusion-shaped (a ranked list + soundness),
 * never a graph.
 */
export async function handleReportCoverageGaps(input: ReportCoverageGapsInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  // A partial first-run index cannot ground a negative conclusion (change:
  // refine-first-run-partial-serving).
  const withheld = withheldOnPartialIndex(ctx, 'test-coverage gaps');
  if (withheld) return withheld;
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const maxResults = Math.max(1, Math.min(input.maxResults ?? 100, MAX_RESULTS_CAP));
  // One precomputed traversal structure for this artifact generation, not a
  // per-call adjacency rebuild (change: optimize-reachability-precompute). The
  // whole-graph reach below runs as a topological scan of the condensation DAG.
  const traversal = await loadTraversalIndex(absDir, cg);

  // ── Test reachability seeds (the exact inverse of select_tests) ─────────────
  // Source 1: every test node — a test transitively reaches the production code
  // it calls. Source 2: the production side (callerId) of every `tested_by` edge
  // — a function a test imports/asserts on is associated with that test even when
  // it is not a direct call-graph caller (import-based association). Seeding on
  // both and walking FORWARD yields every production node a test can reach.
  const testSeeds = new Set<string>();
  for (const n of cg.nodes) {
    if (n.isTest && !n.isExternal) testSeeds.add(n.id);
  }
  for (const e of cg.edges) {
    if (e.kind === 'tested_by' && e.callerId) testSeeds.add(e.callerId);
  }
  const reachedByTest = traversal.reachAll(testSeeds, 'forward', { directResolvedOnly: input.directResolvedOnly });

  // ── Candidate universe: internal, non-test, non-infra, non-generated code ───
  const universe = cg.nodes.filter(n => isCodeNode(n) && !n.isTest && !isExcludedPath(n.filePath));

  // ── Scope resolution: whole repo (default) | diff | region(filePattern) ─────
  // Precedence mirrors select_tests: explicit changedSymbols → diffRef → (when a
  // diff was explicitly requested via empty diffRef) the working tree vs HEAD.
  // A `filePattern` always further narrows the result (region scope on its own, or
  // an extra filter layered on a diff scope) and is echoed whenever applied.
  const hasSymbols = !!(input.changedSymbols && input.changedSymbols.length > 0);
  const wantsDiff = hasSymbols || input.diffRef !== undefined;
  let scope: 'repo' | 'diff' | 'region' = 'repo';
  let scopeIds: Set<string> | null = null;
  let changedDescriptor: string[] = [];
  let baseRefUsed: string | undefined;
  let baseRefFallback: { requested: string; resolved: string } | undefined;
  let diffError: string | undefined;
  if (wantsDiff) {
    scope = 'diff';
    baseRefUsed = input.diffRef && input.diffRef.length > 0 ? input.diffRef : 'HEAD';
    if (hasSymbols) {
      const seeds = seedsFromSymbols(cg, input.changedSymbols!);
      scopeIds = new Set(seeds.map(s => s.id));
      changedDescriptor = input.changedSymbols!;
    } else {
      try {
        // Resolve-or-disclose through the one shared helper (fix-cli-conclusion-honesty): a
        // typo'd diffRef silently falls back inside getChangedFiles, which would report gaps
        // scoped to the wrong diff. Resolve first, disclose the fallback, diff the real base.
        const { getChangedFiles, resolveBaseRefDisclosed } = await import('../../drift/git-diff.js');
        const base = await resolveBaseRefDisclosed(absDir, baseRefUsed);
        if (base.fellBack) baseRefFallback = { requested: baseRefUsed, resolved: base.resolved };
        baseRefUsed = base.resolved;
        const diff = await getChangedFiles({ rootPath: absDir, baseRef: base.resolved, includeUnstaged: true });
        const files = diff.files.map(f => f.path);
        changedDescriptor = files;
        scopeIds = new Set(seedsFromFiles(cg, files).map(s => s.id));
      } catch (err) {
        diffError = `git diff failed (base ${baseRefUsed}): ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } else if (input.filePattern) {
    scope = 'region';
  }
  if (diffError) return { error: diffError };

  // ── In-scope candidate set: the analysis FRAME for THIS call ────────────────
  // The counts (analyzedSymbols / reachableFromTest) and the gap list all range
  // over this set, so a scoped call's denominator matches its scoped gaps — never
  // the whole repo's 2000 symbols sitting behind a single scoped gap.
  let inScope = universe;
  if (input.filePattern) inScope = inScope.filter(n => n.filePath.includes(input.filePattern!));
  if (scopeIds) inScope = inScope.filter(n => scopeIds!.has(n.id));

  // Honesty: a diff/region scope that matched NOTHING is "nothing resolved", which
  // must never read as the reassuring "no gaps" of a scope that matched symbols and
  // found them all test-reachable. Disclose the reason (mirrors select_tests' empty-
  // seed message), so an agent never concludes "my change is covered" from a typo.
  let unmatchedNote: string | undefined;
  if (scope !== 'repo' && inScope.length === 0) {
    if (hasSymbols) {
      unmatchedNote = 'None of the given symbol(s) resolved to an in-scope production function (typo, not analyzed, or excluded as test/generated/vendored) — this is "nothing matched", NOT "no coverage gaps".';
    } else if (scope === 'diff') {
      unmatchedNote = changedDescriptor.length === 0
        ? `No files changed vs ${baseRefUsed} (or the diff touched only non-code files) — "nothing changed", NOT "no coverage gaps".`
        : 'The changed file(s) contain no in-scope production function (only tests/generated/vendored, or not yet analyzed) — "nothing matched", NOT "no coverage gaps".';
    } else {
      unmatchedNote = `filePattern "${input.filePattern}" matched no in-scope production symbol — "nothing matched", NOT "no coverage gaps".`;
    }
  }

  // ── The gap set: in-scope code with no reaching test ────────────────────────
  const gapNodes = inScope.filter(n => !reachedByTest.has(n.id));

  // ── Significance labels for ranking (reused classifiers, no new score) ──────
  // Strict mode is threaded into the dead set too, so `alsoFlaggedDead` rests on
  // the SAME edge basis as the gap partition (no strict/non-strict disagreement).
  const deadIds = await deadCodeIds(absDir, cg, { directResolvedOnly: input.directResolvedOnly });
  const landmarks = computeLandmarkSignals(cg, { deadIds });
  const signalsById = new Map(landmarks.map(l => [l.id, l.signals]));

  const gaps: CoverageGap[] = gapNodes.map(n => {
    const signals = (signalsById.get(n.id) ?? []).filter(s => s.label !== 'dead');
    const gap: CoverageGap = {
      name: n.name,
      file: n.filePath,
      language: n.language,
      fanIn: n.fanIn ?? 0,
      signals,
    };
    if (deadIds.has(n.id)) {
      gap.alsoFlaggedDead = true;
      // Derived from the dead set + the node's own fan-in — no extra traversal.
      gap.deadReason = gap.fanIn > 0 ? 'dead-via-unreachable-callers' : 'no-callers';
    }
    return gap;
  });

  // Rank: certainty before significance. A dead-flagged gap is one whose
  // reachability this analysis could NOT establish, so ranking it above a gap that
  // is certainly live-and-untested spends the reader's budget on the undecidable
  // (change: demote-dead-flagged-coverage-gaps). Tiers, in order:
  //   live load-bearing > live > dead-flagged load-bearing > dead-flagged.
  // Within a tier the previous comparator is preserved byte-for-byte: fan-in
  // (evidence), then a stable file+name tiebreak. Still label-based and
  // deterministic — no composite score, no new tuning constant.
  const isLoadBearing = (g: CoverageGap) => g.signals.some(s => s.label === 'hub' || s.label === 'chokepoint');
  const isLive = (g: CoverageGap) => !g.alsoFlaggedDead;
  gaps.sort((a, b) => {
    const al = isLive(a) ? 1 : 0;
    const bl = isLive(b) ? 1 : 0;
    if (al !== bl) return bl - al;
    const at = isLoadBearing(a) ? 1 : 0;
    const bt = isLoadBearing(b) ? 1 : 0;
    if (at !== bt) return bt - at;
    if (a.fanIn !== b.fanIn) return b.fanIn - a.fanIn;
    return a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
  });

  const returned = gaps.slice(0, maxResults);
  const omitted = gaps.length - returned.length;

  // Page composition: how much of what the caller is holding is decidable
  // untested code versus undecidable reachability. Reported for the returned page
  // AND the omitted remainder, so a 264-gap set discloses its shape without the
  // caller re-deriving it.
  const liveOf = (list: CoverageGap[]) => list.filter(isLive).length;
  const composition = {
    returned: { live: liveOf(returned), deadFlagged: returned.length - liveOf(returned) },
    ...(omitted > 0
      ? {
          omittedRemainder: {
            live: liveOf(gaps) - liveOf(returned),
            deadFlagged: omitted - (liveOf(gaps) - liveOf(returned)),
          },
        }
      : {}),
    total: { live: liveOf(gaps), deadFlagged: gaps.length - liveOf(gaps) },
  };

  // ── Honest coverage posture (mirrors select_tests' testDetection) ───────────
  const graphHasTests = cg.nodes.some(n => n.isTest) || cg.edges.some(e => e.kind === 'tested_by');
  const universeLangs = [...new Set(universe.map(n => n.language))].sort();
  const langsWithTests = new Set(cg.nodes.filter(n => n.isTest).map(n => n.language));
  const testDetection: 'full' | 'partial' | 'none' =
    !graphHasTests ? 'none'
    : universeLangs.every(l => langsWithTests.has(l)) ? 'full'
    : 'partial';

  const caveats: string[] = [
    'Reports only the sound direction: a symbol with NO reaching test has a coverage gap. It NEVER claims a symbol is "tested" or "covered".',
    'Reachable-from-a-test means a test CAN reach the code, not that any test ASSERTS its behavior — structural reachability is not behavioral verification.',
    'Dynamic dispatch, reflection, and DI can make a symbol reachable-by-test through an edge this static analysis cannot see — such a symbol may be falsely reported as a gap (over-report, the safe direction here).',
  ];
  if (testDetection === 'none') {
    caveats.push('No tests were detected in this graph — every symbol looks untested because test detection found nothing, NOT because the code is genuinely untested. Verify test-file detection for your languages.');
  } else if (testDetection === 'partial') {
    // Name ONLY the languages with no detected test node — listing every universe
    // language here would falsely imply a well-tested language (e.g. TypeScript) is
    // untested. Honesty: the over-report risk is scoped to these languages alone.
    const langsWithoutTests = universeLangs.filter(l => !langsWithTests.has(l));
    caveats.push(`No test files were detected for these languages (${langsWithoutTests.join(', ')}); their gaps may be over-reported (every symbol looks untested where no test was detected).`);
  }
  if (hasSymbols) {
    // Symbol resolution prefers an exact (case-insensitive) name match but falls back
    // to substring, so a short name can scope to more than the one function intended.
    caveats.push('Symbol scope resolves by name (exact preferred, substring fallback); a short or partial symbol name may widen the scope to several functions.');
  }
  // Emitted only when the returned page actually carries the reason — a caveat about
  // a signal that is not present is noise of the kind this change exists to remove.
  if (returned.some(g => g.deadReason === 'dead-via-unreachable-callers')) {
    caveats.push('Some returned gaps are flagged dead despite having callers (deadReason "dead-via-unreachable-callers"): their callers are themselves unreachable from any liveness root. That is the signature of an INBOUND edge static analysis could not resolve (WebSocket/queue/DI dispatch) — undecidable reachability, NOT evidence the code is unused. Such gaps are ranked below every live gap.');
  }

  // Confidence boundary: the liveness partition rests on the edges traversed within
  // the test-reachable set (the complement of the reported gaps — same posture as
  // find_dead_code, whose basis is the live set). Synthesized edges among reached
  // nodes mean a "reached" verdict leaned on a heuristic; disclose it. (spec:
  // add-confidence-boundary-disclosure)
  const reachBasis = edgeBasisWithinSet(cg.edges, reachedByTest);
  const staleness = await computeStaleness(absDir);
  const confidenceBoundary = assembleBoundary({ basis: reachBasis, staleness, integrity: ctx?.integrity });

  const testedCount = inScope.filter(n => reachedByTest.has(n.id)).length;

  // The unresolved-ref disclosure leads the caveats — it changes which base the diff
  // scope was computed against, so it must not be buried under the gaps-only caveats.
  if (baseRefFallback) {
    caveats.unshift(`Requested base ref "${baseRefFallback.requested}" did not resolve; scoped gaps to the diff vs "${baseRefFallback.resolved}" instead (git's silent fallback). Pass a ref that exists to target the base you meant.`);
  }

  return {
    scope,
    ...(scope === 'diff' ? { changed: changedDescriptor } : {}),
    ...(baseRefFallback ? { baseRefFallback } : {}),
    ...(input.filePattern ? { filePattern: input.filePattern } : {}),
    analyzedSymbols: inScope.length,
    reachableFromTest: testedCount,
    gapCount: gaps.length,
    coverageGaps: returned,
    composition,
    ...(omitted > 0 ? { omitted } : {}),
    ...(unmatchedNote ? { note: unmatchedNote } : {}),
    soundness: { posture: 'gaps-only' as const, claim: 'no-reaching-test' as const, caveats },
    coverage: { languages: universeLangs, testDetection },
    confidenceBoundary,
  };
}
