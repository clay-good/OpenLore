/**
 * Complexity trend (change: add-complexity-trend-signal) over a real git history: a function
 * that grew branches is `rising`, a stable one `flat`, one with too little history is withheld,
 * bulk commits are skipped, and `get_health_map` carries the trend and an advisory
 * `declining-health` finding. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

vi.mock('./utils.js', async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return { ...actual, validateDirectory: vi.fn(async (d: string) => d), readCachedContext: vi.fn(async () => null) };
});

import { computeComplexityTrends, trendOf, decliningHealthFindings, TREND_SAMPLES } from './complexity-trend.js';
import { handleGetHealthMap } from './health-map.js';
import { readCachedContext } from './utils.js';
import { EdgeStore } from '../edge-store.js';
import { CallGraphBuilder, serializeCallGraph, type FunctionNode } from '../../analyzer/call-graph.js';

const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
};
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', env: ENV });
const write = (cwd: string, rel: string, content: string) => {
  const p = join(cwd, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
};

/** A function with `n` independent `if` branches (complexity n + 1). */
function branches(name: string, n: number): string {
  const body = Array.from({ length: n }, (_, i) => `  if (x === ${i}) return ${i};`).join('\n');
  return `export function ${name}(x: number): number {\n${body}\n  return -1;\n}\n`;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.mocked(readCachedContext).mockResolvedValue(null as never);
});

/** Commit each state of the repo in order; returns the repo path. */
function history(states: Array<Record<string, string>>): string {
  const d = mkdtempSync(join(tmpdir(), 'openlore-trend-'));
  dirs.push(d);
  git(d, ['init', '-q', '-b', 'main']);
  states.forEach((files, i) => {
    for (const [f, c] of Object.entries(files)) write(d, f, c);
    git(d, ['add', '-A']);
    git(d, ['commit', '-q', '-m', `c${i}`]);
  });
  return d;
}

async function currentNodes(root: string, files: Record<string, string>): Promise<FunctionNode[]> {
  const g = serializeCallGraph(await new CallGraphBuilder().build(
    Object.entries(files).map(([path, content]) => ({ path, content, language: 'TypeScript' })),
  ));
  void root;
  return g.nodes;
}

describe('trendOf', () => {
  it('labels a sequence without any size threshold', () => {
    expect(trendOf([10, 10, 12])).toBe('rising');
    expect(trendOf([12, 11, 11])).toBe('falling');
    expect(trendOf([11, 11, 11])).toBe('flat');
    expect(trendOf([10, 12, 11])).toBe('mixed');
    expect(trendOf([10, 12])).toBeUndefined();
  });
});

describe('computeComplexityTrends', () => {
  it('labels a growing function rising, a stable one flat, and withholds a new one', async () => {
    const final = {
      'src/grow.ts': branches('grow', 14),
      'src/stable.ts': branches('stable', 11),
      'src/young.ts': branches('young', 12),
    };
    const root = history([
      { 'src/grow.ts': branches('grow', 9), 'src/stable.ts': branches('stable', 11) },
      { 'src/grow.ts': branches('grow', 11), 'src/stable.ts': `${branches('stable', 11)}// a\n` },
      { 'src/grow.ts': branches('grow', 14), 'src/stable.ts': `${branches('stable', 11)}// b\n`, 'src/young.ts': branches('young', 12) },
    ]);
    const r = await computeComplexityTrends(root, await currentNodes(root, final), new Set(Object.keys(final)), 10);
    const by = Object.fromEntries(r.hotspots.map(h => [h.name, h]));
    expect(by.grow).toMatchObject({ trend: 'rising' });
    expect(by.grow.samples.map(s => s.complexity)).toEqual([10, 12, 15]);
    expect(by.stable).toMatchObject({ trend: 'flat' });
    expect(by.young).toMatchObject({ withheld: 'shallow-history' });
    expect(by.young.samples).toHaveLength(1);

    const findings = decliningHealthFindings(r);
    expect(findings.map(f => f.subject)).toEqual(['src/grow.ts::grow']);
    expect(findings[0]).toMatchObject({ code: 'declining-health', message: expect.stringContaining('from 10 to 15') });
  });

  it('skips bulk commits and samples at most TREND_SAMPLES commits', async () => {
    const bulk: Record<string, string> = { 'src/grow.ts': branches('grow', 20) };
    for (let i = 0; i < 30; i++) bulk[`src/noise${i}.ts`] = `export const n${i} = ${i};\n`;
    const states: Array<Record<string, string>> = [];
    for (let k = 9; k <= 9 + TREND_SAMPLES; k++) states.push({ 'src/grow.ts': branches('grow', k) });
    states.push(bulk); // the newest commit touches 31 files: a bulk commit, not sampled
    const root = history(states);
    const r = await computeComplexityTrends(root, await currentNodes(root, { 'src/grow.ts': branches('grow', 20) }), new Set(['src/grow.ts']), 10);
    const samples = r.hotspots[0].samples.map(s => s.complexity);
    expect(samples).toHaveLength(TREND_SAMPLES);
    expect(samples).not.toContain(21);
    expect(r.hotspots[0].trend).toBe('rising');
  });

  it('only samples functions at or above the threshold in churned files', async () => {
    const files = { 'src/low.ts': branches('low', 3), 'src/high.ts': branches('high', 12) };
    const root = history([files]);
    const nodes = await currentNodes(root, files);
    expect((await computeComplexityTrends(root, nodes, new Set(['src/low.ts', 'src/high.ts']), 10)).hotspots.map(h => h.name)).toEqual(['high']);
    expect((await computeComplexityTrends(root, nodes, new Set(['src/low.ts']), 10)).hotspots).toEqual([]);
  });
});

describe('get_health_map carries the trend', () => {
  it('reports the trend and an advisory finding when churn data exists', async () => {
    const final = { 'src/grow.ts': branches('grow', 14) };
    const root = history([
      { 'src/grow.ts': branches('grow', 9) },
      { 'src/grow.ts': branches('grow', 11) },
      final,
    ]);
    const store = EdgeStore.open(join(root, 'graph.db'));
    store.insertChangeCoupling({ churn: new Map([['src/grow.ts', 3]]), coupling: new Map(), stats: { commitsScanned: 3, bulkCommitsFiltered: 0, filesTracked: 1 } });
    const nodes = await currentNodes(root, final);
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: { nodes, edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [], stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 } },
      edgeStore: store,
    } as never);
    try {
      const r = await handleGetHealthMap({ directory: root }) as {
        summary: { decliningHealthCount: number };
        complexityTrend: { hotspots: Array<{ name: string; trend?: string }>; findings?: Array<{ code: string; enforcementClass: string }>; gated?: boolean };
      };
      expect(r.complexityTrend.hotspots[0]).toMatchObject({ name: 'grow', trend: 'rising' });
      expect(r.summary.decliningHealthCount).toBe(1);
      expect(r.complexityTrend.findings?.[0]).toMatchObject({ code: 'declining-health', enforcementClass: 'advisory' });
      expect(r.complexityTrend.gated).toBe(false);
    } finally {
      store.close();
    }
  });

  it('withholds the trend when there is no churn data', async () => {
    const root = history([{ 'src/grow.ts': branches('grow', 14) }]);
    const nodes = await currentNodes(root, { 'src/grow.ts': branches('grow', 14) });
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: { nodes, edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [], stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 } },
    } as never);
    const r = await handleGetHealthMap({ directory: root }) as { complexityTrend: { withheld?: string } };
    expect(r.complexityTrend.withheld).toMatch(/churn/);
  });
});
