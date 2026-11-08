/**
 * Confidence-boundary disclosure (change: add-confidence-boundary-disclosure).
 *
 * Every conclusion answer carries a deterministic `confidenceBoundary` saying what
 * it does NOT know: how much of the traversal rested on directly-resolved edges vs
 * synthesized (heuristic) ones, which known-unknowable boundaries it crossed, and
 * whether the index it ran against still matches the working tree. Categorical
 * labels and counts only — never a blended confidence score, never an LLM call
 * (north star c6d1ad07). Additive metadata: a caller that ignores it sees today's
 * answer unchanged.
 *
 * The basis and crossings are derived from the `confidence`/`synthesizedBy`
 * provenance already on every edge (spec: add-synthesized-dynamic-dispatch-edges,
 * add-type-hierarchy-resolved-dispatch). The staleness marker reuses the project
 * fingerprint written at analyze time and the git diff machinery — nothing new is
 * computed at analyze time except the optional build commit.
 */

import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ARTIFACT_FINGERPRINT, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR } from '../../../constants.js';
import { gitPathArgs } from '../../../utils/git-args.js';
import type { IndexIntegrity } from '../../analyzer/index-attestation.js';
import { repairStatusFor, repairDisclosureText } from '../cold-start-bootstrap.js';
import type { PartialIndexStamp } from '../../runtime/partial-index.js';
import { execFileGit as execFileAsync } from '../../../utils/git-exec.js';


// Source extensions whose change can alter the call graph — mirrors the fingerprint
// source set. A docs-only or config-only change does not stale the graph.
const GRAPH_SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.cs',
]);

/** The only edge fields the boundary reads — a minimal, structural view. */
export interface BoundaryEdge {
  confidence?: string;
  synthesizedBy?: string;
}

/** An edge in the call graph, as the boundary needs to see it for pair indexing. */
interface PairableEdge extends BoundaryEdge {
  callerId?: string;
  calleeId?: string;
}

/** How an answer's traversal was grounded: direct vs heuristically-recovered edges. */
export interface EdgeBasis {
  /** Edges resting on direct name/type resolution. */
  directEdges: number;
  /** Edges recovered heuristically (confidence === 'synthesized'). */
  synthesizedEdges: number;
  /** Synthesized-edge count broken down by the rule that produced each. */
  synthesizedByRule?: Record<string, number>;
}

export type KnownUnknowableKind =
  | 'synthesized-dispatch'
  | 'unindexed-repo'
  | 'dynamic-boundary'
  /**
   * The answer served symbols re-read from the working tree, but their INCOMING call
   * edges still come from the index and may predate the edit (change:
   * overlay-dirty-files-at-query-time). Re-reading a file is sound for what that file
   * contains; re-resolving who calls into it is a whole-graph operation the overlay
   * deliberately does not attempt, so it is disclosed rather than implied.
   */
  | 'working-tree-overlay';

/**
 * One dynamic-dispatch construct the resolver could not follow, as disclosed on a conclusion
 * (change: disclose-dynamic-boundary-regions). The structured half of the crossing: the reader
 * gets the file, line and kind rather than a prose caveat about the language.
 */
export interface DisclosedDynamicSite {
  file: string;
  line: number;
  /** A member of the analyzer's closed dynamic-boundary vocabulary. */
  kind: string;
}

/** A boundary the computation is known to be unable to see past. */
export interface KnownUnknowableCrossing {
  kind: KnownUnknowableKind;
  /** The synthesis rule, when kind === 'synthesized-dispatch'. */
  rule?: string;
  count: number;
  /** Actionable, human-readable disclosure. */
  detail: string;
  /**
   * The sites in scope, when kind === 'dynamic-boundary'. Bounded, and deduplicated by kind+file to
   * one entry per group — a file dispatching reflectively fifty times is one fact about that file.
   * `count` therefore counts SITES while this list counts GROUPS; `omittedSites` is the truncation
   * receipt in the same group unit, so a bounded list never reads as the whole set.
   */
  sites?: DisclosedDynamicSite[];
  /**
   * File+kind groups not listed because the disclosure bound was reached. Absent when nothing was
   * omitted. In groups, matching `sites`, NOT in the raw site unit `count` uses.
   */
  omittedSites?: number;
}

/** The index lags the working tree: source has changed since the build commit. */
export interface StalenessMarker {
  /** Short SHA the index was built at. */
  indexCommit: string;
  /** Source files changed since the build commit (graph-relevant extensions). */
  filesChangedSince: number;
  detail: string;
}

/**
 * The persisted index this answer ran against did not reconcile against its build-time
 * attestation — it is materially smaller than the build committed (`degraded`) or built
 * at a different schema (`mismatched`). Negative conclusions over such an index may be
 * false. Absent when the index is `healthy` or unverifiable (change:
 * add-index-integrity-attestation).
 */
export interface IndexIntegrityDisclosure {
  verdict: 'degraded' | 'mismatched';
  detail: string;
}

/**
 * A background index repair is in flight for the queried repo (change:
 * make-index-self-healing). The answer was served from the stale index without
 * waiting; a later call after the rebuild completes serves fresh results. Absent
 * when no repair is running. Distinguishes *repairing* from plain *stale* so an
 * agent can choose to proceed on the disclosed answer or retry.
 */
export interface RepairInProgressMarker {
  inProgress: true;
  /** Why the repair started (integrity-mismatched, stale-region, schema-reset, …). */
  reason: string;
  detail: string;
}

/**
 * One named cause of an answer's incompleteness (change:
 * never-claim-complete-beside-a-refusal).
 *
 * `complete: false` on its own tells an agent only that *something* is missing. Each
 * reason names WHICH part, and points at the response field carrying the detail, so the
 * agent can decide whether the gap touches the question it actually asked.
 */
export interface DisclosureReason {
  /**
   * The response (or boundary) field that disclosed: a registered disclosure channel's
   * path (`notAssessed`, `changeGranularity.reasons`, …), or one of the boundary's own
   * parts (`knownUnknowable`, `staleness`, `integrity`, `repair`), or `disclosures` for a
   * live, handler-declared prose disclosure.
   */
  channel: string;
  /** What is incomplete and where to read about it, in the boundary's own voice. */
  detail: string;
}

export interface ConfidenceBoundary {
  /** How the traversal was grounded. Omitted for non-traversal answers (recall). */
  basis?: EdgeBasis;
  /** Boundaries the computation cannot see past. Absent when none. */
  knownUnknowable?: KnownUnknowableCrossing[];
  /** Index-vs-working-tree staleness. Absent when the index is current. */
  staleness?: StalenessMarker;
  /** Index integrity verdict when the underlying index did not reconcile. Absent when healthy. */
  integrity?: IndexIntegrityDisclosure;
  /** A background repair is healing this index right now. Absent when none is running. */
  repair?: RepairInProgressMarker;
  /**
   * True iff the computation crossed no boundary AND the answer disclosed no refusal,
   * cap, fallback, degradation or discarded input: no synthesized-edge reliance, no
   * known-unknowable crossing, a current index, a reconciled (non-degraded,
   * non-mismatched) index, and every registered disclosure channel silent.
   *
   * The answer-level NoFalseCompleteness flag, and DERIVED — never asserted. A handler
   * cannot set it: it falls out of {@link assembleBoundary}'s parts and of
   * {@link reconcileCompleteness}'s sweep of the response's disclosure channels at the
   * dispatch boundary. `complete: true` beside a disclosed gap is the most damaging form
   * of the defect, because it tells the agent not to look further.
   */
  complete: boolean;
  /**
   * Why the answer is NOT complete — one entry per cause, each naming the field that
   * holds the detail. Present iff `complete` is false; absent on a complete answer.
   */
  incompleteBecause?: DisclosureReason[];
}

/**
 * Map an index integrity verdict to a confidence-boundary disclosure. Healthy and
 * unverifiable (undefined) indexes disclose nothing — only a verdict that actually
 * undermines the answer's completeness is surfaced.
 */
export function integrityDisclosure(integrity?: IndexIntegrity): IndexIntegrityDisclosure | undefined {
  if (!integrity || integrity.verdict === 'healthy') return undefined;
  return { verdict: integrity.verdict, detail: integrity.detail };
}

/**
 * Refuse to serve a negative conclusion computed from a partial first-run index
 * (change: refine-first-run-partial-serving).
 *
 * A partial index is a SOUND LOWER BOUND on what exists: it can prove a caller is there, never
 * that one is not. "This function is dead", "no test reaches this", "nothing calls it" are
 * exactly the claims partiality inverts — the file holding the only caller may simply not have
 * been reached yet — so they are withheld rather than downgraded. Positive lookups and
 * navigation are unaffected and keep answering.
 *
 * The result carries no boundary of its own: `dispatchTool` attaches the completeness receipt to
 * every response, so repeating the same paragraph here would send it twice.
 *
 * Returns null when the index is complete, so a handler reads as a one-line guard.
 */
export function withheldOnPartialIndex(
  ctx: { partial?: PartialIndexStamp } | null | undefined,
  conclusion: string,
): {
  error: string;
  withheld: true;
  reason: 'partial-index';
  remedy: string;
} | null {
  if (!ctx?.partial) return null;
  return {
    error: `Withheld: ${conclusion} cannot be computed from a partial first-run index. `
      + 'A negative conclusion drawn now could be inverted by a file this index has not '
      + 'reached, so none is served.',
    withheld: true,
    reason: 'partial-index',
    remedy: 'Re-run this tool once the first analysis completes.',
  };
}

/**
 * The repair-in-progress marker for a directory, or undefined when no background repair is
 * running. Handlers pass this into {@link assembleBoundary} so a stale answer served during a
 * self-heal is disclosed as *repairing*, not silently stale (change: make-index-self-healing).
 */
export function repairDisclosure(directory: string): RepairInProgressMarker | undefined {
  const status = repairStatusFor(directory);
  if (!status) return undefined;
  return {
    inProgress: true,
    reason: status.reason,
    detail: repairDisclosureText(status.reason),
  };
}

/** Tally direct vs synthesized edges (by rule) from a set of traversed edges. */
export function edgeBasis(edges: Iterable<BoundaryEdge>): EdgeBasis {
  let directEdges = 0;
  let synthesizedEdges = 0;
  const byRule: Record<string, number> = {};
  for (const e of edges) {
    if (e.confidence === 'synthesized') {
      synthesizedEdges++;
      const rule = e.synthesizedBy ?? 'synthesized';
      byRule[rule] = (byRule[rule] ?? 0) + 1;
    } else {
      directEdges++;
    }
  }
  const basis: EdgeBasis = { directEdges, synthesizedEdges };
  if (synthesizedEdges > 0) basis.synthesizedByRule = byRule;
  return basis;
}

/** Count direct vs synthesized edges internal to a node-id set (both endpoints in). */
export function edgeBasisWithinSet(edges: Iterable<PairableEdge>, nodeIds: Set<string>): EdgeBasis {
  const relevant: BoundaryEdge[] = [];
  for (const e of edges) {
    if (e.callerId && e.calleeId && nodeIds.has(e.callerId) && nodeIds.has(e.calleeId)) relevant.push(e);
  }
  return edgeBasis(relevant);
}

/**
 * Index a call-edge list by `caller→callee` for chain lookups. When both a direct
 * and a synthesized edge exist for the same pair, the direct one wins: the path is
 * realizable without the heuristic, so it is not a boundary crossing.
 */
export function buildPairEdgeIndex(edges: Iterable<PairableEdge>): Map<string, BoundaryEdge> {
  const idx = new Map<string, BoundaryEdge>();
  for (const e of edges) {
    if (!e.callerId || !e.calleeId) continue;
    const key = e.callerId + '\x00' + e.calleeId;
    const existing = idx.get(key);
    if (!existing || (existing.confidence === 'synthesized' && e.confidence !== 'synthesized')) {
      idx.set(key, { confidence: e.confidence, synthesizedBy: e.synthesizedBy });
    }
  }
  return idx;
}

/**
 * The rule label for a hop a SYNTHESIZED edge realizes, or `undefined` for a directly-resolved hop
 * (a direct edge wins over a synthesized one for the same pair, see {@link buildPairEdgeIndex}).
 * The rule name comes from a repository-controlled artifact, so only a plain rule-shaped name is
 * echoed; anything else reads `synthesized`. Shared by every tool that reports a path or a
 * neighbour, so a message or event hop never reads as a call.
 */
export function hopVia(edge: BoundaryEdge | undefined): string | undefined {
  if (edge?.confidence !== 'synthesized') return undefined;
  const rule = edge.synthesizedBy;
  return typeof rule === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(rule) ? rule : 'synthesized';
}

/** Edge basis for a set of node-id chains, deduping repeated caller→callee pairs. */
export function edgeBasisForChains(chains: string[][], pairIndex: Map<string, BoundaryEdge>): EdgeBasis {
  const seen = new Set<string>();
  const edges: BoundaryEdge[] = [];
  for (const chain of chains) {
    for (let i = 0; i + 1 < chain.length; i++) {
      const key = chain[i] + '\x00' + chain[i + 1];
      if (seen.has(key)) continue;
      seen.add(key);
      const e = pairIndex.get(key);
      if (e) edges.push(e);
    }
  }
  return edgeBasis(edges);
}

/**
 * The known-unknowable crossings implied by a basis: each synthesized rule is a
 * recovered-heuristic dispatch boundary the agent should verify before asserting.
 */
export function crossingsFromBasis(basis: EdgeBasis): KnownUnknowableCrossing[] {
  if (!basis.synthesizedByRule) return [];
  return Object.entries(basis.synthesizedByRule)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rule, count]) => ({
      kind: 'synthesized-dispatch' as const,
      rule,
      count,
      detail:
        `${count} edge(s) on this answer were recovered heuristically by the "${rule}" rule, not by ` +
        `direct name resolution — the true callee is not statically guaranteed; verify before asserting.`,
    }));
}

// Short per-directory memo so a burst of conclusion calls in one agent turn doesn't
// re-shell `git diff` each time. Source changes are what move the result, so a few
// seconds of latency on the staleness check itself is immaterial.
const STALENESS_TTL_MS = 5000;
export interface StalenessAssessment {
  indexCommit: string | null;
  changedSourceFiles: number | null;
  marker: StalenessMarker | undefined;
}
const stalenessMemo = new Map<string, { at: number; value: StalenessAssessment }>();

/**
 * Pure staleness decision: emit a marker only when we can both name the build
 * commit AND count graph-relevant source files changed since it. A null commit
 * (older index, or a non-git analyze) or a null count (not a git repo, git failed)
 * means we cannot assess staleness reliably — we stay silent rather than cry wolf
 * on every answer. Zero changed source files means the index is current.
 */
export function buildStalenessMarker(indexCommit: string | null, changedSourceFiles: number | null): StalenessMarker | undefined {
  if (!indexCommit) return undefined;
  if (changedSourceFiles === null) return undefined;
  if (changedSourceFiles === 0) return undefined;
  return {
    indexCommit,
    filesChangedSince: changedSourceFiles,
    detail:
      `Computed against the index built at commit ${indexCommit}; ${changedSourceFiles} source ` +
      `file(s) changed since. Re-run analyze_codebase for a current answer.`,
  };
}

/** Read the build commit the index was analyzed at, if it was captured. */
async function readBuildCommit(absDir: string, analysisDir?: string): Promise<string | null> {
  try {
    const raw = await readFile(join(
      analysisDir ?? join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR),
      ARTIFACT_FINGERPRINT,
    ), 'utf-8');
    const fp = JSON.parse(raw) as { commit?: string | null };
    return fp.commit ?? null;
  } catch {
    return null;
  }
}

/**
 * Count graph-relevant source files changed between a build commit and the current
 * working tree (committed + unstaged). Null when not a git repo or git fails — the
 * caller then stays silent rather than guessing.
 */
async function countSourceChangedSince(absDir: string, commit: string): Promise<number | null> {
  try {
    const { isGitRepositoryRoot, validateGitRef } = await import('../../drift/git-diff.js');
    // Root-only: `git diff --name-only <commit>` below the repo root lists the WHOLE
    // repo's changed files (repo-root-relative), over-counting staleness from sibling
    // packages. Gate on the root to keep the prior "null below root" behavior.
    if (!(await isGitRepositoryRoot(absDir))) return null;
    validateGitRef(commit);
    const [{ stdout: changed }, { stdout: untracked }] = await Promise.all([
      execFileAsync('git', gitPathArgs('diff', '--name-only', commit, '--'), { cwd: absDir }),
      execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '--'], { cwd: absDir }),
    ]);
    return new Set(`${changed}\n${untracked}`
      .split('\n')
      .map((s) => s.trim())
      .filter((f) => f.length > 0 && GRAPH_SOURCE_EXTS.has(extname(f))))
      .size;
  } catch {
    return null;
  }
}

/**
 * Staleness marker when source has changed since the index's build commit. Git-based
 * and deterministic: staleness fires iff graph-relevant source files changed since
 * the commit the index was built at. Returns undefined when the index is current, or
 * when staleness cannot be assessed (no build commit, or not a git repo).
 */
export async function computeStaleness(absDir: string, now: number = Date.now()): Promise<StalenessMarker | undefined> {
  return computeStalenessForAnalysis(
    absDir,
    join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR),
    now,
  );
}

/** Viewer/custom-analysis variant of {@link computeStaleness}. */
export async function computeStalenessForAnalysis(
  absDir: string,
  analysisDir: string,
  now: number = Date.now(),
): Promise<StalenessMarker | undefined> {
  return (await assessStalenessForAnalysis(absDir, analysisDir, now)).marker;
}

/** Return the viewer-facing assessment without collapsing unknown and current. */
export async function assessStalenessForAnalysis(
  absDir: string,
  analysisDir: string,
  now: number = Date.now(),
  useMemo: boolean = true,
): Promise<StalenessAssessment> {
  const commit = await readBuildCommit(absDir, analysisDir);
  const memoKey = `${absDir}\0${analysisDir}\0${commit ?? ''}`;
  const memo = stalenessMemo.get(memoKey);
  if (useMemo && memo && now - memo.at < STALENESS_TTL_MS) return memo.value;

  const changed = commit ? await countSourceChangedSince(absDir, commit) : null;
  const value = {
    indexCommit: commit,
    changedSourceFiles: changed,
    marker: buildStalenessMarker(commit, changed),
  };
  if (useMemo) stalenessMemo.set(memoKey, { at: now, value });
  return value;
}

/**
 * Assemble a boundary from its parts and derive `complete`. The synthesized-edge
 * crossings are derived from the basis; callers may add extra crossings (e.g. an
 * unindexed federated repo), and `disclosures` carries live, answer-specific prose
 * disclosures the handler already computed (see {@link NON_DISCLOSURE_RESPONSE_FIELDS}
 * for why a prose field is never swept automatically). An answer is complete only when
 * nothing was crossed, the index is current, and nothing was disclosed.
 *
 * Every cause is named in `incompleteBecause`, so `complete: false` says WHICH part is
 * incomplete rather than merely that something is.
 */
export function assembleBoundary(parts: {
  basis?: EdgeBasis;
  extraCrossings?: KnownUnknowableCrossing[];
  staleness?: StalenessMarker;
  integrity?: IndexIntegrity;
  repair?: RepairInProgressMarker;
  /**
   * Live disclosures this answer made in prose (a dropped filter, an unresolved ref, a
   * withheld label). Standing methodology notes are NOT disclosures and must not be
   * passed — they would make `complete` permanently false and so meaningless.
   */
  disclosures?: readonly string[];
}): ConfidenceBoundary {
  const crossings = [
    ...(parts.basis ? crossingsFromBasis(parts.basis) : []),
    ...(parts.extraCrossings ?? []),
  ];
  const integrity = integrityDisclosure(parts.integrity);
  const live = (parts.disclosures ?? []).filter((d) => typeof d === 'string' && d.trim().length > 0);
  const boundary: ConfidenceBoundary = {
    complete: crossings.length === 0 && !parts.staleness && !integrity && !parts.repair && live.length === 0,
  };
  if (parts.basis) boundary.basis = parts.basis;
  if (crossings.length > 0) boundary.knownUnknowable = crossings;
  if (parts.staleness) boundary.staleness = parts.staleness;
  if (integrity) boundary.integrity = integrity;
  if (parts.repair) boundary.repair = parts.repair;
  if (!boundary.complete) {
    const reasons: DisclosureReason[] = [];
    if (crossings.length > 0) {
      reasons.push({
        channel: 'knownUnknowable',
        detail: `${crossings.length} boundary crossing(s) this answer could not see past — read confidenceBoundary.knownUnknowable.`,
      });
    }
    if (parts.staleness) reasons.push({ channel: 'staleness', detail: parts.staleness.detail });
    if (integrity) reasons.push({ channel: 'integrity', detail: integrity.detail });
    if (parts.repair) reasons.push({ channel: 'repair', detail: parts.repair.detail });
    for (const d of live) reasons.push({ channel: 'disclosures', detail: d });
    boundary.incompleteBecause = reasons;
  }
  return boundary;
}

// ===========================================================================
// NoCompleteBesideADisclosure (mcp-quality; change:
// never-claim-complete-beside-a-refusal)
// ===========================================================================
//
// `complete: true` in the same response as an explicit refusal, cap, fallback,
// degradation or discarded input is the most damaging form of a false claim: it tells
// the agent not to look further, converting a DISCLOSED gap into a silent one. Five
// independent instances shipped that way (an `unverifiable` verdict, a time-capped
// briefing, a discarded `asOf`, a bounded `noPath`, a pattern that matched nothing).
//
// The rule lives HERE, as a registry swept once at the dispatch boundary, rather than
// as a line in each handler: `dispatchTool` is the single point both transports and
// every CLI wrapper funnel through, so a tool CANNOT opt out of it — including a tool
// that does not exist yet. The sweep is O(1) in the size of the payload: it reads a
// fixed list of named paths (depth 2 at most) and never walks the response.

/** A response field whose presence/content means this answer disclosed a gap. */
export interface DisclosureChannel {
  /** Response field, or `parent.child`. Depth 2 at most — never a deep scan. */
  path: string;
  /** True iff this channel actually disclosed something on THIS answer. */
  fires: (value: unknown) => boolean;
  /** What is incomplete and where to read it, in the boundary's voice. */
  detail: (value: unknown) => string;
}

const nonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
const nonEmptyRecord = (v: unknown): boolean => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const _k in v as Record<string, unknown>) return true;
  return false;
};
const countOf = (v: unknown): number => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);

/**
 * Response fields that mean "this answer disclosed a gap". Each entry is an explicit
 * predicate, never a generic truthiness test: `truncation` is present on every
 * briefing_since answer and `truncated: 0` on every find_dead_code answer, so a blanket
 * "field present ⇒ incomplete" rule would make `complete` permanently false — and a flag
 * that is always false carries no information at all.
 */
export const DISCLOSURE_CHANNELS: readonly DisclosureChannel[] = [
  {
    path: 'verdict',
    fires: (v) => v === 'unverifiable',
    detail: () => 'The verdict is "unverifiable": this answer is a refusal, not a conclusion — read `reason`.',
  },
  {
    path: 'withheld',
    fires: (v) => v === true || (typeof v === 'string' && v.length > 0),
    detail: (v) => `Part of this answer was withheld (${typeof v === 'string' ? v : 'see the `withheld` field'}).`,
  },
  {
    path: 'unsupported',
    fires: (v) => v === true,
    detail: () => 'The requested subject is unsupported here, so nothing was assessed — read `reason`.',
  },
  {
    path: 'notReady',
    fires: (v) => v === true,
    detail: () => 'The index was not ready, so no answer was computed.',
  },
  {
    path: 'notAssessed',
    fires: (v) => countOf(v) > 0,
    detail: (v) => `${countOf(v)} item(s) could not be assessed — read \`notAssessed\`; their absence from the findings is not a clean bill.`,
  },
  {
    path: 'boundaries',
    fires: nonEmptyArray,
    detail: (v) => `${countOf(v)} analysis boundary(ies) were crossed — read \`boundaries\`; the result is a lower bound.`,
  },
  {
    path: 'truncated',
    fires: (v) => v === true || countOf(v) > 0 || (nonEmptyRecord(v) && countOf((v as { omitted?: unknown }).omitted) > 0),
    detail: () => 'The result list was truncated — read `truncated`; the returned set is not the whole set.',
  },
  {
    path: 'truncation.bounded',
    fires: (v) => v === true,
    detail: () => 'The result was bounded before the whole set was returned — read `truncation`.',
  },
  {
    path: 'baseRefFallback',
    fires: nonEmptyRecord,
    detail: (v) => {
      const f = v as { requested?: unknown; resolved?: unknown };
      return `The requested base ref did not resolve; this answer was computed against "${String(f.resolved)}" instead of "${String(f.requested)}".`;
    },
  },
  {
    path: 'changeGranularity.reasons',
    fires: nonEmptyRecord,
    detail: (v) => {
      const entries = Object.entries(v as Record<string, unknown>)
        .map(([k, n]) => `${k}: ${String(n)}`)
        .sort()
        .join(', ');
      return `Per-symbol change detection degraded to whole-file granularity for some files (${entries}) — read \`changeGranularity\`; the changed set is coarser than it looks.`;
    },
  },
  {
    path: 'changeGranularity.fallbacks',
    fires: nonEmptyArray,
    detail: (v) => `${countOf(v)} file(s) fell back from per-symbol to whole-file change detection — read \`changeGranularity.fallbacks\`.`,
  },
  {
    path: 'filePatternMatch',
    fires: (v) => nonEmptyRecord(v) && (v as { matchedFiles?: unknown }).matchedFiles === 0,
    detail: (v) => `The requested filePattern "${String((v as { pattern?: unknown }).pattern)}" matched 0 indexed files, so this answer covers an EMPTY scope — read \`filePatternMatch\`.`,
  },
  {
    path: 'noPath',
    fires: nonEmptyRecord,
    detail: () => 'No path was found within the bounded search — read `noPath`; "not found within the bound" is not "does not exist".',
  },
  {
    path: 'ambiguousCallSites',
    fires: (v) => nonEmptyRecord(v) && countOf((v as { count?: unknown }).count) > 0,
    detail: (v) => `${countOf((v as { count?: unknown }).count)} call site(s) the resolver refused to bind touch this answer — read \`ambiguousCallSites\`; it is a lower bound.`,
  },
  {
    path: 'staleTriggeredMemories',
    fires: nonEmptyArray,
    detail: (v) => `${countOf(v)} triggered memory(ies) are orphaned and were not served as content — read \`staleTriggeredMemories\`.`,
  },
  {
    path: 'unreconciled',
    fires: nonEmptyArray,
    detail: (v) => `${countOf(v)} authoritative record(s) disagree and none was selected — read \`unreconciled\`.`,
  },
  {
    path: 'evidenceRefuted',
    fires: nonEmptyArray,
    detail: (v) => `${countOf(v)} record(s) rest on a claim that no longer holds — read \`evidenceRefuted\`.`,
  },
  {
    path: 'evidenceUnverifiable',
    fires: nonEmptyArray,
    detail: (v) => `${countOf(v)} record(s) rest on a claim that could not be checked — read \`evidenceUnverifiable\`.`,
  },
  {
    path: 'opaqueEnvSources',
    fires: nonEmptyArray,
    detail: (v) => `${countOf(v)} configuration source(s) could not be listed — read \`opaqueEnvSources\`; declarations there are invisible here.`,
  },
  {
    path: 'partialIndex.partial',
    fires: (v) => v === true,
    detail: () => 'This answer was computed from a partial first-run index — read `partialIndex`.',
  },
];

/**
 * Response fields that LOOK disclosure-shaped but are NOT completeness signals, each with
 * the reason it is excluded. The structural guard requires every disclosure-shaped field
 * on the tool surface to appear either here or in {@link DISCLOSURE_CHANNELS}, so a new
 * tool cannot introduce a third, unclassified kind.
 */
export const NON_DISCLOSURE_RESPONSE_FIELDS: Readonly<Record<string, string>> = {
  // Prose channels. Each MIXES standing methodology with live disclosure in one array or
  // string (briefing_since ships two permanent caveats; find_path's `note` explains a
  // conclusion rather than qualifying it), so sweeping them would pin `complete` to false
  // forever. The handlers that put live disclosures in prose declare them explicitly
  // through `assembleBoundary({ disclosures })` instead.
  caveats: 'Mixes standing methodology with live disclosure; handlers declare the live part via assembleBoundary({ disclosures }).',
  note: 'Overloaded: explains a conclusion as often as it qualifies one. Declared via assembleBoundary({ disclosures }) when it discloses.',
  notes: 'Standing methodology prose, like `caveats`.',
  hint: 'A next-step suggestion, not a statement about this answer\'s coverage.',
  reason: 'Explains the verdict/ranking that WAS computed; the refusal case is caught by the `verdict` channel.',
  soundness: 'A standing posture + methodology caveats, identical on every answer of that tool.',
  // Receipts that are present-and-empty on a healthy answer. Their firing form is
  // registered above under the specific field that carries the count.
  truncation: 'Present on every answer; the `truncation.bounded` channel carries the firing form.',
  changeGranularity: 'Present whenever per-symbol detection ran; the `.reasons`/`.fallbacks` channels carry the firing form.',
  coverage: 'Describes which languages/signals the answer used, not a gap in it.',
  // Nested sub-receipts whose FIRING form is already a channel on the parent. The sweep
  // reads named paths, never a payload walk, so an inner count is reached through its
  // parent's registered channel or not at all.
  omitted: 'An inner count of a truncation receipt; `truncated` / `truncation.bounded` carry the firing form.',
  omittedAtLeast: 'An inner count of a bounded traversal receipt, under its own parent block.',
  omittedByTier: 'An inner breakdown of `truncation`, which has its own channel.',
  omittedSites: 'An inner count of a knownUnknowable crossing, which is already a boundary part.',
  // Per-record verdicts. These qualify ONE served record, not the answer as a whole; the
  // whole-answer gaps of the tools that emit them are declared through
  // `assembleBoundary({ disclosures })`.
  ambiguous: 'A per-anchor outcome on one memory record, not a statement about the recall.',
  staleRegion: 'A per-memory freshness verdict on one record, not about the whole answer.',
  staleRegionComposition: 'Per-memory freshness provenance on one record.',
  staleDecisionRef: 'A per-memory signal that one record cites a superseded decision.',
  staleFiles: 'Inner evidence of the memory-anchor findings report, under its own block.',
  unassessedReason: 'Inner prose of the memory-anchor findings report, under its own block.',
  // Content transforms, not structural gaps.
  redactions: 'Secret redaction changes the text served, not what the structural conclusion covered.',
  federationNote: 'Names an opt-in flag that does not apply to this mode; the mode\'s own answer is unaffected.',
  unsupportedCapabilityNote: 'Descriptive capability-matrix prose, not a gap in a computed answer.',
};

/** Precomputed path segments — the sweep never splits a string at request time. */
const CHANNEL_SEGMENTS: readonly (readonly string[])[] = DISCLOSURE_CHANNELS.map((c) => c.path.split('.'));

/**
 * Derive `confidenceBoundary.complete` from the response's disclosure channels, and name
 * every cause in `incompleteBecause`.
 *
 * Applied once at the dispatch boundary, so no tool — present or future — can claim a
 * complete answer beside a disclosed refusal, cap, fallback, degradation or discarded
 * input. Idempotent: re-running it adds nothing new. A response with no
 * `confidenceBoundary` is returned untouched — this reconciles a claim the answer makes,
 * it never invents one.
 */
export function reconcileCompleteness(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const response = result as Record<string, unknown>;
  const boundary = response.confidenceBoundary;
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) return result;

  const fired: DisclosureReason[] = [];
  for (let i = 0; i < DISCLOSURE_CHANNELS.length; i++) {
    const segments = CHANNEL_SEGMENTS[i];
    let value: unknown = response[segments[0]];
    for (let s = 1; s < segments.length && value; s++) {
      value = typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[segments[s]]
        : undefined;
    }
    if (value === undefined || value === null) continue;
    const channel = DISCLOSURE_CHANNELS[i];
    if (channel.fires(value)) fired.push({ channel: channel.path, detail: channel.detail(value) });
  }
  if (fired.length === 0) return result;

  const existing = (boundary as ConfidenceBoundary).incompleteBecause ?? [];
  const seen = new Set(existing.map((r) => r.channel));
  return {
    ...response,
    confidenceBoundary: {
      ...(boundary as ConfidenceBoundary),
      complete: false,
      incompleteBecause: [...existing, ...fired.filter((r) => !seen.has(r.channel))],
    },
  };
}

/**
 * The crossing for an answer whose symbols were re-read from the working tree. Returns
 * undefined when no file was overlaid, so a normal answer carries nothing extra.
 */
export function overlayCrossing(overlaidFileCount: number): KnownUnknowableCrossing | undefined {
  if (overlaidFileCount <= 0) return undefined;
  return {
    kind: 'working-tree-overlay',
    count: overlaidFileCount,
    detail: `${overlaidFileCount} edited file(s) were re-read from the working tree for this answer. Their symbols and spans are current; incoming call edges come from the index and may predate the edit.`,
  };
}

/** Reset the staleness memo — test-only hook so a stubbed fingerprint is re-read. */
export function __resetStalenessMemo(): void {
  stalenessMemo.clear();
}
