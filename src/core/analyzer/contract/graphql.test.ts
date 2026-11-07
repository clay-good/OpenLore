/**
 * GraphQL SDL reader and cross-file merge (change: add-contract-graph-projection, GraphQL phase).
 *
 * Drives `readGraphql` over the type-system grammar it covers, over client documents it must set
 * aside, and over every input it must refuse whole — an unreadable file is `{ error }`, never a
 * partial document, and the error never echoes a string's text. `mergeGraphqlSchema` is driven
 * over GraphQL's one global namespace: `extend` folded in, a name defined twice ambiguous.
 */
import { describe, it, expect } from 'vitest';
import {
  readGraphql, mergeGraphqlSchema, namedType, isGraphqlPath, isBuiltInScalar,
  type GqlDocument, type GqlType,
} from './graphql.js';
import { MAX_SPEC_BYTES } from './openapi.js';

const read = (text: string, file = 'schema.graphql'): GqlDocument => {
  const d = readGraphql(file, text);
  if ('error' in d) throw new Error(`unexpected error: ${d.error}`);
  if ('clientDocument' in d) throw new Error('unexpected client document');
  return d;
};
const fails = (text: string): string => {
  const d = readGraphql('bad.graphql', text);
  expect('error' in d, `expected an error, got a document for:\n${text}`).toBe(true);
  expect(Object.keys(d).sort()).toEqual(['error', 'file']);
  return (d as { error: string }).error;
};
const type = (d: GqlDocument, name: string, extension = false): GqlType => {
  const t = d.types.find(x => x.name === name && x.extension === extension);
  if (!t) throw new Error(`no type ${name}`);
  return t;
};

describe('isGraphqlPath / isBuiltInScalar / namedType', () => {
  it('recognizes .graphql, .graphqls and .gql only', () => {
    expect(isGraphqlPath('api/schema.graphql')).toBe(true);
    expect(isGraphqlPath('api/schema.graphqls')).toBe(true);
    expect(isGraphqlPath('API/OPS.GQL')).toBe(true);
    expect(isGraphqlPath('schema.graphql.bak')).toBe(false);
    expect(isGraphqlPath('schema.graphql.ts')).toBe(false);
    expect(isGraphqlPath('graphql/index.ts')).toBe(false);
  });
  it('knows the five built-in scalars and nothing else', () => {
    for (const s of ['Int', 'Float', 'String', 'Boolean', 'ID']) expect(isBuiltInScalar(s)).toBe(true);
    expect(isBuiltInScalar('DateTime')).toBe(false);
    expect(isBuiltInScalar('string')).toBe(false);
  });
  it('strips list and non-null wrappers', () => {
    expect(namedType('[Order!]!')).toBe('Order');
    expect(namedType('[[ID]]')).toBe('ID');
    expect(namedType('Order')).toBe('Order');
  });
});

describe('readGraphql: happy path', () => {
  const SDL = `# A header comment { with a brace
"""
The schema roots.
"""
schema @link(url: "https://specs.apollo.dev/federation/v2.0") {
  query: RootQuery
  mutation: RootMutation
}

"An order."
type Order implements Node & Priced @key(fields: "id") {
  "The id"
  id: ID!
  items(first: Int = 10, after: String): [Item!]!
  total: Float @deprecated(reason: "use money")
  legacy: String @deprecated
}

interface Node { id: ID! }
interface Priced implements Node { id: ID!, total: Float }

input OrderFilter {
  status: Status = OPEN
  ids: [ID!] = ["a", "b"]
  range: Range = { from: 1, to: -2.5e3 }
  old: Int @deprecated(reason: "gone")
}

enum Status { OPEN, CLOSED @deprecated BACKORDER @tag(name: "x") }
union SearchResult = | Order | Item
scalar DateTime @specifiedBy(url: "https://example.com")

type RootQuery {
  order(id: ID!): Order
  search(filter: OrderFilter!, limit: Int = 20 @deprecated): [SearchResult]
}

extend type RootQuery { me: Order }
`;

  it('reads every kind of type, field, argument and value', () => {
    const d = read(SDL);
    expect(d.format).toBe('graphql-sdl');
    expect(d.roots).toEqual({ query: 'RootQuery', mutation: 'RootMutation' });
    expect(d.types.map(t => `${t.extension ? 'extend ' : ''}${t.kind} ${t.name}`)).toEqual([
      'scalar DateTime', 'interface Node', 'object Order', 'input OrderFilter', 'interface Priced',
      'object RootQuery', 'extend object RootQuery', 'union SearchResult', 'enum Status',
    ]);
    const order = type(d, 'Order');
    expect(order.interfaces).toEqual(['Node', 'Priced']);
    expect(order.line).toBe(11);
    expect(order.fields.map(f => `${f.name}: ${f.type}${f.deprecated ? ' (deprecated)' : ''}`)).toEqual([
      'id: ID!', 'items: [Item!]!', 'total: Float (deprecated)', 'legacy: String (deprecated)',
    ]);
    expect(order.fields[0].line).toBe(13);
    expect(order.fields[1].args).toEqual([
      expect.objectContaining({ name: 'first', type: 'Int', defaultValue: '10', deprecated: false }),
      expect.objectContaining({ name: 'after', type: 'String', deprecated: false }),
    ]);
    expect(order.fields[1].args[1].defaultValue).toBeUndefined();
    expect(type(d, 'Priced').interfaces).toEqual(['Node']);

    const filter = type(d, 'OrderFilter');
    expect(filter.fields.map(f => [f.name, f.type, f.defaultValue, f.deprecated])).toEqual([
      ['status', 'Status', 'OPEN', false],
      ['ids', '[ID!]', '[ "a" "b" ]', false],
      ['range', 'Range', '{ from : 1 to : -2.5e3 }', false],
      ['old', 'Int', undefined, true],
    ]);
    expect(type(d, 'Status').values.map(v => `${v.name}${v.deprecated ? '*' : ''}`)).toEqual(['OPEN', 'CLOSED*', 'BACKORDER']);
    expect(type(d, 'SearchResult').members).toEqual(['Order', 'Item']);
    const root = type(d, 'RootQuery');
    expect(root.fields[1].args.map(a => [a.name, a.type, a.defaultValue, a.deprecated])).toEqual([
      ['filter', 'OrderFilter!', undefined, false], ['limit', 'Int', '20', true],
    ]);
    expect(type(d, 'RootQuery', true).fields.map(f => f.name)).toEqual(['me']);
    // Custom directives are outside the model and named.
    expect(d.unassessed).toEqual(['@key', '@link', '@specifiedBy', '@tag']);
  });

  it('hashes custom directives so a change to one is seen, and @deprecated stays out of the hash', () => {
    const a = read('type T @key(fields: "id") { id: ID! @external }');
    const b = read('type T @key(fields: "sku") { id: ID! @external }');
    const c = read('type T @key(fields: "id") { id: ID! @external @deprecated }');
    expect(a.types[0].directivesHash).not.toBe(b.types[0].directivesHash);
    expect(a.types[0].fields[0].directivesHash).toBe(b.types[0].fields[0].directivesHash);
    expect(a.types[0].fields[0].directivesHash).toBe(c.types[0].fields[0].directivesHash);
    // Order of directives does not matter.
    expect(read('type T @a @b { x: Int }').types[0].directivesHash).toBe(read('type T @b @a { x: Int }').types[0].directivesHash);
  });

  it('descriptions and comments change nothing', () => {
    const plain = read('type T { a(x: Int): String }\nenum E { A }');
    const described = read('"""T\n  docs"""\ntype T {\n  "a" a("x" x: Int): String # c\n}\n"E" enum E { "A" A }');
    const strip = (d: GqlDocument) => JSON.stringify(d.types.map(t => ({ ...t, line: 0, fields: t.fields.map(f => ({ ...f, line: 0, args: f.args.map(a => ({ ...a, line: 0 })) })), values: t.values.map(v => ({ ...v, line: 0 })) })));
    expect(strip(described)).toBe(strip(plain));
  });

  it('reads directive definitions as outside the model, and an empty or comment-only file as an empty schema', () => {
    const d = read('directive @auth(requires: Role = ADMIN) repeatable on | FIELD_DEFINITION | OBJECT\ntype T { a: Int @auth }');
    expect(d.unassessed).toEqual(['@auth', 'directive @auth']);
    expect(read('').types).toEqual([]);
    expect(read('# nothing here\n').types).toEqual([]);
  });

  it('reads `extend schema`, `extend` of every kind, and types without a body', () => {
    const d = read(`extend schema @link(url: "x") { subscription: Events }
extend schema @foo
extend interface Node { createdAt: String }
extend enum Status { ARCHIVED }
extend union Result = Extra
extend input Filter { tag: String }
extend scalar Date @specifiedBy(url: "y")
type Empty
interface Bare
`);
    expect(d.roots).toEqual({ subscription: 'Events' });
    expect(d.types.filter(t => t.extension).map(t => `${t.kind} ${t.name}`).sort()).toEqual([
      'enum Status', 'input Filter', 'interface Node', 'scalar Date', 'union Result',
    ]);
    expect(type(d, 'Empty').fields).toEqual([]);
  });

  it('accepts commas anywhere, a BOM, and CRLF line endings with correct line numbers', () => {
    const d = read('\uFEFFtype A {\r\n  a: Int,,\r\n  b: [String!]!,\r\n}\r\n,,type B { c: A }\r\n');
    expect(type(d, 'A').fields.map(f => [f.name, f.type, f.line])).toEqual([['a', 'Int', 2], ['b', '[String!]!', 3]]);
    expect(type(d, 'B').line).toBe(5);
  });

  it('counts lines through block strings for the definitions that follow', () => {
    const d = read('"""\nline 2\nline 3\n"""\ntype A { a: Int }\n\n"x"\ntype B { b: Int }');
    expect(type(d, 'A').line).toBe(5);
    expect(type(d, 'B').line).toBe(8);
  });

  it('reads escaped triple quotes inside a block string and escapes inside a string', () => {
    const d = read('"""a \\""" still the description """ type A { a: Int }\n"say \\"hi\\" \\\\" type B { b: Int }');
    expect(d.types.map(t => t.name)).toEqual(['A', 'B']);
  });

  it('decodes string escapes, so one value written two ways is one value', () => {
    const arg = (lit: string) => read(`type A { a(x: String = ${lit}): Int }`).types[0].fields[0].args[0].defaultValue;
    expect(arg('"\\u00e9t\\u00E9"')).toBe(arg('"été"'));
    expect(arg('"\\u{1F4A5}"')).toBe(arg('"💥"'));
    expect(arg('"a\\nb\\t\\"\\\\\\/"')).toBe(JSON.stringify('a\nb\t"\\/'));
    // A malformed \u escape is read literally, never a crash.
    expect(arg('"\\uZZ"')).toBe(JSON.stringify('uZZ'));
  });

  it('a backslash at the end of a line does not carry a string onto the next line', () => {
    expect(fails('type A { a(x: String = "abc\\\n"): Int }')).toMatch(/line 1: unterminated string/);
  });

  it('reads unicode inside strings and comments', () => {
    const d = read('# 注释 💥\n"""ünïcødé 💥 """ type A { a(x: String = "日本 💥"): Int }');
    expect(type(d, 'A').fields[0].args[0].defaultValue).toBe(JSON.stringify('日本 💥'));
  });

  it('deep but bounded list nesting is read', () => {
    const t = `${'['.repeat(32)}Int${']'.repeat(32)}`;
    expect(read(`type A { a: ${t} }`).types[0].fields[0].type).toBe(t);
  });

  it('sorts types by name, a definition before its extension, then by line', () => {
    const d = read('extend type B { y: Int }\ntype B { x: Int }\ntype A { a: Int }\nextend type B { z: Int }');
    expect(d.types.map(t => `${t.name}${t.extension ? '+' : ''}@${t.line}`)).toEqual(['A@3', 'B@2', 'B+@1', 'B+@4']);
  });
});

describe('readGraphql: client documents', () => {
  it('a file of operations and fragments is a client document, not a schema', () => {
    const ops = `query GetOrder($id: ID!, $n: Int = 3) @cached {
  order(id: $id) { ...OrderParts items(first: $n) { id } }
}
mutation { cancel(id: "1") { ok } }
subscription OnOrder { orderChanged { id } }
fragment OrderParts on Order { id total }
{ shorthand { id } }
`;
    expect(readGraphql('ops.graphql', ops)).toEqual({ file: 'ops.graphql', clientDocument: true });
    expect(readGraphql('one.gql', '{ me { id } }')).toEqual({ file: 'one.gql', clientDocument: true });
  });

  it('operations inside a schema file are named outside the model, never mistaken for the schema', () => {
    const d = read('type Query { a: Int }\nquery Q { a }');
    expect(d.types.map(t => t.name)).toEqual(['Query']);
    expect(d.unassessed).toContain('operations in a schema file');
  });

  it('an unterminated operation is an error, not a client document', () => {
    expect(fails('query Q { a { b }')).toMatch(/end of file/);
  });
});

describe('readGraphql: refusals', () => {
  it('names the line and the token, never a string\'s text', () => {
    const secret = 'sk_live_SECRET_VALUE';
    const err = fails(`type A {\n  a: Int\n  "${secret}" }`);
    expect(err).not.toContain(secret);
    expect(err).toMatch(/^line 3: /);
    const err2 = fails(`type A { a: Int }\n"${secret}"`);
    expect(err2).not.toContain(secret);
    const err3 = fails(`type A { a: Int = "${secret}" }`);
    expect(err3).not.toContain(secret);
  });

  it('an unterminated string or block string is unreadable', () => {
    expect(fails('"""never closed\ntype A { a: Int }')).toMatch(/line 1: unterminated block string/);
    expect(fails('type A {\n "oops\n a: Int }')).toMatch(/line 2: unterminated string/);
    expect(fails('"tail')).toMatch(/unterminated string/);
    expect(fails('"""a \\"""')).toMatch(/unterminated block string/);
  });

  it('unbalanced or truncated definitions are unreadable', () => {
    expect(fails('type A { a: Int')).toMatch(/end of file|expected/);
    expect(fails('type A { a: [Int }')).toMatch(/expected `]`/);
    expect(fails('type A { a(x: Int: Int }')).toMatch(/expected/);
    expect(fails('type A { a: Int }}')).toMatch(/unexpected `}`/);
    expect(fails('union U = ')).toMatch(/end of file|expected a union member/);
    expect(fails('type A implements { a: Int }')).toMatch(/expected an interface name/);
    expect(fails('input A { a: [Int] = [1, 2 }')).toMatch(/unbalanced/);
    expect(fails('input A { a: [Int] = [1, 2')).toMatch(/end of file/);
  });

  it('a duplicate field or enum value is unreadable', () => {
    expect(fails('type A { a: Int\n a: String }')).toMatch(/line 2: field `a` declared twice in A/);
    expect(fails('input I { a: Int, a: Int }')).toMatch(/declared twice/);
    expect(fails('enum E { X Y X }')).toMatch(/enum value `X` declared twice/);
  });

  it('schema blocks with unknown operations, bad keywords, and stray tokens are unreadable', () => {
    expect(fails('schema { root: Q }')).toMatch(/unexpected `root` in `schema`/);
    expect(fails('schema')).toMatch(/expected `\{` after `schema`/);
    expect(fails('object A { a: Int }')).toMatch(/unexpected `object` at the top level/);
    expect(fails('extend query Q { a }')).toMatch(/unexpected `query`/);
    expect(fails('directive @x on')).toMatch(/directive location/);
    expect(fails('type A { a: Int } ; ')).toMatch(/unexpected character/);
    expect(fails('type A { a: Int }\n"one" "two" type B')).toMatch(/unexpected a string/);
  });

  it('list nesting past the bound is unreadable, not a stack overflow', () => {
    const deep = `${'['.repeat(33)}Int${']'.repeat(33)}`;
    expect(fails(`type A { a: ${deep} }`)).toMatch(/nested deeper than 32/);
    const hostile = `${'['.repeat(200_000)}Int`;
    expect(fails(`type A { a: ${hostile} }`)).toMatch(/nested deeper than 32/);
  });

  it('a huge name is unreadable, and the error is bounded', () => {
    const err = fails(`type ${'A'.repeat(1_025)} { a: Int }`);
    expect(err).toMatch(/longer than 1024 characters/);
    expect(err.length).toBeLessThan(200);
    expect(read(`type ${'A'.repeat(1_024)} { a: Int }`).types[0].name).toHaveLength(1_024);
    // A long token in an error is cut at 40 characters.
    expect(fails(`type A { ${'b'.repeat(500)} }`).length).toBeLessThan(200);
  });

  it('an oversized file is refused before it is tokenized', () => {
    expect(fails(' '.repeat(MAX_SPEC_BYTES + 1))).toMatch(/larger than 4 MB/);
  });

  it('a stray non-ASCII character outside a string is unreadable with a bounded message', () => {
    const err = fails('type Å { a: Int }');
    expect(err).toMatch(/unexpected character/);
    expect(err.length).toBeLessThan(80);
  });
});

describe('readGraphql: linear on hostile input', () => {
  const time = (text: string) => {
    const t = performance.now();
    readGraphql('big.graphql', text);
    return performance.now() - t;
  };

  it('a 4 MB schema of many types is read in linear time', () => {
    const one = 'type T00000 { a(x: Int = 1): [String!]! @deprecated b: Int }\n';
    const mk = (bytes: number) => {
      const parts: string[] = [];
      for (let i = 0, n = 0; n < bytes; i++) { const l = one.replace('00000', String(i).padStart(6, '0')); n += l.length; parts.push(l); }
      return parts.join('');
    };
    const small = mk(1024 * 1024);
    const big = mk(MAX_SPEC_BYTES - 64 * 1024);
    const d = readGraphql('big.graphql', big);
    expect('types' in d ? d.types.length : d).toBeGreaterThan(50_000);
    time(small);
    const ts = time(small);
    const tb = time(big);
    expect(tb).toBeLessThan(Math.max(ts * 10, 3_000));
  });

  it('one 4 MB comment, string, block string or default value is linear', () => {
    const n = MAX_SPEC_BYTES - 1024;
    for (const text of [
      `#${'x'.repeat(n)}\ntype A { a: Int }`,
      `"${'x'.repeat(n)}" type A { a: Int }`,
      `"""${'x\n'.repeat(n / 2)}""" type A { a: Int }`,
      `"""${'\\"""'.repeat(n / 4)}""" type A { a: Int }`,
      `type A { a(x: [Int] = [${'1 '.repeat(n / 2)}]): Int }`,
      `type A { a(x: In = ${'{a:'.repeat(n / 3)}`,
      `"""${'"'.repeat(n)}`,
      `${','.repeat(n)}type A { a: Int }`,
      `type A { ${'-'.repeat(n)} }`,
    ]) {
      const t = performance.now();
      readGraphql('h.graphql', text);
      expect(performance.now() - t, text.slice(0, 20)).toBeLessThan(3_000);
    }
  });

  it('a 4 MB run of name characters fails fast at the name bound', () => {
    expect(time(`type ${'a'.repeat(MAX_SPEC_BYTES - 10)}`)).toBeLessThan(3_000);
  });
});

describe('mergeGraphqlSchema', () => {
  const doc = (file: string, text: string) => read(text, file);

  it('folds extensions from other files into one definition, recording where each field came from', () => {
    const s = mergeGraphqlSchema([
      doc('b/orders.graphql', 'extend type Query { order(id: ID!): Order }\nextend enum Status { ARCHIVED }\nextend union R = B'),
      doc('a/base.graphql', 'type Query { me: User }\ntype Order { id: ID! }\ntype User { id: ID! }\nenum Status { OPEN }\nunion R = A\ntype A { a: Int }\ntype B { b: Int }'),
    ]);
    const q = s.types.get('Query')!;
    expect(q.file).toBe('a/base.graphql');
    expect(q.extendedIn).toEqual(['b/orders.graphql']);
    expect(q.fields.map(f => `${f.name}@${f.file ?? '-'}`)).toEqual(['me@-', 'order@b/orders.graphql']);
    expect(s.types.get('Status')!.values.map(v => v.name)).toEqual(['OPEN', 'ARCHIVED']);
    expect(s.types.get('R')!.members).toEqual(['A', 'B']);
    expect(s.roots).toEqual({ query: 'Query', mutation: 'Mutation', subscription: 'Subscription' });
    expect(s.ambiguous).toEqual([]);
    expect(s.orphanExtensions).toEqual([]);
    expect(s.conflicts).toEqual([]);
  });

  it('an extension in the same file adds fields without a file mark', () => {
    const s = mergeGraphqlSchema([doc('s.graphql', 'type Query { a: Int }\nextend type Query { b: Int }')]);
    expect(s.types.get('Query')!.fields.map(f => f.file)).toEqual([undefined, undefined]);
  });

  it('a name defined in two files is ambiguous and absent; its extensions are not orphans', () => {
    const s = mergeGraphqlSchema([
      doc('svc-a/schema.graphql', 'type Order { id: ID! }'),
      doc('svc-b/schema.graphql', 'type Order { sku: String }'),
      doc('ext.graphql', 'extend type Order { extra: Int }\nextend type Ghost { x: Int }'),
    ]);
    expect(s.types.has('Order')).toBe(false);
    expect(s.ambiguous).toEqual([{ name: 'Order', files: ['svc-a/schema.graphql', 'svc-b/schema.graphql'] }]);
    expect(s.orphanExtensions).toEqual([{ name: 'Ghost', file: 'ext.graphql' }]);
  });

  it('reports a field declared twice through an extension, and an extension of the wrong kind', () => {
    const s = mergeGraphqlSchema([
      doc('a.graphql', 'type Query { a: Int }\nenum E { X }'),
      doc('b.graphql', 'extend type Query { a: String }\nextend type E { y: Int }'),
    ]);
    expect(s.conflicts).toEqual([
      '`extend object E` in b.graphql extends a enum',
      'field `Query.a` is declared twice (an extension in b.graphql)',
    ]);
    expect(s.types.get('Query')!.fields.map(f => f.type)).toEqual(['Int']);
  });

  it('a root named differently in two files is a conflict; the first file wins', () => {
    const s = mergeGraphqlSchema([
      doc('b.graphql', 'schema { query: Q2 }'),
      doc('a.graphql', 'schema { query: Q1 }'),
    ]);
    expect(s.roots.query).toBe('Q1');
    expect(s.conflicts).toEqual(['the query root is `Q1` in one file and `Q2` in another']);
  });

  it('does not mutate its input documents', () => {
    const base = doc('a.graphql', 'type Query { a: Int }');
    const ext = doc('b.graphql', 'extend type Query { b: Int }');
    const before = JSON.stringify([base, ext]);
    mergeGraphqlSchema([base, ext]);
    mergeGraphqlSchema([base, ext]);
    expect(JSON.stringify([base, ext])).toBe(before);
  });

  it('is independent of input order', () => {
    const docs = [
      doc('a.graphql', 'type Query { a: Int }\ntype T @key(fields: "id") { id: ID }'),
      doc('b.graphql', 'extend type Query { b: Int }\nextend type T @shareable { x: Int }'),
      doc('c.graphql', 'extend type Query { c: Int }\nextend type T @tag(name: "c") { y: Int }'),
    ];
    const a = mergeGraphqlSchema(docs);
    const b = mergeGraphqlSchema([...docs].reverse());
    expect(JSON.stringify([...b.types.entries()])).toBe(JSON.stringify([...a.types.entries()]));
  });

  it('moving a type\'s fields into a directive-free extension leaves its directive hash unchanged', () => {
    const whole = mergeGraphqlSchema([doc('a.graphql', 'type T @key(fields: "id") { id: ID x: Int }')]);
    const split = mergeGraphqlSchema([doc('a.graphql', 'type T @key(fields: "id") { id: ID }'), doc('b.graphql', 'extend type T { x: Int }')]);
    expect(split.types.get('T')!.directivesHash).toBe(whole.types.get('T')!.directivesHash);
  });

  it('moving an extension between files leaves its directive hash unchanged', () => {
    const one = mergeGraphqlSchema([doc('a.graphql', 'type T { id: ID }'), doc('b.graphql', 'extend type T @shareable { x: Int }'), doc('c.graphql', 'extend type T @tag(name: "t") { y: Int }')]);
    const two = mergeGraphqlSchema([doc('a.graphql', 'type T { id: ID }'), doc('z.graphql', 'extend type T @shareable { x: Int }'), doc('c.graphql', 'extend type T @tag(name: "t") { y: Int }')]);
    expect(two.types.get('T')!.directivesHash).toBe(one.types.get('T')!.directivesHash);
  });
});
