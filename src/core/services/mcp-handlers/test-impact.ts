/**
 * Deterministic Test Impact Selection (spec-19) — static, call-graph-based
 * regression test selection (RTS) served to the agent at edit time.
 *
 * "I changed parseConfig() — which tests should I run?" is answered by walking the
 * call graph *backward* from the change to every test that transitively reaches it.
 * grep can't (the reach is through indirect calls); the model is slow and guesses;
 * a deterministic graph does it instantly over edges we already store (`calls`,
 * `tested_by`, inheritance).
 *
 * Soundness is stated honestly: this is an OVER-APPROXIMATE PRIORITIZER, not a
 * sound replacement for the full suite. Direct/static dispatch is safely
 * over-approximated; dynamic dispatch, reflection, and DI can under-select.
 */

import { validateDirectory, readCachedContext } from './utils.js';
import { resolveFederationScope, findCrossRepoTests } from '../../federation/resolver.js';
import { loadTraversalIndex } from './traversal.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';
import { SUBGRAPH_MAX_DEPTH_LIMIT } from '../../../constants.js';
import { assembleBoundary, computeStaleness, edgeBasisWithinSet } from './confidence-boundary.js';

export interface SelectTestsInput {
  directory: string;
  /** Explicit changed symbols (function/method names). */
  changedSymbols?: string[];
  /** Git ref to diff the working tree against (e.g. "HEAD", "main"). */
  diffRef?: string;
  /** Max backward-reachability depth (default 12, capped). */
  maxDepth?: number;
  /**
   * Restrict backward reachability to directly-resolved edges only, ignoring
   * synthesized dynamic-dispatch edges (spec: add-synthesized-dynamic-dispatch-edges).
   * Default false (synthesized edges are traversed, so tests reaching changed code
   * only through a callback/event/route are still selected).
   */
  directResolvedOnly?: boolean;
  /**
   * Opt in to federation scope: also select tests in consumer repos that reach a
   * call site of a changed published symbol. (change: add-multi-repo-federation)
   */
  federation?: boolean;
  /** Restrict the federation scope to these registry repo names (default: all). */
  federationRepos?: string[];
}

type Confidence = 'high' | 'medium' | 'low';
const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

interface SelectedTest {
  test: string;
  file: string;
  viaPath: string[];
  confidence: Confidence;
}

/** Resolve changed symbols → seed production nodes (exact name preferred). */
export function seedsFromSymbols(cg: SerializedCallGraph, symbols: string[]): FunctionNode[] {
  const out = new Map<string, FunctionNode>();
  for (const sym of symbols) {
    const lower = sym.toLowerCase();
    const exact = cg.nodes.filter(n => !n.isExternal && !n.isTest && n.name.toLowerCase() === lower);
    const pick = exact.length > 0
      ? exact
      : cg.nodes.filter(n => !n.isExternal && !n.isTest && n.name.toLowerCase().includes(lower));
    for (const n of pick) out.set(n.id, n);
  }
  return [...out.values()];
}

/** Tolerant file match: exact or suffix either way. */
function fileMatches(nodeFile: string, changed: string): boolean {
  if (nodeFile === changed) return true;
  const a = nodeFile.replace(/^\/+/, ''), b = changed.replace(/^\/+/, '');
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

/** Resolve changed files (from a diff) → seed production nodes. */
export function seedsFromFiles(cg: SerializedCallGraph, files: string[]): FunctionNode[] {
  const out = new Map<string, FunctionNode>();
  for (const n of cg.nodes) {
    if (n.isExternal || n.isTest) continue;
    if (files.some(f => fileMatches(n.filePath, f))) out.set(n.id, n);
  }
  return [...out.values()];
}

/** Test identity for dedup across the two discovery paths. */
function testKey(file: string, name: string): string {
  return `${file}\0${name}`;
}

/**
 * Select the tests that transitively reach a set of changed symbols/files.
 * Read-only, deterministic, offline. Returns `unknown` (additive-by-cast).
 */
export async function handleSelectTests(input: SelectTestsInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const maxDepth = Math.max(1, Math.min(input.maxDepth ?? 12, SUBGRAPH_MAX_DEPTH_LIMIT));

  // ── Resolve the changed set ────────────────────────────────────────────────
  // Precedence: explicit changedSymbols → diffRef → default to the working-tree
  // diff vs HEAD. The default matters for weak tool-callers (e.g. a local model
  // in Pi) that invoke select_tests with NO arguments: rather than erroring,
  // a bare call answers the most common intent — "which tests cover my current
  // uncommitted changes?". The result flags that it defaulted, so it's never
  // mysterious.
  const hasSymbols = !!(input.changedSymbols && input.changedSymbols.length > 0);
  const baseRef = input.diffRef && input.diffRef.length > 0 ? input.diffRef : 'HEAD';
  const defaultedToHead = !hasSymbols && (input.diffRef === undefined || input.diffRef === '');

  let seeds: FunctionNode[];
  let changedFiles: string[] = [];
  if (hasSymbols) {
    seeds = seedsFromSymbols(cg, input.changedSymbols!);
  } else {
    try {
      const { getChangedFiles } = await import('../../drift/git-diff.js');
      const diff = await getChangedFiles({ rootPath: absDir, baseRef, includeUnstaged: true });
      changedFiles = diff.files.map(f => f.path);
      seeds = seedsFromFiles(cg, changedFiles);
    } catch (err) {
      return { error: `git diff failed (base ${baseRef}): ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (seeds.length === 0) {
    // Honesty: if federation was opted into, say why no cross-repo selection ran
    // rather than silently omitting the federation block an active scope implies.
    const federationRequested = input.federation === true || (input.federationRepos?.length ?? 0) > 0;
    return {
      changed: changedFiles,
      selectedTests: [],
      message: hasSymbols
        ? 'No matching production functions found for the given symbols.'
        : `No changed production functions vs ${baseRef}${defaultedToHead ? ' (defaulted — no changedSymbols or diffRef was given)' : ''}. Nothing has changed, the diff touches only non-code files, or analyze_codebase is stale.`,
      ...(defaultedToHead ? { note: 'Called without changedSymbols/diffRef — diffed the working tree against HEAD. Pass changedSymbols or diffRef to target a specific change.' } : {}),
      ...(federationRequested ? { federationNote: 'Federation scope was requested, but no changed production symbol resolved in the home repo — cross-repo test selection keys off the home repo\'s changed published symbols, so nothing was propagated. Pass changedSymbols (or a diffRef with code changes) to select across the fleet.' } : {}),
      soundness: { posture: 'over-approximate', caveats: ['No seeds resolved — nothing to select.'] },
      coverage: { languages: [], testDetection: 'none' as const },
      confidenceBoundary: assembleBoundary({ staleness: await computeStaleness(absDir), integrity: ctx?.integrity }),
    };
  }

  // ── Backward reachability with path tracking (calls + inheritance) ──────────
  // Served from the precomputed traversal structure for this artifact generation
  // rather than a per-call adjacency rebuild (change: optimize-reachability-precompute).
  // `sortNeighbors` preserves the ascending-caller-id expansion order the `viaPath`
  // chains below are reconstructed from, so the payload is unchanged.
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const traversal = await loadTraversalIndex(absDir, cg);
  const seedIds = new Set(seeds.map(s => s.id));
  const { depth: depthOf, parent } = traversal.bfsWithParents(
    seeds.map(s => s.id),
    'backward',
    maxDepth,
    { directResolvedOnly: input.directResolvedOnly },
    { sortNeighbors: true },
  );

  // Path from a reached node down to its seed: [node, …, changedFn].
  const pathToSeed = (id: string): string[] => {
    const names: string[] = [];
    let cur: string | undefined = id;
    const guard = new Set<string>();
    while (cur !== undefined && !guard.has(cur)) {
      guard.add(cur);
      names.push(nodeMap.get(cur)?.name ?? cur);
      if (depthOf.get(cur) === 0) break;
      cur = parent.get(cur);
    }
    return names;
  };

  const byTest = new Map<string, SelectedTest>();
  const add = (file: string, name: string, viaPath: string[], confidence: Confidence) => {
    const key = testKey(file, name);
    const existing = byTest.get(key);
    if (!existing || CONF_RANK[confidence] > CONF_RANK[existing.confidence] ||
        (CONF_RANK[confidence] === CONF_RANK[existing.confidence] && viaPath.length < existing.viaPath.length)) {
      byTest.set(key, { test: name, file, viaPath, confidence });
    }
  };

  // Source 1 — test nodes reached by the backward call-walk.
  for (const [id, depth] of depthOf) {
    if (depth === 0) continue;
    const n = nodeMap.get(id);
    if (!n?.isTest || n.isExternal) continue;
    const confidence: Confidence = depth === 1 ? 'high' : depth <= 3 ? 'medium' : 'low';
    add(n.filePath, n.name, pathToSeed(id), confidence);
  }

  // Source 2 — `tested_by` edges on any reached production node (catches import-
  // based associations whose test node isn't a real call-graph caller).
  for (const e of cg.edges) {
    if (e.kind !== 'tested_by') continue;
    if (!depthOf.has(e.callerId)) continue; // production node not in the impacted set
    const testFile = e.calleeId.includes('::') ? e.calleeId.split('::')[0] : e.calleeId;
    const onSeed = seedIds.has(e.callerId);
    const confidence: Confidence = onSeed ? 'high' : 'medium';
    add(testFile, e.calleeName, [e.calleeName, ...pathToSeed(e.callerId)], confidence);
  }

  // Fallback — seeds with no reaching test at all: associate tests of sibling
  // functions in the same file (newly-added / untested functions), low confidence.
  let usedFileFallback = false;
  const reachedSeedFiles = new Set([...byTest.values()].flatMap(t => t.viaPath));
  for (const s of seeds) {
    const seedHasTest = [...byTest.values()].some(t => t.viaPath.includes(s.name));
    if (seedHasTest) continue;
    for (const e of cg.edges) {
      if (e.kind !== 'tested_by') continue;
      const prod = nodeMap.get(e.callerId);
      if (!prod || prod.filePath !== s.filePath) continue;
      const testFile = e.calleeId.includes('::') ? e.calleeId.split('::')[0] : e.calleeId;
      add(testFile, e.calleeName, [e.calleeName, `(same file as ${s.name})`], 'low');
      usedFileFallback = true;
    }
  }
  void reachedSeedFiles;

  const selectedTests = [...byTest.values()].sort(
    (a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence] ||
      a.file.localeCompare(b.file) || a.test.localeCompare(b.test),
  );

  // ── Coverage & soundness (honest, never falsely confident) ──────────────────
  const seedLangs = [...new Set(seeds.map(s => s.language))].sort();
  const graphHasTests = cg.nodes.some(n => n.isTest) || cg.edges.some(e => e.kind === 'tested_by');
  const langsWithTests = new Set(cg.nodes.filter(n => n.isTest).map(n => n.language));
  const testDetection: 'full' | 'partial' | 'none' =
    !graphHasTests ? 'none'
    : seedLangs.every(l => langsWithTests.has(l)) ? 'full'
    : 'partial';

  const caveats: string[] = [
    'Static call-graph selection is an over-approximate prioritizer, not a sound replacement for the full suite.',
    'Dynamic dispatch, reflection, and dependency injection can under-select (a relevant test may be missed).',
  ];
  if (testDetection === 'none') {
    caveats.push('No tests were detected in this graph — the selection is empty, not "no tests needed". Verify test-file detection for your languages.');
  } else if (testDetection === 'partial') {
    caveats.push(`Test detection is incomplete for some changed languages (${seedLangs.join(', ')}); tests in undetected languages are missing.`);
  }
  if (usedFileFallback) {
    caveats.push('Some seeds had no reaching test; sibling-file tests were included at low confidence (likely newly-added or untested functions).');
  }
  if (selectedTests.length === 0 && testDetection !== 'none') {
    caveats.push('No test transitively reaches the change. It may be genuinely untested, or reached only via dynamic dispatch this static analysis cannot see.');
  }

  // Confidence boundary: the selection rests on the backward call-walk over the
  // impacted set; synthesized edges among those nodes mean a test reached the
  // change through heuristic dispatch. (spec: add-confidence-boundary-disclosure)
  const impactedIds = new Set(depthOf.keys());
  const selectBasis = edgeBasisWithinSet(cg.edges, impactedIds);
  // Federation (opt-in): select tests in consumer repos that reach a call site of
  // a changed published symbol — the cross-repo blast radius of the change.
  // (change: add-multi-repo-federation)
  let federationBlock: Record<string, unknown> | undefined;
  const fedScope = resolveFederationScope(absDir, { federation: input.federation, federationRepos: input.federationRepos });
  if (fedScope.active) {
    const { tests: crossRepoTests, coverage } = await findCrossRepoTests(fedScope, seeds.map(s => s.name), { maxDepth, directResolvedOnly: input.directResolvedOnly });
    federationBlock = {
      crossRepoTests: crossRepoTests.map(t => ({ repo: t.repo, test: t.test.name, file: t.test.file, viaSymbol: t.viaSymbol, confidence: t.depth <= 1 ? 'high' : t.depth <= 3 ? 'medium' : 'low' })),
      crossRepoTestCount: crossRepoTests.length,
      reposConsulted: coverage.reposConsulted.map(r => r.name),
      reposSkipped: coverage.reposSkipped.map(r => ({ name: r.name, state: r.state, reason: r.reason })),
      caveats: coverage.caveats,
    };
  }

  return {
    changed: hasSymbols ? seeds.map(s => s.name) : changedFiles,
    seeds: seeds.map(s => ({ name: s.name, file: s.filePath })),
    selectedTests,
    ...(defaultedToHead ? { note: 'No changedSymbols/diffRef given — selected tests for your current working-tree changes vs HEAD.' } : {}),
    ...(federationBlock ? { federation: federationBlock } : {}),
    soundness: { posture: 'over-approximate' as const, caveats },
    coverage: { languages: seedLangs, testDetection },
    confidenceBoundary: assembleBoundary({ basis: selectBasis, staleness: await computeStaleness(absDir), integrity: ctx?.integrity }),
  };
}
