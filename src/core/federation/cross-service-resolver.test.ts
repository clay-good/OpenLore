/**
 * Cross-service federation resolver (change: add-cross-service-api-topology).
 *
 * findCrossRepoClientCallers links an outbound HTTP client call site in one indexed
 * repo to a route handler in another — the cross-repo blast radius of an API change
 * that federation's name-based resolver cannot see (the call references a URL, not
 * the handler's symbol). Indexes are synthetic on-disk fixtures; the consumer repo's
 * source is written for real because client calls are re-extracted from source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../services/edge-store.js';
import { OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_LLM_CONTEXT } from '../../constants.js';
import { addRepo } from './registry.js';
import { resolveFederationScope, findCrossRepoClientCallers } from './resolver.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import type { RouteDefinition } from '../analyzer/http-route-parser.js';

const created: string[] = [];

function node(id: string, name: string, filePath: string, startLine: number, endLine: number): FunctionNode {
  return { id, name, filePath, isAsync: true, language: 'TypeScript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, startLine, endLine };
}

function route(method: string, normalizedPath: string): RouteDefinition {
  return { file: 'home/api.ts', method, path: normalizedPath, normalizedPath, handlerName: 'getUser', framework: 'express', line: 1, contractSource: 'none' };
}

/** Materialize a consumer repo: an .openlore index AND real source files on disk. */
function makeConsumerRepo(
  prefix: string,
  nodes: FunctionNode[],
  sources: Record<string, string>,
): string {
  const dir = mkdtempSync(join(tmpdir(), `xsvc-${prefix}-`));
  created.push(dir);
  const adir = join(dir, OPENLORE_ANALYSIS_REL_PATH);
  mkdirSync(adir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(adir));
  store.clearAll();
  store.insertNodes(nodes.filter(n => !n.isExternal && !n.isTest));
  store.insertEdges([]);
  store.close();
  const callGraph = {
    nodes, edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
  writeFileSync(join(adir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }));
  writeFileSync(join(adir, 'fingerprint.json'), JSON.stringify({ hash: `fp-${prefix}`, computedAt: '2026-06-26T00:00:00.000Z', fileCount: nodes.length }));
  // Real source files (client calls are re-extracted from disk).
  for (const [rel, content] of Object.entries(sources)) {
    const fp = join(dir, rel);
    mkdirSync(join(fp, '..'), { recursive: true });
    writeFileSync(fp, content, 'utf-8');
  }
  return dir;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xsvc-home-'));
  created.push(home);
});
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('findCrossRepoClientCallers', () => {
  const consumerSource = [
    'export async function loadUser(id: string) {',
    '  return fetch(`/api/users/${id}`);',
    '}',
  ].join('\n');

  it('links a client call in repo B to a home handler route', async () => {
    const consumer = makeConsumerRepo('consumer',
      [node('src/users.ts::loadUser', 'loadUser', 'src/users.ts', 1, 3)],
      { 'src/users.ts': consumerSource });
    addRepo(home, consumer, { name: 'web' });
    const scope = resolveFederationScope(home, { federation: true });

    const res = await findCrossRepoClientCallers(scope, [route('GET', '/api/users/:param')]);
    expect(res.callers).toHaveLength(1);
    expect(res.callers[0]).toMatchObject({
      repo: 'web', caller: { name: 'loadUser', file: 'src/users.ts' }, method: 'GET', path: '/api/users/:param',
    });
    expect(res.coverage.reposConsulted.map(r => r.name)).toEqual(['web']);
    expect(res.coverage.caveats.join(' ')).toMatch(/route key/i);
  });

  it('a dynamic (non-literal) client target links nothing', async () => {
    const consumer = makeConsumerRepo('dyn',
      [node('src/dyn.ts::callDynamic', 'callDynamic', 'src/dyn.ts', 1, 3)],
      { 'src/dyn.ts': 'export async function callDynamic(endpoint: string) {\n  return fetch(endpoint);\n}' });
    addRepo(home, consumer, { name: 'web' });
    const scope = resolveFederationScope(home, { federation: true });

    const res = await findCrossRepoClientCallers(scope, [route('GET', '/api/users/:param')]);
    expect(res.callers).toHaveLength(0);
  });

  it('a client call to a different endpoint links nothing', async () => {
    const consumer = makeConsumerRepo('other',
      [node('src/other.ts::loadWidgets', 'loadWidgets', 'src/other.ts', 1, 3)],
      { 'src/other.ts': 'export async function loadWidgets() {\n  return fetch("/api/widgets");\n}' });
    addRepo(home, consumer, { name: 'web' });
    const scope = resolveFederationScope(home, { federation: true });

    const res = await findCrossRepoClientCallers(scope, [route('GET', '/api/users/:param')]);
    expect(res.callers).toHaveLength(0);
  });

  it('no home routes → no work, no callers', async () => {
    const consumer = makeConsumerRepo('noop',
      [node('src/users.ts::loadUser', 'loadUser', 'src/users.ts', 1, 3)],
      { 'src/users.ts': consumerSource });
    addRepo(home, consumer, { name: 'web' });
    const scope = resolveFederationScope(home, { federation: true });

    const res = await findCrossRepoClientCallers(scope, []);
    expect(res.callers).toHaveLength(0);
    expect(res.coverage.reposConsulted).toHaveLength(0);
  });

  it('is deterministic across runs', async () => {
    const consumer = makeConsumerRepo('det',
      [
        node('src/a.ts::loadA', 'loadA', 'src/a.ts', 1, 3),
        node('src/b.ts::loadB', 'loadB', 'src/b.ts', 1, 3),
      ],
      {
        'src/a.ts': 'export async function loadA(id: string) {\n  return fetch(`/api/users/${id}`);\n}',
        'src/b.ts': 'export async function loadB(id: string) {\n  return fetch(`/api/users/${id}`);\n}',
      });
    addRepo(home, consumer, { name: 'web' });
    const scope = resolveFederationScope(home, { federation: true });

    const sig = (cs: Awaited<ReturnType<typeof findCrossRepoClientCallers>>) =>
      cs.callers.map(c => `${c.repo}:${c.caller.id}`).join('|');
    const first = sig(await findCrossRepoClientCallers(scope, [route('GET', '/api/users/:param')]));
    const second = sig(await findCrossRepoClientCallers(scope, [route('GET', '/api/users/:param')]));
    expect(first).toBe(second);
    expect(first).toBe('web:src/a.ts::loadA|web:src/b.ts::loadB');
  });
});
