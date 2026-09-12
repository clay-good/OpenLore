/**
 * Literal reflective dispatch resolution (change: resolve-literal-reflective-dispatch).
 *
 * The dynamic-boundary matcher records every reflective construct as a CANDIDATE. This module
 * decides, after the class hierarchy exists (Pass 7), which candidates bind structurally:
 *
 *  - **Literal dispatch table** — `HANDLERS[k]()` / `HANDLERS["create"]()` over a module-level
 *    table of literal keys to named functions that the matcher found stable in its file. Every
 *    entry must bind; a table over the synthesis fan-out cap binds nothing (`over-cap`).
 *  - **Literal member on a self-typed receiver** — `this["m"]()`, `getattr(self, "m")()`, Ruby
 *    `send(:m)`. The receiver's type is the enclosing class, so `m` is looked up in that class and
 *    its subclasses, or — only when none defines it and every ancestor's base is resolved — in its
 *    ancestors.
 *
 * Resolution is STRICT-UNIQUENESS: a target binds only when exactly one internal candidate remains
 * after narrowing. There is no same-file preference — a same-file homonym beside other homonyms is
 * ambiguous. Reflection by bare method name on an untyped receiver is never resolved here; it stays
 * a disclosed boundary.
 *
 * The output is additive: synthesized edges plus the bound and refused candidate keys that decide
 * the dynamic-boundary partition. A candidate this module did not attempt is left to the name
 * count. Deterministic: inputs are iterated in build order, targets in id order.
 */

import type { CallEdge, ClassNode, FunctionNode, InheritanceEdge } from './call-graph-types.js';
import {
  REFLECTIVE_RESOLUTION_RULE,
  type AttributedCandidate,
  type DynamicBoundaryRefusal,
} from './dynamic-boundary.js';

export interface LiteralReflectionInput {
  candidatesByFile: ReadonlyMap<string, { language: string; candidates: AttributedCandidate[] }>;
  nodes: ReadonlyMap<string, FunctionNode>;
  classes: readonly ClassNode[];
  inheritanceEdges: readonly InheritanceEdge[];
  /** Every edge accumulated so far. An emitted caller→callee pair never duplicates one of these. */
  edges: readonly CallEdge[];
  /** The synthesis per-site fan-out cap, passed in so this module stays a leaf. */
  fanOutCap: number;
}

export interface LiteralReflectionResult {
  /** New `literal-reflective` edges, never a pair already present in the input edges. */
  edges: CallEdge[];
  /** {@link literalReflectionKey} of every candidate whose target bound (its edge exists). */
  bound: Set<string>;
  /** The resolver's own refusal for a candidate it attempted and declined. */
  refusals: Map<string, DynamicBoundaryRefusal>;
}

/** Candidate identity: a resolved edge carries no offset, so retraction keys on the construct. */
export function literalReflectionKey(filePath: string, startIndex: number): string {
  return `${filePath}\u0000${startIndex}`;
}

type Outcome = { targets?: FunctionNode[]; refusal?: DynamicBoundaryRefusal };

export function resolveLiteralReflection(input: LiteralReflectionInput): LiteralReflectionResult {
  const result: LiteralReflectionResult = { edges: [], bound: new Set(), refusals: new Map() };
  const work: Array<{ filePath: string; c: AttributedCandidate }> = [];
  for (const [filePath, { candidates }] of input.candidatesByFile) {
    for (const c of candidates) {
      if (c.table || (c.receiver === 'self' && c.literalTarget)) work.push({ filePath, c });
    }
  }
  if (work.length === 0) return result;

  const callers = new Set(work.map(w => w.c.symbolId).filter((id): id is string => !!id));
  const present = new Set<string>();
  for (const e of input.edges) {
    if (callers.has(e.callerId)) present.add(`${e.callerId}\u0000${e.calleeId}`);
  }

  let free: Map<string, FunctionNode[]> | undefined;
  let hierarchy: Hierarchy | undefined;
  for (const { filePath, c } of work) {
    const key = literalReflectionKey(filePath, c.startIndex);
    const outcome = c.table
      ? resolveTable(c.table, (free ??= freeFunctionsByName(input.nodes)), input.fanOutCap)
      : resolveSelf(c, input.nodes, (hierarchy ??= buildHierarchy(input.classes, input.inheritanceEdges)));
    if (outcome.refusal) {
      result.refusals.set(key, outcome.refusal);
      continue;
    }
    if (!outcome.targets) continue;
    if (!c.symbolId) {
      // Every target binds, but no indexed symbol contains the construct to be the caller.
      result.refusals.set(key, 'resolvable-but-unbound');
      continue;
    }
    result.bound.add(key);
    for (const target of outcome.targets) {
      const pair = `${c.symbolId}\u0000${target.id}`;
      if (present.has(pair)) continue;
      present.add(pair);
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

/** Internal free functions by simple name — the only things a table's bare identifier can bind. */
function freeFunctionsByName(nodes: ReadonlyMap<string, FunctionNode>): Map<string, FunctionNode[]> {
  const out = new Map<string, FunctionNode[]>();
  for (const n of nodes.values()) {
    if (n.isExternal || n.className) continue;
    const list = out.get(n.name);
    if (list) list.push(n); else out.set(n.name, [n]);
  }
  return out;
}

function resolveTable(
  table: { names: string[]; size: number },
  free: Map<string, FunctionNode[]>,
  cap: number,
): Outcome {
  if (table.size > cap) return { refusal: 'over-cap' };
  let ambiguous = false;
  let missing = false;
  const targets: FunctionNode[] = [];
  for (const name of table.names) {
    const found = free.get(name) ?? [];
    if (found.length > 1) ambiguous = true;
    else if (found.length === 0) missing = true;
    else targets.push(found[0]);
  }
  // All or nothing: a partial edge set with the construct retracted would hide the missing target.
  if (ambiguous) return { refusal: 'ambiguous-target' };
  if (missing) return { refusal: 'unresolved-external' };
  return { targets: byId(targets) };
}

interface Hierarchy {
  byFileAndName: Map<string, ClassNode>;
  byId: Map<string, ClassNode>;
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
}

function buildHierarchy(classes: readonly ClassNode[], inheritance: readonly InheritanceEdge[]): Hierarchy {
  const h: Hierarchy = { byFileAndName: new Map(), byId: new Map(), parents: new Map(), children: new Map() };
  for (const cls of classes) {
    h.byId.set(cls.id, cls);
    if (!cls.isModule) h.byFileAndName.set(`${cls.filePath}\u0000${cls.name}`, cls);
  }
  for (const e of inheritance) {
    // Method inheritance only; an implemented interface contributes no body.
    if (e.kind !== 'extends' && e.kind !== 'embeds') continue;
    (h.parents.get(e.childId) ?? h.parents.set(e.childId, []).get(e.childId)!).push(e.parentId);
    (h.children.get(e.parentId) ?? h.children.set(e.parentId, []).get(e.parentId)!).push(e.childId);
  }
  return h;
}

/** Every class reachable from `start` over `links`, excluding `start`. Iterative, cycle-safe. */
function closure(start: ClassNode, links: Map<string, string[]>, h: Hierarchy): ClassNode[] {
  const seen = new Set([start.id]);
  const out: ClassNode[] = [];
  const stack = [...(links.get(start.id) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const cls = h.byId.get(id);
    if (!cls) continue;
    out.push(cls);
    stack.push(...(links.get(id) ?? []));
  }
  return out;
}

function methodsNamed(classes: ClassNode[], name: string, nodes: ReadonlyMap<string, FunctionNode>): FunctionNode[] {
  const out = new Map<string, FunctionNode>();
  for (const cls of classes) {
    for (const id of cls.methodIds) {
      const n = nodes.get(id);
      if (n && !n.isExternal && n.name === name) out.set(n.id, n);
    }
  }
  return byId([...out.values()]);
}

function resolveSelf(c: AttributedCandidate, nodes: ReadonlyMap<string, FunctionNode>, h: Hierarchy): Outcome {
  const caller = c.symbolId ? nodes.get(c.symbolId) : undefined;
  if (!caller?.className || !c.literalTarget) return {};
  const cls = h.byFileAndName.get(`${caller.filePath}\u0000${caller.className}`);
  if (!cls) return {};
  // The receiver's dynamic type is the class or a subclass, so a definition there wins.
  let targets = methodsNamed([cls, ...closure(cls, h.children, h)], c.literalTarget, nodes);
  if (targets.length === 0) {
    // Otherwise the nearest ancestor's — but only when no base anywhere up the chain is unresolved,
    // since an external base could define the method first in the resolution order.
    const ancestors = closure(cls, h.parents, h);
    const resolved = [cls, ...ancestors]
      .every(k => (h.parents.get(k.id)?.length ?? 0) >= k.parentClasses.length);
    targets = resolved ? methodsNamed(ancestors, c.literalTarget, nodes) : [];
  }
  if (targets.length > 1) return { refusal: 'ambiguous-target' };
  return targets.length === 1 ? { targets } : {};
}

function byId(list: FunctionNode[]): FunctionNode[] {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
