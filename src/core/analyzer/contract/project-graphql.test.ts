/**
 * GraphQL projection (change: add-contract-graph-projection, GraphQL phase).
 *
 * Drives `projectGraphql` directly and through `projectContracts`: the operation and type nodes,
 * the `references_schema` and `implements_endpoint` edges, and every refusal it must disclose
 * instead of guessing — a map that is not literal, a field the schema lacks, an inline or
 * ambiguous implementation, a function that is not there, an unread file, a client document.
 */
import { describe, it, expect } from 'vitest';
import { projectGraphql, GRAPHQL_RESOLVER_BINDING, MAX_GRAPHQL_FILES, type GraphqlProjectionInput } from './project-graphql.js';
import { projectContracts, contractDisclosure, type ContractProjectionInput } from './project.js';
import type { ResolverMap } from './graphql-resolvers.js';
import type { FunctionNode } from '../call-graph-types.js';

const SCHEMA = `schema { query: Query, mutation: Mutation }

type Query {
  order(id: ID!): Order
  orders(filter: OrderFilter, first: Int = 10): [Order!]!
  search(term: String!): [SearchResult!]!
  me: User
}

type Mutation {
  cancelOrder(id: ID!): Order @deprecated(reason: "use updateOrder")
}

type Order implements Node {
  id: ID!
  status: Status!
  owner: User
  money: Money
}
type User implements Node { id: ID! }
interface Node { id: ID! }
input OrderFilter { status: Status, ids: [ID!] }
enum Status { OPEN CLOSED }
union SearchResult = Order | User
scalar DateTime
`;
const EXT = `extend type Query { health: Boolean! }
extend type Order { createdAt: DateTime }
`;

function fn(id: string, partial: Partial<FunctionNode> = {}): FunctionNode {
  const [filePath, name] = id.split('::');
  return { id, name, filePath, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, startLine: 7, endLine: 9, ...partial };
}

const CODE = [
  fn('src/resolvers.ts::getOrder'),
  fn('src/resolvers.ts::listOrders'),
  fn('src/orders/service.ts::cancel', { startLine: 30 }),
  fn('src/a.ts::dup'), fn('src/b.ts::dup'),
];
const byName = (code: FunctionNode[]) => (_map: ResolverMap, name: string) => code.filter(n => n.name === name);

const map = (partial: Partial<ResolverMap> = {}): ResolverMap => ({
  file: 'src/resolvers.ts', line: 3, runtime: 'node', root: 'Query',
  entries: [{ field: 'order', fn: 'getOrder', line: 4 }, { field: 'orders', fn: 'listOrders', line: 5 }],
  ...partial,
});

function direct(partial: Partial<GraphqlProjectionInput> = {}, maps: ResolverMap[] = [map()]) {
  return projectGraphql({
    files: [{ path: 'graphql/schema.graphql', content: SCHEMA }, { path: 'graphql/ext.graphql', content: EXT }],
    resolverMaps: () => maps,
    resolveImplementation: byName(CODE),
    ...partial,
  });
}

const edgesOf = (p: { edges: Array<{ callerId: string; calleeId: string; kind?: string }> }, kind: string) =>
  p.edges.filter(e => e.kind === kind).map(e => `${e.callerId} -> ${e.calleeId}`).sort();

describe('projectGraphql: nodes', () => {
  it('projects one node per root field and per non-root type, extensions folded in', () => {
    const p = direct();
    expect(p.nodes.map(n => n.name).sort()).toEqual([
      'DateTime', 'Mutation.cancelOrder', 'Node', 'Order', 'OrderFilter',
      'Query.health', 'Query.me', 'Query.order', 'Query.orders', 'Query.search',
      'SearchResult', 'Status', 'User',
    ]);
    const n = Object.fromEntries(p.nodes.map(x => [x.name, x]));
    expect(n['Query.order']).toMatchObject({ id: 'graphql/schema.graphql::Query.order', filePath: 'graphql/schema.graphql', language: 'GraphQL', startLine: 4, signature: 'query order(id: ID!): Order' });
    expect(n['Query.orders'].signature).toBe('query orders(filter: OrderFilter, first: Int): [Order!]!');
    expect(n['Mutation.cancelOrder'].signature).toBe('mutation cancelOrder(id: ID!): Order');
    // A field added by `extend` in another file lives in that file.
    expect(n['Query.health']).toMatchObject({ filePath: 'graphql/ext.graphql', startLine: 1 });
    expect(n.Order).toMatchObject({ id: 'graphql/schema.graphql::Order', signature: 'type Order' });
    expect(n.OrderFilter.signature).toBe('input OrderFilter');
    expect(n.SearchResult.signature).toBe('union SearchResult');
    expect(p.nodes.every(x => x.fanIn === 0 && x.fanOut === 0 && x.language === 'GraphQL')).toBe(true);
    expect(p.unreadSpecifications).toEqual([]);
    expect(p.notAssessed).toEqual([]);
  });

  it('a renamed root type is projected under the schema block\'s names', () => {
    const p = direct({ files: [{ path: 's.graphql', content: 'schema { query: RootQuery }\ntype RootQuery { a: Int }\ntype Query { notRoot: Int }' }] }, []);
    expect(p.nodes.map(n => n.name).sort()).toEqual(['Query', 'RootQuery.a']);
  });

  it('is deterministic whatever the file order', () => {
    const a = direct();
    const b = direct({ files: [{ path: 'graphql/ext.graphql', content: EXT }, { path: 'graphql/schema.graphql', content: SCHEMA }] });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('projectGraphql: references_schema', () => {
  it('links operations to their argument and result types, and types to the types they name', () => {
    const refs = edgesOf(direct(), 'references_schema');
    const s = (from: string, to: string, f = 'graphql/schema.graphql') => `${f}::${from} -> graphql/schema.graphql::${to}`;
    expect(refs).toEqual([
      s('Mutation.cancelOrder', 'Order'),
      s('Order', 'DateTime'),
      s('Order', 'Node'),
      s('Order', 'Status'),
      s('Order', 'User'),
      s('OrderFilter', 'Status'),
      s('Query.me', 'User'),
      s('Query.order', 'Order'),
      s('Query.orders', 'Order'),
      s('Query.orders', 'OrderFilter'),
      s('Query.search', 'SearchResult'),
      s('SearchResult', 'Order'),
      s('SearchResult', 'User'),
      s('User', 'Node'),
    ].sort());
    // Built-in scalars draw nothing; `Money` is defined nowhere and is counted in a note.
    expect(direct().notes).toEqual(expect.arrayContaining([expect.stringMatching(/^1 GraphQL type reference\(s\) name a type no file read defines/)]));
  });

  it('a type defined in two files is ambiguous: no node, no edge, a note', () => {
    const p = direct({ files: [
      { path: 'a/schema.graphql', content: 'type Query { order: Order }\ntype Order { id: ID }' },
      { path: 'b/schema.graphql', content: 'type Order { sku: String }' },
    ] }, []);
    expect(p.nodes.map(n => n.name)).toEqual(['Query.order']);
    expect(edgesOf(p, 'references_schema')).toEqual([]);
    expect(p.notes).toEqual(expect.arrayContaining([expect.stringContaining('1 GraphQL type(s) are defined in more than one file (Order)')]));
  });

  it('names constructs outside the model, orphan extensions and conflicts in notes', () => {
    const p = direct({ files: [
      { path: 's.graphql', content: 'type Query @key(fields: "id") { a: Int }\nextend type Ghost { x: Int }' },
      { path: 't.graphql', content: 'extend type Query { a: String }' },
    ] }, []);
    expect(p.notes).toEqual(expect.arrayContaining([
      'GraphQL constructs outside the model were not read: @key',
      '1 `extend` definition(s) extend a type no file read defines',
      'field `Query.a` is declared twice (an extension in t.graphql)',
    ]));
  });
});

describe('projectGraphql: implements_endpoint from resolver maps', () => {
  it('binds the functions a literal map names, marked as a resolver binding', () => {
    const p = direct();
    const bound = p.edges.filter(e => e.kind === 'implements_endpoint');
    expect(bound.map(e => `${e.callerId} -> ${e.calleeId}`).sort()).toEqual([
      'src/resolvers.ts::getOrder -> graphql/schema.graphql::Query.order',
      'src/resolvers.ts::listOrders -> graphql/schema.graphql::Query.orders',
    ]);
    expect(bound.every(e => e.synthesizedBy === GRAPHQL_RESOLVER_BINDING && e.line === 7)).toBe(true);
    expect(p.unresolvedResolvers).toEqual([]);
    expect(p.unboundOperations).toEqual([
      'Mutation.cancelOrder (graphql/schema.graphql:11)',
      'Query.health (graphql/ext.graphql:1)',
      'Query.me (graphql/schema.graphql:7)',
      'Query.search (graphql/schema.graphql:6)',
    ]);
  });

  it('passes only the root names the schema defines to the scan', () => {
    let asked: readonly string[] = [];
    direct({ resolverMaps: roots => { asked = roots; return []; } });
    expect([...asked].sort()).toEqual(['Mutation', 'Query']);
  });

  it('discloses every entry it cannot bind, with why', () => {
    const p = direct({}, [
      map({ entries: [
        { field: 'order', line: 4 },
        { field: 'nope', fn: 'getOrder', line: 5 },
        { field: '__resolveType', fn: 'getOrder', line: 6 },
        { field: 'me', fn: 'dup', line: 7 },
        { field: 'search', fn: 'missing', line: 8 },
        { field: 'health', fn: 'cancel', line: 9 },
      ] }),
      map({ file: 'src/other.ts', line: 1, root: 'Mutation', entries: [], notLiteral: 'the resolver object has a spread or a computed key' }),
    ]);
    expect(p.unresolvedResolvers).toEqual([
      { file: 'src/other.ts', line: 1, root: 'Mutation', reason: 'not-literal', detail: 'the resolver object has a spread or a computed key' },
      { file: 'src/resolvers.ts', line: 4, root: 'Query', field: 'order', reason: 'inline-implementation' },
      { file: 'src/resolvers.ts', line: 5, root: 'Query', field: 'nope', reason: 'unknown-field' },
      { file: 'src/resolvers.ts', line: 7, root: 'Query', field: 'me', reason: 'implementation-not-found', detail: '`dup` is neither defined in src/resolvers.ts nor imported by it' },
      { file: 'src/resolvers.ts', line: 8, root: 'Query', field: 'search', reason: 'implementation-not-found', detail: '`missing` is neither defined in src/resolvers.ts nor imported by it' },
      { file: 'src/resolvers.ts', line: 9, root: 'Query', field: 'health', reason: 'implementation-not-found', detail: '`cancel` is neither defined in src/resolvers.ts nor imported by it' },
    ]);
    expect(p.edges.some(e => e.kind === 'implements_endpoint')).toBe(false);
    expect(p.unboundOperations).toHaveLength(6);
  });

  it('an imported name is looked for outside the file, and refused when more than one matches', () => {
    const p = direct({}, [map({ entries: [
      { field: 'health', fn: 'cancel', imported: true, line: 9 },
      { field: 'me', fn: 'dup', imported: true, line: 7 },
      { field: 'search', fn: 'gone', imported: true, line: 8 },
    ] })]);
    expect(edgesOf(p, 'implements_endpoint')).toEqual(['src/orders/service.ts::cancel -> graphql/ext.graphql::Query.health']);
    expect(p.edges.find(e => e.kind === 'implements_endpoint')!.line).toBe(30);
    expect(p.unresolvedResolvers.map(u => `${u.field} ${u.reason}${u.detail ? `: ${u.detail}` : ''}`)).toEqual([
      'me ambiguous-implementation: more than one `dup`',
      'search implementation-not-found: `gone` is imported by src/resolvers.ts from a module that is not indexed here',
    ]);
  });

  it('a function in the map\'s own file wins over a same-named import elsewhere', () => {
    const code = [...CODE, fn('src/elsewhere.ts::getOrder')];
    const p = direct({ resolveImplementation: byName(code) }, [map({ entries: [{ field: 'order', fn: 'getOrder', imported: true, line: 4 }] })]);
    expect(edgesOf(p, 'implements_endpoint')).toEqual(['src/resolvers.ts::getOrder -> graphql/schema.graphql::Query.order']);
  });

  it('a map for a root type that is a client-visible name but not a root binds nothing', () => {
    const p = direct({}, [map({ root: 'Order', entries: [{ field: 'id', fn: 'getOrder', line: 4 }] })]);
    expect(p.edges.some(e => e.kind === 'implements_endpoint')).toBe(false);
  });

  it('two maps binding one operation draw two edges, never a duplicate', () => {
    const p = direct({}, [map(), map(), map({ file: 'src/b.ts', entries: [{ field: 'order', fn: 'dup', line: 2 }] })]);
    expect(edgesOf(p, 'implements_endpoint')).toEqual([
      'src/b.ts::dup -> graphql/schema.graphql::Query.order',
      'src/resolvers.ts::getOrder -> graphql/schema.graphql::Query.order',
      'src/resolvers.ts::listOrders -> graphql/schema.graphql::Query.orders',
    ]);
  });

  it('a resolver scan that throws is disclosed, not fatal', () => {
    const p = direct({ resolverMaps: () => { throw new Error('boom\nstack'); } });
    expect(p.notAssessed).toEqual(['the resolver scan failed: boom']);
    expect(p.nodes.length).toBeGreaterThan(0);
  });
});

describe('projectGraphql: unread files and client documents', () => {
  it('an unreadable schema file is listed and withholds nothing it cannot', () => {
    const p = direct({ files: [{ path: 'graphql/schema.graphql', content: SCHEMA }, { path: 'graphql/bad.graphql', content: 'type X { "secret-text" ' }] });
    expect(p.unreadSpecifications).toEqual([{ file: 'graphql/bad.graphql', reason: expect.stringMatching(/^line 1: /) }]);
    expect(p.unreadSpecifications[0].reason).not.toContain('secret-text');
    expect(p.notAssessed).toEqual(['1 GraphQL schema file(s) could not be read']);
  });

  it('a client document is set aside, never projected', () => {
    const p = direct({ files: [{ path: 'web/queries.graphql', content: 'query Q { order(id: 1) { id } }' }] });
    expect(p.clientDocuments).toEqual(['web/queries.graphql']);
    expect(p.nodes).toEqual([]);
    expect(p.unreadSpecifications).toEqual([]);
  });

  it('nothing is read from no schema', () => {
    let called = false;
    const p = direct({ files: [], resolverMaps: () => { called = true; return []; } });
    expect(called).toBe(false);
    expect(p.nodes).toEqual([]);
  });
});

describe('projectGraphql: caps', () => {
  it('stops at the operation cap and discloses it', () => {
    const fields = Array.from({ length: 2_005 }, (_, i) => `f${i}: Int`).join('\n');
    const p = direct({ files: [{ path: 's.graphql', content: `type Query {\n${fields}\n}` }] }, []);
    expect(p.nodes).toHaveLength(2_000);
    expect(p.truncations).toEqual([{ reason: 'operation-cap', cap: 2_000, seen: 2_005 }]);
    expect(p.notAssessed).toEqual(['5 GraphQL operation(s) past the cap were not projected']);
  });

  it('stops at the type cap and discloses it', () => {
    const types = Array.from({ length: 4_003 }, (_, i) => `type T${String(i).padStart(5, '0')} { a: Int }`).join('\n');
    const p = direct({ files: [{ path: 's.graphql', content: types }] }, []);
    expect(p.nodes).toHaveLength(4_000);
    expect(p.truncations).toEqual([{ reason: 'schema-cap', cap: 4_000, seen: 4_003 }]);
  });
});

describe('projectGraphql through projectContracts', () => {
  function viaContracts(partial: Partial<ContractProjectionInput> = {}, maps: ResolverMap[] = [map()]) {
    return projectContracts({
      files: [{ path: 'graphql/schema.graphql', content: SCHEMA }, { path: 'graphql/ext.graphql', content: EXT }],
      routes: [], calls: [],
      resolveHandler: () => undefined, resolveCaller: () => undefined,
      graphqlResolverMaps: () => maps,
      resolveGraphqlImplementation: byName(CODE),
      ...partial,
    });
  }

  it('merges GraphQL nodes, edges and disclosures in', () => {
    const p = viaContracts();
    expect(p.nodes.filter(n => n.language === 'GraphQL')).toHaveLength(13);
    expect(edgesOf(p, 'implements_endpoint')).toHaveLength(2);
    expect(p.unboundGraphqlOperations.total).toBe(4);
    expect(p.unresolvedResolvers).toEqual({ items: [], total: 0 });
    expect(contractDisclosure(p)).toBeDefined();
    expect(p.notes).toEqual(expect.arrayContaining([expect.stringContaining('GraphQL type reference(s)')]));
  });

  it('a .graphql file is never sniffed as OpenAPI', () => {
    const p = viaContracts({ files: [{ path: 'graphql/openapi.graphql', content: 'openapi: 3.0.0\ntype Query { a: Int }' }] });
    expect(p.unreadSpecifications.items.map(u => u.file)).toEqual(['graphql/openapi.graphql']);
    expect(p.nodes.filter(n => n.language === 'OpenAPI')).toEqual([]);
  });

  it('lists a client document among the skipped candidates, with why', () => {
    const p = viaContracts({ files: [{ path: 'graphql/schema.graphql', content: SCHEMA }, { path: 'web/q.graphql', content: '{ me { id } }' }] });
    expect(p.skippedCandidates.items).toEqual(expect.arrayContaining([{ file: 'web/q.graphql', reason: expect.stringContaining('GraphQL client document') }]));
  });

  it('withholds unbound operations while a schema file is unread, but lists the unread file', () => {
    const p = viaContracts({ files: [{ path: 'graphql/schema.graphql', content: SCHEMA }, { path: 'graphql/bad.graphql', content: 'type {' }] }, []);
    expect(p.unboundGraphqlOperations).toEqual({ items: [], total: 0 });
    expect(p.unreadSpecifications.items.map(u => u.file)).toEqual(['graphql/bad.graphql']);
    expect(p.notAssessed).toEqual(expect.arrayContaining(['1 GraphQL schema file(s) could not be read']));
  });

  it('withholds unbound operations when GraphQL files were omitted by the caller', () => {
    const p = viaContracts({ graphqlFilesOmitted: 3 });
    expect(p.unboundGraphqlOperations.total).toBe(0);
    expect(p.notAssessed).toEqual(expect.arrayContaining(['3 GraphQL file(s) past the file cap were not read']));
    expect(p.truncations).toEqual(expect.arrayContaining([{ reason: 'graphql-file-cap', cap: MAX_GRAPHQL_FILES, seen: 5 }]));
  });

  it('stops at the GraphQL file cap and discloses it', () => {
    const files = Array.from({ length: MAX_GRAPHQL_FILES + 2 }, (_, i) => ({ path: `g/f${String(i).padStart(4, '0')}.graphql`, content: `type T${i} { a: Int }` }));
    const p = viaContracts({ files }, []);
    expect(p.nodes.filter(n => n.language === 'GraphQL')).toHaveLength(MAX_GRAPHQL_FILES);
    expect(p.truncations).toEqual(expect.arrayContaining([{ reason: 'graphql-file-cap', cap: MAX_GRAPHQL_FILES, seen: MAX_GRAPHQL_FILES + 2 }]));
  });

  it('an unreadable GraphQL file does not withhold OpenAPI or protobuf conclusions about routes', () => {
    const OPENAPI = 'openapi: 3.0.0\ninfo: {title: t, version: "1"}\npaths:\n  /a:\n    get:\n      responses: {"200": {description: ok}}\n';
    const p = viaContracts({ files: [{ path: 'api/openapi.yaml', content: OPENAPI }, { path: 'g/bad.graphql', content: 'type {' }] }, []);
    expect(p.unmatchedOperations.total).toBe(1);
  });
});
