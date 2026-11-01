import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const stores = vi.hoisted(() => ({
  decisions: [] as Array<Record<string, unknown>>,
  memories: [] as Array<Record<string, unknown>>,
  freshness: new Map<string, string>(),
}));
vi.mock('../../decisions/store.js', async (orig) => ({ ...(await orig() as object), loadDecisionStore: vi.fn(async () => ({ decisions: stores.decisions })) }));
vi.mock('../../decisions/memory-store.js', async (orig) => ({ ...(await orig() as object), loadMemoryStore: vi.fn(async () => ({ memories: stores.memories })) }));
vi.mock('../../decisions/anchor.js', async (orig) => ({
  ...(await orig() as object),
  // Freshness keyed by the first anchor's note so each record's state is set by the test.
  memoryFreshness: (anchors: Array<{ note?: string }>) => ({ freshness: stores.freshness.get(anchors[0]?.note ?? '') ?? 'fresh', verdicts: [], anchored: true }),
}));

import { handleVerifyClaim } from './claim-verification.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT, ARTIFACT_ROUTE_INVENTORY } from '../../../constants.js';

const dirs: string[] = [];
afterEach(() => { stores.decisions = []; stores.memories = []; stores.freshness.clear(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
const write = (root: string, rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };

const SPEC = `openapi: 3.0.3
info: {title: Orders, version: '1'}
servers: [{url: 'https://api.example.com/v1'}]
paths:
  /orders:
    post:
      responses: {'201': {description: ok}}
  /orders/{id}:
    get:
      responses: {'200': {description: ok}}
    delete:
      responses: {'204': {description: gone}}
`;
const nodes = [
  { id: 'src/legacy.ts::DeprecatedHandler', name: 'DeprecatedHandler', filePath: 'src/legacy.ts', startIndex: 0, endIndex: 40, startLine: 1, endLine: 2, language: 'TypeScript' },
  { id: 'src/legacy.ts::helper', name: 'helper', filePath: 'src/legacy.ts', startIndex: 41, endIndex: 80, startLine: 3, endLine: 4, language: 'TypeScript' },
];

function repo(files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'olclaim-')));
  dirs.push(root);
  write(root, '.gitignore', '.openlore/\n');
  write(root, 'api/openapi.yaml', SPEC);
  write(root, 'src/client.ts', "export const drop = (id: string) => fetch(`/v1/orders/${id}`, { method: 'DELETE' });\n");
  write(root, 'src/legacy.ts', 'export function DeprecatedHandler() {}\n\nexport function helper() {}\n');
  for (const [rel, c] of Object.entries(files)) write(root, rel, c);
  const analysis = join(OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  write(root, join(analysis, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges: [] } }));
  write(root, join(analysis, ARTIFACT_ROUTE_INVENTORY), JSON.stringify({ routes: [{ method: 'GET', path: '/orders/:id', framework: 'express', file: 'src/server.ts', handler: 'h' }] }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root, env: GIT_ENV });
  return root;
}
type R = { verdict: string; reason: string; receipt?: Record<string, unknown>; error?: string };
const claim = async (root: string, kind: string, subject: string) => (await handleVerifyClaim({ directory: root, kind: kind as never, subject })) as R;

describe('endpoint-implemented', () => {
  it('confirmed when a handler serves it (base path and parameter names aside)', async () => {
    const r = await claim(repo(), 'endpoint-implemented', 'GET /v1/orders/{orderId}');
    expect(r.verdict).toBe('confirmed');
    expect(r.receipt).toMatchObject({ operation: { address: 'GET /v1/orders/{id}', file: 'api/openapi.yaml', line: 9 }, handlers: [{ method: 'GET', path: '/orders/:id', file: 'src/server.ts' }] });
  });

  it('refuted when declared and unserved, naming the spec file and line', async () => {
    const r = await claim(repo(), 'endpoint-implemented', 'DELETE /v1/orders/{id}');
    expect(r.verdict).toBe('refuted');
    expect(r.reason).toContain('api/openapi.yaml:11');
  });

  it('unverifiable when no specification declares it, or no handler is indexed', async () => {
    const root = repo();
    expect((await claim(root, 'endpoint-implemented', 'PUT /v1/other')).verdict).toBe('unverifiable');
    write(root, join(OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY), JSON.stringify({ routes: [] }));
    expect((await claim(root, 'endpoint-implemented', 'GET /v1/orders/{id}')).reason).toContain('No server route handler');
  });

  it('a malformed address is an input error', async () => {
    expect((await claim(repo(), 'endpoint-implemented', 'orders')).error).toContain('METHOD /path');
  });
});

describe('endpoint-consumed', () => {
  it('confirmed with the call sites', async () => {
    const r = await claim(repo(), 'endpoint-consumed', 'DELETE /v1/orders/{id}');
    expect(r.verdict).toBe('confirmed');
    expect(r.receipt?.consumers).toEqual([expect.objectContaining({ file: 'src/client.ts', line: 1 })]);
  });

  it('refuted is scoped to this repository and names the external boundary', async () => {
    const r = await claim(repo(), 'endpoint-consumed', 'POST /v1/orders');
    expect(r.verdict).toBe('refuted');
    expect(r.reason).toMatch(/not "no caller"/);
    expect(r.reason).toContain('other repositories');
    expect(r.receipt).toMatchObject({ scope: 'this repository', consumers: [] });
  });

  it('unverifiable when the specification cannot be read', async () => {
    const root = repo({ 'api/openapi.yaml': 'openapi: 3.0.3\npaths:\n  /orders: [unclosed\n' });
    const r = await claim(root, 'endpoint-consumed', 'POST /v1/orders');
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toContain('could not be read');
  });
});

describe('decision-governed', () => {
  const anchor = (note: string, name = 'DeprecatedHandler') => ({ nodeId: `src/legacy.ts::${name}`, filePath: 'src/legacy.ts', symbolName: name, note });

  it('confirmed names the decision id and its freshness', async () => {
    stores.decisions = [{ id: 'a1b2c3d4', status: 'approved', title: 'Keep the legacy handler until v3', anchors: [anchor('d')] }];
    stores.freshness.set('d', 'drifted');
    const r = await claim(repo(), 'decision-governed', 'DeprecatedHandler');
    expect(r.verdict).toBe('confirmed');
    expect(r.receipt?.governing).toEqual([expect.objectContaining({ kind: 'decision', id: 'a1b2c3d4', freshness: 'drifted', status: 'approved' })]);
  });

  it('an orphaned memory, a superseded or draft decision, and another symbol do not govern', async () => {
    stores.decisions = [
      { id: 'aaaaaaaa', status: 'draft', title: 'draft', anchors: [anchor('x')] },
      { id: 'bbbbbbbb', status: 'approved', title: 'old', anchors: [anchor('x')] },
      { id: 'cccccccc', status: 'approved', title: 'new', anchors: [anchor('x', 'helper')], supersedes: 'bbbbbbbb' },
    ];
    stores.memories = [{ id: 'm1', content: 'note', anchors: [anchor('orphan')] }];
    stores.freshness.set('orphan', 'orphaned');
    const r = await claim(repo(), 'decision-governed', 'DeprecatedHandler');
    expect(r.verdict).toBe('refuted');
    const notGoverning = r.receipt?.notGoverning as Array<{ id: string; why: string }>;
    expect(notGoverning).toEqual(expect.arrayContaining([
      { kind: 'decision', id: 'aaaaaaaa', why: 'status draft' },
      { kind: 'decision', id: 'bbbbbbbb', why: 'superseded' },
      { kind: 'memory', id: 'm1', why: 'anchor orphaned' },
    ]));
  });

  it('a fresh memory governs; an unknown or ambiguous symbol is unverifiable', async () => {
    stores.memories = [{ id: 'm2', content: 'Do not remove: the billing cron calls it', anchors: [anchor('m2')] }];
    const root = repo();
    expect((await claim(root, 'decision-governed', 'DeprecatedHandler')).verdict).toBe('confirmed');
    expect((await claim(root, 'decision-governed', 'NoSuchSymbol')).verdict).toBe('unverifiable');
  });
});

describe('existing kinds are unchanged', () => {
  it('an unknown kind lists every kind', async () => {
    const r = (await handleVerifyClaim({ directory: repo(), kind: 'nope' as never, subject: 'x' })) as { error: string };
    expect(r.error).toContain('decision-current, decision-governed, endpoint-implemented, endpoint-consumed');
  });
});
