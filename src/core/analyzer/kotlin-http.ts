/**
 * Kotlin HTTP topology (change: add-kotlin-http-topology, issue #546).
 *
 * Routes and outbound calls, each recognized only in a file that imports the framework's package:
 * a same-named function from another library is never taken for a route or a client call.
 *
 * Annotation-driven frameworks (Spring MVC / WebFlux, JAX-RS, Retrofit) are read from the
 * declaration scanner, because the pinned grammar parses an annotation that opens a file outside
 * the class node. DSL-driven frameworks (Ktor routing, the Spring functional router) and client
 * call chains are read from the parse tree.
 */
import type Parser from 'tree-sitter';
import { blankCommentsPreservingLayout } from './comment-blanking.js';
import { getExceptionParser } from './exception-flow.js';
import type { HttpCall, RouteDefinition } from './http-route-parser.js';
import { normalizeKotlinForParse, scanKotlinDeclarations, scanKotlinFile, type KotlinSignatureDeclaration } from './kotlin-source.js';
import { parseWithBudget, type BudgetableParser } from './parse-budget.js';

type Node = Parser.SyntaxNode;

const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
const VERB_SET: ReadonlySet<string> = new Set(VERBS);

const SPRING_MAPPINGS: Readonly<Record<string, string>> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};

/** Import gates: the package prefix that must be imported for a framework to be recognized. */
const GATES = {
  springMvc: ['org.springframework.web.bind.annotation'],
  springRouter: ['org.springframework.web.reactive.function.server', 'org.springframework.web.servlet.function'],
  jaxRs: ['javax.ws.rs', 'jakarta.ws.rs'],
  ktorServer: ['io.ktor.server.routing', 'io.ktor.routing'],
  ktorClient: ['io.ktor.client'],
  okhttp: ['okhttp3'],
  retrofit: ['retrofit2.http'],
  springClient: ['org.springframework.web.client', 'org.springframework.web.reactive.function.client'],
  jdk: ['java.net.http'],
} as const;

/** Known HTTP frameworks that are not modeled; a file that imports one is counted, by name. */
const UNMODELED_HTTP_FRAMEWORKS: ReadonlyArray<[string, string]> = [
  ['io.micronaut.http', 'micronaut'], ['org.http4k', 'http4k'], ['io.javalin', 'javalin'],
  ['com.github.kittinunf.fuel', 'fuel'], ['io.ktor.server.resources', 'ktor-resources'], ['io.ktor.resources', 'ktor-resources'],
];

/** Marks a route whose path is not a string literal or a resolvable constant. Never matched. */
export const UNRESOLVED_ROUTE_PATH = '<unresolved>';

class Imports {
  private readonly fqns: string[];
  constructor(content: string) { this.fqns = scanKotlinFile(content).imports.map(i => i.fqn); }
  has(prefixes: readonly string[]): boolean {
    return this.fqns.some(fqn => prefixes.some(p => fqn === p || fqn.startsWith(`${p}.`)));
  }
}

/** Frameworks imported by this file that the extractor knows of and does not model. */
export function kotlinUnmodeledHttpFrameworks(content: string): string[] {
  const fqns = scanKotlinFile(content).imports.map(i => i.fqn);
  const found = new Set<string>();
  for (const [prefix, name] of UNMODELED_HTTP_FRAMEWORKS) {
    if (fqns.some(fqn => fqn === prefix || fqn.startsWith(`${prefix}.`))) found.add(name);
  }
  return [...found].sort();
}

// ── String values ───────────────────────────────────────────────────────────

/** `const val NAME = "literal"` declarations of the file. A name with two values is dropped. */
function stringConstants(content: string): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const m of blankCommentsPreservingLayout(content).matchAll(/\bconst[ \t]+val[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?::[ \t]*String[ \t]*)?=[ \t]*"([^"$\\\n]*)"/g)) {
    const prior = seen.get(m[1]);
    seen.set(m[1], prior === undefined || prior === m[2] ? m[2] : null);
  }
  const out = new Map<string, string>();
  for (const [name, value] of seen) if (value !== null) out.set(name, value);
  return out;
}

/** A string literal with no template: its value. Anything else: undefined. */
function plainString(text: string): string | undefined {
  const m = text.trim().match(/^"((?:[^"\\$\n]|\\.)*)"$/);
  return m ? m[1] : undefined;
}

/** A literal path, a constant that resolves to one literal, or {@link UNRESOLVED_ROUTE_PATH}. */
function resolvePath(expression: string, constants: Map<string, string>): string {
  const literal = plainString(expression);
  if (literal !== undefined) return literal;
  const name = expression.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  return (name && constants.get(name)) ?? UNRESOLVED_ROUTE_PATH;
}

/** A URL literal or template; template expressions become `${…}` path parameters. */
function urlText(node: Node | undefined): string | undefined {
  if (!node || node.type !== 'string_literal') return undefined;
  const text = node.text;
  const inner = text.startsWith('"""') ? text.slice(3, -3) : text.slice(1, -1);
  // `$id` and `${expr}` both stand for one path parameter.
  return inner.replace(/\$\{[^}]*\}/g, '${p}').replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '${p}');
}

const looksLikeUrl = (url: string): boolean => /^(?:https?:\/\/|\/|\$\{)/.test(url);

function joinPath(prefix: string, path: string): string {
  if (prefix === UNRESOLVED_ROUTE_PATH || path === UNRESOLVED_ROUTE_PATH) return UNRESOLVED_ROUTE_PATH;
  const joined = `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  return joined.length > 1 ? joined.replace(/\/+$/, '') || '/' : '/';
}

// ── Annotations (from the declaration scanner) ──────────────────────────────

interface Annotation { name: string; args: string }

/** Annotations of a declaration, from the lines the signature renderer gives one per annotation. */
function annotationsOf(declaration: KotlinSignatureDeclaration): Annotation[] {
  const out: Annotation[] = [];
  for (const line of declaration.signature.split('\n')) {
    const m = line.match(/^@(?:[a-z]+:)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\))?$/);
    if (m) out.push({ name: m[1], args: m[2] ?? '' });
  }
  return out;
}

/** Split at commas outside brackets and strings. */
function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === '"') quote = false; continue; }
    if (c === '"') quote = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(last, i)); last = i + 1; }
  }
  parts.push(text.slice(last));
  return parts.map(p => p.trim()).filter(Boolean);
}

/** Named and positional arguments of an annotation. */
function annotationArgs(args: string): { positional: string[]; named: Map<string, string> } {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (const part of splitArgs(args)) {
    const m = part.match(/^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+)$/);
    if (m) named.set(m[1], m[2].trim()); else positional.push(part);
  }
  return { positional, named };
}

/** `"/a"`, `["/a", "/b"]`, `arrayOf("/a", "/b")` → the element expressions. */
function elements(expression: string): string[] {
  const array = expression.trim().match(/^(?:\[([\s\S]*)\]|arrayOf\s*\(([\s\S]*)\))$/);
  return array ? splitArgs(array[1] ?? array[2] ?? '') : [expression.trim()];
}

function annotationPaths(annotation: Annotation | undefined, constants: Map<string, string>): string[] {
  if (!annotation) return [''];
  const { positional, named } = annotationArgs(annotation.args);
  const expression = named.get('value') ?? named.get('path') ?? positional[0];
  if (expression === undefined) return [''];
  return elements(expression).map(e => resolvePath(e, constants));
}

function routeOf(file: string, method: string, path: string, handlerName: string, framework: string, line: number, extra: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    file, method, path,
    // An unresolved path must never match a client call.
    normalizedPath: path === UNRESOLVED_ROUTE_PATH ? `\0unresolved:${file}:${line}` : normalizePath(path),
    handlerName, framework, line, contractSource: 'none', ...extra,
  };
}

/** Same canonical form as `normalizeUrl` in the route parser (kept local to avoid an import cycle). */
function normalizePath(raw: string): string {
  let url = raw.replace(/\$\{[^}]+\}/g, ':param');
  url = url.replace(/^https?:\/\/[^/]+/, '');
  url = url.replace(/[?#].*$/, '');
  url = url.replace(/\{[^}]+\}/g, ':param').replace(/<[^>]+>/g, ':param').replace(/:[\w]+/g, ':param');
  url = `/${url}`.replace(/\/+/g, '/');
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url.toLowerCase();
}

function annotationRoutes(file: string, content: string, imports: Imports, constants: Map<string, string>): RouteDefinition[] {
  const spring = imports.has(GATES.springMvc);
  const jaxRs = imports.has(GATES.jaxRs);
  if (!spring && !jaxRs) return [];
  const declarations = scanKotlinDeclarations(content);
  const routes: RouteDefinition[] = [];
  const classPrefixes = new Map<string, { spring?: string[]; jaxRs?: string[] }>();
  for (const d of declarations) {
    if (d.kind !== 'class' && d.kind !== 'interface' && d.kind !== 'object') continue;
    const annotations = annotationsOf(d);
    const qualified = d.owner ? `${d.owner}.${d.name}` : d.name;
    const entry: { spring?: string[]; jaxRs?: string[] } = {};
    if (spring && annotations.some(a => a.name === 'RestController' || a.name === 'Controller')) {
      entry.spring = annotationPaths(annotations.find(a => a.name === 'RequestMapping'), constants);
    }
    const classPath = annotations.find(a => a.name === 'Path');
    if (jaxRs && classPath) entry.jaxRs = annotationPaths(classPath, constants);
    if (entry.spring || entry.jaxRs) classPrefixes.set(qualified, entry);
  }
  for (const d of declarations) {
    if (d.kind !== 'function' || !d.owner) continue;
    const owner = classPrefixes.get(d.owner);
    if (!owner) continue;
    const annotations = annotationsOf(d);
    const body = d.signature.match(/@RequestBody\s+(?:@\w+(?:\([^)]*\))?\s+)*(?:vararg\s+)?[A-Za-z_]\w*\s*:\s*([^,)=]+)/)?.[1]?.trim();
    const contract: Partial<RouteDefinition> = {
      ...(body ? { requestBodyType: body } : {}),
      ...(d.type ? { responseType: d.type } : {}),
      contractSource: body || d.type ? 'annotation' : 'none',
    };
    if (owner.spring) {
      for (const annotation of annotations) {
        let methods: string[] = [];
        if (SPRING_MAPPINGS[annotation.name]) methods = [SPRING_MAPPINGS[annotation.name]];
        else if (annotation.name === 'RequestMapping') {
          const written = annotationArgs(annotation.args).named.get('method');
          methods = written ? elements(written).map(e => e.split('.').pop()!.trim().toUpperCase()).filter(m => VERB_SET.has(m)) : [];
        }
        if (methods.length === 0) continue;
        for (const prefix of owner.spring) {
          for (const path of annotationPaths(annotation, constants)) {
            for (const method of methods) routes.push(routeOf(file, method, joinPath(prefix, path), d.name, 'spring', d.line, contract));
          }
        }
      }
    }
    if (owner.jaxRs) {
      const verb = annotations.find(a => VERB_SET.has(a.name));
      if (!verb) continue;
      const methodPath = annotations.find(a => a.name === 'Path');
      for (const prefix of owner.jaxRs) {
        for (const path of annotationPaths(methodPath, constants)) routes.push(routeOf(file, verb.name, joinPath(prefix, path), d.name, 'jax-rs', d.line, contract));
      }
    }
  }
  return routes;
}

/** Retrofit interface annotations: outbound calls, matched by path. Never routes. */
function retrofitCalls(file: string, content: string, imports: Imports): HttpCall[] {
  if (!imports.has(GATES.retrofit)) return [];
  const calls: HttpCall[] = [];
  for (const d of scanKotlinDeclarations(content)) {
    if (d.kind !== 'function' || d.ownerKind !== 'interface') continue;
    for (const annotation of annotationsOf(d)) {
      const { positional, named } = annotationArgs(annotation.args);
      let method: string | undefined;
      let expression: string | undefined;
      if (VERB_SET.has(annotation.name)) { method = annotation.name; expression = named.get('value') ?? positional[0]; }
      else if (annotation.name === 'HTTP') { method = plainString(named.get('method') ?? '')?.toUpperCase(); expression = named.get('path'); }
      const url = expression === undefined ? undefined : plainString(expression);
      if (!method || url === undefined) continue;
      calls.push({ file, method, url, normalizedUrl: normalizePath(url), line: d.line, offset: d.offset, client: 'retrofit' });
    }
  }
  return calls;
}

// ── The parse tree (DSL routes and client chains) ───────────────────────────

async function parse(content: string, filePath: string): Promise<Node | undefined> {
  const parser = await getExceptionParser('Kotlin', filePath);
  if (!parser) return undefined;
  return parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, normalizeKotlinForParse(content)).rootNode;
}

interface CallShape {
  name: string;
  receiver?: Node;
  args: Node[];
  lambda?: Node;
  /** The inner call node that was read as part of this one (`get("/x")` of `get("/x") { }`). */
  inner?: Node;
}

/**
 * A call with its name, receiver, value arguments, and trailing lambda. `get("/x") { … }` is two
 * nested call nodes in this grammar (the inner one holds the arguments); they are read as one.
 */
function callShape(node: Node): CallShape | undefined {
  if (node.type !== 'call_expression') return undefined;
  let callee = node.namedChildren[0];
  const suffixes = node.namedChildren.filter(c => c.type === 'call_suffix');
  let args: Node[] = [];
  let lambda: Node | undefined;
  const read = (suffix: Node): void => {
    const list = suffix.namedChildren.find(c => c.type === 'value_arguments');
    if (list) args = list.namedChildren.filter(c => c.type === 'value_argument');
    const annotated = suffix.namedChildren.find(c => c.type === 'annotated_lambda');
    const literal = annotated?.namedChildren.find(c => c.type === 'lambda_literal');
    if (literal) lambda = literal;
  };
  for (const suffix of suffixes) read(suffix);
  let inner: Node | undefined;
  if (callee?.type === 'call_expression' && args.length === 0 && lambda) {
    inner = callee;
    for (const suffix of callee.namedChildren.filter(c => c.type === 'call_suffix')) read(suffix);
    callee = callee.namedChildren[0];
  }
  if (!callee) return undefined;
  const extra = { ...(lambda ? { lambda } : {}), ...(inner ? { inner } : {}) };
  if (callee.type === 'simple_identifier') return { name: callee.text, args, ...extra };
  if (callee.type === 'navigation_expression') {
    const suffix = callee.namedChildren.at(-1);
    const name = suffix?.type === 'navigation_suffix' ? suffix.namedChildren.find(c => c.type === 'simple_identifier') : undefined;
    const receiver = callee.namedChildren[0];
    if (name && receiver) return { name: name.text, receiver, args, ...extra };
  }
  return undefined;
}

/** The value expression of a positional argument, or of the argument named `name`. */
function argValue(args: Node[], index: number, name?: string): Node | undefined {
  if (name) {
    const named = args.find(a => a.namedChildren.length === 2 && a.namedChildren[0].type === 'simple_identifier' && a.namedChildren[0].text === name);
    if (named) return named.namedChildren[1];
  }
  const positional = args.filter(a => !(a.namedChildren.length === 2 && a.namedChildren[0].type === 'simple_identifier' && /=/.test(a.text.slice(a.namedChildren[0].text.length, a.namedChildren[1].startIndex - a.startIndex))));
  return positional[index]?.namedChildren.at(-1);
}

const functionName = (fn: Node): string | undefined => fn.namedChildren.find(c => c.type === 'simple_identifier')?.text.replace(/^`|`$/g, '');

function functionReceiver(fn: Node): string | undefined {
  const name = fn.namedChildren.find(c => c.type === 'simple_identifier');
  const receiver = name && fn.namedChildren.find(c => c.type === 'user_type' && c.endIndex <= name.startIndex);
  return receiver?.namedChildren.filter(c => c.type === 'type_identifier').at(-1)?.text;
}

const CHAIN_LINKS: ReadonlySet<string> = new Set([
  'navigation_expression', 'navigation_suffix', 'call_expression', 'call_suffix', 'value_arguments', 'value_argument',
]);

/**
 * The whole call chain a node belongs to, through receivers and arguments:
 * `HttpRequest.newBuilder(URI.create("u")).build()` from the `URI.create` call. A call that
 * stands alone is its own chain.
 */
function chainRoot(node: Node): Node {
  let cur = node;
  while (cur.parent && CHAIN_LINKS.has(cur.parent.type)) cur = cur.parent;
  return cur;
}

interface Walk {
  file: string;
  constants: Map<string, string>;
  imports: Imports;
  routes: RouteDefinition[];
  calls: HttpCall[];
}

interface Scope {
  /** Inside `routing { }` or a `Route` extension function. */
  ktor: boolean;
  /** Inside `router { }` / `coRouter { }`. */
  springRouter: boolean;
  prefix: string;
  enclosing: string;
}

const KTOR_VERBS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
const ROUTE_RECEIVERS: ReadonlySet<string> = new Set(['Route', 'Routing', 'RootRoute']);

function pathOfArg(node: Node | undefined, walk: Walk): string {
  if (!node) return '';
  if (node.type === 'string_literal') {
    const literal = plainString(node.text);
    return literal ?? UNRESOLVED_ROUTE_PATH;
  }
  return resolvePath(node.text, walk.constants);
}

function handlerOf(args: Node[], from: number, scope: Scope): string {
  for (const arg of args.slice(from)) {
    const reference = arg.descendantsOfType('callable_reference')[0] ?? arg.descendantsOfType('navigation_suffix').find(s => s.text.startsWith('::'));
    const name = reference?.namedChildren.filter(c => c.type === 'simple_identifier').at(-1)?.text;
    if (name) return name;
  }
  return scope.enclosing;
}

function visit(node: Node, scope: Scope, walk: Walk): void {
  if (node.type === 'function_declaration') {
    const name = functionName(node) ?? scope.enclosing;
    const receiver = functionReceiver(node);
    const inner: Scope = {
      ...scope, enclosing: name,
      ktor: walk.imports.has(GATES.ktorServer) && receiver !== undefined && ROUTE_RECEIVERS.has(receiver),
      springRouter: false,
      prefix: '',
    };
    for (const child of node.namedChildren) visit(child, inner, walk);
    return;
  }
  const call = callShape(node);
  if (!call) { for (const child of node.namedChildren) visit(child, scope, walk); return; }

  const line = node.startPosition.row + 1;
  let lambdaScope: Scope = scope;
  let handledAsRoute = false;

  // ── Ktor routing DSL ──
  if (walk.imports.has(GATES.ktorServer) && !call.receiver) {
    if (call.name === 'routing' && call.lambda) lambdaScope = { ...scope, ktor: true, prefix: '' };
    else if (scope.ktor && call.name === 'route' && call.lambda) {
      lambdaScope = { ...scope, prefix: joinPath(scope.prefix, pathOfArg(argValue(call.args, 0, 'path'), walk)) };
    } else if (scope.ktor && KTOR_VERBS.has(call.name) && (call.lambda || call.args.length > 0)) {
      const first = argValue(call.args, 0, 'path');
      // `get { }` inside `route("/p")` has no path of its own.
      const hasPath = first !== undefined && first.type !== 'lambda_literal' && first.type !== 'callable_reference';
      const path = joinPath(scope.prefix, hasPath ? pathOfArg(first, walk) : '');
      walk.routes.push(routeOf(walk.file, call.name.toUpperCase(), path, handlerOf(call.args, hasPath ? 1 : 0, scope), 'ktor', line));
      handledAsRoute = true;
      // A verb call inside a handler is not a route.
      lambdaScope = { ...scope, ktor: false };
    }
  }
  // ── Spring functional router ──
  if (walk.imports.has(GATES.springRouter)) {
    if (!call.receiver && (call.name === 'router' || call.name === 'coRouter') && call.lambda) lambdaScope = { ...scope, springRouter: true, prefix: '' };
    else if (scope.springRouter && !call.receiver && VERB_SET.has(call.name) && call.args.length > 0) {
      const path = joinPath(scope.prefix, pathOfArg(argValue(call.args, 0), walk));
      walk.routes.push(routeOf(walk.file, call.name, path, handlerOf(call.args, 1, scope), 'spring-router', line));
      handledAsRoute = true;
      lambdaScope = { ...scope, springRouter: false };
    } else if (scope.springRouter && call.receiver?.type === 'string_literal' && call.name === 'nest' && call.lambda) {
      lambdaScope = { ...scope, prefix: joinPath(scope.prefix, plainString(call.receiver.text) ?? UNRESOLVED_ROUTE_PATH) };
    }
  }

  // ── Clients ──
  if (!handledAsRoute && call.receiver) {
    const first = argValue(call.args, 0);
    const url = urlText(first);
    const push = (method: string, client: string, raw: string): void => {
      walk.calls.push({ file: walk.file, method, url: raw, normalizedUrl: normalizePath(raw), line, offset: node.startIndex, client });
    };
    if (walk.imports.has(GATES.ktorClient) && url !== undefined && looksLikeUrl(url)) {
      if (KTOR_VERBS.has(call.name)) push(call.name.toUpperCase(), 'ktor-client', url);
      else if (call.name === 'request') {
        const method = call.lambda?.text.match(/\bmethod\s*=\s*HttpMethod\.([A-Za-z]+)/)?.[1]?.toUpperCase();
        push(method && VERB_SET.has(method) ? method : 'UNKNOWN', 'ktor-client', url);
      }
    }
    if (walk.imports.has(GATES.okhttp) && call.name === 'url' && url !== undefined) {
      const chain = chainRoot(node).text;
      if (/\bRequest\s*\.\s*Builder\s*\(/.test(chain)) {
        const verb = chain.match(/\.\s*(post|put|delete|patch|head)\s*\(/)?.[1] ?? chain.match(/\.\s*method\s*\(\s*"([A-Za-z]+)"/)?.[1] ?? 'get';
        push(verb.toUpperCase(), 'okhttp', url);
      }
    }
    if (walk.imports.has(GATES.springClient) && url !== undefined) {
      const restTemplate: Record<string, string> = {
        getForObject: 'GET', getForEntity: 'GET', postForObject: 'POST', postForEntity: 'POST', postForLocation: 'POST',
        patchForObject: 'PATCH',
      };
      if (restTemplate[call.name]) push(restTemplate[call.name], 'spring-rest-template', url);
      else if ((call.name === 'put' || call.name === 'delete') && looksLikeUrl(url)) push(call.name.toUpperCase(), 'spring-rest-template', url);
      else if (call.name === 'exchange') {
        const method = argValue(call.args, 1)?.text.match(/HttpMethod\.([A-Za-z]+)/)?.[1]?.toUpperCase();
        push(method && VERB_SET.has(method) ? method : 'UNKNOWN', 'spring-rest-template', url);
      } else if (call.name === 'uri') {
        const verb = call.receiver.text.match(/\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*\)\s*$/)?.[1];
        if (verb) push(verb.toUpperCase(), 'spring-web-client', url);
      }
    }
    if (walk.imports.has(GATES.jdk) && call.name === 'create' && call.receiver.text === 'URI' && url !== undefined) {
      const chain = chainRoot(node).text;
      if (/\bHttpRequest\b/.test(chain)) {
        const verb = chain.match(/\.\s*(POST|PUT|DELETE|GET|HEAD)\s*\(/)?.[1] ?? chain.match(/\.\s*method\s*\(\s*"([A-Za-z]+)"/)?.[1] ?? 'GET';
        push(verb.toUpperCase(), 'jdk-http-client', url);
      }
    }
  }

  // Descend. A trailing lambda takes the scope its call gave it; every other child the current one.
  const lambda = call.lambda;
  const { inner } = call;
  for (const child of node.namedChildren) {
    if (lambda && child.startIndex <= lambda.startIndex && lambda.endIndex <= child.endIndex) visitContaining(child, lambda, lambdaScope, scope, walk);
    // The inner call node is this same call: its arguments are visited, it is not read again.
    else if (inner && child.startIndex === inner.startIndex && child.endIndex === inner.endIndex) for (const part of child.namedChildren) visit(part, scope, walk);
    else visit(child, scope, walk);
  }
}

/** Visit `node`, giving `lambdaScope` to the subtree of `lambda` and `scope` to the rest. */
function visitContaining(node: Node, lambda: Node, lambdaScope: Scope, scope: Scope, walk: Walk): void {
  if (node.startIndex === lambda.startIndex && node.endIndex === lambda.endIndex && node.type === lambda.type) {
    for (const child of node.namedChildren) visit(child, lambdaScope, walk);
    return;
  }
  // The inner call node of `get("/x") { }` and the suffix wrappers lead to the lambda; their
  // other children (the arguments) keep the outer scope.
  for (const child of node.namedChildren) {
    if (child.startIndex <= lambda.startIndex && lambda.endIndex <= child.endIndex) visitContaining(child, lambda, lambdaScope, scope, walk);
    else visit(child, scope, walk);
  }
}

export interface KotlinHttpFacts {
  routes: RouteDefinition[];
  calls: HttpCall[];
  /** Imported HTTP frameworks that are known and not modeled. */
  unmodeled: string[];
}

/** Routes and outbound HTTP calls of one Kotlin file. Fail-soft: a file that cannot be parsed yields its annotation facts only. */
export async function extractKotlinHttp(file: string, content: string): Promise<KotlinHttpFacts> {
  const imports = new Imports(content);
  const unmodeled = kotlinUnmodeledHttpFrameworks(content);
  const gated = Object.values(GATES).some(prefixes => imports.has(prefixes));
  if (!gated) return { routes: [], calls: [], unmodeled };
  const constants = stringConstants(content);
  const routes = annotationRoutes(file, content, imports, constants);
  const calls = retrofitCalls(file, content, imports);
  const needsTree = (['ktorServer', 'springRouter', 'ktorClient', 'okhttp', 'springClient', 'jdk'] as const).some(g => imports.has(GATES[g]));
  if (needsTree) {
    try {
      const root = await parse(content, file);
      if (root) {
        const walk: Walk = { file, constants, imports, routes, calls };
        visit(root, { ktor: false, springRouter: false, prefix: '', enclosing: '<file>' }, walk);
      }
    } catch { /* fail-soft: annotation facts stand */ }
  }
  const byLine = <T extends { line: number }>(a: T, b: T): number => a.line - b.line;
  return { routes: routes.sort(byLine), calls: calls.sort(byLine), unmodeled };
}
