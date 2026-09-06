/**
 * Per-file receiver type registries (change: shrink-receiver-resolution-boundary).
 *
 * The call graph resolves `this.m()` / `self.m()` by walking the enclosing class chain. The one
 * intra-object shape it cannot see at all is the CHAINED receiver — `this.<field>.<method>()` /
 * `self.<field>.<method>()`. The call query only ever captured an `(identifier)`, `(this)` or
 * `(super)` receiver, so a chained receiver matched no alternative: it produced no raw edge, no
 * resolved edge, and no `external::` leaf. It was the last call shape that was *silently* absent
 * rather than disclosed — `exception-flow.ts` classified it `other` and promised it resolved "to an
 * internal edge or an `external::obj.x` edge", which was not true for this shape.
 *
 * This module records the deterministic facts needed to type such a receiver: a class field's
 * declared type, and — where a field is initialized from a call to a locally-declared function —
 * that function's declared return type. Local *variable* types are already covered by
 * `type-inference-engine.ts`; this is the field/return dimension it never had.
 *
 * Four rules are load-bearing:
 *
 *  1. **Declared types only, never inferred shapes.** A field types the receiver when the source
 *     SAYS its type (an annotation, a `new T()`, a call to a local function with a declared return
 *     type). Nothing is guessed from naming, usage, or assignment flow.
 *  2. **Conflict refuses.** One `Class.field` carrying two different types anywhere in the file is
 *     dropped outright — the receiver stays a disclosed boundary rather than binding to whichever
 *     declaration parsed first.
 *  3. **No second parse.** Facts are collected from the tree Pass 1 already owns, through the same
 *     query runner `collectClassRelationshipFacts` uses, and are plain data so they survive the
 *     extraction-worker structured clone and the Pass-1 fact cache JSON.
 *  4. **Fail-soft.** A grammar without the queried node types yields nothing (the runner already
 *     swallows query errors), which is the same deterministic answer on every lane.
 */

/** Languages whose extractors contribute receiver-field facts. Authoritative source for the
 *  `receiverResolution` capability flag in the declarative language-support registry; a behavioral
 *  test asserts a fixture in each member yields facts and a non-member yields none. */
export const RECEIVER_REGISTRY_LANGUAGES: ReadonlySet<string> = new Set<string>([
  'TypeScript',
  'JavaScript',
  'Python',
]);

/**
 * One `Class.field → Type` observation. Plain data: it crosses the worker structured-clone and the
 * fact-cache JSON boundary exactly like {@link ClassRelationshipFact}. Observations are appended,
 * never merged, so a conflict stays visible to the builder, which refuses it.
 */
export interface ReceiverFieldFact {
  /** Enclosing class of the field declaration. */
  className: string;
  /** Field name as written (`repo` in `this.repo`). */
  field: string;
  /** Declared type name. Always capitalized — see {@link isTypeName}. */
  type: string;
}

/** Minimal structural view of a tree-sitter node — the subset this module walks. */
interface RegistryNode {
  type: string;
  text: string;
  parent: RegistryNode | null;
  childForFieldName(name: string): RegistryNode | null;
}

/** Minimal structural view of a tree-sitter query match. */
interface RegistryMatch {
  captures: Array<{ name: string; node: RegistryNode }>;
}

/** Conventional type-name test, matching `type-inference-engine.ts`: only capitalized names are
 *  treated as types, which keeps primitives and lower-case locals out of the registry. */
function isTypeName(name: string | undefined): name is string {
  return !!name && /^[A-Z]/.test(name);
}

/** Nearest enclosing class name, or undefined outside a class. Walks the parent chain, so it is
 *  correct for a field assigned deep inside a method body, not only at the class-body top level. */
function enclosingClassName(node: RegistryNode | null): string | undefined {
  for (let cur = node; cur; cur = cur.parent) {
    if (
      cur.type === 'class_declaration' ||
      cur.type === 'class_definition' ||
      cur.type === 'class'
    ) {
      const name = cur.childForFieldName('name')?.text;
      if (name) return name;
    }
  }
  return undefined;
}

/** Python receiver identifiers that denote the enclosing object/class. Mirrors `exception-flow.ts`. */
const PY_SELF_RECEIVERS = new Set(['self', 'cls']);

/**
 * Collect `Class.field → Type` facts while Pass 1 still owns the syntax tree.
 *
 * `runQuery` is the same fail-soft runner {@link collectClassRelationshipFacts} uses: a query the
 * installed grammar rejects returns no matches instead of throwing.
 */
export function collectReceiverFieldFacts(
  language: string,
  runQuery: (source: string) => RegistryMatch[],
): ReceiverFieldFact[] {
  if (!RECEIVER_REGISTRY_LANGUAGES.has(language)) return [];
  try {
    return language === 'Python'
      ? collectPythonFacts(runQuery)
      : collectTypeScriptFacts(runQuery);
  } catch {
    // Fail-soft, exactly like the inheritance collector: no facts is a valid answer, a throw is not.
    return [];
  }
}

/** Deduplicate and order facts so two analyses of an unchanged file emit byte-identical payloads. */
function finalize(facts: ReceiverFieldFact[]): ReceiverFieldFact[] {
  const seen = new Set<string>();
  const out: ReceiverFieldFact[] = [];
  for (const fact of facts) {
    const key = `${fact.className}\0${fact.field}\0${fact.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  out.sort((a, b) =>
    a.className.localeCompare(b.className) ||
    a.field.localeCompare(b.field) ||
    a.type.localeCompare(b.type));
  return out;
}

/** Does a `required_parameter` declare a parameter PROPERTY (`constructor(private repo: Repo)`)?
 *  A plain constructor parameter declares a local, not a field, and must not enter the registry. */
function isParameterProperty(parameter: RegistryNode): boolean {
  return /^\s*(?:public|private|protected|readonly)\b/.test(parameter.text);
}

function collectTypeScriptFacts(runQuery: (source: string) => RegistryMatch[]): ReceiverFieldFact[] {
  const facts: ReceiverFieldFact[] = [];
  const push = (node: RegistryNode | null, field: string | undefined, type: string | undefined): void => {
    const className = enclosingClassName(node);
    if (!className || !field || !isTypeName(type)) return;
    facts.push({ className, field, type });
  };
  const capture = (m: RegistryMatch, name: string): RegistryNode | undefined =>
    m.captures.find(c => c.name === name)?.node;

  // 1. `private repo: Repo;` — an annotated field declaration. A generic annotation
  //    (`Map<string, X>`) is a `generic_type`, not a `type_identifier`, so the query itself
  //    excludes it: a container's `get`/`set` is not an in-project method.
  for (const m of runQuery(`
    (public_field_definition
      name: (property_identifier) @field
      type: (type_annotation (type_identifier) @type)) @node
  `)) {
    push(capture(m, 'node') ?? null, capture(m, 'field')?.text, capture(m, 'type')?.text);
  }

  // 2. `private repo = new Repo();` — a field initialized by construction, annotated or not.
  for (const m of runQuery(`
    (public_field_definition
      name: (property_identifier) @field
      value: (new_expression constructor: (identifier) @type)) @node
  `)) {
    push(capture(m, 'node') ?? null, capture(m, 'field')?.text, capture(m, 'type')?.text);
  }

  // 3. `constructor(private readonly repo: Repo)` — a parameter property. A plain parameter with
  //    no modifier declares a local, so the modifier check is load-bearing, not cosmetic.
  for (const m of runQuery(`
    (method_definition
      name: (property_identifier) @method
      parameters: (formal_parameters
        (required_parameter
          pattern: (identifier) @field
          type: (type_annotation (type_identifier) @type)) @param)) @node
  `)) {
    if (capture(m, 'method')?.text !== 'constructor') continue;
    const param = capture(m, 'param');
    if (!param || !isParameterProperty(param)) continue;
    push(capture(m, 'node') ?? null, capture(m, 'field')?.text, capture(m, 'type')?.text);
  }

  // 4. `this.repo = new Repo();` — assignment anywhere in the class, including a method body.
  for (const m of runQuery(`
    (assignment_expression
      left: (member_expression
        object: (this)
        property: (property_identifier) @field)
      right: (new_expression constructor: (identifier) @type)) @node
  `)) {
    push(capture(m, 'node') ?? null, capture(m, 'field')?.text, capture(m, 'type')?.text);
  }

  // 5. `this.repo = makeRepo();` where `makeRepo(): Repo` is declared in this file — the
  //    return-type dimension of the registry. Only a LOCAL declaration counts: an imported
  //    factory's return type is not readable from this tree, and is left as a boundary.
  //    The return-type scan runs only when such an assignment exists, so the common file pays
  //    one query rather than three.
  const factoryAssignments = runQuery(`
    (assignment_expression
      left: (member_expression
        object: (this)
        property: (property_identifier) @field)
      right: (call_expression function: (identifier) @callee)) @node
  `);
  if (factoryAssignments.length > 0) {
    const returnTypes = localReturnTypes(runQuery);
    for (const m of factoryAssignments) {
      const callee = capture(m, 'callee')?.text;
      push(capture(m, 'node') ?? null, capture(m, 'field')?.text, callee ? returnTypes.get(callee) : undefined);
    }
  }

  return finalize(facts);
}

/** `functionName → declared return type`, for functions declared in THIS file. A name declared
 *  twice with different return types is dropped: the registry never picks a winner. */
function localReturnTypes(runQuery: (source: string) => RegistryMatch[]): Map<string, string> {
  const seen = new Map<string, string | null>();
  const record = (name: string | undefined, type: string | undefined): void => {
    if (!name || !isTypeName(type)) return;
    const prior = seen.get(name);
    if (prior === undefined) seen.set(name, type);
    else if (prior !== type) seen.set(name, null);
  };
  for (const source of [
    `(function_declaration name: (identifier) @fn return_type: (type_annotation (type_identifier) @type))`,
    `(variable_declarator name: (identifier) @fn value: (arrow_function return_type: (type_annotation (type_identifier) @type)))`,
  ]) {
    for (const m of runQuery(source)) {
      record(
        m.captures.find(c => c.name === 'fn')?.node.text,
        m.captures.find(c => c.name === 'type')?.node.text,
      );
    }
  }
  const out = new Map<string, string>();
  for (const [name, type] of seen) if (type) out.set(name, type);
  return out;
}

function collectPythonFacts(runQuery: (source: string) => RegistryMatch[]): ReceiverFieldFact[] {
  const facts: ReceiverFieldFact[] = [];
  const capture = (m: RegistryMatch, name: string): RegistryNode | undefined =>
    m.captures.find(c => c.name === name)?.node;
  const push = (m: RegistryMatch, type: string | undefined): void => {
    if (!PY_SELF_RECEIVERS.has(capture(m, 'recv')?.text ?? '')) return;
    const className = enclosingClassName(capture(m, 'node') ?? null);
    const field = capture(m, 'field')?.text;
    if (!className || !field || !isTypeName(type)) return;
    facts.push({ className, field, type });
  };

  // 1. `self.repo: Repo = ...` — an annotated attribute assignment.
  for (const m of runQuery(`
    (assignment
      left: (attribute object: (identifier) @recv attribute: (identifier) @field)
      type: (type (identifier) @type)) @node
  `)) {
    push(m, capture(m, 'type')?.text);
  }

  // 2. `self.repo = Repo()` — construction. Capitalization is the class convention Python's own
  //    style guide fixes, and is the same signal `type-inference-engine.ts` already relies on.
  for (const m of runQuery(`
    (assignment
      left: (attribute object: (identifier) @recv attribute: (identifier) @field)
      right: (call function: (identifier) @type)) @node
  `)) {
    push(m, capture(m, 'type')?.text);
  }

  // 3. `def __init__(self, repo: Repo): self.repo = repo` — an annotated parameter forwarded to a
  //    field. Both halves must be present: an annotation alone declares a local.
  const forwarded = runQuery(`
    (assignment
      left: (attribute object: (identifier) @recv attribute: (identifier) @field)
      right: (identifier) @value) @node
  `);
  if (forwarded.length > 0) {
    const paramTypes = pythonInitParamTypes(runQuery);
    for (const m of forwarded) {
      const className = enclosingClassName(capture(m, 'node') ?? null);
      const value = capture(m, 'value')?.text;
      if (!className || !value) continue;
      push(m, paramTypes.get(`${className}\0${value}`));
    }
  }

  return finalize(facts);
}

/** `Class\0param → annotated type` for `__init__` parameters. Keyed by class so two classes'
 *  same-named constructor parameters cannot cross-contaminate. A parameter annotated twice with
 *  different types within one class is dropped. */
function pythonInitParamTypes(runQuery: (source: string) => RegistryMatch[]): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const m of runQuery(`
    (function_definition
      name: (identifier) @fn
      parameters: (parameters
        (typed_parameter (identifier) @param type: (type (identifier) @type)))) @node
  `)) {
    if (m.captures.find(c => c.name === 'fn')?.node.text !== '__init__') continue;
    const className = enclosingClassName(m.captures.find(c => c.name === 'node')?.node ?? null);
    const param = m.captures.find(c => c.name === 'param')?.node.text;
    const type = m.captures.find(c => c.name === 'type')?.node.text;
    if (!className || !param || !isTypeName(type)) continue;
    const key = `${className}\0${param}`;
    const prior = seen.get(key);
    if (prior === undefined) seen.set(key, type);
    else if (prior !== type) seen.set(key, null);
  }
  const out = new Map<string, string>();
  for (const [key, type] of seen) if (type) out.set(key, type);
  return out;
}

/**
 * The resolved per-repository field registry: `filePath::Class.field → type`, with every
 * conflicting observation removed. Built once in Pass 2 from the collected facts.
 */
export type ReceiverFieldRegistry = ReadonlyMap<string, string>;

/** Registry key for one field. Exported so tests and callers agree on the shape. */
export function receiverFieldKey(filePath: string, className: string, field: string): string {
  return `${filePath}::${className}.${field}`;
}

/**
 * Fold per-file facts into the registry, dropping any `Class.field` observed with more than one
 * type. Refusal is per key, so one conflicted field never suppresses its siblings.
 */
export function buildReceiverFieldRegistry(
  factsByFile: Iterable<readonly [string, readonly ReceiverFieldFact[]]>,
): ReceiverFieldRegistry {
  const observed = new Map<string, string | null>();
  for (const [filePath, facts] of factsByFile) {
    for (const fact of facts) {
      const key = receiverFieldKey(filePath, fact.className, fact.field);
      const prior = observed.get(key);
      if (prior === undefined) observed.set(key, fact.type);
      else if (prior !== fact.type) observed.set(key, null);
    }
  }
  const registry = new Map<string, string>();
  for (const [key, type] of observed) if (type) registry.set(key, type);
  return registry;
}
