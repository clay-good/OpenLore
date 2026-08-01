/**
 * Cycle detection over the dependency graph (`detectDependencyCycles`).
 *
 * Two properties are locked down here:
 *  1. The iterative implementation is BEHAVIOR-IDENTICAL to the recursive one it replaced — proven
 *     against a reference copy of the original recursion over many random graphs.
 *  2. It does not overflow the call stack on a deep dependency chain — the crash it was written to
 *     fix. A recursive walk aborts `analyze` for the whole repository on a chain of a few thousand
 *     files (`RangeError: Maximum call stack size exceeded`); this must survive tens of thousands.
 */
import { describe, it, expect } from 'vitest';
import { detectDependencyCycles } from './dependency-graph.js';

type Adj = Map<string, Set<string>>;

/**
 * The ORIGINAL recursive implementation, verbatim, as the equivalence oracle. If the iterative
 * rewrite ever diverges from this on any input, the property test below fails.
 */
function detectCyclesRecursive(adjacencyList: Adj, nodeIds: Iterable<string>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  const normalize = (cycle: string[]): string => {
    const clean = cycle.slice(0, -1);
    if (clean.length === 0) return '';
    const minIdx = clean.indexOf(clean.reduce((min, curr) => (curr < min ? curr : min)));
    return [...clean.slice(minIdx), ...clean.slice(0, minIdx)].join('|');
  };
  const isDuplicate = (existing: string[][], nc: string[]): boolean => {
    const n = normalize(nc);
    return existing.some(e => normalize(e) === n);
  };

  const dfs = (node: string): void => {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);
    for (const neighbor of adjacencyList.get(node) ?? new Set<string>()) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recursionStack.has(neighbor)) {
        const cycle = path.slice(path.indexOf(neighbor));
        cycle.push(neighbor);
        if (!isDuplicate(cycles, cycle)) cycles.push(cycle);
      }
    }
    path.pop();
    recursionStack.delete(node);
  };

  for (const nodeId of nodeIds) {
    if (!visited.has(nodeId)) dfs(nodeId);
  }
  return cycles;
}

/** Deterministic LCG so the random graphs are identical on every run. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A random directed graph over `n` nodes with the given edge probability. */
function randomGraph(n: number, edgeProb: number, rng: () => number): { adj: Adj; ids: string[] } {
  // Non-sequential, varied ids so normalizeCycle's lexicographic-min rotation is actually exercised.
  const ids = Array.from({ length: n }, (_, i) => `mod-${((i * 7 + 3) % n)}-${i}`);
  const adj: Adj = new Map(ids.map(id => [id, new Set<string>()]));
  for (const a of ids) {
    for (const b of ids) {
      if (rng() < edgeProb) adj.get(a)!.add(b); // self-loops and back-edges both allowed
    }
  }
  return { adj, ids };
}

describe('detectDependencyCycles — identical to the recursive original', () => {
  it('matches the recursive oracle across 200 random graphs (nodes, edges, order, dedup)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = makeRng(seed);
      const n = 2 + Math.floor(rng() * 9);       // 2..10 nodes
      const p = 0.15 + rng() * 0.5;              // varying density
      const { adj, ids } = randomGraph(n, p, rng);
      const got = detectDependencyCycles(adj, ids);
      const want = detectCyclesRecursive(adj, ids);
      // Full structural equality: same cycles, same order within and between, same dedup outcome.
      expect(got, `seed ${seed} (n=${n})`).toEqual(want);
    }
  });

  it('handles the hand cases: direct, indirect, self-loop, disjoint, and rotation dedup', () => {
    const cases: Adj[] = [
      new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]),                       // a<->b
      new Map([['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set(['a'])]]), // a->b->c->a
      new Map([['a', new Set(['a'])]]),                                               // self-loop
      new Map([['a', new Set(['b'])], ['b', new Set()], ['c', new Set(['c'])]]),      // one dead, one self
      new Map([['a', new Set(['b'])], ['b', new Set(['a', 'c'])], ['c', new Set(['b'])]]), // two overlapping 2-cycles
    ];
    for (const [i, adj] of cases.entries()) {
      const ids = [...adj.keys()];
      expect(detectDependencyCycles(adj, ids), `case ${i}`).toEqual(detectCyclesRecursive(adj, ids));
    }
  });
});

describe('detectDependencyCycles — no fatal crash on a deep chain (the bug it fixes)', () => {
  const DEEP = 50_000;

  function linearChain(n: number, closeTheLoop: boolean): { adj: Adj; ids: string[] } {
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const adj: Adj = new Map(ids.map(id => [id, new Set<string>()]));
    for (let i = 0; i < n - 1; i++) adj.get(ids[i])!.add(ids[i + 1]); // n0 -> n1 -> ... -> n(last)
    if (closeTheLoop) adj.get(ids[n - 1])!.add(ids[0]);               // ...-> n0, one giant cycle
    return { adj, ids };
  }

  it('completes on a 50,000-deep acyclic chain and reports no cycle', () => {
    const { adj, ids } = linearChain(DEEP, false);
    let cycles: string[][] | undefined;
    expect(() => { cycles = detectDependencyCycles(adj, ids); }).not.toThrow();
    expect(cycles).toEqual([]);
  });

  it('completes on a 50,000-deep chain that closes into one cycle and reports exactly that cycle', () => {
    const { adj, ids } = linearChain(DEEP, true);
    let cycles: string[][] | undefined;
    expect(() => { cycles = detectDependencyCycles(adj, ids); }).not.toThrow();
    expect(cycles).toHaveLength(1);
    expect(cycles![0]).toHaveLength(DEEP + 1);      // every node once, plus the repeated closing node
    expect(cycles![0][0]).toBe('n0');
    expect(cycles![0][DEEP]).toBe('n0');
  });

  it("proves the depth is real: the old recursive walk overflows where the new one doesn't", () => {
    // Guards against a fixture that never actually stressed the stack — if this input did not
    // overflow recursion, the no-crash test above would be vacuous.
    const { adj, ids } = linearChain(DEEP, false);
    expect(() => detectCyclesRecursive(adj, ids)).toThrow(RangeError);
  });
});
