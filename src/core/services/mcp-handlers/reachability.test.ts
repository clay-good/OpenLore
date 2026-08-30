/**
 * Spec-20 — Reachability & Dead-Code Analysis.
 * Mark-and-sweep over a fixture with known live/dead regions across two languages,
 * plus the "what dies if I delete X" diff and honest-confidence behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => { throw new Error('ENOENT'); }) }));

import { handleFindDeadCode } from './reachability.js';
import { readCachedContext } from './utils.js';
import { readFile } from 'node:fs/promises';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id, filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 0, ...over,
  };
}
function edge(callerId: string, calleeId: string): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence: 'import', kind: 'calls' };
}
function graph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return { nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 } };
}

// Live chain: main → handler → helper.  Dead: orphan (no caller). Dead cluster:
// deadA ↔ deadB call each other but nothing reaches them. Python live + dead.
const NODES = [
  node({ id: 'src/main.ts::main', fanOut: 1 }),
  node({ id: 'src/app.ts::handler', fanIn: 1, fanOut: 1 }),
  node({ id: 'src/app.ts::helper', fanIn: 1 }),
  node({ id: 'src/dead.ts::orphan' }),                       // dead: no caller
  node({ id: 'src/dead.ts::deadA', fanIn: 1, fanOut: 1 }),   // dead cluster
  node({ id: 'src/dead.ts::deadB', fanIn: 1, fanOut: 1 }),
  node({ id: 'src/py.py::live_py', language: 'Python', fanIn: 0 }), // root via import (mocked)
  node({ id: 'src/py.py::dead_py', language: 'Python' }),    // dead, but dynamic → low conf
  node({ id: 'src/main.test.ts::testMain', filePath: 'src/main.test.ts', isTest: true, fanOut: 1 }),
];
const EDGES = [
  edge('src/main.ts::main', 'src/app.ts::handler'),
  edge('src/app.ts::handler', 'src/app.ts::helper'),
  edge('src/dead.ts::deadA', 'src/dead.ts::deadB'),
  edge('src/dead.ts::deadB', 'src/dead.ts::deadA'),
  edge('src/main.test.ts::testMain', 'src/main.ts::main'),
];

describe('handleFindDeadCode', () => {
  beforeEach(() => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph(NODES, EDGES) } as never);
    // Dep graph: 'main' and 'live_py' are imported elsewhere → roots.
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({
      edges: [{ importedNames: ['main', 'live_py'] }],
    }) as never);
  });

  it('flags the orphan and dead cluster, keeps the live chain reachable', async () => {
    const r = await handleFindDeadCode({ directory: '/p' }) as {
      candidateDead: Array<{ name: string; confidence: string; reason: string }>;
      stats: { reachable: number; candidateDead: number };
      coverage: { exportSignal: string };
    };
    const dead = r.candidateDead.map(d => d.name).sort();
    expect(dead).toEqual(['deadA', 'deadB', 'dead_py', 'orphan']);
    // Live chain not flagged.
    expect(dead).not.toContain('handler');
    expect(dead).not.toContain('helper');
    expect(dead).not.toContain('main');
    expect(r.coverage.exportSignal).toBe('dependency-graph');
  });

  it('never flags an IaC node (GitHub Actions workflow/job) as dead code', async () => {
    // A CI workflow handle and its jobs have no internal callers, but they are
    // infrastructure, not code — they must never be reported as candidate-dead (an
    // agent relies on this: "your CI workflow is dead code" would be a false alarm).
    const ghaNodes = [
      node({ id: 'src/main.ts::main', fanOut: 0 }),                                // a real (imported) root
      node({ id: 'src/orphan.ts::deadFn' }),                                       // a genuinely dead TS fn
      node({ id: '.github/workflows/ci.yml::workflow', language: 'GitHub Actions', className: 'workflow', startLine: 1, endLine: 1 }),
      node({ id: '.github/workflows/ci.yml::job.build', language: 'GitHub Actions', className: 'workflow-job', startLine: 5, endLine: 9 }),
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(ghaNodes, []) } as never);
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ edges: [{ importedNames: ['main'] }] }) as never);
    const r = await handleFindDeadCode({ directory: '/p' }) as { candidateDead: Array<{ name: string }> };
    const dead = r.candidateDead.map(d => d.name);
    expect(dead).toContain('deadFn');                       // the dead code fn IS a candidate
    expect(dead).not.toContain('workflow');                 // GHA nodes are excluded from the universe
    expect(dead).not.toContain('job.build');
    expect(dead.some(n => n.includes('.github'))).toBe(false);
  });

  it('tags confidence: static orphan high, dead cluster medium, dynamic low', async () => {
    const r = await handleFindDeadCode({ directory: '/p' }) as { candidateDead: Array<{ name: string; confidence: string }> };
    const byName = Object.fromEntries(r.candidateDead.map(d => [d.name, d.confidence]));
    expect(byName.orphan).toBe('high');     // no caller, static lang, not imported
    expect(byName.deadA).toBe('medium');    // reachable only from other dead code
    expect(byName.dead_py).toBe('low');     // dynamic language
  });

  it('reason explains why each looks dead', async () => {
    const r = await handleFindDeadCode({ directory: '/p' }) as { candidateDead: Array<{ name: string; reason: string }> };
    const orphan = r.candidateDead.find(d => d.name === 'orphan')!;
    expect(orphan.reason).toMatch(/no internal caller/);
    expect(orphan.reason).toMatch(/not imported by name from any other file/);
  });

  it('caps a candidate to low when its module is imported elsewhere (namespace/default/re-export safety)', async () => {
    // dep graph: dead.ts is imported by another module (edge target), though no name resolved.
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      nodes: [{ id: 'n1', file: { path: 'src/dead.ts' } }, { id: 'n2', file: { path: 'src/consumer.ts' } }],
      edges: [{ target: 'n1', importedNames: [] }, { importedNames: ['main', 'live_py'] }],
    }) as never);
    const r = await handleFindDeadCode({ directory: '/p' }) as { candidateDead: Array<{ name: string; confidence: string; reason: string }> };
    const orphan = r.candidateDead.find(d => d.name === 'orphan')!;
    expect(orphan.confidence).toBe('low'); // module is consumed, so not high even with no named import
    expect(orphan.reason).toMatch(/module IS imported elsewhere/);
  });

  it('caps script-container candidates because framework entrypoints are unanalyzed', async () => {
    const vueNode = node({ id: 'src/App.vue::save', filePath: 'src/App.vue', language: 'TypeScript' });
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph([vueNode], []) } as never);
    vi.mocked(readFile).mockImplementation(async path => {
      if (String(path).endsWith('parse-health.json')) {
        return JSON.stringify({
          version: 1, totalDegradedFiles: 0, totalErrorRegions: 0, byLanguage: [], topFiles: [], files: [],
          scriptContainers: [{
            format: 'Vue', extension: '.vue', fileCount: 1, scriptBlockCount: 1,
            extractedScriptBlockCount: 1, limitations: ['template expressions'],
            files: [{ filePath: 'src/App.vue', format: 'Vue', scriptBlockCount: 1, extractedScriptBlockCount: 1 }],
          }],
        });
      }
      return JSON.stringify({ edges: [] });
    });

    const result = await handleFindDeadCode({ directory: '/p' }) as {
      candidateDead: Array<{ name: string; confidence: string; reason: string }>;
    };
    expect(result.candidateDead[0]).toMatchObject({ name: 'save', confidence: 'low' });
    expect(result.candidateDead[0].reason).toMatch(/framework macros are unanalyzed/);
  });

  it('soundness banner refuses deletion authority and warns on dynamic dispatch', async () => {
    const r = await handleFindDeadCode({ directory: '/p' }) as { soundness: { posture: string; caveats: string[] } };
    expect(r.soundness.posture).toBe('candidates-not-authority');
    expect(r.soundness.caveats.join(' ')).toMatch(/never auto-delete/i);
    expect(r.soundness.caveats.join(' ')).toMatch(/dynamic dispatch/i);
  });

  it('"what dies if I delete handler" returns helper (reachable only via handler)', async () => {
    const r = await handleFindDeadCode({ directory: '/p', ifDeleted: 'handler' }) as {
      target: string; becomesDeadIfDeleted: Array<{ name: string }>; count: number;
      confidenceBoundary?: { complete: boolean };
    };
    expect(r.target).toBe('handler');
    expect(r.becomesDeadIfDeleted.map(n => n.name)).toEqual(['helper']);
    // The boundary is attached to the delete-impact (target-mode) return too.
    expect(typeof r.confidenceBoundary?.complete).toBe('boolean');
  });

  it('"what dies if I delete a leaf" returns nothing', async () => {
    const r = await handleFindDeadCode({ directory: '/p', ifDeleted: 'helper' }) as { count: number; note: string };
    expect(r.count).toBe(0);
    expect(r.note).toMatch(/Nothing else becomes unreachable/);
  });

  it('errors when ifDeleted symbol is unknown', async () => {
    const r = await handleFindDeadCode({ directory: '/p', ifDeleted: 'nope' }) as { error: string };
    expect(r.error).toMatch(/not found/);
  });

  it('lowers confidence and caveats when the dependency graph is absent', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));
    const r = await handleFindDeadCode({ directory: '/p' }) as {
      coverage: { exportSignal: string }; candidateDead: Array<{ name: string; confidence: string }>; soundness: { caveats: string[] };
    };
    expect(r.coverage.exportSignal).toBe('none');
    // Without the import signal, even the orphan caps at medium.
    expect(r.candidateDead.find(d => d.name === 'orphan')!.confidence).toBe('medium');
    expect(r.soundness.caveats.join(' ')).toMatch(/no dependency graph/i);
  });

  it('errors cleanly when no analysis is cached', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await handleFindDeadCode({ directory: '/p' }) as { error: string };
    expect(r.error).toMatch(/analyze_codebase/);
  });

  // ── Confidence boundary (spec: add-confidence-boundary-disclosure) ──────────
  it('reports a clean, complete boundary when liveness rests only on direct edges', async () => {
    const r = await handleFindDeadCode({ directory: '/p' }) as {
      confidenceBoundary: { basis: { directEdges: number; synthesizedEdges: number }; complete: boolean; knownUnknowable?: unknown };
    };
    expect(r.confidenceBoundary.basis.directEdges).toBeGreaterThan(0);
    expect(r.confidenceBoundary.basis.synthesizedEdges).toBe(0);
    expect(r.confidenceBoundary.complete).toBe(true);
    expect(r.confidenceBoundary.knownUnknowable).toBeUndefined();
  });

  it('flags a known-unknowable crossing when liveness leans on a synthesized edge', async () => {
    // helper is kept live only by a synthesized callback-registration edge from
    // the (live) handler — the reachability sweep crossed a heuristic boundary.
    const nodes = [
      node({ id: 'src/main.ts::main', fanOut: 1 }),
      node({ id: 'src/app.ts::handler', fanIn: 1, fanOut: 1 }),
      node({ id: 'src/app.ts::helper', fanIn: 1 }),
    ];
    const edges: CallEdge[] = [
      edge('src/main.ts::main', 'src/app.ts::handler'),
      { callerId: 'src/app.ts::handler', calleeId: 'src/app.ts::helper', calleeName: 'helper', confidence: 'synthesized', kind: 'calls', synthesizedBy: 'callback-registration' },
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ edges: [{ importedNames: ['main'] }] }) as never);

    const r = await handleFindDeadCode({ directory: '/p' }) as {
      confidenceBoundary: {
        basis: { synthesizedEdges: number; synthesizedByRule?: Record<string, number> };
        complete: boolean;
        knownUnknowable?: Array<{ kind: string; rule?: string }>;
      };
    };
    expect(r.confidenceBoundary.basis.synthesizedEdges).toBe(1);
    expect(r.confidenceBoundary.basis.synthesizedByRule).toEqual({ 'callback-registration': 1 });
    expect(r.confidenceBoundary.complete).toBe(false);
    expect(r.confidenceBoundary.knownUnknowable?.[0]).toMatchObject({ kind: 'synthesized-dispatch', rule: 'callback-registration' });
  });
});
