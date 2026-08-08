/**
 * Fleet-level anchored memory (ADR-0019; federation group 4 + cross-agent intent
 * handoff, item 3). The intersection of federation and bitemporal anchored memory:
 * a memory recorded in a producer repo and anchored to an interface it publishes
 * surfaces, with its freshness verdict, when an agent recalls while editing a
 * consumer repo.
 *
 * Direction: the HOME repo (where recall runs) is the consumer. Its external call
 * references (`confidence === 'external'`) name the upstream interfaces it uses.
 * For each scoped producer repo we load its index + memory store ONCE, select the
 * memories anchored to one of those interfaces, and compute each memory's freshness
 * against the PRODUCER's graph — so the authoritative-recall invariant holds across
 * the boundary (an orphaned producer anchor is withheld, exactly as in-repo).
 *
 * Deterministic, no LLM, no merged graph (each repo loaded lazily). Cross-repo
 * identity is name-only — arity/overload is unavailable at an external call site,
 * the same honest caveat the rest of federation carries.
 */
import { resolve } from 'node:path';
import { readCachedContext } from '../services/mcp-handlers/utils.js';
import { loadMemoryStore } from '../decisions/memory-store.js';
import { loadDecisionStore, INACTIVE_STATUSES } from '../decisions/store.js';
import { makeFreshnessView } from '../decisions/anchor-adapter.js';
import { memoryFreshness, decisionAnchors } from '../decisions/anchor.js';
import { repoStatus } from './registry.js';
import type { FederationScope } from './resolver.js';
import type { ConsultedRepo, FederationCoverage } from './types.js';
import type { MemoryFreshness, StructuralAnchor } from '../../types/index.js';
import { decisionContentProvenance, type ServedContentProvenance } from '../services/served-content.js';

/** Default cap on fleet records returned (per kind), to keep the recall conclusion bounded. */
export const DEFAULT_MAX_FLEET_MEMORIES = 50;

/** A producer-repo memory about an interface the home repo consumes. */
export interface FleetMemory {
  /** Producer repo name (from the registry). */
  repo: string;
  /** The published interface this memory is anchored to (and that home references). */
  symbol: string;
  /** Producer-side file the anchor points at. */
  filePath: string;
  content: string;
  provenance: ServedContentProvenance;
  /** Freshness against the PRODUCER's graph; `orphaned` is withheld, never returned. */
  freshness: Exclude<MemoryFreshness, 'orphaned'>;
  type?: string;
  recordedAt: string;
}

/** A producer-repo decision about an interface the home repo consumes. */
export interface FleetDecision {
  repo: string;
  symbol: string;
  filePath: string;
  title: string;
  provenance: ServedContentProvenance;
  status: string;
  /** Freshness against the PRODUCER's graph; `orphaned` is withheld, never returned. */
  freshness: Exclude<MemoryFreshness, 'orphaned'>;
  recordedAt: string;
}

export interface FleetMemoryResult {
  memories: FleetMemory[];
  decisions: FleetDecision[];
  truncated: number;
  coverage: FederationCoverage;
}

/** First anchor whose symbol the home repo consumes (with a defined symbolName). */
function consumedAnchor(anchors: readonly StructuralAnchor[], consumedNames: ReadonlySet<string>): (StructuralAnchor & { symbolName: string }) | undefined {
  return anchors.find((a): a is StructuralAnchor & { symbolName: string } =>
    a.symbolName !== undefined && consumedNames.has(a.symbolName));
}

/**
 * Select fleet-level memories for the home (consumer) repo. Returns memories from
 * the scoped producer repos that are anchored to an interface the home repo
 * references, each with its producer-side verdict. Orphaned/retired memories are
 * withheld; the result is bounded and names the repos consulted/skipped.
 */
export async function findFleetMemory(
  homeDir: string,
  scope: FederationScope,
  opts: { maxMemories?: number } = {},
): Promise<FleetMemoryResult> {
  const cap = Math.max(1, opts.maxMemories ?? DEFAULT_MAX_FLEET_MEMORIES);
  const reposConsulted: ConsultedRepo[] = [];
  const reposSkipped: ConsultedRepo[] = [];
  const memories: FleetMemory[] = [];
  const decisions: FleetDecision[] = [];
  let truncated = 0;

  // The upstream interfaces the home repo consumes from the fleet.
  const homeCtx = await readCachedContext(resolve(homeDir));
  if (!homeCtx?.edgeStore) {
    return { memories, decisions, truncated, coverage: { applied: true, reposConsulted, reposSkipped, caveats: ['home repo has no edge store — re-run "openlore analyze"'] } };
  }
  const consumedNames = new Set(homeCtx.edgeStore.getExternalReferenceNames());
  if (consumedNames.size === 0) {
    return { memories, decisions, truncated, coverage: { applied: true, reposConsulted, reposSkipped, caveats: [] } };
  }

  for (const entry of scope.repos) {
    const status = repoStatus(entry, true);
    if (!status.consulted) { reposSkipped.push(status); continue; }
    const repoPath = resolve(entry.path);
    const ctx = await readCachedContext(repoPath);
    if (!ctx?.edgeStore) {
      reposSkipped.push({ ...status, consulted: false, reason: 'index present but has no edge store (call-graph.db) — re-run "openlore analyze"' });
      continue;
    }
    reposConsulted.push(status);
    const view = makeFreshnessView(ctx.edgeStore, repoPath);

    // Memories anchored to a consumed interface (retired ones excluded).
    const memStore = await loadMemoryStore(repoPath);
    for (const m of memStore.memories) {
      if (m.invalidatedAt) continue;                         // retired — authoritative-recall invariant
      const anchor = consumedAnchor(m.anchors, consumedNames);
      if (!anchor) continue;                                 // not about an interface home consumes
      const f = memoryFreshness(m.anchors, view);
      if (f.freshness === 'orphaned') continue;              // anchor gone in producer — withheld
      if (memories.length >= cap) { truncated++; continue; }
      memories.push({
        repo: entry.name,
        symbol: anchor.symbolName,
        filePath: anchor.filePath,
        content: m.content,
        provenance: 'foreign-actor',
        freshness: f.freshness,
        ...(m.type ? { type: m.type } : {}),
        recordedAt: m.recordedAt,
      });
    }

    // Decisions anchored to a consumed interface (inactive ones excluded — the same
    // lifecycle gate single-repo recall/orient applies). Freshness from the producer's
    // graph; orphaned withheld.
    const decStore = await loadDecisionStore(repoPath);
    for (const d of decStore.decisions) {
      if (INACTIVE_STATUSES.has(d.status)) continue;
      const anchors = decisionAnchors(d);
      const anchor = consumedAnchor(anchors, consumedNames);
      if (!anchor) continue;
      const f = memoryFreshness(anchors, view);
      if (f.freshness === 'orphaned') continue;
      if (decisions.length >= cap) { truncated++; continue; }
      decisions.push({
        repo: entry.name,
        symbol: anchor.symbolName,
        filePath: anchor.filePath,
        title: d.title,
        provenance: decisionContentProvenance(d),
        status: d.status,
        freshness: f.freshness,
        recordedAt: d.recordedAt,
      });
    }
  }

  const caveats: string[] = [];
  if (memories.length > 0 || decisions.length > 0 || truncated > 0) {
    caveats.push('Fleet records are matched to an interface by exact symbol name at the home repo\'s external call sites; arity/overload is unconfirmed across the boundary.');
  }
  if (scope.unknownNames.length > 0) {
    caveats.push(`Requested repos not in the registry (ignored): ${scope.unknownNames.join(', ')}.`);
  }
  return { memories, decisions, truncated, coverage: { applied: true, reposConsulted, reposSkipped, caveats } };
}
