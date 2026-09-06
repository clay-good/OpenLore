/**
 * find_dead_code next to a dynamic boundary (change: disclose-dynamic-boundary-regions).
 *
 * Three rules the spec makes normative, each asserted against the shipped confidence ladder rather
 * than against the new code in isolation:
 *   1. the specific site REPLACES the generic caveat as the stated reason — it never lowers
 *      confidence a second time on a candidate a shipped cap already covers;
 *   2. a site outside what can name the candidate does not qualify it;
 *   3. the crossing is scoped to the answer, and a boundary never makes a candidate more dead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));
// Only `readFile` is stubbed — the dependency-graph read. The site artifact is written for real,
// so the rest of `node:fs/promises` must stay intact.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));

import { handleFindDeadCode } from './reachability.js';
import { readCachedContext } from './utils.js';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DYNAMIC_BOUNDARY } from '../../../constants.js';
import { __resetDynamicBoundaryMemo } from './dynamic-boundary-disclosure.js';
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

// `tsOrphan` is a static-language candidate that would otherwise be HIGH confidence.
// `pyOrphan` is a dynamic-language candidate the shipped rule already caps at LOW.
const NODES = [
  node({ id: 'src/main.ts::main', fanOut: 1 }),
  node({ id: 'src/app.ts::handler', fanIn: 1 }),
  node({ id: 'src/plugins.ts::tsOrphan' }),
  node({ id: 'src/py/plugins.py::pyOrphan', language: 'Python' }),
  node({ id: 'src/far/away.ts::farOrphan' }),
];
const EDGES = [edge('src/main.ts::main', 'src/app.ts::handler')];

const GRAPH: SerializedCallGraph = {
  nodes: NODES, edges: EDGES, classes: [], inheritanceEdges: [], hubFunctions: [],
  entryPoints: [], layerViolations: [],
  stats: { totalNodes: NODES.length, totalEdges: EDGES.length, avgFanIn: 0, avgFanOut: 0 },
};

interface SiteSpec { filePath: string; language: string; kind: string; line: number }

let root: string;

/**
 * The dependency graph is mocked (this handler reads it with `readFile`); the site artifact is
 * written for real, because the disclosure loader reads it through the hardened bounded reader —
 * which refuses a symlink and will not block on a FIFO, and therefore does not go through
 * `readFile` at all.
 */
async function mockArtifacts(sites: SiteSpec[], imports: Array<[string, string]> = []): Promise<void> {
  const nodesById = [...new Set(imports.flat())].map(p => ({ id: p, file: { path: p } }));
  const depGraph = JSON.stringify({
    nodes: nodesById,
    edges: [
      { importedNames: ['main'] },
      ...imports.map(([from, to]) => ({ source: from, target: to })),
    ],
  });
  vi.mocked(readFile).mockImplementation((async (p: unknown) => {
    if (String(p).endsWith('dependency-graph.json')) return depGraph;
    throw new Error('ENOENT');
  }) as never);

  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ARTIFACT_DYNAMIC_BOUNDARY), JSON.stringify({
    version: 1, totalSites: sites.length, totalFiles: sites.length, byKind: [], byLanguage: [],
    files: sites.map(s => ({
      filePath: s.filePath, language: s.language,
      sites: [{ line: s.line, kind: s.kind, refusal: 'no-static-target', evidence: 'o[n]()', moduleLevel: true }],
    })),
  }));
  // The loaders memoize per directory for a few seconds so a burst of composed handler calls does
  // not re-read one artifact. These cases rewrite it inside that window, which no real run does.
  __resetDynamicBoundaryMemo();
}

interface DeadResult {
  candidateDead: Array<{ name: string; file: string; confidence: string; reason: string }>;
  confidenceBoundary: { knownUnknowable?: Array<{ kind: string; count: number; sites?: Array<{ file: string; line: number }> }> };
}
const run = () => handleFindDeadCode({ directory: root }) as Promise<DeadResult>;
const find = (r: DeadResult, name: string) => r.candidateDead.find(c => c.name === name)!;
const crossing = (r: DeadResult) =>
  r.confidenceBoundary.knownUnknowable?.find(c => c.kind === 'dynamic-boundary');

describe('find_dead_code — dynamic-boundary qualification', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-dead-dyn-'));
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: GRAPH } as never);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('names the specific site as the reason and caps the candidate at low', async () => {
    await mockArtifacts([{ filePath: 'src/plugins.ts', language: 'TypeScript', kind: 'computed-member', line: 31 }]);
    const r = await run();
    const c = find(r, 'tsOrphan');
    expect(c.confidence).toBe('low');
    expect(c.reason).toContain('src/plugins.ts:31');
    expect(c.reason).toContain('computed member dispatch');
  });

  it('does not lower a candidate a shipped cap already covers — and the reason gets specific', async () => {
    // `pyOrphan` is already `low` by the dynamic-language rule. The site-based treatment must
    // REPLACE the generic caveat with a named construct, not downgrade a second time.
    const withoutSite = await (async () => {
      await mockArtifacts([]);
      return find(await run(), 'pyOrphan');
    })();
    await mockArtifacts([{ filePath: 'src/py/plugins.py', language: 'Python', kind: 'reflective-invoke', line: 7 }]);
    const withSite = find(await run(), 'pyOrphan');

    expect(withoutSite.confidence).toBe('low');
    expect(withSite.confidence).toBe(withoutSite.confidence); // unchanged, not lowered again
    expect(withoutSite.reason).not.toContain('src/py/plugins.py:7');
    expect(withSite.reason).toContain('src/py/plugins.py:7');
  });

  it('a site in a module that cannot name the candidate does not qualify it', async () => {
    await mockArtifacts([{ filePath: 'src/plugins.ts', language: 'TypeScript', kind: 'computed-member', line: 31 }]);
    const r = await run();
    expect(find(r, 'farOrphan').reason).not.toContain('src/plugins.ts');
  });

  it('a site whose importer chain reaches the candidate DOES qualify it', async () => {
    await mockArtifacts(
      [{ filePath: 'src/plugins.ts', language: 'TypeScript', kind: 'computed-member', line: 31 }],
      [['src/plugins.ts', 'src/far/away.ts']],
    );
    expect(find(await run(), 'farOrphan').reason).toContain('src/plugins.ts:31');
  });

  it('a site in another language never qualifies', async () => {
    await mockArtifacts([{ filePath: 'src/plugins.ts', language: 'Python', kind: 'reflective-invoke', line: 3 }]);
    expect(find(await run(), 'tsOrphan').reason).not.toContain('src/plugins.ts:3');
  });

  it('the crossing names the sites in the answer and is absent without them', async () => {
    await mockArtifacts([{ filePath: 'src/plugins.ts', language: 'TypeScript', kind: 'computed-member', line: 31 }]);
    const c = crossing(await run());
    expect(c?.sites).toEqual([{ file: 'src/plugins.ts', line: 31, kind: 'computed-member' }]);

    await mockArtifacts([]);
    expect(crossing(await run())).toBeUndefined();
  });

  it('a boundary never makes a candidate MORE dead, or promotes one to live', async () => {
    await mockArtifacts([]);
    const clean = await run();
    await mockArtifacts([{ filePath: 'src/plugins.ts', language: 'TypeScript', kind: 'computed-member', line: 31 }]);
    const withSite = await run();

    // The candidate SET is identical — a boundary changes confidence and wording, never membership.
    expect(withSite.candidateDead.map(c => c.name).sort())
      .toEqual(clean.candidateDead.map(c => c.name).sort());
    const rank = { high: 0, medium: 1, low: 2 };
    for (const c of withSite.candidateDead) {
      const before = clean.candidateDead.find(x => x.name === c.name)!;
      expect(rank[c.confidence as keyof typeof rank])
        .toBeGreaterThanOrEqual(rank[before.confidence as keyof typeof rank]);
    }
  });
});
