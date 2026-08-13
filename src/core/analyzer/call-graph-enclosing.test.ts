/**
 * Immediate-enclosing-function computation (change: bulletproof-background-index).
 *
 * `ensureUniqueNodeIds` disambiguates nested functions that share a bare id, and it needs each
 * node's immediate enclosing function to build the discriminator (`file::A.m1/helper`). That was a
 * full scan of every node, per colliding node. The collision it fires on is not exotic — an
 * `export function` wrapper and its inner declaration carry the same id — so in a file of plain
 * `export function`s every node collides and the scan runs for all of them. It was 24% of an
 * entire `analyze` run on a 2 MB single file.
 *
 * The replacement is one sweep with an ancestor stack. Because the id it produces is STABLE and
 * lands in the persisted graph, a disagreement with the old definition would silently re-key
 * functions — breaking anchored memories and reading as removed+added in every later diff. So this
 * is a differential test against the brute-force definition, which is kept in the source purely to
 * be diffed against.
 */
import { describe, it, expect } from 'vitest';

import {
  _computeEnclosingForTesting,
  _enclosingByBruteForceForTesting,
} from './call-graph.js';
import type { FunctionNode } from './call-graph.js';

const node = (name: string, startIndex: number, endIndex: number): FunctionNode =>
  ({ id: `f.ts::${name}`, name, filePath: 'f.ts', startIndex, endIndex } as unknown as FunctionNode);

/** Assert the sweep agrees with the definition for every node in the set. */
function expectAgreement(nodes: FunctionNode[], label: string): void {
  const swept = _computeEnclosingForTesting(nodes);
  for (const n of nodes) {
    const expected = _enclosingByBruteForceForTesting(nodes, n);
    expect(swept.get(n), `${label}: disagreed for ${n.name} [${n.startIndex},${n.endIndex}]`)
      .toBe(expected);
  }
}

describe('computeEnclosing — identical to the brute-force definition', () => {
  it('simple nesting', () => {
    const outer = node('outer', 0, 100);
    const inner = node('inner', 10, 50);
    const deepest = node('deepest', 20, 30);
    expectAgreement([outer, inner, deepest], 'simple');

    const m = _computeEnclosingForTesting([outer, inner, deepest]);
    expect(m.get(deepest)).toBe(inner);
    expect(m.get(inner)).toBe(outer);
    expect(m.get(outer)).toBeUndefined();
  });

  it('siblings have no container', () => {
    const a = node('a', 0, 10);
    const b = node('b', 20, 30);
    const m = _computeEnclosingForTesting([a, b]);
    expect(m.get(a)).toBeUndefined();
    expect(m.get(b)).toBeUndefined();
    expectAgreement([a, b], 'siblings');
  });

  it('an identical span is NOT a container', () => {
    // The `export function` wrapper case: two nodes over exactly the same bytes are the same
    // logical function matched twice, and are meant to collapse — not to enclose each other.
    const wrapper = node('f', 0, 50);
    const decl = node('f', 0, 50);
    const inner = node('helper', 10, 20);
    const m = _computeEnclosingForTesting([wrapper, decl, inner]);
    expect(m.get(wrapper)).toBeUndefined();
    expect(m.get(decl)).toBeUndefined();
    // …and `inner` must still find a real container past the identical pair.
    expect(m.get(inner) === wrapper || m.get(inner) === decl).toBe(true);
    expectAgreement([wrapper, decl, inner], 'identical span');
  });

  it('several identical spans stacked, with a genuine container outside them', () => {
    const outer = node('outer', 0, 100);
    const a = node('x', 10, 40);
    const b = node('x', 10, 40);
    const c = node('x', 10, 40);
    expectAgreement([outer, a, b, c], 'triple identical');
  });

  it('a container that starts at the same offset but ends later', () => {
    const outer = node('outer', 0, 100);
    const inner = node('inner', 0, 40);
    const m = _computeEnclosingForTesting([outer, inner]);
    expect(m.get(inner)).toBe(outer);
    expect(m.get(outer)).toBeUndefined();
    expectAgreement([outer, inner], 'shared start');
  });

  it('a container that ends at the same offset but starts earlier', () => {
    const outer = node('outer', 0, 100);
    const inner = node('inner', 60, 100);
    const m = _computeEnclosingForTesting([outer, inner]);
    expect(m.get(inner)).toBe(outer);
    expectAgreement([outer, inner], 'shared end');
  });

  it('zero-width and single-byte spans', () => {
    const outer = node('outer', 0, 10);
    const empty = node('empty', 5, 5);
    const one = node('one', 7, 8);
    expectAgreement([outer, empty, one], 'degenerate spans');
  });

  it('an empty node set and a single node', () => {
    expect(_computeEnclosingForTesting([]).size).toBe(0);
    const solo = node('solo', 0, 10);
    expect(_computeEnclosingForTesting([solo]).get(solo)).toBeUndefined();
  });

  it('agrees on randomized properly-nested trees', () => {
    // AST spans are properly nested — two nodes never partially overlap — so the generator builds
    // real nestings rather than random intervals. Fixed seed so a failure is reproducible.
    let seed = 0xc0ffee;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let trial = 0; trial < 120; trial++) {
      const nodes: FunctionNode[] = [];
      let counter = 0;

      const build = (lo: number, hi: number, depth: number): void => {
        if (depth > 5 || hi - lo < 4) return;
        nodes.push(node(`n${counter++}`, lo, hi));
        // Occasionally emit an identical-span twin, the wrapper/declaration shape.
        if (rnd() < 0.25) nodes.push(node(`n${counter++}`, lo, hi));
        const children = Math.floor(rnd() * 3);
        let cursor = lo + 1;
        for (let c = 0; c < children && cursor < hi - 2; c++) {
          const width = Math.max(2, Math.floor(rnd() * (hi - cursor - 1)));
          build(cursor, Math.min(cursor + width, hi - 1), depth + 1);
          cursor += width + 1;
        }
      };

      build(0, 200, 0);
      // Shuffle: the sweep must not depend on the caller's ordering.
      for (let i = nodes.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
      }
      expectAgreement(nodes, `random trial ${trial} (${nodes.length} nodes)`);
    }
  });

  it('is not quadratic', () => {
    // The whole point. Every agreement assertion above passes just as happily against the scan
    // this replaced, so without a scaling check the fix could silently not be a fix.
    const build = (n: number): FunctionNode[] =>
      Array.from({ length: n }, (_, i) => node(`f${i}`, i * 10, i * 10 + 9));

    const time = (nodes: FunctionNode[]): number => {
      const t = process.hrtime.bigint();
      _computeEnclosingForTesting(nodes);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };

    // BEST of several runs, not a single sample. A sub-millisecond baseline measured
    // once on a loaded machine is noise, not signal: one GC pause or scheduler
    // preemption during the large run inflated the ratio past the bound and this
    // test failed under a full parallel suite while passing in isolation. Noise only
    // ever ADDS time, so the minimum is the honest estimate of the intrinsic cost —
    // and it leaves the quadratic detector intact (a quadratic implementation is
    // ~64× at its best run too).
    const best = (n: number, runs = 5): number => {
      const nodes = build(n);
      let fastest = Infinity;
      for (let i = 0; i < runs; i++) fastest = Math.min(fastest, time(nodes));
      return Math.max(fastest, 0.01);
    };

    time(build(1000)); // warm
    const small = best(2000);
    const large = best(16000);

    // 8× the nodes. Linear-with-a-sort is ~8-10×; quadratic is ~64×. The bound is loose enough to
    // survive CI noise and still fails by a wide margin if the scan returns.
    expect(large / small, `${small.toFixed(1)}ms -> ${large.toFixed(1)}ms for 8x the nodes`)
      .toBeLessThan(30);
  });
});
