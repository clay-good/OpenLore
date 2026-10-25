/**
 * certify_merge, end-to-end on REAL parsed graphs.
 *
 * The sibling `merge-semantic-certificate.test.ts` drives the pure join functions with
 * hand-built nodes, which proves the join logic but trusts an assumption it never checks:
 * that a real `CallGraphBuilder` actually emits the signatures and the added call/import
 * edges the join keys on. If the builder stopped populating `signature`, or emitted the
 * cross-file call edge with a shape `isDirectCall` rejects, every synthetic-node test would
 * still pass while the shipped tool silently found nothing.
 *
 * So here the graphs come from `CallGraphBuilder().build(...)` over real TypeScript source
 * variants — the exact path `graphAtRef` takes per git ref — and we assert the end-to-end
 * verdict: the disjoint-footprint merge hazard the certificate exists to catch (one branch
 * adds a call, the other breaks the callee) is flagged, and a genuinely disjoint change is not.
 */
import { describe, expect, it } from 'vitest';

import { CallGraphBuilder } from '../../analyzer/call-graph.js';
import type { CallEdge, FunctionNode } from '../../analyzer/call-graph-types.js';
import { addedEdges, changedSymbols, crossJoin } from './merge-semantic-certificate.js';

interface Graph { nodes: Map<string, FunctionNode>; edges: CallEdge[]; }

async function build(files: Array<{ path: string; content: string; language: string }>): Promise<Graph> {
  const r = await new CallGraphBuilder().build(files);
  return { nodes: r.nodes, edges: r.edges };
}

/** `parseConfig` with the given parameter list, in lib.ts. */
const lib = (params: string): { path: string; content: string; language: string } => ({
  path: 'lib.ts',
  content: `export function parseConfig(${params}): object { return {}; }\n`,
  language: 'TypeScript',
});
/** app.ts, optionally calling parseConfig from `start`. */
const app = (callsParseConfig: boolean): { path: string; content: string; language: string } => ({
  path: 'app.ts',
  content: `import { parseConfig } from "./lib";\nexport function start(): void {${callsParseConfig ? ' parseConfig("{}");' : ''}}\n`,
  language: 'TypeScript',
});

const nameIn = (g: Graph) => (id: string): string | undefined => g.nodes.get(id)?.name;

describe('certify_merge on real parsed graphs', () => {
  it('a real CallGraphBuilder emits the signatures and cross-file call edge the join keys on', async () => {
    const base = await build([lib('raw: string'), app(false)]);
    const withCall = await build([lib('raw: string'), app(true)]);

    // The assumption the synthetic-node tests never verify: real signatures are present…
    expect(base.nodes.get('lib.ts::parseConfig')?.signature).toContain('parseConfig(raw: string)');
    // …and adding the call produces exactly one new direct edge into parseConfig.
    const added = addedEdges(base, withCall);
    expect(added).toHaveLength(1);
    expect(added[0].calleeId).toBe('lib.ts::parseConfig');
    expect(added[0].callerId).toBe('app.ts::start');
  });

  it('flags the disjoint-footprint hazard: ours adds a call, theirs removes the export', async () => {
    const base = await build([lib('raw: string'), app(false)]);
    const ours = await build([lib('raw: string'), app(true)]);                  // adds call
    const theirs = await build([                                                 // removes parseConfig
      { path: 'lib.ts', content: 'export function somethingElse(): void {}\n', language: 'TypeScript' },
      app(false),
    ]);

    const theirsChanged = changedSymbols(base, theirs);
    expect(theirsChanged).toContainEqual(
      expect.objectContaining({ id: 'lib.ts::parseConfig', kind: 'removed' }),
    );

    const findings = crossJoin('ours', addedEdges(base, ours), 'theirs', theirsChanged, nameIn(ours));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      verdict: 'incompatible',
      side: 'ours',
      changedBy: 'theirs',
      callee: 'parseConfig',
      rule: 'export-removed',
    });
  });

  it('flags a breaking signature change: ours adds a call, theirs adds a required parameter', async () => {
    const base = await build([lib('raw: string'), app(false)]);
    const ours = await build([lib('raw: string'), app(true)]);                  // adds call
    const theirs = await build([lib('raw: string, strict: boolean'), app(false)]); // adds required param

    const theirsChanged = changedSymbols(base, theirs);
    const pc = theirsChanged.find(c => c.id === 'lib.ts::parseConfig');
    expect(pc).toBeDefined();
    // An added required parameter is a breaking (or at worst potentially-breaking) change —
    // never classified non-breaking, which would drop it from `changedSymbols` entirely.
    expect(['breaking', 'potentially-breaking']).toContain(pc!.kind);

    const findings = crossJoin('ours', addedEdges(base, ours), 'theirs', theirsChanged, nameIn(ours));
    expect(findings).toHaveLength(1);
    expect(findings[0].callee).toBe('parseConfig');
    expect(['incompatible', 'potentially-incompatible']).toContain(findings[0].verdict);
  });

  it('does not flag a genuinely disjoint change: ours adds a call, theirs touches an unrelated file', async () => {
    const base = await build([lib('raw: string'), app(false)]);
    const ours = await build([lib('raw: string'), app(true)]);                  // adds call
    const theirs = await build([                                                 // parseConfig untouched
      lib('raw: string'),
      { path: 'other.ts', content: 'export function helper(): void {}\n', language: 'TypeScript' },
      app(false),
    ]);

    const findings = crossJoin('ours', addedEdges(base, ours), 'theirs', changedSymbols(base, theirs), nameIn(ours));
    expect(findings).toEqual([]);
  });
});
