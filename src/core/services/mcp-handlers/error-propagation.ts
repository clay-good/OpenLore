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
 * Scope: TypeScript / JavaScript / Python (the languages with cleanly extractable
 * throw + typed/untyped catch semantics). A query in any other language returns an
 * explicit `unsupported` result, never an empty escape set.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type Parser from 'tree-sitter';
import { validateDirectory, readCachedContext } from './utils.js';
import {
  ERROR_PROPAGATION_LANGUAGES,
  getExceptionParser,
  extractExceptionFacts,
  guardsCatch,
  DYNAMIC_TYPE,
  type FunctionExceptionFacts,
} from '../../analyzer/exception-flow.js';
import type { SerializedCallGraph, FunctionNode, CallEdge } from '../../analyzer/call-graph.js';

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

/** One exception that can escape the query function. */
interface EscapeEntry {
  type: string;
  /** 'direct' = thrown by the query itself; 'propagated' = from a callee. */
  kind: 'direct' | 'propagated';
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
  const allNodes = (cg.nodes ?? []) as FunctionNode[];
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

  const depthBound = Number.isFinite(input.maxDepth as number)
    ? Math.max(MIN_DEPTH, Math.min(input.maxDepth as number, MAX_DEPTH))
    : DEFAULT_DEPTH;

  // ── Live exception-facts cache (parse each file once) ──────────────────────
  const treeByFile = new Map<string, Parser.Tree | null>();
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
  let parsedCount = 0;
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
        const content = await readFile(join(absDir, n.filePath), 'utf-8');
        const parser = await getExceptionParser(n.language);
        tree = parser ? parser.parse(content) : null;
      } catch {
        tree = null;
      }
      treeByFile.set(n.filePath, tree);
    }
    if (!tree) {
      boundaries.add(`source unreadable since analysis — re-run analyze_codebase (${n.filePath})`);
      factsById.set(n.id, null);
      return null;
    }
    parsedCount++;
    const facts = extractExceptionFacts(tree.rootNode, n.startIndex, n.endIndex, n.language);
    factsById.set(n.id, facts);
    if (facts.tryGuards.some(g => g.caughtTypes.length > 0)) {
      boundaries.add(
        'Python typed `except` is matched by exact type name only — subclass catches are not ' +
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

  async function escapes(
    n: FunctionNode,
    depth: number,
    stack: Set<string>,
  ): Promise<{ esc: EscapeEntry[]; complete: boolean }> {
    const cached = memo.get(n.id);
    if (cached) return { esc: cached, complete: true };
    if (stack.has(n.id)) return { esc: [], complete: true }; // cycle back-edge — no new escapes
    if (depth > depthBound) {
      capHit = true;
      boundaries.add(`traversal bounded at depth ${depthBound}; deeper callees not analyzed`);
      return { esc: [], complete: false };
    }

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
      if (cs.receiver !== 'self') continue;
      if (resolvedHere.has(`${cs.calleeName}@${cs.line}`)) continue;
      unresolvedSelfCalls.set(`${n.id}@${cs.line}@${cs.calleeName}`, `${selfLabel}:${cs.line} (${cs.calleeName})`);
    }

    // Direct throws that escape this function.
    for (const ts of facts.throwSites) {
      if (ts.locallyHandled) continue;
      out.push({
        type: ts.type,
        kind: 'direct',
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
        if (caughtAtCallSite(facts, edge, e.type)) {
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
      const key = `${e.type}@@${e.originFunction}@@${e.originLine}`;
      const prev = byKey.get(key);
      if (!prev || e.path.length < prev.path.length) byKey.set(key, e);
    }
    const deduped = [...byKey.values()];
    if (complete) memo.set(n.id, deduped); // never cache a truncated result
    return { esc: deduped, complete };
  }

  const escapeList = (await escapes(query, 0, new Set())).esc;

  // Dedupe handled events.
  const handledByKey = new Map<string, HandledEntry>();
  for (const h of handled) handledByKey.set(`${h.type}@@${h.caughtIn}@@${h.fromCallee}`, h);
  const handledList = [...handledByKey.values()];

  // Stable, deterministic ordering (full tiebreak set so cache edge order never
  // perturbs output for entries that differ only in a later field).
  const sortEsc = (a: EscapeEntry, b: EscapeEntry): number =>
    a.type.localeCompare(b.type) || a.originFunction.localeCompare(b.originFunction) || a.originLine - b.originLine;
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
      `${unresolvedSelfCalls.size} intra-object call site(s) (this./super./self./cls.) could not be ` +
        'resolved to an indexed method (a call-graph resolution limit) — their exceptions are out of ' +
        'scope, NEVER assumed none. A clean escape set does not clear these paths.',
    );
  }

  const directCount = escapeList.filter(e => e.kind === 'direct').length;
  const dynamicCount = escapeList.filter(e => e.type === DYNAMIC_TYPE).length;

  return {
    query: queryLabel,
    summary: {
      escapes: escapeList.length,
      direct: directCount,
      propagated: escapeList.length - directCount,
      dynamic: dynamicCount,
      handledInternally: handledList.length,
      functionsAnalyzed: parsedCount,
      externalCalleesNotAnalyzed: externalCallees.size,
      unresolvedSelfCalls: unresolvedSelfCalls.size,
    },
    escapes: escapeList,
    handledInternally: handledList,
    boundaries: [...boundaries].sort(),
    ...(externalCallees.size > 0
      ? { externalCalleesNotAnalyzed: { count: externalCallees.size, sample: externalSample.slice(0, 15) } }
      : {}),
    ...(unresolvedSelfCalls.size > 0
      ? { unresolvedSelfCalls: { count: unresolvedSelfCalls.size, sample: unresolvedSelfSample.slice(0, 15) } }
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
