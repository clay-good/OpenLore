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
});
