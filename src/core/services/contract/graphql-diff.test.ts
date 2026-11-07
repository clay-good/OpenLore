/**
 * GraphQL change rules (change: add-contract-graph-projection, GraphQL phase).
 *
 * Every GraphQL row of the closed rule table, the variance of nullability (outputs may only get
 * stricter, inputs only looser — at every list level), and the edits that must read as NO change:
 * a root type renamed through the schema block, an extension moved to another file, a description
 * rewritten. A directive is outside the model: changing one is `schema-unassessed`, never silence.
 */
import { describe, it, expect } from 'vitest';
import { readGraphql, mergeGraphqlSchema, type GqlDocument, type GqlSchema } from '../../analyzer/contract/graphql.js';
import { diffGraphql } from './graphql-diff.js';
import { CONTRACT_RULES, contractBump, type ContractChange } from './contract-diff.js';

const schema = (files: Record<string, string>): GqlSchema => mergeGraphqlSchema(Object.entries(files).map(([file, text]) => {
  const r = readGraphql(file, text);
  if ('error' in r) throw new Error(`${file}: ${r.error}`);
  if ('clientDocument' in r) throw new Error(`${file}: a client document`);
  return r as GqlDocument;
}));
const one = (text: string) => schema({ 'schema.graphql': text });
const diff = (base: string, head: string) => diffGraphql(one(base), one(head));
const rows = (cs: ContractChange[]) => cs.map(c => `${c.rule} ${c.address}${c.element ? ` [${c.element}]` : ''}`);

const BASE = `type Query {
  order(id: ID!, verbose: Boolean = false): Order
  orders(filter: OrderFilter, first: Int = 10): [Order!]!
  legacy: String
}
type Mutation { cancel(id: ID!): Boolean }

type Order implements Node {
  id: ID!
  total: Float
  tags: [String]
  status: Status!
}
interface Node { id: ID! }
input OrderFilter { status: Status, ids: [ID!], limit: Int = 5 }
enum Status { OPEN CLOSED }
union Result = Order
scalar DateTime
`;

describe('diffGraphql: no change', () => {
  it('an identical schema is no change', () => {
    expect(diff(BASE, BASE)).toEqual([]);
  });

  it('descriptions, comments, commas, whitespace and field order are no change', () => {
    const head = `"""The root"""
type Query {
  "Many"
  orders(
    "filter" filter: OrderFilter
    first: Int = 10
  ): [Order!]!,
  legacy: String # keep
  order(id: ID!, verbose: Boolean = false): Order
}
type Mutation { "c" cancel(id: ID!): Boolean }
"o" type Order implements Node { status: Status!, tags: [String], total: Float, id: ID! }
interface Node { id: ID! }
input OrderFilter { limit: Int = 5, status: Status, ids: [ID!] }
enum Status { "closed" CLOSED, OPEN }
union Result = Order
"d" scalar DateTime
`;
    expect(diff(BASE, head)).toEqual([]);
  });

  it('renaming the query root through the schema block is no change', () => {
    const head = BASE.replace('type Query {', 'schema { query: RootQuery, mutation: RootMutation }\ntype RootQuery {').replace('type Mutation', 'type RootMutation');
    expect(diff(BASE, head)).toEqual([]);
  });

  it('moving an extension between files, or folding it into the definition, is no change', () => {
    const a = schema({ 'a.graphql': 'type Query { a: Int }\ntype T @key(fields: "id") { id: ID }', 'b.graphql': 'extend type Query { b: Int }\nextend type T @shareable { x: Int }' });
    const b = schema({ 'a.graphql': 'type Query { a: Int }\ntype T @key(fields: "id") { id: ID }', 'z/moved.graphql': 'extend type Query { b: Int }\nextend type T @shareable { x: Int }' });
    expect(diffGraphql(a, b)).toEqual([]);
    const plain = schema({ 'a.graphql': 'type Query { a: Int }\ntype U { id: ID }', 'b.graphql': 'extend type Query { b: Int }\nextend type U { x: Int }' });
    const folded = schema({ 'a.graphql': 'type Query { a: Int b: Int }\ntype U { id: ID x: Int }' });
    expect(diffGraphql(plain, folded)).toEqual([]);
    expect(diffGraphql(folded, plain)).toEqual([]);
  });

  it('a type moved to another file is no change', () => {
    expect(diffGraphql(schema({ 'a.graphql': BASE }), schema({ 'a.graphql': BASE.replace('scalar DateTime\n', ''), 'b.graphql': 'scalar DateTime' }))).toEqual([]);
  });

  it('a deprecation reason edited, or a value escaped differently, is no change', () => {
    expect(diff('type Query { a: Int @deprecated(reason: "x") }', 'type Query { a: Int @deprecated(reason: "y") }')).toEqual([]);
    expect(diff('type Query { a(s: String = "é"): Int }', 'type Query { a(s: String = "\\u00e9"): Int }')).toEqual([]);
  });
});

describe('diffGraphql: operations', () => {
  it('added, removed and deprecated operations, by root kind', () => {
    const head = BASE
      .replace('  legacy: String\n', '  legacy: String @deprecated\n  me: Order\n')
      .replace('type Mutation { cancel(id: ID!): Boolean }', 'type Mutation { refund(id: ID!): Boolean }');
    expect(rows(diff(BASE, head))).toEqual([
      'operation-removed Mutation.cancel',
      'operation-added Mutation.refund',
      'operation-deprecated Query.legacy',
      'operation-added Query.me',
    ]);
    const cs = diff(BASE, head);
    expect(cs.find(c => c.rule === 'operation-removed')).toMatchObject({ class: 'breaking', detail: 'mutation cancel removed', file: 'schema.graphql', line: 6 });
    expect(cs.find(c => c.address === 'Query.me')).toMatchObject({ class: 'non-breaking', detail: 'query me added', line: 5 });
  });

  it('a subscription root that appears is all additions', () => {
    expect(rows(diff(BASE, `${BASE}type Subscription { orderChanged: Order }`))).toEqual(['operation-added Subscription.orderChanged']);
  });

  it('the result type follows output variance', () => {
    const at = (from: string, to: string) => diff(`type Query { a: ${from} }`, `type Query { a: ${to} }`).map(c => `${c.rule} ${c.class}`);
    expect(at('String', 'String!')).toEqual(['output-field-made-non-null non-breaking']);
    expect(at('String!', 'String')).toEqual(['field-type-changed breaking']);
    expect(at('[String]', '[String!]')).toEqual(['output-field-made-non-null non-breaking']);
    expect(at('[String]', '[String!]!')).toEqual(['output-field-made-non-null non-breaking']);
    expect(at('[String!]', '[String]')).toEqual(['field-type-changed breaking']);
    expect(at('[[String]]', '[[String!]!]!')).toEqual(['output-field-made-non-null non-breaking']);
    expect(at('[[String!]]', '[[String]]')).toEqual(['field-type-changed breaking']);
    expect(at('String', '[String]')).toEqual(['field-type-changed breaking']);
    expect(at('[String]', 'String')).toEqual(['field-type-changed breaking']);
    expect(at('String', 'ID')).toEqual(['field-type-changed breaking']);
    expect(at('[String]', '[[String]]')).toEqual(['field-type-changed breaking']);
  });
});

describe('diffGraphql: arguments (input position)', () => {
  const at = (from: string, to: string) => diff(`type Query { a(x: ${from}): Int }`, `type Query { a(x: ${to}): Int }`).map(c => `${c.rule} ${c.class}`);

  it('arguments follow input variance, at every list level', () => {
    expect(at('String!', 'String')).toEqual(['input-made-optional non-breaking']);
    expect(at('String', 'String!')).toEqual(['param-made-required breaking']);
    expect(at('[String!]', '[String]')).toEqual(['input-made-optional non-breaking']);
    expect(at('[String]', '[String!]')).toEqual(['param-made-required breaking']);
    expect(at('[String!]!', '[String]')).toEqual(['input-made-optional non-breaking']);
    expect(at('[[Int]!]', '[[Int!]!]')).toEqual(['param-made-required breaking']);
    expect(at('Int', 'Float')).toEqual(['field-type-changed breaking']);
    expect(at('Int', '[Int]')).toEqual(['field-type-changed breaking']);
  });

  it('a stricter argument with a default still refuses an explicit null, so it is not "made optional"', () => {
    const cs = diff('type Query { a(x: Int): Int }', 'type Query { a(x: Int! = 5): Int }');
    expect(cs.map(c => `${c.rule} ${c.class}`)).toEqual(['field-type-changed breaking']);
  });

  it('added, removed and deprecated arguments', () => {
    const cs = diff('type Query { a(x: Int, y: Int): Int }', 'type Query { a(x: Int @deprecated, n: Int!, o: Int, d: Int! = 3): Int }');
    expect(cs.map(c => `${c.rule} ${c.class} [${c.element}]`)).toEqual([
      'arg-removed breaking [argument y]',
      'field-deprecated dangerous [argument x]',
      'optional-param-added non-breaking [argument d]',
      'optional-param-added non-breaking [argument o]',
      'required-param-added breaking [argument n]',
    ]);
  });

  it('a default added, changed or removed is dangerous', () => {
    expect(at('Int = 1', 'Int = 2')).toEqual(['arg-default-changed dangerous']);
    expect(at('Int', 'Int = 2')).toEqual(['arg-default-changed dangerous']);
    expect(at('Int = 1', 'Int')).toEqual(['arg-default-changed dangerous']);
    expect(at('[Int] = [1, 2]', '[Int] = [1,2]')).toEqual([]);
    expect(at('Filter = {a: 1}', 'Filter = { a : 1 }')).toEqual([]);
    expect(at('Int! = 1', 'Int! = 2')).toEqual(['arg-default-changed dangerous']);
    // Canonical defaults: object field order and number spelling are no change.
    expect(at('Filter = {a: 1, b: 2}', 'Filter = {b: 2, a: 1}')).toEqual([]);
    expect(at('Float = 1', 'Float = 1.0')).toEqual([]);
    expect(at('Filter = {a: 1, b: 2}', 'Filter = {a: 1, b: 3}')).toEqual(['arg-default-changed dangerous']);
  });

  it('removing the default of a non-null argument makes it required', () => {
    expect(at('Int! = 1', 'Int!')).toEqual(['arg-default-changed dangerous']);
  });
});

describe('diffGraphql: types', () => {
  it('object fields: added, removed, retyped, deprecated', () => {
    const head = BASE.replace('  total: Float\n  tags: [String]\n', '  total: Float @deprecated\n  tags: [String!]\n  currency: String\n').replace('  status: Status!\n}', '  status: Status\n}');
    expect(rows(diff(BASE, head))).toEqual([
      'field-added Order [field currency]',
      'field-deprecated Order [field total]',
      'field-type-changed Order [field status]',
      'output-field-made-non-null Order [field tags]',
    ]);
    expect(rows(diff(BASE, BASE.replace('  total: Float\n', '')))).toEqual(['field-removed Order [field total]']);
  });

  it('object field arguments are compared like operation arguments', () => {
    const cs = diff('type Order { items(first: Int): [Int] }', 'type Order { items(first: Int!, after: String): [Int] }');
    expect(rows(cs)).toEqual(['optional-param-added Order [argument after]', 'param-made-required Order [argument first]']);
  });

  it('input fields follow input variance and the required-field rule', () => {
    const at = (from: string, to: string) => diff(`input F { ${from} }`, `input F { ${to} }`).map(c => `${c.rule} ${c.class}`);
    expect(at('a: Int', 'a: Int!')).toEqual(['param-made-required breaking']);
    expect(at('a: Int!', 'a: Int')).toEqual(['input-made-optional non-breaking']);
    expect(at('a: [String]', 'a: [String!]')).toEqual(['param-made-required breaking']);
    expect(at('a: [String!]', 'a: [String]')).toEqual(['input-made-optional non-breaking']);
    expect(at('a: Int', 'a: Int! = 1')).toEqual(['field-type-changed breaking']);
    expect(at('a: Int', 'a: Int, b: Int!')).toEqual(['required-input-field-added breaking']);
    expect(at('a: Int', 'a: Int, b: Int! = 1')).toEqual(['field-added non-breaking']);
    expect(at('a: Int', 'a: Int, b: Int')).toEqual(['field-added non-breaking']);
    expect(at('a: Int, b: Int', 'a: Int')).toEqual(['field-removed breaking']);
    expect(at('a: Int = 1', 'a: Int = 2')).toEqual(['arg-default-changed dangerous']);
    expect(at('a: Int', 'a: Int @deprecated')).toEqual(['field-deprecated dangerous']);
    expect(at('a: Int', 'a: Int @constraint(max: 5)')).toEqual(['schema-unassessed potentially-breaking']);
  });

  it('enum values: added is dangerous, removed is breaking, deprecated is dangerous', () => {
    const cs = diff('enum S { A B C }', 'enum S { A @deprecated C D }');
    expect(cs.map(c => `${c.rule} ${c.class} ${c.element}`)).toEqual([
      'enum-value-deprecated dangerous A',
      'enum-value-removed breaking B',
      'graphql-enum-value-added dangerous D',
    ]);
  });

  it('union members: added is dangerous, removed is breaking', () => {
    const cs = diff('union U = A | B\ntype A { a: Int }\ntype B { b: Int }\ntype C { c: Int }', 'union U = A | C\ntype A { a: Int }\ntype B { b: Int }\ntype C { c: Int }');
    expect(cs.map(c => `${c.rule} ${c.class} ${c.element}`)).toEqual(['union-member-added dangerous C', 'union-member-removed breaking B']);
  });

  it('interfaces: implementing one more is non-breaking, one fewer is breaking; interface fields are outputs', () => {
    const base = 'interface N { id: ID }\ninterface M { m: Int }\ntype T implements N { id: ID m: Int }';
    expect(diff(base, base.replace('implements N', 'implements N & M')).map(c => `${c.rule} ${c.class} ${c.element}`)).toEqual(['interface-added dangerous M']);
    expect(diff(base.replace('implements N', 'implements N & M'), base).map(c => `${c.rule} ${c.class} ${c.element}`)).toEqual(['interface-removed breaking M']);
    expect(rows(diff(base, base.replace('interface N { id: ID }', 'interface N { id: ID! }')))).toEqual(['output-field-made-non-null N [field id]']);
  });

  it('types added, removed, or changed in kind', () => {
    expect(rows(diff(BASE, `${BASE}type Extra { a: Int }`))).toEqual(['type-added Extra']);
    expect(rows(diff(BASE, BASE.replace('scalar DateTime\n', '')))).toEqual(['type-removed DateTime']);
    const kind = diff('type T { a: Int }', 'input T { a: Int }');
    expect(kind.map(c => `${c.rule} ${c.detail}`)).toEqual(['type-removed T changed from object to input']);
    expect(rows(diff('enum E { A }', 'scalar E'))).toEqual(['type-removed E']);
  });
});

describe('diffGraphql: ambiguity', () => {
  it('a type defined in two files at head is not compared, never "removed"', () => {
    const base = schema({ 'a.graphql': 'type Query { a: Order }\ntype Order { id: ID }' });
    const head = schema({ 'a.graphql': 'type Query { a: Order }\ntype Order { id: ID }', 'copy/a.graphql': 'type Order { id: ID }' });
    expect(diffGraphql(base, head).map(c => `${c.rule} ${c.address} ${c.class}`)).toEqual(['schema-unassessed Order potentially-breaking']);
    expect(diffGraphql(head, base).map(c => `${c.rule} ${c.address}`)).toEqual(['schema-unassessed Order']);
    expect(diffGraphql(head, head)).toEqual([]);
  });

  it('a root type defined in two files is not compared, never every operation removed or added', () => {
    const base = schema({ 'a.graphql': 'type Query { a: Int b: Int }' });
    const head = schema({ 'a.graphql': 'type Query { a: Int b: Int }', 'copy/a.graphql': 'type Query { a: Int }' });
    const fwd = diffGraphql(base, head);
    expect(fwd.map(c => `${c.rule} ${c.address}`)).toEqual(['schema-unassessed Query']);
    expect(fwd[0].detail).toContain('at head');
    const back = diffGraphql(head, base);
    expect(back.map(c => `${c.rule} ${c.address}`)).toEqual(['schema-unassessed Query']);
    expect(back[0].detail).toContain('at the base revision');
    expect(diffGraphql(head, head)).toEqual([]);
    expect(contractBump(fwd)).toBeNull();
  });
});

describe('diffGraphql: directives are outside the model', () => {
  it('a changed custom directive on any element is schema-unassessed', () => {
    const cases: Array<[string, string]> = [
      ['type T @key(fields: "id") { a: Int }', 'type T @key(fields: "sku") { a: Int }'],
      ['type T { a: Int @external }', 'type T { a: Int }'],
      ['type T { a(x: Int @len(max: 1)): Int }', 'type T { a(x: Int @len(max: 2)): Int }'],
      ['enum E { A @tag(name: "x") }', 'enum E { A }'],
      ['type Query { a: Int @auth }', 'type Query { a: Int @auth(role: ADMIN) }'],
      ['type T { a: Int }\nextend type T @shareable', 'type T { a: Int }'],
    ];
    for (const [base, head] of cases) {
      const cs = diff(base, head);
      expect(cs.map(c => c.rule), `${base} → ${head}`).toEqual(['schema-unassessed']);
      expect(cs[0].class).toBe('potentially-breaking');
    }
  });

  it('a schema-unassessed change withholds the bump', () => {
    const cs = diff('type Query { a: Int @auth }', 'type Query { a: Int @auth(role: ADMIN) }');
    expect(contractBump(cs)).toBeNull();
  });
});

describe('diffGraphql: rule table and output', () => {
  it('every GraphQL rule it emits is a row of the closed table, with its class', () => {
    const head = BASE
      .replace('order(id: ID!, verbose: Boolean = false): Order', 'order(id: ID, verbose: Boolean = true, n: Int!): Order!')
      .replace('  legacy: String\n', '')
      .replace('enum Status { OPEN CLOSED }', 'enum Status { OPEN NEW }')
      .replace('union Result = Order', 'union Result = Node2\ntype Node2 { a: Int }');
    const cs = diff(BASE, head);
    for (const c of cs) expect(c.class).toBe(CONTRACT_RULES[c.rule]);
    expect(new Set(cs.map(c => c.rule))).toEqual(new Set([
      'input-made-optional', 'arg-default-changed', 'required-param-added', 'output-field-made-non-null',
      'operation-removed', 'graphql-enum-value-added', 'enum-value-removed', 'union-member-added',
      'union-member-removed', 'type-added',
    ]));
    expect(contractBump(cs)).toBe('major');
  });

  it('is sorted and deterministic', () => {
    const head = BASE.replace('  legacy: String\n', '').replace('enum Status { OPEN CLOSED }', 'enum Status { X }');
    const a = diff(BASE, head);
    expect(a).toEqual(diff(BASE, head));
    const keys = a.map(c => `${c.address}\0${c.rule}\0${c.element ?? ''}\0${c.detail}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('attributes a change to the file its element lives in', () => {
    const base = schema({ 'a.graphql': 'type Query { a: Int }\ntype T { x: Int }', 'b.graphql': 'extend type Query { b: Int }\nextend type T { y: Int }' });
    const head = schema({ 'a.graphql': 'type Query { a: Int }\ntype T { x: Int }', 'b.graphql': 'extend type Query { b: String }\nextend type T { y: String }' });
    expect(diffGraphql(base, head).map(c => `${c.rule} ${c.address} ${c.file}:${c.line}`)).toEqual([
      'field-type-changed Query.b b.graphql:1',
      'field-type-changed T b.graphql:2',
    ]);
  });

  it('an empty side is all additions or all removals', () => {
    const empty = mergeGraphqlSchema([]);
    expect(rows(diffGraphql(empty, one('type Query { a: Int }\ntype T { x: Int }')))).toEqual(['operation-added Query.a', 'type-added T']);
    expect(rows(diffGraphql(one('type Query { a: Int }\ntype T { x: Int }'), empty))).toEqual(['operation-removed Query.a', 'type-removed T']);
  });
});

describe('diffGraphql: review repros (roots, Federation 1, ambiguity, directive definitions)', () => {
  it('a Federation 1 subgraph that drops a field from `extend type Query` removes an operation', () => {
    const base = 'extend type Query { me: User topProducts: Int }\ntype User { id: ID! }';
    const head = 'extend type Query { me: User }\ntype User { id: ID! }';
    const cs = diff(base, head);
    expect(cs.map(c => `${c.rule} ${c.class} ${c.address}`)).toEqual(['operation-removed breaking Query.topProducts']);
    expect(diff(base, base)).toEqual([]);
  });

  it('a type ambiguous on both sides is compared by fingerprint: changed is schema-unassessed, unchanged is nothing', () => {
    const base = schema({ 'a.graphql': 'type Query { a: Int }\ntype Order { id: ID }', 'copy/a.graphql': 'type Order { id: ID }' });
    const head = schema({ 'a.graphql': 'type Query { a: Int }\ntype Order { id: ID }', 'copy/a.graphql': 'type Order { id: ID total: Int }' });
    const cs = diffGraphql(base, head);
    expect(cs.map(c => `${c.rule} ${c.address}`)).toEqual(['schema-unassessed Order']);
    expect(cs[0].detail).toContain('on both sides and changed');
    expect(contractBump(cs)).toBeNull();
    expect(diffGraphql(base, base)).toEqual([]);
  });

  it('a root type ambiguous on both sides that changes is schema-unassessed', () => {
    const base = schema({ 'a.graphql': 'type Query { a: Int }', 'copy/a.graphql': 'type Query { a: Int }' });
    const head = schema({ 'a.graphql': 'type Query { a: Int }', 'copy/a.graphql': 'type Query { a: String }' });
    expect(diffGraphql(base, head).map(c => `${c.rule} ${c.address}`)).toEqual(['schema-unassessed Query']);
    expect(diffGraphql(base, base)).toEqual([]);
  });

  it('a type ambiguous at base and gone at head, or new and ambiguous at head, is schema-unassessed', () => {
    const amb = schema({ 'a.graphql': 'type Query { a: Int }\ntype O { id: ID }', 'b.graphql': 'type O { id: ID }' });
    const gone = schema({ 'a.graphql': 'type Query { a: Int }' });
    expect(diffGraphql(amb, gone).map(c => `${c.rule} ${c.address}`)).toEqual(['schema-unassessed O']);
    expect(diffGraphql(gone, amb).map(c => `${c.rule} ${c.address}`)).toEqual(['schema-unassessed O']);
  });

  it('directive definitions: added is non-breaking; removed, a location removed, repeatable removed, a required argument added are breaking', () => {
    const base = 'type Query { a: Int }\ndirective @auth(role: String) repeatable on FIELD | QUERY';
    const cases: Array<[string, string]> = [
      ['type Query { a: Int }', 'directive-removed breaking @auth'],
      [base.replace('FIELD | QUERY', 'FIELD'), 'directive-location-removed breaking @auth'],
      [base.replace(' repeatable', ''), 'directive-repeatable-removed breaking @auth'],
      [base.replace('role: String', 'role: String, tenant: ID!'), 'required-param-added breaking @auth'],
      [`${base}\ndirective @cached on FIELD`, 'directive-added non-breaking @cached'],
    ];
    for (const [head, want] of cases) {
      const cs = diff(base, head);
      expect(cs.map(c => `${c.rule} ${c.class} ${c.address}`), head).toEqual([want]);
      expect(cs[0].class).toBe(CONTRACT_RULES[cs[0].rule]);
    }
    expect(diff(base, base.replace('FIELD | QUERY', 'QUERY | FIELD'))).toEqual([]);
    expect(diff(base.replace(' repeatable', ''), base)).toEqual([]);
    expect(diff(base, base.replace('FIELD | QUERY', 'FIELD | QUERY | MUTATION'))).toEqual([]);
    expect(diff(base, base.replace('role: String', 'role: String!')).map(c => c.rule)).toEqual(['param-made-required']);
  });

  it('a changed directive on `schema` is schema-unassessed', () => {
    const cs = diff('schema @link(url: "a") { query: Query }\ntype Query { a: Int }', 'schema @link(url: "b") { query: Query }\ntype Query { a: Int }');
    expect(cs.map(c => `${c.rule} ${c.address}`)).toEqual(['schema-unassessed schema']);
    expect(contractBump(cs)).toBeNull();
    expect(diff('extend schema @link(url: "a")\ntype Query { a: Int }', 'extend schema @link(url: "b")\ntype Query { a: Int }').map(c => c.rule)).toEqual(['schema-unassessed']);
  });

  it('with a `schema` definition naming only `query`, a type named Mutation is an ordinary type', () => {
    const base = 'schema { query: Query }\ntype Query { a: Mutation }\ntype Mutation { m: Int }';
    const cs = diff(base, base.replace('m: Int', 'm: String'));
    expect(rows(cs)).toEqual(['field-type-changed Mutation [field m]']);
    expect(rows(diff(base, base.replace('type Mutation { m: Int }', 'type Mutation { m: Int n: Int }')))).toEqual(['field-added Mutation [field n]']);
  });

  it('roots named differently in two files are schema-unassessed for that kind, never every operation removed', () => {
    const base = schema({ 'a.graphql': 'schema { query: Q1 }\ntype Q1 { a: Int }\ntype Q2 { b: Int }' });
    const head = schema({ 'a.graphql': 'schema { query: Q1 }\ntype Q1 { a: Int }\ntype Q2 { b: Int }', 'b.graphql': 'extend schema { query: Q2 }' });
    const cs = diffGraphql(base, head);
    expect(cs.map(c => `${c.rule} ${c.class} ${c.address}`)).toEqual(['schema-unassessed potentially-breaking schema.query']);
    expect(cs[0].detail).toContain('at head');
    expect(diffGraphql(head, base).map(c => `${c.rule} ${c.address}`)).toEqual(['schema-unassessed schema.query']);
  });
});
