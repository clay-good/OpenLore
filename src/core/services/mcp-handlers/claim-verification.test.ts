/**
 * Structural claim verification (change: add-structural-claim-verification).
 *
 * Verdict logic over fixture call graphs (mocked readCachedContext) for every
 * claim kind, plus a real-edge-store test that the receipt's content hash equals
 * an independent hash of the cited span. Plain .test.ts so CI runs it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleVerifyClaim } from './claim-verification.js';
import { readCachedContext } from './utils.js';
import { __resetStalenessMemo } from './confidence-boundary.js';
import { EdgeStore } from '../edge-store.js';
import { hashSpan } from '../../decisions/anchor.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DECISIONS_SUBDIR, DECISIONS_PENDING_FILE } from '../../../constants.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';
import type { PendingDecision, DecisionStore } from '../../../types/index.js';

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id, filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 0, ...over,
  };
}
function edge(callerId: string, calleeId: string, over: Partial<CallEdge> = {}): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence: 'import', kind: 'calls', ...over };
}
function graph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return { nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 } };
}
function useGraph(nodes: FunctionNode[], edges: CallEdge[]): void {
  vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph(nodes, edges) } as never);
}

// Live chain: main (a root, main-like) → handler → helper. orphan is dead.
const MAIN = node({ id: 'src/main.ts::main', fanOut: 1 });
const HANDLER = node({ id: 'src/app.ts::handler', fanIn: 1, fanOut: 1 });
const HELPER = node({ id: 'src/app.ts::helper', fanIn: 1 });
const ORPHAN = node({ id: 'src/dead.ts::orphan' });
const LIVE_EDGES = [
  edge('src/main.ts::main', 'src/app.ts::handler'),
  edge('src/app.ts::handler', 'src/app.ts::helper'),
];

beforeEach(() => {
  __resetStalenessMemo();
  useGraph([MAIN, HANDLER, HELPER, ORPHAN], LIVE_EDGES);
});

describe('verify_claim — input validation', () => {
  it('rejects an unknown claim kind', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'whatever' as never, subject: 'main' }) as { error: string };
    expect(r.error).toMatch(/Unknown claim kind/);
  });
  it('requires an object for relational kinds', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'calls', subject: 'main' }) as { error: string };
    expect(r.error).toMatch(/provide an "object"/);
  });
  it('errors cleanly when no analysis is cached', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await handleVerifyClaim({ directory: '/p', kind: 'dead', subject: 'orphan' }) as { error: string };
    expect(r.error).toMatch(/analyze_codebase/);
  });
});

describe('verify_claim — unresolved / ambiguous symbols are unverifiable', () => {
  it('returns unverifiable when the subject is not in the graph', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'dead', subject: 'nonexistent' }) as { verdict: string; reason: string };
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toMatch(/not found/);
  });
  it('returns unverifiable when the subject name is ambiguous', async () => {
    useGraph([node({ id: 'a.ts::dup' }), node({ id: 'b.ts::dup' }), MAIN], []);
    const r = await handleVerifyClaim({ directory: '/p', kind: 'dead', subject: 'dup' }) as { verdict: string; reason: string };
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toMatch(/ambiguous/);
  });
});

describe('verify_claim — calls', () => {
  it('confirms a true direct calls claim', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'calls', subject: 'main', object: 'handler' }) as { verdict: string; reason: string };
    expect(r.verdict).toBe('confirmed');
    expect(r.reason).toMatch(/directly calls/);
  });
  it('refutes a false calls claim (transitive, not direct)', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'calls', subject: 'main', object: 'helper' }) as { verdict: string };
    expect(r.verdict).toBe('refuted');
  });
  it('confirms a synthesized-only calls claim but flags the dispatch boundary', async () => {
    useGraph([MAIN, HANDLER], [
      edge('src/main.ts::main', 'src/app.ts::handler', { confidence: 'synthesized', synthesizedBy: 'callback-registration' }),
    ]);
    const r = await handleVerifyClaim({ directory: '/p', kind: 'calls', subject: 'main', object: 'handler' }) as {
      verdict: string; confidenceBoundary: { complete: boolean; knownUnknowable?: Array<{ kind: string; rule?: string }> };
    };
    expect(r.verdict).toBe('confirmed');
    expect(r.confidenceBoundary.complete).toBe(false);
    expect(r.confidenceBoundary.knownUnknowable?.[0]).toMatchObject({ kind: 'synthesized-dispatch', rule: 'callback-registration' });
  });
});

describe('verify_claim — reaches', () => {
  it('confirms a transitive reach and reports the hop count', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'reaches', subject: 'main', object: 'helper' }) as { verdict: string; reason: string };
    expect(r.verdict).toBe('confirmed');
    expect(r.reason).toMatch(/transitively reaches.*2 hop/);
  });
  it('refutes an unreachable target', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'reaches', subject: 'helper', object: 'main' }) as { verdict: string };
    expect(r.verdict).toBe('refuted');
  });
});

describe('verify_claim — impacts', () => {
  it('confirms that changing a callee impacts its transitive caller', async () => {
    // helper is called (transitively) by main, so changing helper can impact main.
    const r = await handleVerifyClaim({ directory: '/p', kind: 'impacts', subject: 'helper', object: 'main' }) as { verdict: string; reason: string };
    expect(r.verdict).toBe('confirmed');
    expect(r.reason).toMatch(/can impact "main"/);
  });
  it('refutes impact when the object does not depend on the subject', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'impacts', subject: 'main', object: 'helper' }) as { verdict: string };
    expect(r.verdict).toBe('refuted');
  });
});

describe('verify_claim — dead', () => {
  it('confirms a truly unreachable symbol', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'dead', subject: 'orphan' }) as { verdict: string; reason: string };
    expect(r.verdict).toBe('confirmed');
    expect(r.reason).toMatch(/unreachable from every liveness root/);
  });
  it('refutes a symbol reached by direct edges', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'dead', subject: 'helper' }) as { verdict: string };
    expect(r.verdict).toBe('refuted');
  });
  it('returns unverifiable for a symbol reached only through synthesized dispatch', async () => {
    // ghost is reached from the live root main ONLY via a synthesized edge: dead
    // in the directly-resolved graph, live in the synthesized-inclusive graph.
    const ghost = node({ id: 'src/dyn.ts::ghost', fanIn: 1 });
    useGraph([MAIN, ghost], [
      edge('src/main.ts::main', 'src/dyn.ts::ghost', { confidence: 'synthesized', synthesizedBy: 'callback-registration' }),
    ]);
    const r = await handleVerifyClaim({ directory: '/p', kind: 'dead', subject: 'ghost' }) as {
      verdict: string; reason: string; confidenceBoundary: { complete: boolean; knownUnknowable?: Array<{ kind: string }> };
    };
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toMatch(/synthesized dynamic-dispatch/);
    expect(r.confidenceBoundary.complete).toBe(false);
    expect(r.confidenceBoundary.knownUnknowable?.[0]).toMatchObject({ kind: 'synthesized-dispatch' });
  });
});

describe('verify_claim — safe-to-change', () => {
  it('confirms a symbol with no internal callers is safe to change', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'safe-to-change', subject: 'orphan' }) as { verdict: string; reason: string };
    expect(r.verdict).toBe('confirmed');
    expect(r.reason).toMatch(/No internal caller depends/);
  });
  it('refutes when internal callers depend on the symbol', async () => {
    const r = await handleVerifyClaim({ directory: '/p', kind: 'safe-to-change', subject: 'helper' }) as { verdict: string; reason: string };
    expect(r.verdict).toBe('refuted');
    expect(r.reason).toMatch(/internal caller/);
  });
  it('returns unverifiable when the symbol is invoked via synthesized dispatch', async () => {
    const widget = node({ id: 'src/w.ts::widget', fanIn: 1 });
    useGraph([MAIN, widget], [
      edge('src/main.ts::main', 'src/w.ts::widget', { confidence: 'synthesized', synthesizedBy: 'route-handler' }),
    ]);
    const r = await handleVerifyClaim({ directory: '/p', kind: 'safe-to-change', subject: 'widget' }) as { verdict: string; reason: string };
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toMatch(/dynamic-dispatch/);
  });
});

// ── Receipt as citation (task 2): real edge store + source files ──────────────
describe('verify_claim — receipt is an auditable citation', () => {
  let root: string;
  const FOO_SRC = 'export function foo() {\n  return bar();\n}\n';
  const BAR_SRC = 'export function bar() {\n  return 1;\n}\n';

  function srcNode(filePath: string, src: string, name: string): FunctionNode {
    return {
      id: `${filePath}::${name}`, name, filePath, isAsync: false, language: 'TypeScript',
      startIndex: 0, endIndex: Buffer.byteLength(src, 'utf-8'),
      startLine: 1, endLine: src.split('\n').length, fanIn: 0, fanOut: 0,
    };
  }
  const fooNode = () => srcNode('src/foo.ts', FOO_SRC, 'foo');
  const barNode = () => srcNode('src/bar.ts', BAR_SRC, 'bar');

  beforeEach(async () => {
    __resetStalenessMemo();
    root = await mkdtemp(join(tmpdir(), 'openlore-claim-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'foo.ts'), FOO_SRC, 'utf-8');
    await writeFile(join(root, 'src', 'bar.ts'), BAR_SRC, 'utf-8');
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const store = EdgeStore.open(EdgeStore.dbPath(dir));
    store.clearAll();
    store.insertNodes([fooNode(), barNode()]);
    store.close();
    // The fixture call graph the handler reasons over: foo directly calls bar.
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: graph([fooNode(), barNode()], [edge('src/foo.ts::foo', 'src/bar.ts::bar')]),
    } as never);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('attaches a receipt whose content hash matches an independent hash of the cited span', async () => {
    const r = await handleVerifyClaim({ directory: root, kind: 'calls', subject: 'foo', object: 'bar' }) as {
      verdict: string;
      receipt?: { subject: { contentHash: string; symbol?: string; lineSpan?: { start: number; end: number } }; object?: { contentHash: string } };
    };
    expect(r.verdict).toBe('confirmed');
    expect(r.receipt).toBeDefined();
    // The receipt's subject hash equals an independent hash of foo's source span.
    expect(r.receipt!.subject.symbol).toBe('foo');
    expect(r.receipt!.subject.contentHash).toBe(hashSpan(FOO_SRC));
    // And the object certificate cites bar's span.
    expect(r.receipt!.object?.contentHash).toBe(hashSpan(BAR_SRC));
  });
});

// ── decision-current: verdicts over the recorded decision store ───────────────
describe('verify_claim — decision-current', () => {
  let root: string;

  function decision(over: Partial<PendingDecision> & { id: string }): PendingDecision {
    return {
      status: 'approved', title: `decision ${over.id}`, rationale: 'r', consequences: 'c',
      proposedRequirement: null, affectedDomains: [], affectedFiles: [], syncedToSpecs: [],
      sessionId: 's', recordedAt: '2026-06-01T00:00:00Z', contentOrigin: 'agent-recorded', confidence: 'high', ...over,
    };
  }
  async function writeStore(decisions: PendingDecision[]): Promise<void> {
    const dir = join(root, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const store: DecisionStore = { version: '1', sessionId: 's', updatedAt: '2026-06-01T00:00:00Z', decisions };
    await writeFile(join(dir, DECISIONS_PENDING_FILE), JSON.stringify(store, null, 2) + '\n', 'utf-8');
  }

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'openlore-claim-dec-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('confirms a recorded decision that is neither superseded nor rejected', async () => {
    await writeStore([decision({ id: 'a1b2c3d4', title: 'Use JWTs', status: 'approved' })]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'a1b2c3d4' }) as {
      verdict: string; reason: string; receipt?: { decision: { id: string; status: string } };
    };
    expect(r.verdict).toBe('confirmed');
    expect(r.reason).toMatch(/is recorded with status "approved"/);
    expect(r.receipt?.decision.id).toBe('a1b2c3d4');
  });

  it('refutes a superseded decision and names the live superseder', async () => {
    await writeStore([
      decision({ id: 'a1b2c3d4', title: 'Old approach' }),
      decision({ id: 'b2c3d4e5', title: 'New approach', supersedes: 'a1b2c3d4' }),
    ]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'a1b2c3d4' }) as {
      verdict: string; reason: string; receipt?: { decision: { supersededBy?: string } };
    };
    expect(r.verdict).toBe('refuted');
    expect(r.reason).toMatch(/superseded by b2c3d4e5/);
    expect(r.reason).toMatch(/cite b2c3d4e5 instead/);
    expect(r.receipt?.decision.supersededBy).toBe('b2c3d4e5');
  });

  it('follows a supersession chain to the live terminal superseder', async () => {
    await writeStore([
      decision({ id: 'aaaaaaaa', title: 'v1' }),
      decision({ id: 'bbbbbbbb', title: 'v2', supersedes: 'aaaaaaaa' }),
      decision({ id: 'cccccccc', title: 'v3', supersedes: 'bbbbbbbb' }),
    ]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'aaaaaaaa' }) as {
      verdict: string; reason: string;
    };
    expect(r.verdict).toBe('refuted');
    expect(r.reason).toMatch(/cite cccccccc instead/);
  });

  it('is unverifiable when the decision belongs to a supersession cycle', async () => {
    await writeStore([
      decision({ id: 'aaaaaaaa', title: 'Approach A', supersedes: 'bbbbbbbb' }),
      decision({ id: 'bbbbbbbb', title: 'Approach B', supersedes: 'aaaaaaaa' }),
    ]);
    for (const subject of ['aaaaaaaa', 'bbbbbbbb']) {
      const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject }) as {
        verdict: string; reason: string; receipt?: unknown;
      };
      expect(r.verdict).toBe('unverifiable');
      expect(r.reason).toMatch(/supersession cycle.*aaaaaaaa.*bbbbbbbb/i);
      expect(r.receipt).toBeUndefined();
    }
  });

  it('refutes a rejected decision', async () => {
    await writeStore([decision({ id: 'deadbeef', title: 'Rejected idea', status: 'rejected' })]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'deadbeef' }) as {
      verdict: string; reason: string;
    };
    expect(r.verdict).toBe('refuted');
    expect(r.reason).toMatch(/was rejected/);
  });

  it('is unverifiable for a well-formed id with no recorded decision', async () => {
    await writeStore([decision({ id: 'a1b2c3d4' })]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'ffffffff' }) as {
      verdict: string; reason: string;
    };
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toMatch(/No decision "ffffffff" is recorded/);
  });

  it('is unverifiable when no decision store exists at all', async () => {
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'a1b2c3d4' }) as {
      verdict: string; reason: string;
    };
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toMatch(/No decision/);
  });

  it('is unverifiable for a malformed (non-8-hex) id', async () => {
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'Use JWTs' }) as {
      verdict: string; reason: string;
    };
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toMatch(/is not a decision id/);
  });

  it('accepts an uppercase id by normalizing to lowercase', async () => {
    await writeStore([decision({ id: 'a1b2c3d4', title: 'Use JWTs' })]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'A1B2C3D4' }) as {
      verdict: string;
    };
    expect(r.verdict).toBe('confirmed');
  });

  // A DECLINED supersession (the superseder was rejected) leaves the original standing —
  // it must agree with isEffectiveSuperseder / the stale-decision-reference finding, which
  // exclude rejected/phantom superseders. (regression: shared retirement semantics)
  it('confirms the target when its only superseder was rejected (declined supersession)', async () => {
    await writeStore([
      decision({ id: 'a1b2c3d4', title: 'Standing approach' }),
      decision({ id: 'b2c3d4e5', title: 'Declined replacement', status: 'rejected', supersedes: 'a1b2c3d4' }),
    ]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'a1b2c3d4' }) as {
      verdict: string;
    };
    expect(r.verdict).toBe('confirmed');
  });

  it('confirms the target when its only superseder is a phantom', async () => {
    await writeStore([
      decision({ id: 'a1b2c3d4', title: 'Standing approach' }),
      decision({ id: 'b2c3d4e5', title: 'Phantom replacement', status: 'phantom', supersedes: 'a1b2c3d4' }),
    ]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'a1b2c3d4' }) as {
      verdict: string;
    };
    expect(r.verdict).toBe('confirmed');
  });

  // A decision that names its own id as `supersedes` retires nothing and must not refute itself.
  it('does not refute a decision that supersedes itself', async () => {
    await writeStore([decision({ id: 'a1b2c3d4', title: 'Self-referential', supersedes: 'a1b2c3d4' })]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'a1b2c3d4' }) as {
      verdict: string;
    };
    expect(r.verdict).toBe('confirmed');
  });

  // Two decisions superseding one target — the named superseder is deterministic
  // (lexicographically smallest id), regardless of store order.
  it('names a deterministic superseder when a target has multiple superseders', async () => {
    await writeStore([
      decision({ id: 'a1b2c3d4', title: 'Original' }),
      decision({ id: 'ffffffff', title: 'Late superseder', supersedes: 'a1b2c3d4' }),
      decision({ id: '11111111', title: 'Early superseder', supersedes: 'a1b2c3d4' }),
    ]);
    const r = await handleVerifyClaim({ directory: root, kind: 'decision-current', subject: 'a1b2c3d4' }) as {
      verdict: string; reason: string; receipt?: { decision: { supersededBy?: string } };
    };
    expect(r.verdict).toBe('refuted');
    expect(r.receipt?.decision.supersededBy).toBe('11111111');
    expect(r.reason).toMatch(/cite 11111111 instead/);
  });
});

// ---------------------------------------------------------------------------
// Dynamic-boundary cap (change: disclose-dynamic-boundary-regions)
// ---------------------------------------------------------------------------

describe('verify_claim — a negative verdict is capped at a dynamic boundary', () => {
  let root: string;

  /** Write a dynamic-boundary artifact into a real temp repo the handler will read. */
  async function withSites(files: Array<{ filePath: string; language: string; kind: string; line: number }>) {
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'dynamic-boundary.json'), JSON.stringify({
      version: 1,
      totalSites: files.length,
      totalFiles: files.length,
      byKind: [],
      byLanguage: [],
      files: files.map(f => ({
        filePath: f.filePath,
        language: f.language,
        sites: [{ line: f.line, kind: f.kind, refusal: 'no-static-target', evidence: 'obj[name]()', moduleLevel: true }],
      })),
    }));
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-claim-dyn-'));
    __resetStalenessMemo();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('caps a confirmed "dead" at unverifiable and names the site', async () => {
    useGraph([MAIN, ORPHAN], []);
    await withSites([{ filePath: 'src/dead.ts', language: 'TypeScript', kind: 'computed-member', line: 17 }]);
    const r = await handleVerifyClaim({ directory: root, kind: 'dead', subject: 'orphan' }) as {
      verdict: string; reason: string; receipt?: unknown;
      confidenceBoundary: { knownUnknowable?: Array<{ kind: string; sites?: Array<{ file: string; line: number }> }> };
    };
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toContain('src/dead.ts:17');
    const crossing = r.confidenceBoundary.knownUnknowable?.find(c => c.kind === 'dynamic-boundary');
    expect(crossing?.sites).toEqual([{ file: 'src/dead.ts', line: 17, kind: 'computed-member' }]);
    // The shipped invariant holds: no receipt is minted for an unverifiable verdict.
    expect(r.receipt).toBeUndefined();
  });

  it('caps a confirmed "safe-to-change" the same way', async () => {
    useGraph([MAIN, ORPHAN], []);
    await withSites([{ filePath: 'src/dead.ts', language: 'TypeScript', kind: 'reflective-invoke', line: 3 }]);
    const r = await handleVerifyClaim({ directory: root, kind: 'safe-to-change', subject: 'orphan' }) as
      { verdict: string; reason: string };
    expect(r.verdict).toBe('unverifiable');
    expect(r.reason).toContain('src/dead.ts:3');
  });

  it('does NOT touch a refuted verdict — a boundary can only reinforce a positive claim', async () => {
    useGraph([MAIN, HANDLER, HELPER], LIVE_EDGES);
    await withSites([{ filePath: 'src/app.ts', language: 'TypeScript', kind: 'reflective-invoke', line: 2 }]);
    const r = await handleVerifyClaim({ directory: root, kind: 'dead', subject: 'helper' }) as { verdict: string };
    expect(r.verdict).toBe('refuted');
  });

  it('a site that cannot name the subject leaves the verdict confirmed', async () => {
    useGraph([MAIN, ORPHAN], []);
    // A site in an unrelated module, with no dependency graph, so the closure is that file alone.
    await withSites([{ filePath: 'src/elsewhere.ts', language: 'TypeScript', kind: 'reflective-invoke', line: 1 }]);
    const r = await handleVerifyClaim({ directory: root, kind: 'dead', subject: 'orphan' }) as { verdict: string };
    expect(r.verdict).toBe('confirmed');
  });

  it('a repository with no sites is unaffected', async () => {
    useGraph([MAIN, ORPHAN], []);
    const r = await handleVerifyClaim({ directory: root, kind: 'dead', subject: 'orphan' }) as { verdict: string };
    expect(r.verdict).toBe('confirmed');
  });

  it('two crossings both survive — neither silently overwrites the other', async () => {
    // `orphan` is reachable ONLY through a synthesized edge (already unverifiable), AND sits next to
    // a dynamic-boundary site. The receipt must carry both reasons, not the last one written.
    useGraph([MAIN, ORPHAN], [
      edge('src/main.ts::main', 'src/dead.ts::orphan', { confidence: 'synthesized', synthesizedBy: 'event-channel' }),
    ]);
    await withSites([{ filePath: 'src/dead.ts', language: 'TypeScript', kind: 'reflective-invoke', line: 8 }]);
    const r = await handleVerifyClaim({ directory: root, kind: 'safe-to-change', subject: 'orphan' }) as {
      verdict: string;
      confidenceBoundary: { knownUnknowable?: Array<{ kind: string }> };
    };
    expect(r.verdict).toBe('unverifiable');
    const kinds = (r.confidenceBoundary.knownUnknowable ?? []).map(c => c.kind).sort();
    expect(kinds).toContain('synthesized-dispatch');
    expect(kinds).toContain('dynamic-boundary');
  });
});
