/**
 * certify_merge Pass-1 cache equivalence (change: speed-up-certify-merge-shared-pass1-cache).
 *
 * certify_merge builds the call graph at three refs — base, ours, theirs — which differ only in
 * the files that changed between them. The tool now shares ONE in-process Pass-1 fact memo across
 * the three builds so an unchanged file is parsed once, not three times. The whole value of that
 * optimization is that it must not move a single verdict: the cached build and the full
 * (uncached) build have to produce byte-identical findings.
 *
 * This proves exactly that. Over a multi-file scenario it builds base/ours/theirs two ways — with
 * no cache (today's reference path) and with the shared cache (base warmed first, then the two
 * sides) — runs the identical certify_merge finding assembly over each, and asserts the verdict,
 * summary, and findings are deep-equal. It also asserts the cache actually served reuse (the
 * `reused` disclosure is > 0 on the side builds), so the equivalence is not vacuously true over a
 * cache that never hit.
 */
import { describe, expect, it } from 'vitest';

import { CallGraphBuilder } from '../../analyzer/call-graph.js';
import type { CallEdge, FunctionNode } from '../../analyzer/call-graph-types.js';
import {
  BufferedPass1FactCache,
  computeExtractorStamp,
  type Pass1FactStorage,
} from '../../analyzer/pass1-fact-cache.js';
import { addedEdges, changedSymbols, crossJoin } from './merge-semantic-certificate.js';

interface Graph { nodes: Map<string, FunctionNode>; edges: CallEdge[]; }
type SourceFile = { path: string; content: string; language: string };

/** The identical in-process storage certify_merge wires — mirrors the on-disk key triple. */
class MemStorage implements Pass1FactStorage {
  private readonly rows = new Map<string, string>();
  getPass1Facts(filePath: string, contentHash: string, stamp: string): string | undefined {
    return this.rows.get(`${filePath}\u0000${contentHash}\u0000${stamp}`);
  }
  put(filePath: string, contentHash: string, stamp: string, facts: string): void {
    this.rows.set(`${filePath}\u0000${contentHash}\u0000${stamp}`, facts);
  }
}

/** The exact finding assembly handleCertifyMerge runs, so the comparison is the tool's own output. */
function certify(baseG: Graph, oursG: Graph, theirsG: Graph): Record<string, unknown> {
  const oursChanged = changedSymbols(baseG, oursG);
  const theirsChanged = changedSymbols(baseG, theirsG);
  const oursAdded = addedEdges(baseG, oursG);
  const theirsAdded = addedEdges(baseG, theirsG);
  const nameIn = (g: Graph) => (id: string): string | undefined => g.nodes.get(id)?.name;
  const findings = [
    ...crossJoin('theirs', theirsAdded, 'ours', oursChanged, nameIn(theirsG)),
    ...crossJoin('ours', oursAdded, 'theirs', theirsChanged, nameIn(oursG)),
  ];
  const incompatible = findings.filter(f => f.verdict === 'incompatible').length;
  return {
    verdict: incompatible > 0 ? 'incompatible' : findings.length > 0 ? 'potentially-incompatible' : 'no-detected-conflict',
    summary: { conflicts: findings.length, incompatible, potentiallyIncompatible: findings.length - incompatible },
    findings: findings.map(f => ({
      code: 'merge-semantic-conflict',
      severity: f.verdict === 'incompatible' ? 'error' : 'warning',
      subject: `${f.caller} -> ${f.callee}@${f.line ?? '?'}`,
      side: f.side, changedBy: f.changedBy, rule: f.rule,
    })),
  };
}

/** A handful of files unchanged across every ref — the parse work the cache is meant to reuse. */
const stable = (): SourceFile[] =>
  Array.from({ length: 6 }, (_, i) => ({
    path: `util${i}.ts`,
    content: `export function helper${i}(x: number): number {\n  return x + ${i};\n}\n`,
    language: 'TypeScript',
  }));
const lib = (fn: string): SourceFile => ({ path: 'lib.ts', content: `${fn}\n`, language: 'TypeScript' });
const app = (callsParseConfig: boolean): SourceFile => ({
  path: 'app.ts',
  content: `import { parseConfig } from "./lib";\nexport function start(): void {${callsParseConfig ? ' parseConfig("{}");' : ''}}\n`,
  language: 'TypeScript',
});

const parseConfig = lib('export function parseConfig(raw: string): object { return JSON.parse(raw); }');
const removed = lib('export function somethingElse(): void {}');

const baseFiles: SourceFile[] = [...stable(), parseConfig, app(false)];
const oursFiles: SourceFile[] = [...stable(), parseConfig, app(true)];   // app adds the call
const theirsFiles: SourceFile[] = [...stable(), removed, app(false)];    // lib removes the export

async function buildNoCache(files: SourceFile[]): Promise<Graph> {
  const r = await new CallGraphBuilder().build(files);
  return { nodes: r.nodes, edges: r.edges };
}

describe('certify_merge shared Pass-1 cache equivalence', () => {
  it('cached three-build path yields byte-identical verdict, summary, and findings vs the full build', async () => {
    // Reference path: a cold CallGraphBuilder per ref.
    const uncached = certify(
      await buildNoCache(baseFiles),
      await buildNoCache(oursFiles),
      await buildNoCache(theirsFiles),
    );

    // Optimized path: one shared memo, base warmed first, then the two sides read it.
    const storage = new MemStorage();
    const cache = new BufferedPass1FactCache(storage, computeExtractorStamp());
    const baseRes = await new CallGraphBuilder({ pass1Cache: cache }).build(baseFiles);
    const { stamp, rows } = cache.take();
    for (const row of rows) storage.put(row.filePath, row.contentHash, stamp, row.facts);
    const oursRes = await new CallGraphBuilder({ pass1Cache: cache }).build(oursFiles);
    const theirsRes = await new CallGraphBuilder({ pass1Cache: cache }).build(theirsFiles);

    const cached = certify(
      { nodes: baseRes.nodes, edges: baseRes.edges },
      { nodes: oursRes.nodes, edges: oursRes.edges },
      { nodes: theirsRes.nodes, edges: theirsRes.edges },
    );

    // The scenario really is a conflict (ours adds a call into a symbol theirs removed)…
    expect(uncached.verdict).toBe('incompatible');
    // …and the cache changed nothing about it.
    expect(cached).toEqual(uncached);

    // Non-vacuity: the side builds actually reused the stable + unchanged files from the warm memo
    // (every ref shares the 6 util files; ours also reuses lib, theirs also reuses app).
    expect(oursRes.pass1Cache?.reused).toBeGreaterThan(0);
    expect(theirsRes.pass1Cache?.reused).toBeGreaterThan(0);
  });
});
