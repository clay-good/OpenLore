/**
 * Projection: OpenAPI operations → the existing graph primitives (change: add-contract-node-projection).
 *
 * The single place where a declared interface becomes an ordinary graph node. Because it reuses
 * FunctionNode/CallEdge, orient/search_code/get_subgraph/analyze_impact and the SCIP + federation
 * exports see contract elements with no change of their own.
 *
 * Two edges are produced, both LITERAL — no name similarity, no embeddings:
 *   `implements_endpoint`  handler function → the operation it serves
 *   `consumes_endpoint`    the function enclosing a client call → the operation it calls
 *
 * An edge carries this substrate's authority, so every rule below refuses rather than guesses: a
 * method + path that names more than ONE declared operation binds nothing (two services in one
 * repository are not one service), and a call written to an absolute URL binds only when the host
 * is one the document itself declares.
 *
 * Everything the projection could not bind is disclosed, never dropped: operations no route
 * serves, routes no operation declares, handlers and callers that matched but could not be pinned
 * to one node, client calls whose method or path is not literal, ambiguous addresses, a
 * specification that failed to parse, inputs that were not assessed at all, and every cap. Each
 * list is bounded and carries an exact total, so a disclosure can never itself become the thing
 * that blows up an artifact.
 */

import type { CallEdge, FunctionNode } from '../call-graph-types.js';
import type { HttpCall, RouteDefinition } from '../http-route-parser.js';
import { normalizeUrl } from '../http-route-parser.js';
import { readOpenApi, looksLikeOpenApi, HTTP_METHODS, type ContractDocument } from './openapi.js';

/** Specification files read per build. */
export const MAX_CONTRACT_FILES = 50;
/** Operation nodes projected per build. */
export const MAX_CONTRACT_OPERATIONS = 2000;
/** Items listed per disclosure (every list carries its exact total beside it). */
export const MAX_DISCLOSED = 20;

const CONCRETE_METHODS: ReadonlySet<string> = new Set(HTTP_METHODS.map(m => m.toUpperCase()));

/** The edge kinds this projection produces — neither is a call, and neither ranks code. */
export const CONTRACT_EDGE_KINDS = ['implements_endpoint', 'consumes_endpoint'] as const;

/** Whether an edge kind is one the contract projection produces. */
export function isContractEdgeKind(kind: string | undefined): boolean {
  return kind === 'implements_endpoint' || kind === 'consumes_endpoint';
}

/** A bounded list with its exact total, so a cap never reads as the whole truth. */
export interface Disclosed<T> { items: T[]; total: number }

/** A specification file that declared itself one and could not be read. */
export interface UnreadSpecification { file: string; reason: string }

/** A route registration no declared operation matched. */
export interface UnmatchedRoute { file: string; method: string; path: string }

/** A route or call that matched an operation but could not be pinned to one code node. */
export interface UnresolvedBinding { file: string; line: number; method: string; path: string; operation: string }

/** A client call site the projection refused to bind, with why. */
export interface UnboundClientCall {
  file: string;
  line: number;
  url: string;
  reason: 'method-not-literal' | 'path-not-literal' | 'foreign-host' | 'ambiguous-operation' | 'no-operation';
}

/** A method + path that names more than one declared operation, so nothing binds to it. */
export interface AmbiguousAddress { address: string; operations: string[] }

/**
 * What the projection could not bind, carried on the build result so a consumer can say
 * "unmatched" rather than imply absence. No node, no edge — disclosure only.
 */
export interface ContractDisclosure {
  /** Operations no indexed route serves and no indexed client call consumes. */
  unmatchedOperations: Disclosed<string>;
  /** Route registrations no declared operation matched. */
  unmatchedRoutes: Disclosed<UnmatchedRoute>;
  /** Routes and calls that matched an operation but whose code node could not be resolved. */
  unresolvedBindings: Disclosed<UnresolvedBinding>;
  /** Specifications that declared themselves one and could not be read. */
  unreadSpecifications: Disclosed<UnreadSpecification>;
  /** Client call sites left unbound. */
  unboundClientCalls: Disclosed<UnboundClientCall>;
  /** Addresses that name more than one declared operation; nothing binds to them. */
  ambiguousAddresses: Disclosed<AmbiguousAddress>;
  /**
   * Set when a conclusion is WITHHELD because an input was not assessed — the route extraction
   * failed or degraded, a specification could not be read, or the operation cap stopped the
   * index. Then `unmatchedOperations` and `unmatchedRoutes` are empty because they cannot be
   * computed, NOT because nothing is unmatched.
   */
  notAssessed?: string[];
  /** Every cap the projection stopped at (both can fire in one build). */
  truncations?: Array<{ reason: 'file-cap' | 'operation-cap'; cap: number; seen: number }>;
}

export interface ProjectedContracts extends ContractDisclosure {
  nodes: FunctionNode[];
  edges: CallEdge[];
}

const bound = <T>(items: T[]): Disclosed<T> => ({ items: items.slice(0, MAX_DISCLOSED), total: items.length });
const none = <T>(): Disclosed<T> => ({ items: [], total: 0 });

/** An empty projection, for a caller that must disclose a failure instead of a result. */
export function emptyContractProjection(): ProjectedContracts {
  return empty();
}

function empty(): ProjectedContracts {
  return {
    nodes: [], edges: [],
    unmatchedOperations: none(), unmatchedRoutes: none(), unresolvedBindings: none(),
    unreadSpecifications: none(), unboundClientCalls: none(), ambiguousAddresses: none(),
  };
}

/** The disclosure half of a projection, or undefined when it says nothing at all. */
export function contractDisclosure(p: ProjectedContracts): ContractDisclosure | undefined {
  const rest: ContractDisclosure = {
    unmatchedOperations: p.unmatchedOperations,
    unmatchedRoutes: p.unmatchedRoutes,
    unresolvedBindings: p.unresolvedBindings,
    unreadSpecifications: p.unreadSpecifications,
    unboundClientCalls: p.unboundClientCalls,
    ambiguousAddresses: p.ambiguousAddresses,
    ...(p.notAssessed ? { notAssessed: p.notAssessed } : {}),
    ...(p.truncations ? { truncations: p.truncations } : {}),
  };
  const lists: Array<Disclosed<unknown>> = [
    rest.unmatchedOperations, rest.unmatchedRoutes, rest.unresolvedBindings,
    rest.unreadSpecifications, rest.unboundClientCalls, rest.ambiguousAddresses,
  ];
  const silent = lists.every(l => l.total === 0) && !rest.notAssessed && !rest.truncations;
  return silent ? undefined : rest;
}

export interface ContractProjectionInput {
  /** Candidate specification files, path + content. */
  files: readonly { path: string; content: string }[];
  /** Candidates the caller did not read, so the cap it hit is disclosed rather than invisible. */
  filesOmitted?: number;
  /** Server route registrations from the HTTP route parser. */
  routes: readonly RouteDefinition[];
  /** Client call sites from the HTTP projection. */
  calls: readonly HttpCall[];
  /**
   * Why the route/call extraction cannot be treated as complete (it threw, or a file hit a parse
   * budget). Present means no "nothing serves this operation" conclusion is drawn at all.
   */
  extractionNotAssessed?: readonly string[];
  /** The code node that implements a route, or undefined when it cannot be resolved uniquely. */
  resolveHandler: (route: RouteDefinition) => FunctionNode | undefined;
  /** The code node enclosing a client call, or undefined. */
  resolveCaller: (call: HttpCall) => FunctionNode | undefined;
}

/** A path template with no literal segment (`/`, `/{id}`): too generic to match without its base path. */
const onlyParams = (normalized: string): boolean =>
  normalized.split('/').filter(Boolean).every(seg => seg.startsWith(':'));

/**
 * The literal host of an absolute URL, lower-cased and without the port; `''` when the URL is a
 * path (no host to check), `null` when a host is written but interpolated.
 */
function literalHost(raw: string): string | null {
  const url = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return '';
  const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = rest.split(/[/?#]/)[0] ?? '';
  if (!host || host.includes('${')) return null;
  return host.split('@').pop()!.split(':')[0].toLowerCase();
}

/**
 * Whether a client call's URL is literal enough to bind: written as a path or an absolute URL,
 * with no interpolation in the host or the first path segment. `/v1/orders/${id}` is literal (the
 * interpolation is a path parameter); `${base}/orders` is not — the base could be another service.
 */
function isLiteralCallUrl(raw: string): boolean {
  const url = raw.trim();
  const host = literalHost(url);
  if (host === null) return false;
  if (host) return true;
  if (!url.startsWith('/')) return false;
  const first = url.replace(/^\/+/, '').split('/')[0] ?? '';
  return !first.includes('${');
}

/** Stable node id for an operation, mirroring the IaC projector's `<file>::<address>`. */
const nodeId = (file: string, address: string): string => `${file}::${address}`;

interface Indexed { node: FunctionNode; doc: ContractDocument; segments: string[] }

/**
 * Project the operations declared by `files` and bind them to the code that serves and calls them.
 *
 * Matching is by HTTP method plus the normalized path template: the operation's FULL path (the
 * servers base path included), or — because a router is often mounted under that base — the path
 * as declared under `paths`. Either way the match must name exactly ONE declared operation across
 * every specification; a base-less match additionally needs a literal segment. A match that is
 * not unique is no match, and the address is disclosed as ambiguous.
 */
export function projectContracts(input: ContractProjectionInput): ProjectedContracts {
  const notAssessed = new Set<string>(input.extractionNotAssessed ?? []);
  const truncations: NonNullable<ContractDisclosure['truncations']> = [];
  const omitted = input.filesOmitted ?? 0;

  const finish = (p: ProjectedContracts): ProjectedContracts => ({
    ...p,
    ...(notAssessed.size ? { notAssessed: [...notAssessed].sort() } : {}),
    ...(truncations.length ? { truncations } : {}),
  });

  const candidates = [...input.files]
    .filter(f => looksLikeOpenApi(f.content))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Defensive: the caller caps RETENTION (it holds the content); this caps reading. Either cap
  // means a candidate that could declare what a route serves was never read.
  const read = candidates.slice(0, MAX_CONTRACT_FILES);
  const unread = candidates.length - read.length + omitted;
  if (unread > 0) {
    truncations.push({ reason: 'file-cap', cap: MAX_CONTRACT_FILES, seen: candidates.length + omitted });
    notAssessed.add(`${unread} specification candidate(s) past the file cap were not read`);
  }
  if (!read.length) return finish(empty());

  const docs: ContractDocument[] = [];
  const unreadSpecifications: UnreadSpecification[] = [];
  for (const f of read) {
    const doc = readOpenApi(f.path, f.content);
    if (!doc) continue;
    if ('error' in doc) { unreadSpecifications.push({ file: f.path, reason: doc.error }); continue; }
    docs.push(doc);
  }
  // A specification that could not be read may declare the very operation a route serves, so no
  // "nothing declares this route" conclusion can be drawn while one is unread.
  if (unreadSpecifications.length) {
    notAssessed.add(`${unreadSpecifications.length} specification(s) could not be read`);
  }
  if (!docs.length) {
    return finish({ ...empty(), unreadSpecifications: bound(unreadSpecifications) });
  }

  // ── Operation nodes ───────────────────────────────────────────────────────
  const nodes: FunctionNode[] = [];
  /** Normalized `METHOD /full/path` → the operations at it. */
  const byFullPath = new Map<string, Indexed[]>();
  /** Normalized `METHOD /declared/path` → the operations at it. */
  const byDeclaredPath = new Map<string, Indexed[]>();
  const index = (m: Map<string, Indexed[]>, key: string, entry: Indexed): void => {
    const at = m.get(key);
    if (at) at.push(entry); else m.set(key, [entry]);
  };
  let seenOperations = 0;
  for (const doc of docs) {
    for (const op of doc.operations) {
      seenOperations++;
      if (nodes.length >= MAX_CONTRACT_OPERATIONS) continue;
      const node: FunctionNode = {
        id: nodeId(doc.file, op.address),
        name: op.address,
        filePath: doc.file,
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
      const full = normalizeUrl(op.path);
      index(byFullPath, `${op.method} ${full}`, { node, doc, segments: full.split('/').filter(Boolean) });
      const declared = normalizeUrl(op.declaredPath);
      index(byDeclaredPath, `${op.method} ${declared}`, { node, doc, segments: declared.split('/').filter(Boolean) });
    }
  }
  if (seenOperations > nodes.length) {
    truncations.push({ reason: 'operation-cap', cap: MAX_CONTRACT_OPERATIONS, seen: seenOperations });
    // An unindexed operation may be the one a route serves, so neither side can be called unmatched.
    notAssessed.add(`${seenOperations - nodes.length} operation(s) past the operation cap were not indexed`);
  }

  const ambiguous = new Map<string, AmbiguousAddress>();
  /**
   * The ONE operation a bucket names, or undefined when it names several. Several specifications
   * declaring the SAME address (a bundle beside its source) are one operation, and the first by
   * file path owns it; two different addresses colliding on a normalized key — a different case,
   * a trailing slash, a differently-named parameter in another service's specification — are an
   * ambiguity, disclosed and bound to nothing.
   */
  const unique = (key: string, at: Indexed[] | undefined): Indexed | undefined => {
    if (!at?.length) return undefined;
    const addresses = [...new Set(at.map(e => e.node.name))].sort();
    if (addresses.length === 1) return at[0];
    ambiguous.set(key, { address: key, operations: addresses });
    return undefined;
  };

  /**
   * The operation a method + path serves, or undefined. The full path wins; the declared path
   * binds only when it is not all-parameter. Either way the match must be unique.
   */
  const operationFor = (method: string, rawPath: string): Indexed | undefined => {
    const path = normalizeUrl(rawPath);
    const key = `${method} ${path}`;
    const full = byFullPath.get(key);
    if (full?.length) return unique(key, full);
    if (onlyParams(path)) return undefined;
    return unique(key, byDeclaredPath.get(key));
  };

  /**
   * Parameterized operations by `METHOD <segment count>`, so filling a concrete path in compares
   * against only the templates of the same shape instead of every operation in the repository.
   * Both indexes contribute, so a router mounted without the base path fills in too. Built once,
   * lazily — a repository whose client calls all match exactly never pays for it.
   */
  let templatesByShape: Map<string, Indexed[]> | undefined;
  const shapeIndex = (): NonNullable<typeof templatesByShape> => {
    if (templatesByShape) return templatesByShape;
    templatesByShape = new Map();
    const seen = new Set<string>();
    for (const [key, at] of [...byFullPath, ...byDeclaredPath]) {
      const method = key.slice(0, key.indexOf(' '));
      for (const entry of at) {
        if (!entry.segments.some(seg => seg.startsWith(':'))) continue;
        if (entry.segments.every(seg => seg.startsWith(':'))) continue;
        const dedupe = `${method} ${entry.segments.join('/')}\0${entry.node.id}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const shape = `${method} ${entry.segments.length}`;
        const bucket = templatesByShape.get(shape);
        if (bucket) bucket.push(entry); else templatesByShape.set(shape, [entry]);
      }
    }
    return templatesByShape;
  };

  /**
   * The operation a CONCRETE path fills in — a client call writes the value (`/v1/orders/7`)
   * where the specification writes the parameter (`/v1/orders/{id}`). Still literal: a template
   * segment accepts one path segment and nothing else, no similarity and no prefix guessing. An
   * exact match always wins (`operationFor` is tried first), and a concrete path that fills in
   * more than one declared operation binds nothing.
   */
  const operationFilledBy = (method: string, rawPath: string): { hit?: Indexed; ambiguous?: true } => {
    const segments = normalizeUrl(rawPath).split('/').filter(Boolean);
    if (!segments.length || segments.some(seg => seg.startsWith(':'))) return {};
    const matched = (shapeIndex().get(`${method} ${segments.length}`) ?? [])
      .filter(t => t.segments.every((seg, i) => seg.startsWith(':') || seg === segments[i]));
    if (new Set(matched.map(t => t.node.name)).size > 1) return { ambiguous: true };
    return matched[0] ? { hit: matched[0] } : {};
  };

  // ── implements_endpoint: handler → operation ──────────────────────────────
  const edges: CallEdge[] = [];
  const seenEdges = new Set<string>();
  const matchedOperations = new Set<string>();
  const unmatchedRoutes: UnmatchedRoute[] = [];
  const unresolvedBindings: UnresolvedBinding[] = [];
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
    matchedOperations.add(op.node.id);
    const handler = input.resolveHandler(route);
    if (handler) pushEdge(handler, op.node, 'implements_endpoint', route.line);
    // The operation is declared and served; only the HANDLER could not be pinned to one node.
    else unresolvedBindings.push({ file: route.file, line: route.line, method, path: route.path, operation: op.node.name });
  }

  // ── consumes_endpoint: the function enclosing a client call → operation ───
  const unboundClientCalls: UnboundClientCall[] = [];
  const disclose = (call: HttpCall, reason: UnboundClientCall['reason']): void => {
    unboundClientCalls.push({ file: call.file, line: call.line, url: call.url, reason });
  };
  const calls = [...input.calls].sort((a, b) =>
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
  for (const call of calls) {
    const method = call.method.toUpperCase();
    if (!CONCRETE_METHODS.has(method)) { disclose(call, 'method-not-literal'); continue; }
    if (!isLiteralCallUrl(call.url)) { disclose(call, 'path-not-literal'); continue; }
    const exact = operationFor(method, call.url);
    const filled = exact ? undefined : operationFilledBy(method, call.url);
    const op = exact ?? filled?.hit;
    if (!op) {
      // An address that names several operations is ambiguous, not undeclared.
      const key = `${method} ${normalizeUrl(call.url)}`;
      disclose(call, filled?.ambiguous || ambiguous.has(key) ? 'ambiguous-operation' : 'no-operation');
      continue;
    }
    // A call written to an absolute URL is a call to THAT host. Binding it to a specification
    // whose own servers name a different host would assert a call this repository does not make.
    const host = literalHost(call.url);
    if (host && op.doc.serverHosts.length && !op.doc.serverHosts.includes(host)) {
      disclose(call, 'foreign-host');
      continue;
    }
    matchedOperations.add(op.node.id);
    const caller = input.resolveCaller(call);
    if (caller) pushEdge(caller, op.node, 'consumes_endpoint', call.line);
    // The operation is declared and called; only the CALLER could not be pinned to one node.
    else unresolvedBindings.push({ file: call.file, line: call.line, method, path: call.url, operation: op.node.name });
  }

  // An operation is "unmatched" only when every input that could have matched it was assessed. A
  // route extraction that threw, a degraded file, an unread specification, or an operation past
  // the cap withholds the conclusion instead of asserting a false absence.
  const withheld = notAssessed.size > 0;
  const unmatchedOperations = nodes
    .filter(n => !matchedOperations.has(n.id))
    .map(n => `${n.name} (${n.filePath}:${n.startLine})`)
    .sort();
  return finish({
    nodes,
    edges,
    unmatchedOperations: withheld ? none() : bound(unmatchedOperations),
    unmatchedRoutes: withheld ? none() : bound(unmatchedRoutes),
    unresolvedBindings: bound(unresolvedBindings),
    unreadSpecifications: bound(unreadSpecifications),
    unboundClientCalls: bound(unboundClientCalls),
    ambiguousAddresses: bound([...ambiguous.values()].sort((a, b) => (a.address < b.address ? -1 : 1))),
  });
}
