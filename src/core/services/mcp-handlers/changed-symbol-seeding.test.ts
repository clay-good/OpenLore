/**
 * The three between-revisions consumers seed from the symbol-level changed-set
 * (change: add-symbol-content-hashes): `select_tests`, `blast_radius`, `briefing_since`.
 * The changed-set itself is tested against real git repositories in
 * `services/symbol-changed-set.test.ts`; here it is stubbed so the wiring, the receipts, and the
 * messages are pinned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

vi.mock('../../drift/git-diff.js', async (importActual) => {
  const actual = await importActual<typeof import('../../drift/git-diff.js')>();
  return {
    ...actual,
    getChangedFiles: vi.fn(async () => ({ files: [{ path: 'src/m.ts', status: 'modified', isTest: false }] })),
    resolveBaseRefDisclosed: vi.fn(async (_d: string, requested: string) => ({ requested, resolved: 'HEAD', fellBack: false })),
    getRepoPrefix: vi.fn(async () => ''),
  };
});

vi.mock('../symbol-changed-set.js', async (importActual) => {
  const actual = await importActual<typeof import('../symbol-changed-set.js')>();
  return { ...actual, computeSymbolChangedSet: vi.fn() };
});

vi.mock('./graph.js', async (importActual) => {
  const actual = await importActual<typeof import('./graph.js')>();
  return { ...actual, handleAnalyzeImpact: vi.fn(async () => ({ error: 'not needed' })) };
});

vi.mock('./analysis.js', () => ({ handleCheckSpecDrift: vi.fn(async () => ({ issues: [], totalChangedFiles: 1, analyzedFiles: 1, filesOmitted: 0 })) }));

vi.mock('./confidence-boundary.js', async (importActual) => {
  const actual = await importActual<typeof import('./confidence-boundary.js')>();
  return { ...actual, computeStaleness: vi.fn(async () => undefined) };
});

vi.mock('../../provenance/change-coupling.js', async (importActual) => {
  const actual = await importActual<typeof import('../../provenance/change-coupling.js')>();
  return { ...actual, analyzeChangeCoupling: vi.fn(async () => ({ churn: new Map(), coupling: new Map(), stats: { commitsScanned: 10 } })) };
});

import { handleSelectTests } from './test-impact.js';
import { computeBlastRadius } from './blast-radius.js';
import { handleBriefingSince } from './briefing-since.js';
import { readCachedContext } from './utils.js';
import { computeSymbolChangedSet, type FileSymbolChange, type SymbolChangedSet } from '../symbol-changed-set.js';
import type { CallEdge, FunctionNode, SerializedCallGraph } from '../../analyzer/call-graph.js';

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id,
    filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 0,
    ...over,
  };
}
function graph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return { nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 } };
}

const NODES = [
  node({ id: 'src/m.ts::alpha', fanIn: 3 }),
  node({ id: 'src/m.ts::beta', fanIn: 1 }),
  node({ id: 'src/m.ts::gamma' }),
  node({ id: 'src/m.test.ts::testAlpha', isTest: true, fanOut: 1 }),
];
const EDGES: CallEdge[] = [
  { callerId: 'src/m.test.ts::testAlpha', calleeId: 'src/m.ts::alpha', calleeName: 'alpha', confidence: 'import', kind: 'calls' },
];

const symbolChange = (over: Partial<Extract<FileSymbolChange, { granularity: 'symbol' }>> = {}): FileSymbolChange => ({
  granularity: 'symbol', changed: [], appeared: [], disappeared: [], referencing: [], dynamicDispatch: [], ...over,
});

function changedSet(change: FileSymbolChange, carried: SymbolChangedSet['carried'] = []): SymbolChangedSet {
  return { byFile: new Map([['src/m.ts', change]]), carried };
}

beforeEach(() => {
  vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph(NODES, EDGES) } as never);
  vi.mocked(computeSymbolChangedSet).mockResolvedValue(changedSet(symbolChange({ changed: ['src/m.ts::alpha'] })));
});

describe('select_tests seeds from the changed symbols', () => {
  it('seeds only the changed symbol and reports the granularity', async () => {
    const r = await handleSelectTests({ directory: '/repo', diffRef: 'HEAD' }) as {
      seeds: Array<{ name: string }>; changeGranularity: { symbolExactFiles: number; fileGranularFiles: number };
    };
    expect(r.seeds.map(s => s.name)).toEqual(['alpha']);
    expect(r.changeGranularity).toMatchObject({ symbolExactFiles: 1, fileGranularFiles: 0 });
  });

  it('keeps a referencing and a dynamic-dispatch symbol in the seed set', async () => {
    vi.mocked(computeSymbolChangedSet).mockResolvedValue(changedSet(symbolChange({
      changed: ['src/m.ts::alpha'], referencing: ['src/m.ts::beta'], dynamicDispatch: ['src/m.ts::gamma'],
    })));
    const r = await handleSelectTests({ directory: '/repo', diffRef: 'HEAD' }) as { seeds: Array<{ name: string }> };
    expect(r.seeds.map(s => s.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('says a formatting-only diff changed no symbol, rather than "nothing changed"', async () => {
    vi.mocked(computeSymbolChangedSet).mockResolvedValue(changedSet(symbolChange()));
    const r = await handleSelectTests({ directory: '/repo', diffRef: 'HEAD' }) as {
      message: string; selectedTests: unknown[]; changeGranularity: unknown;
    };
    expect(r.message).toContain('formatting or comments only');
    expect(r.selectedTests).toEqual([]);
    expect(r.changeGranularity).toBeDefined();
  });

  it('keeps every symbol and discloses the reason when a file stays file-granular', async () => {
    vi.mocked(computeSymbolChangedSet).mockResolvedValue(changedSet({ granularity: 'file', reason: 'module-level-change' }));
    const r = await handleSelectTests({ directory: '/repo', diffRef: 'HEAD' }) as {
      seeds: Array<{ name: string }>; soundness: { caveats: string[] };
      changeGranularity: { fileGranularFiles: number; fallbacks: Array<{ file: string; reason: string }> };
    };
    expect(r.seeds.map(s => s.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(r.changeGranularity.fallbacks).toEqual([{ file: 'src/m.ts', reason: 'module-level-change' }]);
    expect(r.soundness.caveats.some(c => c.includes('module-level-change'))).toBe(true);
  });

  it('keeps every symbol when the changed-set throws', async () => {
    vi.mocked(computeSymbolChangedSet).mockRejectedValue(new Error('git exploded'));
    const r = await handleSelectTests({ directory: '/repo', diffRef: 'HEAD' }) as {
      seeds: Array<{ name: string }>; changeGranularity: { fallbacks: Array<{ reason: string }> };
    };
    expect(r.seeds.map(s => s.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(r.changeGranularity.fallbacks).toEqual([{ file: 'src/m.ts', reason: 'not-assessed' }]);
  });
});

describe('blast_radius seeds from the changed symbols', () => {
  it('counts only the changed symbols and carries the receipt', async () => {
    const b = await computeBlastRadius({ directory: '/repo' }) as {
      changed: { symbols: number; symbolNames: string[] }; changeGranularity: { symbolExactFiles: number };
    };
    expect(b.changed).toMatchObject({ symbols: 1, symbolNames: ['alpha'] });
    expect(b.changeGranularity).toMatchObject({ symbolExactFiles: 1 });
  });

  it('says so in the headline when the code edits are formatting only', async () => {
    vi.mocked(computeSymbolChangedSet).mockResolvedValue(changedSet(symbolChange()));
    const b = await computeBlastRadius({ directory: '/repo' }) as { headline: string; changed: { symbols: number } };
    expect(b.changed.symbols).toBe(0);
    expect(b.headline).toContain('formatting or comments only');
  });
});

describe('briefing_since briefs the changed symbols', () => {
  it('briefs the changed symbol and leaves the unchanged ones out', async () => {
    const r = await handleBriefingSince({ directory: '/repo', baseRef: 'HEAD' }) as {
      changedSymbols: number; briefing: Array<{ name: string }>; caveats: string[];
    };
    expect(r.changedSymbols).toBe(1);
    expect(r.briefing.map(c => c.name)).toEqual(['alpha']);
    expect(r.caveats.some(c => c.includes('FILE granularity'))).toBe(false);
  });

  it('briefs a carried rename and names the pair, because its callers changed', async () => {
    vi.mocked(computeSymbolChangedSet).mockResolvedValue(changedSet(
      symbolChange({ appeared: ['src/m.ts::beta'], disappeared: ['src/m.ts::betaOld'] }),
      [{ from: 'src/m.ts::betaOld', to: 'src/m.ts::beta', reason: 'renamed', basis: 'exact-signature' }],
    ));
    const r = await handleBriefingSince({ directory: '/repo', baseRef: 'HEAD' }) as {
      changedSymbols: number; briefing: Array<{ name: string }>; carried: Array<{ from: string; to: string }>; caveats: string[];
    };
    expect(r.carried).toEqual([{ from: 'src/m.ts::betaOld', to: 'src/m.ts::beta', reason: 'renamed', basis: 'exact-signature' }]);
    expect(r.briefing.map(c => c.name)).toEqual(['beta']);
    expect(r.changedSymbols).toBe(1);
    expect(r.caveats.some(c => c.includes('renames or moves'))).toBe(true);
  });

  it('keeps the file-granular disclosure when a file could not be hashed', async () => {
    vi.mocked(computeSymbolChangedSet).mockResolvedValue(changedSet({ granularity: 'file', reason: 'language-not-hashed' }));
    const r = await handleBriefingSince({ directory: '/repo', baseRef: 'HEAD' }) as { changedSymbols: number; caveats: string[] };
    expect(r.changedSymbols).toBe(3);
    expect(r.caveats[0]).toContain('language-not-hashed');
  });
});
