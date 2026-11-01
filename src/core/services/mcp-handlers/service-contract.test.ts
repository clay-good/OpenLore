import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { handleCertifyServiceContract } from './service-contract.js';
import { renderServiceContract } from '../../../cli/commands/certify-service-contract.js';

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
    get:
      responses: {'200': {description: ok}}
  /orders/{id}:
    get:
      parameters: [{name: id, in: path, required: true, schema: {type: string}}]
      responses: {'200': {description: ok, content: {application/json: {schema: {type: object, properties: {id: {type: string}, total: {type: number}}}}}}}
    delete:
      parameters: [{name: id, in: path, required: true, schema: {type: string}}]
      responses: {'204': {description: gone}}
`;
const CLIENT = "export const get = (id: string) => fetch(`/v1/orders/${id}`);\nexport const drop = (id: string) => fetch(`/v1/orders/${id}`, { method: 'DELETE' });\n";
const routes = (list: Array<[string, string]>) => JSON.stringify({ routes: list.map(([method, path]) => ({ method, path, framework: 'express', file: 'src/server.ts', handler: 'h' })) });

const CONFIG = { version: '1.0.0', projectType: 'nodejs', openspecPath: './openspec', analysis: { maxFiles: 500, includePatterns: [], excludePatterns: [] },
  generation: { model: 'claude-sonnet-5', domains: 'auto' }, createdAt: '2026-10-31T00:00:00.000Z', lastRun: null };

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'olcontract-')));
  dirs.push(root);
  write(root, '.gitignore', '.openlore/\n');
  for (const [rel, c] of Object.entries(files)) write(root, rel, c);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

describe('certify_service_contract', () => {
  it('lists the surface and two-way parity against the route inventory', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC, '.openlore/analysis/route-inventory.json': routes([['GET', '/orders'], ['GET', '/orders/:id'], ['GET', '/orders/export'], ['GET', '/health']]) });
    const r = await handleCertifyServiceContract({ directory: root });
    expect(r.specs).toEqual([{ file: 'api/openapi.yaml', format: 'openapi-3', basePath: '/v1', operations: 3 }]);
    expect((r.surface as Array<{ address: string }>).map(s => s.address)).toEqual(['DELETE /v1/orders/{id}', 'GET /v1/orders', 'GET /v1/orders/{id}']);
    expect(r.parity).toEqual({ assessed: true, matched: 2, declaredUnimplemented: 1, implementedUndeclared: 1 });
    const findings = r.findings as Array<{ code: string; subject: string; remediation?: string; enforcementClass: string }>;
    expect(findings.map(f => `${f.code} ${f.subject}`).sort()).toEqual([
      'contract-declared-unimplemented DELETE /v1/orders/{id}',
      'contract-implemented-undeclared src/server.ts::GET /orders/export',
    ]);
    expect(findings.every(f => f.enforcementClass === 'advisory' && f.remediation)).toBe(true);
    expect(r.changes).toBeUndefined();
  });

  it('parity is not assessed without a route inventory or with no server route', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC });
    expect((await handleCertifyServiceContract({ directory: root })).parity).toMatchObject({ assessed: false, reason: expect.stringContaining('openlore analyze') });
    write(root, '.openlore/analysis/route-inventory.json', routes([]));
    expect((await handleCertifyServiceContract({ directory: root })).parity).toMatchObject({ assessed: false, reason: expect.stringContaining('no server route handler') });
  });

  it('with a base ref: verdicts joined to the client call sites that call them', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC, 'src/client.ts': CLIENT });
    write(root, 'api/openapi.yaml', SPEC.replace(/ {4}delete:\n(.*\n){2}/, '').replace('id: {type: string}, total', 'total'));
    const r = await handleCertifyServiceContract({ directory: root, baseRef: 'main' });
    const changes = r.changes as { total: number; items: Array<{ rule: string; class: string; address: string; consumers: Array<{ file: string; line: number }> }>; suggestedBump: string };
    expect(changes.items.map(c => `${c.rule} ${c.address}`)).toEqual(['operation-removed DELETE /v1/orders/{id}', 'response-property-removed GET /v1/orders/{id}']);
    expect(changes.items[0].consumers).toEqual([{ file: 'src/client.ts', line: 2, method: 'DELETE', url: '/v1/orders/${id}' }]);
    expect(changes.items[1].consumers.map(c => c.line)).toEqual([1]);
    expect(changes.suggestedBump).toBe('major');
    const breaking = (r.findings as Array<{ code: string; severity: string; message: string }>).filter(f => f.code === 'contract-breaking');
    expect(breaking).toHaveLength(2);
    expect(breaking[0].severity).toBe('error');
    expect(breaking[0].message).toContain('src/client.ts:2');
    expect(r.boundaries).toEqual(expect.arrayContaining([expect.stringContaining('other repositories')]));
    expect(renderServiceContract(r)).toContain('operation-removed');
  });

  it('a specification broken in the working tree is not assessed, never "no changes"', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC });
    write(root, 'api/openapi.yaml', 'openapi: 3.0.3\npaths:\n  /orders: [unclosed\n');
    const r = await handleCertifyServiceContract({ directory: root, baseRef: 'main' });
    expect(r.notAssessed).toEqual([{ file: 'api/openapi.yaml', reason: expect.any(String) }]);
    expect((r.changes as { total: number }).total).toBe(0);
    expect(r.specs).toEqual([]);
  });

  it('an unresolvable base ref is an error unless the fallback is allowed', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC });
    git(root, 'commit', '--allow-empty', '-qm', 'second');
    expect((await handleCertifyServiceContract({ directory: root, baseRef: 'no-such-branch' })).error).toContain('does not resolve');
    const r = await handleCertifyServiceContract({ directory: root, baseRef: 'no-such-branch', allowBaseFallback: true });
    expect((r.changes as { baseRefFallback?: unknown }).baseRefFallback).toBeDefined();
  });

  it('enforcement.policy can turn a code off', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC, '.openlore/analysis/route-inventory.json': routes([['GET', '/orders']]) });
    write(root, '.openlore/config.json', JSON.stringify({ ...CONFIG, enforcement: { policy: { 'contract-declared-unimplemented': 'off' } } }));
    const r = await handleCertifyServiceContract({ directory: root });
    expect((r.findings as Array<{ code: string }>).some(f => f.code === 'contract-declared-unimplemented')).toBe(false);
  });

  it('an unreadable configuration is disclosed, not silently replaced by the default policy', async () => {
    const root = repo({ 'api/openapi.yaml': SPEC });
    write(root, '.openlore/config.json', '{"enforcement": ');
    const r = await handleCertifyServiceContract({ directory: root });
    expect(r.boundaries).toEqual(expect.arrayContaining([expect.stringContaining('enforcement.policy was not applied')]));
  });

  it('ignores YAML that is not a specification and specifications under node_modules', async () => {
    const root = repo({ 'docker-compose.yml': 'services: {}\n', 'node_modules/x/openapi.yaml': SPEC, 'package.json': '{"name":"x"}' });
    const r = await handleCertifyServiceContract({ directory: root });
    expect(r.specs).toEqual([]);
    expect(r.parity).toMatchObject({ assessed: false });
  });
});
