/**
 * Protobuf projection (change: add-contract-graph-projection, protobuf phase).
 *
 * Drives `projectProtobuf` directly and through `projectContracts`: the nodes and edges it draws,
 * and every refusal it must disclose instead of guessing — an ambiguous service, an unknown one,
 * an implementation that is not literal or not unique, a file that could not be read, a cap.
 */
import { describe, it, expect } from 'vitest';
import { projectProtobuf, GRPC_REGISTRATION_BINDING, MAX_PROTO_FILES, type ProtobufProjectionInput } from './project-protobuf.js';
import { projectContracts, contractDisclosure, type ContractProjectionInput } from './project.js';
import type { GrpcRegistration } from './grpc-registration.js';
import type { FunctionNode } from '../call-graph-types.js';

const ORDERS = `syntax = "proto3";
package shop.orders.v1;

import "google/protobuf/timestamp.proto";
import "common.proto";

service OrderService {
  rpc GetOrder(GetOrderRequest) returns (Order);
  rpc ListOrders(ListOrdersRequest) returns (stream Order);
}

message GetOrderRequest { string id = 1; }
message ListOrdersRequest { int32 page_size = 1; }
message Order {
  string id = 1;
  Status status = 2;
  shop.common.Money total = 3;
  google.protobuf.Timestamp created = 4;
  map<string, Line> lines = 5;
  message Line { string sku = 1; }
}
enum Status { STATUS_UNSPECIFIED = 0; PAID = 1; }
`;
const COMMON = `syntax = "proto3";
package shop.common;
message Money { int64 units = 1; }
`;

function fn(id: string, partial: Partial<FunctionNode> = {}): FunctionNode {
  const [filePath, name] = id.split('::');
  const simple = name.slice(name.lastIndexOf('.') + 1);
  const cls = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : undefined;
  return {
    id, name: simple, filePath, isAsync: false, language: 'Go', startIndex: 0, endIndex: 10,
    fanIn: 0, fanOut: 0, startLine: 3, endLine: 9, ...(cls ? { className: cls } : {}), ...partial,
  };
}

/** A resolver over a fixed code index, filtering by the registration's type as the builder does. */
const resolverOver = (code: FunctionNode[]) => (reg: GrpcRegistration, name: string) =>
  code.filter(n => n.name === name && (reg.implType === undefined || n.className === reg.implType));

const goReg = (partial: Partial<GrpcRegistration> = {}): GrpcRegistration => ({
  file: 'cmd/server/main.go', line: 12, runtime: 'go', service: 'OrderService', implType: 'orderServer', ...partial,
});

const SERVER = [fn('cmd/server/main.go::orderServer.GetOrder'), fn('cmd/server/main.go::orderServer.ListOrders')];

function direct(partial: Partial<ProtobufProjectionInput> = {}) {
  return projectProtobuf({
    files: [{ path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/common.proto', content: COMMON }],
    registrations: [goReg()],
    resolveImplementation: resolverOver(SERVER),
    ...partial,
  });
}

const edgesOf = (p: { edges: Array<{ callerId: string; calleeId: string; kind?: string }> }, kind: string) =>
  p.edges.filter(e => e.kind === kind).map(e => `${e.callerId} -> ${e.calleeId}`).sort();

describe('projectProtobuf: nodes', () => {
  it('projects RPC, message and enum nodes with ids, names and signatures', () => {
    const p = direct();
    const byName = Object.fromEntries(p.nodes.map(n => [n.name, n]));
    expect(Object.keys(byName).sort()).toEqual([
      '/shop.orders.v1.OrderService/GetOrder', '/shop.orders.v1.OrderService/ListOrders',
      'shop.common.Money', 'shop.orders.v1.GetOrderRequest', 'shop.orders.v1.ListOrdersRequest',
      'shop.orders.v1.Order', 'shop.orders.v1.Order.Line', 'shop.orders.v1.Status',
    ]);
    expect(p.nodes.every(n => n.language === 'Protobuf' && n.fanIn === 0 && n.fanOut === 0)).toBe(true);
    const get = byName['/shop.orders.v1.OrderService/GetOrder'];
    expect(get).toMatchObject({
      id: 'proto/orders.proto::/shop.orders.v1.OrderService/GetOrder', filePath: 'proto/orders.proto',
      signature: 'rpc GetOrder(GetOrderRequest) returns (Order)', startLine: 8, endLine: 8,
    });
    expect(byName['/shop.orders.v1.OrderService/ListOrders'].signature).toBe('rpc ListOrders(ListOrdersRequest) returns (stream Order)');
    expect(byName['shop.orders.v1.Order.Line']).toMatchObject({ id: 'proto/orders.proto::shop.orders.v1.Order.Line', signature: 'message Line' });
    expect(byName['shop.orders.v1.Status'].signature).toBe('enum Status');
    expect(byName['shop.common.Money'].filePath).toBe('proto/common.proto');
    expect(new Set(p.nodes.map(n => n.id)).size).toBe(p.nodes.length);
  });

  it('is deterministic regardless of file and registration order', () => {
    const a = direct();
    const b = direct({
      files: [{ path: 'proto/common.proto', content: COMMON }, { path: 'proto/orders.proto', content: ORDERS }],
      registrations: [goReg(), goReg({ line: 3, service: 'Unknown' })].reverse(),
    });
    const c = direct({
      files: [{ path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/common.proto', content: COMMON }],
      registrations: [goReg(), goReg({ line: 3, service: 'Unknown' })],
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(c));
    expect(a.nodes.map(n => n.id)).toEqual(c.nodes.map(n => n.id));
  });
});

describe('projectProtobuf: references_schema', () => {
  it('links RPCs to their request and response, and messages to their field types (cross-file, map values)', () => {
    const p = direct();
    const f = 'proto/orders.proto::';
    expect(edgesOf(p, 'references_schema')).toEqual([
      `${f}/shop.orders.v1.OrderService/GetOrder -> ${f}shop.orders.v1.GetOrderRequest`,
      `${f}/shop.orders.v1.OrderService/GetOrder -> ${f}shop.orders.v1.Order`,
      `${f}/shop.orders.v1.OrderService/ListOrders -> ${f}shop.orders.v1.ListOrdersRequest`,
      `${f}/shop.orders.v1.OrderService/ListOrders -> ${f}shop.orders.v1.Order`,
      `${f}shop.orders.v1.Order -> ${f}shop.orders.v1.Order.Line`,
      `${f}shop.orders.v1.Order -> ${f}shop.orders.v1.Status`,
      `${f}shop.orders.v1.Order -> proto/common.proto::shop.common.Money`,
    ].sort());
    // An enum references nothing; a scalar draws no edge.
    expect(p.edges.some(e => e.callerId.endsWith('Status'))).toBe(false);
    expect(p.edges.every(e => e.confidence === 'import')).toBe(true);
  });

  it('counts an unresolved google.protobuf type without withholding anything', () => {
    const p = direct();
    expect(p.unresolvedTypes).toBe(1); // google.protobuf.Timestamp
    expect(p.notAssessed).toEqual([]);
    expect(p.unboundRpcs).toEqual([]);
  });

  it('draws no edge to a type declared in two files, and counts it', () => {
    const dup = `syntax = "proto3";\npackage shop.common;\nmessage Money { int64 cents = 1; }\n`;
    const p = direct({ files: [
      { path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/common.proto', content: COMMON },
      { path: 'vendor/common.proto', content: dup },
    ] });
    expect(p.edges.some(e => e.calleeId.endsWith('shop.common.Money'))).toBe(false);
    expect(p.unresolvedTypes).toBe(2);
    // Both copies are still nodes.
    expect(p.nodes.filter(n => n.name === 'shop.common.Money').map(n => n.filePath).sort()).toEqual(['proto/common.proto', 'vendor/common.proto']);
  });
});

describe('projectProtobuf: implements_endpoint from registrations', () => {
  it('binds the registered type\'s methods to the RPCs they serve', () => {
    const p = direct();
    expect(edgesOf(p, 'implements_endpoint')).toEqual([
      'cmd/server/main.go::orderServer.GetOrder -> proto/orders.proto::/shop.orders.v1.OrderService/GetOrder',
      'cmd/server/main.go::orderServer.ListOrders -> proto/orders.proto::/shop.orders.v1.OrderService/ListOrders',
    ]);
    const e = p.edges.find(x => x.kind === 'implements_endpoint')!;
    expect(e).toMatchObject({ synthesizedBy: GRPC_REGISTRATION_BINDING, line: 3, calleeName: '/shop.orders.v1.OrderService/GetOrder' });
    expect(p.unresolvedRegistrations).toEqual([]);
  });

  it('lists RPCs no registration bound', () => {
    const p = direct({ resolveImplementation: resolverOver([SERVER[0]]) });
    expect(p.unboundRpcs).toEqual(['/shop.orders.v1.OrderService/ListOrders (proto/orders.proto:9)']);
    expect(direct({ registrations: [] }).unboundRpcs).toHaveLength(2);
  });

  it('discloses an unknown service', () => {
    const p = direct({ registrations: [goReg({ service: 'BillingService' })] });
    expect(p.unresolvedRegistrations).toEqual([{ file: 'cmd/server/main.go', line: 12, service: 'BillingService', reason: 'unknown-service' }]);
    expect(p.edges.some(e => e.kind === 'implements_endpoint')).toBe(false);
  });

  it('discloses a service whose simple name two packages declare', () => {
    const v2 = ORDERS.replace('package shop.orders.v1;', 'package shop.orders.v2;');
    const p = direct({ files: [
      { path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/v2/orders.proto', content: v2 },
      { path: 'proto/common.proto', content: COMMON },
    ] });
    expect(p.unresolvedRegistrations).toEqual([{
      file: 'cmd/server/main.go', line: 12, service: 'OrderService', reason: 'ambiguous-service',
      detail: 'shop.orders.v1.OrderService, shop.orders.v2.OrderService',
    }]);
    expect(p.edges.some(e => e.kind === 'implements_endpoint')).toBe(false);
  });

  it('discloses one full service name declared in two files', () => {
    const p = direct({ files: [
      { path: 'proto/orders.proto', content: ORDERS }, { path: 'copy/orders.proto', content: ORDERS },
      { path: 'proto/common.proto', content: COMMON },
    ] });
    expect(p.unresolvedRegistrations).toEqual([{
      file: 'cmd/server/main.go', line: 12, service: 'shop.orders.v1.OrderService', reason: 'ambiguous-service',
      detail: 'copy/orders.proto, proto/orders.proto',
    }]);
  });

  it('discloses a registration whose implementation is not literal', () => {
    const p = direct({ registrations: [goReg({ implType: undefined, notLiteral: 'the implementation is `srv`' })] });
    expect(p.unresolvedRegistrations).toEqual([{
      file: 'cmd/server/main.go', line: 12, service: 'shop.orders.v1.OrderService', reason: 'not-literal', detail: 'the implementation is `srv`',
    }]);
    expect(p.unboundRpcs).toHaveLength(2);
  });

  it('discloses two same-named methods at the same level instead of picking one', () => {
    const p = direct({ resolveImplementation: resolverOver([
      ...SERVER, fn('cmd/server/main.go::orderServer.GetOrder', { id: 'cmd/server/main.go::orderServer.GetOrder#2', startLine: 40 }),
    ]) });
    expect(p.unresolvedRegistrations).toEqual([{
      file: 'cmd/server/main.go', line: 12, service: 'shop.orders.v1.OrderService', rpc: 'GetOrder',
      reason: 'ambiguous-implementation', detail: 'more than one `GetOrder` on orderServer',
    }]);
    expect(edgesOf(p, 'implements_endpoint')).toEqual([
      'cmd/server/main.go::orderServer.ListOrders -> proto/orders.proto::/shop.orders.v1.OrderService/ListOrders',
    ]);
  });

  it('prefers the registration\'s file, then its directory, then the only candidate', () => {
    const sameFile = fn('cmd/server/main.go::orderServer.GetOrder');
    const sameDir = fn('cmd/server/impl.go::orderServer.GetOrder');
    const elsewhere = fn('internal/orders/server.go::orderServer.GetOrder');
    const other = fn('internal/billing/server.go::orderServer.GetOrder');
    const target = (code: FunctionNode[]) => direct({ resolveImplementation: resolverOver(code) })
      .edges.filter(e => e.kind === 'implements_endpoint').map(e => e.callerId);
    expect(target([elsewhere, sameDir, sameFile])).toEqual(['cmd/server/main.go::orderServer.GetOrder']);
    expect(target([elsewhere, sameDir])).toEqual(['cmd/server/impl.go::orderServer.GetOrder']);
    expect(target([elsewhere])).toEqual(['internal/orders/server.go::orderServer.GetOrder']);
    // Two candidates, neither in the registration's file or directory: no pick.
    const p = direct({ resolveImplementation: resolverOver([elsewhere, other]) });
    expect(p.edges.some(e => e.kind === 'implements_endpoint')).toBe(false);
    expect(p.unresolvedRegistrations.map(r => r.reason)).toEqual(['ambiguous-implementation']);
  });

  it('binds a Python servicer by its class', () => {
    const p = direct({
      registrations: [{ file: 'app/server.py', line: 5, runtime: 'python', service: 'OrderService', implType: 'OrderServicer' }],
      resolveImplementation: resolverOver([fn('app/servicer.py::OrderServicer.GetOrder', { language: 'Python' })]),
    });
    expect(edgesOf(p, 'implements_endpoint')).toEqual([
      'app/servicer.py::OrderServicer.GetOrder -> proto/orders.proto::/shop.orders.v1.OrderService/GetOrder',
    ]);
  });

  describe('Node grpc-js', () => {
    const nodeReg = (partial: Partial<GrpcRegistration> = {}): GrpcRegistration => ({
      file: 'src/server.js', line: 4, runtime: 'node', service: 'proto.shop.orders.v1.OrderService',
      methods: [{ key: 'getOrder', fn: 'getOrder' }, { key: 'ListOrders', fn: 'listAll' }], ...partial,
    });
    const code = [fn('src/handlers.js::getOrder', { language: 'JavaScript' }), fn('src/handlers.js::listAll', { language: 'JavaScript' })];

    it('matches the service by dotted suffix and each RPC by key (as written or camelCase)', () => {
      const p = direct({ registrations: [nodeReg()], resolveImplementation: resolverOver(code) });
      expect(edgesOf(p, 'implements_endpoint')).toEqual([
        'src/handlers.js::getOrder -> proto/orders.proto::/shop.orders.v1.OrderService/GetOrder',
        'src/handlers.js::listAll -> proto/orders.proto::/shop.orders.v1.OrderService/ListOrders',
      ]);
    });

    it('falls back to a unique simple name, and to the name without a `Service` suffix', () => {
      const simple = direct({ registrations: [nodeReg({ service: 'pkg.OrderService' })], resolveImplementation: resolverOver(code) });
      expect(edgesOf(simple, 'implements_endpoint')).toHaveLength(2);
      const ordersProto = ORDERS.replace('service OrderService', 'service Orders');
      const stripped = direct({
        files: [{ path: 'proto/orders.proto', content: ordersProto }, { path: 'proto/common.proto', content: COMMON }],
        registrations: [nodeReg({ service: 'pkg.OrdersService' })], resolveImplementation: resolverOver(code),
      });
      expect(edgesOf(stripped, 'implements_endpoint')).toHaveLength(2);
    });

    it('discloses an inline implementation per RPC and leaves an absent key unbound', () => {
      const p = direct({ registrations: [nodeReg({ methods: [{ key: 'getOrder' }] })], resolveImplementation: resolverOver(code) });
      expect(p.unresolvedRegistrations).toEqual([{
        file: 'src/server.js', line: 4, service: 'shop.orders.v1.OrderService', rpc: 'GetOrder', reason: 'inline-implementation',
      }]);
      expect(p.edges.some(e => e.kind === 'implements_endpoint')).toBe(false);
      expect(p.unboundRpcs).toHaveLength(2);
    });

    it('discloses a service suffix that names no declared service', () => {
      const p = direct({ registrations: [nodeReg({ service: 'proto.billing.Ledger' })], resolveImplementation: resolverOver(code) });
      expect(p.unresolvedRegistrations.map(r => r.reason)).toEqual(['unknown-service']);
    });
  });
});

describe('projectProtobuf: unread files and caps', () => {
  it('discloses an unread file and withholds through notAssessed', () => {
    const p = direct({ files: [
      { path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/common.proto', content: COMMON },
      { path: 'proto/legacy.proto', content: 'syntax = "proto2"; message X { optional string a = 1; }' },
    ] });
    expect(p.unreadSpecifications).toEqual([{ file: 'proto/legacy.proto', reason: expect.stringMatching(/proto2/) }]);
    expect(p.notAssessed).toEqual(['1 protobuf file(s) could not be read']);
  });

  it('projects nothing but the disclosure when every file is unread', () => {
    const p = direct({ files: [{ path: 'a.proto', content: 'message A {}' }] });
    expect(p.nodes).toEqual([]);
    expect(p.edges).toEqual([]);
    expect(p.unreadSpecifications).toHaveLength(1);
  });

  it('caps RPC nodes and says so', () => {
    const rpcs = Array.from({ length: 2_001 }, (_, i) => `rpc M${String(i).padStart(4, '0')}(E) returns (E);`).join('\n');
    const p = projectProtobuf({
      files: [{ path: 'big.proto', content: `syntax = "proto3";\nmessage E {}\nservice S {\n${rpcs}\n}\n` }],
      registrations: [], resolveImplementation: () => [],
    });
    expect(p.nodes.filter(n => n.name.startsWith('/'))).toHaveLength(2_000);
    expect(p.truncations).toEqual([{ reason: 'operation-cap', cap: 2_000, seen: 2_001 }]);
    expect(p.notAssessed).toEqual(['1 RPC(s) past the cap were not projected']);
  });
});

// ── Through projectContracts ────────────────────────────────────────────────

const OPENAPI = `openapi: 3.0.0
info: { title: t, version: '1' }
paths:
  /orders:
    get:
      operationId: listOrders
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
components:
  schemas:
    Order:
      type: object
      properties:
        id: { type: string }
`;

function viaContracts(partial: Partial<ContractProjectionInput> = {}) {
  return projectContracts({
    files: [{ path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/common.proto', content: COMMON }],
    routes: [], calls: [],
    resolveHandler: () => undefined, resolveCaller: () => undefined,
    grpcRegistrations: [goReg()],
    resolveGrpcImplementation: resolverOver(SERVER),
    ...partial,
  });
}

describe('projectContracts with protobuf', () => {
  it('merges protobuf nodes and edges into the projection', () => {
    const p = viaContracts();
    expect(p.nodes.filter(n => n.language === 'Protobuf')).toHaveLength(8);
    expect(edgesOf(p, 'implements_endpoint')).toHaveLength(2);
    expect(p.unboundRpcs).toEqual({ items: [], total: 0 });
    expect(p.unresolvedRegistrations).toEqual({ items: [], total: 0 });
    // The unresolved google.protobuf import is said, and withholds nothing.
    expect(p.notAssessed).toEqual([expect.stringMatching(/^1 protobuf type reference\(s\) resolve to no type/)]);
  });

  it('discloses unbound RPCs and unresolved registrations, bounded with totals', () => {
    const p = viaContracts({ grpcRegistrations: [goReg({ service: 'Nope' })] });
    expect(p.unboundRpcs.total).toBe(2);
    expect(p.unresolvedRegistrations).toEqual({ items: [{ file: 'cmd/server/main.go', line: 12, service: 'Nope', reason: 'unknown-service' }], total: 1 });
    expect(contractDisclosure(p)).toBeDefined();
  });

  it('withholds unboundRpcs while a .proto is unread, but still lists the unread file', () => {
    const p = viaContracts({
      grpcRegistrations: [],
      files: [{ path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/common.proto', content: COMMON }, { path: 'proto/x.proto', content: 'edition = "2023";' }],
    });
    expect(p.unboundRpcs).toEqual({ items: [], total: 0 });
    expect(p.unreadSpecifications.items).toEqual([{ file: 'proto/x.proto', reason: expect.stringMatching(/editions/) }]);
    expect(p.notAssessed).toContain('1 protobuf file(s) could not be read');
  });

  it('does not let an unread .proto withhold OpenAPI unmatchedOperations', () => {
    const p = viaContracts({
      grpcRegistrations: [],
      files: [{ path: 'openapi.yaml', content: OPENAPI }, { path: 'proto/x.proto', content: 'message A {}' }],
    });
    expect(p.unmatchedOperations.items).toEqual(['GET /orders (openapi.yaml:5)']);
    expect(p.unboundRpcs.total).toBe(0);
  });

  it('does not let an unread OpenAPI document withhold unboundRpcs', () => {
    const p = viaContracts({
      grpcRegistrations: [],
      files: [
        { path: 'openapi.yaml', content: 'openapi: 3.0.0\npaths:\n  - [\n' },
        { path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/common.proto', content: COMMON },
      ],
    });
    expect(p.unreadSpecifications.items.map(u => u.file)).toEqual(['openapi.yaml']);
    expect(p.unboundRpcs.total).toBe(2);
    expect(p.unmatchedOperations.total).toBe(0); // withheld on the OpenAPI side
  });

  it('lists OpenAPI operations only in unmatchedOperations, never a named schema or an RPC', () => {
    const p = viaContracts({
      grpcRegistrations: [],
      files: [{ path: 'openapi.yaml', content: OPENAPI }, { path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/common.proto', content: COMMON }],
    });
    expect(p.nodes.some(n => n.name.includes('#/components/schemas/Order'))).toBe(true);
    expect(p.unmatchedOperations.items).toEqual(['GET /orders (openapi.yaml:5)']);
    expect(p.unmatchedOperations.total).toBe(1);
    expect(p.unboundRpcs.total).toBe(2);
  });

  it('caps the .proto files read and withholds unboundRpcs past the cap', () => {
    const files = Array.from({ length: MAX_PROTO_FILES + 2 }, (_, i) => ({
      path: `proto/f${String(i).padStart(4, '0')}.proto`,
      content: `syntax = "proto3";\npackage p${i};\nmessage M {}\nservice S { rpc R(M) returns (M); }\n`,
    }));
    const p = viaContracts({ grpcRegistrations: [], files });
    expect(p.truncations).toContainEqual({ reason: 'proto-file-cap', cap: MAX_PROTO_FILES, seen: MAX_PROTO_FILES + 2 });
    expect(p.notAssessed).toContain('2 protobuf file(s) past the file cap were not read');
    expect(p.nodes.filter(n => n.language === 'Protobuf' && n.name.startsWith('/'))).toHaveLength(MAX_PROTO_FILES);
    // The last two by path are the unread ones.
    expect(p.nodes.some(n => n.filePath === `proto/f${String(MAX_PROTO_FILES).padStart(4, '0')}.proto`)).toBe(false);
    expect(p.unboundRpcs.total).toBe(0);
  });

  it('projects no protobuf half when no .proto file is given', () => {
    const p = viaContracts({ files: [{ path: 'openapi.yaml', content: OPENAPI }] });
    expect(p.nodes.some(n => n.language === 'Protobuf')).toBe(false);
    expect(p.unresolvedRegistrations.total).toBe(0);
    expect(p.unboundRpcs.total).toBe(0);
  });

  it('never reads a .proto file as an OpenAPI candidate', () => {
    // A comment mentioning `openapi:` makes a .proto look like an OpenAPI document to the sniff.
    const p = viaContracts({
      grpcRegistrations: [],
      files: [{ path: 'proto/orders.proto', content: `// openapi: 3.0.0\n${ORDERS}` }, { path: 'proto/common.proto', content: COMMON }],
    });
    expect(p.unreadSpecifications.total).toBe(0);
    expect(p.nodes.every(n => n.language === 'Protobuf')).toBe(true);
  });
});

describe('one format never withholds the other', () => {
  it('an `extend` block is disclosed but does not withhold the unbound RPCs', () => {
    const p = viaContracts({
      files: [{ path: 'proto/orders.proto', content: ORDERS.replace('enum Status', 'extend google.protobuf.MethodOptions { string scope = 50001; }\nenum Status') }, { path: 'proto/common.proto', content: COMMON }],
      grpcRegistrations: [],
    });
    expect(p.notAssessed).toEqual(expect.arrayContaining([expect.stringContaining('outside the model were not read: extend')]));
    expect(p.unboundRpcs.total).toBe(2);
  });

  it('an omitted OpenAPI candidate does not withhold the unbound RPCs, and an omitted .proto does', () => {
    const files = [{ path: 'proto/orders.proto', content: ORDERS }, { path: 'proto/common.proto', content: COMMON }];
    expect(viaContracts({ files, grpcRegistrations: [], filesOmitted: 3 }).unboundRpcs.total).toBe(2);
    const p = viaContracts({ files, grpcRegistrations: [], protoFilesOmitted: 1 });
    expect(p.unboundRpcs.total).toBe(0);
    expect(p.truncations).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'proto-file-cap' })]));
  });
});
