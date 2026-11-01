import { describe, it, expect } from 'vitest';
import { readOpenApi, looksLikeOpenApi, type ContractDocument } from '../../analyzer/contract/openapi.js';
import { diffContracts, contractParity, contractBump, CONTRACT_RULES } from './contract-diff.js';

const doc = (text: string, file = 'api.yaml'): ContractDocument => {
  const r = readOpenApi(file, text);
  if (!r || 'error' in r) throw new Error(`not readable: ${JSON.stringify(r)}`);
  return r;
};

const BASE = `openapi: 3.0.3
info: {title: T, version: '1'}
servers: [{url: 'https://{host}/v1/'}]
paths:
  /orders:
    parameters: [{name: limit, in: query, schema: {type: integer}}]
    get:
      responses:
        '200': {description: ok, content: {application/json: {schema: {type: object, properties: {items: {type: array}}}}}}
    post:
      requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/New'}}}}
      responses: {'201': {description: c}}
  /orders/{id}:
    get:
      parameters: [{$ref: '#/components/parameters/Id'}]
      responses: {'200': {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/Order'}}}}}
components:
  parameters:
    Id: {name: id, in: path, schema: {type: string}}
  schemas:
    New:
      allOf:
        - {type: object, required: [sku], properties: {sku: {type: string}}}
        - {type: object, properties: {qty: {type: integer, format: int32}}}
    Order: {type: object, properties: {id: {type: string}, status: {type: string, enum: [open, shipped]}}}
`;

describe('readOpenApi', () => {
  it('reads operations, base path, $refs, allOf, and lines', () => {
    const d = doc(BASE);
    expect(d.format).toBe('openapi-3');
    expect(d.basePath).toBe('/v1');
    expect(d.operations.map(o => o.address)).toEqual(['GET /v1/orders', 'GET /v1/orders/{id}', 'POST /v1/orders']);
    const get = d.operations.find(o => o.address === 'GET /v1/orders/{id}')!;
    expect(get.params).toEqual([{ name: 'id', in: 'path', required: true, type: 'string', hash: expect.any(String) }]);
    expect(get.response?.properties.map(p => `${p.name}:${p.type}`)).toEqual(['id:string', 'status:string{["\\"open\\"","\\"shipped\\""]}']);
    const post = d.operations.find(o => o.method === 'POST')!;
    expect(post.body).toMatchObject({ required: true, assessed: true, properties: [{ name: 'qty', required: false, type: 'integer:int32' }, { name: 'sku', required: true, type: 'string' }] });
    expect(d.operations.find(o => o.address === 'GET /v1/orders')!.params[0].name).toBe('limit'); // path-level parameter
    expect(post.line).toBe(10);
  });

  it('reads Swagger 2.0 with basePath and a body parameter', () => {
    const d = doc(`swagger: '2.0'\ninfo: {title: T, version: '1'}\nbasePath: /api\npaths:\n  /pets:\n    post:\n      parameters: [{name: body, in: body, required: true, schema: {type: object, properties: {name: {type: string}}}}]\n      responses: {'200': {description: ok, schema: {type: object, properties: {id: {type: integer}}}}}\n`);
    expect(d.format).toBe('swagger-2');
    const op = d.operations[0];
    expect(op.address).toBe('POST /api/pets');
    expect(op.params).toEqual([]);
    expect(op.body?.properties.map(p => p.name)).toEqual(['name']);
    expect(op.response?.properties.map(p => p.name)).toEqual(['id']);
  });

  it('is not a specification: undefined; a broken one: an error, never an empty contract', () => {
    expect(readOpenApi('x.yaml', 'name: app\nversion: 1\n')).toBeUndefined();
    expect(looksLikeOpenApi('openapi: 3.0.0\npaths: {}\n')).toBe(true);
    const bad = readOpenApi('b.yaml', 'openapi: 3.0.0\npaths:\n  /a: [unclosed\n');
    expect(bad && 'error' in bad).toBe(true);
  });

  it('lists external $refs, oneOf, callbacks, and webhooks as outside the model', () => {
    const d = doc(`openapi: 3.1.0\ninfo: {title: T, version: '1'}\nwebhooks: {ping: {}}\npaths:\n  /a:\n    post:\n      callbacks: {cb: {}}\n      requestBody: {content: {application/json: {schema: {oneOf: [{type: string}, {type: integer}]}}}}\n      responses: {'200': {description: ok, content: {application/json: {schema: {$ref: 'other.yaml#/X'}}}}}\n`);
    expect(d.unassessed).toEqual(['callbacks', 'external $ref', 'webhooks']);
    expect(d.operations[0].body?.assessed).toBe(false);
    expect(d.operations[0].response?.assessed).toBe(false);
  });

  it('a $ref cycle ends within the hop bound', () => {
    const d = doc(`openapi: 3.0.0\ninfo: {title: T, version: '1'}\npaths:\n  /a:\n    get:\n      responses: {'200': {$ref: '#/components/responses/A'}}\ncomponents:\n  responses:\n    A: {$ref: '#/components/responses/B'}\n    B: {$ref: '#/components/responses/A'}\n`);
    expect(d.operations[0].response).toMatchObject({ assessed: false, properties: [] });
    expect(d.unassessed).toContain('unresolved $ref');
  });

  it('YAML alias bombs are refused, not expanded', () => {
    const bomb = ['openapi: 3.0.0', 'paths: {}', 'a: &a [x,x,x,x,x,x,x,x,x,x]', ...'bcdefghij'.split('').map((c, i) => `${c}: &${c} [*${'abcdefghij'[i]},*${'abcdefghij'[i]},*${'abcdefghij'[i]},*${'abcdefghij'[i]},*${'abcdefghij'[i]},*${'abcdefghij'[i]},*${'abcdefghij'[i]},*${'abcdefghij'[i]},*${'abcdefghij'[i]},*${'abcdefghij'[i]}]`)].join('\n');
    const r = readOpenApi('bomb.yaml', bomb);
    expect(r && 'error' in r).toBe(true);
  });
});

describe('diffContracts', () => {
  const edit = (f: (s: string) => string) => doc(f(BASE));

  it('no change: no verdicts, patch bump', () => {
    expect(diffContracts([doc(BASE)], [doc(BASE)])).toEqual([]);
    expect(contractBump([])).toBe('patch');
  });

  it('classifies each rule of the closed table', () => {
    const head = edit(s => s
      .replace("  /orders/{id}:\n    get:", "  /orders/{id}:\n    get:\n      deprecated: true")
      .replace("parameters: [{name: limit, in: query, schema: {type: integer}}]", "parameters: [{name: limit, in: query, required: true, schema: {type: string}}, {name: tenant, in: header, required: true, schema: {type: string}}, {name: q, in: query, schema: {type: string}}]")
      .replace("properties: {qty: {type: integer, format: int32}}", "required: [qty], properties: {qty: {type: integer, format: int32}, note: {type: string}, code: {type: string}}")
      .replace("required: [sku], properties: {sku: {type: string}}", "required: [sku, code2], properties: {sku: {type: string}, code2: {type: string}}")
      .replace("status: {type: string, enum: [open, shipped]}", "status: {type: string, enum: [open, refunded, shipped]}, total: {type: number}")
      .replace("properties: {id: {type: string}, ", "properties: {")
      .replace("properties: {items: {type: array}}", "properties: {items: {type: object}}"));
    const changes = diffContracts([doc(BASE)], [head]);
    const got = changes.map(c => `${c.address}|${c.rule}|${c.element ?? ''}`);
    expect(got).toEqual(expect.arrayContaining([
      'GET /v1/orders/{id}|operation-deprecated|',
      'GET /v1/orders|required-param-added|header:tenant',
      'GET /v1/orders|optional-param-added|query:q',
      'GET /v1/orders|param-made-required|query:limit',
      'GET /v1/orders|param-type-changed|query:limit',
      'GET /v1/orders|response-property-type-changed|items',
      'POST /v1/orders|body-property-made-required|qty',
      'POST /v1/orders|optional-body-property-added|note',
      'POST /v1/orders|required-body-property-added|code2',
      'GET /v1/orders/{id}|response-property-removed|id',
      'GET /v1/orders/{id}|response-property-added|total',
      'GET /v1/orders/{id}|response-property-widened|status',
    ]));
    for (const c of changes) expect(c.class).toBe(CONTRACT_RULES[c.rule]);
    expect(contractBump(changes)).toBe('major');
  });

  it('operations removed, added, and moved between files', () => {
    const base = doc(BASE);
    const head = doc(BASE.replace('  /orders/{id}:', '  /orders/{id}/items:'));
    const rules = diffContracts([base], [head]).map(c => `${c.rule} ${c.address}`);
    expect(rules).toEqual(['operation-removed GET /v1/orders/{id}', 'operation-added GET /v1/orders/{id}/items']);
    expect(diffContracts([base], [{ ...base, file: 'moved.yaml' }])).toEqual([]);
  });

  it('a changed schema outside the model is potentially-breaking and withholds the bump', () => {
    const head = edit(s => s.replace("{$ref: '#/components/schemas/Order'}", '{oneOf: [{type: string}, {type: integer}]}'));
    const changes = diffContracts([doc(BASE)], [head]);
    expect(changes.map(c => c.rule)).toEqual(['schema-unassessed']);
    expect(contractBump(changes)).toBeNull();
  });

  it('additions only: minor', () => {
    const head = edit(s => s.replace("properties: {items: {type: array}}", "properties: {items: {type: array}, next: {type: string}}"));
    expect(contractBump(diffContracts([doc(BASE)], [head]))).toBe('minor');
  });
});

describe('contractParity', () => {
  const route = (method: string, path: string) => ({ method, path, file: 'src/app.ts', handler: 'h' });

  it('matches with and without the base path, and both directions of mismatch', () => {
    const p = contractParity([doc(BASE)], [
      route('GET', '/orders'), route('POST', '/v1/orders'), route('GET', '/orders/export'),
      route('GET', '/health'), route('GET', '/ordersX'), route('ALL', '/orders/*'),
    ]);
    expect(p.matched).toBe(2);
    expect(p.declaredUnimplemented.map(u => u.address)).toEqual(['GET /v1/orders/{id}']);
    expect(p.implementedUndeclared.map(u => `${u.method} ${u.path}`)).toEqual(['GET /orders/export']);
    expect(p.dynamic).toBe(1);
  });

  it('a path parameter matches whatever the framework names it', () => {
    const p = contractParity([doc(BASE)], [route('GET', '/v1/orders/:orderId'), route('GET', '/orders'), route('POST', '/orders')]);
    expect(p.declaredUnimplemented).toEqual([]);
  });
});

describe('adversarial review regressions', () => {
  const spec = (paths: string, extra = '') => `openapi: 3.0.0\ninfo: {title: T, version: '1'}\n${extra}paths:\n${paths}`;
  const rules = (a: string, b: string) => diffContracts([doc(a)], [doc(b)]).map(c => `${c.rule}${c.element ? ` ${c.element}` : ''}`);
  const post = (schema: string) => spec(`  /a:\n    post:\n      requestBody: {content: {application/json: {schema: ${schema}}}}\n      responses: {'200': {description: ok}}\n`);
  const get = (schema: string) => spec(`  /a:\n    get:\n      responses: {'200': {description: ok, content: {application/json: {schema: ${schema}}}}}\n`);

  it('a change to a schema outside the model is potentially-breaking, never "no change"', () => {
    expect(rules(post("{oneOf: [{type: object, properties: {a: {type: string}}}]}"), post("{oneOf: [{type: object, required: [b], properties: {b: {type: integer}}}]}"))).toEqual(['schema-unassessed']);
    expect(rules(post("{$ref: 'a.yaml#/A'}"), post("{$ref: 'b.yaml#/B'}"))).toEqual(['schema-unassessed']);
    expect(rules(get('{type: array, items: {type: string}}'), get('{type: array, items: {type: integer}}'))).toEqual(['schema-unassessed']);
    expect(contractBump(diffContracts([doc(get('{type: array, items: {type: string}}'))], [doc(get('{type: array, items: {type: integer}}'))]))).toBeNull();
  });

  it('nested, constraint, and nullability changes are seen', () => {
    const nested = (t: string) => post(`{type: object, properties: {addr: {type: object, properties: {zip: {type: ${t}}}}}}`);
    expect(rules(nested('string'), nested('integer'))).toEqual(['schema-unassessed addr']);
    expect(rules(post('{type: object, properties: {n: {type: string, maxLength: 100}}}'), post('{type: object, properties: {n: {type: string, maxLength: 5}}}'))).toEqual(['schema-unassessed n']);
    expect(rules(get('{type: object, properties: {n: {type: string}}}'), get('{type: object, properties: {n: {type: string, nullable: true}}}'))).toEqual(['response-property-widened n']);
    expect(rules(post('{type: object, properties: {n: {type: string}}}'), post('{type: object, additionalProperties: false, properties: {n: {type: string}}}'))).toEqual(['schema-unassessed']);
  });

  it('documentation-only edits are not changes', () => {
    expect(rules(post('{type: object, properties: {n: {type: string, description: a}}}'), post('{type: object, properties: {n: {type: string, description: b, example: x}}}'))).toEqual([]);
  });

  it('a parameter declared with content is compared', () => {
    const p = (t: string) => spec(`  /a:\n    get:\n      parameters: [{name: f, in: query, content: {application/json: {schema: {type: ${t}}}}}]\n      responses: {'200': {description: ok}}\n`);
    expect(rules(p('string'), p('integer'))).toEqual(['param-type-changed query:f']);
  });

  it('unquoted versions are read, and a declared but unreadable document is an error', () => {
    expect(doc(`swagger: 2.0\ninfo: {title: T, version: '1'}\npaths:\n  /a:\n    get: {responses: {'200': {description: ok}}}\n`).format).toBe('swagger-2');
    expect(doc(`openapi: 3.0\ninfo: {title: T, version: '1'}\npaths:\n  /a:\n    get: {responses: {'200': {description: ok}}}\n`).operations).toHaveLength(1);
    expect(readOpenApi('x.yaml', 'openapi: 4.0.0\npaths: {}\n')).toEqual({ file: 'x.yaml', error: expect.stringContaining('unsupported') });
  });

  it('the sniff finds minified JSON, a BOM, and a key after long comments', () => {
    expect(looksLikeOpenApi('{"info":{"title":"T"},"openapi":"3.0.0","paths":{}}')).toBe(true);
    expect(looksLikeOpenApi('\uFEFFopenapi: 3.0.0\npaths: {}\n')).toBe(true);
    expect(looksLikeOpenApi(`${'# c\n'.repeat(2000)}openapi: 3.0.0\npaths: {}\n`)).toBe(true);
    expect(doc('\uFEFF' + spec("  /a:\n    get: {responses: {'200': {description: ok}}}\n")).operations).toHaveLength(1);
  });

  it('reads paths in linear time (8x the paths, well under 64x the time)', () => {
    const big = (n: number) => spec(Array.from({ length: n }, (_, i) => `  /p${i}:\n    get: {responses: {'200': {description: ok}}}\n`).join(''));
    const time = (text: string) => { const t = performance.now(); const d = doc(text); return { ms: performance.now() - t, n: d.operations.length }; };
    const small = big(2000);
    const large = big(16000);
    time(small); // warm up
    const a = Math.min(time(small).ms, time(small).ms);
    const [b1, b2] = [time(large), time(large)];
    expect(b1.n).toBe(16000);
    expect(Math.min(b1.ms, b2.ms) / a).toBeLessThan(24);
  });

  it('an operation declared in two files is compared as a set', () => {
    const a = doc(post('{type: object, properties: {n: {type: string}}}'), 'a.yaml');
    const b1 = doc(post('{type: object, properties: {n: {type: string}}}'), 'b.yaml');
    const b2 = doc(post('{type: object, properties: {n: {type: integer}}}'), 'b.yaml');
    expect(diffContracts([a, b1], [a, b2]).map(c => c.rule)).toEqual(['schema-unassessed']);
    expect(diffContracts([a, b1], [a, b1])).toEqual([]);
  });

  it('allOf: the parent schema properties and required lists across members count', () => {
    expect(rules(post('{allOf: [{type: object, properties: {x: {type: string}}}], properties: {p: {type: string}}}'),
      post('{allOf: [{type: object, properties: {x: {type: string}}}, {required: [x]}], required: [p], properties: {p: {type: integer}}}')))
      .toEqual(['body-property-made-required p', 'body-property-made-required x', 'body-property-type-changed p']);
  });

  it('Swagger 2: the operation body wins over a path-level body', () => {
    const sw = (req: string) => `swagger: '2.0'\ninfo: {title: T, version: '1'}\npaths:\n  /a:\n    parameters: [{name: b, in: body, schema: {type: object, properties: {x: {type: string}}}}]\n    post:\n      parameters: [{name: b, in: body, schema: {type: object, ${req}properties: {x: {type: string}, y: {type: string}}}}]\n      responses: {'200': {description: ok}}\n`;
    expect(rules(sw(''), sw('required: [y], '))).toEqual(['body-property-made-required y']);
  });

  it('a duplicated path key is an error, not a silent last-wins', () => {
    expect(readOpenApi('d.yaml', spec("  /a:\n    get: {responses: {'200': {description: ok}}}\n  /a:\n    post: {responses: {'200': {description: ok}}}\n"))).toEqual({ file: 'd.yaml', error: expect.stringContaining('duplicate key: /a') });
  });

  it('YAML merge keys are applied', () => {
    expect(doc(spec("  /a: {<<: *ops}\n", "x-ops: &ops {get: {responses: {'200': {description: ok}}}}\n")).operations.map(o => o.address)).toEqual(['GET /a']);
  });

  it('renaming a path parameter is not a change', () => {
    const p = (n: string) => spec(`  /o/{${n}}:\n    get:\n      parameters: [{name: ${n}, in: path, required: true, schema: {type: string}}]\n      responses: {'200': {description: ok}}\n`);
    expect(diffContracts([doc(p('id'))], [doc(p('orderId'))]).filter(c => c.class === 'breaking')).toEqual([]);
  });

  it('base paths from variable schemes, scheme-relative URLs, and operation servers', () => {
    const ok = "    get: {responses: {'200': {description: ok}}}\n";
    expect(doc(spec(`  /a:\n${ok}`, "servers: [{url: '{scheme}://api.x.com/v1'}]\n")).operations[0].address).toBe('GET /v1/a');
    expect(doc(spec(`  /a:\n${ok}`, "servers: [{url: '//api.x.com/v2/'}]\n")).operations[0].address).toBe('GET /v2/a');
    expect(doc(spec(`  /a:\n    servers: [{url: /v3}]\n${ok}`, "servers: [{url: /v1}]\n")).operations[0].address).toBe('GET /v3/a');
  });

  it('enum values with commas do not collide', () => {
    expect(rules(get("{type: object, properties: {e: {type: string, enum: [a, 'b,c']}}}"), get('{type: object, properties: {e: {type: string, enum: [a, b, c]}}}'))).toEqual(['response-property-type-changed e']);
  });
});

describe('second review regressions', () => {
  const spec = (paths: string, extra = '', v = '3.0.0') => `openapi: ${v}\ninfo: {title: T, version: '1'}\n${extra}paths:\n${paths}`;
  const post = (schema: string, extra = '', v?: string) => spec(`  /a:\n    post:\n      requestBody: {content: {application/json: {schema: ${schema}}}}\n      responses: {'200': {description: ok}}\n`, extra, v);
  const get = (responses: string) => spec(`  /a:\n    get:\n      responses: ${responses}\n`);
  const diff = (a: string, b: string) => diffContracts([doc(a)], [doc(b)]);
  const rules = (a: string, b: string) => diff(a, b).map(c => `${c.rule}${c.element ? ` ${c.element}` : ''}`);
  const bump = (a: string, b: string) => contractBump(diff(a, b));

  it('no-op edits are not changes: set order, duplicates, inline vs $ref', () => {
    expect(rules(post('{type: object, required: [a, b], properties: {a: {type: string}, b: {type: string, enum: [x, y]}}}'),
      post('{type: object, required: [b, a, a], properties: {a: {type: string}, b: {type: string, enum: [y, x]}}}'))).toEqual([]);
    const comp = "components: {schemas: {N: {type: object, properties: {a: {type: string, maxLength: 3}}}}}\n";
    expect(rules(post('{type: object, properties: {a: {type: string, maxLength: 3}}}', comp), post("{$ref: '#/components/schemas/N'}", comp))).toEqual([]);
  });

  it('an unexplained difference is reported even when another rule fires', () => {
    expect(bump(post('{type: object, properties: {a: {type: string}}}'), post('{type: object, additionalProperties: false, properties: {a: {type: string}, b: {type: string}}}'))).toBeNull();
    const q = (extra: string) => spec(`  /a:\n    get:\n      parameters: [{name: q, in: query, ${extra}schema: {type: string${extra ? ', maxLength: 3' : ''}}}]\n      responses: {'200': {description: ok}}\n`);
    expect(bump(q('required: true, '), q(''))).toBeNull();
    expect(rules(get("{'200': {description: ok, content: {application/json: {schema: {type: object, required: [id], properties: {id: {type: string}}}}}}}"),
      get("{'200': {description: ok, content: {application/json: {schema: {type: object, properties: {id: {type: string}, n: {type: string}}}}}}}"))).toEqual(['response-property-added n', 'response-property-made-optional id']);
  });

  it('a change deep inside a large schema is seen', () => {
    const big = (t: string) => post(`{type: array, items: {type: object, properties: {${Array.from({ length: 3000 }, (_, i) => `p${i}: {type: ${i === 999 ? t : 'string'}}`).join(', ')}}}}`);
    expect(bump(big('string'), big('integer'))).toBeNull();
    expect(diff(big('string'), big('string'))).toEqual([]);
  });

  it('hashes do not depend on which operation is read first (reference cycles)', () => {
    const comp = "components: {schemas: {A: {type: object, properties: {b: {$ref: '#/components/schemas/B'}}}, B: {type: object, properties: {a: {$ref: '#/components/schemas/A'}}}}}\n";
    const z = "  /z:\n    get: {responses: {'200': {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/A'}}}}}}\n";
    const a = "  /a:\n    get: {responses: {'200': {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/B'}}}}}}\n";
    expect(rules(spec(z, comp), spec(a + z, comp))).toEqual(['operation-added']);
  });

  it('OpenAPI 3.1 keywords beside a $ref count', () => {
    const comp = "components: {schemas: {B: {type: object, properties: {a: {type: string}}}}}\n";
    expect(rules(post("{$ref: '#/components/schemas/B'}", comp, '3.1.0'), post("{$ref: '#/components/schemas/B', required: [a]}", comp, '3.1.0'))).toEqual(['body-property-made-required a']);
  });

  it('every 2xx response counts: 2XX, a second 2xx, and a changed status code', () => {
    const r = (code: string, props: string) => `{'${code}': {description: ok, content: {application/json: {schema: {type: object, properties: {${props}}}}}}}`;
    expect(rules(get(r('2XX', 'a: {type: string}')), get(r('2XX', 'b: {type: string}')))).toContain('response-property-removed a');
    expect(bump(get(r('200', 'a: {type: string}')), get(r('201', 'a: {type: string}')))).toBeNull();
    expect(bump(get("{'200': {description: ok}, '202': {description: ok, content: {text/plain: {schema: {type: string}}}}}"),
      get("{'200': {description: ok}, '202': {description: ok, content: {text/plain: {schema: {type: integer}}}}}"))).toBeNull();
  });

  it('request-side widening is not breaking; header case and server order are not changes', () => {
    expect(bump(post('{type: object, properties: {a: {type: string, enum: [x]}}}'), post('{type: object, properties: {a: {type: string}}}'))).toBe('minor');
    expect(bump(post('{type: object, properties: {a: {type: string}}}'), post('{type: object, properties: {a: {type: string, nullable: true}}}'))).toBe('minor');
    const h = (n: string) => spec(`  /a:\n    get:\n      parameters: [{name: ${n}, in: header, required: true, schema: {type: string}}]\n      responses: {'200': {description: ok}}\n`);
    expect(diff(h('X-Id'), h('x-id'))).toEqual([]);
    const ok = "  /a:\n    get: {responses: {'200': {description: ok}}}\n";
    expect(diff(spec(ok, "servers: [{url: 'https://api.x.com/v1'}]\n"), spec(ok, "servers: [{url: 'http://localhost:8080'}, {url: 'https://api.x.com/v1'}]\n"))).toEqual([]);
  });

  it('operations moved behind an external path $ref are not reported removed', () => {
    const before = spec("  /a:\n    get: {responses: {'200': {description: ok}}}\n");
    const after = spec("  /a: {$ref: './paths/a.yaml'}\n");
    expect(diff(before, after).map(c => `${c.rule} ${c.class}`)).toEqual(['schema-unassessed potentially-breaking']);
  });

  it('duplicate method keys and unresolved $ref retargets are not silent', () => {
    expect(readOpenApi('d.yaml', spec("  /a:\n    get: {responses: {'200': {description: ok}}}\n    get: {responses: {'201': {description: ok}}}\n"))).toEqual({ file: 'd.yaml', error: 'duplicate key: get' });
    expect(bump(post("{type: object, properties: {p: {$ref: '#/components/schemas/Gone1'}}}"), post("{type: object, properties: {p: {$ref: '#/components/schemas/Gone2'}}}"))).toBeNull();
  });

  it('the sniff accepts indented and flow-style YAML', () => {
    expect(looksLikeOpenApi('  openapi: 3.0.0\n  paths: {}\n')).toBe(true);
    expect(looksLikeOpenApi('{openapi: 3.0.0, paths: {}}')).toBe(true);
  });
});
