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

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { ARTIFACT_FINGERPRINT, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR } from '../../../constants.js';
import { gitPathArgs } from '../../../utils/git-args.js';
import type { IndexIntegrity } from '../../analyzer/index-attestation.js';
import { repairStatusFor, REPAIR_REASON_DETAIL } from '../cold-start-bootstrap.js';

const execFileAsync = promisify(execFile);

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

export type KnownUnknowableKind = 'synthesized-dispatch' | 'unindexed-repo';

/** A boundary the computation is known to be unable to see past. */
export interface KnownUnknowableCrossing {
  kind: KnownUnknowableKind;
  /** The synthesis rule, when kind === 'synthesized-dispatch'. */
  rule?: string;
  count: number;
  /** Actionable, human-readable disclosure. */
  detail: string;
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
   * True iff the computation crossed no boundary: no synthesized-edge reliance, no
   * known-unknowable crossing, a current index, AND a reconciled (non-degraded,
   * non-mismatched) index. The answer-level NoFalseCompleteness flag — an incomplete
   * answer is never dressed as complete.
   */
  complete: boolean;
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
 * The repair-in-progress marker for a directory, or undefined when no background
 * repair is running. Handlers pass this into {@link assembleBoundary} so a stale
 * answer served during a self-heal is disclosed as *repairing*, not silently stale
 * (change: make-index-self-healing).
 */
export function repairDisclosure(directory: string): RepairInProgressMarker | undefined {
  const status = repairStatusFor(directory);
  if (!status) return undefined;
  return {
    inProgress: true,
    reason: status.reason,
    detail:
      `A background index refresh has started (${REPAIR_REASON_DETAIL[status.reason]}); this answer ` +
      `was served from the stale index without waiting. Re-run for fresh results once it completes.`,
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
    const { stdout } = await execFileAsync('git', gitPathArgs('diff', '--name-only', commit, '--'), { cwd: absDir });
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((f) => f.length > 0 && GRAPH_SOURCE_EXTS.has(extname(f)))
      .length;
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
): Promise<StalenessAssessment> {
  const memoKey = `${absDir}\0${analysisDir}`;
  const memo = stalenessMemo.get(memoKey);
  if (memo && now - memo.at < STALENESS_TTL_MS) return memo.value;

  const commit = await readBuildCommit(absDir, analysisDir);
  const changed = commit ? await countSourceChangedSince(absDir, commit) : null;
  const value = {
    indexCommit: commit,
    changedSourceFiles: changed,
    marker: buildStalenessMarker(commit, changed),
  };
  stalenessMemo.set(memoKey, { at: now, value });
  return value;
}

/**
 * Assemble a boundary from its parts and derive `complete`. The synthesized-edge
 * crossings are derived from the basis; callers may add extra crossings (e.g. an
 * unindexed federated repo). An answer is complete only when nothing was crossed
 * and the index is current.
 */
export function assembleBoundary(parts: {
  basis?: EdgeBasis;
  extraCrossings?: KnownUnknowableCrossing[];
  staleness?: StalenessMarker;
  integrity?: IndexIntegrity;
  repair?: RepairInProgressMarker;
}): ConfidenceBoundary {
  const crossings = [
    ...(parts.basis ? crossingsFromBasis(parts.basis) : []),
    ...(parts.extraCrossings ?? []),
  ];
  const integrity = integrityDisclosure(parts.integrity);
  const boundary: ConfidenceBoundary = {
    complete: crossings.length === 0 && !parts.staleness && !integrity && !parts.repair,
  };
  if (parts.basis) boundary.basis = parts.basis;
  if (crossings.length > 0) boundary.knownUnknowable = crossings;
  if (parts.staleness) boundary.staleness = parts.staleness;
  if (integrity) boundary.integrity = integrity;
  if (parts.repair) boundary.repair = parts.repair;
  return boundary;
}

/** Reset the staleness memo — test-only hook so a stubbed fingerprint is re-read. */
export function __resetStalenessMemo(): void {
  stalenessMemo.clear();
}
