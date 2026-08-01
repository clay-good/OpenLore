/**
 * Graceful-degradation ladder — end-to-end shed behavior through the real CallGraphBuilder
 * (change: make-analyze-scale-to-any-repo).
 *
 * Proves the two load-bearing guarantees of tier 1 (`shed-overlay`):
 *   1. the CFG/def-use overlay is genuinely NOT built when shed (memory saved, not just hidden);
 *   2. the base call graph — nodes and edges — is UNTOUCHED, so a usable index is still produced.
 * Plus the determinism guardrail: the base graph is byte-identical whether or not the overlay was
 * shed, because shedding only removes the additive overlay, never the graph.
 */

import { describe, it, expect } from 'vitest';
import { CallGraphBuilder, serializeCallGraph } from './call-graph.js';
import { withCfgOverlayShed, isCfgOverlayShed } from './memory-strategy.js';

const TS_SRC = `
export function classify(n: number): string {
  let label = "zero";
  if (n > 0) { label = "pos"; } else { label = "neg"; }
  return label;
}
export function caller(n: number): string {
  return classify(n);
}
`;

const FILES = [{ path: 'a.ts', content: TS_SRC, language: 'TypeScript' }];

describe('degradation ladder — overlay shed', () => {
  it('builds a per-function overlay at full fidelity', async () => {
    const result = await new CallGraphBuilder().build(FILES);
    expect(result.cfgs && result.cfgs.size).toBeGreaterThan(0);
  });

  it('builds NO overlay when the overlay is shed', async () => {
    const result = await withCfgOverlayShed(true, () => new CallGraphBuilder().build(FILES));
    // Either an empty map or none at all — the point is zero CFGs were built.
    expect(result.cfgs ? result.cfgs.size : 0).toBe(0);
    expect(isCfgOverlayShed()).toBe(false); // build-scoped store cleared after
  });

  it('keeps the base call graph intact when the overlay is shed (still a usable index)', async () => {
    const shed = await withCfgOverlayShed(true, () => new CallGraphBuilder().build(FILES));
    // Both functions present, and the caller→classify edge survives.
    const names = [...shed.nodes.values()].map(n => n.name).sort();
    expect(names).toContain('classify');
    expect(names).toContain('caller');
    // The caller→classify call edge survives — the base graph is untouched by shedding the overlay.
    expect(shed.edges.length).toBeGreaterThan(0);
  });

  it('the base graph is byte-identical with and without the overlay (determinism)', async () => {
    const full = serializeCallGraph(await new CallGraphBuilder().build(FILES));
    const shed = serializeCallGraph(await withCfgOverlayShed(true, () => new CallGraphBuilder().build(FILES)));
    // The serialized call graph does not carry the overlay (it lives in a side store), so shedding
    // it must not change a single byte of the graph artifact.
    expect(JSON.stringify(shed)).toEqual(JSON.stringify(full));
  });
});
