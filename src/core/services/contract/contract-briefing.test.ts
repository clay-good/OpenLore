import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { contractsForFiles } from './contract-briefing.js';
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
      { operation: 'GET /v1/orders/{id}', spec: 'api/openapi.yaml:13', route: { file: 'src/orders.ts', method: 'GET', path: '/orders/:id' }, deprecated: true, requiredParams: ['id (path, string)'], requiredBody: [] },
      { operation: 'POST /v1/orders', operationId: 'createOrder', spec: 'api/openapi.yaml:6', route: { file: 'src/orders.ts', method: 'POST', path: '/orders' }, requiredParams: [], requiredBody: ['qty (integer)', 'sku (string)'] },
    ]);
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
