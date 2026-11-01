import { describe, it, expect } from 'vitest';
import { readOpenApi, looksLikeOpenApi, type ContractDocument } from './openapi.js';
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
    expect(get.params).toEqual([{ name: 'id', in: 'path', required: true, type: 'string' }]);
    expect(get.response?.properties.map(p => `${p.name}:${p.type}`)).toEqual(['id:string', 'status:string{open,shipped}']);
    const post = d.operations.find(o => o.method === 'POST')!;
    expect(post.body).toEqual({ required: true, assessed: true, properties: [{ name: 'qty', required: false, type: 'integer:int32' }, { name: 'sku', required: true, type: 'string' }] });
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
    expect(d.operations[0].response).toBeUndefined();
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
      'GET /v1/orders/{id}|response-enum-widened|status',
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
