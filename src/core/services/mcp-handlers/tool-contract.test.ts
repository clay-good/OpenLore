/**
 * mcp-quality — the conclusion-over-graph tool contract.
 *
 * Plain `.test.ts` (NOT `.integration.test.ts`) so CI enforces it. The checks
 * are synthetic and deterministic: they do not invoke handlers against the live
 * `.openlore/analysis` fixture, which is gitignored and unavailable in CI. The
 * regression that actually matters — a new tool that forgets to declare a class,
 * or a response shaped like a graph dump — is caught by the completeness
 * cross-check and the predicate below.
 */

import { describe, it, expect } from 'vitest';

import { TOOL_DEFINITIONS } from '../../../cli/commands/mcp.js';
import {
  TOOL_OUTPUT_CLASS,
  EXPLICIT_TOPOLOGY_TOOLS,
  assertConclusionShape,
  ToolContractViolationError,
  TOOL_CAPABILITY_FAMILY,
  CAPABILITY_FAMILIES,
  ADJACENT_TOOL_GROUPS,
  capabilityFamily,
  groupToolsByFamily,
  enforceConclusionContract,
  conclusionShapeFinding,
  CONCLUSION_SHAPE_VIOLATION_CODE,
} from './tool-contract.js';
import { isKnownFindingCode } from './enforcement-policy.js';
import { MAX_PROVENANCE_EDGES } from '../../../constants.js';
import { TOOL_COGNITIVE_WEIGHTS } from './epistemic-lease.js';

const registeredToolNames = TOOL_DEFINITIONS.map(t => t.name);
const toolByName = new Map(TOOL_DEFINITIONS.map(t => [t.name, t]));

describe('TOOL_OUTPUT_CLASS completeness', () => {
  it('classifies every registered tool (no tool is unclassified)', () => {
    const unclassified = registeredToolNames.filter(name => !(name in TOOL_OUTPUT_CLASS));
    expect(unclassified).toEqual([]);
  });

  it('has no stale entries for tools that are no longer registered', () => {
    const registered = new Set(registeredToolNames);
    const stale = Object.keys(TOOL_OUTPUT_CLASS).filter(name => !registered.has(name));
    expect(stale).toEqual([]);
  });

  it('classifies each tool as exactly conclusion or explicit-topology', () => {
    for (const cls of Object.values(TOOL_OUTPUT_CLASS)) {
      expect(['conclusion', 'explicit-topology']).toContain(cls);
    }
  });
});

describe('explicit-topology set', () => {
  it('is exactly { get_call_graph, get_subgraph }', () => {
    expect([...EXPLICIT_TOPOLOGY_TOOLS]).toEqual(['get_call_graph', 'get_subgraph']);
  });
});

// ============================================================================
// CapabilityFamilyTaxonomy (mcp-quality; change: unify-navigation-and-governance-
// substrate). Every tool declares exactly one family from the closed set, the way
// it already declares conclusion vs explicit-topology. These guards fail CI if a
// new tool forgets a family or invents one outside the closed set.
// ============================================================================
describe('TOOL_CAPABILITY_FAMILY completeness', () => {
  it('classifies every registered tool into a family (no tool is unclassified)', () => {
    const unclassified = registeredToolNames.filter(name => !(name in TOOL_CAPABILITY_FAMILY));
    expect(unclassified).toEqual([]);
  });

  it('has no stale entries for tools that are no longer registered', () => {
    const registered = new Set(registeredToolNames);
    const stale = Object.keys(TOOL_CAPABILITY_FAMILY).filter(name => !registered.has(name));
    expect(stale).toEqual([]);
  });

  it('declares only families from the closed set', () => {
    const closed = new Set<string>(CAPABILITY_FAMILIES);
    for (const [name, family] of Object.entries(TOOL_CAPABILITY_FAMILY)) {
      expect(closed.has(family), `tool "${name}" declares unknown family "${family}"`).toBe(true);
    }
  });

  it('the closed family set is exactly the six documented families', () => {
    expect([...CAPABILITY_FAMILIES]).toEqual([
      'navigate', 'change', 'remember', 'verify', 'coordinate', 'federate',
    ]);
  });
});

describe('groupToolsByFamily', () => {
  it('partitions the full surface into family groups covering every tool, in family order', () => {
    const groups = groupToolsByFamily(TOOL_DEFINITIONS);
    // Group order follows CAPABILITY_FAMILIES.
    const order = groups.map(g => g.family);
    expect(order).toEqual(CAPABILITY_FAMILIES.filter(f => order.includes(f)));
    // Every registered tool appears in exactly one group.
    const grouped = groups.flatMap(g => g.tools.map(t => t.name)).sort();
    expect(grouped).toEqual([...registeredToolNames].sort());
    // An agent chooses among a handful of families, not the flat registry.
    expect(groups.length).toBeLessThanOrEqual(CAPABILITY_FAMILIES.length);
  });
});

// ============================================================================
// LeaseWeightTableIsComplete (mcp-handlers; change: fix-epistemic-lease-weights).
// The epistemic lease weights each tool call to track per-session cognitive load.
// Its weight table must cover the whole registry in both directions — the same
// closed-table discipline TOOL_OUTPUT_CLASS and TOOL_CAPABILITY_FAMILY carry — so a
// new tool without a declared weight fails CI rather than silently riding the `?? 1`
// runtime fallback (a freshness signal computed from wrong inputs is a wrong signal).
// ============================================================================
describe('TOOL_COGNITIVE_WEIGHTS completeness', () => {
  it('weights every registered tool (no tool falls to the runtime fallback)', () => {
    const unweighted = registeredToolNames.filter(name => !(name in TOOL_COGNITIVE_WEIGHTS));
    expect(unweighted).toEqual([]);
  });

  it('has no stale entries for tools that are no longer registered', () => {
    const registered = new Set(registeredToolNames);
    const stale = Object.keys(TOOL_COGNITIVE_WEIGHTS).filter(name => !registered.has(name));
    expect(stale).toEqual([]);
  });

  it('assigns every weight from the existing tier set (no newly invented constant)', () => {
    // Weights are assigned by analogy to an existing entry, never a fresh magnitude:
    // 0 (reset), 1-2 (lightweight), 3-5 (structural/graph), 8 (deep architectural trace).
    const allowed = new Set([0, 1, 2, 3, 4, 5, 8]);
    for (const [name, weight] of Object.entries(TOOL_COGNITIVE_WEIGHTS)) {
      expect(allowed.has(weight), `tool "${name}" has weight ${weight} outside the declared tier set`).toBe(true);
    }
  });

  it('scores near-twin tools equally (find_path === trace_execution_path)', () => {
    // Two point-to-point path traversals documented as near-twins accrue equal load —
    // the 8× accounting gap the fix closes.
    expect(TOOL_COGNITIVE_WEIGHTS.find_path).toBe(TOOL_COGNITIVE_WEIGHTS.trace_execution_path);
  });
});

// ============================================================================
// NoRedundantConclusions (mcp-quality). Tools in the same family with adjacent
// purposes are NOT merged — each returns a separately-useful conclusion — so the
// contract instead requires each member to name a near-sibling in its description,
// making the distinction legible to a selecting agent.
// ============================================================================
describe('NoRedundantConclusions: adjacent tools disambiguate themselves', () => {
  it('every adjacency group is intra-family (a group spans exactly one family)', () => {
    for (const group of ADJACENT_TOOL_GROUPS) {
      const families = new Set(group.map(name => capabilityFamily(name)));
      expect(families.size, `adjacency group [${group.join(', ')}] spans families ${[...families].join(', ')}`).toBe(1);
    }
  });

  it('every adjacency-group member is a registered tool', () => {
    for (const group of ADJACENT_TOOL_GROUPS) {
      for (const name of group) {
        expect(toolByName.has(name), `adjacency group references unknown tool "${name}"`).toBe(true);
      }
    }
  });

  // AdjacentConclusionsCrossReferenceAllPairs (enforce-conclusion-contract-runtime):
  // every member names EVERY sibling, not merely one — so a 3+-member group cannot
  // pass on a single lucky mention while a genuinely-confusable sibling goes unnamed.
  it('each member names EVERY other member of its group (all-pairs, not just one)', () => {
    for (const group of ADJACENT_TOOL_GROUPS) {
      for (const name of group) {
        const description = toolByName.get(name)?.description ?? '';
        const siblings = group.filter(s => s !== name);
        const missing = siblings.filter(s => !description.includes(s));
        expect(
          missing,
          `tool "${name}" is adjacent to {${siblings.join(', ')}} but its description omits {${missing.join(', ')}} ` +
            `(AdjacentConclusionsCrossReferenceAllPairs: name every sibling and state the distinct question)`,
        ).toEqual([]);
      }
    }
  });

  it('registers the two audit-found adjacency pairs', () => {
    const registered = ADJACENT_TOOL_GROUPS.map(g => [...g].sort().join('+'));
    expect(registered).toContain(['find_path', 'trace_execution_path'].sort().join('+'));
    expect(registered).toContain(['audit_spec_coverage', 'check_spec_drift'].sort().join('+'));
  });

  it('the all-pairs guard fails a synthetic 3-member group missing one sibling', () => {
    // Mutation check: a member that names only ONE of its two siblings must be caught.
    const descriptions: Record<string, string> = {
      a: 'a relates to b and c',
      b: 'b relates to a and c',
      c: 'c relates to a only', // omits b
    };
    const group = ['a', 'b', 'c'];
    const offenders: string[] = [];
    for (const name of group) {
      const siblings = group.filter(s => s !== name);
      const missing = siblings.filter(s => !descriptions[name].includes(s));
      if (missing.length > 0) offenders.push(`${name}→${missing.join(',')}`);
    }
    expect(offenders).toEqual(['c→b']);
  });
});

describe('assertConclusionShape', () => {
  it('throws for a tool that is not classified', () => {
    expect(() => assertConclusionShape('not_a_real_tool', { ok: true })).toThrow(
      ToolContractViolationError,
    );
  });

  it('exempts explicit-topology tools even when they return a graph dump', () => {
    const dump = { nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }] };
    expect(() => assertConclusionShape('get_subgraph', dump)).not.toThrow();
    expect(() => assertConclusionShape('get_call_graph', dump)).not.toThrow();
  });

  it('passes a conclusion tool that returns a direct answer (path chain)', () => {
    const response = {
      paths: [{ chain: ['entry', 'mid', 'target'], hops: 2 }],
      reason: 'shortest reaching chain',
    };
    expect(() => assertConclusionShape('trace_execution_path', response)).not.toThrow();
  });

  it('passes a conclusion tool that returns a ranked list', () => {
    const response = { hubs: [{ name: 'validateDirectory', fanIn: 49 }] };
    expect(() => assertConclusionShape('get_critical_hubs', response)).not.toThrow();
  });

  it('passes a conclusion tool that returns a bare metric', () => {
    expect(() => assertConclusionShape('analyze_impact', { blastRadius: 12 })).not.toThrow();
  });

  it('passes an error/guidance response', () => {
    expect(() => assertConclusionShape('get_minimal_context', { error: 'No analysis found.' })).not.toThrow();
  });

  it('throws when a conclusion tool returns both top-level nodes[] and edges[]', () => {
    const dump = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] };
    expect(() => assertConclusionShape('get_minimal_context', dump)).toThrow(/nodes\[\] and edges\[\]/);
  });

  it('throws when a conclusion tool returns more than MAX_PROVENANCE_EDGES id-reference edges', () => {
    const edges = Array.from({ length: MAX_PROVENANCE_EDGES + 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
    expect(() => assertConclusionShape('analyze_impact', { trail: edges })).toThrow(/raw edge objects/);
  });

  it('allows bounded provenance up to MAX_PROVENANCE_EDGES id-reference edges', () => {
    const edges = Array.from({ length: MAX_PROVENANCE_EDGES }, (_, i) => ({ callerId: `n${i}`, calleeId: `n${i + 1}` }));
    expect(() => assertConclusionShape('analyze_impact', { provenance: edges })).not.toThrow();
  });

  it('does not flag a resolved {caller,callee} changelog (the structural_diff boundary)', () => {
    // Resolved name-pairs are self-describing conclusions, not a graph to join.
    const changelog = {
      edges: {
        added: Array.from({ length: 200 }, (_, i) => ({ caller: `f${i}`, callee: `g${i}`, file: 'x.ts' })),
        removed: [],
      },
    };
    expect(() => assertConclusionShape('structural_diff', changelog)).not.toThrow();
  });
});

// ============================================================================
// ConclusionShapeIsEnforcedAtDispatch (mcp-quality; change:
// enforce-conclusion-contract-runtime). The dispatch path runs the shape check on
// every live response: strict (throw) under the test/CI suite, advisory (log +
// disclose, still return) in production. These tests drive both modes via the
// OPENLORE_CONCLUSION_CONTRACT override.
// ============================================================================
describe('enforceConclusionContract (runtime, dispatch-path)', () => {
  const graphDump = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] };

  const withMode = (mode: 'strict' | 'advisory', fn: () => void) => {
    const prev = process.env.OPENLORE_CONCLUSION_CONTRACT;
    process.env.OPENLORE_CONCLUSION_CONTRACT = mode;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.OPENLORE_CONCLUSION_CONTRACT;
      else process.env.OPENLORE_CONCLUSION_CONTRACT = prev;
    }
  };

  it('the conclusion-shape-violation code is registered in the enforcement registry', () => {
    expect(isKnownFindingCode(CONCLUSION_SHAPE_VIOLATION_CODE)).toBe(true);
  });

  it('returns a well-shaped conclusion untouched in both modes', () => {
    const ok = { hubs: [{ name: 'validateDirectory', fanIn: 74 }] };
    withMode('strict', () => expect(enforceConclusionContract('get_critical_hubs', ok)).toBe(ok));
    withMode('advisory', () => expect(enforceConclusionContract('get_critical_hubs', ok)).toBe(ok));
  });

  it('leaves explicit-topology results untouched even when they are a graph dump', () => {
    withMode('strict', () => expect(enforceConclusionContract('get_subgraph', graphDump)).toBe(graphDump));
  });

  it('strict mode: a regressing conclusion handler throws (fails the suite)', () => {
    withMode('strict', () => {
      expect(() => enforceConclusionContract('get_minimal_context', graphDump)).toThrow(
        ToolContractViolationError,
      );
    });
  });

  it('advisory mode: the result is still returned, carrying the disclosure', () => {
    withMode('advisory', () => {
      const logged: string[] = [];
      const out = enforceConclusionContract('get_minimal_context', graphDump, m => logged.push(m)) as {
        nodes: unknown[];
        edges: unknown[];
        _governance: Array<{ code: string; subject: string }>;
      };
      // The computed result survives (dropping a working answer would harm the agent).
      expect(out.nodes).toEqual(graphDump.nodes);
      expect(out.edges).toEqual(graphDump.edges);
      // ...and it carries a conclusion-shape-violation finding naming the tool.
      expect(out._governance).toHaveLength(1);
      expect(out._governance[0].code).toBe(CONCLUSION_SHAPE_VIOLATION_CODE);
      expect(out._governance[0].subject).toBe('get_minimal_context');
      expect(logged).toHaveLength(1);
    });
  });

  it('advisory mode: bounded provenance passes untouched (no disclosure)', () => {
    withMode('advisory', () => {
      const edges = Array.from({ length: MAX_PROVENANCE_EDGES }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
      const ok = { blastRadius: 3, provenance: edges };
      expect(enforceConclusionContract('analyze_impact', ok)).toBe(ok);
    });
  });

  it('advisory mode: a bare array/primitive violation is wrapped, not dropped', () => {
    withMode('advisory', () => {
      const edgeDump = Array.from({ length: MAX_PROVENANCE_EDGES + 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
      const out = enforceConclusionContract('analyze_impact', edgeDump) as {
        result: unknown[];
        _governance: Array<{ code: string }>;
      };
      expect(out.result).toBe(edgeDump);
      expect(out._governance[0].code).toBe(CONCLUSION_SHAPE_VIOLATION_CODE);
    });
  });

  it('conclusionShapeFinding is a well-formed governance finding', () => {
    const f = conclusionShapeFinding('some_tool', 'returns a graph');
    expect(f.code).toBe(CONCLUSION_SHAPE_VIOLATION_CODE);
    expect(f.source).toBe('conclusion-contract');
    expect(f.subject).toBe('some_tool');
    expect(f.message).toContain('some_tool');
  });
});

// ============================================================================
// StandingInstructionsStayShort (cli spec, change: trim-standing-agent-instructions).
// Every tool description is paid on every session; none may pass 800 characters.
// ============================================================================
const MAX_TOOL_DESCRIPTION_CHARS = 800;

function descriptionsOverLimit(tools: ReadonlyArray<{ name: string; description: string }>): string[] {
  return tools
    .filter(t => t.description.length > MAX_TOOL_DESCRIPTION_CHARS)
    .map(t => `${t.name} (${t.description.length} chars)`);
}

describe('tool descriptions stay at most 800 characters', () => {
  it('no description in TOOL_DEFINITIONS passes the limit', () => {
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    expect(descriptionsOverLimit(TOOL_DEFINITIONS)).toEqual([]);
  });

  it('the guard names a tool whose description is one character too long', () => {
    const atLimit = { name: 'at_limit', description: 'x'.repeat(MAX_TOOL_DESCRIPTION_CHARS) };
    const over = { name: 'too_long', description: 'x'.repeat(MAX_TOOL_DESCRIPTION_CHARS + 1) };
    expect(descriptionsOverLimit([atLimit, over])).toEqual(['too_long (801 chars)']);
  });
});
