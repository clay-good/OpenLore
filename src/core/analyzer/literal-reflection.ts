/**
 * Literal reflective dispatch resolution (change: resolve-literal-reflective-dispatch).
 *
 * The dynamic-boundary matcher records every reflective construct as a CANDIDATE. This module
 * decides, after the class hierarchy exists (Pass 7), which candidates bind structurally:
 *
 *  - **Literal dispatch table** — `HANDLERS[k]()` / `HANDLERS["create"]()` over a module-private
 *    `const` table the matcher proved stable in its file, whose every entry names a function declared
 *    at module level in that same file. The binding is by declaration span, never by name: an entry
 *    bound by an import is a reference this file cannot resolve. Every entry must bind; a table over
 *    the synthesis fan-out cap binds nothing (`over-cap`).
 *  - **Literal member on a self-typed receiver** — `this["m"]()`, `getattr(self, "m")()`, Ruby
 *    `send(:m)`, recorded by the matcher only in the lexical instance context of a class. A receiver
 *    of that class or any subclass reaches the class's own definition (or else its nearest
 *    ancestor's) plus every subclass override; exactly one such method binds.
 *
 * Resolution is STRICT-UNIQUENESS. Hierarchy shapes whose method resolution order a class graph
 * cannot establish — more than one parent anywhere involved, an unresolved base above a class with
 * no own definition, a Ruby class reopened across files — are not attempted, and the name count
 * decides the refusal. Reflection by bare method name on an untyped receiver is never resolved.
 *
 * The output is additive: synthesized edges plus the bound and refused candidate keys that decide
 * the dynamic-boundary partition. Deterministic: inputs in build order, targets in id order.
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

type Outcome = { targets?: FunctionNode[]; refusal?: DynamicBoundaryRefusal };

export function resolveLiteralReflection(input: LiteralReflectionInput): LiteralReflectionResult {
  const result: LiteralReflectionResult = { edges: [], bound: new Set(), refusals: new Map() };
  const work: Array<{ filePath: string; language: string; c: AttributedCandidate }> = [];
  for (const [filePath, { language, candidates }] of input.candidatesByFile) {
    for (const c of candidates) {
      if (c.table || (c.receiver === 'self' && c.literalTarget)) work.push({ filePath, language, c });
    }
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
  let hierarchy: Hierarchy | undefined;
  for (const { filePath, language, c } of work) {
    const key = literalReflectionKey(filePath, c.startIndex);
    const outcome = c.table
      ? resolveTable(c.table, (byFile ??= nodesByFile(input.nodes)).get(filePath) ?? [], input.fanOutCap)
      : resolveSelf(c, language, input.nodes,
        (hierarchy ??= buildHierarchy(input.classes, input.inheritanceEdges)));
    if (outcome.refusal) {
      result.refusals.set(key, outcome.refusal);
      continue;
    }
    if (!outcome.targets) continue;
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
    // All or nothing: a partial edge set with the construct retracted would hide a target.
    if (found.length !== 1) return { refusal: found.length === 0 ? 'unresolved-external' : 'ambiguous-target' };
    targets.set(found[0].id, found[0]);
  }
  return { targets: byId([...targets.values()]) };
}

interface Hierarchy {
  byFileAndName: Map<string, ClassNode>;
  byName: Map<string, ClassNode[]>;
  byId: Map<string, ClassNode>;
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
}

function buildHierarchy(classes: readonly ClassNode[], inheritance: readonly InheritanceEdge[]): Hierarchy {
  const h: Hierarchy = {
    byFileAndName: new Map(), byName: new Map(), byId: new Map(), parents: new Map(), children: new Map(),
  };
  for (const cls of classes) {
    h.byId.set(cls.id, cls);
    if (cls.isModule) continue;
    h.byFileAndName.set(`${cls.name} ${cls.filePath}`, cls);
    (h.byName.get(cls.name) ?? h.byName.set(cls.name, []).get(cls.name)!).push(cls);
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
    for (const next of links.get(id) ?? []) stack.push(next);
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
  return [...out.values()];
}

function resolveSelf(
  c: AttributedCandidate,
  language: string,
  nodes: ReadonlyMap<string, FunctionNode>,
  h: Hierarchy,
): Outcome {
  const caller = c.symbolId ? nodes.get(c.symbolId) : undefined;
  const member = c.literalTarget;
  if (!caller?.className || !member) return {};
  const cls = h.byFileAndName.get(`${caller.className} ${caller.filePath}`);
  if (!cls) return {};
  // A Ruby class reopened in another file is ONE class split across ClassNodes.
  if (language === 'Ruby' && (h.byName.get(cls.name)?.length ?? 0) > 1) return {};

  const subclasses = closure(cls, h.children, h);
  const ancestors = closure(cls, h.parents, h);
  // More than one parent anywhere makes the resolution order (Python MRO, mixin order) a question the
  // class graph cannot answer.
  if ([cls, ...subclasses, ...ancestors].some(k => k.parentClasses.length > 1)) return {};

  let base = methodsNamed([cls], member, nodes);
  if (base.length === 0) {
    // An unresolved base could define the member before any indexed ancestor does.
    const fullyResolved = [cls, ...ancestors]
      .every(k => (h.parents.get(k.id)?.length ?? 0) >= k.parentClasses.length);
    if (!fullyResolved) return {};
    // Single-parent chain upward; the nearest definition wins.
    let current: ClassNode | undefined = cls;
    const walked = new Set<string>([cls.id]);
    while (current && base.length === 0) {
      const parentId: string | undefined = h.parents.get(current.id)?.[0];
      current = parentId && !walked.has(parentId) ? h.byId.get(parentId) : undefined;
      if (current) {
        walked.add(current.id);
        base = methodsNamed([current], member, nodes);
      }
    }
  }
  const targets = new Map<string, FunctionNode>();
  for (const n of [...base, ...methodsNamed(subclasses, member, nodes)]) targets.set(n.id, n);
  if (targets.size > 1) return { refusal: 'ambiguous-target' };
  if (targets.size === 1) return { targets: [...targets.values()] };
  // The whole type is visible (every base resolved) and nothing in it carries the member.
  return { refusal: 'unresolved-in-type' };
}

function byId(list: FunctionNode[]): FunctionNode[] {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
