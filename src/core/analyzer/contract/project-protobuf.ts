/**
 * Projection: protobuf services and types → the existing graph primitives
 * (change: add-contract-graph-projection, protobuf phase).
 *
 * The protobuf half of `projectContracts`, kept apart because nothing in it is HTTP: an RPC has no
 * method or path to match, and its server is wired up by a registration call instead of a route.
 *
 *   RPC node              `/pkg.Service/Method` — the gRPC method path, unique per RPC
 *   message / enum node   `pkg.Order` — the full name, package included
 *   `references_schema`   RPC → its request and response types; message → its fields' types
 *   `implements_endpoint` the method a registered implementation defines → the RPC it serves
 *
 * Every rule refuses rather than guesses, as the OpenAPI half does: a service name two packages
 * declare binds nothing, a registered type with two same-named methods binds nothing, and a type
 * name protobuf's own scoping does not resolve draws no edge. All of it is disclosed.
 */

import type { CallEdge, FunctionNode } from '../call-graph-types.js';
import { readProtobuf, resolveProtoTypes, type ProtoDocument, type ProtoRpc, type ProtoService } from './protobuf.js';
import type { GrpcRegistration } from './grpc-registration.js';

/** `.proto` files read per build. Kept apart from the OpenAPI cap: protobuf schemas come in many small files. */
export const MAX_PROTO_FILES = 500;
/** RPC nodes projected per build. */
const MAX_PROTO_RPCS = 2_000;
/** Message and enum nodes projected per build. */
const MAX_PROTO_TYPES = 4_000;

/** `synthesizedBy` on an edge bound through a gRPC server registration rather than a call site. */
export const GRPC_REGISTRATION_BINDING = 'grpc-registration';

/** A registration that names a service, but whose implementation could not be bound. */
export interface UnresolvedRegistration {
  file: string;
  line: number;
  service: string;
  /** The RPC, when the failure is about one method rather than the whole registration. */
  rpc?: string;
  reason: 'not-literal' | 'unknown-service' | 'ambiguous-service' | 'ambiguous-implementation' | 'inline-implementation';
  detail?: string;
}

export interface ProtobufProjectionInput {
  files: readonly { path: string; content: string }[];
  registrations: readonly GrpcRegistration[];
  /**
   * The code functions a registration could mean by `name`: for Go and Python, the methods of
   * `reg.implType`; for Node, the functions of that name. The projector picks among them.
   */
  resolveImplementation: (reg: GrpcRegistration, name: string) => readonly FunctionNode[];
}

export interface ProtobufProjection {
  nodes: FunctionNode[];
  edges: CallEdge[];
  unreadSpecifications: Array<{ file: string; reason: string }>;
  unresolvedRegistrations: UnresolvedRegistration[];
  /** RPCs no scanned registration bound, as `address (file:line)`. */
  unboundRpcs: string[];
  /** Reasons a conclusion is withheld (unread files, caps). */
  notAssessed: string[];
  /** Element classes outside the model (`extend`, `extensions`). Disclosed; never withholds a conclusion. */
  outsideModel: string[];
  /** Said after the fact: type references that drew no edge. Never withholds a conclusion. */
  unresolvedTypes: number;
  truncations: Array<{ reason: 'operation-cap' | 'schema-cap'; cap: number; seen: number }>;
}

const nodeId = (file: string, name: string) => `${file}::${name}`;
const dirOf = (f: string) => f.slice(0, f.lastIndexOf('/') + 1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const declarationNode = (file: string, name: string, line: number, signature: string): FunctionNode => ({
  id: nodeId(file, name), name, filePath: file, isAsync: false, language: 'Protobuf',
  startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0, signature, startLine: line, endLine: line,
});

const rpcSignature = (rpc: ProtoRpc) =>
  `rpc ${rpc.name}(${rpc.clientStreaming ? 'stream ' : ''}${rpc.request.written}) returns (${rpc.serverStreaming ? 'stream ' : ''}${rpc.response.written})`;

/**
 * The ONE implementation among `candidates`: the one in the registration's own file, else the
 * one in its directory (a Go package, a Python package), else the only one anywhere. Two at the
 * same level is an ambiguity, never a pick.
 */
function pick(reg: GrpcRegistration, candidates: readonly FunctionNode[]): FunctionNode | 'ambiguous' | undefined {
  if (!candidates.length) return undefined;
  for (const level of [(n: FunctionNode) => n.filePath === reg.file, (n: FunctionNode) => dirOf(n.filePath) === dirOf(reg.file), () => true]) {
    const at = candidates.filter(level);
    if (at.length === 1) return at[0];
    if (at.length > 1) return 'ambiguous';
  }
  return undefined;
}

export function projectProtobuf(input: ProtobufProjectionInput): ProtobufProjection {
  const out: ProtobufProjection = {
    nodes: [], edges: [], unreadSpecifications: [], unresolvedRegistrations: [], unboundRpcs: [],
    notAssessed: [], outsideModel: [], unresolvedTypes: 0, truncations: [],
  };
  const read: ProtoDocument[] = [];
  for (const f of [...input.files].sort(byPath)) {
    const doc = readProtobuf(f.path, f.content);
    if ('error' in doc) out.unreadSpecifications.push({ file: f.path, reason: doc.error });
    else read.push(doc);
  }
  if (out.unreadSpecifications.length) {
    // An unread file may declare the very service a registration names.
    out.notAssessed.push(`${out.unreadSpecifications.length} protobuf file(s) could not be read`);
  }
  const unassessed = [...new Set(read.flatMap(d => d.unassessed))].sort();
  // Named, but withholding nothing: `extend` and `extensions` declare options and extension
  // ranges, never an RPC, so they cannot hide the service a registration names.
  out.outsideModel = unassessed;
  if (!read.length) return out;
  const { docs, unresolved } = resolveProtoTypes(read);

  // ── Nodes ──
  const typeNodes = new Map<string, FunctionNode>(); // full name → node, only for names declared once
  const declaredIn = new Map<string, number>();
  for (const d of docs) for (const t of [...d.messages, ...d.enums]) declaredIn.set(t.name, (declaredIn.get(t.name) ?? 0) + 1);
  let typesSeen = 0;
  let typesKept = 0;
  for (const d of docs) {
    for (const t of [...d.messages, ...d.enums]) {
      typesSeen++;
      if (typesKept >= MAX_PROTO_TYPES) continue;
      typesKept++;
      const node = declarationNode(d.file, t.name, t.line, `${t.kind} ${t.simpleName}`);
      out.nodes.push(node);
      if (declaredIn.get(t.name) === 1) typeNodes.set(t.name, node);
    }
  }
  if (typesSeen > typesKept) {
    out.truncations.push({ reason: 'schema-cap', cap: MAX_PROTO_TYPES, seen: typesSeen });
    out.notAssessed.push(`${typesSeen - typesKept} protobuf message/enum type(s) past the cap were not projected`);
  }
  /** Full service name → the documents declaring it (more than one is ambiguous). */
  const servicesByName = new Map<string, Array<{ doc: ProtoDocument; service: ProtoService }>>();
  const rpcNodes = new Map<string, FunctionNode>(); // node id → node
  let rpcsSeen = 0;
  for (const d of docs) {
    for (const s of d.services) {
      servicesByName.set(s.name, [...(servicesByName.get(s.name) ?? []), { doc: d, service: s }]);
      for (const rpc of s.rpcs) {
        rpcsSeen++;
        if (rpcNodes.size >= MAX_PROTO_RPCS) continue;
        const node = declarationNode(d.file, rpc.address, rpc.line, rpcSignature(rpc));
        rpcNodes.set(node.id, node);
        out.nodes.push(node);
      }
    }
  }
  if (rpcsSeen > rpcNodes.size) {
    out.truncations.push({ reason: 'operation-cap', cap: MAX_PROTO_RPCS, seen: rpcsSeen });
    out.notAssessed.push(`${rpcsSeen - rpcNodes.size} RPC(s) past the cap were not projected`);
  }

  const seen = new Set<string>();
  const pushEdge = (from: FunctionNode, to: FunctionNode, kind: 'implements_endpoint' | 'references_schema', line: number, synthesizedBy?: string) => {
    const key = `${from.id}\0${to.id}\0${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.edges.push({ callerId: from.id, calleeId: to.id, calleeName: to.name, line, confidence: 'import', kind, ...(synthesizedBy ? { synthesizedBy } : {}) });
  };

  // ── references_schema: RPC → request/response, message → field types ──
  let unlinked = unresolved.length;
  const link = (from: FunctionNode | undefined, type: string | undefined, line: number) => {
    if (!from || !type) return;
    const to = typeNodes.get(type);
    if (to) pushEdge(from, to, 'references_schema', line); else unlinked++;
  };
  for (const d of docs) {
    for (const s of d.services) {
      for (const rpc of s.rpcs) {
        const from = rpcNodes.get(nodeId(d.file, rpc.address));
        link(from, rpc.requestType, rpc.line);
        link(from, rpc.responseType, rpc.line);
      }
    }
    for (const m of d.messages) {
      const from = declaredIn.get(m.name) === 1 ? typeNodes.get(m.name) : undefined;
      for (const f of m.fields) link(from, f.resolved, f.line);
    }
  }
  out.unresolvedTypes = unlinked;

  // ── implements_endpoint: from server registrations ──
  const bound = new Set<string>();
  const simpleIndex = new Map<string, string[]>();
  for (const name of servicesByName.keys()) {
    const simple = name.slice(name.lastIndexOf('.') + 1);
    simpleIndex.set(simple, [...(simpleIndex.get(simple) ?? []), name]);
  }
  /** The ONE full service name a registration's service expression names, or why not. */
  const serviceFor = (reg: GrpcRegistration): { name?: string; reason?: 'unknown-service' | 'ambiguous-service'; candidates?: string[] } => {
    if (reg.runtime === 'node') {
      // `proto.orders.v1.OrderService`: the longest dotted suffix that is a declared full name.
      const parts = reg.service.split('.');
      for (let i = 0; i < parts.length; i++) {
        const suffix = parts.slice(i).join('.');
        if (servicesByName.has(suffix)) return { name: suffix };
      }
      const simple = parts[parts.length - 1];
      const tries = [simple, ...(simple.endsWith('Service') && !simpleIndex.has(simple) ? [simple.slice(0, -'Service'.length)] : [])];
      for (const t of tries) {
        const at = simpleIndex.get(t);
        if (at?.length === 1) return { name: at[0] };
        if (at && at.length > 1) return { reason: 'ambiguous-service', candidates: at };
      }
      return { reason: 'unknown-service' };
    }
    const at = simpleIndex.get(reg.service);
    if (!at) return { reason: 'unknown-service' };
    if (at.length > 1) return { reason: 'ambiguous-service', candidates: at };
    return { name: at[0] };
  };
  const registrations = [...input.registrations].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line);
  for (const reg of registrations) {
    const svc = serviceFor(reg);
    if (!svc.name) {
      out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: reg.service, reason: svc.reason!, ...(svc.candidates ? { detail: svc.candidates.sort().join(', ') } : {}) });
      continue;
    }
    const decls = servicesByName.get(svc.name)!;
    if (decls.length > 1) {
      // Two files declaring one service: which file's RPCs it serves cannot be said.
      out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, reason: 'ambiguous-service', detail: decls.map(x => x.doc.file).sort().join(', ') });
      continue;
    }
    if (reg.notLiteral) {
      out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, reason: 'not-literal', detail: reg.notLiteral });
      continue;
    }
    const { doc, service } = decls[0];
    for (const rpc of service.rpcs) {
      const target = rpcNodes.get(nodeId(doc.file, rpc.address));
      if (!target) continue; // past the cap
      let fnName: string | undefined;
      if (reg.runtime === 'node') {
        const entry = reg.methods?.find(e => e.key === rpc.name) ?? reg.methods?.find(e => e.key === lowerFirst(rpc.name));
        if (!entry) continue; // not in the map: left unbound
        if (!entry.fn) {
          out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, rpc: rpc.name, reason: 'inline-implementation' });
          continue;
        }
        fnName = entry.fn;
      } else fnName = rpc.name;
      const impl = pick(reg, input.resolveImplementation(reg, fnName));
      if (impl === 'ambiguous') {
        out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, rpc: rpc.name, reason: 'ambiguous-implementation', detail: `more than one \`${fnName}\`${reg.implType ? ` on ${reg.implType}` : ''}` });
        continue;
      }
      if (!impl) continue; // not implemented here (a Go server embedding Unimplemented…): left unbound
      pushEdge(impl, target, 'implements_endpoint', impl.startLine ?? reg.line, GRPC_REGISTRATION_BINDING);
      bound.add(target.id);
    }
  }
  out.unboundRpcs = [...rpcNodes.values()].filter(n => !bound.has(n.id)).map(n => `${n.name} (${n.filePath}:${n.startLine})`).sort();
  return out;
}
