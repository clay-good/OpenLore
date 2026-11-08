/**
 * find_dead_code and gRPC registrations (change: add-contract-graph-projection).
 *
 * A method bound to an RPC is a liveness root. A registration that could NOT be bound leaves its
 * implementation unrooted, so the result must say so; and a disclosure that leaves every binding
 * intact (an unresolved `google.protobuf.Timestamp`) must not raise the "bindings were NOT made"
 * alarm. Drives the real handler over an llm-context fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT, ARTIFACT_DEPENDENCY_GRAPH } from '../../../constants.js';
import { handleFindDeadCode } from './reachability.js';
import type { FunctionNode, CallEdge } from '../../analyzer/call-graph.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-grpc-dead-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const node = (id: string, name: string, extra: Partial<FunctionNode> = {}): FunctionNode => ({
  id, name, filePath: id.split('::')[0], isAsync: false, language: 'Go', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, ...extra,
});
const none = { items: [], total: 0 };
const disclosure = (over: Record<string, unknown>) => ({
  unmatchedOperations: none, unmatchedRoutes: none, unresolvedBindings: none, unreadSpecifications: none,
  unboundClientCalls: none, ambiguousAddresses: none, unresolvedGeneratedBindings: none,
  unresolvedRegistrations: none, unboundRpcs: none, skippedCandidates: none, ...over,
});

async function write(nodes: FunctionNode[], edges: CallEdge[], contracts: Record<string, unknown>): Promise<void> {
  const callGraph = { nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 }, contracts };
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }), 'utf-8');
}

/**
 * A dependency graph whose named imports do NOT include the handler — the ONLY shape in which the
 * confidence ladder reaches `high` (an absent dependency-graph artifact makes `exportSignal` `none`
 * and caps every candidate at `medium`, so a fixture without one asserts nothing about `high`).
 */
async function writeDepGraph(importedNames: string[] = ['SomethingElse']): Promise<void> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ARTIFACT_DEPENDENCY_GRAPH), JSON.stringify({
    nodes: [{ id: 'a', file: { path: 'other/a.go' } }, { id: 'b', file: { path: 'other/b.go' } }],
    edges: [{ source: 'a', target: 'b', importedNames }],
  }), 'utf-8');
}

type Candidate = { name: string; className: string | null; confidence: string; reason: string };
const run = async () => (await handleFindDeadCode({ directory: root })) as { candidateDead: Candidate[] };

const RPC = node('orders.proto::/orders.v1.OrderService/GetOrder', '/orders.v1.OrderService/GetOrder', { language: 'Protobuf' });

describe('find_dead_code with gRPC registrations', () => {
  it('a bound implementation is not dead, and an after-the-fact note raises no alarm', async () => {
    const impl = node('srv/main.go::orderServer.GetOrder', 'GetOrder', { className: 'orderServer' });
    await write([impl, RPC], [{ callerId: impl.id, calleeId: RPC.id, calleeName: RPC.name, confidence: 'import', kind: 'implements_endpoint', synthesizedBy: 'grpc-registration' }],
      disclosure({ notes: ['1 protobuf type reference(s) resolve to no type projected from the files read'] }));
    const r = await handleFindDeadCode({ directory: root }) as { candidateDead: Array<{ name: string }>; contractRootsNotAssessed?: unknown };
    expect(r.candidateDead.map(c => c.name)).not.toContain('GetOrder');
    expect(r.contractRootsNotAssessed).toBeUndefined();
  });

  it('an unbound registration is named beside the candidate it leaves unrooted', async () => {
    const impl = node('srv/main.go::orderServer.GetOrder', 'GetOrder', { className: 'orderServer' });
    await write([impl, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{ file: 'srv/main.go', line: 12, service: 'orders.v1.OrderService', reason: 'not-literal', detail: 'the implementation is `srv`' }], total: 1 },
    }));
    const r = await handleFindDeadCode({ directory: root }) as { contractRootsNotAssessed?: { unresolvedRegistrations: number; unresolvedRegistrationItems: Array<{ reason: string }> } };
    expect(r.contractRootsNotAssessed?.unresolvedRegistrations).toBe(1);
    expect(r.contractRootsNotAssessed?.unresolvedRegistrationItems.map(i => i.reason)).toEqual(['not-literal']);
  });

  it('unbound GraphQL operations alone are named (a code-first resolver is not silently dead)', async () => {
    const impl = node('server.go::queryResolver.User', 'User', { className: 'queryResolver' });
    await write([impl], [], disclosure({ unboundGraphqlOperations: { items: ['Query.user (schema.graphql:1)'], total: 1 } }));
    const r = await handleFindDeadCode({ directory: root }) as { contractRootsNotAssessed?: { unboundGraphqlOperations: number } };
    expect(r.contractRootsNotAssessed?.unboundGraphqlOperations).toBe(1);
  });
});

/**
 * The cap: a symbol a contract registration or resolver map NAMED, whose binding the projection
 * refused, is wired up in the source and roots nothing — so it must never be claimed confidently
 * dead (change: cap-unbound-contract-handler-confidence).
 */
describe('find_dead_code never rates an unbound contract handler high-confidence dead', () => {
  const impl = node('srv/main.go::orderServer.GetOrder', 'GetOrder', { className: 'orderServer' });

  it('reaches high confidence when no contract registration names the handler (the baseline)', async () => {
    await write([impl, RPC], [], disclosure({}));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.name).toBe('GetOrder');
    expect(c.confidence).toBe('high');
  });

  it('caps a method whose class a refused gRPC registration named', async () => {
    await write([impl, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{
        file: 'srv/main.go', line: 12, service: 'orders.v1.OrderService', className: 'orderServer',
        reason: 'implementation-not-found', detail: 'no method of `orderServer` named after an RPC was found where the registration says it is',
      }], total: 1 },
    }));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.confidence).toBe('low');
    expect(c.reason).toContain('its class name matches the implementation a contract registration named');
  });

  it('caps a function a refused gRPC registration named by symbol', async () => {
    const fn = node('srv/handlers.ts::getOrder', 'getOrder', { language: 'TypeScript' });
    await write([fn, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{
        file: 'srv/server.ts', line: 8, service: 'orders.v1.OrderService', rpc: 'GetOrder', symbol: 'getOrder',
        reason: 'implementation-not-found', detail: "`getOrder` is imported from '@app/handlers', which is not indexed here (a package or a path alias)",
      }], total: 1 },
    }));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.confidence).toBe('low');
    expect(c.reason).toContain('a contract registration or resolver map writes this name and the binding was refused');
  });

  it('caps a function a refused GraphQL resolver map named', async () => {
    const fn = node('srv/resolvers.ts::order', 'order', { language: 'TypeScript' });
    await write([fn], [], disclosure({
      unresolvedResolvers: { items: [{
        file: 'srv/schema.ts', line: 4, root: 'Query', field: 'order', symbol: 'order',
        reason: 'implementation-not-found', detail: "`order` is imported from '@app/resolvers', which is not indexed here (a package or a path alias)",
      }], total: 1 },
    }));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.confidence).toBe('low');
    expect(c.reason).toContain('a contract registration or resolver map writes this name and the binding was refused');
  });

  // The shape grpc/grpc-node really has: `server.addService(Echo.service, serviceImplementation)`
  // hands over a variable, so the registration names no function and the refusal names no symbol.
  it('caps every candidate in the file of a registration whose implementation could not be read', async () => {
    const handler = node('examples/cancellation/server.js::bidirectionalStreamingEcho', 'bidirectionalStreamingEcho', { language: 'JavaScript' });
    await write([handler, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{
        file: 'examples/cancellation/server.js', line: 61, service: 'grpc.examples.echo.Echo',
        reason: 'not-literal', detail: 'the implementation is `serviceImplementation`',
      }], total: 1 },
    }));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.name).toBe('bidirectionalStreamingEcho');
    expect(c.confidence).toBe('low');
    expect(c.reason).toContain('whose implementation argument could not be read');
  });

  it('leaves another file untouched by a file-scoped cap, and spares an inline implementation', async () => {
    const elsewhere = node('examples/other/util.js::unusedHelper', 'unusedHelper', { language: 'JavaScript' });
    await write([elsewhere, RPC], [], disclosure({
      unresolvedRegistrations: { items: [
        { file: 'examples/cancellation/server.js', line: 61, service: 'grpc.examples.echo.Echo', reason: 'not-literal', detail: 'the implementation is `serviceImplementation`' },
        // An inline handler has no graph node, so its file is NOT capped.
        { file: 'examples/other/util.js', line: 4, service: 'grpc.examples.echo.Echo', rpc: 'UnaryEcho', reason: 'inline-implementation' },
      ], total: 2 },
    }));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.name).toBe('unusedHelper');
    expect(c.confidence).toBe('high');
  });

  it('does not cap a candidate no registration names', async () => {
    const other = node('srv/util.go::unusedHelper', 'unusedHelper');
    await write([other, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{ file: 'srv/main.go', line: 12, service: 'orders.v1.OrderService', className: 'orderServer', reason: 'implementation-not-found' }], total: 1 },
    }));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.name).toBe('unusedHelper');
    expect(c.confidence).toBe('high');
    expect(c.reason).not.toContain('contract registration');
  });

  // A LEGACY artifact (written before the complete name lists were carried) has only the bounded
  // items, so a repository with more refusals than those name holds unbound symbols it cannot
  // recover. The whole repository then gives up `high` rather than guess.
  it('withholds high across the repository when a legacy artifact cannot name every refusal', async () => {
    const other = node('srv/util.go::unusedHelper', 'unusedHelper');
    await write([other, RPC], [], disclosure({
      unresolvedRegistrations: {
        items: Array.from({ length: 20 }, (_, i) => ({ file: 'srv/main.go', line: i + 1, service: `svc.S${i}`, className: `serverImpl${i}`, reason: 'implementation-not-found' })),
        total: 25,
      },
    }));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.name).toBe('unusedHelper');
    expect(c.confidence).toBe('medium');
    expect(c.reason).toContain('5 refused contract binding(s) are not named by this index');
  });

  it('leaves a truncation-ceiling reason off a candidate already capped lower', async () => {
    await write([impl, RPC], [], disclosure({
      unresolvedRegistrations: {
        items: Array.from({ length: 20 }, (_, i) => ({ file: 'srv/main.go', line: i + 1, service: 'orders.v1.OrderService', className: i === 0 ? 'orderServer' : `other${i}`, reason: 'implementation-not-found' })),
        total: 40,
      },
    }));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.confidence).toBe('low');
    expect(c.reason).not.toContain('not named by this index');
  });
});

/**
 * The complete name lists (`cg.contracts.unboundHandlerNames`) are what a current artifact carries,
 * computed over every refusal rather than the 20-item reader slice. Without them the reader's cap
 * would decide a correctness question: grpc-go discloses 43 refusals, so an items-only rule gives
 * up that repository's entire high-confidence tier.
 */
describe('find_dead_code reads the complete refusal names, not the reader slice', () => {
  const unrelated = node('srv/util.go::unusedHelper', 'unusedHelper');

  it('keeps high when a current artifact names every refusal, however many there are', async () => {
    await write([unrelated, RPC], [], disclosure({
      unresolvedRegistrations: {
        items: Array.from({ length: 20 }, (_, i) => ({ file: `srv/s${i}.go`, line: 1, service: `svc.S${i}`, className: `impl${i}`, reason: 'implementation-not-found' })),
        total: 43,
      },
      unboundHandlerNames: {
        symbols: [], files: [],
        classes: Array.from({ length: 43 }, (_, i) => ({ name: `impl${i}` })),
        truncated: 0,
      },
    }));
    await writeDepGraph();
    const r = await run() as { candidateDead: Candidate[]; contractRootsNotAssessed?: Record<string, unknown> };
    expect(r.candidateDead[0]).toMatchObject({ name: 'unusedHelper', confidence: 'high' });
    expect(r.contractRootsNotAssessed?.refusalsNotNamed).toBeUndefined();
  });

  it('caps the named class from the complete list even when the reader slice omits it', async () => {
    const impl = node('srv/main.go::orderServer.GetOrder', 'GetOrder', { className: 'orderServer' });
    await write([impl, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{ file: 'srv/other.go', line: 1, service: 'svc.Other', className: 'otherServer', reason: 'implementation-not-found' }], total: 40 },
      unboundHandlerNames: { symbols: [], files: [], classes: [{ name: 'otherServer' }, { name: 'orderServer' }], truncated: 0 },
    }));
    await writeDepGraph();
    const [c] = (await run()).candidateDead;
    expect(c.confidence).toBe('low');
    expect(c.reason).toContain('its class name matches the implementation a contract registration named');
  });

  it('narrows a class cap to the one directory the projection proves, and states which', async () => {
    // Go, unqualified `&server{}`: `inScope` proves it can only mean the registration's own
    // package, so a same-named struct in another package is NOT capped.
    const here = node('greeter/main.go::server.SayHello', 'SayHello', { className: 'server' });
    const elsewhere = node('metrics/collector.go::server.deadScrape', 'deadScrape', { className: 'server' });
    await write([here, elsewhere, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{ file: 'greeter/main.go', line: 9, service: 'helloworld.Greeter', className: 'server', classDir: 'greeter/', reason: 'implementation-not-found' }], total: 1 },
      unboundHandlerNames: { symbols: [], files: [], classes: [{ name: 'server', dir: 'greeter/' }], truncated: 0 },
    }));
    await writeDepGraph();
    const by = Object.fromEntries((await run()).candidateDead.map(c => [c.name, c]));
    expect(by.SayHello.confidence).toBe('low');
    expect(by.SayHello.reason).toContain('in this directory');
    expect(by.deadScrape.confidence).toBe('high');
  });

  it('withholds high and says so at report level when the name cap itself was reached', async () => {
    await write([unrelated, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{ file: 'srv/s.go', line: 1, service: 'svc.S', className: 'impl', reason: 'implementation-not-found' }], total: 1 },
      unboundHandlerNames: { symbols: [], files: [], classes: [{ name: 'impl' }], truncated: 7 },
    }));
    await writeDepGraph();
    const r = await run() as unknown as { candidateDead: Candidate[]; contractRootsNotAssessed?: Record<string, unknown>; soundness: { caveats: string[] } };
    expect(r.candidateDead[0].confidence).toBe('medium');
    // Stated once at report level, not only on a candidate that happened to reach the high branch.
    expect(r.contractRootsNotAssessed?.refusalsNotNamed).toBe(7);
    expect(r.soundness.caveats.join(' ')).toContain('not named by this index');
  });

  it('states the cap is a lower bound wherever it fired', async () => {
    const impl = node('srv/main.go::orderServer.GetOrder', 'GetOrder', { className: 'orderServer' });
    await write([impl, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{ file: 'srv/main.go', line: 1, service: 'svc.S', className: 'orderServer', reason: 'implementation-not-found' }], total: 1 },
      unboundHandlerNames: { symbols: [], files: [], classes: [{ name: 'orderServer' }], truncated: 0 },
    }));
    await writeDepGraph();
    const r = await run() as unknown as { soundness: { caveats: string[] } };
    expect(r.soundness.caveats.join(' ')).toContain('this cap is a LOWER BOUND');
  });

  // The name scan reads `items` whatever the `total` gate says, so it must survive shapes the
  // report block never dereferences (it only reads items behind a truthy `total`). Without the
  // guards these two inputs threw where the prior build answered.
  it('degrades rather than throwing on a corrupt refusal list', async () => {
    await write([unrelated, RPC], [], disclosure({
      unresolvedRegistrations: { items: 5 as unknown as [], total: 0 },
      unresolvedResolvers: { items: [null as unknown as Record<string, never>], total: 0 },
    }));
    await writeDepGraph();
    const r = await run();
    expect(r.candidateDead[0]).toMatchObject({ name: 'unusedHelper' });
  });
});
