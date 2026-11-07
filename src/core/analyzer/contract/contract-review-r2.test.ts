/**
 * Regressions from the second review round of the GraphQL reader (PR #688): barrel re-exports,
 * `.ts` specifiers, directive ambiguity, client and mock files, inline SDL, Relay schema copies.
 */
import { describe, it, expect } from 'vitest';
import { importTargets } from './grpc-registration.js';
import { scanResolverMaps } from './graphql-resolvers.js';
import { readGraphql, mergeGraphqlSchema, relaySchemaPaths, type GqlDocument } from './graphql.js';
import { diffGraphql } from '../../services/contract/graphql-diff.js';

const files = (m: Record<string, string>) => ({ list: Object.keys(m), get: (f: string) => m[f] });

describe('importTargets: one level of re-export', () => {
  it('follows `export *` and `export { x as y } from` through a barrel index', () => {
    const repo = files({
      'src/handlers/index.ts': "export * from './feature';\nexport { listAll as listFeatures } from './list';\n",
      'src/handlers/feature.ts': 'export function getFeature() {}',
      'src/handlers/list.ts': 'export function listAll() {}',
    });
    const t = (name: string) => importTargets('src/server.ts', './handlers', name, 'node', repo.list, repo.get);
    expect(t('getFeature')).toEqual(expect.arrayContaining([{ file: 'src/handlers/feature.ts', name: 'getFeature' }]));
    expect(t('listFeatures')).toEqual(expect.arrayContaining([{ file: 'src/handlers/list.ts', name: 'listAll' }]));
  });

  it('resolves a `.ts` specifier and a Python package re-export', () => {
    const js = files({ 'src/feature.ts': '' });
    expect(importTargets('src/server.ts', './feature.ts', 'x', 'node', js.list, js.get)).toEqual([{ file: 'src/feature.ts', name: 'x' }]);
    const py = files({ 'app/resolvers/__init__.py': 'from .orders import resolve_order\n', 'app/resolvers/orders.py': '' });
    expect(importTargets('app/schema.py', 'app.resolvers', 'resolve_order', 'python', py.list, py.get))
      .toEqual(expect.arrayContaining([{ file: 'app/resolvers/orders.py', name: 'resolve_order' }]));
  });
});

describe('scanResolverMaps: round-2 shapes', () => {
  const roots = ['Query', 'Mutation', 'Subscription'];
  it('a server file that imports graphql-request (or a client type) is still read', () => {
    const src = "import { GraphQLClient } from 'graphql-request';\nimport type { ApolloClient } from '@apollo/client';\nfunction getOrder() {}\nexport const resolvers = { Query: { order: getOrder } };\n";
    expect(scanResolverMaps('src/schema.ts', src, roots).map(m => m.entries.map(e => e.fn))).toEqual([['getOrder']]);
  });
  it('`const Query = {}` in a resolver-named path binds; enum-like values are not resolver maps', () => {
    expect(scanResolverMaps('src/resolvers/Query.ts', "import { getOrder } from '../services/orders';\nexport const Query = { order: getOrder };\n", roots)).toHaveLength(1);
    expect(scanResolverMaps('src/ops.ts', 'const kinds = { Query: OperationTypeNode.QUERY, Mutation: true };\n', roots)).toEqual([]);
  });
  it('`subscribe` binds wherever it sits in the subscription object', () => {
    const src = 'function sub() {}\nexport const resolvers = { Subscription: { orderCreated: { resolve: (x) => x, subscribe: sub } } };\n';
    expect(scanResolverMaps('src/resolvers.ts', src, roots)[0].entries).toEqual([expect.objectContaining({ field: 'orderCreated', fn: 'sub' })]);
  });
  it('a file with its own inline SDL, a mock file, and an msw file are not this schema\'s resolvers', () => {
    expect(scanResolverMaps('appB/server.ts', 'const typeDefs = `type Query { user: String }`;\nfunction f() {}\ncreateSchema({ typeDefs, resolvers: { Query: { user: f } } });\n', roots)).toEqual([]);
    expect(scanResolverMaps('app.py', 'type_defs = gql("""\n  type Query { user: String }\n""")\nquery = QueryType()\n@query.field("user")\ndef r(*_): ...\n', roots)).toEqual([]);
    expect(scanResolverMaps('src/client/mocks.ts', 'function m() {}\nexport const mocks = { Query: { legacy: m } };\n', roots)).toEqual([]);
    expect(scanResolverMaps('src/handlers.ts', "import { graphql } from 'msw';\nfunction m() {}\nconst resolvers = { Query: { a: m } };\n", roots)).toEqual([]);
  });
});

describe('GraphQL schema: round-2 semantics', () => {
  const ok = (file: string, text: string) => { const r = readGraphql(file, text); if (!('types' in r)) throw new Error(JSON.stringify(r)); return r as GqlDocument; };
  it('a directive defined again in a second file is not reported removed', () => {
    const base = mergeGraphqlSchema([ok('schema.graphql', 'directive @auth(role: String) on FIELD_DEFINITION\ntype Query { a: Int }')]);
    const head = mergeGraphqlSchema([ok('schema.graphql', 'directive @auth(role: String) on FIELD_DEFINITION\ntype Query { a: Int }'), ok('gen/d.graphql', 'directive @auth(role: String) on FIELD_DEFINITION')]);
    const d = diffGraphql(base, head);
    expect(d.map(c => c.rule)).toEqual(['schema-unassessed']);
    expect(d.some(c => c.class === 'breaking')).toBe(false);
  });
  it('Apollo local state (types beside `@client` operations) is a client document', () => {
    expect(readGraphql('src/local.graphql', 'extend type Query { isLoggedIn: Boolean! }\nquery IsUserLoggedIn { isLoggedIn @client }\n')).toEqual({ file: 'src/local.graphql', clientDocument: true });
  });
  it('the schema a Relay config names is the compiler\'s copy', () => {
    expect([...relaySchemaPaths([{ path: 'package.json', content: '{"relay": {"src": "./src", "schema": "./schema/schema.graphql"}}' }])]).toEqual(['schema/schema.graphql']);
    expect([...relaySchemaPaths([{ path: 'web/relay.config.js', content: "module.exports = { schema: './data/schema.graphql' };" }])]).toEqual(['web/data/schema.graphql']);
    // A path climbing out of the Relay project names someone else's schema — often this repository's
    // own server — and is never dropped on the config's say-so (round-3 security review).
    expect([...relaySchemaPaths([{ path: 'web/relay.config.js', content: "module.exports = { schema: '../api/schema.graphql' };" }])]).toEqual([]);
    expect([...relaySchemaPaths([{ path: 'package.json', content: '{"relay":{"schema":"../../../schema.graphql"}}' }])]).toEqual([]);
  });
});

describe('round-3 review', () => {
  const roots = ['Query', 'Mutation', 'Subscription'];
  it('a member of a local object is not followed; middleware and shield maps are not resolvers', () => {
    const m = scanResolverMaps('src/resolvers.ts', 'const repo = {};\nfunction find() {}\nexport const resolvers = { Query: { lookup: repo.find } };\n', roots);
    expect(m[0].entries).toEqual([expect.objectContaining({ field: 'lookup', notFollowed: expect.stringContaining('member of `repo`') })]);
    expect(scanResolverMaps('src/permissions.ts', "import { applyMiddleware } from 'graphql-middleware';\nconst logInput = async () => {};\nexport const middleware = { Query: { search: logInput } };\n", roots)).toEqual([]);
    expect(scanResolverMaps('src/perm.ts', 'function isAuthenticated() {}\nexport const permissions = shield({ Query: { orders: isAuthenticated } });\n', roots)).toEqual([]);
  });
  it('a Python decorator naming its field with a variable is disclosed', () => {
    const r = scanResolverMaps('app.py', 'query = QueryType()\nFIELD = "x"\n@query.field(FIELD)\ndef r(*_): ...\n', roots);
    expect(r).toEqual([expect.objectContaining({ notLiteral: expect.stringContaining('variable') })]);
  });
  it('one hostile barrel resolves in linear time', () => {
    const list = Array.from({ length: 2_000 }, (_, i) => `src/m${i}.ts`);
    const barrel = Array.from({ length: 300 }, () => `export { ${Array.from({ length: 180 }, () => 'a as h0').join(', ')} } from "./m1";`).join('\n');
    const content: Record<string, string> = { 'src/barrel/index.ts': barrel };
    const t = Date.now();
    importTargets('src/resolvers.ts', './barrel', 'h0', 'node', [...list, 'src/barrel/index.ts'], f => content[f]);
    expect(Date.now() - t).toBeLessThan(2_000);
  });
});
