/**
 * Tests for analyzeForRefactoring — all 5 issue categories.
 *
 * Categories tested:
 *   unreachable       — no callers AND no requirements
 *   high_fan_in       — fanIn >= 8 (and not a cross-cutting utility hub)
 *   high_fan_out      — fanOut >= 8
 *   multi_requirement — mapped to > 2 requirements (SRP violation)
 *   in_cycle          — part of a strongly-connected component (cycle)
 *
 * Also tests: depth computation, priority scoring, cycle summaries,
 * isCrossCuttingHub suppression, and requirement mapping integration.
 */

import { describe, it, expect } from 'vitest';
import { analyzeForRefactoring } from './refactor-analyzer.js';
import type { SerializedCallGraph, FunctionNode } from './call-graph.js';
import type { MappingEntry } from './refactor-analyzer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<FunctionNode> & { id: string; name: string; filePath: string }): FunctionNode {
  return {
    className: undefined,
    isAsync: false,
    language: 'TypeScript',
    startIndex: 0,
    endIndex: 100,
    fanIn: 0,
    fanOut: 0,
    ...overrides,
  };
}

function makeGraph(
  nodes: FunctionNode[],
  edges: SerializedCallGraph['edges'] = []
): SerializedCallGraph {
  return {
    nodes,
    edges,
    classes: [],
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [],
    layerViolations: [],
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      avgFanIn: 0,
      avgFanOut: 0,
    },
  };
}

function issuesOf(report: ReturnType<typeof analyzeForRefactoring>, name: string) {
  return report.priorities.find(e => e.function === name)?.issues ?? [];
}

// ---------------------------------------------------------------------------
// unreachable
// ---------------------------------------------------------------------------

describe('analyzeForRefactoring — unreachable', () => {
  it('flags functions in a cycle with no external entry point as unreachable', () => {
    // a↔b call each other but nobody external calls them.
    // Both have fanIn=1 → neither is an entry point → BFS never reaches them → depth=-1.
    const a = makeNode({ id: 'dead.ts::a', name: 'a', filePath: 'dead.ts', fanIn: 1, fanOut: 1 });
    const b = makeNode({ id: 'dead.ts::b', name: 'b', filePath: 'dead.ts', fanIn: 1, fanOut: 1 });

    const graph = makeGraph([a, b], [
      { callerId: 'dead.ts::a', calleeId: 'dead.ts::b', calleeName: 'b', confidence: 'name_only' as const },
      { callerId: 'dead.ts::b', calleeId: 'dead.ts::a', calleeName: 'a', confidence: 'name_only' as const },
    ]);

    const report = analyzeForRefactoring(graph);
    expect(issuesOf(report, 'a')).toContain('unreachable');
    expect(issuesOf(report, 'b')).toContain('unreachable');
  });

  it('does NOT flag isolated functions (fanIn=0) as unreachable — they are entry points', () => {
    // A function with no callers is treated as a potential entry point (depth=0).
    // This covers exported handlers, main functions, event callbacks, etc.
    const standalone = makeNode({ id: 'a.ts::standalone', name: 'standalone', filePath: 'a.ts', fanIn: 0, fanOut: 0 });
    const graph = makeGraph([standalone]);
    const report = analyzeForRefactoring(graph);
    expect(issuesOf(report, 'standalone')).not.toContain('unreachable');
  });

  it('does NOT flag unreachable when the function has mapped requirements', () => {
    // a↔b cycle → both depth=-1; but 'a' has a requirement → suppress unreachable for 'a' only
    const a = makeNode({ id: 'dead.ts::a', name: 'a', filePath: 'dead.ts', fanIn: 1, fanOut: 1 });
    const b = makeNode({ id: 'dead.ts::b', name: 'b', filePath: 'dead.ts', fanIn: 1, fanOut: 1 });

    const graph = makeGraph([a, b], [
      { callerId: 'dead.ts::a', calleeId: 'dead.ts::b', calleeName: 'b', confidence: 'name_only' as const },
      { callerId: 'dead.ts::b', calleeId: 'dead.ts::a', calleeName: 'a', confidence: 'name_only' as const },
    ]);

    const mappings: MappingEntry[] = [
      { requirement: 'REQ-1', functions: [{ name: 'a', file: 'dead.ts' }] },
    ];

    const report = analyzeForRefactoring(graph, mappings);
    expect(issuesOf(report, 'a')).not.toContain('unreachable');
    expect(issuesOf(report, 'b')).toContain('unreachable'); // b has no requirements
  });

  it('reports unreachable count in stats', () => {
    // a↔b cycle, both disconnected → both unreachable
    const a = makeNode({ id: 'f.ts::a', name: 'a', filePath: 'f.ts', fanIn: 1, fanOut: 1 });
    const b = makeNode({ id: 'f.ts::b', name: 'b', filePath: 'f.ts', fanIn: 1, fanOut: 1 });
    const graph = makeGraph([a, b], [
      { callerId: 'f.ts::a', calleeId: 'f.ts::b', calleeName: 'b', confidence: 'name_only' as const },
      { callerId: 'f.ts::b', calleeId: 'f.ts::a', calleeName: 'a', confidence: 'name_only' as const },
    ]);
    const report = analyzeForRefactoring(graph);
    expect(report.stats.unreachable).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// high_fan_in
// ---------------------------------------------------------------------------

describe('analyzeForRefactoring — high_fan_in', () => {
  it('flags a function with fanIn >= 8', () => {
    const hub = makeNode({ id: 'src/hub.ts::dispatch', name: 'dispatch', filePath: 'src/hub.ts', fanIn: 10, fanOut: 2 });
    const report = analyzeForRefactoring(makeGraph([hub]));
    expect(issuesOf(report, 'dispatch')).toContain('high_fan_in');
    expect(report.stats.highFanIn).toBe(1);
  });

  it('does NOT flag a function with fanIn < 8', () => {
    const node = makeNode({ id: 'src/a.ts::fn', name: 'fn', filePath: 'src/a.ts', fanIn: 7, fanOut: 1 });
    const report = analyzeForRefactoring(makeGraph([node]));
    expect(issuesOf(report, 'fn')).not.toContain('high_fan_in');
  });

  it('suppresses high_fan_in for pure-sink functions in utility/logger paths', () => {
    const logger = makeNode({
      id: 'src/utils/logger.ts::info',
      name: 'info',
      filePath: 'src/utils/logger.ts',
      fanIn: 20,
      fanOut: 0, // pure sink
    });
    const report = analyzeForRefactoring(makeGraph([logger]));
    expect(issuesOf(report, 'info')).not.toContain('high_fan_in');
  });

  it('does NOT suppress high_fan_in for utility functions that also make calls (fanOut > 0)', () => {
    const util = makeNode({
      id: 'src/utils/transformer.ts::process',
      name: 'process',
      filePath: 'src/utils/transformer.ts',
      fanIn: 10,
      fanOut: 3, // calls other functions → not a pure sink
    });
    const report = analyzeForRefactoring(makeGraph([util]));
    expect(issuesOf(report, 'process')).toContain('high_fan_in');
  });
});

// ---------------------------------------------------------------------------
// high_fan_out
// ---------------------------------------------------------------------------

describe('analyzeForRefactoring — high_fan_out', () => {
  it('flags a function with fanOut >= 8 (god function)', () => {
    const god = makeNode({ id: 'src/orchestrator.ts::run', name: 'run', filePath: 'src/orchestrator.ts', fanIn: 1, fanOut: 12 });
    const report = analyzeForRefactoring(makeGraph([god]));
    expect(issuesOf(report, 'run')).toContain('high_fan_out');
    expect(report.stats.highFanOut).toBe(1);
  });

  it('does NOT flag a function with fanOut < 8', () => {
    const node = makeNode({ id: 'src/a.ts::fn', name: 'fn', filePath: 'src/a.ts', fanIn: 1, fanOut: 7 });
    const report = analyzeForRefactoring(makeGraph([node]));
    expect(issuesOf(report, 'fn')).not.toContain('high_fan_out');
  });

  it('can have both high_fan_in and high_fan_out simultaneously', () => {
    const bottleneck = makeNode({
      id: 'core.ts::bottleneck',
      name: 'bottleneck',
      filePath: 'core.ts',
      fanIn: 10,
      fanOut: 10,
    });
    const report = analyzeForRefactoring(makeGraph([bottleneck]));
    expect(issuesOf(report, 'bottleneck')).toContain('high_fan_in');
    expect(issuesOf(report, 'bottleneck')).toContain('high_fan_out');
  });
});

// ---------------------------------------------------------------------------
// multi_requirement (SRP violation)
// ---------------------------------------------------------------------------

describe('analyzeForRefactoring — multi_requirement', () => {
  it('flags a function mapped to more than 2 requirements', () => {
    const fn = makeNode({ id: 'svc.ts::handleAll', name: 'handleAll', filePath: 'svc.ts', fanIn: 1, fanOut: 1 });
    const graph = makeGraph([fn]);

    const mappings: MappingEntry[] = [
      { requirement: 'REQ-1', functions: [{ name: 'handleAll', file: 'svc.ts' }] },
      { requirement: 'REQ-2', functions: [{ name: 'handleAll', file: 'svc.ts' }] },
      { requirement: 'REQ-3', functions: [{ name: 'handleAll', file: 'svc.ts' }] },
    ];

    const report = analyzeForRefactoring(graph, mappings);
    expect(issuesOf(report, 'handleAll')).toContain('multi_requirement');
    expect(report.stats.srpViolations).toBe(1);

    const entry = report.priorities.find(e => e.function === 'handleAll')!;
    expect(entry.requirements).toHaveLength(3);
  });

  it('does NOT flag a function mapped to exactly 2 requirements', () => {
    const fn = makeNode({ id: 'svc.ts::handle', name: 'handle', filePath: 'svc.ts', fanIn: 1, fanOut: 1 });
    const mappings: MappingEntry[] = [
      { requirement: 'REQ-1', functions: [{ name: 'handle', file: 'svc.ts' }] },
      { requirement: 'REQ-2', functions: [{ name: 'handle', file: 'svc.ts' }] },
    ];

    const report = analyzeForRefactoring(makeGraph([fn]), mappings);
    expect(issuesOf(report, 'handle')).not.toContain('multi_requirement');
  });

  it('matches requirements using file suffix matching', () => {
    // Mapping uses short path, node uses full path
    const fn = makeNode({ id: 'src/services/user.ts::create', name: 'create', filePath: 'src/services/user.ts', fanIn: 1, fanOut: 1 });
    const mappings: MappingEntry[] = [
      { requirement: 'REQ-1', functions: [{ name: 'create', file: 'services/user.ts' }] },
      { requirement: 'REQ-2', functions: [{ name: 'create', file: 'services/user.ts' }] },
      { requirement: 'REQ-3', functions: [{ name: 'create', file: 'services/user.ts' }] },
    ];

    const report = analyzeForRefactoring(makeGraph([fn]), mappings);
    expect(issuesOf(report, 'create')).toContain('multi_requirement');
  });
});

// ---------------------------------------------------------------------------
// in_cycle
// ---------------------------------------------------------------------------

describe('analyzeForRefactoring — in_cycle', () => {
  it('flags two mutually recursive functions as in_cycle', () => {
    // a → b → a (cycle of size 2)
    const a = makeNode({ id: 'cycle.ts::a', name: 'a', filePath: 'cycle.ts', fanIn: 1, fanOut: 1 });
    const b = makeNode({ id: 'cycle.ts::b', name: 'b', filePath: 'cycle.ts', fanIn: 1, fanOut: 1 });

    const graph = makeGraph([a, b], [
      { callerId: 'cycle.ts::a', calleeId: 'cycle.ts::b', calleeName: 'b', confidence: 'name_only' as const },
      { callerId: 'cycle.ts::b', calleeId: 'cycle.ts::a', calleeName: 'a', confidence: 'name_only' as const },
    ]);

    const report = analyzeForRefactoring(graph);
    expect(issuesOf(report, 'a')).toContain('in_cycle');
    expect(issuesOf(report, 'b')).toContain('in_cycle');
    expect(report.stats.cycleParticipants).toBe(2);
    expect(report.stats.cyclesDetected).toBe(1);
  });

  it('reports cycles in the cycles summary', () => {
    const a = makeNode({ id: 'c.ts::a', name: 'a', filePath: 'c.ts', fanIn: 1, fanOut: 1 });
    const b = makeNode({ id: 'c.ts::b', name: 'b', filePath: 'c.ts', fanIn: 1, fanOut: 1 });
    const c = makeNode({ id: 'c.ts::c', name: 'c', filePath: 'c.ts', fanIn: 1, fanOut: 1 });

    const graph = makeGraph([a, b, c], [
      { callerId: 'c.ts::a', calleeId: 'c.ts::b', calleeName: 'b', confidence: 'name_only' as const },
      { callerId: 'c.ts::b', calleeId: 'c.ts::c', calleeName: 'c', confidence: 'name_only' as const },
      { callerId: 'c.ts::c', calleeId: 'c.ts::a', calleeName: 'a', confidence: 'name_only' as const },
    ]);

    const report = analyzeForRefactoring(graph);
    expect(report.cycles).toHaveLength(1);
    expect(report.cycles[0].size).toBe(3);
    expect(report.cycles[0].participants.map(p => p.function).sort()).toEqual(['a', 'b', 'c']);
  });

  it('does NOT flag a linear chain as a cycle', () => {
    // a → b → c (no cycle)
    const a = makeNode({ id: 'l.ts::a', name: 'a', filePath: 'l.ts', fanIn: 0, fanOut: 1 });
    const b = makeNode({ id: 'l.ts::b', name: 'b', filePath: 'l.ts', fanIn: 1, fanOut: 1 });
    const c = makeNode({ id: 'l.ts::c', name: 'c', filePath: 'l.ts', fanIn: 1, fanOut: 0 });

    const graph = makeGraph([a, b, c], [
      { callerId: 'l.ts::a', calleeId: 'l.ts::b', calleeName: 'b', confidence: 'name_only' as const },
      { callerId: 'l.ts::b', calleeId: 'l.ts::c', calleeName: 'c', confidence: 'name_only' as const },
    ]);

    const report = analyzeForRefactoring(graph);
    expect(report.stats.cyclesDetected).toBe(0);
    expect(issuesOf(report, 'a')).not.toContain('in_cycle');
    expect(issuesOf(report, 'b')).not.toContain('in_cycle');
    expect(issuesOf(report, 'c')).not.toContain('in_cycle');
  });
});

// ---------------------------------------------------------------------------
// Depth computation
// ---------------------------------------------------------------------------

describe('analyzeForRefactoring — depth computation', () => {
  it('assigns depth 0 to entry points (fanIn === 0)', () => {
    const entry = makeNode({ id: 'app.ts::main', name: 'main', filePath: 'app.ts', fanIn: 0, fanOut: 1 });
    const leaf = makeNode({ id: 'app.ts::leaf', name: 'leaf', filePath: 'app.ts', fanIn: 1, fanOut: 0 });

    const graph = makeGraph([entry, leaf], [
      { callerId: 'app.ts::main', calleeId: 'app.ts::leaf', calleeName: 'leaf', confidence: 'name_only' as const },
    ]);

    const report = analyzeForRefactoring(graph);
    // leaf is reachable (depth 1), so NOT unreachable
    expect(issuesOf(report, 'leaf')).not.toContain('unreachable');
    expect(issuesOf(report, 'main')).not.toContain('unreachable');
  });

  it('assigns depth -1 to functions not reachable from any entry point', () => {
    // island: a calls b, but nobody calls a (fanIn=0), and c is isolated
    // c is unreachable: no path from any entry point
    const a = makeNode({ id: 'x.ts::a', name: 'a', filePath: 'x.ts', fanIn: 0, fanOut: 1 });
    const b = makeNode({ id: 'x.ts::b', name: 'b', filePath: 'x.ts', fanIn: 1, fanOut: 0 });
    // c is a cycle participant with no entry: a→b path doesn't include c
    const c = makeNode({ id: 'x.ts::c', name: 'c', filePath: 'x.ts', fanIn: 1, fanOut: 1 });
    const d = makeNode({ id: 'x.ts::d', name: 'd', filePath: 'x.ts', fanIn: 1, fanOut: 1 });

    // c↔d is a cycle, but nobody calls c or d from outside
    const graph = makeGraph([a, b, c, d], [
      { callerId: 'x.ts::a', calleeId: 'x.ts::b', calleeName: 'b', confidence: 'name_only' as const },
      { callerId: 'x.ts::c', calleeId: 'x.ts::d', calleeName: 'd', confidence: 'name_only' as const },
      { callerId: 'x.ts::d', calleeId: 'x.ts::c', calleeName: 'c', confidence: 'name_only' as const },
    ]);

    const report = analyzeForRefactoring(graph);
    // c and d form a cycle and are unreachable (depth -1)
    // but they are in_cycle, so they'll have that issue instead of unreachable
    // Actually: unreachable is suppressed if they have requirements — but here no requirements
    // They have fanIn > 0 (each other), so depth might not be -1...
    // Wait: c.fanIn=1 (called by d), but d itself has fanIn=1 (called by c)
    // The entry points are nodes with fanIn=0: only 'a' has fanIn=0
    // BFS from 'a': visits b. c and d are never reached → depth -1 → unreachable
    expect(issuesOf(report, 'c')).toContain('unreachable');
    expect(issuesOf(report, 'd')).toContain('unreachable');
  });
});

// ---------------------------------------------------------------------------
// Priority scoring
// ---------------------------------------------------------------------------

describe('analyzeForRefactoring — priority scoring', () => {
  it('sorts results by priorityScore descending', () => {
    // godFn: entry point (fanIn=0) with fanOut=15 → high_fan_out at depth=0 → high score
    // hubFn: fanIn=9 but no edges to it → depth=-1 → unreachable + high_fan_in → lower score
    const godFn = makeNode({ id: 'a.ts::godFn', name: 'godFn', filePath: 'a.ts', fanIn: 0, fanOut: 15 });
    const hubFn = makeNode({ id: 'a.ts::hubFn', name: 'hubFn', filePath: 'a.ts', fanIn: 9, fanOut: 0 });

    const report = analyzeForRefactoring(makeGraph([godFn, hubFn]));

    expect(report.priorities[0].function).toBe('godFn');
    expect(report.priorities[0].priorityScore).toBeGreaterThan(report.priorities[1].priorityScore);
  });

  it('only includes functions with at least one issue in priorities', () => {
    // clean: reachable entry point with normal fanIn/fanOut → no issues
    // dirty: god function with fanOut >= 8
    const clean = makeNode({ id: 'ok.ts::clean', name: 'clean', filePath: 'ok.ts', fanIn: 0, fanOut: 1 });
    const dirty = makeNode({ id: 'ok.ts::dirty', name: 'dirty', filePath: 'ok.ts', fanIn: 1, fanOut: 10 });

    const report = analyzeForRefactoring(makeGraph([clean, dirty], [
      { callerId: 'ok.ts::clean', calleeId: 'ok.ts::dirty', calleeName: 'dirty', confidence: 'name_only' as const },
    ]));

    expect(report.priorities.map(e => e.function)).not.toContain('clean');
    expect(report.priorities.map(e => e.function)).toContain('dirty');
  });
});

// ---------------------------------------------------------------------------
// Empty / edge cases
// ---------------------------------------------------------------------------

describe('analyzeForRefactoring — edge cases', () => {
  it('handles empty call graph', () => {
    const report = analyzeForRefactoring(makeGraph([]));
    expect(report.stats.totalFunctions).toBe(0);
    expect(report.priorities).toHaveLength(0);
    expect(report.cycles).toHaveLength(0);
  });

  it('treats isolated functions (fanIn=0, no edges) as entry points, not unreachable', () => {
    // All three have fanIn=0 → all are entry points (depth=0) → none are unreachable
    const nodes = Array.from({ length: 3 }, (_, i) =>
      makeNode({ id: `f.ts::fn${i}`, name: `fn${i}`, filePath: 'f.ts', fanIn: 0, fanOut: 0 })
    );
    const report = analyzeForRefactoring(makeGraph(nodes));
    expect(report.stats.unreachable).toBe(0);
    expect(report.stats.cyclesDetected).toBe(0);
  });

  it('sets generatedAt to a recent ISO timestamp', () => {
    const report = analyzeForRefactoring(makeGraph([]));
    const ts = new Date(report.generatedAt).getTime();
    expect(ts).toBeGreaterThan(Date.now() - 5000);
  });
});

// ---------------------------------------------------------------------------
// Projected declarations are not refactoring targets
// ---------------------------------------------------------------------------

describe('analyzeForRefactoring — projected declarations', () => {
  it('does not report two mutually-recursive schemas as a dependency cycle', () => {
    // `Node.next → Other.back → Node` is an ordinary recursive type — a tree with parent
    // links, a linked list, a comment thread. It is not a cycle anyone can or should break,
    // and this report is what the generated architecture document prints as work to do.
    const graph = makeGraph(
      [
        makeNode({ id: 'openapi.yaml::#/components/schemas/Node', name: '#/components/schemas/Node', filePath: 'openapi.yaml', language: 'OpenAPI' }),
        makeNode({ id: 'openapi.yaml::#/components/schemas/Other', name: '#/components/schemas/Other', filePath: 'openapi.yaml', language: 'OpenAPI' }),
      ],
      [
        { callerId: 'openapi.yaml::#/components/schemas/Node', calleeId: 'openapi.yaml::#/components/schemas/Other', calleeName: '#/components/schemas/Other', confidence: 'name_only' as const, kind: 'references_schema' },
        { callerId: 'openapi.yaml::#/components/schemas/Other', calleeId: 'openapi.yaml::#/components/schemas/Node', calleeName: '#/components/schemas/Node', confidence: 'name_only' as const, kind: 'references_schema' },
      ],
    );

    const report = analyzeForRefactoring(graph);

    expect(report.cycles).toEqual([]);
    expect(report.stats.cyclesDetected).toBe(0);
    expect(report.stats.cycleParticipants).toBe(0);
    expect(report.priorities.flatMap(p => p.issues)).not.toContain('in_cycle');
  });

  it('still reports a real cycle between two functions', () => {
    // The exclusion is keyed on the node language and the edge kind, so it must not have
    // disarmed cycle detection itself.
    const graph = makeGraph(
      [
        makeNode({ id: 'a.ts::a', name: 'a', filePath: 'a.ts' }),
        makeNode({ id: 'b.ts::b', name: 'b', filePath: 'b.ts' }),
      ],
      [
        { callerId: 'a.ts::a', calleeId: 'b.ts::b', calleeName: 'b', confidence: 'name_only' as const, kind: 'calls' },
        { callerId: 'b.ts::b', calleeId: 'a.ts::a', calleeName: 'a', confidence: 'name_only' as const, kind: 'calls' },
      ],
    );

    expect(analyzeForRefactoring(graph).stats.cyclesDetected).toBe(1);
  });

  it('counts only code in the totals it reports refactoring work against', () => {
    // `totalFunctions` is the denominator a reader uses to judge how much of the repository has
    // outstanding work. Counting declarations in it makes any proportion meaningless.
    const graph = makeGraph(
      [
        makeNode({ id: 'src/h.ts::handler', name: 'handler', filePath: 'src/h.ts' }),
        makeNode({ id: 'openapi.yaml::GET /x', name: 'GET /x', filePath: 'openapi.yaml', language: 'OpenAPI' }),
        makeNode({ id: 'openapi.yaml::#/components/schemas/X', name: '#/components/schemas/X', filePath: 'openapi.yaml', language: 'OpenAPI' }),
      ],
      [{ callerId: 'openapi.yaml::GET /x', calleeId: 'src/h.ts::handler', calleeName: 'handler', confidence: 'name_only' as const, kind: 'implements_endpoint' }],
    );

    const report = analyzeForRefactoring(graph);

    expect(report.stats.totalFunctions).toBe(1);
    expect(report.priorities.map(p => p.function)).not.toContain('GET /x');
    expect(report.priorities.map(p => p.function)).not.toContain('#/components/schemas/X');
  });
});
