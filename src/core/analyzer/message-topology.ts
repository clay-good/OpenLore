/**
 * Message-topology edges (change: add-message-topology-edges).
 *
 * A client/server, IPC, or Redux-style app often has no call between the code that builds a
 * message and the code that handles it: `ws.send({ type: "restart" })` on one side, and
 * `switch (msg.type) { case "restart": … }` on the other. This module collects both sides from a
 * parsed TypeScript/JavaScript file so the call graph's synthesis pass can pair them:
 *
 *  - a **consumer clause** is a `switch (x.<field>)` case, or the consequent of
 *    `if (x.<field> === <tag>)`, keyed `<field>=<tag>`. It becomes a registration whose handler is
 *    the clause's single callee when the clause body is one call, and the enclosing function
 *    otherwise;
 *  - a **construction site** is an object literal carrying `<field>: <tag>` that is handed straight
 *    to a transport call (`send`, `postMessage`, `dispatch`, …, optionally through
 *    `JSON.stringify`), keyed the same way. It becomes a dispatch from its enclosing function.
 *
 * Pairing, the fan-out cap, and edge provenance are the event-channel rule's, unchanged. The rule
 * only pairs what is static on both sides: a computed, templated, or spread-overridden tag gives no
 * key, so it gives no edge and no boundary record.
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
 * A send whose key no indexed consumer selects becomes a disclosed dynamic-boundary site, so "no
 * handler found" never reads as "no handler exists".
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

/**
 * The tag recorded for a clause whose tag cannot be compared (`case CHECKOUT_REQUEST`, an imported
 * constant). It pairs with nothing; it only stops a send on the same field from claiming that no
 * consumer exists.
 */
export const MESSAGE_UNCOMPARABLE_TAG = '=*';

/** Calls that hand a message to a transport. A construction passed to one is a send. */
const TRANSPORT_METHODS: ReadonlySet<string> = new Set([
  'send', 'postMessage', 'sendMessage', 'dispatch', 'broadcast', 'publish', 'emit',
]);

/**
 * Cheap pre-filter: the file must name a discriminant field as a property (`x.type`) or as an
 * object key (`type:`). A file with neither does no AST work for this rule.
 */
const MESSAGE_PREFILTER = /(?:\.\s*|[{,]\s*)(?:type|kind|action|event|op|cmd|command|tag)\b/;

export function mayContainMessageTopology(content: string): boolean {
  return MESSAGE_PREFILTER.test(content);
}

/**
 * One handler clause: key → the node ids that handle it. `fallbackId` is the enclosing function,
 * used when the clause's single callee was recorded by name and later resolves to nothing — so the
 * Pass-1 lane, which resolves names only after collection, attributes the clause exactly as the
 * re-parsing lane does.
 */
export interface MessageRegistration { key: string; handlerIds: string[]; fallbackId?: string }
/** One construction site. */
export interface MessageDispatch { key: string; callerId: string; line: number }
/** A construction site, with the source of the transport call it is handed to. */
export interface MessageSend {
  key: string;
  /** Absent when no indexed function contains the send. */
  callerId?: string;
  filePath: string;
  line: number;
  /** Source of the transport call, raw. The caller neutralizes it into evidence. */
  source: string;
}

export interface MessageSites {
  registrations: MessageRegistration[];
  dispatches: MessageDispatch[];
  sends: MessageSend[];
}

/** What the collector needs from the call-graph builder, injected so this module stays a leaf. */
export interface MessageCollectorEnv {
  filePath: string;
  /** Static key of a tag node (`str:x`, `const:A.B`), or undefined when the tag is not static. */
  staticKey: (node: Parser.SyntaxNode | undefined) => string | undefined;
  /** Node id of the indexed function enclosing a byte offset. */
  enclosingId: (startIndex: number) => string | undefined;
  /** Node id of a called name, resolved without guessing, or undefined. */
  resolveCallee: (name: string) => string | undefined;
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

/**
 * A tag that can be paired. `env.staticKey` reads `ident.prop` as a constant, which is right for
 * `Msg.Open` and wrong for `m.type`: a tag read from another message's discriminant is a run-time
 * value that only shares a spelling, so it is refused.
 */
function tagKey(node: Parser.SyntaxNode | null | undefined, env: MessageCollectorEnv): string | undefined {
  if (!node || testedField(node)) return undefined;
  return env.staticKey(node);
}

/**
 * Names bound by an import from a package (`import { info } from "pino"`). A clause calling one
 * calls code outside the index, so the name must not resolve to a same-named function in the repo.
 */
function packageImportedNames(root: Parser.SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (const imp of root.descendantsOfType('import_statement')) {
    const source = imp.childForFieldName('source')?.text.slice(1, -1) ?? '';
    if (source === '' || source.startsWith('.') || source.startsWith('/')) continue;
    for (const id of imp.descendantsOfType(['identifier', 'property_identifier'])) {
      if (id.parent?.type === 'import_specifier' && id.parent.childForFieldName('alias') && id.parent.childForFieldName('name')?.startIndex === id.startIndex) continue;
      names.add(id.text);
    }
  }
  return names;
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
): MessageRegistration | undefined {
  const callee = singleCallee(statements);
  const enclosing = env.enclosingId(clause.startIndex);
  const resolved = callee && !env.packageNames.has(callee) ? env.resolveCallee(callee) : undefined;
  if (resolved) return { key, handlerIds: [resolved], ...(enclosing ? { fallbackId: enclosing } : {}) };
  return enclosing ? { key, handlerIds: [enclosing] } : undefined;
}

interface CollectorState extends MessageCollectorEnv { packageNames: Set<string> }

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
    const tag = tagKey(value, env);
    const statements = clause.namedChildren.filter(c => !(value && c.startIndex === value.startIndex && c.endIndex === value.endIndex) && c.type !== 'comment');
    if (tag !== undefined) pending.push(`${field}=${tag}`);
    else if (isConstantLike(value)) out.registrations.push({ key: `${field}${MESSAGE_UNCOMPARABLE_TAG}`, handlerIds: [] });
    if (statements.length === 0) continue;
    for (const key of pending) {
      const reg = registrationFor(key, statements, clause, env);
      if (reg) out.registrations.push(reg);
    }
    pending = [];
  }
}

function unparen(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | null | undefined {
  let n = node;
  while (n?.type === 'parenthesized_expression') n = n.namedChildren[0];
  return n;
}

/**
 * `x.<field> === <tag>` (either side), as its key, or undefined. A comparison of a discriminant
 * field against a tag that is not static yields `<field>=*` ({@link MESSAGE_UNCOMPARABLE_TAG}).
 */
function equalityKey(node: Parser.SyntaxNode | null | undefined, env: MessageCollectorEnv): string | undefined {
  const cond = unparen(node);
  if (cond?.type !== 'binary_expression') return undefined;
  const op = cond.childForFieldName('operator')?.text;
  if (op !== '===' && op !== '==') return undefined;
  const left = cond.childForFieldName('left');
  const right = cond.childForFieldName('right');
  let field = testedField(left);
  let tag = field ? tagKey(right, env) : undefined;
  if (tag === undefined) {
    field = testedField(right);
    tag = field ? tagKey(left, env) : undefined;
  }
  if (field && tag !== undefined) return `${field}=${tag}`;
  const opaque = testedField(left) && isConstantLike(right) ? testedField(left)
    : testedField(right) && isConstantLike(left) ? testedField(right) : undefined;
  return opaque ? `${opaque}${MESSAGE_UNCOMPARABLE_TAG}` : undefined;
}

/**
 * A tag that names a value this rule cannot compare — an identifier (`CHECKOUT_REQUEST`) or a
 * member chain — but is not another message's discriminant (`a.type === b.type` compares two
 * messages; it selects no tag).
 */
function isConstantLike(node: Parser.SyntaxNode | null | undefined): boolean {
  const n = unparen(node);
  return !!n && (n.type === 'identifier' || n.type === 'member_expression') && !testedField(n);
}

/**
 * The key an `if` condition selects: one equality, or one equality among the operands of an `&&`
 * chain (`msg && msg.type === "stop"`). The consequent runs only when every operand holds, so the
 * tag must match. Two equalities in one chain select nothing a single key can name, so they give none.
 */
function conditionKey(node: Parser.SyntaxNode | null | undefined, env: MessageCollectorEnv): string | undefined {
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
  const keys = operands.map(o => equalityKey(o, env)).filter((k): k is string => k !== undefined);
  return keys.length === 1 ? keys[0] : undefined;
}

function collectIfClause(stmt: Parser.SyntaxNode, env: CollectorState, out: MessageSites): void {
  const key = conditionKey(stmt.childForFieldName('condition'), env);
  if (!key) return;
  if (key.endsWith(MESSAGE_UNCOMPARABLE_TAG)) { out.registrations.push({ key, handlerIds: [] }); return; }
  const consequence = stmt.childForFieldName('consequence');
  if (!consequence) return;
  const reg = registrationFor(key, [consequence], stmt, env);
  if (reg) out.registrations.push(reg);
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

/** The transport call an object literal is handed to, directly or through `JSON.stringify`. */
function transportCall(obj: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  let arg: Parser.SyntaxNode = obj;
  for (let depth = 0; depth < 2; depth++) {
    // A type-only wrapper (`{ … } as Msg`, `satisfies`, `!`, parentheses) does not change the value.
    while (arg.parent && TYPE_ONLY_WRAPPERS.has(arg.parent.type)) arg = arg.parent;
    const args = arg.parent;
    if (args?.type !== 'arguments') return undefined;
    const call = args.parent;
    if (call?.type !== 'call_expression') return undefined;
    const callee = call.childForFieldName('function');
    const name = methodName(callee);
    if (name && TRANSPORT_METHODS.has(name)) return call;
    const isStringify = callee?.type === 'member_expression'
      && callee.childForFieldName('object')?.text === 'JSON' && name === 'stringify';
    if (!isStringify) return undefined;
    arg = call;
  }
  return undefined;
}

function collectConstruction(obj: Parser.SyntaxNode, env: MessageCollectorEnv, out: MessageSites): void {
  const members = obj.namedChildren;
  const keys: string[] = [];
  for (let i = 0; i < members.length; i++) {
    const pair = members[i];
    if (pair.type !== 'pair') continue;
    const field = pairKeyName(pair.childForFieldName('key'));
    if (!field || !MESSAGE_DISCRIMINANT_FIELDS.has(field)) continue;
    // A later spread can overwrite the tag at run time, so the tag is not static.
    if (members.slice(i + 1).some(m => m.type === 'spread_element')) continue;
    const tag = tagKey(pair.childForFieldName('value'), env);
    if (tag !== undefined) keys.push(`${field}=${tag}`);
  }
  if (keys.length === 0) return;
  const transport = transportCall(obj);
  if (!transport) return;
  // A send no indexed function contains (top level, an anonymous callback) has no edge to carry,
  // but is still recorded as a send, so it is disclosed rather than dropped.
  const callerId = env.enclosingId(obj.startIndex);
  const line = obj.startPosition.row + 1;
  for (const key of keys) {
    if (callerId) out.dispatches.push({ key, callerId, line });
    out.sends.push({ key, ...(callerId ? { callerId } : {}), filePath: env.filePath, line, source: transport.text });
  }
}

/** Collect one parsed TS/JS file's message-topology sites into `out`. */
export function collectMessageSites(root: Parser.SyntaxNode, baseEnv: MessageCollectorEnv, out: MessageSites): void {
  const env: CollectorState = { ...baseEnv, packageNames: packageImportedNames(root) };
  for (const sw of root.descendantsOfType('switch_statement')) collectSwitchClauses(sw, env, out);
  for (const stmt of root.descendantsOfType('if_statement')) collectIfClause(stmt, env, out);
  for (const obj of root.descendantsOfType('object')) collectConstruction(obj, env, out);
}
