/**
 * Cross-service API topology — end-to-end through analyze_impact under federation
 * (change: add-cross-service-api-topology).
 *
 * The headline scenario: a client call site in repo A targets a route registered in
 * repo B; cross-repo impact on the repo-B handler surfaces the repo-A client as a
 * cross-service consumer. Real on-disk indexes + source for both repos; no mock —
 * this exercises deriveSeedRoutes + findCrossRepoClientCallers wired into the
 * analyze_impact federation block.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import { OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_LLM_CONTEXT, ARTIFACT_ROUTE_INVENTORY } from '../../../constants.js';
import { addRepo } from '../../federation/registry.js';
import { handleAnalyzeImpact } from './graph.js';
import type { FunctionNode, CallEdge } from '../../analyzer/call-graph.js';

const created: string[] = [];

function node(id: string, name: string, filePath: string, extra: Partial<FunctionNode> = {}): FunctionNode {
  return { id, name, filePath, isAsync: true, language: 'TypeScript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, ...extra };
}

interface RouteInvEntry { method: string; path: string; framework: string; file: string; handler: string; contractSource: string }

/** Materialize a repo: .openlore index (edge store + llm-context) + real source files
 *  + an optional persisted route inventory (the real artifact federation reads first). */
function makeRepo(prefix: string, nodes: FunctionNode[], edges: CallEdge[], sources: Record<string, string>, routes?: RouteInvEntry[]): string {
  const dir = mkdtempSync(join(tmpdir(), `xsvc-e2e-${prefix}-`));
  created.push(dir);
  const adir = join(dir, OPENLORE_ANALYSIS_REL_PATH);
  mkdirSync(adir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(adir));
  store.clearAll();
  store.insertNodes(nodes.filter(n => !n.isExternal && !n.isTest));
  store.insertEdges(edges);
  store.close();
  const callGraph = {
    nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
  writeFileSync(join(adir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }));
  writeFileSync(join(adir, 'fingerprint.json'), JSON.stringify({ hash: `fp-${prefix}`, computedAt: '2026-06-26T00:00:00.000Z', fileCount: nodes.length }));
  if (routes) {
    writeFileSync(join(adir, ARTIFACT_ROUTE_INVENTORY), JSON.stringify({ total: routes.length, byMethod: {}, byFramework: {}, routes }));
  }
  for (const [rel, content] of Object.entries(sources)) {
    const fp = join(dir, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content, 'utf-8');
  }
  return dir;
}

afterEach(() => { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('analyze_impact cross-service consumers across a federation', () => {
  let api: string; // repo B: registers GET /api/users/:id → getUser

  beforeEach(() => {
    const serverSrc = [
      'import express from "express";',
      'const app = express();',
      'function getUser(req, res) { res.json({}); }',
      "app.get('/api/users/:id', getUser);",
    ].join('\n');
    api = makeRepo('api', [node('src/api.ts::getUser', 'getUser', 'src/api.ts', { startLine: 3, endLine: 3 })], [], { 'src/api.ts': serverSrc });
  });

  it('surfaces a client consumer in another repo as a cross-service consumer', async () => {
    const webSrc = [
      'export async function loadUser(id: string) {',
      '  return fetch(`/api/users/${id}`);',
      '}',
    ].join('\n');
    const web = makeRepo('web', [node('src/users.ts::loadUser', 'loadUser', 'src/users.ts', { startLine: 1, endLine: 3 })], [], { 'src/users.ts': webSrc });
    addRepo(api, web, { name: 'web' });

    const result = await handleAnalyzeImpact(api, 'getUser', 2, false, false, undefined, true) as {
      federation?: { crossServiceConsumers?: Array<{ repo: string; caller: string; method: string; path: string }>; crossServiceConsumerCount?: number };
    };

    const xsvc = result.federation?.crossServiceConsumers ?? [];
    expect(xsvc).toHaveLength(1);
    expect(xsvc[0]).toMatchObject({ repo: 'web', caller: 'loadUser', method: 'GET', path: '/api/users/:param' });
    expect(result.federation?.crossServiceConsumerCount).toBe(1);
  });

  it('omits the cross-service block when no client targets the endpoint', async () => {
    const webSrc = 'export async function loadWidgets() {\n  return fetch("/api/widgets");\n}';
    const web = makeRepo('web2', [node('src/w.ts::loadWidgets', 'loadWidgets', 'src/w.ts', { startLine: 1, endLine: 3 })], [], { 'src/w.ts': webSrc });
    addRepo(api, web, { name: 'web' });

    const result = await handleAnalyzeImpact(api, 'getUser', 2, false, false, undefined, true) as {
      federation?: { crossServiceConsumers?: unknown };
    };
    expect(result.federation).toBeDefined();
    expect(result.federation?.crossServiceConsumers).toBeUndefined();
  });

  it('finds a cross-repo consumer when the handler is registered in a different file (Django)', async () => {
    // The handler `thing_detail` lives in views.py, but its route is registered in
    // urls.py — so the seed's own file has no route. The persisted route inventory
    // (which lists every route) is what lets federation derive the route key here.
    const dj = makeRepo(
      'dj',
      [node('src/views.py::thing_detail', 'thing_detail', 'src/views.py', { language: 'Python', startLine: 1, endLine: 2 })],
      [],
      { 'src/views.py': 'def thing_detail(request, pk):\n    return {}' },
      [{ method: 'UNKNOWN', path: '/api/things/<int:pk>/', framework: 'django', file: 'src/urls.py', handler: 'thing_detail', contractSource: 'none' }],
    );
    const webSrc = 'export async function loadThing(id) {\n  return fetch(`/api/things/${id}`);\n}';
    const web = makeRepo('djweb', [node('src/t.ts::loadThing', 'loadThing', 'src/t.ts', { startLine: 1, endLine: 3 })], [], { 'src/t.ts': webSrc });
    addRepo(dj, web, { name: 'web' });

    const result = await handleAnalyzeImpact(dj, 'thing_detail', 2, false, false, undefined, true) as {
      federation?: { crossServiceConsumers?: Array<{ repo: string; caller: string; path: string }> };
    };
    const xsvc = result.federation?.crossServiceConsumers ?? [];
    expect(xsvc).toHaveLength(1);
    expect(xsvc[0]).toMatchObject({ repo: 'web', caller: 'loadThing', path: '/api/things/:param' });
  });
});
