/**
 * Cross-service API topology (change: add-cross-service-api-topology).
 *
 * The single-repo half of the contract: an outbound HTTP client call site is
 * projected onto the call graph as a function→function edge to the server route
 * handler it targets, labeled `http_endpoint` (distinct from a direct call), so the
 * existing impact/pathfinding tools answer "who calls this endpoint?" with no
 * schema or tool change. This proves the projection end-to-end through the real
 * CallGraphBuilder.build() — the layer that was previously only covered at the
 * extractor level (http-route-parser.test.ts), not at the call-graph projection.
 *
 * Route + HTTP-call detection reads from disk by path (as the existing HTTP edge
 * pass does), so fixtures are written to a temp dir. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CallGraphBuilder } from './call-graph.js';
import type { CallEdge, FunctionNode } from './call-graph.js';

type Built = Awaited<ReturnType<CallGraphBuilder['build']>>;

const idByName = (b: Built, name: string): string | undefined =>
  [...b.nodes.values()].find((n: FunctionNode) => n.name === name)?.id;

const httpEdges = (b: Built): CallEdge[] => b.edges.filter(e => e.confidence === 'http_endpoint');

/** The cross-service edge from a client function to a handler function, if present. */
const crossServiceEdge = (b: Built, fromName: string, toName: string): CallEdge | undefined => {
  const from = idByName(b, fromName), to = idByName(b, toName);
  return b.edges.find(e => e.callerId === from && e.calleeId === to && e.confidence === 'http_endpoint');
};

/**
 * Backward reachability over the call graph: the caller node-ids that reach `toName`.
 * This is exactly what `analyze_impact` traverses, so asserting the client function is
 * among a handler's callers is asserting "analyze_impact on the handler surfaces it".
 */
const callersOf = (b: Built, toName: string): string[] => {
  const to = idByName(b, toName);
  return b.edges.filter(e => e.calleeId === to).map(e => e.callerId);
};

describe('cross-service API topology — single-repo projection', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-xservice-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /** Write a set of fixture files to disk and build the call graph over them. */
  async function buildFixture(files: Array<{ path: string; content: string; language: string }>): Promise<Built> {
    const onDisk = files.map(f => ({ ...f, path: join(root, f.path) }));
    for (const f of onDisk) {
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.content, 'utf-8');
    }
    return new CallGraphBuilder().build(onDisk);
  }

  it('A client call site links to its route handler (cross-language: TS client → Python FastAPI)', async () => {
    const b = await buildFixture([
      {
        path: 'web/users.ts',
        language: 'TypeScript',
        content: [
          'export async function loadUser(id: string) {',
          '  const res = await fetch(`/api/users/${id}`);',
          '  return res.json();',
          '}',
        ].join('\n'),
      },
      {
        path: 'api/users.py',
        language: 'Python',
        content: [
          '@router.get("/api/users/{user_id}")',
          'async def get_user(user_id: str):',
          '    return {"id": user_id}',
        ].join('\n'),
      },
    ]);

    const edge = crossServiceEdge(b, 'loadUser', 'get_user');
    expect(edge, 'expected an http_endpoint edge loadUser → get_user').toBeDefined();
    // Distinct from a direct call: labeled http_endpoint, never a plain resolved call.
    expect(edge!.confidence).toBe('http_endpoint');
    expect(edge!.kind).toBe('calls');
    // analyze_impact on the handler surfaces the client caller (backward reachability).
    expect(callersOf(b, 'get_user')).toContain(idByName(b, 'loadUser'));
  });

  it('A monorepo full-stack link needs no federation (TS client → TS Express handler)', async () => {
    const b = await buildFixture([
      {
        path: 'client/api.ts',
        language: 'TypeScript',
        content: [
          'export async function createOrder(payload: unknown) {',
          "  return fetch('/api/orders', { method: 'POST', body: JSON.stringify(payload) });",
          '}',
        ].join('\n'),
      },
      {
        path: 'server/routes.ts',
        language: 'TypeScript',
        content: [
          'import express from "express";',
          'const app = express();',
          'function placeOrder(req, res) { res.json({ ok: true }); }',
          "app.post('/api/orders', placeOrder);",
        ].join('\n'),
      },
    ]);

    expect(crossServiceEdge(b, 'createOrder', 'placeOrder')).toBeDefined();
    expect(callersOf(b, 'placeOrder')).toContain(idByName(b, 'createOrder'));
  });

  it('Handler in a different file than the route registration links (Django urls.py → views.py)', async () => {
    const b = await buildFixture([
      {
        path: 'web/things.ts',
        language: 'TypeScript',
        content: [
          'export async function loadThing() {',
          "  return fetch('/api/things/42');",
          '}',
        ].join('\n'),
      },
      {
        path: 'srv/urls.py',
        language: 'Python',
        content: [
          'urlpatterns = [',
          "    path('api/things/<int:pk>/', views.thing_detail, name='thing'),",
          ']',
        ].join('\n'),
      },
      {
        path: 'srv/views.py',
        language: 'Python',
        content: [
          'def thing_detail(request, pk):',
          '    return {}',
        ].join('\n'),
      },
    ]);

    // The route is declared in urls.py but the handler lives in views.py: Pass 2b
    // must resolve the handler by a UNIQUE cross-file name match, not same-file only.
    expect(crossServiceEdge(b, 'loadThing', 'thing_detail')).toBeDefined();
    expect(callersOf(b, 'thing_detail')).toContain(idByName(b, 'loadThing'));
  });

  it('A separate Express routes file (registration apart from handler definition) links', async () => {
    const b = await buildFixture([
      {
        path: 'web/cart.ts',
        language: 'TypeScript',
        content: [
          'export async function addToCart(item: unknown) {',
          "  return fetch('/api/cart', { method: 'POST', body: JSON.stringify(item) });",
          '}',
        ].join('\n'),
      },
      {
        path: 'server/handlers.ts',
        language: 'TypeScript',
        content: [
          'export function cartAdd(req, res) { res.status(201).json({}); }',
        ].join('\n'),
      },
      {
        path: 'server/routes.ts',
        language: 'TypeScript',
        content: [
          'import express from "express";',
          'import { cartAdd } from "./handlers";',
          'const app = express();',
          "app.post('/api/cart', cartAdd);",
        ].join('\n'),
      },
    ]);

    expect(crossServiceEdge(b, 'addToCart', 'cartAdd')).toBeDefined();
  });

  it('Ambiguous handler name across files stays unresolved (no guessed cross-file edge)', async () => {
    const b = await buildFixture([
      {
        path: 'web/load.ts',
        language: 'TypeScript',
        content: [
          'export async function loadDup() {',
          "  return fetch('/api/dup/1');",
          '}',
        ].join('\n'),
      },
      {
        path: 'srv/urls.py',
        language: 'Python',
        content: ["urlpatterns = [ path('api/dup/<int:pk>/', views.handler, name='d') ]"].join('\n'),
      },
      // Two functions named `handler` in different files → ambiguous → no edge.
      { path: 'srv/a.py', language: 'Python', content: 'def handler(request, pk):\n    return 1' },
      { path: 'srv/b.py', language: 'Python', content: 'def handler(request, pk):\n    return 2' },
    ]);

    expect(httpEdges(b)).toHaveLength(0);
  });

  it('Equivalent path-parameter forms reconcile (client `${id}` ↔ route `:id`/`{id}`)', async () => {
    const b = await buildFixture([
      {
        path: 'web/profile.ts',
        language: 'TypeScript',
        content: [
          'export async function fetchProfile(userId: string) {',
          '  return fetch(`/api/users/${userId}/profile`);',
          '}',
        ].join('\n'),
      },
      {
        path: 'server/profile.ts',
        language: 'TypeScript',
        content: [
          'import express from "express";',
          'const router = express.Router();',
          'function getProfile(req, res) { res.json({}); }',
          "router.get('/api/users/:id/profile', getProfile);",
        ].join('\n'),
      },
    ]);

    // `${userId}` normalizes to :param and `:id` normalizes to :param → they match.
    expect(crossServiceEdge(b, 'fetchProfile', 'getProfile')).toBeDefined();
  });

  it('Comments before a client call do not drift its line / drop its edge', async () => {
    const b = await buildFixture([
      {
        path: 'web/commented.ts',
        language: 'TypeScript',
        content: [
          'export async function first() {',
          "  return fetch('/api/first');   // a trailing comment",
          '}',
          '// a standalone comment line',
          'export async function second() {',
          "  return fetch('/api/second');", // its line must not drift onto the comment
          '}',
        ].join('\n'),
      },
      {
        path: 'server/routes.ts',
        language: 'TypeScript',
        content: [
          'import express from "express";',
          'const app = express();',
          'function handleFirst(req, res) { res.end(); }',
          'function handleSecond(req, res) { res.end(); }',
          "app.get('/api/first', handleFirst);",
          "app.get('/api/second', handleSecond);",
        ].join('\n'),
      },
    ]);

    expect(crossServiceEdge(b, 'first', 'handleFirst')).toBeDefined();
    expect(crossServiceEdge(b, 'second', 'handleSecond')).toBeDefined();
  });

  it('A handler that calls its own endpoint produces no self-loop edge', async () => {
    const b = await buildFixture([
      {
        path: 'server/self.ts',
        language: 'TypeScript',
        content: [
          'import express from "express";',
          'const app = express();',
          'function selfHandler(req, res) {',
          "  fetch('/api/self');", // the handler fetches its own route
          '  res.json({});',
          '}',
          "app.get('/api/self', selfHandler);",
        ].join('\n'),
      },
    ]);

    // caller (enclosing fn of the fetch) === callee (handler) → must be skipped.
    expect(crossServiceEdge(b, 'selfHandler', 'selfHandler')).toBeUndefined();
    expect(httpEdges(b)).toHaveLength(0);
  });

  it('A dynamic target emits no edge (non-literal URL is never guessed)', async () => {
    const b = await buildFixture([
      {
        path: 'web/dynamic.ts',
        language: 'TypeScript',
        content: [
          'export async function callDynamic(endpoint: string) {',
          '  return fetch(endpoint);', // bare variable — not a static literal
          '}',
        ].join('\n'),
      },
      {
        path: 'server/anything.ts',
        language: 'TypeScript',
        content: [
          'import express from "express";',
          'const app = express();',
          'function anyHandler(req, res) { res.end(); }',
          "app.get('/api/anything', anyHandler);",
        ].join('\n'),
      },
    ]);

    // No static path on the call site → no HttpCall extracted → no cross-service edge.
    expect(crossServiceEdge(b, 'callDynamic', 'anyHandler')).toBeUndefined();
    expect(httpEdges(b)).toHaveLength(0);
  });

  it('A method/path with no registered route in scope emits no edge', async () => {
    const b = await buildFixture([
      {
        path: 'web/orphan.ts',
        language: 'TypeScript',
        content: [
          'export async function loadWidgets() {',
          "  return fetch('/api/widgets');", // no server registers /api/widgets
          '}',
        ].join('\n'),
      },
      {
        path: 'server/users.ts',
        language: 'TypeScript',
        content: [
          'import express from "express";',
          'const app = express();',
          'function listUsers(req, res) { res.json([]); }',
          "app.get('/api/users', listUsers);",
        ].join('\n'),
      },
    ]);

    expect(crossServiceEdge(b, 'loadWidgets', 'listUsers')).toBeUndefined();
    // The unrelated /api/users pair is still wired, so the graph isn't simply empty.
    expect(httpEdges(b).length).toBe(0);
  });

  it('Cross-service edges are deterministic across re-analyses', async () => {
    const files = [
      {
        path: 'web/a.ts',
        language: 'TypeScript',
        content: [
          'export async function loadA(id: string) {',
          '  return fetch(`/api/a/${id}`);',
          '}',
        ].join('\n'),
      },
      {
        path: 'web/b.ts',
        language: 'TypeScript',
        content: [
          'export async function loadB(id: string) {',
          '  return fetch(`/api/b/${id}`);',
          '}',
        ].join('\n'),
      },
      {
        path: 'server/api.ts',
        language: 'TypeScript',
        content: [
          'import express from "express";',
          'const app = express();',
          'function handleA(req, res) { res.end(); }',
          'function handleB(req, res) { res.end(); }',
          "app.get('/api/a/:id', handleA);",
          "app.get('/api/b/:id', handleB);",
        ].join('\n'),
      },
    ];

    const sig = (b: Built): string =>
      httpEdges(b)
        .map(e => `${b.nodes.get(e.callerId)?.name}→${b.nodes.get(e.calleeId)?.name}`)
        .sort()
        .join('|');

    const first = sig(await buildFixture(files));
    const second = sig(await buildFixture(files));
    expect(first).toBe(second);
    expect(first).toContain('loadA→handleA');
    expect(first).toContain('loadB→handleB');
  });
});
