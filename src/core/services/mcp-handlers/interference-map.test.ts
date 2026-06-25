import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));
// resolveBaseRef + handleSpecStoreStatus are dynamically imported by the handler; stub
// them so the tests never shell out to git or read a real spec-store binding.
vi.mock('../../drift/git-diff.js', () => ({
  resolveBaseRef: vi.fn(async (_dir: string, ref: string) => (ref === 'auto' ? 'main' : ref)),
}));
vi.mock('./spec-store.js', () => ({ handleSpecStoreStatus: vi.fn() }));

import {
  computeInterferenceMap,
  parseUnifiedDiff,
  writeSetFromHunks,
  type InterferenceMap,
  type InFlightProviders,
  type RawChange,
  type BaseSymbol,
  type FileHunks,
} from './interference-map.js';
import { readCachedContext } from './utils.js';
import { handleSpecStoreStatus } from './spec-store.js';
import { assertConclusionShape, TOOL_OUTPUT_CLASS } from './tool-contract.js';
import { isKnownFindingCode, resolveEnforcementClass } from './enforcement-policy.js';
import type { FunctionNode, CallEdge, SerializedCallGraph } from '../../analyzer/call-graph.js';

// ---- graph fixtures (mirrors plan-parallel-work.test.ts) ----

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
  } as SerializedCallGraph;
}

function homeGraph(): SerializedCallGraph {
  return graph([
    node({ id: 'a.ts::foo', startLine: 1, endLine: 10 }),
    node({ id: 'reg.ts::REGISTRY', startLine: 10, endLine: 50 }),
    node({ id: 'shared.ts::shared', startLine: 1, endLine: 20 }),
    node({ id: 'cons.ts::consumer' }),
    node({ id: 'prod.ts::producer', fanIn: 1 }),
  ], [edge('cons.ts::consumer', 'prod.ts::producer')]);
}

const OPTS = { ambientFanInPercentile: 1.0 };

// ---- raw-change builders ----

function baseSym(id: string, startLine: number, endLine: number, stableId?: string): BaseSymbol {
  const [filePath, name] = id.split('::');
  return { id, name, filePath, startLine, endLine, ...(stableId ? { stableId } : {}) };
}
/** A modify hunk (carries deletions) over an old-line span. */
function modifyHunk(oldStart: number, oldCount = 1) {
  return { oldStart, oldCount, hasDeletions: true };
}
/** A pure-insertion hunk (no deletions) at an old-line position. */
function appendHunk(oldStart: number) {
  return { oldStart, oldCount: 0, hasDeletions: false };
}
function change(
  over: Partial<RawChange> & { ref: string; actor: string; repo: string; kind: RawChange['kind'] },
): RawChange {
  return { files: [], baseSymbolsByFile: new Map(), ...over };
}

/** Providers that return a fixed set of branches/PRs, never touching git/gh. */
function providers(opts: {
  branchesByRepo?: Record<string, RawChange[]>;
  prsByRepo?: Record<string, RawChange[]>;
  gh?: boolean;
}): InFlightProviders {
  return {
    enumerateBranches: async (_p, name) => opts.branchesByRepo?.[name] ?? [],
    enumeratePullRequests: async (_p, name) => opts.prsByRepo?.[name] ?? [],
    ghAvailable: async () => opts.gh ?? false,
  };
}

function mockHome(cg: SerializedCallGraph = homeGraph()) {
  vi.mocked(readCachedContext).mockResolvedValue({ callGraph: cg } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(handleSpecStoreStatus).mockResolvedValue({ bound: false } as never);
  mockHome();
});

function run(input: Parameters<typeof computeInterferenceMap>[0], prov: InFlightProviders) {
  return computeInterferenceMap({ ...OPTS, ...input }, prov) as Promise<InterferenceMap>;
}

// ====================================================================
// Pure cores: diff parsing + hunk → write-set
// ====================================================================

describe('parseUnifiedDiff', () => {
  it('parses hunks, deletion-nature, renames, and added/deleted files', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -5,3 +5,4 @@',
      ' ctx',
      '-old line',
      '+new line',
      '+added',
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+brand new',
      '+second',
      'diff --git a/old.ts b/renamed.ts',
      'rename from old.ts',
      'rename to renamed.ts',
    ].join('\n');
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(3);
    const a = files.find(f => f.path === 'a.ts')!;
    expect(a.status).toBe('modified');
    expect(a.hunks[0]).toMatchObject({ oldStart: 5, oldCount: 3, hasDeletions: true });
    const nu = files.find(f => f.path === 'new.ts')!;
    expect(nu.status).toBe('added');
    expect(nu.hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, hasDeletions: false });
    const rn = files.find(f => f.path === 'renamed.ts')!;
    expect(rn.status).toBe('renamed');
    expect(rn.oldPath).toBe('old.ts');
  });
});

describe('writeSetFromHunks', () => {
  const symbols = new Map<string, BaseSymbol[]>([
    ['reg.ts', [baseSym('reg.ts::REGISTRY', 10, 50)]],
    ['a.ts', [baseSym('a.ts::foo', 1, 10)]],
  ]);

  it('reads append vs modify off the diff (pure insertion → append, deletion → modify)', () => {
    const appendOnly: FileHunks[] = [{ path: 'reg.ts', status: 'modified', hunks: [appendHunk(30)] }];
    expect(writeSetFromHunks(appendOnly, symbols)).toEqual([
      { id: 'reg.ts::REGISTRY', name: 'REGISTRY', filePath: 'reg.ts', writeMode: 'append' },
    ]);
    const modified: FileHunks[] = [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(4, 2)] }];
    expect(writeSetFromHunks(modified, symbols)[0].writeMode).toBe('modify');
  });

  it('modify dominates append when a symbol has both hunk kinds', () => {
    const both: FileHunks[] = [{ path: 'a.ts', status: 'modified', hunks: [appendHunk(3), modifyHunk(6)] }];
    expect(writeSetFromHunks(both, symbols)[0].writeMode).toBe('modify');
  });

  it('a hunk touching no base symbol contributes nothing', () => {
    const outside: FileHunks[] = [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(100)] }];
    expect(writeSetFromHunks(outside, symbols)).toEqual([]);
  });
});

// ====================================================================
// Spec scenarios
// ====================================================================

describe('CrossActorInterferenceMap — scenarios', () => {
  it('Scenario: two branches sharing a written symbol report a WAW between actors', async () => {
    const branchX = change({
      ref: 'feat-x', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(4, 3)] }],
      baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::foo', 1, 10)]]]),
    });
    const branchY = change({
      ref: 'feat-y', actor: 'Bob', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(6, 2)] }],
      baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::foo', 1, 10)]]]),
    });
    const map = await run(
      { directory: '/p', includePullRequests: false },
      providers({ branchesByRepo: { 'this-repo': [branchX, branchY] } }),
    );
    expect(map.assessedCount).toBe(2);
    expect(map.conflicts).toHaveLength(1);
    expect(map.conflicts[0].hazard).toBe('WAW');
    expect(map.conflicts[0].witnesses).toContain('foo');
    expect(map.findingCount).toBe(1);
    expect(map.findings[0].code).toBe('cross-actor-conflict');
    expect(map.findings[0].subject).toContain('feat-x');
    expect(map.findings[0].subject).toContain('feat-y');
  });

  it('Scenario: an agent task and a human branch are compared uniformly (cross-actor WAW)', async () => {
    const branch = change({
      ref: 'feat-shared', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'shared.ts', status: 'modified', hunks: [modifyHunk(5, 3)] }],
      baseSymbolsByFile: new Map([['shared.ts', [baseSym('shared.ts::shared', 1, 20)]]]),
    });
    const map = await run(
      { directory: '/p', includePullRequests: false, tasks: [{ id: 'agent-task-1', seedSymbols: ['shared.ts::shared'] }] },
      providers({ branchesByRepo: { 'this-repo': [branch] } }),
    );
    const c = map.conflicts.find(x => x.hazard === 'WAW');
    expect(c).toBeDefined();
    const refs = [c!.a.ref, c!.b.ref].sort();
    expect(refs).toEqual(['agent-task-1', 'feat-shared']);
    // agent task and branch are the same KIND of node — both produce a write-write finding.
    expect(map.findings.some(f => f.subject.includes('agent-task-1'))).toBe(true);
  });

  it('Scenario: two PRs appending to the same registry do NOT falsely conflict (resolved-by-merge)', async () => {
    const pr1 = change({
      ref: 'PR #1', actor: 'Alice', repo: 'this-repo', kind: 'pull-request',
      files: [{ path: 'reg.ts', status: 'modified', hunks: [appendHunk(20)] }],
      baseSymbolsByFile: new Map([['reg.ts', [baseSym('reg.ts::REGISTRY', 10, 50)]]]),
    });
    const pr2 = change({
      ref: 'PR #2', actor: 'Bob', repo: 'this-repo', kind: 'pull-request',
      files: [{ path: 'reg.ts', status: 'modified', hunks: [appendHunk(40)] }],
      baseSymbolsByFile: new Map([['reg.ts', [baseSym('reg.ts::REGISTRY', 10, 50)]]]),
    });
    const map = await run(
      { directory: '/p', includeBranches: false },
      providers({ prsByRepo: { 'this-repo': [pr1, pr2] }, gh: true }),
    );
    expect(map.assessedCount).toBe(2);
    // shared-append, NOT WAW — no write-write finding emitted.
    expect(map.findingCount).toBe(0);
    expect(map.conflicts.every(c => c.hazard !== 'WAW')).toBe(true);
    expect(map.conflicts[0]?.hazard).toBe('shared-append');
  });

  it('Scenario: an unfetchable PR is labeled "not assessed", not cleared', async () => {
    const unfetchable = change({
      ref: 'PR #9', actor: 'Carol', repo: 'this-repo', kind: 'pull-request',
      fetchError: 'gh pr diff 9 failed',
    });
    const map = await run(
      { directory: '/p', includeBranches: false },
      providers({ prsByRepo: { 'this-repo': [unfetchable] }, gh: true }),
    );
    expect(map.assessedCount).toBe(0);
    expect(map.notAssessedCount).toBe(1);
    const n = map.changes.find(c => c.ref === 'PR #9')!;
    expect(n.assessed).toBe(false);
    expect(n.reason).toBe('diff-unfetchable');
  });

  it('a change whose symbols do not resolve is "not assessed", not "no conflict"', async () => {
    const docsOnly = change({
      ref: 'feat-docs', actor: 'Dan', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'README.md', status: 'modified', hunks: [modifyHunk(1, 4)] }],
      baseSymbolsByFile: new Map(), // nothing resolved
    });
    const map = await run(
      { directory: '/p', includePullRequests: false },
      providers({ branchesByRepo: { 'this-repo': [docsOnly] } }),
    );
    expect(map.notAssessedCount).toBe(1);
    expect(map.changes[0].reason).toBe('no-resolvable-symbols');
  });
});

// ====================================================================
// Federation
// ====================================================================

describe('CrossActorMapExtendsAcrossFederation', () => {
  it('Scenario: a branch in one repo conflicts with a PR in another via a shared stable id', async () => {
    const cgB = graph([node({ id: 'lib.ts::resolve', startLine: 1, endLine: 30, stableId: 'SID-resolve' })]);
    // home (A) graph: same federated symbol under a different path-based id but same stableId.
    const cgA = graph([node({ id: 'a.ts::resolve', startLine: 1, endLine: 30, stableId: 'SID-resolve' })]);
    vi.mocked(readCachedContext).mockImplementation(async (dir: string) =>
      (dir === '/repoB' ? { callGraph: cgB } : { callGraph: cgA }) as never);
    vi.mocked(handleSpecStoreStatus).mockResolvedValue({
      bound: true,
      targets: [{ name: 'B', resolved: true, state: 'indexed', path: '/repoB' }],
    } as never);

    const branchA = change({
      ref: 'feat-a', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(5, 3)] }],
      baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::resolve', 1, 30, 'SID-resolve')]]]),
    });
    const prB = change({
      ref: 'PR #7', actor: 'Bob', repo: 'B', kind: 'pull-request',
      files: [{ path: 'lib.ts', status: 'modified', hunks: [modifyHunk(5, 3)] }],
      baseSymbolsByFile: new Map([['lib.ts', [baseSym('lib.ts::resolve', 1, 30, 'SID-resolve')]]]),
    });
    const map = await run(
      { directory: '/p', federation: true },
      providers({ branchesByRepo: { 'this-repo': [branchA] }, prsByRepo: { B: [prB] }, gh: true }),
    );
    expect(map.repos).toEqual(['this-repo', 'B']);
    const cross = map.conflicts.find(c => c.crossRepo);
    expect(cross).toBeDefined();
    expect(cross!.hazard).toBe('WAW');
    expect(cross!.witnesses).toContain('resolve');
    expect(map.findings.some(f => f.message.includes('across repos'))).toBe(true);
  });

  it('Scenario: no federation degrades cleanly to single-repo', async () => {
    const branch = change({
      ref: 'feat-only', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(2, 3)] }],
      baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::foo', 1, 10)]]]),
    });
    const map = await run(
      { directory: '/p', includePullRequests: false }, // federation omitted
      providers({ branchesByRepo: { 'this-repo': [branch] } }),
    );
    expect(map.repos).toEqual(['this-repo']);
    expect(map.assessedCount).toBe(1);
    expect(handleSpecStoreStatus).not.toHaveBeenCalled();
  });

  it('a stale federated target index makes its changes "not assessed", never silently dropped', async () => {
    vi.mocked(handleSpecStoreStatus).mockResolvedValue({
      bound: true,
      targets: [{ name: 'B', resolved: true, state: 'stale', path: '/repoB' }],
    } as never);
    const map = await run(
      { directory: '/p', includeBranches: false, includePullRequests: false, federation: true },
      providers({}),
    );
    expect(map.repos).toEqual(['this-repo']); // B's index unusable → not assessed marker
    const marker = map.changes.find(c => c.repo === 'B');
    expect(marker?.reason).toBe('index-stale');
  });
});

// ====================================================================
// Contract, determinism, caveats
// ====================================================================

describe('contract + determinism', () => {
  it('is classified as a conclusion tool', () => {
    expect(TOOL_OUTPUT_CLASS.map_in_flight_conflicts).toBe('conclusion');
  });

  it('emits the registered, policy-governable cross-actor-conflict finding code', () => {
    expect(isKnownFindingCode('cross-actor-conflict')).toBe(true);
    expect(resolveEnforcementClass('cross-actor-conflict', { 'cross-actor-conflict': 'blocking' })).toBe('blocking');
    expect(resolveEnforcementClass('cross-actor-conflict', undefined)).toBe('advisory'); // advisory by default
  });

  it('passes the conclusion-over-graph shape contract and carries the ground-truth disclosure', async () => {
    const branchX = change({
      ref: 'feat-x', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(4, 3)] }],
      baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::foo', 1, 10)]]]),
    });
    const map = await run(
      { directory: '/p', includePullRequests: false },
      providers({ branchesByRepo: { 'this-repo': [branchX] } }),
    );
    expect(() => assertConclusionShape('map_in_flight_conflicts', map)).not.toThrow();
    expect(map.disclosure).toMatch(/ground truth/i);
    expect(map.posture).toBe('advisory');
  });

  it('is deterministic for a fixed input', async () => {
    const mk = () => [
      change({
        ref: 'feat-x', actor: 'Alice', repo: 'this-repo', kind: 'branch',
        files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(4, 3)] }],
        baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::foo', 1, 10)]]]),
      }),
      change({
        ref: 'feat-y', actor: 'Bob', repo: 'this-repo', kind: 'branch',
        files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(6, 2)] }],
        baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::foo', 1, 10)]]]),
      }),
    ];
    const a = await run({ directory: '/p', includePullRequests: false }, providers({ branchesByRepo: { 'this-repo': mk() } }));
    const b = await run({ directory: '/p', includePullRequests: false }, providers({ branchesByRepo: { 'this-repo': mk() } }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('caveats when gh is unavailable (PRs not enumerated), never a false "no PRs conflict"', async () => {
    const map = await run(
      { directory: '/p' },
      providers({ gh: false }), // gh absent
    );
    expect(map.caveats.some(c => /gh.*not available/i.test(c))).toBe(true);
  });

  it('returns an error when no analysis is cached', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null as never);
    const res = await computeInterferenceMap({ directory: '/p' }, providers({}));
    expect(res).toHaveProperty('error');
  });
});
