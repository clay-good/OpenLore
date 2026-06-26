/**
 * Federation resolver — the deterministic cross-repo primitive.
 *
 * Given a symbol published by the home repo, find its *consumers* across the
 * federated repos in scope. A consumer is a function in another indexed repo that
 * calls the symbol as an unresolved external reference (the producer doesn't live
 * in that repo). The match is exact on the symbol-name descriptor of the
 * producer's content-addressed stable ID — honest that arity is unconfirmed at an
 * external call site, and that a bare exported-name collision across packages is
 * possible. Repos that are unindexed / stale / missing are reported as
 * not-consulted, never guessed.
 *
 * No merged graph: each repo's index is loaded lazily, on demand, via the same
 * `readCachedContext` used for single-repo queries.
 *
 * See decisions bf5aff2d (registry) + 67ca60fe (resolution contract).
 */

import { resolve, isAbsolute, extname } from 'node:path';
import { readCachedContext } from '../services/mcp-handlers/utils.js';
import { isTestFile } from '../analyzer/test-file.js';
import type { SerializedCallGraph, FunctionNode } from '../analyzer/call-graph.js';
import { extractHttpCalls, buildHttpEdges, type RouteDefinition } from '../analyzer/http-route-parser.js';
import { listRepos, repoStatus } from './registry.js';
import type { ConsultedRepo, FederationCoverage, FederationRepoEntry } from './types.js';

/** JS/TS extensions OpenLore extracts outbound HTTP client call sites from. */
const HTTP_CLIENT_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

/** Default cap on cross-repo consumers returned, to keep conclusions bounded. */
export const DEFAULT_MAX_CONSUMERS = 200;

/** The federation scope a single query runs against. */
export interface FederationScope {
  /** True when federation is active for this query. */
  active: boolean;
  /** Registry entries selected for this query (a named subset, or all). */
  repos: FederationRepoEntry[];
  /** Names requested via federationRepos that aren't in the registry. */
  unknownNames: string[];
}

/**
 * Resolve a federation scope from handler args. Federation is opt-in: inactive
 * unless `federation` is true or `federationRepos` names at least one repo.
 */
export function resolveFederationScope(
  homeDir: string,
  opts: { federation?: boolean; federationRepos?: string[] } = {},
): FederationScope {
  const requested = (opts.federationRepos ?? []).map(s => s.trim()).filter(Boolean);
  const active = opts.federation === true || requested.length > 0;
  if (!active) return { active: false, repos: [], unknownNames: [] };

  const all = listRepos(homeDir);
  if (requested.length === 0) {
    return { active: true, repos: all, unknownNames: [] };
  }
  const byName = new Map(all.map(r => [r.name, r]));
  const repos: FederationRepoEntry[] = [];
  const unknownNames: string[] = [];
  for (const name of requested) {
    const entry = byName.get(name);
    if (entry) repos.push(entry);
    else unknownNames.push(name);
  }
  return { active: true, repos, unknownNames };
}

/** A consuming call site in a federated repo. */
export interface CrossRepoConsumer {
  /** Federated repo name (from the registry). */
  repo: string;
  repoPath: string;
  /** The consuming function in that repo. */
  caller: { id: string; name: string; file: string };
  /** The published symbol name it references. */
  symbol: string;
}

export interface CrossRepoConsumerResult {
  symbol: string;
  consumers: CrossRepoConsumer[];
  /** Number of consumers dropped by the cap, if any. */
  truncated: number;
  coverage: FederationCoverage;
}

/** Result of a multi-symbol cross-repo consumer lookup. */
export interface CrossRepoConsumerBatch {
  /** symbol name → its consumers across scoped repos. */
  bySymbol: Map<string, CrossRepoConsumer[]>;
  truncated: number;
  coverage: FederationCoverage;
}

/**
 * Find consumers for many published symbols at once, loading each scoped repo's
 * index exactly once. This is the core primitive; the single-symbol form wraps it.
 */
export async function findCrossRepoConsumersBatch(
  scope: FederationScope,
  symbols: string[],
  opts: { maxConsumers?: number } = {},
): Promise<CrossRepoConsumerBatch> {
  const cap = Math.max(1, opts.maxConsumers ?? DEFAULT_MAX_CONSUMERS);
  const wanted = [...new Set(symbols.filter(Boolean))];
  const bySymbol = new Map<string, CrossRepoConsumer[]>(wanted.map(s => [s, []]));
  const reposConsulted: ConsultedRepo[] = [];
  const reposSkipped: ConsultedRepo[] = [];
  let total = 0;
  let truncated = 0;

  for (const entry of scope.repos) {
    const status = repoStatus(entry, true);
    if (status.state !== 'indexed') {
      reposSkipped.push(status);
      continue;
    }
    // Per-repo isolation: a store that opens fine but throws mid-query (SQLite
    // corruption on an untouched page, disk error, DB locked by a concurrent
    // analyze) must NOT abort the whole fleet query — skip that repo with a reason.
    // Critical for find_dead_code: a thrown federation lookup would otherwise drop
    // the cross-repo liveness check and risk a confidently-wrong "safe to delete".
    try {
      const ctx = await readCachedContext(resolve(entry.path));
      if (!ctx?.edgeStore) {
        reposSkipped.push({
          ...status,
          consulted: false,
          reason: 'index present but has no edge store (call-graph.db) — re-run "openlore analyze"',
        });
        continue;
      }
      for (const symbol of wanted) {
        const edges = ctx.edgeStore.getExternalConsumers(symbol);
        const seenCallers = new Set<string>();
        const list = bySymbol.get(symbol)!;
        for (const edge of edges) {
          if (seenCallers.has(edge.callerId)) continue;
          seenCallers.add(edge.callerId);
          // The cap bounds the consumer *list*, but must never zero a symbol's
          // liveness signal: always keep at least one consumer per symbol-with-edges
          // even past the cap, then truncate the rest. Without this, a multi-symbol
          // batch (e.g. find_dead_code over many candidates) where an earlier symbol
          // exhausts the shared cap would leave a later, genuinely-consumed symbol
          // with an empty list — and find_dead_code would flip it to a false-positive
          // "dead" (a confidently-wrong "safe to delete"). See decision 67ca60fe.
          if (list.length >= 1 && total >= cap) { truncated++; continue; }
          total++;
          const node = ctx.edgeStore.getNode(edge.callerId);
          list.push({
            repo: entry.name,
            repoPath: entry.path,
            caller: {
              id: edge.callerId,
              name: node?.name ?? edge.callerId.split('::').pop() ?? edge.callerId,
              file: node?.filePath ?? edge.callerId.split('::')[0] ?? '',
            },
            symbol,
          });
        }
      }
      reposConsulted.push(status); // only after a full, successful read
    } catch (err) {
      reposSkipped.push({
        ...status,
        consulted: false,
        reason: `index unreadable mid-query — skipped: ${(err as Error).message}`,
      });
    }
  }

  const caveats: string[] = [];
  if (total > 0) {
    caveats.push(
      'Cross-repo consumers are matched by exact symbol name at external call sites; ' +
        'call-site signatures are unavailable, so overload/arity is unconfirmed and a ' +
        'bare exported-name collision across packages is possible.',
    );
  }
  if (scope.unknownNames.length > 0) {
    caveats.push(`Requested repos not in the registry (ignored): ${scope.unknownNames.join(', ')}.`);
  }

  return { bySymbol, truncated, coverage: { applied: true, reposConsulted, reposSkipped, caveats } };
}

/**
 * Find consumers of a single published symbol across the scoped repos. Loads each
 * indexed repo's edge store lazily; skips (and reports) unindexed/stale/missing
 * repos and repos whose index has no SQLite edge store.
 */
export async function findCrossRepoConsumers(
  scope: FederationScope,
  symbol: string,
  opts: { maxConsumers?: number } = {},
): Promise<CrossRepoConsumerResult> {
  const batch = await findCrossRepoConsumersBatch(scope, [symbol], opts);
  return {
    symbol,
    consumers: batch.bySymbol.get(symbol) ?? [],
    truncated: batch.truncated,
    coverage: batch.coverage,
  };
}

/** A scoped repo that defines a symbol of a given name (the producer side). */
export interface SymbolProducer {
  repo: string;
  repoPath: string;
  node: { id: string; name: string; file: string; stableId?: string };
}

/**
 * Locate which scoped repos *define* a symbol of this exact name (an internal,
 * non-test node). Used by federated find_path to name the repo that publishes a
 * `to` endpoint that doesn't live in the home repo.
 */
export async function locateSymbolProducers(
  scope: FederationScope,
  symbolName: string,
): Promise<{ producers: SymbolProducer[]; coverage: FederationCoverage }> {
  const producers: SymbolProducer[] = [];
  const reposConsulted: ConsultedRepo[] = [];
  const reposSkipped: ConsultedRepo[] = [];
  for (const entry of scope.repos) {
    const status = repoStatus(entry, true);
    if (status.state !== 'indexed') { reposSkipped.push(status); continue; }
    // Per-repo isolation: a mid-query store throw must not abort the fleet query.
    try {
      const ctx = await readCachedContext(resolve(entry.path));
      if (!ctx?.edgeStore) {
        reposSkipped.push({ ...status, consulted: false, reason: 'no edge store — re-run "openlore analyze"' });
        continue;
      }
      for (const node of ctx.edgeStore.searchNodes(symbolName, 50)) {
        if (node.name === symbolName && !node.isExternal && !node.isTest) {
          producers.push({
            repo: entry.name,
            repoPath: entry.path,
            node: { id: node.id, name: node.name, file: node.filePath, stableId: node.stableId },
          });
        }
      }
      reposConsulted.push(status);
    } catch (err) {
      reposSkipped.push({ ...status, consulted: false, reason: `index unreadable mid-query — skipped: ${(err as Error).message}` });
    }
  }
  return { producers, coverage: { applied: true, reposConsulted, reposSkipped, caveats: [] } };
}

/** A cross-repo client call site that targets a home-repo route handler. */
export interface CrossRepoClientCaller {
  repo: string;
  repoPath: string;
  /** The enclosing function of the client call in the consuming repo. */
  caller: { id: string; name: string; file: string };
  /** The HTTP method + normalized path the call targets (the matched route key). */
  method: string;
  path: string;
  /** Match strength, identical to the single-repo `http_endpoint` tiers. */
  confidence: 'exact' | 'path' | 'fuzzy';
}

export interface CrossRepoClientCallerResult {
  callers: CrossRepoClientCaller[];
  /** Number of callers dropped by the cap, if any. */
  truncated: number;
  coverage: FederationCoverage;
}

/**
 * Find outbound HTTP client call sites across the scoped repos that target one of
 * the given home-repo route handlers. This is the cross-service counterpart to
 * {@link findCrossRepoConsumersBatch}: federation's name-based resolver cannot
 * bridge a client→handler hop, because the call site references a URL, not the
 * handler's symbol — so we match on the normalized ROUTE KEY instead, via the exact
 * same {@link buildHttpEdges} the single-repo `http_endpoint` edge is built from
 * (identical exact/path/fuzzy semantics, no divergent matcher).
 *
 * Each scoped repo's index is loaded once; its JS/TS source files are re-read to
 * extract client call sites (calls are not persisted in the index) and matched
 * against `homeRoutes`, with the enclosing function reported as the consumer.
 * Read-only, deterministic, opt-in; unindexed/stale/unreadable repos are reported,
 * never guessed. (Re-reading source per query, rather than a persisted client-call
 * index, keeps this self-contained in the federation layer; persisting the index is
 * a future optimization.)
 */
export async function findCrossRepoClientCallers(
  scope: FederationScope,
  homeRoutes: RouteDefinition[],
  opts: { maxConsumers?: number } = {},
): Promise<CrossRepoClientCallerResult> {
  const cap = Math.max(1, opts.maxConsumers ?? DEFAULT_MAX_CONSUMERS);
  const callers: CrossRepoClientCaller[] = [];
  const reposConsulted: ConsultedRepo[] = [];
  const reposSkipped: ConsultedRepo[] = [];
  let truncated = 0;
  if (homeRoutes.length === 0) {
    return { callers, truncated, coverage: { applied: true, reposConsulted, reposSkipped, caveats: [] } };
  }

  for (const entry of scope.repos) {
    const status = repoStatus(entry, true);
    if (status.state !== 'indexed') { reposSkipped.push(status); continue; }
    // Per-repo isolation: a malformed index / mid-query throw must not abort the fleet query.
    try {
      const ctx = await readCachedContext(resolve(entry.path));
      const cg = ctx?.callGraph as SerializedCallGraph | undefined;
      if (!cg) {
        reposSkipped.push({ ...status, consulted: false, reason: 'no call graph — re-run "openlore analyze"' });
        continue;
      }
      // Group the repo's non-external, non-test JS/TS nodes by file — the files that
      // could hold a client call site. Sorted for a deterministic read order.
      const nodesByFile = new Map<string, FunctionNode[]>();
      for (const n of cg.nodes) {
        if (n.isExternal || n.isTest || isTestFile(n.filePath)) continue;
        if (!HTTP_CLIENT_EXTS.has(extname(n.filePath).toLowerCase())) continue;
        (nodesByFile.get(n.filePath) ?? nodesByFile.set(n.filePath, []).get(n.filePath)!).push(n);
      }
      for (const file of [...nodesByFile.keys()].sort()) {
        const abs = isAbsolute(file) ? file : resolve(entry.path, file);
        let calls;
        try { calls = await extractHttpCalls(abs); }
        catch { continue; } // a single unreadable file never aborts the repo
        // Match this file's calls against the home routes with the single-repo matcher.
        for (const he of buildHttpEdges(calls, homeRoutes)) {
          const enclosing = enclosingByLine(nodesByFile.get(file)!, he.call.line);
          if (!enclosing) continue;
          if (callers.length >= cap) { truncated++; continue; }
          callers.push({
            repo: entry.name,
            repoPath: entry.path,
            caller: { id: enclosing.id, name: enclosing.name, file },
            method: he.method,
            path: he.path,
            confidence: he.confidence,
          });
        }
      }
      reposConsulted.push(status); // only after a full, successful read
    } catch (err) {
      reposSkipped.push({ ...status, consulted: false, reason: `index unreadable mid-query — skipped: ${(err as Error).message}` });
    }
  }

  // Deterministic order, independent of file-read scheduling.
  callers.sort((a, b) =>
    a.repo < b.repo ? -1 : a.repo > b.repo ? 1 :
    a.caller.id < b.caller.id ? -1 : a.caller.id > b.caller.id ? 1 :
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const caveats: string[] = [];
  if (callers.length > 0) {
    caveats.push(
      'Cross-service consumers are matched by normalized HTTP route key (method + path) at client ' +
        'call sites; a dynamically-constructed path or base URL resolves to nothing and is never linked.',
    );
  }
  if (scope.unknownNames.length > 0) {
    caveats.push(`Requested repos not in the registry (ignored): ${scope.unknownNames.join(', ')}.`);
  }
  return { callers, truncated, coverage: { applied: true, reposConsulted, reposSkipped, caveats } };
}

/** Innermost enclosing function of a 1-based line, by node start/end line ranges. */
function enclosingByLine(nodes: FunctionNode[], line: number): FunctionNode | undefined {
  let best: FunctionNode | undefined;
  let bestSpan = Infinity;
  for (const n of nodes) {
    if (n.startLine === undefined || n.endLine === undefined) continue;
    if (line < n.startLine || line > n.endLine) continue;
    const span = n.endLine - n.startLine;
    if (span < bestSpan) { best = n; bestSpan = span; }
  }
  return best;
}

/**
 * Backward reachability to test nodes within a single loaded repo's call graph:
 * from a set of seed node IDs, walk callers up to `maxDepth` and collect any test
 * reached. Two discovery sources, matching the single-repo select_tests handler:
 *   1. test *nodes* reached by the backward call-walk, and
 *   2. `tested_by` edges on any reached production node (incl. the seeds) — the
 *      import-based test association the analyzer emits for a real test file, where
 *      the test is NOT a call-graph caller node (e.g. an inline `it(...)` block).
 * Source 2 is the common real-world case; without it a consumer repo whose tests
 * are detected by import association selects nothing across the boundary.
 *
 * Traverses the in-memory `SerializedCallGraph`, NOT the SQLite edge store: the
 * store persists only production nodes, so test nodes / tested_by edges exist
 * *only* in the call graph (the same reason the single-repo handler uses ctx.callGraph).
 */
export function findReachingTests(
  cg: SerializedCallGraph,
  seedIds: string[],
  maxDepth = 12,
  opts: { directResolvedOnly?: boolean } = {},
): Array<{ id: string; name: string; file: string; depth: number }> {
  const nodeById = new Map<string, FunctionNode>(cg.nodes.map(n => [n.id, n]));
  const nameToIds = new Map<string, string[]>();
  for (const n of cg.nodes) {
    if (!nameToIds.has(n.name)) nameToIds.set(n.name, []);
    nameToIds.get(n.name)!.push(n.id);
  }
  // Backward adjacency: callee id → caller ids. Resolve each edge's callee to a
  // node id (prefer the resolved calleeId; fall back to a unique name match).
  const callersOf = new Map<string, Set<string>>();
  // tested_by association: production node id → its test(s), keyed off the edge's
  // callee (the test file/symbol). The same edge the single-repo handler reads.
  const testedByOf = new Map<string, Array<{ name: string; file: string }>>();
  for (const e of cg.edges) {
    if (e.kind === 'tested_by') {
      const file = e.calleeId.includes('::') ? e.calleeId.split('::')[0] : e.calleeId;
      if (!testedByOf.has(e.callerId)) testedByOf.set(e.callerId, []);
      testedByOf.get(e.callerId)!.push({ name: e.calleeName, file });
      continue;
    }
    // Strict mode: ignore synthesized dynamic-dispatch edges so the cross-repo
    // walk rests only on directly-resolved calls, matching the single-repo
    // handler's `directResolvedOnly` (tested_by associations are still honored).
    if (opts.directResolvedOnly && e.confidence === 'synthesized') continue;
    let calleeId: string | undefined = e.calleeId && nodeById.has(e.calleeId) ? e.calleeId : undefined;
    if (!calleeId) {
      const byName = nameToIds.get(e.calleeName);
      if (byName && byName.length === 1) calleeId = byName[0];
    }
    if (!calleeId) continue;
    if (!callersOf.has(calleeId)) callersOf.set(calleeId, new Set());
    callersOf.get(calleeId)!.add(e.callerId);
  }

  const isTest = (n: FunctionNode | undefined): boolean => !!n && (n.isTest || isTestFile(n.filePath));
  const tests: Array<{ id: string; name: string; file: string; depth: number }> = [];
  // Dedup across both sources on file+name so a test reached as a call node and a
  // tested_by target is reported once.
  const seenTest = new Set<string>();
  const emit = (name: string, file: string, depth: number): void => {
    const key = `${file}\0${name}`;
    if (seenTest.has(key)) return;
    seenTest.add(key);
    tests.push({ id: key, name, file, depth });
  };
  // tested_by on a seed: the test directly exercises the consumer call site (depth 1).
  for (const s of new Set(seedIds)) {
    for (const t of testedByOf.get(s) ?? []) emit(t.name, t.file, 1);
  }
  const visited = new Set<string>(seedIds);
  let frontier = [...new Set(seedIds)];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const callerId of callersOf.get(id) ?? []) {
        if (visited.has(callerId)) continue;
        visited.add(callerId);
        const node = nodeById.get(callerId);
        if (isTest(node)) emit(node!.name, node!.filePath, depth);
        for (const t of testedByOf.get(callerId) ?? []) emit(t.name, t.file, depth);
        next.push(callerId);
      }
    }
    frontier = next;
  }
  return tests;
}

/** A test in a federated repo that transitively reaches a cross-repo consumer. */
export interface CrossRepoTest {
  repo: string;
  repoPath: string;
  test: { name: string; file: string };
  /** The published symbol whose consumer (in this repo) the test reaches. */
  viaSymbol: string;
  /** Backward hop distance from the consumer to the test. */
  depth: number;
}

/**
 * Federated test selection: for published symbols changed in the home repo, find
 * tests across scoped consumer repos that transitively reach a call site of those
 * symbols. Each repo's index is loaded once; backward reachability runs locally.
 */
export async function findCrossRepoTests(
  scope: FederationScope,
  symbols: string[],
  opts: { maxDepth?: number; directResolvedOnly?: boolean } = {},
): Promise<{ tests: CrossRepoTest[]; coverage: FederationCoverage }> {
  const wanted = [...new Set(symbols.filter(Boolean))];
  const maxDepth = Math.max(1, opts.maxDepth ?? 12);
  const tests: CrossRepoTest[] = [];
  const reposConsulted: ConsultedRepo[] = [];
  const reposSkipped: ConsultedRepo[] = [];

  const wantedSet = new Set(wanted);
  for (const entry of scope.repos) {
    const status = repoStatus(entry, true);
    if (status.state !== 'indexed') { reposSkipped.push(status); continue; }
    // Per-repo isolation: a malformed index / mid-query throw must not abort the
    // whole fleet query — skip that repo with a reason.
    try {
      const ctx = await readCachedContext(resolve(entry.path));
      const cg = ctx?.callGraph as SerializedCallGraph | undefined;
      if (!cg) {
        reposSkipped.push({ ...status, consulted: false, reason: 'no call graph — re-run "openlore analyze"' });
        continue;
      }
      // Consumer seeds, grouped by the published symbol they consume: each external
      // call site in this repo to a wanted symbol. Walking each symbol's seeds
      // separately attributes every reached test to the *specific* symbol whose
      // consumer reached it — not a blanket join of all symbols this repo touches.
      const seedsBySymbol = new Map<string, string[]>();
      for (const edge of cg.edges) {
        if (edge.confidence !== 'external' || !wantedSet.has(edge.calleeName)) continue;
        const seeds = seedsBySymbol.get(edge.calleeName) ?? [];
        if (!seeds.includes(edge.callerId)) seeds.push(edge.callerId);
        seedsBySymbol.set(edge.calleeName, seeds);
      }
      // (no early-out for empty seeds — the loop below is simply a no-op, and the
      // repo is still correctly counted as consulted.)
      for (const [viaSymbol, seedIds] of seedsBySymbol) {
        const reached = findReachingTests(cg, seedIds, maxDepth, { directResolvedOnly: opts.directResolvedOnly });
        for (const t of reached) {
          tests.push({ repo: entry.name, repoPath: entry.path, test: { name: t.name, file: t.file }, viaSymbol, depth: t.depth });
        }
      }
      reposConsulted.push(status);
    } catch (err) {
      reposSkipped.push({ ...status, consulted: false, reason: `index unreadable mid-query — skipped: ${(err as Error).message}` });
    }
  }

  const caveats: string[] = [];
  if (tests.length > 0) {
    caveats.push('Cross-repo tests are selected by exact symbol-name match at external call sites; over-approximate, and dynamic dispatch in consumer repos can under-select.');
  }
  if (scope.unknownNames.length > 0) {
    caveats.push(`Requested repos not in the registry (ignored): ${scope.unknownNames.join(', ')}.`);
  }
  return { tests, coverage: { applied: true, reposConsulted, reposSkipped, caveats } };
}

/** An empty/inactive coverage block (federation not requested). */
export function inactiveCoverage(): FederationCoverage {
  return { applied: false, reposConsulted: [], reposSkipped: [], caveats: [] };
}
