/**
 * Reachability & Dead-Code Analysis (spec-20) — cross-language mark-and-sweep
 * over the unified call graph.
 *
 * "Is this reachable from any entry point?", "what is dead?", and "what becomes
 * dead if I delete X?" — graph reachability questions grep can't answer (it sees
 * text, not reach) and the model burns tokens guessing at. Reachability is forward
 * BFS from roots; candidate-dead is the unreached remainder; "dead if I delete X"
 * is the set reachable only through X.
 *
 * Prior art: knip / ts-prune do mark-and-sweep, but TS/JS-only. This is the
 * cross-language version over the tree-sitter graph (15+ languages).
 *
 * HONEST LIMITS — output is *candidates*, never deletion authority. Callback /
 * event-channel and route→handler dispatch is now PARTIALLY recovered via
 * synthesized edges (single-language, statically-paired registration+dispatch;
 * spec: add-synthesized-dynamic-dispatch-edges), and polymorphic dispatch through
 * inheritance/interfaces is recovered via Class Hierarchy Analysis (name+arity,
 * declared-type-narrowed where the receiver type is statically recoverable; spec:
 * add-type-hierarchy-resolved-dispatch). A symbol reachable only through such an
 * edge is no longer reported as high-confidence dead. What remains a blind spot:
 * reflection, computed/string-built dispatch (`obj[name]()`), cross-language
 * bridges and cross-language polymorphism, DI/plugin registries with no
 * statically-visible binding, RTA/VTA-level pruning of the CHA name+arity
 * over-approximation, and externally-consumed public exports — these can still
 * produce false "dead" positives. Roots include tests, imported symbols, and
 * detected framework entries; every candidate carries a confidence level and a
 * reason; nothing is ever auto-deleted. Pass `directResolvedOnly` to ignore
 * synthesized edges and get the strict directly-resolved reachability instead.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateDirectory, readCachedContext } from './utils.js';
import { resolveFederationScope, findCrossRepoConsumersBatch } from '../../federation/resolver.js';
import { buildAdjacency } from './graph.js';
import { assembleBoundary, computeStaleness, edgeBasisWithinSet } from './confidence-boundary.js';
import { isIacLanguage } from '../../analyzer/iac/types.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH } from '../../../constants.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';

export interface FindDeadCodeInput {
  directory: string;
  /** "What becomes dead if I delete this symbol?" — switches to delete-impact mode. */
  ifDeleted?: string;
  /** Limit candidate-dead results (default 100). */
  maxResults?: number;
  /** Only report candidates whose file path contains this substring. */
  filePattern?: string;
  /**
   * Restrict reachability to directly-resolved edges only: synthesized
   * dynamic-dispatch edges are not traversed (spec: add-synthesized-dynamic-dispatch-edges).
   * Trades completeness for certainty — a symbol reachable only through a
   * synthesized edge is then treated as unreached. Default false.
   */
  directResolvedOnly?: boolean;
  /**
   * Opt in to federation scope: a symbol with no consumer in THIS repo may still
   * be live across the fleet. When set, candidates consumed by another indexed
   * repo are pulled out of candidate-dead and reported as live-via-federation.
   * (change: add-multi-repo-federation)
   */
  federation?: boolean;
  /** Restrict the federation scope to these registry repo names (default: all). */
  federationRepos?: string[];
}

type Confidence = 'high' | 'medium' | 'low';

// Languages where export is explicit and dispatch mostly static — deadness is
// more reliable. Dynamic languages (implicit exports, runtime dispatch) cap low.
const STATIC_LANGS = new Set([
  'TypeScript', 'JavaScript', 'Go', 'Rust', 'Java', 'Kotlin', 'C#', 'Swift', 'C++', 'C', 'Scala', 'Dart',
]);
const DYNAMIC_LANGS = new Set(['Python', 'Ruby', 'PHP', 'Lua', 'Elixir', 'Bash']);

/** A code node we can reason about (not external, not infrastructure). */
function isCodeNode(n: FunctionNode): boolean {
  return !n.isExternal && !isIacLanguage(n.language);
}

/**
 * Node-ids invoked by something OUTSIDE the call graph — they are liveness roots,
 * not dead code. Always includes cross-language HTTP handlers (`http_endpoint`
 * edges). When `includeSynthesizedRoutes` is set (default reachability, not strict
 * mode), also includes targets of synthesized `route-handler` edges: a framework
 * invokes a route handler regardless of whether its registration site is itself
 * reached, so a top-level/unenclosed route still keeps its handler live.
 */
function externallyInvokedHandlerIds(cg: SerializedCallGraph, includeSynthesizedRoutes = true): Set<string> {
  const ids = new Set<string>();
  for (const e of cg.edges) {
    if (!e.calleeId) continue;
    if (e.confidence === 'http_endpoint') ids.add(e.calleeId);
    else if (includeSynthesizedRoutes && e.confidence === 'synthesized' && e.synthesizedBy === 'route-handler') {
      ids.add(e.calleeId);
    }
  }
  return ids;
}

interface DepSignals {
  /** Symbol names imported by name somewhere (`import { X }`). */
  names: Set<string>;
  /** Repo-relative file paths of modules imported anywhere — a broader "module is
   *  used" signal that catches namespace/default/re-export usage named-import
   *  detection misses. A symbol in a consumed module can't be high-confidence dead. */
  files: Set<string>;
}

/** Load the cross-file import signals from the dependency graph. */
async function loadDepSignals(absDir: string): Promise<DepSignals | null> {
  try {
    const raw = await readFile(join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH), 'utf-8');
    const g = JSON.parse(raw) as {
      nodes?: Array<{ id: string; file?: { path?: string } }>;
      edges?: Array<{ target?: string; importedNames?: string[] }>;
    };
    const names = new Set<string>();
    const idToPath = new Map((g.nodes ?? []).map(n => [n.id, n.file?.path ?? '']));
    const files = new Set<string>();
    for (const e of g.edges ?? []) {
      for (const n of e.importedNames ?? []) names.add(n);
      const path = e.target ? idToPath.get(e.target) : undefined;
      if (path) files.add(path);
    }
    return { names, files };
  } catch {
    return null;
  }
}

/** A candidate's module is imported somewhere → tolerant path match against the dep-graph file set. */
function fileImported(filePath: string, importedFiles: Set<string>): boolean {
  if (importedFiles.has(filePath)) return true;
  const a = filePath.replace(/^\/+/, '');
  for (const f of importedFiles) {
    const b = f.replace(/^\/+/, '');
    if (a === b || a.endsWith('/' + b) || b.endsWith('/' + a)) return true;
  }
  return false;
}

/**
 * Compute the live (reachable) node-id set by forward BFS from seed roots.
 * `excludeId` removes a node from both the seeds and the traversal (delete mode).
 */
function reachableFrom(
  seeds: string[],
  forward: Map<string, Set<string>>,
  excludeId?: string,
): Set<string> {
  const live = new Set<string>();
  const queue: string[] = [];
  for (const s of seeds) {
    if (s === excludeId || live.has(s)) continue;
    live.add(s); queue.push(s);
  }
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of forward.get(id) ?? []) {
      if (next === excludeId || live.has(next)) continue;
      live.add(next); queue.push(next);
    }
  }
  return live;
}

/**
 * The candidate dead-code id set: code nodes (excluding tests) not reachable from
 * any liveness root (tests, by-name imports, HTTP handlers, main-like). Shares the
 * documented roots definition with {@link handleFindDeadCode} so `find_dead_code`
 * and landmark signals agree on what "dead" means. Candidate ids only — deadness
 * is a signal, never deletion authority (see module header).
 */
export async function deadCodeIds(
  absDir: string,
  cg: SerializedCallGraph,
  opts?: { directResolvedOnly?: boolean },
): Promise<Set<string>> {
  // Strict mode (opt-in): drop synthesized dynamic-dispatch edges from both the
  // reachability walk AND the synthesized route-handler roots, so a caller that
  // computes its own partition with `directResolvedOnly` gets a dead set grounded
  // on the SAME edge basis (otherwise the two conclusions can disagree). Default
  // (no opts) preserves the prior non-strict behavior byte-for-byte.
  const strict = opts?.directResolvedOnly === true;
  const dep = await loadDepSignals(absDir);
  const importedNames = dep?.names ?? null;
  const { forward } = buildAdjacency(cg, { directResolvedOnly: strict });
  const handlerRootIds = externallyInvokedHandlerIds(cg, !strict);
  const isMainLike = (n: FunctionNode) => n.name === 'main' || n.name === 'Main' || n.name === 'default';
  const isRoot = (n: FunctionNode): boolean =>
    !!n.isTest || handlerRootIds.has(n.id) || isMainLike(n) ||
    (importedNames !== null && importedNames.has(n.name));
  const codeNodes = cg.nodes.filter(isCodeNode);
  const seedIds = codeNodes.filter(isRoot).map(r => r.id).sort();
  const live = reachableFrom(seedIds, forward);
  return new Set(codeNodes.filter(n => !n.isTest && !live.has(n.id)).map(n => n.id));
}

export async function handleFindDeadCode(input: FindDeadCodeInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const dep = await loadDepSignals(absDir);
  const importedNames = dep?.names ?? null;
  const importedFiles = dep?.files ?? null;
  const { nodeMap, forward } = buildAdjacency(cg, { directResolvedOnly: input.directResolvedOnly });

  // Map each node reached *into* by a synthesized edge → the rule that produced it.
  // Used (in non-strict mode) to cap confidence at `low` for any candidate-dead
  // node that has an incoming synthesized edge whose source is itself unreached —
  // so a synthesized-dispatch target is never reported as high-confidence dead.
  const synthRuleByCallee = new Map<string, string>();
  if (!input.directResolvedOnly) {
    for (const e of cg.edges) {
      if (e.confidence === 'synthesized' && e.calleeId) {
        synthRuleByCallee.set(e.calleeId, e.synthesizedBy ?? 'synthesized');
      }
    }
  }

  // ── Roots (liveness seeds) — conservative: prefer false-live over false-dead ──
  // tests (they invoke code) · symbols imported by another file · HTTP route
  // handlers · synthesized route handlers (framework-invoked entry points; omitted
  // in strict mode) · main-like entry functions.
  const httpHandlerIds = externallyInvokedHandlerIds(cg, !input.directResolvedOnly);
  const isMainLike = (n: FunctionNode) => n.name === 'main' || n.name === 'Main' || n.name === 'default';
  const isRoot = (n: FunctionNode): boolean =>
    !!n.isTest ||
    httpHandlerIds.has(n.id) ||
    isMainLike(n) ||
    (importedNames !== null && importedNames.has(n.name));

  const codeNodes = cg.nodes.filter(isCodeNode);
  const roots = codeNodes.filter(isRoot);
  const seedIds = [...roots].map(r => r.id).sort();
  const live = reachableFrom(seedIds, forward);

  const exportSignal: 'dependency-graph' | 'none' = importedNames !== null ? 'dependency-graph' : 'none';
  const languages = [...new Set(codeNodes.map(n => n.language))].sort();

  // Confidence boundary: the liveness partition (and so every dead verdict) rests
  // on the edges traversed within the reachable set. Synthesized edges among them
  // mean a candidate's deadness leaned on a heuristic; disclose it. (spec:
  // add-confidence-boundary-disclosure)
  const liveBasis = edgeBasisWithinSet(cg.edges, live);
  const staleness = await computeStaleness(absDir);
  const confidenceBoundary = assembleBoundary({ basis: liveBasis, staleness, integrity: ctx?.integrity });

  // ── Delete-impact mode: "what becomes dead if I delete X?" ──────────────────
  if (input.ifDeleted !== undefined) {
    const target = codeNodes.find(n => n.name === input.ifDeleted)
      ?? codeNodes.find(n => n.name.toLowerCase() === input.ifDeleted!.toLowerCase());
    if (!target) return { error: `Symbol "${input.ifDeleted}" not found in the code graph.` };

    const liveWithout = reachableFrom(seedIds, forward, target.id);
    const becomesDead = [...live]
      .filter(id => id !== target.id && !liveWithout.has(id))
      .map(id => nodeMap.get(id))
      .filter((n): n is FunctionNode => !!n && isCodeNode(n) && !n.isTest)
      .map(n => ({ name: n.name, file: n.filePath, language: n.language, fanIn: n.fanIn }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

    // Delete-impact is a within-repo reachability question; federation scope (a
    // cross-repo *liveness* signal) does not apply. Disclose rather than silently
    // drop an opt-in flag — a cross-repo consumer is surfaced by the candidate-dead
    // mode (omit `ifDeleted`), not here.
    const federationRequested = input.federation === true || (input.federationRepos?.length ?? 0) > 0;
    return {
      target: target.name,
      file: target.filePath,
      becomesDeadIfDeleted: becomesDead,
      count: becomesDead.length,
      note: becomesDead.length === 0
        ? 'Nothing else becomes unreachable — every other node has an independent path to a root (or is itself a root).'
        : 'These nodes are reachable only through the target. Deleting it orphans them — verify before removing (dynamic callers are invisible here).',
      ...(federationRequested ? { federationNote: 'Federation scope is not applied in delete-impact (ifDeleted) mode — it is a within-repo reachability query. To see cross-repo consumers that keep a symbol live, call find_dead_code with federation and without ifDeleted, or analyze_impact with federation.' } : {}),
      soundness: deadCodeSoundness(exportSignal, languages),
      confidenceBoundary,
    };
  }

  // ── Candidate dead-code report ──────────────────────────────────────────────
  let candidates = codeNodes.filter(n => !n.isTest && !live.has(n.id));
  if (input.filePattern) candidates = candidates.filter(n => n.filePath.includes(input.filePattern!));

  const ranked = candidates
    .map(n => {
      const noCaller = (n.fanIn ?? 0) === 0;
      const dynamic = DYNAMIC_LANGS.has(n.language) || !STATIC_LANGS.has(n.language);
      const moduleUsed = importedFiles !== null && fileImported(n.filePath, importedFiles);
      const reasons: string[] = [];
      if (noCaller) reasons.push('no internal caller');
      else reasons.push('reachable only from other candidate-dead code');
      if (importedNames !== null && !importedNames.has(n.name)) reasons.push('not imported by name from any other file');
      if (moduleUsed) reasons.push('but its module IS imported elsewhere (symbol-level usage unresolved — e.g. namespace/default import or external API)');
      reasons.push('not a test, route handler, or main entry');

      // Conservative: a symbol whose module is consumed elsewhere can't be high —
      // named-import detection misses namespace/default/re-export usage.
      let confidence: Confidence;
      if (dynamic) confidence = 'low';
      else if (moduleUsed) confidence = 'low';
      else if (exportSignal === 'none') confidence = 'medium';
      else confidence = noCaller ? 'high' : 'medium';

      // A candidate reached into by a synthesized dynamic-dispatch edge (its
      // dispatcher itself unreached) is never high-confidence dead — it is a known
      // dynamic-dispatch blind spot, downgraded to low with the rule named.
      const synthRule = synthRuleByCallee.get(n.id);
      if (synthRule) {
        confidence = 'low';
        reasons.push(`reachable via a synthesized ${synthRule} edge whose dispatcher is not itself reached — likely live through dynamic dispatch`);
      }

      return {
        name: n.name, file: n.filePath, language: n.language, className: n.className ?? null,
        fanIn: n.fanIn ?? 0, startLine: n.startLine ?? null,
        confidence, reason: reasons.join('; '),
      };
    })
    .sort((a, b) =>
      ({ high: 0, medium: 1, low: 2 })[a.confidence] - ({ high: 0, medium: 1, low: 2 })[b.confidence] ||
      a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  // Federation (opt-in): a symbol with no consumer in THIS repo can still be live
  // fleet-wide. Pull any candidate consumed by another indexed repo out of the
  // candidate-dead set and report it as live-via-federation, with named coverage.
  // (change: add-multi-repo-federation)
  let finalRanked = ranked;
  let federationBlock: Record<string, unknown> | undefined;
  const fedScope = resolveFederationScope(absDir, { federation: input.federation, federationRepos: input.federationRepos });
  if (fedScope.active && ranked.length > 0) {
    const names = [...new Set(ranked.map(r => r.name))];
    const batch = await findCrossRepoConsumersBatch(fedScope, names);
    const liveNames = new Set([...batch.bySymbol.entries()].filter(([, v]) => v.length > 0).map(([k]) => k));
    const liveViaFederation = ranked
      .filter(r => liveNames.has(r.name))
      .map(r => ({
        name: r.name,
        file: r.file,
        consumers: (batch.bySymbol.get(r.name) ?? []).map(c => ({ repo: c.repo, caller: c.caller.name, file: c.caller.file })),
      }));
    finalRanked = ranked.filter(r => !liveNames.has(r.name));
    federationBlock = {
      liveViaFederation,
      keptAliveCount: liveViaFederation.length,
      reposConsulted: batch.coverage.reposConsulted.map(r => r.name),
      reposSkipped: batch.coverage.reposSkipped.map(r => ({ name: r.name, state: r.state, reason: r.reason })),
      // Disclose the consumer cap, matching analyze_impact — never silently drop.
      ...(batch.truncated > 0 ? { truncated: batch.truncated } : {}),
      caveats: batch.coverage.caveats,
    };
  } else if (fedScope.active) {
    federationBlock = {
      liveViaFederation: [],
      keptAliveCount: 0,
      reposConsulted: [],
      reposSkipped: [],
      caveats: [],
    };
  }

  const limit = Math.max(1, Math.min(input.maxResults ?? 100, 1000));
  const byConfidence = {
    high: finalRanked.filter(r => r.confidence === 'high').length,
    medium: finalRanked.filter(r => r.confidence === 'medium').length,
    low: finalRanked.filter(r => r.confidence === 'low').length,
  };

  return {
    stats: {
      analyzed: codeNodes.filter(n => !n.isTest).length,
      roots: roots.length,
      reachable: [...live].filter(id => { const n = nodeMap.get(id); return !!n && isCodeNode(n) && !n.isTest; }).length,
      candidateDead: finalRanked.length,
    },
    rootKinds: {
      tests: roots.filter(r => r.isTest).length,
      imported: importedNames !== null ? roots.filter(r => !r.isTest && importedNames.has(r.name)).length : 0,
      httpHandlers: roots.filter(r => httpHandlerIds.has(r.id)).length,
    },
    byConfidence,
    candidateDead: finalRanked.slice(0, limit),
    truncated: finalRanked.length > limit ? finalRanked.length - limit : 0,
    coverage: { languages, exportSignal },
    ...(federationBlock ? { federation: federationBlock } : {}),
    soundness: deadCodeSoundness(exportSignal, languages),
    confidenceBoundary,
  };
}

function deadCodeSoundness(exportSignal: 'dependency-graph' | 'none', languages: string[]): {
  posture: string; caveats: string[];
} {
  const caveats = [
    'These are CANDIDATES, not deletion authority — never auto-delete based on this.',
    'Dynamic dispatch, reflection, DI, plugin registries, and framework routing invoke code invisibly to static analysis; such symbols can be flagged dead falsely.',
    'Public API consumed OUTSIDE this repo is not visible as a root and may appear dead — treat exported library symbols with caution.',
  ];
  if (exportSignal === 'none') {
    caveats.push('No dependency graph found — the "imported elsewhere" liveness signal is unavailable, so confidence is reduced. Run analyze_codebase to generate it.');
  }
  const dynamic = languages.filter(l => DYNAMIC_LANGS.has(l));
  if (dynamic.length > 0) {
    caveats.push(`Dynamic languages present (${dynamic.join(', ')}): implicit exports and runtime dispatch make deadness unreliable — those candidates are capped at low confidence.`);
  }
  return { posture: 'candidates-not-authority', caveats };
}
