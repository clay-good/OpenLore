/**
 * Literal reflective dispatch resolution (change: resolve-literal-reflective-dispatch).
 *
 * The dynamic-boundary matcher records every reflective construct as a CANDIDATE. This module
 * decides, after every other edge exists (Pass 7a), which candidates bind structurally. One family is
 * recovered: a **literal dispatch table** — `HANDLERS[k]()` / `HANDLERS["create"]()` over a
 * module-private JS/TS `const` table the matcher proved stable in its file. Each entry binds by the
 * byte span of its same-file module-level declaration, never by name; an entry the matcher could
 * not prove local (an import, a reassigned or `this`-using function) keeps the construct a site. A
 * non-literal key binds every entry or none, and a table over the synthesis fan-out cap binds none.
 *
 * Deliberately NOT recovered: a literal member on a self-typed receiver (`this["m"]()`,
 * `getattr(self, "m")()`, Ruby `send(:m)`). Two rounds of adversarial review showed the class graph
 * cannot bound that type soundly — members added by assignment or mixins, and subclasses whose
 * parent never resolved, are invisible — so those constructs stay disclosed sites.
 *
 * The output is additive: synthesized edges plus the bound and refused candidate keys that decide
 * the dynamic-boundary partition. Deterministic: inputs in build order, targets in id order.
 */

import type { CallEdge, FunctionNode } from './call-graph-types.js';
import {
  REFLECTIVE_RESOLUTION_RULE,
  type AttributedCandidate,
  type DynamicBoundaryRefusal,
} from './dynamic-boundary.js';

export interface LiteralReflectionInput {
  candidatesByFile: ReadonlyMap<string, { language: string; candidates: AttributedCandidate[] }>;
  nodes: ReadonlyMap<string, FunctionNode>;
  /** Every edge accumulated so far. An emitted caller→callee pair never duplicates one of these. */
  edges: readonly CallEdge[];
  /** The synthesis per-site fan-out cap, passed in so this module stays a leaf. */
  fanOutCap: number;
}

export interface LiteralReflectionResult {
  /** New `literal-reflective` edges, never a pair already present in the input edges. */
  edges: CallEdge[];
  /** {@link literalReflectionKey} of every candidate whose targets bound (their edges exist). */
  bound: Set<string>;
  /** The resolver's own refusal for a candidate it attempted and declined. */
  refusals: Map<string, DynamicBoundaryRefusal>;
}

/**
 * Candidate identity: a resolved edge carries no offset, so retraction keys on the construct. The
 * offset leads and the path follows a colon, so no path can make two keys collide.
 */
export function literalReflectionKey(filePath: string, startIndex: number): string {
  return `${startIndex}:${filePath}`;
}

type Outcome = { targets: FunctionNode[] } | { refusal: DynamicBoundaryRefusal };

export function resolveLiteralReflection(input: LiteralReflectionInput): LiteralReflectionResult {
  const result: LiteralReflectionResult = { edges: [], bound: new Set(), refusals: new Map() };
  const work: Array<{ filePath: string; c: AttributedCandidate & { table: NonNullable<AttributedCandidate['table']> } }> = [];
  for (const [filePath, { candidates }] of input.candidatesByFile) {
    // A file whose matcher counted more constructs than it retained binds nothing. The unretained
    // constructs are disclosed only as a count, so a binding that emptied the listed sites would leave
    // that count with no line to name — and a conclusion with nothing to qualify it.
    if (candidates.some(c => (c.matchedTotal ?? 0) > candidates.length)) continue;
    for (const c of candidates) if (c.table) work.push({ filePath, c: c as typeof work[number]['c'] });
  }
  if (work.length === 0) return result;

  const callers = new Set(work.map(w => w.c.symbolId).filter((id): id is string => !!id));
  const present = new Map<string, Set<string>>();
  const has = (caller: string, callee: string): boolean => present.get(caller)?.has(callee) ?? false;
  const add = (caller: string, callee: string): void => {
    (present.get(caller) ?? present.set(caller, new Set()).get(caller)!).add(callee);
  };
  for (const e of input.edges) if (callers.has(e.callerId)) add(e.callerId, e.calleeId);

  let byFile: Map<string, FunctionNode[]> | undefined;
  for (const { filePath, c } of work) {
    const key = literalReflectionKey(filePath, c.startIndex);
    const outcome = resolveTable(c.table, (byFile ??= nodesByFile(input.nodes)).get(filePath) ?? [], input.fanOutCap);
    if ('refusal' in outcome) {
      result.refusals.set(key, outcome.refusal);
      continue;
    }
    if (!c.symbolId) {
      result.refusals.set(key, 'unattributed-caller');
      continue;
    }
    result.bound.add(key);
    for (const target of outcome.targets) {
      if (has(c.symbolId, target.id)) continue;
      add(c.symbolId, target.id);
      result.edges.push({
        callerId: c.symbolId,
        calleeId: target.id,
        calleeName: target.name,
        line: c.line,
        confidence: 'synthesized',
        kind: 'calls',
        callType: 'direct',
        synthesizedBy: REFLECTIVE_RESOLUTION_RULE,
      });
    }
  }
  return result;
}

function nodesByFile(nodes: ReadonlyMap<string, FunctionNode>): Map<string, FunctionNode[]> {
  const out = new Map<string, FunctionNode[]>();
  for (const n of nodes.values()) {
    if (n.isExternal) continue;
    const list = out.get(n.filePath);
    if (list) list.push(n); else out.set(n.filePath, [n]);
  }
  return out;
}

function resolveTable(
  table: NonNullable<AttributedCandidate['table']>,
  fileNodes: FunctionNode[],
  cap: number,
): Outcome {
  if (table.size > cap) return { refusal: 'over-cap' };
  if (table.nonLocal || !table.decls || table.decls.length !== table.names.length) {
    return { refusal: 'unresolved-in-file-scope' };
  }
  const targets = new Map<string, FunctionNode>();
  for (let i = 0; i < table.names.length; i++) {
    const [start, end] = table.decls[i];
    // The node the extractor emitted for THIS declaration: same name, overlapping span.
    const found = fileNodes.filter(n =>
      n.name === table.names[i] && n.startIndex < end && start < n.endIndex);
    // All or nothing: a partial edge set with the construct retracted would hide a target. A
    // declaration the extractor emitted no matching node for is still a same-file symbol, so the
    // refusal must not claim it resolves to nothing.
    if (found.length > 1) return { refusal: 'ambiguous-target' };
    if (found.length === 0) return { refusal: 'unresolved-in-file-scope' };
    targets.set(found[0].id, found[0]);
  }
  return { targets: [...targets.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}
