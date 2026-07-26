/**
 * One loaded traversal structure per artifact generation
 * (change: optimize-reachability-precompute).
 *
 * The handlers used to rebuild `Map<string, Set<string>>` adjacency on every tool
 * call. They now ask this module for the shared {@link TraversalIndex} instead.
 *
 * INVALIDATION rides entirely on object identity, so it cannot drift: the memo is
 * a `WeakMap` keyed on the `SerializedCallGraph` object itself. `readCachedContext`
 * hands out one context object per `llm-context.json` generation and replaces it
 * wholesale when the file's mtime moves — so a new generation is a new `callGraph`
 * object, which is a memo miss, which reloads. An externally-run `openlore analyze`
 * that rewrites the artifact under a warm daemon therefore cannot be answered from
 * the old structure; there is no cached-generation bookkeeping to get wrong, and a
 * garbage-collected context takes its structure with it.
 *
 * The persisted artifact is an optimization on top of that, never a source of
 * truth: it is accepted only when its `contextDigest` matches the digest of the
 * `llm-context.json` bytes the served graph was parsed from. Anything else —
 * absent, stale, truncated, wrong schema version, foreign endianness — falls back
 * to building the structure in memory. A slower correct answer always wins.
 *
 * TRUST BOUNDARY, stated plainly. The digest check proves the structure was
 * written alongside THESE artifact bytes; it is not a signature, so it does not
 * prove the structure faithfully describes that graph. A writer with a lying
 * digest could serve a wrong traversal — but such a writer already has write
 * access to `.openlore/analysis/`, where `llm-context.json` (the graph itself) sits
 * beside it and is exactly as forgeable. This artifact therefore adds no new trust
 * surface: it is trusted precisely as far as the graph artifact is, and never
 * further. Verifying the structure against the graph would cost the O(N+E) rebuild
 * it exists to avoid, and would buy nothing an attacker could not get by editing
 * the graph directly.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_TRAVERSAL_INDEX } from '../../../constants.js';
import {
  buildTraversalIndex,
  deserializeTraversalIndex,
  type TraversalIndex,
} from '../../analyzer/condensation.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';

/**
 * Hard ceiling on the persisted structure before we read it, mirroring the
 * `ARTIFACT_MAX_BYTES` guard `llm-context.json` already carries (mcp-security:
 * Untrusted Artifact Deserialization). The structure lives in the same untrusted
 * `.openlore/analysis/` directory but was, unlike its sibling, unbounded — a
 * genuinely new size surface. Real structures run ~10% of the context they
 * accompany; this exists only to fail closed on a poisoned or runaway file.
 */
const TRAVERSAL_INDEX_MAX_BYTES = 512 * 1024 * 1024;

/** The path the structure is persisted at for `absDir`. */
function indexPath(absDir: string): string {
  return join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_TRAVERSAL_INDEX);
}

/**
 * Whether a persisted structure exists for `absDir`. Lets the read path skip
 * digesting the (multi-MB) analysis artifact when there is nothing to unlock —
 * see the call site in `readCachedContext`.
 */
export async function traversalIndexExists(analysisDir: string): Promise<boolean> {
  try {
    return (await stat(join(analysisDir, ARTIFACT_TRAVERSAL_INDEX))).isFile();
  } catch {
    return false;
  }
}

/** Loaded/built structures, one per graph generation. */
const indexByGraph = new WeakMap<SerializedCallGraph, TraversalIndex>();

/** Digest of the artifact bytes each served graph was parsed from. */
const digestByGraph = new WeakMap<SerializedCallGraph, string>();

/**
 * Record the `llm-context.json` content digest for a just-parsed graph. Called by
 * `readCachedContext` on the cold path; without it the persisted structure cannot
 * be validated and is simply not used.
 */
export function recordArtifactDigest(cg: SerializedCallGraph, digest: string): void {
  digestByGraph.set(cg, digest);
}

/**
 * The traversal structure for `cg`, built in memory and memoized for this
 * generation. Synchronous — for the pure, sync computations (`computeFootprint`,
 * called once per task in `plan_parallel_work` / `map_in_flight_conflicts`) that
 * cannot become async without rippling through their callers.
 */
export function traversalIndexFor(cg: SerializedCallGraph): TraversalIndex {
  let ix = indexByGraph.get(cg);
  if (!ix) {
    ix = buildTraversalIndex(cg);
    indexByGraph.set(cg, ix);
  }
  return ix;
}

/**
 * The traversal structure for `cg`, preferring the one persisted next to the
 * analysis artifacts. Memoized per generation, so the disk read and the digest
 * check happen at most once per `openlore analyze`, not once per tool call.
 */
export async function loadTraversalIndex(
  absDir: string,
  cg: SerializedCallGraph,
): Promise<TraversalIndex> {
  const memo = indexByGraph.get(cg);
  if (memo) return memo;

  const digest = digestByGraph.get(cg);
  if (digest !== undefined) {
    try {
      const path = indexPath(absDir);
      const st = await stat(path);
      if (st.size > TRAVERSAL_INDEX_MAX_BYTES) return traversalIndexFor(cg);
      const raw = await readFile(path, 'utf-8');
      const loaded = deserializeTraversalIndex(raw, digest);
      if (loaded) {
        // Re-check the memo: a concurrent request may have built one across our
        // await. Whichever lands first wins — both are equivalent by construction,
        // and sharing one keeps a single structure live per generation.
        const raced = indexByGraph.get(cg);
        if (raced) return raced;
        indexByGraph.set(cg, loaded);
        return loaded;
      }
    } catch {
      // No artifact, unreadable, or not parseable — build it instead.
    }
  }
  return traversalIndexFor(cg);
}
