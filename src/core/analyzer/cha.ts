/**
 * Class Hierarchy Analysis (CHA) — type-hierarchy-resolved polymorphic dispatch.
 * (spec: add-type-hierarchy-resolved-dispatch)
 *
 * Closes the polymorphic-dispatch blind spot deterministically, from the
 * `ClassNode` / `InheritanceEdge` hierarchy the call graph already extracts plus
 * the existing type-inference engine — no LLM, no points-to solve. Classic CHA
 * (Dean, Grove, Chambers, ECOOP 1995): resolve a virtual call `recv.m()` to the
 * implementations of `m` reachable in the type subtree of `recv`'s type.
 *
 * Two additive, provenance-labeled edge kinds, both `confidence: 'synthesized'`:
 *
 *  - **Virtual-dispatch** (`kind: 'calls'`): from an unpinned `recv.m()` call site
 *    to each implementation of `m` in `recv`'s subtree. Labeled `cha-declared-type`
 *    when the receiver type was statically recovered (so the target set is narrowed
 *    to that type's subtree) and `cha-name-only` when it was not (a deliberately
 *    weaker over-approximation: every implementation of `m` by method NAME across the
 *    whole hierarchy — the call site's argument count is not recovered, so no arity
 *    narrowing is applied here).
 *  - **Override** (`kind: 'overrides'`): from a base method `B.m` to every overriding
 *    `D.m` where `D <: B` and both declare `m` with compatible arity. The precise,
 *    consistent replacement for the legacy class-level N×M adjacency cross-product.
 *
 * Bias is false-negatives over false-positives: a virtual-dispatch edge is emitted
 * only when `m` resolves to ≥1 implementation in the user-defined hierarchy (external
 * / stdlib types are not in it and never resolve); per-call-site fan-out is capped and
 * over-cap call sites are dropped (not partially wired) and logged.
 */
import type { FunctionNode, ClassNode, InheritanceEdge, CallEdge } from './call-graph.js';
import type { ImportMap } from './import-resolver-bridge.js';
import { inferTypesFromSource } from './type-inference-engine.js';
import { logger } from '../../utils/logger.js';

/** Per-call-site / per-base-method target fan-out cap — mirrors the dynamic-dispatch bound. */
export const CHA_FANOUT_CAP = 8;

/** A receiver-based method call recovered from the raw edges: `recv.method(...)`. */
export interface RawMethodCall {
  callerId: string;
  /** Receiver variable/expression name (`recv` in `recv.m()`); `self`/`this`/`cls` allowed. */
  recv: string;
  /** Method name `m`. */
  method: string;
  line: number;
}

const SELF_RECEIVERS = new Set(['self', 'this', 'cls']);

/** Directory portion of a repo-relative path (posix-style separators, as used by node ids). */
function dirOfPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

/** Return the opening receiver parenthesis for a Go method-shaped signature. */
function goReceiverOpen(signature: string): number | undefined {
  let i = 0;
  while (/\s/.test(signature[i] ?? '')) i++;
  if (signature.slice(i, i + 4) !== 'func' || /[\w$]/.test(signature[i + 4] ?? '')) {
    return undefined;
  }
  i += 4;
  while (i < signature.length) {
    while (/\s/.test(signature[i] ?? '')) i++;
    if (signature.slice(i, i + 2) !== '/*') break;
    const close = signature.indexOf('*/', i + 2);
    if (close === -1) return undefined;
    i = close + 2;
  }
  return signature[i] === '(' ? i : undefined;
}

/**
 * Extract a parameter count from a function declaration signature. Returns
 * `undefined` when no parameter list is recoverable, in which case arity is
 * treated as compatible with anything (we never *drop* a real override for an
 * unparseable signature — false-negative bias).
 */
export function arityFromSignature(signature: string | undefined): number | undefined {
  if (!signature) return undefined;
  let open = signature.indexOf('(');
  if (open === -1) return undefined;
  // Go method signatures put the receiver before the method name:
  // `func (s *Server) handle(w, r)`. The receiver is not a call argument, so
  // skip its balanced group and count the following parameter list.
  const receiverOpen = goReceiverOpen(signature);
  if (receiverOpen !== undefined) {
    open = receiverOpen;
    let receiverDepth = 0;
    let receiverClose = -1;
    for (let i = open; i < signature.length; i++) {
      if (signature[i] === '(') receiverDepth++;
      else if (signature[i] === ')' && --receiverDepth === 0) { receiverClose = i; break; }
    }
    const parameterOpen = receiverClose === -1 ? -1 : signature.indexOf('(', receiverClose + 1);
    // No second group means this is a function literal/type (`func(a int)`),
    // not a method receiver. Count its original parameter list unchanged.
    if (parameterOpen !== -1) open = parameterOpen;
  }
  let depth = 0;
  let params = '';
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(') { depth++; if (depth === 1) continue; }
    if (ch === ')') { depth--; if (depth === 0) { break; } }
    params += ch;
  }
  const trimmed = params.trim();
  if (trimmed === '') return 0;
  // Count top-level commas (ignore those nested in generics/defaults/parens).
  let d = 0;
  let count = 1;
  for (const ch of trimmed) {
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') d++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') d--;
    else if (ch === ',' && d === 0) count++;
  }
  return count;
}

function arityCompatible(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/**
 * Indexes over the extracted hierarchy, built once per CHA pass.
 */
class Hierarchy {
  /** ClassNode ids grouped by class name (a name may resolve to several across files). */
  private readonly classIdsByName = new Map<string, string[]>();
  /** ClassNode by id. */
  private readonly classById = new Map<string, ClassNode>();
  /** Direct subtype children: parent ClassNode id → child ClassNode ids. */
  private readonly childrenOf = new Map<string, string[]>();
  /** All class-method nodes named `m`, across the hierarchy. */
  private readonly methodsByName = new Map<string, FunctionNode[]>();

  constructor(
    private readonly nodes: Map<string, FunctionNode>,
    classes: ClassNode[],
    inheritanceEdges: InheritanceEdge[],
    private readonly importMap?: ImportMap,
  ) {
    for (const c of classes) {
      // Synthetic module groupings (free functions grouped by file) are NOT a real
      // type hierarchy — a free function is not a polymorphic method of some
      // receiver, so resolving `recv.fn()` against them would manufacture false
      // edges (e.g. `redis_client.get()` → a module-level `get()`). Exclude them.
      if (c.isModule) continue;
      this.classById.set(c.id, c);
      const arr = this.classIdsByName.get(c.name);
      if (arr) arr.push(c.id); else this.classIdsByName.set(c.name, [c.id]);
    }
    // Subtype edges only: extends / implements / embeds describe the real type
    // subtree. The derived class-level 'overrides' edges are redundant here.
    for (const e of inheritanceEdges) {
      if (e.kind === 'overrides') continue;
      const arr = this.childrenOf.get(e.parentId);
      if (arr) arr.push(e.childId); else this.childrenOf.set(e.parentId, [e.childId]);
    }
    for (const c of this.classById.values()) {
      for (const mid of c.methodIds) {
        const node = this.nodes.get(mid);
        if (!node || node.isExternal) continue;
        const arr = this.methodsByName.get(node.name);
        if (arr) arr.push(node); else this.methodsByName.set(node.name, [node]);
      }
    }
  }

  hasClass(name: string): boolean {
    return this.classIdsByName.has(name);
  }

  /** Whether any hierarchy class declares a method named `m`. */
  declaresMethod(method: string): boolean {
    return this.methodsByName.has(method);
  }

  /** ClassNode ids in the subtree rooted at every class named `typeName` (inclusive). */
  subtreeClassIds(typeName: string): Set<string> {
    const seen = new Set<string>();
    const queue = [...(this.classIdsByName.get(typeName) ?? [])];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of this.childrenOf.get(id) ?? []) {
        if (!seen.has(child)) queue.push(child);
      }
    }
    return seen;
  }

  /** ClassNode ids in the subtree rooted at `classId` (inclusive). */
  subtreeFromClassId(classId: string): Set<string> {
    const seen = this.descendantClassIds(classId);
    seen.add(classId);
    return seen;
  }

  /**
   * Resolve a receiver TYPE NAME to a single ClassNode id. A name shared by classes in
   * several files is disambiguated, most-specific-evidence first: the caller's own file
   * (decisive for `self`/`this`/`cls` and local shadows) → the file the caller imports the
   * name from → unique within the caller's directory. Returns undefined when the name is
   * unknown OR remains genuinely ambiguous — the caller then over-approximates by name
   * rather than guessing a specific class (mirrors base-class resolution; same bias).
   */
  resolveTypeToClassId(typeName: string, callerFile: string): string | undefined {
    const ids = this.classIdsByName.get(typeName);
    if (!ids || ids.length === 0) return undefined;
    if (ids.length === 1) return ids[0];
    const sameFile = ids.find((id) => this.classById.get(id)?.filePath === callerFile);
    if (sameFile) return sameFile;
    const importedFrom = this.importMap?.get(callerFile)?.get(typeName);
    if (importedFrom) {
      const viaImport = ids.find((id) => {
        const c = this.classById.get(id);
        return !!c && (c.filePath === importedFrom
          || c.filePath.startsWith(`${importedFrom}.`)
          || c.filePath.startsWith(`${importedFrom}/`));
      });
      if (viaImport) return viaImport;
    }
    const dir = dirOfPath(callerFile);
    const sameDir = ids.filter((id) => dirOfPath(this.classById.get(id)!.filePath) === dir);
    if (sameDir.length === 1) return sameDir[0];
    return undefined; // genuinely ambiguous across directories
  }

  /** ClassNode ids strictly below `classId` (its descendants). */
  descendantClassIds(classId: string): Set<string> {
    const seen = new Set<string>();
    const queue = [...(this.childrenOf.get(classId) ?? [])];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of this.childrenOf.get(id) ?? []) {
        if (!seen.has(child)) queue.push(child);
      }
    }
    return seen;
  }

  classNode(id: string): ClassNode | undefined {
    return this.classById.get(id);
  }

  /** Method nodes named `m` declared by any class in the given subtree. */
  methodsInSubtree(subtree: Set<string>, method: string): FunctionNode[] {
    const out: FunctionNode[] = [];
    for (const classId of subtree) {
      const cls = this.classById.get(classId);
      if (!cls) continue;
      for (const mid of cls.methodIds) {
        const node = this.nodes.get(mid);
        if (node && !node.isExternal && node.name === method) out.push(node);
      }
    }
    return out;
  }

  /** Every class-method node named `m` across the whole hierarchy. */
  methodsNamed(method: string): FunctionNode[] {
    return this.methodsByName.get(method) ?? [];
  }

  allClasses(): ClassNode[] {
    return [...this.classById.values()];
  }
}

/**
 * Materialize method-level override edges `B.m → D.m` for every base method `B.m`
 * overridden by a descendant `D.m` (name + compatible arity), transitively across
 * the subtype subtree. Replaces the legacy class-level all-methods cross-product:
 * precise (name+arity matched, never connecting unrelated methods) and never
 * silently dropped on large class pairs.
 */
function synthesizeOverrideEdges(h: Hierarchy, nodes: Map<string, FunctionNode>): CallEdge[] {
  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const base of h.allClasses()) {
    const descendants = h.descendantClassIds(base.id);
    if (descendants.size === 0) continue;
    for (const baseMethodId of base.methodIds) {
      const baseMethod = nodes.get(baseMethodId);
      if (!baseMethod || baseMethod.isExternal) continue;
      const baseArity = arityFromSignature(baseMethod.signature);
      for (const overrider of h.methodsInSubtree(descendants, baseMethod.name)) {
        if (overrider.id === baseMethod.id) continue;
        if (!arityCompatible(baseArity, arityFromSignature(overrider.signature))) continue;
        const key = `${baseMethod.id}\0${overrider.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          callerId: baseMethod.id,
          calleeId: overrider.id,
          calleeName: overrider.name,
          line: overrider.startLine,
          confidence: 'synthesized',
          kind: 'overrides',
          synthesizedBy: 'override',
        });
      }
    }
  }
  return edges;
}

/**
 * Resolve unpinned `recv.m()` call sites to their virtual-dispatch targets via CHA.
 * `directCalleeIdsByCaller` maps a callerId to the set of callee ids it already
 * resolves to directly, so CHA never duplicates a directly-resolved edge.
 */
function synthesizeVirtualDispatchEdges(
  h: Hierarchy,
  rawMethodCalls: RawMethodCall[],
  nodes: Map<string, FunctionNode>,
  fileContents: Map<string, string>,
  directCalleeIdsByCaller: Map<string, Set<string>>,
): CallEdge[] {
  const edges: CallEdge[] = [];
  const emitted = new Set<string>(); // dedup `${callerId}\0${calleeId}` across call sites
  // Cache inferred receiver types per caller function body (one inference per fn).
  const typesByCaller = new Map<string, Map<string, string>>();

  for (const call of rawMethodCalls) {
    const caller = nodes.get(call.callerId);
    if (!caller || caller.isExternal) continue;
    if (!h.declaresMethod(call.method)) continue; // bias: only user-defined methods resolve

    // ── Recover the receiver's declared type ────────────────────────────────
    let declaredType: string | undefined;
    if (SELF_RECEIVERS.has(call.recv)) {
      declaredType = caller.className; // self/this/cls dispatch over the enclosing class subtree
    } else {
      let inferred = typesByCaller.get(call.callerId);
      if (!inferred) {
        const content = fileContents.get(caller.filePath);
        const body = content && caller.startIndex !== undefined && caller.endIndex !== undefined
          ? content.slice(caller.startIndex, caller.endIndex)
          : '';
        inferred = body ? inferTypesFromSource(body, caller.language) : new Map();
        typesByCaller.set(call.callerId, inferred);
      }
      declaredType = inferred.get(call.recv);
    }

    // ── Resolve targets + provenance label ──────────────────────────────────
    let targets: FunctionNode[];
    let rule: 'cha-declared-type' | 'cha-name-only';
    if (declaredType) {
      // A statically-recovered receiver type that is NOT a user-defined hierarchy
      // class is an external/stdlib type (e.g. Array) — emit nothing, don't guess.
      if (!h.hasClass(declaredType)) continue;
      // Resolve the type NAME to a specific class using the caller's import/dir context.
      // Only a uniquely-resolved type yields a precise edge narrowed to that class's
      // subtree (cha-declared-type). A name shared across files that can't be pinned must
      // NOT wear the precise label — it over-approximates across the union of those types'
      // subtrees, honestly labeled name-only (was a false `cha-declared-type` to a
      // wrong-directory same-named class).
      const resolvedTypeId = h.resolveTypeToClassId(declaredType, caller.filePath);
      if (resolvedTypeId) {
        targets = h.methodsInSubtree(h.subtreeFromClassId(resolvedTypeId), call.method);
        rule = 'cha-declared-type';
      } else {
        targets = h.methodsInSubtree(h.subtreeClassIds(declaredType), call.method);
        rule = 'cha-name-only';
      }
    } else {
      // No receiver type recovered: over-approximate by method name across the whole
      // hierarchy. Arity is NOT matched here — the call site's argument count isn't
      // captured in RawMethodCall — so the label reflects name-only resolution.
      targets = h.methodsNamed(call.method);
      rule = 'cha-name-only';
    }

    // Drop targets already directly resolved from this call site, and self-edges.
    const direct = directCalleeIdsByCaller.get(call.callerId);
    const sharesDispatchEcosystem = (target: FunctionNode): boolean =>
      target.language === caller.language ||
      (['Java', 'Kotlin'].includes(target.language) &&
        ['Java', 'Kotlin'].includes(caller.language));
    const fresh = targets.filter(t =>
      sharesDispatchEcosystem(t) &&
      t.id !== call.callerId && !(direct && direct.has(t.id)),
    );
    const unique = new Map(fresh.map(t => [t.id, t]));
    if (unique.size === 0) continue;

    // Fan-out cap: drop (don't partially wire) an over-cap call site.
    if (unique.size > CHA_FANOUT_CAP) {
      logger.debug(
        `[cha] virtual-dispatch '${call.method}' dropped: ${unique.size} candidates exceed cap ${CHA_FANOUT_CAP}`,
      );
      continue;
    }

    for (const target of unique.values()) {
      const key = `${call.callerId}\0${target.id}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      edges.push({
        callerId: call.callerId,
        calleeId: target.id,
        calleeName: target.name,
        line: call.line,
        confidence: 'synthesized',
        kind: 'calls',
        callType: 'method',
        synthesizedBy: rule,
      });
    }
  }
  return edges;
}

/**
 * Run the CHA synthesis pass: override edges + virtual-dispatch edges. Additive —
 * returns only new edges, never modifies the directly-resolved graph. Per-rule and
 * order-independent; a failure in one rule must not abort the other or the build.
 */
export function synthesizeTypeHierarchyEdges(input: {
  nodes: Map<string, FunctionNode>;
  classes: ClassNode[];
  inheritanceEdges: InheritanceEdge[];
  rawMethodCalls: RawMethodCall[];
  fileContents: Map<string, string>;
  directCalleeIdsByCaller: Map<string, Set<string>>;
  /** Per-file import map, so a receiver type NAME shared across files resolves to the
   *  class the caller actually imports (precise dispatch) instead of every same-named class. */
  importMap?: ImportMap;
}): CallEdge[] {
  const h = new Hierarchy(input.nodes, input.classes, input.inheritanceEdges, input.importMap);
  let overrideEdges: CallEdge[] = [];
  let dispatchEdges: CallEdge[] = [];
  try {
    overrideEdges = synthesizeOverrideEdges(h, input.nodes);
  } catch (e) {
    logger.debug(`[cha] override rule failed: ${(e as Error).message}`);
  }
  try {
    dispatchEdges = synthesizeVirtualDispatchEdges(
      h, input.rawMethodCalls, input.nodes, input.fileContents, input.directCalleeIdsByCaller,
    );
  } catch (e) {
    logger.debug(`[cha] virtual-dispatch rule failed: ${(e as Error).message}`);
  }
  return [...overrideEdges, ...dispatchEdges];
}
