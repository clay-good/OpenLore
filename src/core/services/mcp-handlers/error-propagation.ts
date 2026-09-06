/**
 * `analyze_error_propagation` MCP handler (change: add-error-propagation-graph).
 *
 * The call graph answers *who calls whom*; it is silent on *what can throw out of
 * here, and is it handled*. This tool answers that, as a conclusion: given a query
 * function, the exception types that can propagate OUT of it to its callers
 * (`escapes`) and the ones thrown somewhere in its reachable subtree but caught
 * within it (`handledInternally`) — each with provenance — plus the honesty
 * `boundaries` that make the result a sound lower bound.
 *
 * It is the error-handling analogue of `analyze_impact` (blast radius of a change)
 * and `select_tests` (tests reaching a change). Computed live from the cached call
 * graph (callee edges + call-site lines) plus a re-read and tree-sitter parse of
 * the source the reachable functions span — the `find_clones` precedent: no new
 * persisted artifact, no schema migration, no edit to the hot analyze walk.
 *
 * Scope: TypeScript / JavaScript / Python / Java / C# exception semantics and a
 * separate Go returned-error + panic/recover model. A query in any other language returns an
 * explicit `unsupported` result, never an empty escape set.
 */

import { relative } from 'node:path';
import type Parser from 'tree-sitter';
import { validateDirectory, readCachedContext, safeJoin } from './utils.js';
import {
  loadDynamicBoundaryReport,
  dynamicBoundaryCrossing,
} from './dynamic-boundary-disclosure.js';
import { readFileConfined } from '../../../utils/path-confinement.js';
import {
  ERROR_PROPAGATION_LANGUAGES,
  getExceptionParser,
  extractExceptionFacts,
  guardsCatch,
  DYNAMIC_TYPE,
  extractGoErrorFacts,
  resolveCurrentFunctionSpan,
  rootAstIndexWithinBudget,
  type FunctionExceptionFacts,
  type GoErrorFacts,
} from '../../analyzer/exception-flow.js';
import type { SerializedCallGraph, FunctionNode, CallEdge, AmbiguousCallSite } from '../../analyzer/call-graph.js';
import { parseWithBudget, type BudgetableParser } from '../../analyzer/parse-budget.js';

export interface AnalyzeErrorPropagationInput {
  directory: string;
  /** A function in the index: its name, or `name::path` to disambiguate. */
  symbol?: string;
  /** Callee-traversal depth bound (default 10, clamped to [1, 30]). */
  maxDepth?: number;
}

const DEFAULT_DEPTH = 10;
const MIN_DEPTH = 1;
const MAX_DEPTH = 30;
/** Cap on functions parsed for one query — bounds work on a huge subtree. */
const MAX_FUNCTIONS = 800;
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;

function releaseTrees(trees: Map<string, Parser.Tree | null>): void {
  for (const tree of trees.values()) {
    try { (tree as Parser.Tree & { delete?: () => void } | null)?.delete?.(); } catch { /* best-effort native resource release */ }
  }
  trees.clear();
}

/** One exception that can escape the query function. */
interface EscapeEntry {
  type: string;
  /** 'direct' = thrown by the query itself; 'propagated' = from a callee. */
  kind: 'direct' | 'declared' | 'propagated';
  originFunction: string;
  originFile: string;
  originLine: number;
  /** Call path from the query down to the origin (function::file labels). */
  path: string[];
}

/** One exception thrown in the subtree but caught within the query's reach. */
interface HandledEntry {
  type: string;
  caughtIn: string;
  caughtAtLine: number;
  fromCallee: string;
}

const labelOf = (n: FunctionNode): string => `${n.name}::${n.filePath}`;

/**
 * Compute the exceptions that escape a query function. Read-only, deterministic,
 * offline. Returns `unknown` (additive-by-cast), conclusion-shaped — labeled
 * escape/handled sets with provenance and disclosed boundaries, never a graph.
 */
export async function handleAnalyzeErrorPropagation(
  input: AnalyzeErrorPropagationInput,
): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);

  const sym = typeof input.symbol === 'string' ? input.symbol.trim() : '';
  if (!sym) return { error: 'Provide `symbol` — a function name, or name::path, in the index.' };

  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  // Normalize every internal artifact path through the symlink-aware project-root
  // boundary before resolution, traversal, parsing, or output. Poisoned nodes are
  // omitted; edges to them become the existing unresolved-callee boundary rather
  // than an out-of-root read.
  const allNodes = ((cg.nodes ?? []) as FunctionNode[]).flatMap(n => {
    if (n.isExternal) return [n];
    try {
      const absPath = safeJoin(absDir, n.filePath);
      return [{ ...n, filePath: relative(absDir, absPath) }];
    } catch {
      return [];
    }
  });
  const edges = (cg.edges ?? []) as CallEdge[];

  // ── Resolve the query symbol (find_clones resolution discipline) ───────────
  const sep = sym.indexOf('::');
  const namePart = sep >= 0 ? sym.slice(0, sep) : sym;
  const pathPart = sep >= 0 ? sym.slice(sep + 2) : undefined;

  let candidates = allNodes.filter(n => n.name === namePart);
  if (pathPart) {
    candidates = candidates.filter(n => n.filePath === pathPart || n.filePath.endsWith(pathPart));
  }
  if (candidates.length === 0) {
    const nameLower = namePart.toLowerCase();
    const near = [...new Set(allNodes.map(n => n.name))]
      .filter(nm => nm.toLowerCase().includes(nameLower))
      .slice(0, 10);
    return {
      error: `No indexed function matching "${sym}".`,
      candidates: near,
      hint: near.length ? 'Did you mean one of these? Pass name::path to disambiguate.' : 'Run analyze_codebase first.',
    };
  }
  if (candidates.length > 1) {
    return {
      error: `"${sym}" is ambiguous — matches ${candidates.length} functions. Pass name::path.`,
      candidates: candidates.slice(0, 10).map(n => `${n.name}::${n.filePath}`),
    };
  }

  const query = candidates[0];
  const queryLabel = {
    symbol: labelOf(query),
    className: query.className,
    language: query.language,
    startLine: query.startLine,
    endLine: query.endLine,
  };

  if (!ERROR_PROPAGATION_LANGUAGES.has(query.language)) {
    return {
      query: queryLabel,
      unsupported: true,
      note:
        `Error-propagation analysis is not supported for ${query.language}. Supported: ` +
        `${[...ERROR_PROPAGATION_LANGUAGES].join(', ')}. This is an honest "not analyzed", ` +
        'NOT a claim that the function throws nothing.',
    };
  }
  if (query.isExternal || !(query.startIndex < query.endIndex)) {
    return {
      query: queryLabel,
      error: `"${sym}" has no extractable body (external or synthesized). Nothing to analyze.`,
    };
  }

  // ── Indexes: node-by-id and callee adjacency (with call-site lines) ────────
  const nodeById = new Map<string, FunctionNode>();
  for (const n of allNodes) nodeById.set(n.id, n);
  const calleesByCaller = new Map<string, CallEdge[]>();
  for (const e of edges) {
    const arr = calleesByCaller.get(e.callerId);
    if (arr) arr.push(e);
    else calleesByCaller.set(e.callerId, [e]);
  }
  // Artifact edge order is not semantic, but every traversal below is budgeted.
  // Canonicalize before consuming a function/byte budget so reversing persisted
  // edges cannot change which subtree is analyzed or which boundary is reported.
  for (const outgoing of calleesByCaller.values()) {
    outgoing.sort((a, b) =>
      (a.line ?? -1) - (b.line ?? -1) ||
      a.calleeId.localeCompare(b.calleeId) ||
      a.calleeName.localeCompare(b.calleeName) ||
      (a.confidence ?? '').localeCompare(b.confidence ?? '') ||
      (a.kind ?? '').localeCompare(b.kind ?? ''));
  }
  // Unresolved-ambiguous call sites indexed by caller (change:
  // harden-call-resolution-ambiguity) — a call the resolver refused to bind because
  // >1 candidate was viable. Like an unresolved self-call, its callees' exceptions are
  // out of scope: disclosed as a boundary, never assumed none.
  const ambiguousByCaller = new Map<string, AmbiguousCallSite[]>();
  for (const site of cg.ambiguousSites ?? []) {
    const arr = ambiguousByCaller.get(site.callerId);
    if (arr) arr.push(site);
    else ambiguousByCaller.set(site.callerId, [site]);
  }

  const depthBound = Number.isFinite(input.maxDepth as number)
    ? Math.max(MIN_DEPTH, Math.min(input.maxDepth as number, MAX_DEPTH))
    : DEFAULT_DEPTH;

  // Go is deliberately analyzed through returned values + panic/recover, not
  // through the exception-shaped ThrowSite/TryGuard machinery below.
  if (query.language === 'Go') {
    const trees = new Map<string, Parser.Tree | null>();
    const degradedFiles = new Set<string>();
    const cache = new Map<string, GoErrorFacts | null>();
    const boundaries = new Set<string>();
    const external = new Set<string>();
    const testCallees = new Set<string>();
    let analyzed = 0;
    let sourceBytes = 0;
    let bounded = false;
    let lastGoFactsTruncated = false;

    async function factsForGo(n: FunctionNode): Promise<GoErrorFacts | null> {
      lastGoFactsTruncated = false;
      if (cache.has(n.id)) return cache.get(n.id)!;
      if (n.language !== 'Go') {
        boundaries.add(`callee in unsupported language not analyzed (${n.language})`);
        cache.set(n.id, null);
        return null;
      }
      if (!(n.startIndex < n.endIndex)) {
        boundaries.add(`Go callee has no extractable body (${labelOf(n)})`);
        cache.set(n.id, null);
        return null;
      }
      if (analyzed >= MAX_FUNCTIONS) { bounded = true; lastGoFactsTruncated = true; return null; }
      let tree = trees.get(n.filePath);
      if (tree === undefined) {
        try {
          const source = await readFileConfined(absDir, n.filePath, MAX_SOURCE_FILE_BYTES);
          const bytes = Buffer.byteLength(source);
          if (sourceBytes + bytes > MAX_TOTAL_SOURCE_BYTES) {
            bounded = true;
            boundaries.add(`source byte budget exceeded (≤ ${MAX_TOTAL_SOURCE_BYTES} bytes); ${n.filePath} not analyzed`);
            tree = null;
          } else {
            sourceBytes += bytes;
          const parser = await getExceptionParser('Go', n.filePath);
          tree = parser ? parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, source) : null;
          if (tree?.rootNode.hasError) degradedFiles.add(n.filePath);
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('exceeds byte limit')) {
            boundaries.add(`source file exceeds per-file byte budget (≤ ${MAX_SOURCE_FILE_BYTES} bytes); ${n.filePath} not analyzed`);
          }
          tree = null;
        }
        trees.set(n.filePath, tree);
      }
      if (!tree) {
        boundaries.add(`source unreadable or too costly to parse — re-run analyze_codebase (${n.filePath})`);
        cache.set(n.id, null);
        return null;
      }
      if (degradedFiles.has(n.filePath)) {
        boundaries.add(`source contains syntax errors — re-run analyze_codebase after fixing (${n.filePath})`);
        cache.set(n.id, null);
        return null;
      }
      if (!rootAstIndexWithinBudget(tree.rootNode)) {
        boundaries.add(`AST traversal budget exceeded — ${n.filePath} not analyzed`);
        cache.set(n.id, null);
        return null;
      }
      const span = resolveCurrentFunctionSpan(tree.rootNode, n.startIndex, n.endIndex, n.language, n.name);
      if (!span) {
        boundaries.add(`indexed function span is stale — re-run analyze_codebase (${labelOf(n)})`);
        cache.set(n.id, null);
        return null;
      }
      if (span.startIndex !== n.startIndex || span.endIndex !== n.endIndex) {
        boundaries.add(`indexed function span changed and was re-resolved — re-run analyze_codebase (${labelOf(n)})`);
      }
      analyzed++;
      const facts = extractGoErrorFacts(tree.rootNode, span.startIndex, span.endIndex);
      for (const b of facts.boundaries) boundaries.add(`${n.filePath}: ${b}`);
      cache.set(n.id, facts);
      return facts;
    }

    interface GoEscape { value: string; kind: 'returned_error' | 'propagated_error' | 'panic'; originFunction: string; originFile: string; originLine: number; path: string[] }
    interface GoHandled { value: string; kind: 'checked_error' | 'recovered_panic'; handledIn: string; handledAtLine: number; fromCallee?: string }
    const handled: GoHandled[] = [];
    const memo = new Map<string, GoEscape[]>();
    async function walk(n: FunctionNode, depth: number, stack: Set<string>): Promise<{ esc: GoEscape[]; complete: boolean }> {
      if (stack.has(n.id)) return { esc: [], complete: true };
      if (depth > depthBound) { bounded = true; boundaries.add(`traversal bounded at depth ${depthBound}; deeper callees not analyzed`); return { esc: [], complete: false }; }
      if (memo.has(n.id)) return { esc: memo.get(n.id)!, complete: true };
      const facts = await factsForGo(n);
      if (!facts) return { esc: [], complete: !lastGoFactsTruncated };
      const self = labelOf(n);
      const out: GoEscape[] = facts.escapes.map(e => ({ value: e.value, kind: e.kind, originFunction: self, originFile: n.filePath, originLine: e.line, path: [self] }));
      for (const h of facts.handledInternally) handled.push({ value: h.value, kind: h.kind, handledIn: self, handledAtLine: h.line, fromCallee: h.fromCallee });
      let complete = true;
      const resolvedSites = new Set((calleesByCaller.get(n.id) ?? []).map(e => `${e.calleeName}@${e.line ?? -1}`));
      for (const site of facts.callSites) {
        if (!resolvedSites.has(`${site.calleeName}@${site.line}`)) boundaries.add(`${self}:${site.line} call to ${site.calleeName} has no resolved call-graph edge`);
      }
      for (const discarded of facts.discardedResults) {
        if (!resolvedSites.has(`${discarded.calleeName}@${discarded.line}`)) {
          boundaries.add(`${self}:${discarded.line} discarded result ${discarded.resultIndex} from unresolved ${discarded.calleeName || 'call'} may contain an error`);
        }
      }
      for (const site of ambiguousByCaller.get(n.id) ?? []) boundaries.add(`${self}:${site.line ?? '?'} call to ${site.calleeName} is unresolved-ambiguous (${site.candidateCount} candidates)`);
      const next = new Set(stack); next.add(n.id);
      for (const edge of calleesByCaller.get(n.id) ?? []) {
        const callee = nodeById.get(edge.calleeId);
        const matchingDiscarded = facts.discardedResults.filter(d =>
          d.calleeName === edge.calleeName && d.line === (edge.line ?? -1)
        );
        if (!callee || callee.isExternal) {
          external.add(edge.calleeName);
          for (const discarded of matchingDiscarded) boundaries.add(`${self}:${discarded.line} discarded result ${discarded.resultIndex} from unresolved ${edge.calleeName} may contain an error`);
          continue;
        }
        if (callee.isTest) { testCallees.add(edge.calleeName); continue; }
        if (callee.id === n.id) continue;
        const calleeFacts = await factsForGo(callee);
        const returnsChildError = calleeFacts?.returnsError === true;
        const matchingCallSites = facts.callSites.filter(site => site.calleeName === edge.calleeName && site.line === (edge.line ?? -1));
        const siteUnambiguous = matchingCallSites.length === 1;
        if (matchingCallSites.length > 1) boundaries.add(`${self}:${edge.line ?? '?'} has multiple ${edge.calleeName} call sites on one line; error handling/return attribution is not proven`);
        for (const discarded of matchingDiscarded) {
          if (!calleeFacts) boundaries.add(`${self}:${discarded.line} discarded result ${discarded.resultIndex} from ${labelOf(callee)} could not be typed`);
          else if (calleeFacts.errorResultIndices.includes(discarded.resultIndex)) boundaries.add(`${self}:${discarded.line} discards error result ${discarded.resultIndex} from ${labelOf(callee)}`);
        }
        const callerReturns = facts.escapes.some(s =>
          siteUnambiguous && s.kind === 'returned_error' && s.calleeName === edge.calleeName && s.callLine === (edge.line ?? -1) &&
          (s.callResultIndex === undefined || calleeFacts?.errorResultIndices.includes(s.callResultIndex))
        );
        const checkedCandidate = facts.checkedCandidates.find(s =>
          siteUnambiguous && s.fromCallee === edge.calleeName && s.callLine === (edge.line ?? -1) &&
          s.callResultIndex !== undefined && calleeFacts?.errorResultIndices.includes(s.callResultIndex)
        );
        const callerHandles = checkedCandidate !== undefined;
        if (checkedCandidate) handled.push({ value: checkedCandidate.value, kind: 'checked_error', handledIn: self, handledAtLine: checkedCandidate.line, fromCallee: labelOf(callee) });
        if (returnsChildError && !callerReturns && !callerHandles) {
          boundaries.add(`${self}:${edge.line ?? '?'} ignores an error result from ${labelOf(callee)}`);
        }
        const childResult = await walk(callee, depth + 1, next);
        if (!childResult.complete) complete = false;
        for (const child of childResult.esc) {
          if (child.kind === 'panic') {
            const recoveredAtSite = facts.recoveryDeferIndex !== undefined && facts.callSites.some(site =>
              site.calleeName === edge.calleeName && site.line === (edge.line ?? -1) && facts.recoveryDeferIndex! < site.index
            );
            if (recoveredAtSite) handled.push({ value: child.value, kind: 'recovered_panic', handledIn: self, handledAtLine: edge.line ?? 0, fromCallee: labelOf(callee) });
            else out.push({ ...child, path: [self, ...child.path] });
          } else if (callerReturns) {
            const proxyLines = new Set(facts.escapes.filter(s => s.kind === 'returned_error' && s.calleeName === edge.calleeName && s.callLine === (edge.line ?? -1)).map(s => s.line));
            for (let i = out.length - 1; i >= 0; i--) {
              if (out[i].originFunction === self && out[i].kind === 'returned_error' && proxyLines.has(out[i].originLine)) out.splice(i, 1);
            }
            out.push({ ...child, kind: 'propagated_error', path: [self, ...child.path] });
          }
        }
      }
      const byKey = new Map<string, GoEscape>();
      for (const escape of out) {
        const key = `${escape.kind}@@${escape.originFunction}@@${escape.originLine}@@${escape.value}`;
        const previous = byKey.get(key);
        const pathKey = escape.path.join('\0');
        const previousPathKey = previous?.path.join('\0') ?? '';
        if (!previous || escape.path.length < previous.path.length ||
          (escape.path.length === previous.path.length && pathKey < previousPathKey)) byKey.set(key, escape);
      }
      const deduped = [...byKey.values()];
      if (complete) memo.set(n.id, deduped);
      return { esc: deduped, complete };
    }
    const escapes = (await walk(query, 0, new Set())).esc;
    escapes.sort((a, b) => a.kind.localeCompare(b.kind) || a.originFunction.localeCompare(b.originFunction) ||
      a.originLine - b.originLine || a.value.localeCompare(b.value) || a.path.join('\0').localeCompare(b.path.join('\0')));
    const handledList = [...new Map(handled.map(h => [`${h.kind}@@${h.handledIn}@@${h.handledAtLine}@@${h.value}@@${h.fromCallee ?? ''}`, h])).values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.handledIn.localeCompare(b.handledIn) ||
        a.handledAtLine - b.handledAtLine || a.value.localeCompare(b.value) || (a.fromCallee ?? '').localeCompare(b.fromCallee ?? ''));
    if (bounded) boundaries.add(`analysis bounded (≤ ${MAX_FUNCTIONS} functions / depth ${depthBound}); some callees not analyzed`);
    if (external.size) boundaries.add(`${external.size} external/unresolved callee(s) not analyzed — their returned errors and panics are out of scope, never assumed none.`);
    if (testCallees.size) boundaries.add(`${testCallees.size} test-only callee(s) excluded from the production Go error-flow result.`);
    releaseTrees(trees);
    // Dynamic-boundary disclosure (change: disclose-dynamic-boundary-regions). This surface's
    // disclosure is a free-text `boundaries` list, so the sentence is RENDERED FROM the structured
    // crossing that also rides the result — one source, so the two cannot say different things.
    const dynamicCrossing = dynamicBoundaryCrossing(
      await loadDynamicBoundaryReport(absDir),
      [query.filePath, ...escapes.map(e => e.originFile)],
    );
    if (dynamicCrossing) boundaries.add(dynamicCrossing.detail);
    return {
      query: queryLabel, errorModel: 'go-value',
      summary: { escapes: escapes.length, returnedErrors: escapes.filter(e => e.kind !== 'panic').length, panics: escapes.filter(e => e.kind === 'panic').length, propagated: escapes.filter(e => e.kind === 'propagated_error').length, handledInternally: handledList.length, functionsAnalyzed: analyzed, externalCalleesNotAnalyzed: external.size },
      escapes, handledInternally: handledList, boundaries: [...boundaries].sort(),
      ...(dynamicCrossing ? { dynamicBoundaries: dynamicCrossing } : {}),
      ...(external.size ? { externalCalleesNotAnalyzed: { count: external.size, sample: [...external].sort().slice(0, 15) } } : {}),
      note: 'Go model: escapes are returned error values and unrecovered panics; handledInternally are checked-and-not-returned errors and recovered panics. This is a sound lower bound: unresolved calls and discarded results are disclosed in boundaries.',
    };
  }

  // ── Live exception-facts cache (parse each file once) ──────────────────────
  const treeByFile = new Map<string, Parser.Tree | null>();
  const degradedFiles = new Set<string>();
  const factsById = new Map<string, FunctionExceptionFacts | null>();
  const boundaries = new Set<string>();
  // External / unresolved callees are collapsed into a counted summary so a few
  // structural disclosures are not buried under dozens of stdlib-leaf names.
  const externalCallees = new Set<string>();
  const testCallees = new Set<string>();
  // Intra-object call sites (`this.x()` / `super.x()` / `self.x()` / `cls.x()`)
  // the call graph produced NO edge for — the one call shape that gets neither a
  // resolved nor an `external::` edge, so without this it would be silently
  // assumed exception-free. Disclosed, never dropped. Keyed by caller+line+name.
  const unresolvedSelfCalls = new Map<string, string>();
  // Chained intra-object call sites (`this.<field>.x()` / `self.<field>.x()`) whose receiver the
  // per-file type registry could not type (change: shrink-receiver-resolution-boundary). Kept
  // SEPARATE from `unresolvedSelfCalls`: there the callee is provably an in-project method we
  // failed to reach, here the callee's very provenance is unknown, so folding them together would
  // overclaim. Both are boundaries; only one of them is about resolution failure.
  const untypedReceiverCalls = new Map<string, string>();
  // Unresolved-ambiguous call sites reached during the traversal (change:
  // harden-call-resolution-ambiguity). Keyed by caller+line+name so a site is
  // disclosed once regardless of how often the node is revisited.
  const ambiguousCallSites = new Map<string, string>();
  let parsedCount = 0;
  let sourceBytes = 0;
  let capHit = false;
  // Set true by factsFor ONLY when it returned null because the parse cap was hit
  // (a budget truncation) — distinct from a genuine terminal null (unsupported
  // language / bodyless / unreadable), which is complete, not truncated.
  let lastFactsTruncated = false;

  async function factsFor(n: FunctionNode): Promise<FunctionExceptionFacts | null> {
    lastFactsTruncated = false;
    if (factsById.has(n.id)) return factsById.get(n.id)!;
    if (!ERROR_PROPAGATION_LANGUAGES.has(n.language)) {
      boundaries.add(`callee in unsupported language not analyzed (${n.language})`);
      factsById.set(n.id, null);
      return null;
    }
    if (!(n.startIndex < n.endIndex)) {
      factsById.set(n.id, null);
      return null;
    }
    if (parsedCount >= MAX_FUNCTIONS) {
      capHit = true;
      lastFactsTruncated = true;
      // Not cached: if budget frees on another path this node can still be parsed.
      return null;
    }
    let tree = treeByFile.get(n.filePath);
    if (tree === undefined) {
      try {
        // Re-check at the point of use as defense in depth: artifact nodes were
        // normalized above, but the filesystem may contain symlinks.
        const content = await readFileConfined(absDir, n.filePath, MAX_SOURCE_FILE_BYTES);
        const bytes = Buffer.byteLength(content);
        if (sourceBytes + bytes > MAX_TOTAL_SOURCE_BYTES) {
          capHit = true;
          boundaries.add(`source byte budget exceeded (≤ ${MAX_TOTAL_SOURCE_BYTES} bytes); ${n.filePath} not analyzed`);
          tree = null;
        } else {
          sourceBytes += bytes;
        const parser = await getExceptionParser(n.language, n.filePath);
        // Bounded (change: fix-analyze-native-abort-and-file-cost-budget): this parse runs inside
        // the long-lived daemon, so one pathological file must not be able to wedge it. On the
        // budget the file becomes a disclosed boundary below, never a silent "no exceptions".
        tree = parser ? parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content) : null;
        if (tree?.rootNode.hasError) degradedFiles.add(n.filePath);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('exceeds byte limit')) {
          boundaries.add(`source file exceeds per-file byte budget (≤ ${MAX_SOURCE_FILE_BYTES} bytes); ${n.filePath} not analyzed`);
        }
        tree = null;
      }
      treeByFile.set(n.filePath, tree);
    }
    if (!tree) {
      boundaries.add(`source unreadable or too costly to parse — re-run analyze_codebase (${n.filePath})`);
      factsById.set(n.id, null);
      return null;
    }
    if (degradedFiles.has(n.filePath)) {
      boundaries.add(`source contains syntax errors — re-run analyze_codebase after fixing (${n.filePath})`);
      factsById.set(n.id, null);
      return null;
    }
    if (!rootAstIndexWithinBudget(tree.rootNode)) {
      boundaries.add(`AST traversal budget exceeded — ${n.filePath} not analyzed`);
      factsById.set(n.id, null);
      return null;
    }
    const span = resolveCurrentFunctionSpan(tree.rootNode, n.startIndex, n.endIndex, n.language, n.name);
    if (!span) {
      boundaries.add(`indexed function span is stale — re-run analyze_codebase (${labelOf(n)})`);
      factsById.set(n.id, null);
      return null;
    }
    if (span.startIndex !== n.startIndex || span.endIndex !== n.endIndex) {
      boundaries.add(`indexed function span changed and was re-resolved — re-run analyze_codebase (${labelOf(n)})`);
    }
    parsedCount++;
    const facts = extractExceptionFacts(tree.rootNode, span.startIndex, span.endIndex, n.language);
    factsById.set(n.id, facts);
    for (const boundary of facts.boundaries) boundaries.add(`${n.filePath}: ${boundary}`);
    if (facts.tryGuards.some(g => g.caughtTypes.length > 0)) {
      boundaries.add(
        `${facts.language} typed handlers are matched by exact type name only — subclass catches are not ` +
          'modeled, so a typed handler may catch more than reported (conservative: it propagates).',
      );
    }
    return facts;
  }

  const handled: HandledEntry[] = [];
  // Memo holds ONLY fully-computed (untruncated) results — a result clipped by the
  // depth/parse bound is never cached, so a later shallower path recomputes it
  // rather than reusing a stale incomplete answer (sound lower bound).
  const memo = new Map<string, EscapeEntry[]>();

  /**
   * Is an exception of `type` propagating from a callee with edge `edge` caught at
   * its call site(s) in caller `facts`? Joined by (calleeName, line) to the
   * byte-precise call sites. Conservative: caught only if there IS a matching call
   * site and EVERY matching one catches the type (a name/line that does not match
   * any call site → not caught → it escapes — the safe direction).
   */
  function caughtAtCallSite(facts: FunctionExceptionFacts, edge: CallEdge, type: string): boolean {
    const matches = facts.callSites.filter(
      cs => cs.calleeName === edge.calleeName && cs.line === (edge.line ?? -1),
    );
    if (matches.length === 0) return false;
    return matches.every(cs => guardsCatch(cs.guards, type));
  }

  function suppressedAtCallSite(facts: FunctionExceptionFacts, edge: CallEdge): boolean {
    const matches = facts.callSites.filter(
      cs => cs.calleeName === edge.calleeName && cs.line === (edge.line ?? -1),
    );
    return matches.length > 0 && matches.every(cs => cs.guards.some(g => g.suppresses));
  }

  async function escapes(
    n: FunctionNode,
    depth: number,
    stack: Set<string>,
  ): Promise<{ esc: EscapeEntry[]; complete: boolean }> {
    if (stack.has(n.id)) return { esc: [], complete: true }; // cycle back-edge — no new escapes
    if (depth > depthBound) {
      capHit = true;
      boundaries.add(`traversal bounded at depth ${depthBound}; deeper callees not analyzed`);
      return { esc: [], complete: false };
    }
    const cached = memo.get(n.id);
    if (cached) return { esc: cached, complete: true };

    const facts = await factsFor(n);
    if (!facts || !facts.supported) {
      // A parse-cap truncation is incomplete; a genuine terminal (unsupported /
      // bodyless / unreadable) is complete — there is nothing more to find here.
      return { esc: [], complete: !lastFactsTruncated };
    }

    const out: EscapeEntry[] = [];
    const selfLabel = labelOf(n);
    let complete = true;

    // Disclose intra-object call sites (`this.x()` / `self.x()` …) the call graph
    // resolved to NO edge: an in-project method we cannot reach and so cannot
    // clear of throwing. Joined to the caller's edges by (calleeName, line); a
    // self-call with a matching edge DID resolve and is analyzed normally.
    const myEdges = calleesByCaller.get(n.id) ?? [];
    const resolvedHere = new Set(myEdges.map(e => `${e.calleeName}@${e.line ?? -1}`));
    for (const cs of facts.callSites) {
      if (cs.receiver === 'self-field') {
        // Resolved by the receiver registry ⇒ an edge exists and the callee is analyzed
        // normally. No edge ⇒ the field's type is unknown, which is a boundary, never a clean
        // absence (change: shrink-receiver-resolution-boundary).
        if (resolvedHere.has(`${cs.calleeName}@${cs.line}`)) continue;
        untypedReceiverCalls.set(
          `${n.id}@${cs.line}@${cs.calleeName}`,
          `${selfLabel}:${cs.line} (${cs.calleeName})`,
        );
        continue;
      }
      if (cs.receiver !== 'self' && cs.receiver !== 'constructor') continue;
      if (resolvedHere.has(`${cs.calleeName}@${cs.line}`)) continue;
      unresolvedSelfCalls.set(`${n.id}@${cs.line}@${cs.calleeName}`, `${selfLabel}:${cs.line} (${cs.calleeName})`);
    }

    // Disclose unresolved-ambiguous call sites at this node: a call the resolver
    // refused to bind because >1 candidate was viable with no affinity. Its callees'
    // exceptions are out of scope — a clean escape set does not clear these paths
    // (change: harden-call-resolution-ambiguity).
    for (const site of ambiguousByCaller.get(n.id) ?? []) {
      const recv = site.calleeObject ? `${site.calleeObject}.` : '';
      ambiguousCallSites.set(
        `${n.id}@${site.line ?? -1}@${site.calleeName}`,
        `${selfLabel}:${site.line ?? '?'} (${recv}${site.calleeName} → ${site.candidateCount} candidates)`,
      );
    }

    // Direct throws that escape this function.
    for (const ts of facts.throwSites) {
      if (ts.locallyHandled) continue;
      out.push({
        type: ts.type,
        kind: ts.source === 'throws_clause' ? 'declared' : 'direct',
        originFunction: selfLabel,
        originFile: n.filePath,
        originLine: ts.line,
        path: [selfLabel],
      });
    }

    // Propagated escapes from callees, filtered by the guard at the call site.
    const nextStack = new Set(stack);
    nextStack.add(n.id);
    for (const edge of calleesByCaller.get(n.id) ?? []) {
      const callee = nodeById.get(edge.calleeId);
      if (!callee || callee.isExternal) {
        externalCallees.add(edge.calleeName);
        continue;
      }
      if (callee.isTest) {
        testCallees.add(edge.calleeName);
        continue;
      }
      if (callee.id === n.id) continue; // direct self-recursion
      const child = await escapes(callee, depth + 1, nextStack);
      if (!child.complete) complete = false;
      for (const e of child.esc) {
        if (suppressedAtCallSite(facts, edge)) {
          continue;
        } else if (caughtAtCallSite(facts, edge, e.type)) {
          handled.push({
            type: e.type,
            caughtIn: selfLabel,
            caughtAtLine: edge.line ?? 0,
            fromCallee: labelOf(callee),
          });
        } else {
          out.push({ ...e, kind: 'propagated', path: [selfLabel, ...e.path] });
        }
      }
    }

    // Dedupe by (type, origin) keeping the shortest path — a stable set.
    const byKey = new Map<string, EscapeEntry>();
    for (const e of out) {
      const key = `${e.kind}@@${e.type}@@${e.originFunction}@@${e.originLine}`;
      const prev = byKey.get(key);
      const pathKey = e.path.join('\0');
      const previousPathKey = prev?.path.join('\0') ?? '';
      if (!prev || e.path.length < prev.path.length ||
        (e.path.length === prev.path.length && pathKey < previousPathKey)) byKey.set(key, e);
    }
    const deduped = [...byKey.values()];
    if (complete) memo.set(n.id, deduped); // never cache a truncated result
    return { esc: deduped, complete };
  }

  const escapeList = (await escapes(query, 0, new Set())).esc;

  // Dedupe handled events.
  const handledByKey = new Map<string, HandledEntry>();
  for (const h of handled) handledByKey.set(`${h.type}@@${h.caughtIn}@@${h.caughtAtLine}@@${h.fromCallee}`, h);
  const handledList = [...handledByKey.values()];

  // Stable, deterministic ordering (full tiebreak set so cache edge order never
  // perturbs output for entries that differ only in a later field).
  const sortEsc = (a: EscapeEntry, b: EscapeEntry): number =>
    a.type.localeCompare(b.type) || a.originFunction.localeCompare(b.originFunction) || a.originLine - b.originLine ||
    a.kind.localeCompare(b.kind) || a.path.join('\0').localeCompare(b.path.join('\0'));
  escapeList.sort(sortEsc);
  handledList.sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      a.caughtIn.localeCompare(b.caughtIn) ||
      a.fromCallee.localeCompare(b.fromCallee) ||
      a.caughtAtLine - b.caughtAtLine,
  );

  if (capHit) boundaries.add(`analysis bounded (≤ ${MAX_FUNCTIONS} functions / depth ${depthBound}); some callees not analyzed`);

  const externalSample = [...externalCallees].sort();
  if (externalCallees.size > 0) {
    boundaries.add(
      `${externalCallees.size} external/unresolved callee(s) not analyzed (stdlib leaves, ` +
        'unresolved names) — their exceptions are out of scope, never assumed none.',
    );
  }
  if (testCallees.size > 0) {
    boundaries.add(
      `${testCallees.size} test-only callee(s) excluded from the production escape set ` +
        '(a production function calling test code is itself unusual).',
    );
  }
  const unresolvedSelfSample = [...unresolvedSelfCalls.values()].sort();
  if (unresolvedSelfCalls.size > 0) {
    boundaries.add(
      `${unresolvedSelfCalls.size} intra-object call site(s) or constructor call(s) could not be ` +
        'resolved to an indexed target (a call-graph resolution limit) — their exceptions are out of ' +
        'scope, NEVER assumed none. A clean escape set does not clear these paths.',
    );
  }
  const untypedReceiverSample = [...untypedReceiverCalls.values()].sort();
  if (untypedReceiverCalls.size > 0) {
    boundaries.add(
      `${untypedReceiverCalls.size} chained intra-object call site(s) (\`this.<field>.m()\`) whose ` +
        'receiver type the per-file registry could not determine — the callee is of UNKNOWN ' +
        'provenance (in-project or external), so its exceptions are out of scope, NEVER assumed ' +
        'none. A clean escape set does not clear these paths.',
    );
  }
  const ambiguousSample = [...ambiguousCallSites.values()].sort();
  if (ambiguousCallSites.size > 0) {
    boundaries.add(
      `${ambiguousCallSites.size} unresolved-ambiguous call site(s) (a bare/self/type-name call whose ` +
        'name matched more than one candidate with no affinity) were NOT bound to an edge — their ' +
        "callees' exceptions are out of scope, NEVER assumed none. A clean escape set does not clear " +
        'these paths.',
    );
  }

  // Dynamic-boundary disclosure (change: disclose-dynamic-boundary-regions). Same rule as the Go
  // lane: the sentence in `boundaries` is RENDERED FROM the structured crossing that also rides the
  // result, so the free-text and structured disclosures cannot diverge. A callee reached only
  // through a reflective dispatch is not in the escape set at all, which is exactly why a clean
  // escape set next to a site must not read as "this function throws nothing".
  const dynamicCrossing = dynamicBoundaryCrossing(
    await loadDynamicBoundaryReport(absDir),
    [query.filePath, ...escapeList.map(e => e.originFile)],
  );
  if (dynamicCrossing) boundaries.add(dynamicCrossing.detail);

  const directCount = escapeList.filter(e => e.kind === 'direct').length;
  const declaredCount = escapeList.filter(e => e.kind === 'declared').length;
  const propagatedCount = escapeList.filter(e => e.kind === 'propagated').length;
  const dynamicCount = escapeList.filter(e => e.type === DYNAMIC_TYPE).length;

  releaseTrees(treeByFile);
  return {
    query: queryLabel,
    summary: {
      escapes: escapeList.length,
      direct: directCount,
      propagated: propagatedCount,
      ...(declaredCount > 0 ? { declared: declaredCount } : {}),
      dynamic: dynamicCount,
      handledInternally: handledList.length,
      functionsAnalyzed: parsedCount,
      externalCalleesNotAnalyzed: externalCallees.size,
      unresolvedSelfCalls: unresolvedSelfCalls.size,
      untypedReceiverCalls: untypedReceiverCalls.size,
      ambiguousCallSites: ambiguousCallSites.size,
    },
    escapes: escapeList,
    handledInternally: handledList,
    boundaries: [...boundaries].sort(),
    ...(dynamicCrossing ? { dynamicBoundaries: dynamicCrossing } : {}),
    ...(externalCallees.size > 0
      ? { externalCalleesNotAnalyzed: { count: externalCallees.size, sample: externalSample.slice(0, 15) } }
      : {}),
    ...(unresolvedSelfCalls.size > 0
      ? { unresolvedSelfCalls: { count: unresolvedSelfCalls.size, sample: unresolvedSelfSample.slice(0, 15) } }
      : {}),
    ...(untypedReceiverCalls.size > 0
      ? { untypedReceiverCalls: { count: untypedReceiverCalls.size, sample: untypedReceiverSample.slice(0, 15) } }
      : {}),
    ...(ambiguousCallSites.size > 0
      ? { ambiguousCallSites: { count: ambiguousCallSites.size, sample: ambiguousSample.slice(0, 15) } }
      : {}),
    note:
      'escapes = exception types that can propagate OUT of this function to its callers (each with ' +
      'origin + call path; `<dynamic>` = a re-raise/throw whose static type is unknowable). ' +
      'handledInternally = exceptions thrown in the reachable subtree but caught within this ' +
      "function's reach (callers are shielded). This is a SOUND LOWER BOUND: an un-analyzable " +
      'callee is disclosed in boundaries, never assumed exception-free. Spans come from the indexed ' +
      'byte ranges — re-run analyze_codebase after edits.',
  };
}
