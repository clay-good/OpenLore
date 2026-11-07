/**
 * gRPC server registration scanning (change: add-contract-graph-projection, protobuf phase).
 *
 * One registration call per runtime names both the service and its implementation. The scanner
 * must read that call literally, and must NOT read: a generated stub (it defines the function),
 * a registration written in a comment or a string, or an `addService` that is not grpc-js.
 */
import { describe, it, expect } from 'vitest';
import { scanGrpcRegistrations, importedNames, isImportedModule, isImportedPythonModule } from './grpc-registration.js';

describe('scanGrpcRegistrations: Go', () => {
  it('reads the service and the literal implementation type', () => {
    const src = `package main

func main() {
	s := grpc.NewServer()
	pb.RegisterOrderServiceServer(s, &orderServer{db: db})
	pb.RegisterBillingServer(s, billing.Server{})
	RegisterHealthServer(s, new(healthImpl))
}
`;
    expect(scanGrpcRegistrations('cmd/server/main.go', src)).toEqual([
      { file: 'cmd/server/main.go', line: 5, runtime: 'go', service: 'OrderService', implType: 'orderServer' },
      { file: 'cmd/server/main.go', line: 6, runtime: 'go', service: 'Billing', implType: 'Server', implQualifier: 'billing' },
      { file: 'cmd/server/main.go', line: 7, runtime: 'go', service: 'Health', implType: 'healthImpl' },
    ]);
  });

  it('reports a non-literal implementation as notLiteral', () => {
    const src = `func main() {
	srv := &orderServer{}
	pb.RegisterOrderServiceServer(s, srv)
	pb.RegisterOtherServer(s, NewServer())
	pb.RegisterThirdServer(s)
}
`;
    const regs = scanGrpcRegistrations('main.go', src);
    expect(regs.map(r => [r.line, r.service, r.implType, !!r.notLiteral])).toEqual([
      [3, 'OrderService', undefined, true], [4, 'Other', undefined, true], [5, 'Third', undefined, true],
    ]);
    expect(regs[0].notLiteral).toContain('srv');
  });

  it('skips generated stubs, the stub definition itself, and grpc-gateway handlers', () => {
    const def = `func RegisterOrderServiceServer(s grpc.ServiceRegistrar, srv OrderServiceServer) {
	s.RegisterService(&OrderService_ServiceDesc, srv)
}
`;
    expect(scanGrpcRegistrations('gen/orders_grpc.pb.go', `${def}\nfunc x() { RegisterOrderServiceServer(s, &a{}) }`)).toEqual([]);
    expect(scanGrpcRegistrations('gen/orders.pb.go', 'func x() { RegisterOrderServiceServer(s, &a{}) }')).toEqual([]);
    expect(scanGrpcRegistrations('pkg/handwritten.go', def)).toEqual([]);
    expect(scanGrpcRegistrations('gw.go', 'func x() { pb.RegisterOrderServiceHandlerServer(ctx, mux, &orderServer{}) }')).toEqual([]);
  });

  it('does not read a registration in a comment or a string', () => {
    const src = `package main
// pb.RegisterOrderServiceServer(s, &orderServer{})
/* pb.RegisterBlockServer(s, &x{}) */
var doc = "pb.RegisterStrServer(s, &x{})"
var raw = \`pb.RegisterRawServer(s, &x{})\`
func main() { pb.RegisterRealServer(s, &real{}) }
`;
    expect(scanGrpcRegistrations('main.go', src).map(r => r.service)).toEqual(['Real']);
  });

  it('ignores files of other languages', () => {
    expect(scanGrpcRegistrations('README.md', 'pb.RegisterOrderServiceServer(s, &orderServer{})')).toEqual([]);
    expect(scanGrpcRegistrations('orders.proto', 'pb.RegisterOrderServiceServer(s, &orderServer{})')).toEqual([]);
  });
});

describe('scanGrpcRegistrations: Python', () => {
  it('reads the service and the instantiated servicer class', () => {
    const src = `import grpc
from orders import orders_pb2_grpc


def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    orders_pb2_grpc.add_OrderServiceServicer_to_server(OrderServicer(db), server)
    add_BillingServicer_to_server(billing.BillingServicer(), server)
`;
    expect(scanGrpcRegistrations('app/server.py', src)).toEqual([
      { file: 'app/server.py', line: 7, runtime: 'python', service: 'OrderService', implType: 'OrderServicer' },
      { file: 'app/server.py', line: 8, runtime: 'python', service: 'Billing', implType: 'BillingServicer', implQualifier: 'billing' },
    ]);
  });

  it('reports a variable or a lower-case factory as notLiteral', () => {
    const src = `def serve(server):
    servicer = OrderServicer()
    add_OrderServiceServicer_to_server(servicer, server)
    add_OtherServicer_to_server(make_servicer(), server)
`;
    const regs = scanGrpcRegistrations('srv.py', src);
    expect(regs.map(r => [r.line, r.service, r.implType])).toEqual([[3, 'OrderService', undefined], [4, 'Other', undefined]]);
    expect(regs.every(r => r.notLiteral)).toBe(true);
  });

  it('skips generated stubs and the stub definition itself', () => {
    const def = `def add_OrderServiceServicer_to_server(servicer, server):
    rpc_method_handlers = {}
`;
    expect(scanGrpcRegistrations('orders_pb2_grpc.py', `${def}add_OrderServiceServicer_to_server(X(), s)\n`)).toEqual([]);
    expect(scanGrpcRegistrations('orders_pb2.py', 'add_OrderServiceServicer_to_server(X(), s)\n')).toEqual([]);
    expect(scanGrpcRegistrations('vendored_copy.py', def)).toEqual([]);
  });

  it('does not read a registration in a comment, a string or a docstring', () => {
    const src = `"""
Usage:
    add_DocServicer_to_server(DocServicer(), server)
"""
# add_CommentServicer_to_server(CommentServicer(), server)
EXAMPLE = 'add_StrServicer_to_server(StrServicer(), server)'
def serve(server):
    add_RealServicer_to_server(RealServicer(), server)
`;
    expect(scanGrpcRegistrations('srv.py', src).map(r => [r.service, r.line])).toEqual([['Real', 8]]);
  });
});

describe('scanGrpcRegistrations: Node grpc-js', () => {
  it('reads the service expression and each key of the implementation map', () => {
    const src = `const server = new grpc.Server();
server.addService(proto.orders.v1.OrderService.service, {
  getOrder,
  listOrders: list,
  cancel: handlers.cancelOrder,
  watch: (call) => call.end(),
  ship: function (call, cb) { cb(null, {}); },
  async refund(call, cb) { cb(null, {}); },
  track(call, cb) { cb(null, {}); },
});
`;
    expect(scanGrpcRegistrations('src/server.js', src)).toEqual([{
      file: 'src/server.js', line: 2, runtime: 'node', service: 'proto.orders.v1.OrderService',
      methods: [
        { key: 'getOrder', fn: 'getOrder' },
        { key: 'listOrders', fn: 'list' },
        { key: 'cancel', fn: 'cancelOrder', notFollowed: '`handlers.cancelOrder` names a member of `handlers`, which is not an import' },
        { key: 'watch' },
        { key: 'ship' },
        { key: 'refund', fn: 'refund' },
        { key: 'track', fn: 'track' },
      ],
    }]);
  });

  it('reports a spread or a non-literal implementation as notLiteral', () => {
    const src = `server.addService(pkg.A.service, { ...impl, getOrder });
server.addService(pkg.B.service, impl);
server.addService(pkg.C.service, makeImpl());
`;
    const regs = scanGrpcRegistrations('s.ts', src);
    expect(regs.map(r => [r.line, r.service, r.methods, !!r.notLiteral])).toEqual([
      [1, 'pkg.A', undefined, true], [2, 'pkg.B', undefined, true], [3, 'pkg.C', undefined, true],
    ]);
  });

  it('reads the static-codegen form (a service object, no `.service`) as a candidate the projector confirms', () => {
    const src = `container.addService(LoggerService, { log });
server.addService(services.GreeterService, { sayHello });
registry.addService('orders', handler);
`;
    expect(scanGrpcRegistrations('s.ts', src)).toEqual([
      { file: 's.ts', line: 1, runtime: 'node', service: 'LoggerService', descriptor: false, methods: [{ key: 'log', fn: 'log' }] },
      { file: 's.ts', line: 2, runtime: 'node', service: 'services.GreeterService', descriptor: false, methods: [{ key: 'sayHello', fn: 'sayHello' }] },
    ]);
  });

  it('a Go service named `…Handler` is read; grpc-gateway\'s three-argument form is not; nor a method declaration', () => {
    const src = `package main
func (r *Reg) RegisterFooServer(s grpc.ServiceRegistrar, f FooServer) {}
func main() {
	pb.RegisterEventHandlerServer(s, &h{})
	gw.RegisterOrderServiceHandlerServer(ctx, mux, &orderServer{})
}
`;
    expect(scanGrpcRegistrations('main.go', src)).toEqual([{ file: 'main.go', line: 4, runtime: 'go', service: 'EventHandler', implType: 'h' }]);
  });

  it('the markers are linear on an adversarial word', () => {
    const t = Date.now();
    scanGrpcRegistrations('x.go', `var s = "${'Register'.repeat(80_000)}"`);
    scanGrpcRegistrations('x.py', `s = "${'add_'.repeat(160_000)}"`);
    expect(Date.now() - t).toBeLessThan(1_500);
  });

  it('does not read a registration in a comment, string or template literal', () => {
    const src = `// server.addService(pkg.Comment.service, { a });
/* server.addService(pkg.Block.service, { a }); */
const s = "server.addService(pkg.Str.service, { a })";
const t = \`server.addService(pkg.Tpl.service, { a })\`;
server.addService(pkg.Real.service, { a });
`;
    expect(scanGrpcRegistrations('s.ts', src).map(r => [r.service, r.line])).toEqual([['pkg.Real', 5]]);
  });

  it('skips generated stubs', () => {
    expect(scanGrpcRegistrations('gen/orders_grpc_pb.js', 'server.addService(pkg.A.service, { a });')).toEqual([]);
    expect(scanGrpcRegistrations('gen/orders_grpc_pb.cjs', 'server.addService(pkg.A.service, { a });')).toEqual([]);
  });

  it('reads TypeScript, module and JSX extensions', () => {
    for (const f of ['a.ts', 'a.mts', 'a.cjs', 'a.tsx']) {
      expect(scanGrpcRegistrations(f, 'server.addService(pkg.A.service, { a });'), f).toHaveLength(1);
    }
  });
});

describe('scanGrpcRegistrations: robustness', () => {
  it('reports several registrations with correct lines', () => {
    const src = `func main() {\n${Array.from({ length: 30 }, (_, i) => `\tpb.RegisterS${i}Server(s, &impl${i}{})`).join('\n')}\n}\n`;
    const regs = scanGrpcRegistrations('main.go', src);
    expect(regs).toHaveLength(30);
    expect(regs.map(r => r.line)).toEqual(Array.from({ length: 30 }, (_, i) => i + 2));
    expect(regs[29]).toMatchObject({ service: 'S29', implType: 'impl29' });
  });

  it('reports an unterminated call as unreadable without hanging', () => {
    const go = `func main() { pb.RegisterOrderServiceServer(s, &orderServer{${' x: 1,'.repeat(200_000)}`;
    const start = Date.now();
    const regs = scanGrpcRegistrations('main.go', go);
    expect(regs).toEqual([{ file: 'main.go', line: 1, runtime: 'go', service: 'OrderService', notLiteral: 'the registration call could not be read' }]);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('keeps the service of a grpc-js registration whose implementation map is too long to read', () => {
    // A long inline implementation map runs past the per-call bound; the `.service` descriptor in
    // the first argument still names the service, so the disclosure must not lose it.
    const body = Array.from({ length: 2_000 }, (_, i) => `  m${i}(call, cb) { cb(null, { value: ${i} }); },`).join('\n');
    const src = `server.addService(pkg.orders.OrderService.service, {\n${body}\n});\n`;
    const regs = scanGrpcRegistrations('s.js', src);
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ service: 'pkg.orders.OrderService', notLiteral: 'the registration call could not be read' });
  });

  it('does not report an unreadable addService that names no `.service` descriptor', () => {
    expect(scanGrpcRegistrations('s.js', `container.addService(${'x'.repeat(40_000)}`)).toEqual([]);
  });

  it('stays linear on many unterminated calls', () => {
    const src = 'pb.RegisterAServer(s, &a{'.repeat(20_000);
    const start = Date.now();
    scanGrpcRegistrations('main.go', src);
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe('scanGrpcRegistrations: round-3 review', () => {
  it('marks a Node handler that the file imports, and only those', () => {
    const src = `import { listOrders } from './handlers';
const impl = require('./impl');
function getOrder(call, cb) {}
server.addService(proto.orders.v1.OrderService.service, { getOrder, listOrders, del: impl.del, other: elsewhere });
`;
    expect(scanGrpcRegistrations('srv/server.js', src)[0].methods).toEqual([
      { key: 'getOrder', fn: 'getOrder' },
      { key: 'listOrders', fn: 'listOrders', imported: true, from: './handlers' },
      { key: 'del', fn: 'del', imported: true, from: './impl' },
      { key: 'other', fn: 'elsewhere' },
    ]);
  });

  it('a Python constructor followed by a chained call is not literal', () => {
    const r = scanGrpcRegistrations('s.py', 'add_GreeterServicer_to_server(Impl(cfg).wrap(), server)\n');
    expect(r[0]).toMatchObject({ service: 'Greeter', notLiteral: expect.any(String) });
    expect(r[0].implType).toBeUndefined();
  });
});

describe('scanGrpcRegistrations: round-4 review — aliased imports', () => {
  it('an aliased import is looked up by the name it was exported under, never by the alias', () => {
    const esm = scanGrpcRegistrations('srv/server.js', `import { getOrder as get } from './handlers';
server.addService(proto.shop.v1.OrderService.service, { getOrder: get });
`);
    expect(esm[0].methods).toEqual([{ key: 'getOrder', fn: 'getOrder', imported: true, from: './handlers' }]);
    const cjs = scanGrpcRegistrations('srv/server.js', `const { getOrder: g } = require('./handlers');
server.addService(proto.shop.v1.OrderService.service, { getOrder: g });
`);
    expect(cjs[0].methods).toEqual([{ key: 'getOrder', fn: 'getOrder', imported: true, from: './handlers' }]);
  });

  it('a default import names no exported function, so it is not looked for elsewhere', () => {
    const r = scanGrpcRegistrations('srv/server.js', `import handler from './handlers';
server.addService(proto.shop.v1.OrderService.service, { getOrder: handler });
`);
    expect(r[0].methods).toEqual([{ key: 'getOrder', fn: 'handler' }]);
  });
});

describe('importedNames and module resolution', () => {
  it('maps each local name to the name it was exported under and the module it came from', () => {
    const m = importedNames(`import { a, b as c, type T } from './x';
import d, * as ns from "pkg";
const { e, f: g } = require('../y');
const h = await import('./z');
`);
    expect(Object.fromEntries(m)).toEqual({
      a: { exported: 'a', from: './x' }, c: { exported: 'b', from: './x' }, T: { exported: 'T', from: './x' },
      d: { exported: null, from: 'pkg' }, ns: { exported: null, from: 'pkg' },
      e: { exported: 'e', from: '../y' }, g: { exported: 'f', from: '../y' },
      h: { exported: null, from: './z' },
    });
  });

  it('isImportedModule resolves only relative specifiers, with extensions and index files', () => {
    expect(isImportedModule('src/api/resolvers.ts', './orders', 'src/api/orders.ts')).toBe(true);
    expect(isImportedModule('src/api/resolvers.ts', './orders.js', 'src/api/orders.ts')).toBe(true);
    expect(isImportedModule('src/api/resolvers.ts', '../db', 'src/db/index.tsx')).toBe(true);
    for (const ext of ['js', 'mjs', 'cjs']) expect(isImportedModule('src/r.ts', './o', `src/o.${ext}`)).toBe(true);
    expect(isImportedModule('src/api/resolvers.ts', './orders', 'src/orders.ts')).toBe(false);
    expect(isImportedModule('src/api/resolvers.ts', './orders', 'src/api/orders/extra.ts')).toBe(false);
    // A package or a path alias names nothing in the repository.
    expect(isImportedModule('src/r.ts', 'orders', 'orders.ts')).toBe(false);
    expect(isImportedModule('src/r.ts', '@/orders', 'src/orders.ts')).toBe(false);
  });

  it('isImportedPythonModule resolves relative dots from the package and absolute paths as a suffix', () => {
    expect(isImportedPythonModule('app/api/schema.py', '.orders', 'app/api/orders.py')).toBe(true);
    expect(isImportedPythonModule('app/api/schema.py', '..orders', 'app/orders.py')).toBe(true);
    expect(isImportedPythonModule('app/api/schema.py', '..orders', 'app/api/orders.py')).toBe(false);
    expect(isImportedPythonModule('app/api/schema.py', '.', 'app/api/__init__.py')).toBe(true);
    expect(isImportedPythonModule('app/schema.py', 'app.orders', 'src/app/orders.py')).toBe(true);
    expect(isImportedPythonModule('app/schema.py', 'app.orders', 'app/orders/__init__.py')).toBe(true);
    expect(isImportedPythonModule('app/schema.py', 'app.orders', 'myapp/orders.py')).toBe(false);
    expect(isImportedPythonModule('app/schema.py', 'external_pkg', 'app/stats.py')).toBe(false);
  });
});
