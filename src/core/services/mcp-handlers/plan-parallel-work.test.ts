import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

import { computePlanParallelWork, type ParallelWorkPlan } from './plan-parallel-work.js';
import { readCachedContext } from './utils.js';
import { assertConclusionShape, TOOL_OUTPUT_CLASS } from './tool-contract.js';
import { resolveEnforcementClass, isKnownFindingCode } from './enforcement-policy.js';
import type { FunctionNode, CallEdge, SerializedCallGraph } from '../../analyzer/call-graph.js';

// ---- fixtures ----

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  const [filePath, rest] = over.id.split('::');
  return {
    name: rest ?? over.id,
    filePath: filePath ?? 'x.ts',
    isAsync: false, language: 'typescript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0,
    ...over,
  };
}
function edge(callerId: string, calleeId: string): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence: 'import', kind: 'calls' };
}
function graph(nodes: FunctionNode[], edges: CallEdge[] = []): SerializedCallGraph {
  return {
    nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
}

/** A fixture graph covering all scenarios; producer←consumer gives a RAW edge. */
function scenarioGraph(): SerializedCallGraph {
  return graph(
    [
      node({ id: 'a.ts::funcA1' }),
      node({ id: 'a.ts::funcA2' }),
      node({ id: 'b.ts::funcB' }),
      node({ id: 'c.ts::funcC' }),
      node({ id: 'd.ts::funcD' }),
      node({ id: 'shared.ts::shared' }),
      node({ id: 'reg.ts::REGISTRY' }),
      node({ id: 'prod.ts::producer', fanIn: 1 }),
      node({ id: 'cons.ts::consumer' }),
    ],
    [edge('cons.ts::consumer', 'prod.ts::producer')], // consumer reads producer → RAW seam
  );
}

/** Mock the cached context; optionally provide a coupling lookup. */
function mockCtx(cg: SerializedCallGraph, coupling?: Record<string, Array<{ file: string; support: number; confidence: number }>>) {
  const edgeStore = coupling
    ? {
        getChangeCouplingForFiles: (files: string[]) =>
          files.filter(f => coupling[f]).map(f => ({ filePath: f, churn: 10, coupledWith: coupling[f] })),
      }
    : undefined;
  vi.mocked(readCachedContext).mockResolvedValue({ callGraph: cg, edgeStore } as never);
}

// Force ambient classification off so these scenario tests isolate the hazard logic.
const OPTS = { ambientFanInPercentile: 1.0 };

function plan(tasks: Parameters<typeof computePlanParallelWork>[0]['tasks']) {
  return computePlanParallelWork({ directory: '/p', tasks, ...OPTS }) as Promise<ParallelWorkPlan>;
}

beforeEach(() => mockCtx(scenarioGraph()));

// ---- input validation ----

describe('computePlanParallelWork — input contract', () => {
  it('rejects an empty task list', async () => {
    const r = await computePlanParallelWork({ directory: '/p', tasks: [] });
    expect(r).toHaveProperty('error');
  });
  it('rejects a task with no seeds', async () => {
    const r = await computePlanParallelWork({ directory: '/p', tasks: [{ id: 't1' }] });
    expect((r as { error: string }).error).toMatch(/at least one seed/i);
  });
  it('rejects duplicate task ids', async () => {
    const r = await computePlanParallelWork({
      directory: '/p',
      tasks: [{ id: 't1', seedSymbols: ['a.ts::funcA1'] }, { id: 't1', seedSymbols: ['b.ts::funcB'] }],
    });
    expect((r as { error: string }).error).toMatch(/unique/i);
  });
  it('degrades gracefully when no analysis is cached', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await computePlanParallelWork({ directory: '/p', tasks: [{ id: 't1', seedSymbols: ['a.ts::funcA1'] }] });
    expect((r as { error: string }).error).toMatch(/No analysis found/i);
  });
});

// ---- scheduling scenarios ----

describe('computePlanParallelWork — scheduling', () => {
  it('disjoint tasks plan into a single wave with a one-round critical path', async () => {
    const p = await plan([
      { id: 't1', seedSymbols: ['a.ts::funcA1'] },
      { id: 't2', seedSymbols: ['b.ts::funcB'] },
      { id: 't3', seedSymbols: ['c.ts::funcC'] },
    ]);
    expect(p.waves).toHaveLength(1);
    expect(p.waves[0].taskIds).toEqual(['t1', 't2', 't3']);
    expect(p.criticalPath.rounds).toBe(1);
    expect(p.conflicts).toEqual([]);
  });

  it('a WAW pair splits across waves and emits an advisory-by-default finding', async () => {
    const p = await plan([
      { id: 't1', seedSymbols: ['shared.ts::shared'] },
      { id: 't2', seedSymbols: ['shared.ts::shared'] },
    ]);
    expect(p.waves).toHaveLength(2);
    expect(p.conflicts[0]).toMatchObject({ hazard: 'WAW', witnesses: ['shared.ts::shared'] });
    const f = p.findings.find(f => f.code === 'parallel-work-conflict');
    expect(f).toBeDefined();
    // advisory by default — nothing blocks unless an operator opts in
    expect(resolveEnforcementClass('parallel-work-conflict', undefined)).toBe('advisory');
  });

  it('concurrent appends to a registration symbol stay in one wave (shared-append advisory)', async () => {
    const p = await plan([
      { id: 't1', seedSymbols: ['reg.ts::REGISTRY'], writeMode: 'append' },
      { id: 't2', seedSymbols: ['reg.ts::REGISTRY'], writeMode: 'append' },
    ]);
    expect(p.waves).toHaveLength(1);
    expect(p.waves[0].taskIds).toEqual(['t1', 't2']);
    expect(p.advisories.find(a => a.kind === 'shared-append')).toBeDefined();
    expect(p.findings.find(f => f.code === 'parallel-work-conflict')).toBeUndefined();
  });

  it('a RAW dependency orders the waves and sets the critical path', async () => {
    const p = await plan([
      { id: 'producer', seedSymbols: ['prod.ts::producer'] },
      { id: 'consumer', seedSymbols: ['cons.ts::consumer'] },
    ]);
    expect(p.waves).toHaveLength(2);
    expect(p.waves[0].taskIds).toEqual(['producer']);
    expect(p.waves[1].taskIds).toEqual(['consumer']);
    expect(p.waves[1].waitsOn).toEqual(['producer']);
    expect(p.conflicts[0]).toMatchObject({ hazard: 'RAW', direction: 'B after A' });
    expect(p.criticalPath.rounds).toBe(2);
    expect(p.criticalPath.chain).toEqual(['producer', 'consumer']);
  });

  it('same-file disjoint symbols stay in one wave with a WAR advisory', async () => {
    const p = await plan([
      { id: 't1', seedSymbols: ['a.ts::funcA1'] },
      { id: 't2', seedSymbols: ['a.ts::funcA2'] },
    ]);
    expect(p.waves).toHaveLength(1);
    expect(p.advisories.find(a => a.kind === 'WAR')).toBeDefined();
    expect(p.findings).toEqual([]);
  });

  it('a soft-coupling pair is an advisory, not serialized', async () => {
    mockCtx(scenarioGraph(), { 'b.ts': [{ file: 'c.ts', support: 4, confidence: 0.6 }] });
    const p = await plan([
      { id: 't1', seedSymbols: ['b.ts::funcB'] },
      { id: 't2', seedSymbols: ['c.ts::funcC'] },
    ]);
    expect(p.waves).toHaveLength(1);
    expect(p.advisories.find(a => a.kind === 'soft-coupling' && a.witnesses.includes('c.ts'))).toBeDefined();
  });

  it('re-invoking with a subset re-plans deterministically (byte-identical)', async () => {
    const tasks = [
      { id: 'producer', seedSymbols: ['prod.ts::producer'] },
      { id: 'consumer', seedSymbols: ['cons.ts::consumer'] },
    ];
    const a = JSON.stringify(await plan(tasks));
    const b = JSON.stringify(await plan(tasks));
    expect(a).toBe(b);
  });

  it('carries the ground-truth disclosure on every plan', async () => {
    const p = await plan([{ id: 't1', seedSymbols: ['a.ts::funcA1'] }]);
    expect(p.disclosure).toMatch(/integration tests remain the ground truth/i);
    expect(p.scheduling).toMatch(/not globally optimal/i);
  });
});

// ---- the worked-example regression (registration hot-spot collapse) ----

describe('computePlanParallelWork — worked-example regression', () => {
  /** A foundation symbol the three follow-on tasks read, plus a shared registry they all touch. */
  function workedGraph(): SerializedCallGraph {
    return graph(
      [
        node({ id: 'foundation.ts::footprintCore', fanIn: 3 }),
        node({ id: 't2.ts::t2work' }),
        node({ id: 't3.ts::t3work' }),
        node({ id: 't4.ts::t4work' }),
        node({ id: 'reg.ts::REGISTRY' }),
      ],
      [
        edge('t2.ts::t2work', 'foundation.ts::footprintCore'),
        edge('t3.ts::t3work', 'foundation.ts::footprintCore'),
        edge('t4.ts::t4work', 'foundation.ts::footprintCore'),
      ],
    );
  }
  const tasks = (mode: 'append' | 'modify') => [
    { id: 'T1', seedSymbols: ['foundation.ts::footprintCore'] },
    { id: 'T2', seedSymbols: ['t2.ts::t2work', 'reg.ts::REGISTRY'], writeMode: mode },
    { id: 'T3', seedSymbols: ['t3.ts::t3work', 'reg.ts::REGISTRY'], writeMode: mode },
    { id: 'T4', seedSymbols: ['t4.ts::t4work', 'reg.ts::REGISTRY'], writeMode: mode },
  ];

  it('append-declared registry seeds collapse to 2 waves (foundation, then parallel)', async () => {
    mockCtx(workedGraph());
    const p = (await computePlanParallelWork({ directory: '/p', tasks: tasks('append'), ...OPTS })) as ParallelWorkPlan;
    expect(p.waves).toHaveLength(2);
    expect(p.waves[0].taskIds).toEqual(['T1']);
    expect(p.waves[1].taskIds).toEqual(['T2', 'T3', 'T4']);
    expect(p.criticalPath.rounds).toBe(2);
  });

  it('the naive modify default serializes the registry touches to 4 waves (guards the collapse)', async () => {
    mockCtx(workedGraph());
    const p = (await computePlanParallelWork({ directory: '/p', tasks: tasks('modify'), ...OPTS })) as ParallelWorkPlan;
    expect(p.waves).toHaveLength(4);
    expect(p.criticalPath.rounds).toBe(4);
  });
});

// ---- contract & wiring ----

describe('plan_parallel_work — contract & wiring', () => {
  it('returns a conclusion-shaped result (passes the tool contract)', async () => {
    const p = await plan([
      { id: 't1', seedSymbols: ['prod.ts::producer'] },
      { id: 't2', seedSymbols: ['cons.ts::consumer'] },
    ]);
    expect(() => assertConclusionShape('plan_parallel_work', p)).not.toThrow();
    expect(p).not.toHaveProperty('nodes');
    expect(p).not.toHaveProperty('edges');
  });

  it('is classified `conclusion` in the tool contract', () => {
    expect(TOOL_OUTPUT_CLASS['plan_parallel_work']).toBe('conclusion');
  });

  it('registers its governance finding code', () => {
    expect(isKnownFindingCode('parallel-work-conflict')).toBe(true);
  });
});
