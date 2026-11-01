/**
 * Projection: OpenAPI operations → the existing graph primitives (change: add-contract-node-projection).
 *
 * The single place where a declared interface becomes an ordinary graph node. Because it reuses
 * FunctionNode/CallEdge, orient/search_code/get_subgraph/analyze_impact/find_path and the SCIP +
 * federation exports see contract elements with no change of their own.
 *
 * Two edges are produced, both LITERAL — no name similarity, no embeddings:
 *   `implements_endpoint`  handler function → the operation it serves
 *   `consumes_endpoint`    the function enclosing a client call → the operation it calls
 *
 * Everything the projection could not bind is disclosed, never dropped: operations no route
 * serves, routes no operation declares, client calls whose method or path is not literal, a
 * specification that failed to parse, and the caps this projection stops at.
 */

import type { CallEdge, FunctionNode } from '../call-graph-types.js';
import type { HttpCall, RouteDefinition } from '../http-route-parser.js';
import { normalizeUrl } from '../http-route-parser.js';
import { readOpenApi, looksLikeOpenApi, HTTP_METHODS, type ContractDocument } from './openapi.js';

/** Specification files read per build. */
export const MAX_CONTRACT_FILES = 50;
/** Operation nodes projected per build. */
export const MAX_CONTRACT_OPERATIONS = 2000;
/** Unbound sites listed per kind (the count is always exact). */
const MAX_DISCLOSED = 20;

const CONCRETE_METHODS: ReadonlySet<string> = new Set(HTTP_METHODS.map(m => m.toUpperCase()));

/** A specification file that declared itself one and could not be read. */
export interface UnreadSpecification { file: string; reason: string }

/** A route registration no declared operation matched. */
export interface UnmatchedRoute { file: string; method: string; path: string }

/** A client call site the projection refused to bind, with why. */
export interface UnboundClientCall { file: string; line: number; url: string; reason: 'method-not-literal' | 'path-not-literal' | 'no-operation' }

/**
 * What the projection could not bind, carried on the build result so a consumer can say
 * "unmatched" rather than imply absence. No node, no edge — disclosure only.
 */
export interface ContractDisclosure {
  /** Addresses of operations no indexed route serves. */
  unmatchedOperations: string[];
  /** Route registrations no declared operation matched. */
  unmatchedRoutes: UnmatchedRoute[];
  /** Specifications that declared themselves one and could not be read. */
  unreadSpecifications: UnreadSpecification[];
  /** Client call sites left unbound (bounded list; `unboundClientCallCount` is exact). */
  unboundClientCalls: UnboundClientCall[];
  unboundClientCallCount: number;
  /** Set when a cap stopped the projection, naming what it stopped at. */
  truncated?: { reason: 'file-cap' | 'operation-cap'; cap: number; seen: number };
}

export interface ProjectedContracts extends ContractDisclosure {
  nodes: FunctionNode[];
  edges: CallEdge[];
}

/** The disclosure half of a projection, or undefined when it has nothing to disclose. */
export function contractDisclosure(p: ProjectedContracts): ContractDisclosure | undefined {
  const rest: ContractDisclosure = {
    unmatchedOperations: p.unmatchedOperations,
    unmatchedRoutes: p.unmatchedRoutes,
    unreadSpecifications: p.unreadSpecifications,
    unboundClientCalls: p.unboundClientCalls,
    unboundClientCallCount: p.unboundClientCallCount,
    ...(p.truncated ? { truncated: p.truncated } : {}),
  };
  const empty = !rest.unmatchedOperations.length && !rest.unmatchedRoutes.length
    && !rest.unreadSpecifications.length && !rest.unboundClientCallCount && !rest.truncated;
  return empty ? undefined : rest;
}

const EMPTY: ProjectedContracts = {
  nodes: [], edges: [], unmatchedOperations: [], unmatchedRoutes: [],
  unreadSpecifications: [], unboundClientCalls: [], unboundClientCallCount: 0,
};

export interface ContractProjectionInput {
  /** Candidate specification files, path + content. */
  files: readonly { path: string; content: string }[];
  /** Candidates the caller did not read, so the cap it hit is disclosed rather than invisible. */
  filesOmitted?: number;
  /** Server route registrations from the HTTP route parser. */
  routes: readonly RouteDefinition[];
  /** Client call sites from the HTTP projection. */
  calls: readonly HttpCall[];
  /** The code node that implements a route, or undefined when it cannot be resolved uniquely. */
  resolveHandler: (route: RouteDefinition) => FunctionNode | undefined;
  /** The code node enclosing a client call, or undefined. */
  resolveCaller: (call: HttpCall) => FunctionNode | undefined;
}

/** A path template with no literal segment (`/`, `/{id}`): too generic to match without its base path. */
const onlyParams = (normalized: string): boolean =>
  normalized.split('/').filter(Boolean).every(seg => seg.startsWith(':'));

/**
 * Whether a client call's URL is literal enough to bind: written as a path or an absolute URL,
 * with no interpolation in the host or the first path segment. `/v1/orders/${id}` is literal (the
 * interpolation is a path parameter); `${base}/orders` is not — the base could be another service.
 */
function isLiteralCallUrl(raw: string): boolean {
  const url = raw.trim();
  if (/^https?:\/\//i.test(url)) {
    const rest = url.replace(/^https?:\/\//i, '');
    const host = rest.split('/')[0] ?? '';
    return !host.includes('${');
  }
  if (!url.startsWith('/')) return false;
  const first = url.replace(/^\/+/, '').split('/')[0] ?? '';
  return !first.includes('${');
}

/** Stable node id for an operation, mirroring the IaC projector's `<file>::<address>`. */
const nodeId = (file: string, address: string): string => `${file}::${address}`;

/**
 * Project the operations declared by `files` and bind them to the code that serves and calls them.
 *
 * Matching is by HTTP method plus the normalized path template: the operation's FULL path (the
 * servers base path included), or — because a router is often mounted under that base — the path
 * as declared under `paths`, but only when it carries a literal segment and exactly ONE operation
 * across every specification has that method and declared path. A match that is not unique is no
 * match.
 */
export function projectContracts(input: ContractProjectionInput): ProjectedContracts {
  if (!input.files.length) {
    return input.filesOmitted
      ? { ...EMPTY, truncated: { reason: 'file-cap', cap: MAX_CONTRACT_FILES, seen: input.filesOmitted } }
      : EMPTY;
  }
  const candidates = [...input.files]
    .filter(f => looksLikeOpenApi(f.content))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!candidates.length) return EMPTY;

  let truncated: ProjectedContracts['truncated'];
  const read = candidates.slice(0, MAX_CONTRACT_FILES);
  const omitted = input.filesOmitted ?? 0;
  if (candidates.length > MAX_CONTRACT_FILES || omitted) {
    truncated = { reason: 'file-cap', cap: MAX_CONTRACT_FILES, seen: candidates.length + omitted };
  }

  const docs: ContractDocument[] = [];
  const unreadSpecifications: UnreadSpecification[] = [];
  for (const f of read) {
    const doc = readOpenApi(f.path, f.content);
    if (!doc) continue;
    if ('error' in doc) { unreadSpecifications.push({ file: f.path, reason: doc.error }); continue; }
    docs.push(doc);
  }
  if (!docs.length) {
    return { ...EMPTY, unreadSpecifications, ...(truncated ? { truncated } : {}) };
  }

  // ── Operation nodes ───────────────────────────────────────────────────────
  const nodes: FunctionNode[] = [];
  /** Normalized `METHOD /full/path` → the operation nodes at it (several specifications may declare it). */
  const byFullPath = new Map<string, FunctionNode[]>();
  /** Normalized `METHOD /declared/path` → the operation nodes at it. */
  const byDeclaredPath = new Map<string, FunctionNode[]>();
  const index = (m: Map<string, FunctionNode[]>, key: string, node: FunctionNode): void => {
    const at = m.get(key);
    if (at) at.push(node); else m.set(key, [node]);
  };
  let seenOperations = 0;
  for (const doc of docs) {
    for (const op of doc.operations) {
      seenOperations++;
      if (nodes.length >= MAX_CONTRACT_OPERATIONS) continue;
      const id = nodeId(doc.file, op.address);
      const node: FunctionNode = {
        id,
        name: op.address,
        filePath: doc.file,
        className: doc.format === 'swagger-2' ? 'Swagger' : 'OpenAPI',
        isAsync: false,
        language: 'OpenAPI',
        startIndex: 0,
        endIndex: 0,
        fanIn: 0,
        fanOut: 0,
        ...(op.operationId ? { signature: op.operationId } : {}),
        startLine: op.line,
        endLine: op.line,
      };
      nodes.push(node);
      index(byFullPath, `${op.method} ${normalizeUrl(op.path)}`, node);
      index(byDeclaredPath, `${op.method} ${normalizeUrl(op.declaredPath)}`, node);
    }
  }
  if (seenOperations > nodes.length) {
    truncated = { reason: 'operation-cap', cap: MAX_CONTRACT_OPERATIONS, seen: seenOperations };
  }

  /**
   * The operation a method + path serves, or undefined. The full path wins; the declared path
   * binds only when it is unique across every specification and is not all-parameter.
   */
  const operationFor = (method: string, rawPath: string): FunctionNode | undefined => {
    const path = normalizeUrl(rawPath);
    const key = `${method} ${path}`;
    const full = byFullPath.get(key);
    // Several specifications declaring the same operation (a bundle beside its source): the
    // first by file path owns the binding, deterministically.
    if (full?.length) return full[0];
    if (onlyParams(path)) return undefined;
    const declared = byDeclaredPath.get(key);
    return declared?.length === 1 ? declared[0] : undefined;
  };

  /**
   * Parameterized operations by `METHOD <segment count>`, so filling a concrete path in compares
   * against only the templates of the same shape instead of every operation in the repository.
   * Built once, lazily — a repository whose client calls all match exactly never pays for it.
   */
  let templatesByShape: Map<string, Array<{ segments: string[]; node: FunctionNode }>> | undefined;
  const shapeIndex = (): NonNullable<typeof templatesByShape> => {
    if (templatesByShape) return templatesByShape;
    templatesByShape = new Map();
    for (const [key, at] of byFullPath) {
      const space = key.indexOf(' ');
      const segments = key.slice(space + 1).split('/').filter(Boolean);
      if (!segments.some(seg => seg.startsWith(':'))) continue;
      const shape = `${key.slice(0, space)} ${segments.length}`;
      const bucket = templatesByShape.get(shape);
      const entry = { segments, node: at[0] };
      if (bucket) bucket.push(entry); else templatesByShape.set(shape, [entry]);
    }
    return templatesByShape;
  };

  /**
   * The operation a CONCRETE path fills in, or undefined — a client call writes the value
   * (`/v1/orders/7`) where the specification writes the parameter (`/v1/orders/{id}`). Still
   * literal: a template segment accepts one path segment and nothing else, no similarity and no
   * prefix guessing. An exact match always wins (`operationFor` is tried first), and a concrete
   * path that fills in MORE THAN ONE template binds nothing.
   */
  const operationFilledBy = (method: string, rawPath: string): FunctionNode | undefined => {
    const segments = normalizeUrl(rawPath).split('/').filter(Boolean);
    if (!segments.length || segments.some(seg => seg.startsWith(':'))) return undefined;
    const matched = (shapeIndex().get(`${method} ${segments.length}`) ?? [])
      .filter(t => t.segments.every((seg, i) => seg.startsWith(':') || seg === segments[i]))
      .map(t => t.node);
    return new Set(matched.map(n => n.name)).size === 1 ? matched[0] : undefined;
  };

  // ── implements_endpoint: handler → operation ──────────────────────────────
  const edges: CallEdge[] = [];
  const seenEdges = new Set<string>();
  const matchedOperations = new Set<string>();
  const unmatchedRoutes: UnmatchedRoute[] = [];
  const pushEdge = (from: FunctionNode, to: FunctionNode, kind: 'implements_endpoint' | 'consumes_endpoint', line?: number): void => {
    const key = `${from.id}\0${to.id}\0${kind}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({
      callerId: from.id,
      calleeId: to.id,
      calleeName: to.name,
      ...(line !== undefined ? { line } : {}),
      confidence: 'import',
      kind,
    });
  };
  const routes = [...input.routes].sort((a, b) =>
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    || a.line - b.line
    || (a.method < b.method ? -1 : a.method > b.method ? 1 : 0),
  );
  for (const route of routes) {
    const method = route.method.toUpperCase();
    // A wildcard-method registration (`app.use`, `app.all`) declares no one operation.
    if (!CONCRETE_METHODS.has(method)) continue;
    const op = operationFor(method, route.path);
    if (!op) { unmatchedRoutes.push({ file: route.file, method, path: route.path }); continue; }
    matchedOperations.add(op.id);
    const handler = input.resolveHandler(route);
    // The operation is declared and served; only the HANDLER could not be pinned to one node.
    if (handler) pushEdge(handler, op, 'implements_endpoint', route.line);
  }

  // ── consumes_endpoint: the function enclosing a client call → operation ───
  const unboundClientCalls: UnboundClientCall[] = [];
  let unboundClientCallCount = 0;
  const disclose = (call: HttpCall, reason: UnboundClientCall['reason']): void => {
    unboundClientCallCount++;
    if (unboundClientCalls.length < MAX_DISCLOSED) {
      unboundClientCalls.push({ file: call.file, line: call.line, url: call.url, reason });
    }
  };
  const calls = [...input.calls].sort((a, b) =>
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
  for (const call of calls) {
    const method = call.method.toUpperCase();
    if (!CONCRETE_METHODS.has(method)) { disclose(call, 'method-not-literal'); continue; }
    if (!isLiteralCallUrl(call.url)) { disclose(call, 'path-not-literal'); continue; }
    const op = operationFor(method, call.url) ?? operationFilledBy(method, call.url);
    if (!op) { disclose(call, 'no-operation'); continue; }
    matchedOperations.add(op.id);
    const caller = input.resolveCaller(call);
    if (caller) pushEdge(caller, op, 'consumes_endpoint', call.line);
  }

  const unmatchedOperations = nodes.filter(n => !matchedOperations.has(n.id)).map(n => n.name).sort();
  return {
    nodes,
    edges,
    unmatchedOperations,
    unmatchedRoutes,
    unreadSpecifications,
    unboundClientCalls,
    unboundClientCallCount,
    ...(truncated ? { truncated } : {}),
  };
}
