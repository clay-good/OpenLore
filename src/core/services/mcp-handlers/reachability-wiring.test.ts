/**
 * Config-wired liveness roots in dead-code and coverage-gap conclusions
 * (change: add-framework-entry-point-adapters).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
}));
vi.mock('./parse-health-boundary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./parse-health-boundary.js')>();
  return { ...actual, loadParseHealthReport: vi.fn(async () => null) };
});
vi.mock('../../drift/git-diff.js', () => ({ getChangedFiles: vi.fn(async () => ({ files: [] })) }));
vi.mock('../../analyzer/entry-point-adapters.js', () => ({ collectExternalWiring: vi.fn() }));

import { handleFindDeadCode, deadCodeIds } from './reachability.js';
import { handleReportCoverageGaps } from './coverage-gaps.js';
import { readCachedContext } from './utils.js';
import { collectExternalWiring, type ExternalWiringReport } from '../../analyzer/entry-point-adapters.js';
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

// runCli is invoked by package.json `bin` and calls parseFlags; orphan is referenced by nothing.
const CG: SerializedCallGraph = {
  nodes: [
    node({ id: 'src/cli/index.ts::runCli', fanOut: 1 }),
    node({ id: 'src/cli/flags.ts::parseFlags', fanIn: 1 }),
    node({ id: 'src/unused.ts::orphan' }),
  ],
  edges: [edge('src/cli/index.ts::runCli', 'src/cli/flags.ts::parseFlags')],
  classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
  stats: { totalNodes: 3, totalEdges: 1, avgFanIn: 0, avgFanOut: 0 },
};

const WIRED: ExternalWiringReport = {
  wired: [{ file: 'src/cli/index.ts', receipts: [{ config: 'package.json', key: 'bin.tool' }] }],
  boundaries: [{ config: 'package.json', key: 'scripts.dynamic', reference: '$SCRIPT', reason: 'dynamic-reference' }],
  boundariesOmitted: 0,
};
const NONE: ExternalWiringReport = { wired: [], boundaries: [], boundariesOmitted: 0 };

type DeadResult = {
  candidateDead: Array<{ name: string; confidence: string; reason: string }>;
  rootKinds: { externallyWired: number };
  externalWiring: { files: Array<{ file: string; receipts: unknown[]; roots: number }>; boundaries: unknown[] };
  soundness: { caveats: string[] };
};

describe('find_dead_code with config-wired roots', () => {
  beforeEach(() => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: CG } as never);
  });

  it('keeps a bin-wired entry and what it calls out of candidate-dead, with the receipt', async () => {
    vi.mocked(collectExternalWiring).mockResolvedValue(WIRED);
    const r = await handleFindDeadCode({ directory: '/p' }) as DeadResult;
    expect(r.candidateDead.map(d => d.name)).toEqual(['orphan']);
    expect(r.rootKinds.externallyWired).toBe(1);
    expect(r.externalWiring.files).toEqual([
      { file: 'src/cli/index.ts', receipts: [{ config: 'package.json', key: 'bin.tool' }], roots: 1 },
    ]);
  });

  it('never changes a candidate the adapters say nothing about', async () => {
    vi.mocked(collectExternalWiring).mockResolvedValue(NONE);
    const without = await handleFindDeadCode({ directory: '/p' }) as DeadResult;
    vi.mocked(collectExternalWiring).mockResolvedValue(WIRED);
    const withWiring = await handleFindDeadCode({ directory: '/p' }) as DeadResult;
    const orphan = (r: DeadResult) => r.candidateDead.find(d => d.name === 'orphan');
    expect(orphan(withWiring)).toEqual(orphan(without));
    expect(without.candidateDead.map(d => d.name).sort()).toEqual(['orphan', 'parseFlags', 'runCli']);
  });

  it('discloses unresolved config references and the formats it does not read', async () => {
    vi.mocked(collectExternalWiring).mockResolvedValue(WIRED);
    const r = await handleFindDeadCode({ directory: '/p' }) as DeadResult;
    expect(r.externalWiring.boundaries).toEqual(WIRED.boundaries);
    const caveats = r.soundness.caveats.join(' ');
    expect(caveats).toMatch(/1 config reference\(s\) could not be resolved/);
    expect(caveats).toMatch(/Workspace-member manifests, framework routing conventions/);
  });

  it('shares the wired roots with the dead set other conclusions read', async () => {
    vi.mocked(collectExternalWiring).mockResolvedValue(WIRED);
    expect([...await deadCodeIds('/p', CG)]).toEqual(['src/unused.ts::orphan']);
  });

  it('still answers when the adapters fail', async () => {
    vi.mocked(collectExternalWiring).mockRejectedValue(new Error('boom'));
    const r = await handleFindDeadCode({ directory: '/p' }) as DeadResult;
    expect(r.candidateDead.map(d => d.name).sort()).toEqual(['orphan', 'parseFlags', 'runCli']);
    expect(r.rootKinds.externallyWired).toBe(0);
  });
});

describe('report_coverage_gaps with config-wired roots', () => {
  it('labels a config-wired untested entry untested-not-dead, with the receipt', async () => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: CG } as never);
    vi.mocked(collectExternalWiring).mockResolvedValue(WIRED);
    const r = await handleReportCoverageGaps({ directory: '/p' }) as {
      coverageGaps: Array<{ name: string; alsoFlaggedDead?: true; externallyWired?: unknown[] }>;
      soundness: { caveats: string[] };
    };
    expect(r.soundness.caveats.join(' ')).toMatch(/Every function in a file a config invokes .* is treated as live/);
    expect(r.soundness.caveats.join(' ')).toMatch(/1 config reference\(s\) could not be resolved/);
    const runCli = r.coverageGaps.find(g => g.name === 'runCli');
    expect(runCli).toMatchObject({ externallyWired: [{ config: 'package.json', key: 'bin.tool' }] });
    expect(runCli?.alsoFlaggedDead).toBeUndefined();
    const orphan = r.coverageGaps.find(g => g.name === 'orphan');
    expect(orphan).toMatchObject({ alsoFlaggedDead: true });
    expect(orphan?.externallyWired).toBeUndefined();
  });
});
