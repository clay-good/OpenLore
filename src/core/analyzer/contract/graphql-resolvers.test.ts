/**
 * GraphQL resolver maps (change: add-contract-graph-projection, GraphQL phase).
 *
 * `scanResolverMaps` reads the one literal place a schema-first server names the function behind
 * each root field: a JS/TS resolver object, or Ariadne's bindables in Python. Only literal maps
 * count; a map written in a comment or a string is not read, an import is followed to the name it
 * was exported under, and a hostile file stays linear.
 */
import { describe, it, expect } from 'vitest';
import { scanResolverMaps, type ResolverMap } from './graphql-resolvers.js';

const ROOTS = ['Query', 'Mutation', 'Subscription'];
const scan = (file: string, content: string, roots: readonly string[] = ROOTS) => scanResolverMaps(file, content, roots);
const entries = (maps: ResolverMap[]) => maps.flatMap(m => m.entries.map(e => `${m.root}.${e.field} -> ${e.fn ?? '(inline)'}${e.imported ? ' [imported]' : ''}`));

describe('scanResolverMaps: JavaScript / TypeScript', () => {
  it('reads named functions, shorthand, methods, arrow functions and dotted names', () => {
    const src = `import { getOrder } from './orders';
function listOrders() { return []; }
export const resolvers = {
  Query: {
    order: getOrder,
    listOrders,
    count(parent, args) { return 1; },
    async latest() { return null; },
    inline: (p, a) => a.id,
    wrapped: withAuth(getOrder),
    dotted: services.orders.find,
  },
  Mutation: {
    cancel: cancelOrder,
  },
  Order: { total: o => o.total },
};
function cancelOrder() {}
`;
    const maps = scan('src/resolvers.ts', src);
    expect(maps.map(m => `${m.root}@${m.line}`)).toEqual(['Query@4', 'Mutation@13']);
    expect(entries(maps)).toEqual([
      'Query.order -> getOrder [imported]',
      'Query.listOrders -> listOrders',
      'Query.count -> count',
      'Query.latest -> latest',
      'Query.inline -> (inline)',
      'Query.wrapped -> (inline)',
      'Query.dotted -> find',
      'Mutation.cancel -> cancelOrder',
    ]);
    expect(maps.every(m => m.runtime === 'node' && m.file === 'src/resolvers.ts' && !m.notLiteral)).toBe(true);
  });

  it('reads a root object held in its own variable, typed or not, in a file about resolvers', () => {
    const src = 'export const Query: QueryResolvers<Ctx> = { order: getOrder };\nlet Mutation = { cancel };';
    expect(entries(scan('q.ts', `${src}\nexport const resolvers = { Query, Mutation };`))).toEqual([
      'Query.order -> getOrder', 'Mutation.cancel -> cancel',
    ]);
    // A file importing a GraphQL server package is about resolvers too.
    expect(entries(scan('q.ts', `import { ApolloServer } from '@apollo/server';\n${src}`))).toEqual([
      'Query.order -> getOrder', 'Mutation.cancel -> cancel',
    ]);
  });

  it('reads quoted keys', () => {
    expect(entries(scan('q.js', `const resolvers = { "Query": { "order": getOrder, 'orders': listOrders } };`))).toEqual([
      'Query.order -> getOrder', 'Query.orders -> listOrders',
    ]);
  });

  it('a quoted name in a comment inside a map does not break the map', () => {
    const maps = scan('q.js', 'const resolvers = { Query: {\n  order: getOrder, // "legacy": old\n  /* "x": y */ orders: listOrders,\n} };');
    expect(entries(maps)).toEqual(['Query.order -> getOrder', 'Query.orders -> listOrders']);
  });

  it('resolves an aliased import to the name it was exported under (ESM and CommonJS)', () => {
    const esm = `import { getOrder as go, listOrders } from './orders';\nimport * as ns from './ns';\nconst resolvers = { Query: { order: go, orders: listOrders, all: ns.findAll } };`;
    expect(entries(scan('a.ts', esm))).toEqual([
      'Query.order -> getOrder [imported]', 'Query.orders -> listOrders [imported]', 'Query.all -> findAll [imported]',
    ]);
    const cjs = `const { getOrder: go, listOrders } = require('./orders');\nconst svc = require('./svc');\nmodule.exports = { Query: { order: go, orders: listOrders, x: svc.find } };`;
    expect(entries(scan('a.js', cjs))).toEqual([
      'Query.order -> getOrder [imported]', 'Query.orders -> listOrders [imported]', 'Query.x -> find [imported]',
    ]);
  });

  it('a spread or a computed key makes the map not literal, never a partial map', () => {
    const spread = scan('a.ts', 'const resolvers = { Query: { ...baseQuery, order: getOrder } };');
    expect(spread).toEqual([{ file: 'a.ts', line: 1, runtime: 'node', root: 'Query', entries: [], notLiteral: expect.stringContaining('spread') }]);
    const computed = scan('a.ts', "const resolvers = { Query: { [name]: getOrder } };");
    expect(computed[0].notLiteral).toBeDefined();
    expect(computed[0].entries).toEqual([]);
  });

  it('an object that never closes within the bound is not literal', () => {
    const maps = scan('a.ts', `const resolvers = { Query: { order: getOrder, ${'x: y, '.repeat(20_000)}`);
    expect(maps).toEqual([expect.objectContaining({ root: 'Query', entries: [], notLiteral: 'the resolver object could not be read' })]);
  });

  it('does not read maps written in comments, strings or template literals', () => {
    const src = `// const resolvers = { Query: { order: getOrder } };
/* const Query = { order: getOrder }; */
const doc = "{ Query: { order: getOrder } }";
const tpl = \`const resolvers = { Query: { order: getOrder } }\`;
`;
    expect(scan('a.ts', src)).toEqual([]);
  });

  it('reads only the root names the schema has', () => {
    const src = 'const resolvers = { Query: { a: f }, RootQuery: { b: g }, Order: { c: h } };';
    expect(entries(scan('a.ts', src, ['RootQuery']))).toEqual(['RootQuery.b -> g']);
    expect(scan('a.ts', src, [])).toEqual([]);
    // A root name is matched whole, never as a prefix.
    expect(scan('a.ts', 'const resolvers = { QueryExtra: { a: f } };', ['Query'])).toEqual([]);
  });

  it('skips generated files and files of other languages', () => {
    const src = 'const resolvers = { Query: { order: getOrder } };';
    expect(scan('src/types.generated.ts', src)).toEqual([]);
    expect(scan('src/__generated__/resolvers.ts', src)).toEqual([]);
    expect(scan('src/resolvers.go', src)).toEqual([]);
    expect(scan('README.md', src)).toEqual([]);
    expect(scan('src/resolvers.mjs', src)).toHaveLength(1);
    expect(scan('src/resolvers.cts', src)).toHaveLength(1);
    expect(scan('src/Resolvers.TSX', src)).toHaveLength(1);
  });

  it('reports lines with CRLF line endings', () => {
    const maps = scan('a.ts', 'import x from "y";\r\n\r\nconst resolvers = {\r\n  Query: {\r\n    order: getOrder,\r\n  },\r\n};\r\n');
    expect(maps.map(m => m.line)).toEqual([4]);
    expect(entries(maps)).toEqual(['Query.order -> getOrder']);
  });
});

describe('scanResolverMaps: Python (Ariadne)', () => {
  const PY = `from ariadne import QueryType, MutationType, ObjectType
from .orders import resolve_list as list_orders, resolve_count
from .more import (
    resolve_a,
    resolve_b as rb,
)

query = QueryType()
mutation = ariadne.MutationType()
sub = ObjectType("Subscription")
order = ObjectType("Order")


@query.field("order")
@login_required
@other(arg=1)
async def resolve_order(obj, info, id):
    return None


@mutation.field('cancel')
def resolve_cancel(obj, info):
    pass


query.set_field("orders", list_orders)
query.set_field("count", resolve_count)
query.set_field("a", resolve_a)
query.set_field("b", rb)
query.set_field("inline", lambda obj, info: 1)
sub.set_field("events", local_events)
order.set_field("total", resolve_total)
# query.set_field("commented", resolve_x)
doc = 'query.set_field("instring", resolve_y)'
"""
@query.field("docstring")
def resolve_doc(): pass
"""
`;

  it('reads decorators and set_field, following imports and aliases', () => {
    const maps = scan('app/schema.py', PY);
    expect(maps.map(m => `${m.root}@${m.line}`)).toEqual(['Query@8', 'Mutation@9', 'Subscription@10']);
    expect(entries(maps)).toEqual([
      'Query.order -> resolve_order',
      'Query.orders -> resolve_list [imported]',
      'Query.count -> resolve_count [imported]',
      'Query.a -> resolve_a [imported]',
      'Query.b -> resolve_b [imported]',
      'Query.inline -> (inline)',
      'Mutation.cancel -> resolve_cancel',
      'Subscription.events -> local_events',
    ]);
    expect(maps.every(m => m.runtime === 'python')).toBe(true);
    expect(maps[0].entries[0].line).toBe(14);
  });

  it('reads nothing without a bindable for a schema root', () => {
    expect(scan('a.py', 'order = ObjectType("Order")\norder.set_field("x", f)')).toEqual([]);
    expect(scan('a.py', 'q = QueryType()\nq.set_field("x", f)', ['RootQuery'])).toEqual([]);
    expect(entries(scan('a.py', 'q = ObjectType("RootQuery")\nq.set_field("x", f)', ['RootQuery']))).toEqual(['RootQuery.x -> f']);
  });

  it('a decorator without a function after it records the field with no implementation', () => {
    const maps = scan('a.py', 'query = QueryType()\n@query.field("x")\nresolver = something\n');
    expect(entries(maps)).toEqual(['Query.x -> (inline)']);
  });

  it('a non-literal field name is not read', () => {
    expect(entries(scan('a.py', 'query = QueryType()\nquery.set_field(NAME, f)\n@query.field(name)\ndef r(): pass\n'))).toEqual([]);
  });
});

describe('scanResolverMaps: linear on hostile input', () => {
  const timed = (file: string, content: string) => {
    const t = performance.now();
    scan(file, content);
    return performance.now() - t;
  };

  it('a 4 MB file of almost-matches stays fast', () => {
    const n = 4 * 1024 * 1024;
    for (const [file, content] of [
      ['a.ts', `Query${' '.repeat(n)}`],
      ['a.ts', `const Query${' '.repeat(n)}`],
      ['a.ts', `const Query: ${'x'.repeat(n)}`],
      ['a.ts', `{${' ,'.repeat(n / 2)}Query`],
      ['a.ts', `Query ${'"a":'.repeat(n / 4)}`],
      ['a.ts', `Query ${"'".repeat(n)}`],
      ['a.ts', 'const r = { Query: { a: f } };\n'.repeat(n / 32)],
      ['a.py', `q = QueryType()\n${'q.set_field('.repeat(n / 12)}`],
      ['a.py', `q = QueryType()\n${'@q.field("x")\n'.repeat(n / 16)}`],
      ['a.py', `QueryType ${'a'.repeat(n)}`],
      ['a.py', `q = QueryType()\nfrom m import (${'a, '.repeat(n / 3)}`],
    ] as const) {
      expect(timed(file, content), `${file}: ${content.slice(0, 24)}`).toBeLessThan(4_000);
    }
  });

  it('caps the matches examined per file', () => {
    const maps = scan('a.ts', 'const r = { Query: { a: f } };\n'.repeat(1_500));
    // 1,000 maps read, then one not-literal receipt that names the cap.
    expect(maps).toHaveLength(1_001);
    expect(maps.slice(0, 1_000).every(m => !m.notLiteral && m.entries.length === 1)).toBe(true);
    expect(maps[1_000]).toEqual(expect.objectContaining({ line: 1_001, root: 'Query', entries: [], notLiteral: expect.stringContaining('more than 1000') }));
  });
});

describe('scanResolverMaps: imports carry their module', () => {
  it('a named import carries its specifier; a default or namespace import used directly is not followed', () => {
    const maps = scan('src/resolvers.ts', `import { getOrder as go } from './orders';
import handler from './handler';
import * as all from './all';
const { cancel } = require('../cancel');
export const resolvers = { Query: { order: go, h: handler, a: all, x: all.find }, Mutation: { cancel } };
`);
    expect(maps.flatMap(m => m.entries.map(({ line: _l, ...e }) => e))).toEqual([
      { field: 'order', fn: 'getOrder', imported: true, from: './orders' },
      { field: 'h', fn: 'handler', notFollowed: "`handler` is a default or namespace import of './handler', which is not followed" },
      { field: 'a', fn: 'all', notFollowed: "`all` is a default or namespace import of './all', which is not followed" },
      { field: 'x', fn: 'find', imported: true, from: './all' },
      { field: 'cancel', fn: 'cancel', imported: true, from: '../cancel' },
    ]);
  });

  it('a Python `from X import` carries the module it names', () => {
    const maps = scan('app/schema.py', 'from ariadne import QueryType\nfrom ..orders import resolve_order as ro\nfrom external_pkg import resolve_stats\nquery = QueryType()\nquery.set_field("order", ro)\nquery.set_field("stats", resolve_stats)\n');
    expect(maps[0].entries.map(({ line: _l, ...e }) => e)).toEqual([
      { field: 'order', fn: 'resolve_order', imported: true, module: '..orders' },
      { field: 'stats', fn: 'resolve_stats', imported: true, module: 'external_pkg' },
    ]);
  });

  it('Python `set_field` with a module attribute resolves the module the name holds', () => {
    const maps = scan('app/schema.py', `from ariadne import QueryType
import app.orders_mod as orders_mod
from app import other
query = QueryType()
query.set_field("search", orders_mod.resolve_search)
query.set_field("other", other.resolve_other)
query.set_field("unknown", nowhere.resolve_x)
`);
    expect(maps[0].entries.map(({ line: _l, ...e }) => e)).toEqual([
      { field: 'search', fn: 'resolve_search', imported: true, module: 'app.orders_mod' },
      { field: 'other', fn: 'resolve_other', imported: true, module: 'app.other' },
      { field: 'unknown', fn: 'resolve_x', notFollowed: '`nowhere.resolve_x` names an attribute of `nowhere`, which is not an import this file states' },
    ]);
  });
});

describe('scanResolverMaps: client code, mocks and types are not server resolvers (review repros)', () => {
  it('urql `cacheExchange` resolvers and updates bind nothing', () => {
    const src = `import { cacheExchange } from '@urql/exchange-graphcache';
import { createClient } from 'urql';
export const client = createClient({ exchanges: [cacheExchange({ resolvers: { Query: { todo: f } }, updates: { Mutation: { addTodo: g } } })] });
`;
    expect(scan('src/client.ts', src)).toEqual([]);
    // Even without the client import, the enclosing `cacheExchange(…)` call marks it client configuration.
    expect(scan('src/cache.ts', 'const resolvers = 1;\nexport const c = cacheExchange({ resolvers: { Query: { todo: f } }, updates: { Mutation: { addTodo: g } } });')).toEqual([]);
  });

  it('Apollo Client local resolvers and type policies bind nothing', () => {
    expect(scan('src/apollo.ts', `import { ApolloClient, InMemoryCache } from '@apollo/client';
export const client = new ApolloClient({ cache: new InMemoryCache(), resolvers: { Query: { isLoggedIn: readLogin } } });
`)).toEqual([]);
    expect(scan('src/apollo.ts', `const resolvers = {};
export const client = new ApolloClient({ resolvers: { Query: { isLoggedIn: readLogin } } });
export const cache = new InMemoryCache({ typePolicies: { Query: { fields: { me: readMe } } } });
`)).toEqual([]);
  });

  it('a file importing both a client and a server package is still read', () => {
    const src = `import { gql } from '@apollo/client';
import { ApolloServer } from '@apollo/server';
const resolvers = { Query: { order: getOrder } };
`;
    expect(entries(scan('src/server.ts', src))).toEqual(['Query.order -> getOrder']);
  });

  it('stories and mock servers bind nothing', () => {
    const src = 'const resolvers = { Query: { order: getOrder } };';
    expect(scan('src/Order.stories.ts', src)).toEqual([]);
    expect(scan('src/Order.stories.tsx', src)).toEqual([]);
    expect(scan('src/mocks/server.ts', src)).toEqual([]);
    expect(scan('src/__mocks__/server.ts', src)).toEqual([]);
    expect(scan('mock/server.ts', src)).toEqual([]);
  });

  it('`export const Query = {…}` in a file not about resolvers binds nothing', () => {
    expect(scan('src/selectors.ts', 'export const Query = { orders: selectOrders };')).toEqual([]);
    // The same object as a key of a map is still read.
    expect(entries(scan('src/x.ts', 'export default { Query: { orders: selectOrders } };'))).toEqual(['Query.orders -> selectOrders']);
  });

  it('a root bound to an identifier or a call is disclosed as not literal', () => {
    const maps = scan('src/resolvers.ts', 'const resolvers = {\n  Query: queryResolvers,\n  Mutation: mergeResolvers(a, b),\n};');
    expect(maps).toEqual([
      { file: 'src/resolvers.ts', line: 2, runtime: 'node', root: 'Query', entries: [], notLiteral: 'the Query resolvers are `queryResolvers`, not an object written here' },
      { file: 'src/resolvers.ts', line: 3, runtime: 'node', root: 'Mutation', entries: [], notLiteral: 'the Mutation resolvers are `mergeResolvers(…)`, not an object written here' },
    ]);
  });

  it('a resolver TYPE (an interface or a type alias) yields nothing', () => {
    expect(scan('src/types.ts', 'export interface Resolvers { Query: { order: X } }')).toEqual([]);
    expect(scan('src/types.ts', 'export interface Resolvers<C> extends Base { Query: { order: X } }')).toEqual([]);
    expect(scan('src/types.ts', 'export type Resolvers = { Query: { order: X }; Mutation: QueryRes };')).toEqual([]);
  });

  it('an Apollo subscription `{ subscribe: fn }` names fn, imported or not', () => {
    const maps = scan('src/resolvers.ts', `import { subscribeOrders } from './pubsub';
export const resolvers = { Subscription: { orderCreated: { subscribe: subscribeOrders }, orderPaid: { subscribe: () => it } } };
`);
    expect(maps.flatMap(m => m.entries.map(({ line: _l, ...e }) => e))).toEqual([
      { field: 'orderCreated', fn: 'subscribeOrders', imported: true, from: './pubsub' },
      { field: 'orderPaid' },
    ]);
  });
});
