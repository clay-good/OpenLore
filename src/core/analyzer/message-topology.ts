/**
 * Message-topology edges (change: add-message-topology-edges).
 *
 * A client/server, IPC, or Redux-style app often has no call between the code that builds a
 * message and the code that handles it: `ws.send({ type: "restart" })` on one side, and
 * `switch (msg.type) { case "restart": … }` on the other. This module collects both sides from a
 * parsed TypeScript/JavaScript file so the call graph's synthesis pass can pair them:
 *
 *  - a **consumer clause** is a `switch (x.<field>)` case, the consequent of
 *    `if (x.<field> === <tag>)`, or the rest of a function after an early-exit guard
 *    `if (x.<field> !== <tag>) return;`, keyed `<field>=<tag>`. It becomes a registration whose
 *    handler is the clause's single callee when the clause body is one call, and the enclosing
 *    function otherwise;
 *  - a **construction site** is an object literal carrying `<field>: <tag>` that is handed straight
 *    to a transport call (`send`, `postMessage`, `dispatch`, …, optionally through
 *    `JSON.stringify`), keyed the same way. It becomes a dispatch from its enclosing function.
 *
 * A tag pairs only when it is static: a string, a substitution-free template, or `A.B` where `A`
 * is bound at module scope or imported (an enum, a constant object). A parameter or local
 * (`case ev.name:`) is a run-time value, as is another message's discriminant (`m.type`).
 *
 * Two precision gates, both measured on this repository before they were added:
 *
 *  - only the discriminant fields in {@link MESSAGE_DISCRIMINANT_FIELDS} count. Any object literal
 *    can carry a string property, and collecting all of them would make every `{ name: "x" }` a
 *    message;
 *  - only a literal handed to a transport call is a message. A plain data enum (`{ kind: "calls" }`
 *    built, then tested by `if (e.kind === "calls")` far away) has the same shape as a message
 *    protocol. Without this gate, 150 of the 154 edges the rule produced on this repository were
 *    such data-flow pairings, not message hops. A Redux action creator that RETURNS its action is
 *    therefore not paired; the `dispatch({ type })` call site is.
 *
 * Besides pairable registrations, the collector records two kinds of MARKER registration (no
 * handler): a clause no indexed function contains ({@link unattributedConsumerKey}), and a clause
 * that compares the field against a named constant it cannot evaluate ({@link uncomparableKey}).
 * Markers never pair; they only make a send's disclosure say what is actually known.
 *
 * Deterministic and no LLM: a fixed walk over the tree the extractor already parsed.
 */

import type Parser from 'tree-sitter';

/** Languages whose construction and consumer idioms this module recovers. */
export const MESSAGE_TOPOLOGY_LANGUAGES: ReadonlySet<string> = new Set(['TypeScript', 'JavaScript']);

/** The provenance label on every synthesized message edge. */
export const MESSAGE_TOPOLOGY_RULE = 'message-topology';

/** The discriminant field names a message protocol switches on. Closed on purpose (see module doc). */
export const MESSAGE_DISCRIMINANT_FIELDS: ReadonlySet<string> = new Set([
  'type', 'kind', 'action', 'event', 'op', 'cmd', 'command', 'tag',
]);

/** Calls that hand a message to a transport. A construction passed to one is a send. */
const TRANSPORT_METHODS: ReadonlySet<string> = new Set([
  'send', 'postMessage', 'sendMessage', 'dispatch', 'broadcast', 'publish', 'emit',
]);

/**
 * Cheap pre-filter: the file must name a discriminant field as a property (`x.type`) or as an
 * object key (`type:`). A file with neither does no AST work for this rule.
 */
const MESSAGE_PREFILTER = /(?:\.\s*|[{,]\s*["']?)(?:type|kind|action|event|op|cmd|command|tag)\b/;

export function mayContainMessageTopology(content: string): boolean {
  return MESSAGE_PREFILTER.test(content);
}

const MARKER = '\u0000';

/** Marker key: a clause selects `key`, but no indexed function contains it. */
export function unattributedConsumerKey(key: string): string {
  return `${key}${MARKER}unattributed`;
}

/** Marker key: a clause compares `field` against the named constant `name`, which it cannot evaluate. */
export function uncomparableKey(field: string, name: string): string {
  return `${field}${MARKER}~${name}`;
}

/** True for a marker registration key (one that never pairs). */
export function isMarkerKey(key: string): boolean {
  return key.includes(MARKER);
}

/** The discriminant field of a pairing key (`type=str:x` → `type`). */
export function keyField(key: string): string {
  const ends = [key.indexOf('='), key.indexOf(MARKER)].filter(i => i >= 0);
  return ends.length ? key.slice(0, Math.min(...ends)) : key;
}

/**
 * The constant name a send's tag could be spelled as on the consumer side: `const:types.X` → `X`,
 * `str:X` → `X`. A clause testing `case X:` (an imported constant) may hold exactly that value.
 */
export function tagConstantName(key: string): string | undefined {
  const tag = key.slice(key.indexOf('=') + 1);
  const name = tag.startsWith('const:') ? tag.slice(tag.lastIndexOf('.') + 1)
    : tag.startsWith('str:') ? tag.slice(4) : undefined;
  return name && /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

/**
 * One handler clause: key → the node ids that handle it. `file` is the clause's file, which the
 * test-file rule needs for a marker.
 */
export interface MessageRegistration {
  key: string;
  handlerIds: string[];
  /** The function enclosing the clause, which the fan-out cap counts (one per clause container). */
  container?: string;
  file?: string;
}
/** One construction site. */
export interface MessageDispatch { key: string; callerId: string; line: number }
/** A construction site, with the source of the transport call it is handed to. */
export interface MessageSend {
  key: string;
  /** Absent when no indexed function contains the send. */
  callerId?: string;
  filePath: string;
  line: number;
  /**
   * Byte span of the transport call in the file. The caller slices bounded evidence from it — the
   * call's full text is never copied, since nested sends would retain it quadratically.
   */
  start: number;
  end: number;
}

export interface MessageSites {
  registrations: MessageRegistration[];
  dispatches: MessageDispatch[];
  sends: MessageSend[];
}

/** What the collector needs from the call-graph builder, injected so this module stays a leaf. */
export interface MessageCollectorEnv {
  filePath: string;
  /** Node id of the indexed function enclosing a byte offset. */
  enclosingId: (startIndex: number) => string | undefined;
  /** Node id of a called name, resolved without guessing, or undefined. */
  resolveCallee: (name: string) => string | undefined;
}

interface CollectorState extends MessageCollectorEnv {
  /** Names bound at module scope or by any import: what `A` in a constant tag `A.B` may be. */
  moduleNames: Set<string>;
  /** Names bound by a package import or require: never resolved to a repository function. */
  packageNames: Set<string>;
  /** `import { X as Y }`: local `Y` → imported `X`, so a constant tag is keyed by what it names. */
  importAliases: Map<string, string>;
  /** Per-scope bound names, see {@link scopeNames}. */
  scopeMemo: Map<string, ReadonlySet<string>>;
  /**
   * The ancestors of the node being collected (root first), plus the nodes between it and the tags
   * it reads. Supplied by the single top-down walk in {@link collectMessageSites}: tree-sitter's
   * `.parent` re-walks from the root, so walking up from every tag was quadratic on a deep file.
   */
  ancestors: Parser.SyntaxNode[];
  inner: Parser.SyntaxNode[];
}

/** Ancestors checked for shadowing; a tag nested deeper is refused rather than walked. */
const MAX_SCOPE_DEPTH = 256;

function unparen(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | null | undefined {
  let n = node;
  while (n?.type === 'parenthesized_expression') n = n.namedChildren[0];
  return n;
}

/** Discriminant field tested by a `x.<field>` member expression, or undefined. */
function testedField(node: Parser.SyntaxNode | null | undefined): string | undefined {
  const n = unparen(node);
  if (n?.type !== 'member_expression') return undefined;
  const prop = n.childForFieldName('property');
  if (prop?.type !== 'property_identifier') return undefined;
  return MESSAGE_DISCRIMINANT_FIELDS.has(prop.text) ? prop.text : undefined;
}

function methodName(callee: Parser.SyntaxNode | null): string | undefined {
  if (!callee) return undefined;
  if (callee.type === 'identifier') return callee.text;
  if (callee.type === 'member_expression') return callee.childForFieldName('property')?.text;
  return undefined;
}

/** The static key of a tag node, or undefined. See the module doc for what is static. */
function tagKey(node: Parser.SyntaxNode | null | undefined, env: CollectorState): string | undefined {
  const n = unparen(node);
  if (!n) return undefined;
  // A NUL byte could forge a marker key, so a tag carrying one is not static.
  const literal = (text: string): string | undefined => (text.includes(MARKER) ? undefined : `str:${text}`);
  if (n.type === 'string') return literal(n.text.length >= 2 ? n.text.slice(1, -1) : '');
  if (n.type === 'template_string') {
    return n.descendantsOfType('template_substitution').length === 0
      ? literal(n.text.length >= 2 ? n.text.slice(1, -1) : '')
      : undefined;
  }
  if (n.type === 'member_expression' && !testedField(n)) {
    const obj = n.childForFieldName('object');
    const prop = n.childForFieldName('property');
    if (obj?.type === 'identifier' && prop?.type === 'property_identifier' && isModuleBound(obj, env)) {
      return `const:${env.importAliases.get(obj.text) ?? obj.text}.${prop.text}`;
    }
  }
  return undefined;
}

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'function_declaration', 'function_expression', 'function', 'arrow_function', 'method_definition',
  'generator_function_declaration', 'generator_function',
]);

/**
 * Is this identifier the module-scope binding of its name — not shadowed by a parameter or a
 * local declaration of an enclosing function or block? `route(m, Msg) { case Msg.A: }` names the
 * parameter, a run-time value, even when the file also declares a module-level `Msg`.
 */
function isModuleBound(id: Parser.SyntaxNode, env: CollectorState): boolean {
  if (!env.moduleNames.has(id.text)) return false;
  if (env.ancestors.length + env.inner.length > MAX_SCOPE_DEPTH) return false;
  for (const a of env.inner) if (scopeNames(a, env).has(id.text)) return false;
  for (const a of env.ancestors) if (scopeNames(a, env).has(id.text)) return false;
  return true;
}

/**
 * The names a scope node binds for the code inside it: a function's parameters, a `catch`
 * parameter, a `for…of`/`for…in` binding, or a block's declarations. Memoized per node, so a file
 * with thousands of tags under one large block pays for each block once — the walk was quadratic
 * without it (review round 4: a 256 KB file took minutes).
 */
function scopeNames(a: Parser.SyntaxNode, env: CollectorState): ReadonlySet<string> {
  const memoKey = `${a.startIndex}:${a.endIndex}:${a.type}`;
  const hit = env.scopeMemo.get(memoKey);
  if (hit) return hit;
  const names = new Set<string>();
  if (FUNCTION_TYPES.has(a.type)) {
    patternNames(a.childForFieldName('parameters') ?? a.childForFieldName('parameter'), names);
  } else if (a.type === 'catch_clause') {
    patternNames(a.childForFieldName('parameter'), names);
  } else if (a.type === 'for_in_statement') {
    patternNames(a.childForFieldName('left'), names);
  } else if (a.type === 'statement_block' || a.type === 'switch_case' || a.type === 'switch_default') {
    for (const stmt of a.namedChildren) {
      if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
        for (const d of stmt.namedChildren) if (d.type === 'variable_declarator') patternNames(d.childForFieldName('name'), names);
      } else if (stmt.type === 'function_declaration' || stmt.type === 'class_declaration') {
        const name = stmt.childForFieldName('name')?.text;
        if (name) names.add(name);
      }
    }
  }
  env.scopeMemo.set(memoKey, names);
  return names;
}

/**
 * The name of a constant a tag compares against without this rule being able to evaluate it: an
 * identifier bound at module scope or imported, or written in UPPER_CASE (`case CHECKOUT_REQUEST:`),
 * or the last name of a member chain rooted in one. A parameter or local is not a constant.
 */
function constantName(node: Parser.SyntaxNode | null | undefined, env: CollectorState): string | undefined {
  const n = unparen(node);
  if (n?.type === 'identifier') {
    if (isModuleBound(n, env)) return env.importAliases.get(n.text) ?? n.text;
    return /^[A-Z][A-Z0-9_]*$/.test(n.text) && !env.moduleNames.has(n.text) ? n.text : undefined;
  }
  if (n?.type === 'member_expression' && !testedField(n)) {
    let root: Parser.SyntaxNode | null = n;
    while (root?.type === 'member_expression') root = root.childForFieldName('object');
    const prop = n.childForFieldName('property');
    if (root?.type === 'identifier' && isModuleBound(root, env) && prop?.type === 'property_identifier') return prop.text;
  }
  return undefined;
}

/** A package specifier, as opposed to a relative path or a path alias (`@/x`, `~/x`, `#x`). */
function isPackageSpecifier(spec: string): boolean {
  return spec !== '' && !/^(?:\.|\/|@\/|~|#)/.test(spec);
}

function stringValue(node: Parser.SyntaxNode | null | undefined): string | undefined {
  return node?.type === 'string' ? node.text.slice(1, -1) : undefined;
}

/** The local names a binding pattern introduces (`x`, `{ a, b: c }`). */
function patternNames(pattern: Parser.SyntaxNode | null | undefined, out: Set<string>): void {
  // Iterative over the binding positions only: a default value (`k = Msg.A`) and a type annotation
  // bind nothing, and a pair's key (`{ a: b }`) is not its binding.
  const stack = pattern ? [pattern] : [];
  while (stack.length) {
    const n = stack.pop()!;
    switch (n.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern':
        out.add(n.text);
        break;
      case 'required_parameter':
      case 'optional_parameter': {
        const p = n.childForFieldName('pattern');
        if (p) stack.push(p);
        break;
      }
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        const left = n.childForFieldName('left');
        if (left) stack.push(left);
        break;
      }
      case 'pair_pattern': {
        const value = n.childForFieldName('value');
        if (value) stack.push(value);
        break;
      }
      case 'formal_parameters':
      case 'object_pattern':
      case 'array_pattern':
      case 'rest_pattern':
        for (const c of n.namedChildren) stack.push(c);
        break;
      default:
        break;
    }
  }
}

/** `require("pkg")`, possibly through `.default`/`.x`, as its specifier. */
function requireSpecifier(value: Parser.SyntaxNode | null | undefined): string | undefined {
  let n = unparen(value);
  while (n?.type === 'member_expression') n = n.childForFieldName('object');
  if (n?.type !== 'call_expression' || n.childForFieldName('function')?.text !== 'require') return undefined;
  return stringValue(n.childForFieldName('arguments')?.namedChildren[0]);
}

/** Module-scope names and package-bound names of one file. */
function fileBindings(root: Parser.SyntaxNode): { moduleNames: Set<string>; packageNames: Set<string>; importAliases: Map<string, string> } {
  const moduleNames = new Set<string>();
  const packageNames = new Set<string>();
  const importAliases = new Map<string, string>();
  for (const imp of root.descendantsOfType('import_statement')) {
    const local = new Set<string>();
    const clause = imp.namedChildren.find(c => c.type === 'import_clause');
    for (const id of clause?.descendantsOfType('identifier') ?? []) {
      // In `{ a as b }` the local binding is the alias.
      const spec = id.parent?.type === 'import_specifier' ? id.parent : undefined;
      const alias = spec?.childForFieldName('alias');
      if (alias && spec?.childForFieldName('name')?.startIndex === id.startIndex) continue;
      local.add(id.text);
      const imported = alias && spec?.childForFieldName('name');
      if (imported) importAliases.set(id.text, imported.text);
    }
    // `import x = require("pkg")`.
    const req = imp.namedChildren.find(c => c.type === 'import_require_clause');
    const reqName = req?.namedChildren.find(c => c.type === 'identifier');
    if (reqName) local.add(reqName.text);
    const source = stringValue(imp.childForFieldName('source')) ?? stringValue(req?.childForFieldName('source'))
      ?? stringValue(req?.namedChildren.find(c => c.type === 'string'));
    for (const name of local) {
      moduleNames.add(name);
      if (source !== undefined && isPackageSpecifier(source)) packageNames.add(name);
    }
  }
  for (const top of root.namedChildren) {
    let stmt: Parser.SyntaxNode | null | undefined =
      top.type === 'export_statement' ? top.childForFieldName('declaration') ?? top.namedChildren[0] : top;
    // `declare enum D {}`, and an unexported `namespace N {}` (parsed as an expression statement).
    if (stmt?.type === 'ambient_declaration' || stmt?.type === 'expression_statement') stmt = stmt.namedChildren[0];
    if (!stmt) continue;
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
      for (const d of stmt.namedChildren) {
        if (d.type !== 'variable_declarator') continue;
        const names = new Set<string>();
        patternNames(d.childForFieldName('name'), names);
        for (const name of names) moduleNames.add(name);
        // Only a top-level `require` binds a name for the whole file.
        const spec = requireSpecifier(d.childForFieldName('value'));
        if (spec !== undefined && isPackageSpecifier(spec)) for (const name of names) packageNames.add(name);
      }
    } else {
      const name = stmt.childForFieldName('name');
      if (name && (name.type === 'identifier' || name.type === 'type_identifier')) moduleNames.add(name.text);
    }
  }
  return { moduleNames, packageNames, importAliases };
}

/**
 * The single callee of a clause body, when the body is exactly one call (`handle(m)`,
 * `return handle(m)`, `await handle(m)`, `this.handle(m)`), ignoring a trailing `break`. A call on
 * any other receiver (`console.log(m)`, `m.reply()`) names a method of an unknown object, so it is
 * not resolved by its bare name. Otherwise undefined.
 */
function singleCallee(statements: Parser.SyntaxNode[]): string | undefined {
  let body = statements.filter(s => s.type !== 'break_statement' && s.type !== 'comment');
  if (body.length === 1 && body[0].type === 'statement_block') {
    body = body[0].namedChildren.filter(s => s.type !== 'break_statement' && s.type !== 'comment');
  }
  if (body.length !== 1) return undefined;
  const stmt = body[0];
  let expr: Parser.SyntaxNode | null | undefined =
    stmt.type === 'expression_statement' || stmt.type === 'return_statement' ? stmt.namedChildren[0] : undefined;
  if (expr?.type === 'await_expression') expr = expr.namedChildren[0];
  if (expr?.type !== 'call_expression') return undefined;
  const callee = expr.childForFieldName('function');
  if (callee?.type === 'member_expression' && callee.childForFieldName('object')?.type !== 'this') return undefined;
  return methodName(callee);
}

function registrationFor(
  key: string, statements: Parser.SyntaxNode[], clause: Parser.SyntaxNode, env: CollectorState,
): MessageRegistration {
  const callee = singleCallee(statements);
  const enclosing = env.enclosingId(clause.startIndex);
  const resolved = callee && !env.packageNames.has(callee) ? env.resolveCallee(callee) : undefined;
  const file = env.filePath;
  // The enclosing function is always a handler: it is the code that selects the tag, so deleting the
  // clause breaks the sender, and a verdict about it must see the hop. The single callee is the
  // more precise target and joins it. The Pass-1 lane records the callee by name and resolves it
  // later, dropping it when it resolves to nothing — the same set the re-parsing lane builds here.
  const handlerIds = [...(resolved ? [resolved] : []), ...(enclosing && enclosing !== resolved ? [enclosing] : [])];
  if (handlerIds.length) return { key, handlerIds, ...(enclosing ? { container: enclosing } : {}), file };
  return { key: unattributedConsumerKey(key), handlerIds: [], file };
}

function collectSwitchClauses(sw: Parser.SyntaxNode, env: CollectorState, out: MessageSites): void {
  const field = testedField(sw.childForFieldName('value'));
  if (!field) return;
  const body = sw.childForFieldName('body');
  if (!body) return;
  // Consecutive empty cases fall through to the next case that has a body: `case "a": case "b": f()`.
  // A `default:` takes no key of its own but still gives a body to the cases that fall into it.
  let pending: string[] = [];
  for (const clause of body.namedChildren) {
    if (clause.type !== 'switch_case' && clause.type !== 'switch_default') continue;
    const value = clause.type === 'switch_case' ? clause.childForFieldName('value') : null;
    env.inner = [sw, body, clause];
    const tag = tagKey(value, env);
    const statements = clause.namedChildren.filter(c =>
      !(value && c.startIndex === value.startIndex && c.endIndex === value.endIndex) && c.type !== 'comment');
    if (tag !== undefined) pending.push(`${field}=${tag}`);
    else {
      const name = constantName(value, env);
      if (name) out.registrations.push({ key: uncomparableKey(field, name), handlerIds: [], file: env.filePath });
    }
    if (statements.length === 0) continue;
    for (const key of pending) out.registrations.push(registrationFor(key, statements, clause, env));
    pending = [];
  }
}

type Comparison = { key: string; negated: boolean } | { uncomparable: string; field: string } | undefined;

/** `x.<field> ===|==|!==|!= <tag>` (either side). */
function comparison(node: Parser.SyntaxNode | null | undefined, env: CollectorState): Comparison {
  const cond = unparen(node);
  if (cond?.type !== 'binary_expression') return undefined;
  const op = cond.childForFieldName('operator')?.text;
  if (op !== '===' && op !== '==' && op !== '!==' && op !== '!=') return undefined;
  const negated = op === '!==' || op === '!=';
  const left = cond.childForFieldName('left');
  const right = cond.childForFieldName('right');
  for (const [fieldSide, tagSide] of [[left, right], [right, left]] as const) {
    const field = testedField(fieldSide);
    if (!field) continue;
    const tag = tagKey(tagSide, env);
    if (tag !== undefined) return { key: `${field}=${tag}`, negated };
    const name = negated ? undefined : constantName(tagSide, env);
    if (name) return { uncomparable: name, field };
  }
  return undefined;
}

/**
 * The comparison an `if` condition selects on: one comparison, or one equality among the operands
 * of an `&&` chain (`msg && msg.type === "stop"`) — the consequent runs only when every operand
 * holds, so the tag must match. Two comparisons in one chain select nothing a single key can name.
 */
function conditionComparison(node: Parser.SyntaxNode | null | undefined, env: CollectorState): Comparison {
  const operands: Parser.SyntaxNode[] = [];
  const stack = [unparen(node)];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === 'binary_expression' && n.childForFieldName('operator')?.text === '&&') {
      stack.push(unparen(n.childForFieldName('right')), unparen(n.childForFieldName('left')));
    } else {
      operands.push(n);
    }
  }
  const found = operands.map(o => comparison(o, env)).filter(c => c !== undefined);
  if (found.length !== 1) return undefined;
  const only = found[0];
  // A negated comparison inside `&&` does not name what the consequent handles.
  if ('negated' in only && only.negated && operands.length > 1) return undefined;
  return only;
}

const EXIT_STATEMENTS: ReadonlySet<string> = new Set(['return_statement', 'throw_statement', 'continue_statement', 'break_statement']);

/**
 * A statement that leaves the function or loop: `return`, `throw`, `continue`, `break`, or a block
 * of plain expression statements ending in one (`{ console.warn(m); return; }`).
 */
function isEarlyExit(stmt: Parser.SyntaxNode | null | undefined): boolean {
  if (!stmt) return false;
  if (stmt.type !== 'statement_block') return EXIT_STATEMENTS.has(stmt.type);
  const inner = stmt.namedChildren.filter(c => c.type !== 'comment');
  return inner.length > 0 && EXIT_STATEMENTS.has(inner[inner.length - 1].type)
    && inner.slice(0, -1).every(c => c.type === 'expression_statement');
}

/** `x.<field> === <tag> ? a : b` (also `m && m.type === tag ? …`) — its function is the handler. */
function collectTernary(expr: Parser.SyntaxNode, env: CollectorState, out: MessageSites): void {
  env.inner = [expr];
  const found = conditionComparison(expr.childForFieldName('condition'), env);
  if (!found || !('key' in found) || found.negated) return;
  const enclosing = env.enclosingId(expr.startIndex);
  out.registrations.push(enclosing
    ? { key: found.key, handlerIds: [enclosing], container: enclosing, file: env.filePath }
    : { key: unattributedConsumerKey(found.key), handlerIds: [], file: env.filePath });
}

function collectIfClause(stmt: Parser.SyntaxNode, env: CollectorState, out: MessageSites): void {
  env.inner = [stmt];
  const found = conditionComparison(stmt.childForFieldName('condition'), env);
  if (!found) return;
  if ('uncomparable' in found) {
    out.registrations.push({ key: uncomparableKey(found.field, found.uncomparable), handlerIds: [], file: env.filePath });
    return;
  }
  const consequence = stmt.childForFieldName('consequence');
  if (!consequence) return;
  if (!found.negated) {
    out.registrations.push(registrationFor(found.key, [consequence], stmt, env));
    return;
  }
  // `if (m.type !== "x") return;` — what follows handles "x": the enclosing function is the handler.
  if (stmt.childForFieldName('alternative') || !isEarlyExit(consequence)) return;
  const enclosing = env.enclosingId(stmt.startIndex);
  out.registrations.push(enclosing
    ? { key: found.key, handlerIds: [enclosing], container: enclosing, file: env.filePath }
    : { key: unattributedConsumerKey(found.key), handlerIds: [], file: env.filePath });
}

const TYPE_ONLY_WRAPPERS: ReadonlySet<string> = new Set([
  'as_expression', 'satisfies_expression', 'non_null_expression', 'parenthesized_expression', 'type_assertion',
]);

/** The key text of an object pair: `type: …` or `"type": …`. Computed keys are not static here. */
function pairKeyName(keyNode: Parser.SyntaxNode | null): string | undefined {
  if (keyNode?.type === 'property_identifier') return keyNode.text;
  if (keyNode?.type === 'string') return keyNode.text.slice(1, -1);
  return undefined;
}

/**
 * The transport call an object literal is handed to, directly or through `JSON.stringify`, read
 * off the ancestor stack (`ancestors[ancestors.length - 1]` is the literal's parent).
 */
function transportCall(ancestors: Parser.SyntaxNode[]): Parser.SyntaxNode | undefined {
  let k = ancestors.length - 1;
  for (let depth = 0; depth < 2; depth++) {
    // A type-only wrapper (`{ … } as Msg`, `satisfies`, `!`, parentheses) does not change the value.
    while (k >= 0 && TYPE_ONLY_WRAPPERS.has(ancestors[k].type)) k--;
    if (k < 1 || ancestors[k].type !== 'arguments') return undefined;
    const call = ancestors[k - 1];
    if (call.type !== 'call_expression') return undefined;
    const callee = call.childForFieldName('function');
    const name = methodName(callee);
    if (name && TRANSPORT_METHODS.has(name)) return call;
    const isStringify = callee?.type === 'member_expression'
      && callee.childForFieldName('object')?.text === 'JSON' && name === 'stringify';
    if (!isStringify) return undefined;
    k -= 2;
  }
  return undefined;
}

function collectConstruction(obj: Parser.SyntaxNode, env: CollectorState, out: MessageSites): void {
  env.inner = [obj];
  const members = obj.namedChildren;
  let lastSpread = -1;
  for (let i = 0; i < members.length; i++) if (members[i].type === 'spread_element') lastSpread = i;
  const keys: string[] = [];
  for (let i = 0; i < members.length; i++) {
    const pair = members[i];
    if (pair.type !== 'pair') continue;
    const field = pairKeyName(pair.childForFieldName('key'));
    if (!field || !MESSAGE_DISCRIMINANT_FIELDS.has(field)) continue;
    // A later spread can overwrite the tag at run time, so the tag is not static.
    if (i < lastSpread) continue;
    const tag = tagKey(pair.childForFieldName('value'), env);
    if (tag !== undefined) keys.push(`${field}=${tag}`);
  }
  if (keys.length === 0) return;
  const transport = transportCall(env.ancestors);
  if (!transport) return;
  // A send no indexed function contains (top level, an anonymous callback) has no edge to carry,
  // but is still recorded as a send, so it is disclosed rather than dropped.
  const callerId = env.enclosingId(obj.startIndex);
  const line = obj.startPosition.row + 1;
  for (const key of keys) {
    if (callerId) out.dispatches.push({ key, callerId, line });
    out.sends.push({ key, ...(callerId ? { callerId } : {}), filePath: env.filePath, line, start: transport.startIndex, end: transport.endIndex });
  }
}

/**
 * Collect one parsed TS/JS file's message-topology sites into `out`, in ONE top-down walk that
 * carries the ancestor stack — no `.parent` call anywhere, since tree-sitter answers each one by
 * re-walking from the root.
 */
export function collectMessageSites(root: Parser.SyntaxNode, baseEnv: MessageCollectorEnv, out: MessageSites): void {
  const ancestors: Parser.SyntaxNode[] = [];
  const env: CollectorState = { ...baseEnv, ...fileBindings(root), scopeMemo: new Map(), ancestors, inner: [] };
  const cursor = root.walk();
  for (;;) {
    const node = cursor.currentNode;
    if (node.type === 'switch_statement') collectSwitchClauses(node, env, out);
    else if (node.type === 'if_statement') collectIfClause(node, env, out);
    else if (node.type === 'ternary_expression') collectTernary(node, env, out);
    else if (node.type === 'object') collectConstruction(node, env, out);
    if (cursor.gotoFirstChild()) { ancestors.push(node); continue; }
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) return;
      ancestors.pop();
    }
  }
}
