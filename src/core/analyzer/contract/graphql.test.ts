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
  readGraphql, mergeGraphqlSchema, mergeGraphqlUniverses, namedType, isGraphqlPath, isBuiltInScalar,
  type GqlDocument, type GqlType,
} from './graphql.js';
import { partitionSchemaUniverses, projectRootDirs, isProjectRootMarkerPath, MAX_SCHEMA_UNIVERSE_DEPTH } from './types.js';
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
      ['ids', '[ID!]', '["a","b"]', false],
      ['range', 'Range', '{from:1,to:-2500}', false],
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

  it('reads directive definitions into the model (their uses stay outside it), and an empty or comment-only file as an empty schema', () => {
    const d = read('directive @auth(requires: Role = ADMIN) repeatable on | FIELD_DEFINITION | OBJECT\ntype T { a: Int @auth }');
    expect(d.unassessed).toEqual(['@auth']);
    expect(d.directiveDefs.map(x => x.name)).toEqual(['auth']);
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
    expect(fails('input A { a: [Int] = [1, 2 }')).toMatch(/expected a value/);
    expect(fails('input A { a: [Int] = [1, 2')).toMatch(/end of file/);
  });

  it('a duplicate field or enum value withholds THAT type, not the document (change: scope-graphql-schema-universes)', () => {
    const d = read('type A { a: Int\n a: String }\ntype B { b: Int }\ninput I { c: Int, c: Int }\nenum E { X Y X }');
    expect(type(d, 'A').unassessable).toMatch(/field `a` is declared twice \(line 2\)/);
    expect(type(d, 'I').unassessable).toMatch(/field `c` is declared twice/);
    expect(type(d, 'E').unassessable).toMatch(/enum value `X` is declared twice/);
    // The rest of the document is read as before.
    expect(type(d, 'B').unassessable).toBeUndefined();
    expect(type(d, 'B').fields.map(f => f.name)).toEqual(['b']);
    // The first definition is kept, so what IS read of a withheld type is deterministic.
    expect(type(d, 'A').fields.map(f => f.type)).toEqual(['Int']);
    expect(type(d, 'E').values.map(v => v.name)).toEqual(['X', 'Y']);
  });

  it('a withheld type is absent from the merged namespace, with why, and its neighbours are not', () => {
    const merged = mergeGraphqlSchema([read('type A { a: Int\n a: String }\ntype B { b: Int }')]);
    expect(merged.types.has('A')).toBe(false);
    expect(merged.types.has('B')).toBe(true);
    expect(merged.unassessableTypes).toEqual([
      { name: 'A', files: ['schema.graphql'], reason: expect.stringContaining('field `a` is declared twice'), fingerprint: expect.any(String) },
    ]);
    // A reformat that does not change the shape does not change the fingerprint.
    const again = mergeGraphqlSchema([read('\n\ntype A { a: Int\n a: String }\ntype B { b: Int }')]);
    expect(again.unassessableTypes[0].fingerprint).toBe(merged.unassessableTypes[0].fingerprint);
    const altered = mergeGraphqlSchema([read('type A { a: ID\n a: String }\ntype B { b: Int }')]);
    expect(altered.unassessableTypes[0].fingerprint).not.toBe(merged.unassessableTypes[0].fingerprint);
  });

  it('an `extend` holding a duplicate field is not folded in, and does NOT withhold the type it extends', () => {
    const merged = mergeGraphqlSchema([
      read('type A { a: Int }', 'a.graphql'),
      read('extend type A { b: Int\n b: String }', 'b.graphql'),
    ]);
    // The clean definition is still compared — before the type-scoped refusal existed, the whole
    // bad FILE was dropped and `A` was compared normally; withholding `A` here would downgrade a
    // real `field-removed` in a.graphql to `schema-unassessed`.
    expect(merged.types.get('A')!.fields.map(f => f.name)).toEqual(['a']);
    expect(merged.unassessableTypes).toEqual([]);
    expect(merged.conflicts).toEqual([expect.stringMatching(/^`extend object A` in b\.graphql is not read: field `b` is declared twice/)]);
  });

  it('an `extend`-only type whose only extension is unreadable is not invented', () => {
    const merged = mergeGraphqlSchema([read('extend type Ghost { b: Int\n b: String }', 'b.graphql')]);
    expect(merged.types.has('Ghost')).toBe(false);
    expect(merged.orphanExtensions).toEqual([]);
    expect(merged.conflicts).toEqual([expect.stringContaining('`extend object Ghost` in b.graphql is not read')]);
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
    expect(tb).toBeLessThan(Math.max(ts * 10, 9_000));
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
    expect(s.ambiguous).toEqual([{ name: 'Order', files: ['svc-a/schema.graphql', 'svc-b/schema.graphql'], fingerprint: expect.any(String) }]);
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

  it('a root named differently in two files is a conflict, and no root of that kind is guessed', () => {
    const s = mergeGraphqlSchema([
      doc('b.graphql', 'schema { query: Q2 }'),
      doc('a.graphql', 'schema { query: Q1 }'),
    ]);
    // Conflicting roots are not guessed between: the kind has no root, and the conflict is named.
    expect(s.roots.query).toBeUndefined();
    expect(s.rootConflicts).toEqual(['query']);
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

describe('readGraphql: directive definitions, schema directives and default values', () => {
  it('models a directive definition: arguments, repeatable, and sorted unique locations', () => {
    const d = read('directive @auth(role: Role! = ADMIN, scopes: [String]) repeatable on | OBJECT | FIELD_DEFINITION | OBJECT\ndirective @plain on FIELD');
    expect(d.directiveDefs.map(x => ({ ...x, args: x.args.map(a => `${a.name}: ${a.type}${a.defaultValue !== undefined ? ` = ${a.defaultValue}` : ''}`) }))).toEqual([
      { name: 'auth', args: ['role: Role! = ADMIN', 'scopes: [String]'], repeatable: true, locations: ['FIELD_DEFINITION', 'OBJECT'], line: 1 },
      { name: 'plain', args: [], repeatable: false, locations: ['FIELD'], line: 2 },
    ]);
    expect(d.unassessed).toEqual([]);
  });

  it('hashes the directives on `schema` and `extend schema`, and records a schema definition', () => {
    const a = read('schema @link(url: "a") { query: Query }\ntype Query { x: Int }');
    const b = read('schema @link(url: "b") { query: Query }\ntype Query { x: Int }');
    const none = read('schema { query: Query }\ntype Query { x: Int }');
    expect(a.hasSchemaDefinition).toBe(true);
    expect(a.schemaDirectivesHash).not.toBe(b.schemaDirectivesHash);
    expect(a.schemaDirectivesHash).not.toBe(none.schemaDirectivesHash);
    expect(read('extend schema @link(url: "a")').schemaDirectivesHash).not.toBe(read('type Q { a: Int }').schemaDirectivesHash);
    expect(read('extend schema @link(url: "a")').hasSchemaDefinition).toBe(false);
  });

  it('writes default values in canonical form: object fields sorted, numbers as numbers', () => {
    const dv = (t: string) => type(read(`input I { a: ${t} }`), 'I').fields[0].defaultValue;
    expect(dv('F = {b: 2, a: 1}')).toBe(dv('F = { a: 1, b: 2 }'));
    expect(dv('F = {b: 2, a: 1}')).toBe('{a:1,b:2}');
    expect(dv('Float = 1.0')).toBe(dv('Float = 1'));
    expect(dv('Float = 1e3')).toBe('1000');
    expect(dv('[F] = [{y: [1, 2], x: "s"}]')).toBe('[{x:"s",y:[1,2]}]');
    expect(dv('Int = 1')).not.toBe(dv('Int = 2'));
  });

  it('a duplicate argument name, a root named twice, or a second `schema` definition is unreadable', () => {
    // A duplicate argument withholds its own type; a duplicate on a `directive` definition, whose
    // namespace is the document's, still refuses the file.
    expect(type(read('type Q { a(x: Int, x: String): Int }'), 'Q').unassessable).toMatch(/argument `x` is declared twice on `a`/);
    expect(fails('directive @d(x: Int, x: Int) on FIELD')).toMatch(/argument `x` declared twice on @d/);
    expect(fails('schema { query: A query: B }')).toMatch(/the query root is named twice/);
    expect(fails('schema { query: A }\nschema { mutation: B }')).toMatch(/a second `schema` definition/);
    // An `extend schema` beside a definition is fine.
    expect(read('schema { query: A }\nextend schema { mutation: B }').roots).toEqual({ query: 'A', mutation: 'B' });
  });
});

describe('mergeGraphqlSchema: roots, extension-only types, ambiguity fingerprints, directives', () => {
  const doc = (file: string, text: string) => read(text, file);

  it('with a `schema` definition anywhere, only the roots it names exist', () => {
    const s = mergeGraphqlSchema([doc('a.graphql', 'schema { query: Query }\ntype Query { a: Mutation }\ntype Mutation { m: Int }')]);
    expect(s.roots).toEqual({ query: 'Query' });
    // Without one, the default names apply.
    expect(mergeGraphqlSchema([doc('a.graphql', 'type Query { a: Int }')]).roots).toEqual({ query: 'Query', mutation: 'Mutation', subscription: 'Subscription' });
    // An `extend schema` alone is not a definition: the defaults stay, overridden by what it names.
    expect(mergeGraphqlSchema([doc('a.graphql', 'extend schema { subscription: Events }')]).roots).toEqual({ query: 'Query', mutation: 'Mutation', subscription: 'Events' });
  });

  it('a type only extended (Federation 1) is merged as an extension-only type', () => {
    const s = mergeGraphqlSchema([
      doc('a.graphql', 'extend type Query { me: User }\ntype User { id: ID! }'),
      doc('b.graphql', 'extend type Query { topProducts: Int }'),
    ]);
    const q = s.types.get('Query')!;
    expect(q.extensionOnly).toBe(true);
    expect(q.extension).toBe(false);
    expect(q.file).toBe('a.graphql');
    expect(q.extendedIn).toEqual(['b.graphql']);
    expect(q.fields.map(f => `${f.name}@${f.file ?? '-'}`)).toEqual(['me@-', 'topProducts@b.graphql']);
    expect(s.types.get('User')!.extensionOnly).toBeUndefined();
    expect(s.orphanExtensions).toEqual([{ name: 'Query', file: 'a.graphql' }, { name: 'Query', file: 'b.graphql' }]);
  });

  it('an ambiguous type carries a fingerprint of all its definitions and extensions, blind to line numbers', () => {
    const fp = (a: string, b: string, ext = '') => mergeGraphqlSchema([doc('a.graphql', a), doc('b.graphql', b), ...(ext ? [doc('e.graphql', ext)] : [])]).ambiguous[0].fingerprint;
    const base = fp('type O { id: ID }', 'type O { sku: String }');
    expect(fp('\n\ntype O { id: ID }', 'type O { sku: String }')).toBe(base);
    expect(fp('type O { id: ID! }', 'type O { sku: String }')).not.toBe(base);
    expect(fp('type O { id: ID }', 'type O { sku: String }', 'extend type O { x: Int }')).not.toBe(base);
  });

  it('merges directive definitions by name; one defined in two files is ambiguous, with a fingerprint', () => {
    const s = mergeGraphqlSchema([doc('a.graphql', 'directive @a on FIELD\ndirective @b on FIELD'), doc('b.graphql', 'directive @b on OBJECT')]);
    expect([...s.directives.keys()]).toEqual(['a']);
    expect(s.directives.get('a')!.file).toBe('a.graphql');
    expect(s.ambiguousDirectives).toEqual([{ name: 'b', files: ['a.graphql', 'b.graphql'], fingerprint: expect.any(String) }]);
  });

  it('folds every file\'s schema directives into one hash', () => {
    const h = (...texts: string[]) => mergeGraphqlSchema(texts.map((t, i) => doc(`${i}.graphql`, t))).schemaDirectivesHash;
    expect(h('extend schema @link(url: "a")', 'extend schema @link(url: "b")')).toBe(h('extend schema @link(url: "b")', 'extend schema @link(url: "a")'));
    expect(h('extend schema @link(url: "a")')).not.toBe(h('extend schema @link(url: "b")'));
  });
});

describe('schema universes (change: scope-graphql-schema-universes)', () => {
  it('keys a universe by the nearest enclosing project root, and the repository root otherwise', () => {
    const roots = projectRootDirs(['package.json', 'packages/a/package.json', 'packages/b/relay.config.json', 'packages/b/src/notes.md']);
    expect(roots).toEqual(['', 'packages/a', 'packages/b']);
    const p = partitionSchemaUniverses(
      ['packages/a/schema.graphql', 'packages/a/deep/other.graphql', 'packages/b/src/schema.graphql', 'docs/schema.graphql'],
      roots,
    );
    expect(p.universeOf('packages/a/schema.graphql')).toBe('packages/a');
    expect(p.universeOf('packages/a/deep/other.graphql')).toBe('packages/a');
    expect(p.universeOf('packages/b/src/schema.graphql')).toBe('packages/b');
    expect(p.universeOf('docs/schema.graphql')).toBe('');
    expect(p.universes).toEqual(['', 'packages/a', 'packages/b']);
    expect(p.rootsOmitted).toBe(0);
    expect(p.tooDeep).toEqual([]);
  });

  it('recognizes the marker forms, and nothing else', () => {
    for (const f of ['package.json', 'a/b/package.json', 'relay.config.json', 'graphql.config.yml', 'graphql.config.yaml', '.graphqlrc.json', '.graphqlconfig', '.graphqlconfig.yml']) {
      expect(isProjectRootMarkerPath(f), f).toBe(true);
    }
    for (const f of ['package-lock.json', 'my-package.json', 'relay.config.js', 'tsconfig.json', 'schema.graphql']) {
      expect(isProjectRootMarkerPath(f), f).toBe(false);
    }
  });

  it('refuses a root or a schema reached through `..`, an absolute path or a drive letter', () => {
    const p = partitionSchemaUniverses(['../outside/schema.graphql', '/abs/schema.graphql'], ['../outside', '/abs', 'C:/x', 'ok']);
    // Neither schema keys a universe of its own, and no refused root became one.
    expect(p.universeOf('../outside/schema.graphql')).toBe('');
    expect(p.universeOf('/abs/schema.graphql')).toBe('');
    expect(p.universeOf('ok/schema.graphql')).toBe('ok');
    expect(projectRootDirs(['../a/package.json', '/b/package.json'])).toEqual([]);
  });

  it('bounds the walk: a schema deeper than the bound falls back to the repository root, disclosed', () => {
    const deep = `${Array.from({ length: MAX_SCHEMA_UNIVERSE_DEPTH + 5 }, (_, i) => `d${i}`).join('/')}/schema.graphql`;
    const p = partitionSchemaUniverses([deep], ['d0']);
    expect(p.universeOf(deep)).toBe('');
    expect(p.tooDeep).toEqual([deep]);
  });

  it('drops the DEEPEST roots past the cap, so a universe only ever gets wider', () => {
    const roots = ['', ...Array.from({ length: 2_500 }, (_, i) => `packages/p${i}/nested`)];
    const p = partitionSchemaUniverses(['packages/p0/nested/schema.graphql'], roots);
    expect(p.rootsOmitted).toBeGreaterThan(0);
    // The repository root is shallowest, so it is always honored.
    expect(p.universeOf('top.graphql')).toBe('');
  });

  it('merges one schema per universe, so two projects do not void each other', () => {
    const docs = [
      read('type Query { a: Int }\ntype Shared { x: Int }', 'packages/a/schema.graphql'),
      read('type Query { b: Int }\ntype Shared { y: Int }', 'packages/b/schema.graphql'),
    ];
    const roots = ['packages/a', 'packages/b'];
    const p = partitionSchemaUniverses(docs.map(d => d.file), roots);
    const universes = mergeGraphqlUniverses(docs, p.universeOf);
    expect(universes.map(u => u.universe)).toEqual(['packages/a', 'packages/b']);
    for (const u of universes) {
      expect(u.schema.ambiguous).toEqual([]);
      expect(u.schema.types.get('Query')!.fields).toHaveLength(1);
      expect(u.schema.types.has('Shared')).toBe(true);
    }
  });

  it('two schemas in the SAME project still collide and stay unassessed', () => {
    const docs = [
      read('type Query { a: Int }', 'packages/a/schema.graphql'),
      read('type Query { b: Int }', 'packages/a/other/schema.graphql'),
    ];
    const p = partitionSchemaUniverses(docs.map(d => d.file), ['packages/a']);
    const universes = mergeGraphqlUniverses(docs, p.universeOf);
    expect(universes).toHaveLength(1);
    expect(universes[0].schema.ambiguous.map(a => a.name)).toEqual(['Query']);
    expect(universes[0].schema.types.has('Query')).toBe(false);
  });

  it('stays linear on a hostile shape: 2,000 roots, 2,000 schemas 40 deep, looked up per type', () => {
    const roots = Array.from({ length: 2_000 }, (_, i) => `packages/p${i}`);
    const deep = Array.from({ length: MAX_SCHEMA_UNIVERSE_DEPTH }, (_, i) => `d${i}`).join('/');
    const paths = Array.from({ length: 2_000 }, (_, i) => `packages/p${i}/${deep}/schema.graphql`);
    const started = Date.now();
    const p = partitionSchemaUniverses(paths, roots);
    // 40,000 lookups — what a loop over schemas × types would do — cost no extra walk: memoized.
    let wrong = 0;
    for (const f of paths) for (let i = 0; i < 20; i++) if (p.universeOf(f) !== f.slice(0, f.indexOf('/', f.indexOf('/') + 1))) wrong++;
    expect(wrong).toBe(0);
    // Quadratic in either dimension would be millions of segment walks, not thousands.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(p.universes).toHaveLength(2_000);
    expect(p.tooDeep).toEqual([]);
  });
});
