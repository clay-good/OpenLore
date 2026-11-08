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
import { isImportedModule, type GrpcRegistration, type ImportTarget } from './grpc-registration.js';

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
  /**
   * The function name the registration NAMED and this projection refused to bind, when it named
   * one literally. Carried so a consumer can say WHICH symbol was left unrooted — `find_dead_code`
   * reads it to keep an unbound handler out of its high-confidence verdicts. Absent when the
   * failure names no function (an inline implementation, a service expression that is not literal).
   */
  symbol?: string;
  /**
   * The implementation type the registration named (`reg.implType`), when it named one. For Go and
   * Python the registration names a class whose methods serve the RPCs, so the class — not one
   * function — is what was left unbound.
   */
  className?: string;
  reason: 'not-literal' | 'unknown-service' | 'ambiguous-service' | 'ambiguous-implementation' | 'inline-implementation' | 'implementation-not-found';
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
  /** Where an import names a function: its module, one level of re-export followed. */
  importTargets?: (fromFile: string, specifier: string, name: string) => readonly ImportTarget[];
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
/**
 * The method key grpc-js / proto-loader derives from an RPC name with lodash's `camelCase`:
 * `GetHTTPStatus` → `getHttpStatus`. An acronym is one word, so `lowerFirst` alone misses it.
 */
const lodashCamel = (s: string): string => {
  const words = s.match(/[A-Z]{2,}(?=[A-Z][a-z]+[0-9]*|\b|[0-9_])|[A-Z]?[a-z]+[0-9]*|[A-Z]+|[0-9]+/g) ?? [];
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
};
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const declarationNode = (file: string, name: string, line: number, signature: string): FunctionNode => ({
  id: nodeId(file, name), name, filePath: file, isAsync: false, language: 'Protobuf',
  startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0, signature, startLine: line, endLine: line,
});

const rpcSignature = (rpc: ProtoRpc) =>
  `rpc ${rpc.name}(${rpc.clientStreaming ? 'stream ' : ''}${rpc.request.written}) returns (${rpc.serverStreaming ? 'stream ' : ''}${rpc.response.written})`;

/** A module's name as Python imports it: `svc/servicer.py` and `svc/servicer/__init__.py` are `servicer`. */
const moduleName = (f: string) => {
  const base = f.slice(f.lastIndexOf('/') + 1).replace(/\.pyw?$/i, '');
  return base === '__init__' ? (dirOf(f).replace(/\/$/, '').split('/').pop() ?? '') : base;
};
/** The last segment of a file's directory: a Go package's conventional name. */
const dirName = (f: string) => dirOf(f).replace(/\/$/, '').split('/').pop() ?? '';

/**
 * The ONE implementation among `candidates`, where the registration's own scope says it may be.
 * Two in the same place is an ambiguity, never a pick; a candidate outside that place is never
 * taken just because it is the only one.
 *
 *   Go, bare `T`        the registration's own package (its directory) — nowhere else
 *   Go, `pkg.T`         another package whose directory is named `pkg` (an import alias that
 *                       differs from the directory binds nothing)
 *   Python, bare `C`    the registration's own file, else the only one anywhere (an import)
 *   Python, `mod.C`     a module named `mod`
 *   Node                the registration's own file; an IMPORTED handler only in the module it
 *                       was imported from (one barrel re-export followed)
 *   Node, `new C()`     the registration's own file, or — when `C` is imported — only the module
 *                       `implFrom` names; narrowed by the caller, then passed through here
 */
function inScope(reg: GrpcRegistration, candidates: readonly FunctionNode[], imported = false): readonly FunctionNode[] {
  if (reg.runtime === 'go') {
    if (reg.implQualifier === undefined) return candidates.filter(n => dirOf(n.filePath) === dirOf(reg.file));
    return candidates.filter(n => dirOf(n.filePath) !== dirOf(reg.file) && dirName(n.filePath) === reg.implQualifier);
  }
  if (reg.runtime === 'python' && reg.implQualifier !== undefined) {
    return candidates.filter(n => moduleName(n.filePath) === reg.implQualifier);
  }
  // Node: an imported handler's candidates are already narrowed to its module; a local one is
  // looked for in this file only.
  if (reg.runtime === 'node') return imported ? candidates : candidates.filter(n => n.filePath === reg.file);
  const local = candidates.filter(n => n.filePath === reg.file);
  return local.length ? local : candidates;
}

function pick(reg: GrpcRegistration, candidates: readonly FunctionNode[], imported = false): FunctionNode | 'ambiguous' | undefined {
  const at = inScope(reg, candidates, imported);
  return at.length === 1 ? at[0] : at.length > 1 ? 'ambiguous' : undefined;
}

/**
 * Where a Go or Python registration's type lives — a package directory (Go) or a file (Python)
 * — settled ONCE for the whole registration. Choosing per RPC let one registration bind `Charge`
 * nowhere (two candidates) and `Refund` to whichever package alone defines it: a type the
 * registration never named.
 */
const homeOf = (reg: GrpcRegistration, n: FunctionNode) => (reg.runtime === 'go' ? dirOf(n.filePath) : n.filePath);

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
      // A path naming a package (`proto.billing.v2.PaymentService`) that matched no declared full
      // name is another service, not a looser match: only a one- or two-part path (`Svc`,
      // `services.SvcService`) falls back to the simple name.
      if (parts.length > 2) return { reason: 'unknown-service' };
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
    // A Node call naming a service object rather than a `.service` descriptor is a gRPC
    // registration only if that service is declared: `addService` is a common method name.
    if (!svc.name && reg.descriptor === false && svc.reason === 'unknown-service') continue;
    if (!svc.name) {
      // An unread `.proto` may be the one declaring it (an editions file, a syntax error): say so,
      // rather than imply the schema lives in another repository.
      const detail = svc.candidates ? svc.candidates.sort().join(', ')
        : out.unreadSpecifications.length ? `${out.unreadSpecifications.length} .proto file(s) here could not be read and may declare it` : undefined;
      out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: reg.service, ...(reg.implType ? { className: reg.implType } : {}), reason: svc.reason!, ...(detail ? { detail } : {}) });
      continue;
    }
    const decls = servicesByName.get(svc.name)!;
    if (decls.length > 1) {
      // Two files declaring one service: which file's RPCs it serves cannot be said.
      out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, ...(reg.implType ? { className: reg.implType } : {}), reason: 'ambiguous-service', detail: decls.map(x => x.doc.file).sort().join(', ') });
      continue;
    }
    if (reg.notLiteral) {
      out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, ...(reg.implType ? { className: reg.implType } : {}), reason: 'not-literal', detail: reg.notLiteral });
      continue;
    }
    const { doc, service } = decls[0];
    // Linear in RPCs and map keys: one key map per registration, and each RPC's candidates
    // resolved once (a registration × RPCs × keys product made one hostile repository cost 68 s).
    const byKey = new Map((reg.methods ?? []).map(e => [e.key, e] as const));
    // A Node registration that instantiated a class (`new MyHandlers()`): no map names the
    // methods, so each RPC is looked for as a method of that class, under the same key ladder
    // grpc-js derives. Scoped to where the registration says the class is, and nowhere else.
    const nodeClass = reg.runtime === 'node' && reg.implType !== undefined && reg.methods === undefined;
    const classTargets = nodeClass && reg.implFrom !== undefined && input.importTargets
      ? new Set(input.importTargets(reg.file, reg.implFrom, reg.implType!).map(t => t.file))
      : undefined;
    /** Whether a candidate method sits where the instantiated class may be. */
    const classScoped = (n: FunctionNode): boolean =>
      reg.implFrom === undefined ? n.filePath === reg.file
        : classTargets ? classTargets.has(n.filePath)
          : isImportedModule(reg.file, reg.implFrom, n.filePath);
    const work: Array<{ rpc: ProtoRpc; target: FunctionNode; fnName?: string; imported: boolean; from?: string; inline: boolean; found: FunctionNode[] }> = [];
    for (const rpc of service.rpcs) {
      const target = rpcNodes.get(nodeId(doc.file, rpc.address));
      if (!target) continue; // past the cap
      if (reg.runtime !== 'node') { work.push({ rpc, target, fnName: rpc.name, imported: false, inline: false, found: [...input.resolveImplementation(reg, rpc.name)] }); continue; }
      if (nodeClass) {
        // The same ladder a literal map's keys are matched by, tried in order: the first name the
        // class defines is the method serving this RPC.
        for (const name of [...new Set([rpc.name, lowerFirst(rpc.name), lodashCamel(rpc.name)])]) {
          const found = input.resolveImplementation(reg, name).filter(classScoped);
          if (!found.length) continue;
          work.push({ rpc, target, fnName: name, imported: true, inline: false, found: [...found] });
          break;
        }
        continue;
      }
      const entry = byKey.get(rpc.name) ?? byKey.get(lowerFirst(rpc.name)) ?? byKey.get(lodashCamel(rpc.name));
      if (!entry) continue; // not in the map: left unbound
      if (entry.notFollowed) {
        out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, rpc: rpc.name, ...(entry.fn ? { symbol: entry.fn } : {}), reason: 'implementation-not-found', detail: entry.notFollowed });
        continue;
      }
      work.push({ rpc, target, ...(entry.fn ? { fnName: entry.fn } : {}), imported: entry.imported === true, ...(entry.from ? { from: entry.from } : {}), inline: !entry.fn,
        found: entry.fn ? [...input.resolveImplementation(reg, entry.fn)] : [] });
    }
    // Python: a class found in the registration's own file for any RPC is THE class, so an RPC it
    // does not implement is not looked for in a same-named class elsewhere (a servicer named like
    // the service took the rest from the generated client class).
    const homeIsLocal = reg.runtime === 'python' && reg.implQualifier === undefined && work.some(w => w.found.some(n => n.filePath === reg.file));
    if (nodeClass) {
      // One registration names ONE class, so its methods are in one file. Two files declaring a
      // class of that name where the registration says it is binds nothing, as for Go and Python.
      const homes = new Set(work.flatMap(w => w.found.map(n => n.filePath)));
      if (homes.size > 1) {
        out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, reason: 'ambiguous-implementation',
          detail: `\`${reg.implType}\` is defined in more than one place: ${[...homes].sort().slice(0, 4).join(', ')}` });
        continue;
      }
    }
    if (reg.runtime !== 'node') {
      const homes = new Set(work.flatMap(w => inScope(reg, homeIsLocal ? w.found.filter(n => n.filePath === reg.file) : w.found).map(n => homeOf(reg, n))));
      if (homes.size > 1) {
        out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, ...(reg.implType ? { className: reg.implType } : {}), reason: 'ambiguous-implementation',
          detail: `\`${reg.implQualifier ? `${reg.implQualifier}.` : ''}${reg.implType}\` is defined in more than one place: ${[...homes].sort().slice(0, 4).join(', ')}` });
        continue;
      }
      // One home: every RPC is looked for there and nowhere else.
      const [home] = homes;
      if (home !== undefined) for (const w of work) w.found = w.found.filter(n => homeOf(reg, n) === home);
    }
    let anyCandidate = false;
    for (const w of work) {
      const { rpc, target, fnName } = w;
      if (w.inline) {
        out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, rpc: rpc.name, reason: 'inline-implementation' });
        continue;
      }
      // An imported Node handler is looked for only in the module it was imported from (one barrel
      // re-export followed).
      const targets = reg.runtime === 'node' && !nodeClass && w.imported && w.from !== undefined && w.fnName !== undefined && input.importTargets
        ? input.importTargets(reg.file, w.from, w.fnName) : undefined;
      // A class instance's candidates were scoped to the class's own module already.
      const found = reg.runtime === 'node' && w.imported && !nodeClass
        ? (targets
          ? targets.flatMap(t => input.resolveImplementation(reg, t.name).filter(n => n.filePath === t.file))
          : w.found.filter(n => w.from !== undefined && isImportedModule(reg.file, w.from, n.filePath)))
        : w.found;
      const impl = pick(reg, homeIsLocal ? found.filter(n => n.filePath === reg.file) : found, w.imported);
      if (impl) anyCandidate = true;
      if (impl === 'ambiguous') {
        out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, rpc: rpc.name, ...(fnName ? { symbol: fnName } : {}), ...(reg.implType ? { className: reg.implType } : {}), reason: 'ambiguous-implementation', detail: `more than one \`${fnName}\`${reg.implType ? ` on ${reg.implType}` : ''}` });
        continue;
      }
      if (!impl) {
        // Node: each map entry names its own function, so one that binds nothing is said per RPC.
        // A class instance names no methods, so an RPC it does not implement is said once for the
        // whole registration below, as for Go and Python.
        if (reg.runtime === 'node' && !nodeClass) {
          out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, rpc: rpc.name, ...(fnName ? { symbol: fnName } : {}), reason: 'implementation-not-found',
            detail: !w.imported ? `\`${fnName}\` is neither defined in ${reg.file} nor imported by it`
              : targets?.length ? `\`${fnName}\` is imported from '${w.from}', which is indexed but neither defines nor directly re-exports it`
                : `\`${fnName}\` is imported by ${reg.file} from '${w.from}', which is not indexed here (a package, or a specifier no declared path alias resolves to one module)` });
        }
        continue; // Go/Python: not implemented here (a server embedding Unimplemented…): left unbound
      }
      pushEdge(impl, target, 'implements_endpoint', impl.startLine ?? reg.line, GRPC_REGISTRATION_BINDING);
      bound.add(target.id);
    }
    // Not one method of the registered type was found anywhere it may be — an import alias that
    // differs from the directory, an aliased Python import, methods all from an embedded or base
    // type. The implementation then reads as dead code, so the registration is named.
    if (!anyCandidate && (reg.runtime !== 'node' || nodeClass)) {
      const where = nodeClass
        ? reg.implFrom === undefined ? ` in ${reg.file}` : ` in the module '${reg.implFrom}' it is imported from`
        : ' where the registration says it is';
      out.unresolvedRegistrations.push({ file: reg.file, line: reg.line, service: svc.name, ...(reg.implType ? { className: reg.implType } : {}), reason: 'implementation-not-found',
        detail: `no method of \`${reg.implQualifier ? `${reg.implQualifier}.` : ''}${reg.implType}\` named after an RPC was found${where}` });
    }
  }
  out.unboundRpcs = [...rpcNodes.values()].filter(n => !bound.has(n.id)).map(n => `${n.name} (${n.filePath}:${n.startLine})`).sort();
  return out;
}
