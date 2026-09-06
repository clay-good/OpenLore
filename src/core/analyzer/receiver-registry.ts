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

/**
 * The class that OWNS a `this.`/`self.` field write at `node`, or undefined when no class provably
 * does. Walks the parent chain, so it is correct for a field assigned deep inside a method body —
 * but it refuses in the two cases where the nearest class is NOT the owner:
 *
 *  - **A receiver rebinding.** In TS/JS a `function` expression/declaration and an object-literal
 *    method get their own `this`, so `emitter.on('x', function () { this.store = new T(); })`
 *    inside a method says nothing about the enclosing class's `store`. Arrow functions and class
 *    methods keep `this`, so they are walked through. In Python `self` is a parameter, so a `def`
 *    nested inside another `def` rebinds it; one function hop (the method itself) is expected,
 *    a second is a rebinding.
 *  - **An unnameable owner.** A class EXPRESSION with no name (`return class { … }`) owns the
 *    field, but cannot be named — so the field belongs to nobody the registry can key, and
 *    continuing outward would misattribute it to the enclosing named class.
 */
function enclosingClassName(node: RegistryNode | null, language: string): string | undefined {
  const python = language === 'Python';
  let functionHops = 0;
  for (let cur = node; cur; cur = cur.parent) {
    if (python) {
      if (cur.type === 'function_definition' && ++functionHops > 1) return undefined;
    } else {
      if (
        cur.type === 'function_declaration' ||
        cur.type === 'function_expression' ||
        cur.type === 'generator_function' ||
        cur.type === 'generator_function_declaration'
      ) {
        return undefined;
      }
      // A `method_definition` under a `class_body` is a class method (keeps `this`); anywhere
      // else it is an object-literal method, which does not.
      if (cur.type === 'method_definition' && cur.parent?.type !== 'class_body') return undefined;
    }
    if (
      cur.type === 'class_declaration' ||
      cur.type === 'class_definition' ||
      cur.type === 'class'
    ) {
      return cur.childForFieldName('name')?.text;
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

/**
 * Maximum facts retained per file. A generated file — 2,000 classes of 20 annotated fields each —
 * would otherwise serialize a 2 MB `pass1_facts` row and hold it for the whole build, crossing the
 * extraction-worker structured clone on the way. Real code is nowhere near this (60 facts across
 * this repository's 997 TypeScript files), so the cap is a hazard bound, not a working limit.
 * Truncation costs recall on the overflow, never correctness: an absent fact refuses the receiver,
 * which is the registry's own contract.
 */
export const RECEIVER_FIELD_FACT_CAP = 2_000;

/** Byte-ordered comparison. `localeCompare` collation varies with the Node build's ICU data, which
 *  would make "byte-identical across machines" false for the persisted fact row. */
function byteCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deduplicate and order facts so two analyses of an unchanged file emit byte-identical payloads. */
export function finalize(facts: ReceiverFieldFact[]): ReceiverFieldFact[] {
  const seen = new Set<string>();
  const out: ReceiverFieldFact[] = [];
  for (const fact of facts) {
    const key = `${fact.className}\0${fact.field}\0${fact.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  out.sort((a, b) =>
    byteCompare(a.className, b.className) ||
    byteCompare(a.field, b.field) ||
    byteCompare(a.type, b.type));
  // Sorted first, so which facts survive truncation is deterministic rather than parse-order.
  return out.length > RECEIVER_FIELD_FACT_CAP ? out.slice(0, RECEIVER_FIELD_FACT_CAP) : out;
}

/** Does a `required_parameter` declare a parameter PROPERTY (`constructor(private repo: Repo)`)?
 *  A plain constructor parameter declares a local, not a field, and must not enter the registry. */
function isParameterProperty(parameter: RegistryNode): boolean {
  return /^\s*(?:public|private|protected|readonly)\b/.test(parameter.text);
}

/** A `static` field is a different slot from the instance field of the same name, and the registry
 *  key has no static/instance dimension — so a static declaration must never type a `this.` receiver.
 *  The grammar uses one node type for both, so the modifier is read off the declaration text. */
function isStaticField(declaration: RegistryNode): boolean {
  return /^\s*static\b/.test(declaration.text);
}

function collectTypeScriptFacts(runQuery: (source: string) => RegistryMatch[]): ReceiverFieldFact[] {
  const facts: ReceiverFieldFact[] = [];
  const push = (node: RegistryNode | null, field: string | undefined, type: string | undefined): void => {
    const className = enclosingClassName(node, 'TypeScript');
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
      name: [(property_identifier) (private_property_identifier)] @field
      type: (type_annotation (type_identifier) @type)) @node
  `)) {
    const declaration = capture(m, 'node');
    if (!declaration || isStaticField(declaration)) continue;
    push(declaration, capture(m, 'field')?.text, capture(m, 'type')?.text);
  }

  // 2. `private repo = new Repo();` — a field initialized by construction, annotated or not.
  for (const m of runQuery(`
    (public_field_definition
      name: [(property_identifier) (private_property_identifier)] @field
      value: (new_expression constructor: (identifier) @type)) @node
  `)) {
    const declaration = capture(m, 'node');
    if (!declaration || isStaticField(declaration)) continue;
    push(declaration, capture(m, 'field')?.text, capture(m, 'type')?.text);
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
        property: [(property_identifier) (private_property_identifier)] @field)
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
        property: [(property_identifier) (private_property_identifier)] @field)
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
    const className = enclosingClassName(capture(m, 'node') ?? null, 'Python');
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
  //    But convention is not proof: a capitalized name this file DECLARES AS A FUNCTION is a
  //    factory call, not a construction, and typing the field by it would contradict the same
  //    build's own `same_file` edge to that function. Where the file answers the question, the
  //    file wins over the convention.
  const localFunctions = pythonLocalFunctionNames(runQuery);
  for (const m of runQuery(`
    (assignment
      left: (attribute object: (identifier) @recv attribute: (identifier) @field)
      right: (call function: (identifier) @type)) @node
  `)) {
    const type = capture(m, 'type')?.text;
    if (type && localFunctions.has(type)) continue;
    push(m, type);
  }

  // 2b. A class-body annotated attribute: `class Service:\n    repo: Repo`. The spec's
  //     "a field's type annotation" covers this as much as the `self.repo: Repo` form, and it is
  //     the idiom dataclasses and Pydantic models use. The enclosing node must be the class body
  //     itself, which `enclosingClassName`'s function-hop rule already guarantees.
  for (const m of runQuery(`
    (class_definition
      body: (block (expression_statement
        (assignment
          left: (identifier) @field
          type: (type (identifier) @type))))) @node
  `)) {
    const className = capture(m, 'node')?.childForFieldName('name')?.text;
    const field = capture(m, 'field')?.text;
    const type = capture(m, 'type')?.text;
    if (className && field && isTypeName(type)) facts.push({ className, field, type });
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
      const className = enclosingClassName(capture(m, 'node') ?? null, 'Python');
      const value = capture(m, 'value')?.text;
      if (!className || !value) continue;
      push(m, paramTypes.get(`${className}\0${value}`));
    }
  }

  return finalize(facts);
}

/** Every `def` name declared anywhere in this file. A capitalized one is a function, not a class,
 *  however conventional the capitalization looks. */
function pythonLocalFunctionNames(runQuery: (source: string) => RegistryMatch[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const m of runQuery(`(function_definition name: (identifier) @fn)`)) {
    const name = m.captures.find(c => c.name === 'fn')?.node.text;
    if (name) names.add(name);
  }
  return names;
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
    const className = enclosingClassName(m.captures.find(c => c.name === 'node')?.node ?? null, 'Python');
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
