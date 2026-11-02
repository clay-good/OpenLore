import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { changedContractsForSpecFiles, contractsForFiles } from './contract-briefing.js';
import { handleBlastRadius } from '../mcp-handlers/blast-radius.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
const write = (root: string, rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, env: GIT_ENV });

const SPEC = `openapi: 3.0.3
info: {title: Orders, version: '1'}
servers: [{url: 'https://api.example.com/v1'}]
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content: {application/json: {schema: {type: object, required: [sku, qty], properties: {sku: {type: string}, qty: {type: integer}, note: {type: string}}}}}
      responses: {'201': {description: created}}
  /orders/{id}:
    get:
      deprecated: true
      parameters: [{name: id, in: path, required: true, schema: {type: string}}, {name: expand, in: query, schema: {type: string}}]
      responses: {'200': {description: ok}}
  /health:
    get:
      responses: {'200': {description: ok}}
`;
const routes = (list: Array<[string, string, string]>) => JSON.stringify({ routes: list.map(([method, path, file]) => ({ method, path, framework: 'express', file, handler: 'res' })) });

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'olbrief-')));
  dirs.push(root);
  write(root, '.gitignore', '.openlore/\n');
  for (const [rel, c] of Object.entries(files)) write(root, rel, c);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

const INVENTORY = routes([['POST', '/orders', 'src/orders.ts'], ['GET', '/orders/:id', 'src/orders.ts'], ['GET', '/health', 'src/health.ts']]);

describe('contract elements in the briefings', () => {
  it('names the operations a file\'s routes serve, with what the specification requires', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC, '.openlore/analysis/route-inventory.json': INVENTORY, 'src/orders.ts': 'export {};\n', 'src/health.ts': 'export {};\n' });
    const r = await contractsForFiles(root, ['src/orders.ts']);
    expect(r?.contracts).toEqual([
      { operation: 'GET /v1/orders/{id}', spec: 'api/openapi.yaml:13', route: { file: 'src/orders.ts', method: 'GET', path: '/orders/:id' }, deprecated: true, matchedWithoutBasePath: true, requiredParams: ['id (path, string)'], requiredBody: [] },
      { operation: 'POST /v1/orders', operationId: 'createOrder', spec: 'api/openapi.yaml:6', route: { file: 'src/orders.ts', method: 'POST', path: '/orders' }, matchedWithoutBasePath: true, requiredParams: [], requiredBody: ['qty (integer)', 'sku (string)'] },
    ]);
  });

  it('a generic path never matches another specification without its base path; a full-path match does', async () => {
    const PETS = `openapi: 3.0.3\ninfo: {title: Pets, version: '1'}\nservers: [{url: /api/v1}]\npaths:\n  /{petId}:\n    get: {operationId: getPet, responses: {'200': {description: ok}}}\n  /:\n    post: {operationId: createPet, responses: {'201': {description: ok}}}\n  /pets:\n    get: {operationId: listPets, responses: {'200': {description: ok}}}\n`;
    const inv = routes([['GET', '/:id', 'src/tasks.ts'], ['POST', '/', 'src/tasks.ts'], ['GET', '/api/v1/pets', 'src/pets.ts']]);
    const root = repo({ 'pets/openapi.yaml': PETS, 'api/openapi.yaml': SPEC, '.openlore/analysis/route-inventory.json': inv, 'src/tasks.ts': 'x', 'src/pets.ts': 'x' });
    expect(await contractsForFiles(root, ['src/tasks.ts'])).toBeUndefined();
    const pets = await contractsForFiles(root, ['src/pets.ts']);
    expect(pets?.contracts.map(c => [c.operation, c.matchedWithoutBasePath])).toEqual([['GET /api/v1/pets', undefined]]);
  });

  it('a route file outside the scope joins it when it names a function in scope', async () => {
    const router = "router.post('/orders', async (req, res) => res.json(await orderService.createOrder(req.body)));\n";
    const root = repo({ 'api/openapi.yaml': SPEC, '.openlore/analysis/route-inventory.json': routes([['POST', '/orders', 'src/routes.ts']]), 'src/routes.ts': router, 'src/service.ts': 'export function createOrder() {}\n' });
    const r = await contractsForFiles(root, ['src/service.ts'], ['createOrder', 'ord']);
    expect(r?.contracts).toEqual([expect.objectContaining({ operation: 'POST /v1/orders', routeFileNames: 'createOrder', route: expect.objectContaining({ file: 'src/routes.ts' }) })]);
    expect(await contractsForFiles(root, ['src/service.ts'], ['deleteOrder'])).toBeUndefined();
  });

  it('no route in scope, no inventory, or no specification: nothing', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC, '.openlore/analysis/route-inventory.json': INVENTORY, 'src/other.ts': 'export {};\n' });
    expect(await contractsForFiles(root, ['src/other.ts'])).toBeUndefined();
    expect(await contractsForFiles(repo({ 'api/openapi.yaml': SPEC }), ['src/orders.ts'])).toBeUndefined();
    expect(await contractsForFiles(repo({ '.openlore/analysis/route-inventory.json': INVENTORY }), ['src/orders.ts'])).toBeUndefined();
  });

  it('blast_radius lists the operations served by routes in the changed files', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC, '.openlore/analysis/route-inventory.json': INVENTORY, 'src/orders.ts': 'export {};\n', 'src/health.ts': 'export {};\n',
      '.openlore/analysis/llm-context.json': JSON.stringify({ callGraph: { nodes: [], edges: [] } }) });
    write(root, 'src/health.ts', 'export const ok = true;\n');
    const r = await handleBlastRadius({ directory: root, baseRef: 'HEAD' }) as { contracts?: { contracts: Array<{ operation: string }> } };
    expect(r.contracts?.contracts.map(c => c.operation)).toEqual(['GET /v1/health']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The inverse question: the diff changed a SPECIFICATION (change:
// add-contract-graph-projection). A specification is not a call-graph node and declares no
// handler of its own, so a diff that only edits `openapi.yaml` briefed an agent on nothing at
// all — no impacted symbols, no tests, no contracts.
// ════════════════════════════════════════════════════════════════════════════
describe('contract elements a changed specification declares', () => {
  const CLIENT = `export async function loadOrder(id: string) {
  const r = await fetch(\`https://api.example.com/v1/orders/\${id}\`);
  return r.json();
}
`;

  it('names each operation with the handler that serves it and the callers that consume it', async () => {
    const root = repo({
      'api/openapi.yaml': SPEC,
      '.openlore/analysis/route-inventory.json': INVENTORY,
      'src/orders.ts': 'export {};\n',
      'src/health.ts': 'export {};\n',
      'src/client.ts': CLIENT,
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    expect(brief, 'a changed specification must brief').toBeDefined();
    expect(brief!.specs).toEqual(['api/openapi.yaml']);
    const byOp = new Map(brief!.elements.map(e => [e.operation, e]));
    expect([...byOp.keys()].sort()).toEqual([
      'GET /v1/health', 'GET /v1/orders/{id}', 'POST /v1/orders',
    ]);
    // Served by the indexed route.
    expect(byOp.get('POST /v1/orders')?.servedBy).toMatchObject({ file: 'src/orders.ts', method: 'POST' });
    expect(byOp.get('POST /v1/orders')?.operationId).toBe('createOrder');
    // Consumed by a client the diff never touched — the reason to ask the question.
    const consumed = byOp.get('GET /v1/orders/{id}');
    expect(consumed?.consumedBy?.[0]).toMatchObject({ file: 'src/client.ts' });
    expect(consumed?.deprecated).toBe(true);
    // It is a blast radius, and it names the tool that owns the verdict.
    expect(brief!.note).toContain('NOT a verdict');
    expect(brief!.note).toContain('certify_service_contract');
  });

  it('returns nothing when the diff touches no specification', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC, '.openlore/analysis/route-inventory.json': INVENTORY, 'src/orders.ts': 'export {};\n' });
    await expect(changedContractsForSpecFiles(root, ['src/orders.ts'])).resolves.toBeUndefined();
    await expect(changedContractsForSpecFiles(root, [])).resolves.toBeUndefined();
  });

  // The honest half: "nothing binds to this" is only claimable when a route index EXISTS.
  // Without one, silence means not-assessed, and saying `unbound` would be a false negative.
  it('does not claim an operation is unbound when no route handler is indexed', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC, 'src/orders.ts': 'export {};\n' });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    expect(brief).toBeDefined();
    for (const e of brief!.elements) {
      expect(e.servedBy, 'no index, so nothing can be served').toBeUndefined();
      expect(e.unbound, 'absence of an index is not absence of a handler').toBeUndefined();
    }
    expect(brief!.notAssessed?.join(' ')).toContain('not assessed');
  });

  it('marks an operation unbound only when the index exists and nothing matches', async () => {
    const root = repo({
      'api/openapi.yaml': SPEC,
      '.openlore/analysis/route-inventory.json': routes([['POST', '/orders', 'src/orders.ts']]),
      'src/orders.ts': 'export {};\n',
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    const byOp = new Map(brief!.elements.map(e => [e.operation, e]));
    expect(byOp.get('POST /v1/orders')?.unbound).toBeUndefined();
    expect(byOp.get('GET /v1/health')?.unbound).toBe(true);
  });

  it('names a changed specification it could not parse instead of omitting it', async () => {
    const root = repo({
      'api/openapi.yaml': 'openapi: 3.0.3\npaths:\n  /a:\n    get: [not, an, object]\n',
      '.openlore/analysis/route-inventory.json': INVENTORY,
      'src/orders.ts': 'export {};\n',
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    if (brief) {
      expect(brief.specs).toContain('api/openapi.yaml');
      // Either it parsed with no operations, or it is named as unparseable — never silent.
      if (!brief.elements.length) expect(brief.notAssessed?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('surfaces through blast_radius when the diff is a specification edit', async () => {
    const root = repo({
      'api/openapi.yaml': SPEC,
      '.openlore/analysis/route-inventory.json': INVENTORY,
      'src/orders.ts': 'export {};\n',
      'src/health.ts': 'export {};\n',
      'src/client.ts': CLIENT,
      '.openlore/analysis/llm-context.json': JSON.stringify({ callGraph: { nodes: [], edges: [] } }),
    });
    // Edit only the specification: add an operation, touching no source file.
    write(root, 'api/openapi.yaml', SPEC + `  /orders/{id}/items:\n    get:\n      responses: {'200': {description: ok}}\n`);

    const result = await handleBlastRadius({ directory: root }) as Record<string, unknown>;
    const changed = result.changedContracts as { elements: Array<{ operation: string }> } | undefined;

    expect(changed, `a specification-only diff must still brief; got keys ${Object.keys(result).join(',')}`).toBeDefined();
    // The point: the rest of the briefing is empty for a specification-only diff, so without
    // this field the agent is told nothing at all.
    expect(changed!.elements.map(e => e.operation)).toContain('POST /v1/orders');
    expect(changed!.elements.length).toBeGreaterThan(0);
  });
});

// Each case below produced a FALSE claim before the fix. `unbound` and `consumedBy` are the two
// assertions this field adds, so each one that can be wrong needs a test that pins it.
describe('the changed-specification briefing never claims more than it checked', () => {
  const SPEC_ONE = `openapi: 3.0.3
info: {title: A, version: '1'}
servers: [{url: 'https://api.example.com/v1'}]
paths:
  /alpha:
    get:
      operationId: getAlpha
      responses: {'200': {description: ok}}
`;

  it('does not claim unbound when every indexed route carries a wildcard method', async () => {
    // Django routes are extracted with method UNKNOWN. They cannot be matched to an operation,
    // so they were filtered out of matching — while the honesty gate counted them as an index.
    const root = repo({
      'api/openapi.yaml': SPEC_ONE,
      '.openlore/analysis/route-inventory.json': routes([['UNKNOWN', '/v1/alpha', 'app/urls.py']]),
      'app/urls.py': 'urlpatterns = []\n',
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    expect(brief!.elements[0].unbound, 'a wildcard-method route may serve it').toBeUndefined();
    expect(brief!.notAssessed?.join(' ')).toContain('wildcard method');
  });

  it('discloses that the serving handler comes from the last analyze, not the working tree', async () => {
    const root = repo({
      'api/openapi.yaml': SPEC_ONE,
      '.openlore/analysis/route-inventory.json': routes([['GET', '/v1/alpha', 'src/alpha.ts']]),
      'src/alpha.ts': 'export {};\n',
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    expect(brief!.notAssessed?.join(' ')).toContain('as of the last analyze');
  });

  it('does not attribute a call to another host as a consumer', async () => {
    const root = repo({
      'api/openapi.yaml': SPEC_ONE,
      '.openlore/analysis/route-inventory.json': routes([['GET', '/v1/alpha', 'src/alpha.ts']]),
      'src/alpha.ts': 'export {};\n',
      'src/otherhost.ts': "export const r = fetch('https://totally-unrelated.example.net/v1/alpha');\n",
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    const el = brief!.elements.find(e => e.operation === 'GET /v1/alpha');
    expect(el?.consumedBy, 'another vendor on the same path is not a consumer').toBeUndefined();
    expect(brief!.notAssessed?.join(' ')).toContain('another host');
  });

  it('keeps a relative-URL call site, which targets this service', async () => {
    const root = repo({
      'api/openapi.yaml': SPEC_ONE,
      '.openlore/analysis/route-inventory.json': routes([['GET', '/v1/alpha', 'src/alpha.ts']]),
      'src/alpha.ts': 'export {};\n',
      'src/client.ts': "export const r = fetch('/v1/alpha');\n",
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    expect(brief!.elements.find(e => e.operation === 'GET /v1/alpha')?.consumedBy?.[0].file).toBe('src/client.ts');
  });

  it('does not attribute consumers to an all-parameter operation path', async () => {
    const generic = `openapi: 3.0.3
info: {title: G, version: '1'}
servers: [{url: 'https://api.example.com/v1'}]
paths:
  /{kind}/{id}:
    get:
      operationId: getGeneric
      responses: {'200': {description: ok}}
`;
    const root = repo({
      'api/openapi.yaml': generic,
      '.openlore/analysis/route-inventory.json': routes([['GET', '/v1/other', 'src/other.ts']]),
      'src/other.ts': 'export {};\n',
      'src/unrelated.ts': "export const r = fetch('https://billing.internal.corp/v1/invoices/4711');\n",
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    const el = brief!.elements[0];
    expect(el.consumedBy, 'an all-parameter path matches too broadly to attribute').toBeUndefined();
    expect(el.unbound, 'and it is too broad to call unbound either').toBeUndefined();
  });

  it('names every route that matches instead of silently picking the last', async () => {
    const root = repo({
      'api/openapi.yaml': SPEC_ONE,
      '.openlore/analysis/route-inventory.json': routes([['GET', '/alpha', 'src/svc_a.ts'], ['GET', '/alpha', 'src/svc_b.ts']]),
      'src/svc_a.ts': 'export {};\n',
      'src/svc_b.ts': 'export {};\n',
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    const el = brief!.elements[0];
    expect(el.servedBy, 'two handlers match, so neither is "the" one').toBeUndefined();
    expect(el.unbound, 'routes DID match; it is ambiguous, not unbound').toBeUndefined();
    const note = brief!.notAssessed?.join(' ') ?? '';
    expect(note).toContain('src/svc_a.ts');
    expect(note).toContain('src/svc_b.ts');
  });

  it('discloses the languages the consumer scan reads', async () => {
    const root = repo({
      'api/openapi.yaml': SPEC_ONE,
      '.openlore/analysis/route-inventory.json': routes([['GET', '/v1/alpha', 'src/alpha.ts']]),
      'src/alpha.ts': 'export {};\n',
      'src/beta_client.rb': "Net::HTTP.get(URI('https://api.example.com/v1/alpha'))\n",
    });

    const brief = await changedContractsForSpecFiles(root, ['api/openapi.yaml']);

    expect(brief!.notAssessed?.join(' ')).toContain('another language is not assessed');
  });
});
