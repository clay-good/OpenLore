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

  it('an empty repo (no branches/PRs/tasks) returns a clean empty map', async () => {
    const map = await run({ directory: '/p', includePullRequests: false }, providers({}));
    expect(map.assessedCount).toBe(0);
    expect(map.conflicts).toEqual([]);
    expect(map.headline).toMatch(/No in-flight changes assessed/);
  });
});

// ====================================================================
// Adversarial regression set (bug fixes from PR #202 review)
// ====================================================================

describe('adversarial — diff parsing', () => {
  // C1 (critical): a deleted line whose CONTENT starts with dashes (SQL `-- comment`,
  // a Markdown `---` rule, a row of `------`) must still count as a deletion. The old
  // `!startsWith('---')` guard silently downgraded a real WAW to a "safe" shared-append.
  it('classifies a deleted dash-leading line as a deletion, not an append', () => {
    const patch = [
      'diff --git a/q.sql b/q.sql',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -3,1 +3,1 @@',
      '--- old SQL comment',   // a deleted line whose content is "-- old SQL comment"
      '+-- new SQL comment',
    ].join('\n');
    const files = parseUnifiedDiff(patch);
    expect(files[0].hunks[0].hasDeletions).toBe(true);
  });

  it('a deleted row of dashes and a deleted markdown rule both count as deletions', () => {
    const patch = [
      'diff --git a/r.md b/r.md',
      '--- a/r.md',
      '+++ b/r.md',
      '@@ -1,2 +1,1 @@',
      '------',   // deleting a line of dashes
      '----',     // deleting a markdown-ish rule
      '+kept',
    ].join('\n');
    expect(parseUnifiedDiff(patch)[0].hunks[0].hasDeletions).toBe(true);
  });

  it('an added line whose content starts with +++ is not mistaken for a file header', () => {
    const patch = [
      'diff --git a/c.cpp b/c.cpp',
      '--- a/c.cpp',
      '+++ b/c.cpp',
      '@@ -5,0 +6,1 @@',
      '+++counter; // pure insertion',
    ].join('\n');
    const f = parseUnifiedDiff(patch)[0];
    expect(f.path).toBe('c.cpp');               // path not corrupted by the body line
    expect(f.hunks[0].hasDeletions).toBe(false); // pure insertion → append
  });

  it('a dash-deleted symbol makes two changes WAW (must serialize), not shared-append', () => {
    const symbols = new Map<string, BaseSymbol[]>([['q.sql', [baseSym('q.sql::query', 1, 20)]]]);
    const patch = [
      'diff --git a/q.sql b/q.sql', '--- a/q.sql', '+++ b/q.sql',
      '@@ -5,1 +5,1 @@', '--- old', '+-- new',
    ].join('\n');
    const ws = writeSetFromHunks(parseUnifiedDiff(patch), symbols);
    expect(ws[0].writeMode).toBe('modify');
  });
});

describe('adversarial — nested symbols (m6)', () => {
  it('attributes an edit inside a nested function to the innermost symbol only', () => {
    const symbols = new Map<string, BaseSymbol[]>([
      ['n.ts', [baseSym('n.ts::outer', 1, 30), baseSym('n.ts::inner', 10, 15)]],
    ]);
    const hunk: FileHunks[] = [{ path: 'n.ts', status: 'modified', hunks: [modifyHunk(12, 1)] }];
    const ws = writeSetFromHunks(hunk, symbols);
    expect(ws.map(w => w.id)).toEqual(['n.ts::inner']); // NOT also outer → no spurious WAW
  });

  it('a hunk spanning two symbols still attributes to both (genuine breadth)', () => {
    const symbols = new Map<string, BaseSymbol[]>([
      ['n.ts', [baseSym('n.ts::f1', 1, 10), baseSym('n.ts::f2', 11, 20)]],
    ]);
    const hunk: FileHunks[] = [{ path: 'n.ts', status: 'modified', hunks: [modifyHunk(8, 6)] }];
    expect(writeSetFromHunks(hunk, symbols).map(w => w.id).sort()).toEqual(['n.ts::f1', 'n.ts::f2']);
  });
});

describe('adversarial — hazard classes beyond WAW', () => {
  it('reports RAW with a direction when one change writes what another reads', async () => {
    // home graph: cons.ts::consumer → prod.ts::producer (a call edge = a read seam).
    const writeProducer = change({
      ref: 'feat-producer', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'prod.ts', status: 'modified', hunks: [modifyHunk(2, 3)] }],
      baseSymbolsByFile: new Map([['prod.ts', [baseSym('prod.ts::producer', 1, 10)]]]),
    });
    const writeConsumer = change({
      ref: 'feat-consumer', actor: 'Bob', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'cons.ts', status: 'modified', hunks: [modifyHunk(2, 3)] }],
      baseSymbolsByFile: new Map([['cons.ts', [baseSym('cons.ts::consumer', 1, 10)]]]),
    });
    const map = await run(
      { directory: '/p', includePullRequests: false },
      providers({ branchesByRepo: { 'this-repo': [writeProducer, writeConsumer] } }),
    );
    const raw = map.conflicts.find(c => c.hazard === 'RAW');
    expect(raw).toBeDefined();
    expect(raw!.direction).toBeDefined();
    expect(raw!.suggestion).toMatch(/before/);
    // RAW is an ordering hazard, not a hard conflict → no WAW finding.
    expect(map.findingCount).toBe(0);
  });

  it('reports WAR (low risk) for disjoint symbols in the same file — no WAW finding', async () => {
    const a = change({
      ref: 'feat-f1', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'multi.ts', status: 'modified', hunks: [modifyHunk(2, 3)] }],
      baseSymbolsByFile: new Map([['multi.ts', [baseSym('multi.ts::f1', 1, 10)]]]),
    });
    const b = change({
      ref: 'feat-f2', actor: 'Bob', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'multi.ts', status: 'modified', hunks: [modifyHunk(13, 3)] }],
      baseSymbolsByFile: new Map([['multi.ts', [baseSym('multi.ts::f2', 11, 20)]]]),
    });
    const map = await run(
      { directory: '/p', includePullRequests: false },
      providers({ branchesByRepo: { 'this-repo': [a, b] } }),
    );
    expect(map.conflicts[0]?.hazard).toBe('WAR');
    expect(map.findingCount).toBe(0);
  });

  it('reports soft-coupling when write-set files co-change with no call edge', async () => {
    const cg = graph([node({ id: 'x.ts::fx' }), node({ id: 'y.ts::fy' })]);
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: cg,
      edgeStore: { getChangeCouplingForFiles: (files: string[]) =>
        files.includes('x.ts') ? [{ filePath: 'x.ts', churn: 9, coupledWith: [{ file: 'y.ts', support: 5, confidence: 0.8 }] }] : [] },
    } as never);
    const a = change({
      ref: 'feat-x', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'x.ts', status: 'modified', hunks: [modifyHunk(2, 2)] }],
      baseSymbolsByFile: new Map([['x.ts', [baseSym('x.ts::fx', 1, 10)]]]),
    });
    const b = change({
      ref: 'feat-y', actor: 'Bob', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'y.ts', status: 'modified', hunks: [modifyHunk(2, 2)] }],
      baseSymbolsByFile: new Map([['y.ts', [baseSym('y.ts::fy', 1, 10)]]]),
    });
    const map = await run(
      { directory: '/p', includePullRequests: false },
      providers({ branchesByRepo: { 'this-repo': [a, b] } }),
    );
    expect(map.conflicts[0]?.hazard).toBe('soft-coupling');
  });
});

describe('adversarial — caps, honesty, cross-repo file paths', () => {
  it('labels (does not silently drop) changes beyond the maxChanges cap', async () => {
    const mk = (ref: string) => change({
      ref, actor: 'X', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(4, 2)] }],
      baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::foo', 1, 10)]]]),
    });
    const map = await run(
      { directory: '/p', includePullRequests: false, maxChanges: 1 },
      providers({ branchesByRepo: { 'this-repo': [mk('b1'), mk('b2'), mk('b3')] } }),
    );
    expect(map.assessedCount + map.notAssessedCount).toBe(1);
    expect(map.caveats.some(c => /capped at 1/.test(c))).toBe(true);
  });

  it('truncates the evidence lists with authoritative uncapped counts on a huge map', async () => {
    // 22 branches all modifying foo → 231 WAW pairs > the 200 conflict / 100 finding caps.
    const many = Array.from({ length: 22 }, (_, i) => change({
      ref: `b${String(i).padStart(2, '0')}`, actor: 'X', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(4, 2)] }],
      baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::foo', 1, 10)]]]),
    }));
    const map = await run(
      { directory: '/p', includePullRequests: false, maxChanges: 40 },
      providers({ branchesByRepo: { 'this-repo': many } }),
    );
    expect(map.conflictCount).toBe(231);          // authoritative, uncapped
    expect(map.conflicts.length).toBeLessThanOrEqual(200);
    expect(map.conflictsTruncated).toBe(true);
    expect(map.findingsTruncated).toBe(true);
  });

  it('does NOT raise a cross-repo WAR for two repos sharing a relative file path', async () => {
    // Same relative path src/index.ts in both repos, disjoint symbols, no shared stable id.
    const cgA = graph([node({ id: 'src/index.ts::a', startLine: 1, endLine: 10, stableId: 'SID-a' })]);
    const cgB = graph([node({ id: 'src/index.ts::b', startLine: 1, endLine: 10, stableId: 'SID-b' })]);
    vi.mocked(readCachedContext).mockImplementation(async (dir: string) =>
      (dir === '/repoB' ? { callGraph: cgB } : { callGraph: cgA }) as never);
    vi.mocked(handleSpecStoreStatus).mockResolvedValue({
      bound: true, targets: [{ name: 'B', resolved: true, state: 'indexed', path: '/repoB' }],
    } as never);
    const branchA = change({
      ref: 'feat-a', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'src/index.ts', status: 'modified', hunks: [modifyHunk(2, 2)] }],
      baseSymbolsByFile: new Map([['src/index.ts', [baseSym('src/index.ts::a', 1, 10, 'SID-a')]]]),
    });
    const prB = change({
      ref: 'PR #5', actor: 'Bob', repo: 'B', kind: 'pull-request',
      files: [{ path: 'src/index.ts', status: 'modified', hunks: [modifyHunk(2, 2)] }],
      baseSymbolsByFile: new Map([['src/index.ts', [baseSym('src/index.ts::b', 1, 10, 'SID-b')]]]),
    });
    const map = await run(
      { directory: '/p', federation: true },
      providers({ branchesByRepo: { 'this-repo': [branchA] }, prsByRepo: { B: [prB] }, gh: true }),
    );
    // Different stable ids + namespaced file paths → no cross-repo conflict at all.
    expect(map.conflicts.filter(c => c.crossRepo)).toEqual([]);
  });

  it('discloses the signature-shape homonym risk on any cross-repo conflict', async () => {
    const cgA = graph([node({ id: 'a.ts::run', startLine: 1, endLine: 10, stableId: 'SID-run' })]);
    const cgB = graph([node({ id: 'b.ts::run', startLine: 1, endLine: 10, stableId: 'SID-run' })]);
    vi.mocked(readCachedContext).mockImplementation(async (dir: string) =>
      (dir === '/repoB' ? { callGraph: cgB } : { callGraph: cgA }) as never);
    vi.mocked(handleSpecStoreStatus).mockResolvedValue({
      bound: true, targets: [{ name: 'B', resolved: true, state: 'indexed', path: '/repoB' }],
    } as never);
    const branchA = change({
      ref: 'feat-a', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(2, 2)] }],
      baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::run', 1, 10, 'SID-run')]]]),
    });
    const prB = change({
      ref: 'PR #6', actor: 'Bob', repo: 'B', kind: 'pull-request',
      files: [{ path: 'b.ts', status: 'modified', hunks: [modifyHunk(2, 2)] }],
      baseSymbolsByFile: new Map([['b.ts', [baseSym('b.ts::run', 1, 10, 'SID-run')]]]),
    });
    const map = await run(
      { directory: '/p', federation: true },
      providers({ branchesByRepo: { 'this-repo': [branchA] }, prsByRepo: { B: [prB] }, gh: true }),
    );
    expect(map.conflicts.some(c => c.crossRepo && c.hazard === 'WAW')).toBe(true);
    expect(map.caveats.some(c => /homonym|name and arity|signature/i.test(c))).toBe(true);
  });

  it('caveats (degrades to this-repo) when federation is requested but unbound', async () => {
    vi.mocked(handleSpecStoreStatus).mockResolvedValue({ bound: false } as never);
    const map = await run(
      { directory: '/p', includeBranches: false, includePullRequests: false, federation: true },
      providers({}),
    );
    expect(map.repos).toEqual(['this-repo']);
    expect(map.caveats.some(c => /no resolvable spec-store targets/i.test(c))).toBe(true);
  });
});

// ====================================================================
// Round-2 adversarial regression set (real-git e2e review of PR #202)
// ====================================================================

describe('round-2 — rename keeps base identity (FINDING 1: no false no-conflict)', () => {
  // A renamed+edited symbol must conflict with an in-place edit of the same function.
  // buildBaseSymbols parses base content under the OLD path, so a renamed file's symbol
  // id is its base identity (`old/path::name`) — the same id the in-place editor sees.
  it('a renamed+edited function conflicts (WAW) with an in-place edit of the same function', async () => {
    const renamed = change({
      ref: 'feat-rename', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      // git status renamed; the diff hunks are keyed by the NEW path, but the base
      // symbols carry the OLD-path id (what buildBaseSymbols now produces).
      files: [{ path: 'new.ts', status: 'renamed', oldPath: 'old.ts', hunks: [modifyHunk(5, 3)] }],
      baseSymbolsByFile: new Map([['new.ts', [baseSym('old.ts::compute', 1, 10)]]]),
    });
    const inPlace = change({
      ref: 'feat-edit', actor: 'Bob', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'old.ts', status: 'modified', hunks: [modifyHunk(6, 2)] }],
      baseSymbolsByFile: new Map([['old.ts', [baseSym('old.ts::compute', 1, 10)]]]),
    });
    const map = await run(
      { directory: '/p', includePullRequests: false },
      providers({ branchesByRepo: { 'this-repo': [renamed, inPlace] } }),
    );
    expect(map.conflicts.some(c => c.hazard === 'WAW' && c.witnesses.includes('compute'))).toBe(true);
    expect(map.findingCount).toBe(1);
  });

  it('writeSetFromHunks keys a renamed file by its new path but attributes base-identity ids', () => {
    const files: FileHunks[] = [{ path: 'new.ts', status: 'renamed', oldPath: 'old.ts', hunks: [modifyHunk(5, 3)] }];
    const base = new Map<string, BaseSymbol[]>([['new.ts', [baseSym('old.ts::compute', 1, 10)]]]);
    expect(writeSetFromHunks(files, base).map(w => w.id)).toEqual(['old.ts::compute']);
  });
});

describe('round-2 — module-scope registry (M-B: file-scope fallback)', () => {
  it('attributes a module-scope APPEND (no function node) to a file-scope member', () => {
    // A parsed code file with no function symbols ([]); a top-level registry append.
    const files: FileHunks[] = [{ path: 'reg.ts', status: 'modified', hunks: [appendHunk(5)] }];
    const base = new Map<string, BaseSymbol[]>([['reg.ts', []]]);
    const ws = writeSetFromHunks(files, base);
    expect(ws).toEqual([{ id: 'reg.ts', name: 'reg.ts', filePath: 'reg.ts', writeMode: 'append' }]);
  });

  it('two PRs appending to the same module-scope registry array resolve to shared-append (not WAW)', async () => {
    const mk = (ref: string) => change({
      ref, actor: ref, repo: 'this-repo', kind: 'pull-request',
      files: [{ path: 'reg.ts', status: 'modified', hunks: [appendHunk(5)] }],
      baseSymbolsByFile: new Map([['reg.ts', []]]), // parsed code, zero function symbols
    });
    const map = await run(
      { directory: '/p', includeBranches: false },
      providers({ prsByRepo: { 'this-repo': [mk('PR #1'), mk('PR #2')] }, gh: true }),
    );
    expect(map.conflicts[0]?.hazard).toBe('shared-append');
    expect(map.findingCount).toBe(0);
  });

  it('does NOT create a file-scope member for a module-scope MODIFY (avoids over-coupling false WAW)', () => {
    const files: FileHunks[] = [{ path: 'reg.ts', status: 'modified', hunks: [modifyHunk(5, 2)] }];
    const base = new Map<string, BaseSymbol[]>([['reg.ts', []]]);
    expect(writeSetFromHunks(files, base)).toEqual([]);
  });

  it('a non-code file (absent from the map) still contributes nothing', () => {
    const files: FileHunks[] = [{ path: 'README.md', status: 'modified', hunks: [appendHunk(5)] }];
    expect(writeSetFromHunks(files, new Map())).toEqual([]);
  });
});

describe('round-2 — CRLF parsing (C1) + honest caveats (M-A, FINDING 2)', () => {
  it('parses CRLF-terminated structural lines without corrupting the path', () => {
    const patch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -5,1 +5,1 @@', '-old', '+new']
      .map(l => l + '\r').join('\n'); // CRLF on every line
    const files = parseUnifiedDiff(patch);
    expect(files[0].path).toBe('a.ts');            // no trailing \r, no "a/.. b/.." corruption
    expect(files[0].hunks[0].hasDeletions).toBe(true);
  });

  it('a CRLF binary/rename header with no +++ rescue line keeps a clean path', () => {
    const patch = ['diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ']
      .map(l => l + '\r').join('\n');
    expect(parseUnifiedDiff(patch)[0].path).toBe('img.png');
  });

  it('caveats a partial base read (unreadable file) but still assesses the rest', async () => {
    const c = change({
      ref: 'feat-partial', actor: 'Alice', repo: 'this-repo', kind: 'branch',
      files: [{ path: 'a.ts', status: 'modified', hunks: [modifyHunk(4, 2)] }],
      baseSymbolsByFile: new Map([['a.ts', [baseSym('a.ts::foo', 1, 10)]]]),
      unreadableFiles: ['b.ts'],
    });
    const map = await run(
      { directory: '/p', includePullRequests: false },
      providers({ branchesByRepo: { 'this-repo': [c] } }),
    );
    expect(map.assessedCount).toBe(1); // still assessed on a.ts
    expect(map.caveats.some(cv => /could not be read/i.test(cv) && /b\.ts|feat-partial/.test(cv))).toBe(true);
  });

  it('when gh is installed but no PRs are enumerated, says so (no misleading "read against local base")', async () => {
    const map = await run(
      { directory: '/p', includeBranches: false },
      providers({ gh: true, prsByRepo: { 'this-repo': [] } }), // gh present, zero PRs
    );
    expect(map.caveats.some(c => /installed but no open pull requests/i.test(c))).toBe(true);
    expect(map.caveats.some(c => /read against the LOCAL base/i.test(c))).toBe(false);
  });
});
