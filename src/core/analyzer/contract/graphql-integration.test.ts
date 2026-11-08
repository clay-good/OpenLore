/**
 * The GraphQL projection through the real CallGraphBuilder (change: add-contract-graph-projection,
 * GraphQL phase).
 *
 * One schema split over two files, a TypeScript resolver map and a Python (Ariadne) one: the
 * operation nodes land in the graph, each resolver gets an `implements_endpoint` edge, a test
 * file's resolver map binds nothing, and — as for every projected declaration — code fan-in,
 * fan-out, hubs and entry points are unchanged.
 */
import { describe, it, expect } from 'vitest';
import { CallGraphBuilder } from '../call-graph.js';

const SCHEMA = `type Query {
  order(id: ID!): Order
  orders: [Order!]!
  search(term: String!): [Order!]!
}

type Order { id: ID! total: Float }
`;
const EXT = `extend type Mutation { cancelOrder(id: ID!): Order }
type Mutation { placeOrder(id: ID!): Order }
`;

const TS = `import { getOrder as fetchOrder } from './orders';

function listOrders() {
  return loadAll();
}

function loadAll() {
  return [];
}

export const resolvers = {
  Query: {
    order: (_p: unknown, args: { id: string }) => fetchOrder(args.id),
    orders: listOrders,
  },
  Mutation: {
    placeOrder: fetchOrder,
  },
};
`;

const ORDERS = `export function getOrder(id: string) {
  return { id };
}
`;

const PY = `from ariadne import MutationType, QueryType

query = QueryType()
mutation = MutationType()


@query.field("search")
def resolve_search(obj, info, term):
    return find(term)


def find(term):
    return []


def resolve_cancel(obj, info, id):
    return None


mutation.set_field("cancelOrder", resolve_cancel)
`;

const TS_TEST = `function fakeOrders() { return []; }

export const resolvers = { Query: { orders: fakeOrders, search: fakeOrders } };
`;

const CODE = [
  { path: 'src/resolvers.ts', content: TS, language: 'TypeScript' },
  { path: 'src/orders.ts', content: ORDERS, language: 'TypeScript' },
  { path: 'app/schema.py', content: PY, language: 'Python' },
  { path: 'src/resolvers.test.ts', content: TS_TEST, language: 'TypeScript' },
];

const build = (withSchema: boolean) =>
  new CallGraphBuilder(withSchema
    ? { contractFiles: [{ path: 'graphql/schema.graphql', content: SCHEMA }, { path: 'graphql/mutations.graphqls', content: EXT }] }
    : {}).build(CODE);

describe('GraphQL projection through the builder', () => {
  it('binds the TypeScript and Python resolvers to the operations they resolve', async () => {
    const result = await build(true);
    const ops = [...result.nodes.values()].filter(n => n.language === 'GraphQL' && n.name.includes('.'));
    expect(ops.map(n => n.name).sort()).toEqual([
      'Mutation.cancelOrder', 'Mutation.placeOrder', 'Query.order', 'Query.orders', 'Query.search',
    ]);
    const bound = result.edges
      .filter(e => e.kind === 'implements_endpoint')
      .map(e => `${result.nodes.get(e.callerId)!.filePath} ${result.nodes.get(e.callerId)!.name} -> ${result.nodes.get(e.calleeId)!.name}`)
      .sort();
    expect(bound).toEqual([
      'app/schema.py resolve_cancel -> Mutation.cancelOrder',
      'app/schema.py resolve_search -> Query.search',
      'src/orders.ts getOrder -> Mutation.placeOrder',
      'src/resolvers.ts listOrders -> Query.orders',
    ]);
    // The test file's resolver map binds nothing.
    expect(result.edges.some(e => e.kind === 'implements_endpoint' && e.callerId.includes('resolvers.test.ts'))).toBe(false);
    // The inline arrow is disclosed, not guessed.
    expect(result.contracts?.unresolvedResolvers.items).toEqual([
      expect.objectContaining({ file: 'src/resolvers.ts', root: 'Query', field: 'order', reason: 'inline-implementation' }),
    ]);
    expect(result.contracts?.unboundGraphqlOperations.items).toEqual([expect.stringMatching(/^Query\.order \(graphql\/schema\.graphql:2\)$/)]);
  });

  it('draws references_schema edges between the projected declarations', async () => {
    const result = await build(true);
    const refs = result.edges.filter(e => e.kind === 'references_schema').map(e => `${result.nodes.get(e.callerId)?.name} -> ${result.nodes.get(e.calleeId)?.name}`);
    expect(refs.sort()).toEqual([
      'Mutation.cancelOrder -> Order', 'Mutation.placeOrder -> Order',
      'Query.order -> Order', 'Query.orders -> Order', 'Query.search -> Order',
    ]);
  });

  it('leaves code fan-in, fan-out, hubs, entry points and averages untouched', async () => {
    const withSchema = await build(true);
    const bare = await build(false);
    const metrics = (r: Awaited<ReturnType<typeof build>>) =>
      [...r.nodes.values()].filter(n => n.language !== 'GraphQL').map(n => `${n.id} ${n.fanIn}/${n.fanOut}`).sort();
    expect(metrics(withSchema)).toEqual(metrics(bare));
    expect(withSchema.hubFunctions.some(n => n.language === 'GraphQL')).toBe(false);
    expect(withSchema.entryPoints.some(n => n.language === 'GraphQL')).toBe(false);
    expect(withSchema.entryPoints.map(n => n.id).sort()).toEqual(bare.entryPoints.map(n => n.id).sort());
    expect(withSchema.stats.avgFanIn).toBe(bare.stats.avgFanIn);
    expect(withSchema.stats.avgFanOut).toBe(bare.stats.avgFanOut);
    // No GraphQL node or edge without a schema in hand.
    expect([...bare.nodes.values()].some(n => n.language === 'GraphQL')).toBe(false);
    expect(bare.edges.some(e => e.kind === 'implements_endpoint')).toBe(false);
  });

  it('a client document is set aside, and resolver maps bind nothing without a schema', async () => {
    const result = await new CallGraphBuilder({ contractFiles: [{ path: 'web/ops.graphql', content: 'query Q { orders { id } }' }] }).build(CODE);
    expect([...result.nodes.values()].some(n => n.language === 'GraphQL')).toBe(false);
    expect(result.edges.some(e => e.kind === 'implements_endpoint')).toBe(false);
    expect(result.contracts?.skippedCandidates.items).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'web/ops.graphql' })]));
  });

  it('a class method of the imported name is never the resolver (round-3 review)', async () => {
    const code = [
      { path: 'src/orders.ts', language: 'TypeScript', content: 'export const getOrder = authorized(() => repo.getOrder());\nclass OrderRepo { getOrder() { return 1; } }\n' },
      { path: 'src/resolvers.ts', language: 'TypeScript', content: "import { getOrder } from './orders';\nexport const resolvers = { Query: { order: getOrder } };\n" },
    ];
    const result = await new CallGraphBuilder({ contractFiles: [{ path: 'schema.graphql', content: 'type Query { order: Int }' }] }).build(code);
    expect(result.edges.filter(e => e.kind === 'implements_endpoint')).toEqual([]);
    expect(result.contracts?.unresolvedResolvers.items).toEqual([expect.objectContaining({ field: 'order', reason: 'implementation-not-found' })]);
  });

  it('a literal the map does not resolve to a function never binds a same-named function (round-4 review)', async () => {
    const code = [
      { path: 'src/r.ts', language: 'TypeScript', content: 'function find() { return 1; }\nconst repo = makeRepo();\nexport const resolvers = { Query: { find: repo.find } };\n' },
      { path: 'app/s.py', language: 'Python', content: 'from ariadne import QueryType\nquery = QueryType()\ndef make_resolver():\n    return None\nquery.set_field("orders", make_resolver())\n' },
    ];
    const result = await new CallGraphBuilder({ contractFiles: [{ path: 'schema.graphql', content: 'type Query { find: Int orders: Int }' }] }).build(code);
    expect(result.edges.filter(e => e.kind === 'implements_endpoint')).toEqual([]);
    expect(result.contracts?.unresolvedResolvers.items.map(u => `${u.field} ${u.reason}`).sort()).toEqual(['find implementation-not-found', 'orders implementation-not-found']);
  });

  it('a gRPC handler that is a member of a local object binds nothing (round-4 review)', async () => {
    const code = [{ path: 'srv/server.js', language: 'JavaScript', content: 'function getOrder() {}\nconst impl = new OrderImpl();\nfunction main() { server.addService(proto.orders.v1.OrderService.service, { getOrder: impl.getOrder }); }\n' }];
    const result = await new CallGraphBuilder({ contractFiles: [{ path: 'orders.proto', content: 'syntax = "proto3";\npackage orders.v1;\nmessage M {}\nservice OrderService { rpc GetOrder(M) returns (M); }\n' }] }).build(code);
    expect(result.edges.filter(e => e.kind === 'implements_endpoint')).toEqual([]);
    expect(result.contracts?.unresolvedRegistrations.items).toEqual([expect.objectContaining({ rpc: 'GetOrder', reason: 'implementation-not-found' })]);
  });

  it('a map beside an inline schema serves that schema; a fixture .proto is still read (round-4 e2e review)', async () => {
    const code = [
      { path: 'apps/a/resolvers.ts', language: 'TypeScript', content: 'function me() {}\nexport const resolvers = { RootQuery: { me } };\n' },
      { path: 'apps/b/typeDefs.ts', language: 'TypeScript', content: 'export const typeDefs = gql`type RootQuery { me: String }`;\n' },
      { path: 'apps/b/resolvers.ts', language: 'TypeScript', content: 'function meB() {}\nexport const resolvers = { RootQuery: { me: meB } };\n' },
      { path: 'cmd/main.go', language: 'Go', content: 'package main\n\ntype echoServer struct{}\n\nfunc (e *echoServer) Say() {}\n\nfunc main() {\n\tpb.RegisterEchoServer(s, &echoServer{})\n}\n' },
    ];
    const result = await new CallGraphBuilder({ contractFiles: [
      { path: 'apps/a/schema.graphql', content: 'schema { query: RootQuery }\ntype RootQuery { me: Int }' },
      { path: 'e2e/echo.proto', content: 'syntax = "proto3";\npackage echo;\nmessage M {}\nservice Echo { rpc Say(M) returns (M); }\n' },
    ] }).build(code);
    const edges = result.edges.filter(e => e.kind === 'implements_endpoint').map(e => `${e.callerId} -> ${e.calleeId}`).sort();
    expect(edges).toEqual(['apps/a/resolvers.ts::me -> apps/a/schema.graphql::RootQuery.me', 'cmd/main.go::echoServer.Say -> e2e/echo.proto::/echo.Echo/Say']);
  });
});

describe('GraphQL projection through the builder: schema universes (change: scope-graphql-schema-universes)', () => {
  // Two packages, each with its own `type Query` and its own resolver map — the shape every
  // monorepo has, and the one that used to void both schemas.
  const A_SDL = 'type Query { order(id: ID!): Order }\ntype Order { id: ID! }\n';
  const B_SDL = 'type Query { ping: Boolean! }\ntype Order { sku: String! }\n';
  const A_TS = "export function getOrder(id: string) { return { id }; }\nexport const resolvers = { Query: { order: getOrder } };\n";
  const B_TS = 'export function ping() { return true; }\nexport const resolvers = { Query: { ping } };\n';

  const monorepo = (projectRoots?: string[]) => new CallGraphBuilder({
    contractFiles: [
      { path: 'packages/a/schema.graphql', content: A_SDL },
      { path: 'packages/b/schema.graphql', content: B_SDL },
    ],
    ...(projectRoots ? { projectRoots } : {}),
  }).build([
    { path: 'packages/a/src/resolvers.ts', content: A_TS, language: 'TypeScript' },
    { path: 'packages/b/src/resolvers.ts', content: B_TS, language: 'TypeScript' },
  ]);

  it('projects and binds both packages when each is its own project', async () => {
    const result = await monorepo(['packages/a', 'packages/b']);
    const ops = [...result.nodes.values()].filter(n => n.language === 'GraphQL' && n.name.includes('.'));
    expect(ops.map(n => `${n.name} ${n.filePath}`).sort()).toEqual([
      'Query.order packages/a/schema.graphql', 'Query.ping packages/b/schema.graphql',
    ]);
    const bound = result.edges.filter(e => e.kind === 'implements_endpoint')
      .map(e => `${result.nodes.get(e.callerId)!.name} -> ${result.nodes.get(e.calleeId)!.filePath}::${result.nodes.get(e.calleeId)!.name}`).sort();
    expect(bound).toEqual([
      'getOrder -> packages/a/schema.graphql::Query.order',
      'ping -> packages/b/schema.graphql::Query.ping',
    ]);
    // Each `type Order` is its own node; neither voids the other.
    expect([...result.nodes.values()].filter(n => n.language === 'GraphQL' && n.name === 'Order').map(n => n.filePath).sort())
      .toEqual(['packages/a/schema.graphql', 'packages/b/schema.graphql']);
    expect(result.contracts?.notAssessed ?? []).toEqual([]);
  });

  it('with no project roots both are voided — the behavior this change fixes', async () => {
    const result = await monorepo();
    expect([...result.nodes.values()].some(n => n.language === 'GraphQL')).toBe(false);
    expect(result.contracts?.notAssessed ?? []).toEqual(expect.arrayContaining([
      expect.stringContaining('root type Query is defined in more than one file'),
    ]));
  });
});
