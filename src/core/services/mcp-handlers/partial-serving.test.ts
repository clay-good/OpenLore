/**
 * Partial first-run serving (change: refine-first-run-partial-serving).
 *
 * Three properties, in the order they matter: an index-absent repository whose first
 * build is running answers from what has been flushed instead of "no index found"; a
 * repository that HAS an artifact never has it masked by a partial one; and no negative
 * conclusion is ever computed from a partial index.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flushPartialIndex,
  type PartialIndexStamp,
} from '../../runtime/partial-index.js';

let root: string;
let analysisDir: string;

function stampOf(overrides: Partial<PartialIndexStamp> = {}): PartialIndexStamp {
  return {
    partial: true,
    phase: 'extractors' as const,
    buildPhase: 'extractors',
    filesExtracted: 0,
    filesTotal: 240,
    filesMapped: 238,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    analysisDir,
    ...overrides,
  };
}

async function plantPartial(stamp = stampOf()): Promise<void> {
  await flushPartialIndex(analysisDir, {
    repoStructure: { projectName: 'demo', domains: [] },
    llmContext: {
      phase1_survey: { purpose: 'Partial first-run index', files: [] },
      phase2_deep: { purpose: 'Not built yet', files: [] },
      phase3_validation: { purpose: 'Not built yet', files: [] },
      partial: stamp,
    },
    dependencyGraph: { statistics: { nodeCount: 7 } },
    stamp,
  });
}

describe('readCachedContext falls back to a partial first-run index', () => {
  let readCachedContext: typeof import('./utils.js').readCachedContext;
  let reset: typeof import('./utils.js')._resetContextCacheForTesting;

  beforeEach(async () => {
    vi.resetModules();
    const utils = await import('./utils.js');
    readCachedContext = utils.readCachedContext;
    reset = utils._resetContextCacheForTesting;
    reset();
    root = await mkdtemp(join(tmpdir(), 'openlore-partial-serve-'));
    analysisDir = join(root, '.openlore', 'analysis');
    await mkdir(analysisDir, { recursive: true });
  });

  afterEach(async () => {
    reset();
    await rm(root, { recursive: true, force: true });
  });

  it('answers from the partial index when no analysis artifact exists', async () => {
    await plantPartial();

    const ctx = await readCachedContext(root);

    expect(ctx).not.toBeNull();
    expect(ctx!.partial?.partial).toBe(true);
    expect(ctx!.partial?.phase).toBe('extractors');
    // No fabricated graph: graph tools must still refuse, honestly.
    expect(ctx!.callGraph).toBeUndefined();
    expect(ctx!.edgeStore).toBeUndefined();
  });

  it('records the served partial in the request scope so the dispatcher can disclose it', async () => {
    const { withPartialReceiptScope, partialReceiptForThisRequest } = await import('./partial-request.js');
    await plantPartial();

    const seen = await withPartialReceiptScope(async () => {
      await readCachedContext(root);
      return partialReceiptForThisRequest();
    });

    expect(seen?.filesMapped).toBe(238);
  });

  it('discloses nothing for a repository with no partial index', async () => {
    const { withPartialReceiptScope, partialReceiptForThisRequest } = await import('./partial-request.js');

    const seen = await withPartialReceiptScope(async () => {
      await readCachedContext(root);
      return partialReceiptForThisRequest();
    });

    expect(seen).toBeUndefined();
  });

  it('strips graph-shaped fields a partial index cannot legitimately carry', async () => {
    // A hostile repository can ship a partial index and no analysis directory. Handlers do
    // `cg.nodes.map(...)`; an attacker-chosen shape there is the failure the published path's
    // normalization exists to prevent, so the partial path deletes these outright.
    await flushPartialIndex(analysisDir, {
      repoStructure: {}, dependencyGraph: {},
      llmContext: {
        partial: stampOf(),
        callGraph: { nodes: 'not-an-array', edges: 7 },
        signatures: 'nope',
        graphDigest: 'forged',
      },
      stamp: stampOf(),
    });

    const ctx = await readCachedContext(root);

    expect(ctx?.partial?.partial).toBe(true);
    expect(ctx?.callGraph).toBeUndefined();
    expect(ctx?.signatures).toBeUndefined();
    expect(ctx?.graphDigest).toBeUndefined();
  });

  it('never lets a partial index stand in for a present analysis artifact', async () => {
    // Whatever the published path decides about an artifact that IS there — serve it,
    // refuse it as unattested, refuse it as changed — that decision stands. A partial index
    // substituting for it would turn a loud problem into a quiet downgrade, which is the
    // opposite of what this lane is for.
    await writeFile(join(analysisDir, 'llm-context.json'), '{"phase1_survey":{"purpose":"real"}}', 'utf8');
    await plantPartial();

    const ctx = await readCachedContext(root);

    expect(ctx?.partial).toBeUndefined();
    expect(ctx?.phase1_survey?.purpose).toBe('real');
  });

  it('ignores a partial index whose build died', async () => {
    await plantPartial(stampOf({ pid: 4_194_303 }));
    expect(await readCachedContext(root)).toBeNull();
  });
});

describe('negative conclusions are withheld on a partial index', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('find_dead_code refuses and cites the partial boundary', async () => {
    vi.doMock('./utils.js', () => ({
      validateDirectory: vi.fn(async (d: string) => d),
      readCachedContext: vi.fn(async () => ({ partial: stampOf() })),
    }));
    const { handleFindDeadCode } = await import('./reachability.js');

    const result = await handleFindDeadCode({ directory: '/repo' }) as {
      error: string; withheld: boolean; reason: string;
    };

    expect(result.withheld).toBe(true);
    expect(result.reason).toBe('partial-index');
    expect(result.error).toContain('dead-code candidates');
    expect(result.error).toContain('partial first-run index');
    // No boundary of its own: `dispatchTool` attaches the receipt to every response, so a
    // second copy here would send the same paragraph twice.
  });

  it('report_coverage_gaps refuses and cites the partial boundary', async () => {
    vi.doMock('./utils.js', () => ({
      validateDirectory: vi.fn(async (d: string) => d),
      readCachedContext: vi.fn(async () => ({ partial: stampOf() })),
    }));
    vi.doMock('../../drift/git-diff.js', () => ({ getChangedFiles: vi.fn(async () => ({ files: [] })) }));
    const { handleReportCoverageGaps } = await import('./coverage-gaps.js');

    const result = await handleReportCoverageGaps({ directory: '/repo' }) as {
      error: string; withheld: boolean; reason: string;
    };

    expect(result.withheld).toBe(true);
    expect(result.reason).toBe('partial-index');
    expect(result.error).toContain('test-coverage gaps');
  });

  it('a complete index is unaffected by the guard', async () => {
    const { withheldOnPartialIndex } = await import('./confidence-boundary.js');
    expect(withheldOnPartialIndex({}, 'dead-code candidates')).toBeNull();
    expect(withheldOnPartialIndex(null, 'dead-code candidates')).toBeNull();
  });
});
