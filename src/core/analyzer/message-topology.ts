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

/** One handler clause: key → the node ids that handle it. */
export interface MessageRegistration { key: string; handlerIds: string[] }
/** One construction site. */
export interface MessageDispatch { key: string; callerId: string; line: number }
/** A construction site, with the source of the transport call it is handed to. */
export interface MessageSend {
  key: string;
  callerId: string;
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
 * The single callee of a clause body, when the body is exactly one call (`handle(m)`,
 * `return handle(m)`, `await handle(m)`), ignoring a trailing `break`. Otherwise undefined.
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
  return methodName(expr.childForFieldName('function'));
}

function handlerFor(statements: Parser.SyntaxNode[], clause: Parser.SyntaxNode, env: MessageCollectorEnv): string[] {
  const callee = singleCallee(statements);
  const id = (callee ? env.resolveCallee(callee) : undefined) ?? env.enclosingId(clause.startIndex);
  return id ? [id] : [];
}

function collectSwitchClauses(sw: Parser.SyntaxNode, env: MessageCollectorEnv, out: MessageSites): void {
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
    const tag = value ? env.staticKey(value) : undefined;
    const statements = clause.namedChildren.filter(c => !(value && c.startIndex === value.startIndex && c.endIndex === value.endIndex) && c.type !== 'comment');
    if (tag !== undefined) pending.push(`${field}=${tag}`);
    if (statements.length === 0) continue;
    if (pending.length > 0) {
      const handlerIds = handlerFor(statements, clause, env);
      if (handlerIds.length) for (const key of pending) out.registrations.push({ key, handlerIds });
    }
    pending = [];
  }
}

function unparen(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | null | undefined {
  let n = node;
  while (n?.type === 'parenthesized_expression') n = n.namedChildren[0];
  return n;
}

/** `x.<field> === <tag>` (either side), as its key, or undefined. */
function equalityKey(node: Parser.SyntaxNode | null | undefined, env: MessageCollectorEnv): string | undefined {
  const cond = unparen(node);
  if (cond?.type !== 'binary_expression') return undefined;
  const op = cond.childForFieldName('operator')?.text;
  if (op !== '===' && op !== '==') return undefined;
  const left = cond.childForFieldName('left');
  const right = cond.childForFieldName('right');
  let field = testedField(left);
  let tag = field ? env.staticKey(right ?? undefined) : undefined;
  if (tag === undefined) {
    field = testedField(right);
    tag = field ? env.staticKey(left ?? undefined) : undefined;
  }
  return field && tag !== undefined ? `${field}=${tag}` : undefined;
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

function collectIfClause(stmt: Parser.SyntaxNode, env: MessageCollectorEnv, out: MessageSites): void {
  const key = conditionKey(stmt.childForFieldName('condition'), env);
  if (!key) return;
  const consequence = stmt.childForFieldName('consequence');
  if (!consequence) return;
  const handlerIds = handlerFor([consequence], stmt, env);
  if (handlerIds.length) out.registrations.push({ key, handlerIds });
}

/** The transport call an object literal is handed to, directly or through `JSON.stringify`. */
function transportCall(obj: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  let arg: Parser.SyntaxNode = obj;
  for (let depth = 0; depth < 2; depth++) {
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
    const keyNode = pair.childForFieldName('key');
    if (keyNode?.type !== 'property_identifier' || !MESSAGE_DISCRIMINANT_FIELDS.has(keyNode.text)) continue;
    // A later spread can overwrite the tag at run time, so the tag is not static.
    if (members.slice(i + 1).some(m => m.type === 'spread_element')) continue;
    const tag = env.staticKey(pair.childForFieldName('value') ?? undefined);
    if (tag !== undefined) keys.push(`${keyNode.text}=${tag}`);
  }
  if (keys.length === 0) return;
  const transport = transportCall(obj);
  if (!transport) return;
  const callerId = env.enclosingId(obj.startIndex);
  if (!callerId) return;
  const line = obj.startPosition.row + 1;
  for (const key of keys) {
    out.dispatches.push({ key, callerId, line });
    out.sends.push({ key, callerId, filePath: env.filePath, line, source: transport.text });
  }
}

/** Collect one parsed TS/JS file's message-topology sites into `out`. */
export function collectMessageSites(root: Parser.SyntaxNode, env: MessageCollectorEnv, out: MessageSites): void {
  for (const sw of root.descendantsOfType('switch_statement')) collectSwitchClauses(sw, env, out);
  for (const stmt of root.descendantsOfType('if_statement')) collectIfClause(stmt, env, out);
  for (const obj of root.descendantsOfType('object')) collectConstruction(obj, env, out);
}
