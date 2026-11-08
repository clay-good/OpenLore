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
import { isProtobufPath } from './protobuf.js';
import { projectProtobuf, MAX_PROTO_FILES, type UnresolvedRegistration } from './project-protobuf.js';
import { isGraphqlPath } from './graphql.js';
import { schemaProvenance, SCHEMA_PROVENANCE_HEAD_BYTES, type SchemaProvenance } from './types.js';
import { projectGraphql, MAX_GRAPHQL_CANDIDATES, type UnresolvedResolver } from './project-graphql.js';
import type { ResolverMap } from './graphql-resolvers.js';
import type { GrpcRegistration, ImportTarget } from './grpc-registration.js';

/** Specification files read per build. */
export const MAX_CONTRACT_FILES = 50;
/** Operation nodes projected per build. */
export const MAX_CONTRACT_OPERATIONS = 2000;
/** Named-schema nodes projected across all documents in one build. */
const MAX_CONTRACT_SCHEMAS = 2_000;
/** Items listed per disclosure (every list carries its exact total beside it). */
export const MAX_DISCLOSED = 20;

const CONCRETE_METHODS: ReadonlySet<string> = new Set(HTTP_METHODS.map(m => m.toUpperCase()));

/** The edge kinds this projection produces — neither is a call, and neither ranks code. */
export const CONTRACT_EDGE_KINDS = ['implements_endpoint', 'consumes_endpoint', 'references_schema'] as const;

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
 * `synthesizedBy` on an edge bound by `operationId` rather than by a literal path.
 *
 * Such an edge has no literal call site by construction, so a consumer that re-scans for one
 * must read its absence as expected, not as a stale index.
 */
export const GENERATED_CLIENT_BINDING = 'operationId';

/** An `operationId` a generated-client module declared but that could not be bound. */
export interface GeneratedClientBinding {
  operation: string;
  operationId: string;
  spec: string;
  reason: 'duplicate-operation-id' | 'ambiguous-function';
  /** For `ambiguous-function`: the modules holding the same-named functions. */
  files?: string[];
}

/**
 * What the projection could not bind, carried on the build result so a consumer can say
 * "unmatched" rather than imply absence. No node, no edge — disclosure only.
 */
/** One candidate schema's provenance, as disclosed by the projection. */
export interface SchemaProvenanceFact extends SchemaProvenance {
  /** Path relative to the analyzed root. */
  file: string;
}

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
  /** `operationId`s a generated-client module declared that could not be bound. */
  unresolvedGeneratedBindings: Disclosed<GeneratedClientBinding>;
  /** gRPC server registrations that name a service but could not be bound to its RPCs. */
  unresolvedRegistrations: Disclosed<UnresolvedRegistration>;
  /**
   * Files that looked like a specification but are not one — a YAML or JSON file with an
   * `openapi` or `swagger` key that is not at the top level — each with why. Listed so the
   * discovery scope is visible: a file the reader passed over is never silently absent.
   */
  skippedCandidates: Disclosed<UnreadSpecification>;
  /**
   * Candidate schemas that look GENERATED or VENDORED — a codegen output under `__generated__/`,
   * a `# @generated`-headed SDL, a copy under `vendor/` — each with the rule that said so
   * (change: disclose-schema-provenance).
   *
   * An ANNOTATION, never a drop: the schema is projected and graded exactly as before. A
   * `path-pattern` verdict is a guess at the weaker certainty and is never reported as `declared`.
   */
  schemaProvenance?: Disclosed<SchemaProvenanceFact>;
  /**
   * RPCs no scanned registration binds. Registrations are read in Go, Python, and Node (grpc-js)
   * only, so an RPC served from another language is listed here too: this is "not bound", never
   * "not implemented".
   */
  unboundRpcs: Disclosed<string>;
  /** GraphQL resolver-map entries that name an operation but could not be bound to it. */
  unresolvedResolvers: Disclosed<UnresolvedResolver>;
  /**
   * GraphQL operations (root fields) no resolver map binds. Maps are read in JS/TS and Python
   * (Ariadne) only, and code-first servers have none, so this is "not bound", never "not served".
   */
  unboundGraphqlOperations: Disclosed<string>;
  /**
   * Set when a conclusion is WITHHELD because an input was not assessed — the route extraction
   * failed or degraded, a specification could not be read, or the operation cap stopped the
   * index. Then `unmatchedOperations` and `unmatchedRoutes` are empty because they cannot be
   * computed, NOT because nothing is unmatched.
   */
  notAssessed?: string[];
  /**
   * What was said after the fact and withholds nothing: references that drew no edge, elements
   * outside the model. Kept out of `notAssessed`, which consumers read as "a binding may be
   * missing" — an unresolved `google.protobuf.Timestamp` leaves every handler bound.
   */
  notes?: string[];
  /** Every cap the projection stopped at (both can fire in one build). */
  truncations?: Array<{ reason: 'file-cap' | 'proto-file-cap' | 'graphql-file-cap' | 'operation-cap' | 'schema-cap'; cap: number; seen: number }>;
}

export interface ProjectedContracts extends ContractDisclosure {
  nodes: FunctionNode[];
  edges: CallEdge[];
}

const bound = <T>(items: T[], total = items.length): Disclosed<T> => ({ items: items.slice(0, MAX_DISCLOSED), total });
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
    unresolvedGeneratedBindings: none(), unresolvedRegistrations: none(), unboundRpcs: none(),
    unresolvedResolvers: none(), unboundGraphqlOperations: none(),
    skippedCandidates: none(),
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
    unresolvedGeneratedBindings: p.unresolvedGeneratedBindings,
    unresolvedRegistrations: p.unresolvedRegistrations,
    unboundRpcs: p.unboundRpcs,
    unresolvedResolvers: p.unresolvedResolvers,
    unboundGraphqlOperations: p.unboundGraphqlOperations,
    skippedCandidates: p.skippedCandidates,
    ...(p.schemaProvenance ? { schemaProvenance: p.schemaProvenance } : {}),
    ...(p.notAssessed ? { notAssessed: p.notAssessed } : {}),
    ...(p.notes ? { notes: p.notes } : {}),
    ...(p.truncations ? { truncations: p.truncations } : {}),
  };
  const lists: Array<Disclosed<unknown>> = [
    rest.unmatchedOperations, rest.unmatchedRoutes, rest.unresolvedBindings,
    rest.unreadSpecifications, rest.unboundClientCalls, rest.ambiguousAddresses,
    rest.unresolvedGeneratedBindings, rest.unresolvedRegistrations, rest.unboundRpcs, rest.skippedCandidates,
    rest.unresolvedResolvers, rest.unboundGraphqlOperations,
    ...(rest.schemaProvenance ? [rest.schemaProvenance] : []),
  ];
  const silent = lists.every(l => l.total === 0) && !rest.notAssessed && !rest.notes && !rest.truncations;
  return silent ? undefined : rest;
}

export interface ContractProjectionInput {
  /** Candidate specification files, path + content. */
  files: readonly { path: string; content: string }[];
  /** Candidates the caller did not read, so the cap it hit is disclosed rather than invisible. */
  filesOmitted?: number;
  /** `.proto` files the caller did not retain: they withhold protobuf conclusions only. */
  protoFilesOmitted?: number;
  /** GraphQL schema files the caller did not retain: they withhold GraphQL conclusions only. */
  graphqlFilesOmitted?: number;
  /** Schema files the caller deliberately did not pass (fixtures, a Relay copy), each with why. */
  skippedFiles?: ReadonlyArray<{ file: string; reason: string }>;
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
  /**
   * The functions of each module whose header names this specification as its source, indexed by
   * function name (change: add-contract-graph-projection).
   *
   * A generated client builds its URL from a base variable —
   * `fetch(\`${BASE}/orders/${id}\`)` — so the HTTP projection sees no literal path and binds
   * nothing: the operation it calls reads as consumed by no one. Its method name, however, IS the
   * `operationId`, which is an exact identifier rather than a guess.
   *
   * Supplied by the caller because the projector holds specifications, not source: the header
   * scan needs file content the builder already has.
   */
  generatedClientFunctions?: (specPath: string) => ReadonlyMap<string, readonly FunctionNode[]>;
  /** gRPC server registrations in the indexed source, for binding protobuf RPCs to their implementation. */
  grpcRegistrations?: readonly GrpcRegistration[];
  /** Where an import names a function, one barrel re-export followed (gRPC Node, GraphQL). */
  importTargets?: (fromFile: string, specifier: string, name: string, runtime: 'node' | 'python') => readonly ImportTarget[];
  /** The resolver maps in the indexed source for the given root type names (GraphQL). */
  graphqlResolverMaps?: (roots: readonly string[]) => readonly ResolverMap[];
  /** The code functions of a name a resolver entry could mean. */
  resolveGraphqlImplementation?: (map: ResolverMap, name: string) => readonly FunctionNode[];
  /** The code functions a registration could mean by a name (see `ProtobufProjectionInput`). */
  resolveGrpcImplementation?: (reg: GrpcRegistration, name: string) => readonly FunctionNode[];
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
  const notes = new Set<string>();
  const truncations: NonNullable<ContractDisclosure['truncations']> = [];
  const omitted = input.filesOmitted ?? 0;

  // ── Protobuf (change: add-contract-graph-projection) ─────────────────────
  //
  // Projected on its own — an RPC has no method or path, so nothing below applies to it — and
  // merged into every result this function returns. Its own file cap: protobuf schemas come as
  // many small files, so a shared cap of 50 would leave most of a typical repository unread.
  const protoCandidates = [...input.files].filter(f => isProtobufPath(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const protoRead = protoCandidates.slice(0, MAX_PROTO_FILES);
  const proto = protoRead.length
    ? projectProtobuf({
      files: protoRead,
      registrations: input.grpcRegistrations ?? [],
      resolveImplementation: input.resolveGrpcImplementation ?? (() => []),
      ...(input.importTargets ? { importTargets: (from: string, spec: string, name: string) => input.importTargets!(from, spec, name, 'node') } : {}),
    })
    : undefined;
  // ── GraphQL (change: add-contract-graph-projection) ──────────────────────
  // Its own half too, merged in `finish`: a GraphQL operation has no method or path.
  const gqlCandidates = [...input.files].filter(f => isGraphqlPath(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const gqlRead = gqlCandidates.slice(0, MAX_GRAPHQL_CANDIDATES);
  const gql = gqlRead.length
    ? projectGraphql({
      files: gqlRead,
      resolverMaps: input.graphqlResolverMaps ?? (() => []),
      resolveImplementation: input.resolveGraphqlImplementation ?? (() => []),
      ...(input.importTargets ? { importTargets: input.importTargets } : {}),
    })
    : undefined;
  const gqlNotAssessed = [...(gql?.notAssessed ?? [])];
  const gqlUnread = gqlCandidates.length - gqlRead.length + (input.graphqlFilesOmitted ?? 0);
  if (gqlUnread > 0) gqlNotAssessed.push(`${gqlUnread} GraphQL file(s) past the file cap were not read`);

  /** Why a protobuf conclusion is withheld. Kept apart: an unread `.proto` declares no HTTP operation. */
  const protoNotAssessed = [...(proto?.notAssessed ?? [])];
  const protoUnread = protoCandidates.length - protoRead.length + (input.protoFilesOmitted ?? 0);
  if (protoUnread > 0) protoNotAssessed.push(`${protoUnread} protobuf file(s) past the file cap were not read`);

  const finish = (p: ProjectedContracts): ProjectedContracts => {
    // Merged here, after the OpenAPI conclusions were drawn, so neither side withholds the other's.
    const protoWithheld = protoNotAssessed.length > 0;
    for (const reason of protoNotAssessed) notAssessed.add(reason);
    if (protoUnread > 0) truncations.push({ reason: 'proto-file-cap', cap: MAX_PROTO_FILES, seen: protoCandidates.length + (input.protoFilesOmitted ?? 0) });
    for (const t of proto?.truncations ?? []) truncations.push(t);
    if (proto?.outsideModel.length) notes.add(`protobuf elements outside the model were not read: ${proto.outsideModel.join(', ')}`);
    if (proto?.unresolvedTypes) {
      // Said after the fact, like an unresolved `$ref`: it draws no edge, and withholds nothing.
      notes.add(`${proto.unresolvedTypes} protobuf type reference(s) resolve to no type projected from the files read (an import from outside this repository such as \`google.protobuf.*\`, a name declared in two files, or a type past the cap), so no edge was drawn for them`);
    }
    const gqlWithheld = gqlNotAssessed.length > 0;
    for (const reason of gqlNotAssessed) notAssessed.add(reason);
    if (gqlUnread > 0) truncations.push({ reason: 'graphql-file-cap', cap: MAX_GRAPHQL_CANDIDATES, seen: gqlCandidates.length + (input.graphqlFilesOmitted ?? 0) });
    for (const t of gql?.truncations ?? []) truncations.push(t);
    for (const n of gql?.notes ?? []) notes.add(n);
    const unread = [...p.unreadSpecifications.items, ...(proto?.unreadSpecifications ?? []), ...(gql?.unreadSpecifications ?? [])];
    const unreadTotal = p.unreadSpecifications.total + (proto?.unreadSpecifications.length ?? 0) + (gql?.unreadSpecifications.length ?? 0);
    // A GraphQL client document (operations and fragments) is a file that looked like a schema
    // and is not one: it belongs with the other skipped candidates, with why.
    const clientDocs = [
      ...(gql?.clientDocuments ?? []).map(file => ({ file, reason: 'a GraphQL client document (operations and fragments), not a schema' })),
      ...(input.skippedFiles ?? []),
    ];
    // Every candidate that is a SCHEMA by its own format test — not every file the caller passed:
    // `input.files` also holds YAML/JSON that only mentions an `openapi` key somewhere, and naming
    // a lockfile "a generated schema" would be a claim about a file no reader read. A generated or
    // vendored copy is named here and projected all the same. The head is BOUNDED — a 10 MB SDL is
    // never scanned whole.
    const provenance: SchemaProvenanceFact[] = [];
    for (const f of input.files) {
      // Provenance first: it is cheap (a path test and a bounded head) and rare, so the format
      // test that follows — a YAML/JSON parse for the OpenAPI case — runs only for the few files
      // that have provenance at all, never for every candidate.
      const v = schemaProvenance(f.path, f.content.slice(0, SCHEMA_PROVENANCE_HEAD_BYTES));
      if (!v) continue;
      const isSchema = isProtobufPath(f.path) || isGraphqlPath(f.path)
        || (looksLikeOpenApi(f.content) && !!readOpenApi(f.path, f.content));
      if (isSchema) provenance.push({ file: f.path, ...v });
    }
    return {
      ...p,
      nodes: [...p.nodes, ...(proto?.nodes ?? []), ...(gql?.nodes ?? [])],
      edges: [...p.edges, ...(proto?.edges ?? []), ...(gql?.edges ?? [])],
      unreadSpecifications: unreadTotal !== p.unreadSpecifications.total ? bound(unread, unreadTotal) : p.unreadSpecifications,
      skippedCandidates: clientDocs.length
        ? bound([...p.skippedCandidates.items, ...clientDocs], p.skippedCandidates.total + clientDocs.length)
        : p.skippedCandidates,
      unresolvedRegistrations: bound(proto?.unresolvedRegistrations ?? []),
      unboundRpcs: proto && !protoWithheld ? bound(proto.unboundRpcs) : none(),
      unresolvedResolvers: bound(gql?.unresolvedResolvers ?? []),
      unboundGraphqlOperations: gql && !gqlWithheld ? bound(gql.unboundOperations) : none(),
      ...(provenance.length ? { schemaProvenance: bound(provenance) } : {}),
      ...(notAssessed.size ? { notAssessed: [...notAssessed].sort() } : {}),
      ...(notes.size ? { notes: [...notes].sort() } : {}),
      ...(truncations.length ? { truncations } : {}),
    };
  };

  const candidates = [...input.files]
    .filter(f => !isProtobufPath(f.path) && !isGraphqlPath(f.path) && looksLikeOpenApi(f.content))
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
  const skippedCandidates: UnreadSpecification[] = [];
  for (const f of read) {
    const doc = readOpenApi(f.path, f.content);
    if (!doc) { skippedCandidates.push({ file: f.path, reason: 'an `openapi` or `swagger` key, but not at the top level: not a specification' }); continue; }
    if ('error' in doc) { unreadSpecifications.push({ file: f.path, reason: doc.error }); continue; }
    docs.push(doc);
  }
  // A specification that could not be read may declare the very operation a route serves, so no
  // "nothing declares this route" conclusion can be drawn while one is unread.
  if (unreadSpecifications.length) {
    notAssessed.add(`${unreadSpecifications.length} specification(s) could not be read`);
  }
  if (!docs.length) {
    return finish({ ...empty(), unreadSpecifications: bound(unreadSpecifications), skippedCandidates: bound(skippedCandidates) });
  }

  // ── Operation nodes ───────────────────────────────────────────────────────
  const nodes: FunctionNode[] = [];
  /** Normalized `METHOD /full/path` → the operations at it. */
  const byFullPath = new Map<string, Indexed[]>();
  /** Normalized `METHOD /declared/path` → the operations at it. */
  const byDeclaredPath = new Map<string, Indexed[]>();
  /** `<spec>\0<operationId>` → its operation node, for the generated-client binding. */
  const byOperationId = new Map<string, FunctionNode>();
  /** Every operation node by its own id — the only key that is unique per operation. */
  const operationNodeById = new Map<string, FunctionNode>();
  /** Keys whose document declared the same `operationId` twice: nothing binds to either. */
  const duplicateOperationIds = new Set<string>();
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
      operationNodeById.set(node.id, node);
      if (op.operationId) {
        const key = `${doc.file}\0${op.operationId}`;
        // An `operationId` is required to be unique within a document; a document that repeats
        // one is malformed, and binding either operation would be a guess.
        if (byOperationId.has(key)) duplicateOperationIds.add(key);
        else byOperationId.set(key, node);
      }
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
  // ── Named-schema nodes and `$ref` edges (change: add-contract-schema-elements) ────────────
  //
  // A named schema is a reusable TYPE: one shared by twenty operations is one node with twenty
  // inbound edges, which is what makes "what does changing `Order` touch?" answerable. Per-FIELD
  // nodes are deliberately not projected — a large document has thousands of fields, and the
  // question they would answer is already covered by the certification's property-level verdict.
  //
  // Nodes carry `language: 'OpenAPI'`, so every exclusion that keeps a declaration out of the
  // code rankings already covers them, and `references_schema` is a declaration edge kind, so it
  // changes no function's degree.
  const schemaNodeByRef = new Map<string, FunctionNode>();
  let schemasSeen = 0;
  for (const doc of docs) {
    // What the DOCUMENT declared, not what the reader handed over: the reader has a cap of its
    // own, so counting the list it returned under-states every drop past that cap.
    schemasSeen += Math.max(doc.schemasDeclared, doc.schemas.length);
    for (const schema of doc.schemas) {
      if (schemaNodeByRef.size >= MAX_CONTRACT_SCHEMAS) continue;
      const id = nodeId(doc.file, schema.ref);
      // One node per ref per document. Two documents declaring the same ref are distinct
      // declarations, so the id carries the file, exactly as operation nodes do.
      if (schemaNodeByRef.has(id)) continue;
      const node: FunctionNode = {
        id,
        name: schema.ref,
        filePath: doc.file,
        isAsync: false,
        language: 'OpenAPI',
        startIndex: 0,
        endIndex: 0,
        fanIn: 0,
        fanOut: 0,
        signature: schema.name,
        startLine: schema.line,
        endLine: schema.line,
      };
      schemaNodeByRef.set(id, node);
      nodes.push(node);
    }
  }
  if (schemasSeen > schemaNodeByRef.size) {
    truncations.push({ reason: 'schema-cap', cap: MAX_CONTRACT_SCHEMAS, seen: schemasSeen });
    notAssessed.add(`${schemasSeen - schemaNodeByRef.size} named schema(s) past the cap were not projected`);
  }

  const pushEdge = (
    from: FunctionNode,
    to: FunctionNode,
    kind: 'implements_endpoint' | 'consumes_endpoint' | 'references_schema',
    line?: number,
    /**
     * How the binding was established, when it was not a literal path match. An `operationId`
     * binding has no literal call site BY CONSTRUCTION — that is the point of it — so a reader
     * that re-scans for one and finds nothing must be able to tell this apart from a stale index.
     */
    synthesizedBy?: string,
  ): void => {
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
      ...(synthesizedBy ? { synthesizedBy } : {}),
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
  // ── consumes_endpoint by operationId: a generated client's own method name ────────────────
  //
  // Runs after path matching and only ADDS edges; `pushEdge` dedupes, so an operation already
  // bound by a literal path is not bound twice. Nothing here is a guess: the module's header
  // names the specification, and the method name equals an `operationId` exactly.
  const generatedBindings: GeneratedClientBinding[] = [];
  if (input.generatedClientFunctions) {
    for (const doc of docs) {
      let byName: ReadonlyMap<string, readonly FunctionNode[]>;
      try {
        byName = input.generatedClientFunctions(doc.file);
      } catch {
        notAssessed.add(`the generated-client lookup failed for ${doc.file}, so its operationId bindings were not assessed`);
        continue;
      }
      if (!byName.size) continue;
      for (const op of doc.operations) {
        if (!op.operationId) continue;
        const key = `${doc.file}\0${op.operationId}`;
        const fns = byName.get(op.operationId);
        // Nothing of that name here: not a binding that failed, so nothing to disclose. The
        // duplicate check follows, so a document repeating an `operationId` no module even
        // mentions does not emit noise into a disclosure whose purpose is signal.
        if (!fns?.length) continue;
        if (duplicateOperationIds.has(key)) {
          generatedBindings.push({ operation: op.address, operationId: op.operationId, spec: doc.file, reason: 'duplicate-operation-id' });
          continue;
        }
        const target = byOperationId.get(key);
        if (!target) continue; // past the operation cap
        if (fns.length > 1) {
          // Two functions of that name in the module: binding either would be arbitrary.
          generatedBindings.push({
            operation: op.address, operationId: op.operationId, spec: doc.file,
            reason: 'ambiguous-function', files: [...new Set(fns.map(f => f.filePath))].sort().slice(0, 4),
          });
          continue;
        }
        pushEdge(fns[0], target, 'consumes_endpoint', fns[0].startLine, GENERATED_CLIENT_BINDING);
        matchedOperations.add(target.id);
      }
    }
  }

  const withheld = notAssessed.size > 0;
  // Operations only: `nodes` holds the named-schema nodes too, and a schema is not served or
  // called, so listing one here read as "declared but nothing serves it".
  const unmatchedOperations = nodes
    .filter(n => operationNodeById.has(n.id) && !matchedOperations.has(n.id))
    .map(n => `${n.name} (${n.filePath}:${n.startLine})`)
    .sort();
  // Edges: operation → the schemas it names, and schema → the schemas its own definition names.
  // A ref naming nothing the document declares is disclosed rather than dropped: it is usually
  // an external `$ref` the reader already refuses to follow.
  const unresolvedRefs = new Set<string>();
  const linkRefs = (from: FunctionNode, docFile: string, refs: readonly string[]): void => {
    for (const ref of refs) {
      const target = schemaNodeByRef.get(nodeId(docFile, ref));
      if (!target) { unresolvedRefs.add(`${docFile}: ${ref}`); continue; }
      pushEdge(from, target, 'references_schema', from.startLine);
    }
  };
  for (const doc of docs) {
    for (const op of doc.operations) {
      // By ADDRESS, never by `operationId`: a document that repeats an `operationId` is
      // malformed, and keying on it hands the second operation's schema edges to the first —
      // the graph then states that an operation references a type it never names. The address
      // is unique per operation by construction.
      const from = operationNodeById.get(nodeId(doc.file, op.address));
      if (from) linkRefs(from, doc.file, op.refs);
    }
    for (const schema of doc.schemas) {
      const from = schemaNodeByRef.get(nodeId(doc.file, schema.ref));
      if (from) linkRefs(from, doc.file, schema.refs);
    }
  }
  if (unresolvedRefs.size) {
    notes.add(`${unresolvedRefs.size} \`$ref\`(s) name a schema that was not projected — undeclared by this document, or past the schema cap — so no edge was drawn for them`);
  }

  return finish({
    nodes,
    edges,
    unresolvedGeneratedBindings: bound(generatedBindings),
    // Set by `finish` from the protobuf half.
    unresolvedRegistrations: none(), unboundRpcs: none(),
    unresolvedResolvers: none(), unboundGraphqlOperations: none(),
    skippedCandidates: bound(skippedCandidates),
    unmatchedOperations: withheld ? none() : bound(unmatchedOperations),
    unmatchedRoutes: withheld ? none() : bound(unmatchedRoutes),
    unresolvedBindings: bound(unresolvedBindings),
    unreadSpecifications: bound(unreadSpecifications),
    unboundClientCalls: bound(unboundClientCalls),
    ambiguousAddresses: bound([...ambiguous.values()].sort((a, b) => (a.address < b.address ? -1 : 1))),
  });
}
