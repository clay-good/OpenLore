/**
 * Shingle sets are built only where they can be used (change: bulletproof-background-index).
 *
 * The near-clone pass is O(n²) and is gated to at most `MAX_NEAR_FUNCTIONS` (400) candidates, but
 * the shingle set every comparison needs was built for EVERY function during extraction. Above the
 * gate — which is most real repositories — not one of them was ever read.
 *
 * Measured by a heap probe on a 3,500-file repository: 1,270 MB of shingle strings, entirely
 * unused, and the peak of the whole analyze run. So this is not a micro-optimization; it was the
 * single largest allocation the analyzer made, spent on nothing.
 *
 * Two properties have to hold together, and neither is sufficient alone: the sets must not be built
 * when they cannot be used, AND the clone groups must come out exactly as before. Counting
 * construction is exact and deterministic, where a memory or timing assertion would be flaky.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  detectDuplicates,
  _takeShingleBuildCountForTesting,
} from './duplicate-detector.js';
import type { CallGraphResult } from './call-graph.js';

/** A function body long enough to clear MIN_LINES/MIN_TOKENS, distinct per index. */
const body = (i: number, flavor = 0): string =>
  `function fn${i}(alpha: number, beta: number): number {\n` +
  `  const gamma = alpha + ${i} + ${flavor};\n` +
  `  const delta = beta * ${i};\n` +
  `  if (gamma > delta) {\n` +
  `    return gamma - delta;\n` +
  `  }\n` +
  `  return delta - gamma;\n` +
  `}\n`;

/**
 * Build `count` functions, one per file. `flavor` decides how they differ: the default makes every
 * body IDENTICAL (exact clones), while passing `i => i` makes each one distinct.
 */
function fixture(count: number, flavor: ((i: number) => number) | null = null) {
  const files: Array<{ path: string; content: string }> = [];
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const content = flavor === null ? body(0) : body(i, flavor(i));
    const path = `src/f${i}.ts`;
    files.push({ path, content });
    nodes.push({
      id: `${path}::fn${i}`,
      name: `fn${i}`,
      filePath: path,
      language: 'TypeScript',
      startIndex: 0,
      endIndex: content.length,
    });
  }
  return { files, callGraph: { nodes } as unknown as CallGraphResult };
}

beforeEach(() => { _takeShingleBuildCountForTesting(); });

describe('near-clone shingles are bounded by the gate that uses them', () => {
  it('builds NONE when there are more candidates than the near pass will compare', () => {
    // 800 > MAX_NEAR_FUNCTIONS (400), so the near pass is skipped entirely and every shingle set
    // built during extraction would be pure waste — 800 of them, on a repository of 800 functions.
    const { files, callGraph } = fixture(800, i => i);
    detectDuplicates(files, callGraph);
    expect(
      _takeShingleBuildCountForTesting(),
      'shingles were built for functions the near pass will never compare'
    ).toBe(0);
  });

  it('builds at most one per candidate when the near pass DOES run', () => {
    const { files, callGraph } = fixture(50, i => i);
    detectDuplicates(files, callGraph);
    const built = _takeShingleBuildCountForTesting();
    expect(built).toBeGreaterThan(0);
    expect(built, 'built more sets than there were candidates').toBeLessThanOrEqual(50);
  });

  it('still finds the near-clones it found before', () => {
    // A NEAR clone, specifically: bodies sharing a long common core but differing in how many
    // trailing statements they have. Bodies that differ only in literals do NOT reach this pass —
    // Type-2 normalization collapses them into a structural group first, so a fixture built that
    // way tests nothing about shingles at all (a first draft did exactly that).
    //
    // This is the half a "build nothing" bug would silently break: the counter test above would
    // still pass, and near-clone detection would just quietly stop working.
    const core = Array.from({ length: 14 }, (_, k) => `  const v${k} = compute${k}(input, ${k});`).join('\n');
    const files: Array<{ path: string; content: string }> = [];
    const nodes = [];
    for (let i = 0; i < 4; i++) {
      const extra = Array.from({ length: i }, (_, k) => `  const tail${k} = finalize${k}(v0);`).join('\n');
      const fn = `function proc${i}(input: Payload): Result {\n${core}\n${extra}\n  return assemble(v0, v1);\n}\n`;
      // Surrounding module content that differs STRUCTURALLY per file — a different NUMBER of
      // lines, not just different names. Two things had to be learned here: with one function
      // spanning the whole file, a mutation ignoring the byte span was indistinguishable; and
      // making the headers differ only in identifiers did not help either, because Type-2
      // normalization rewrites identifiers to placeholders, so those headers normalized to
      // identical text. Only a different token COUNT separates whole-file from function-span.
      const header = Array.from({ length: 5 + i * 40 }, (_, k) =>
        `import { thing${k} } from './mod${k}.js';`).join('\n');
      const content = `${header}\n\n${fn}\nexport const marker${i} = ${i};\n`;
      const path = `src/p${i}.ts`;
      files.push({ path, content });
      nodes.push({
        id: `${path}::proc${i}`, name: `proc${i}`, filePath: path,
        language: 'TypeScript',
        startIndex: content.indexOf(fn),
        endIndex: content.indexOf(fn) + fn.length,
      });
    }

    const result = detectDuplicates(files, { nodes } as unknown as CallGraphResult);
    const near = result.cloneGroups.filter(g => g.type === 'near');
    expect(near.length, 'the near pass found nothing — shingles are not reaching it').toBe(1);
    expect(near[0].instances).toHaveLength(4);
    expect(near[0].similarity).toBeGreaterThanOrEqual(0.7);
  });

  it('produces the same result whether or not the gate is crossed', () => {
    // The gate changes only WHETHER the near pass runs. Exact and structural grouping must be
    // untouched by the laziness on either side of it.
    const small = fixture(20);   // identical bodies -> exact clones, under the gate
    const large = fixture(500);  // identical bodies -> exact clones, over the gate

    const a = detectDuplicates(small.files, small.callGraph);
    const b = detectDuplicates(large.files, large.callGraph);

    expect(a.cloneGroups.every(g => g.type === 'exact')).toBe(true);
    expect(b.cloneGroups.every(g => g.type === 'exact')).toBe(true);
    // Exact grouping is hash-based and never needed a shingle: crossing the gate must not change
    // that these are all one group.
    expect(a.stats.duplicatedFunctions).toBe(20);
    expect(b.stats.duplicatedFunctions).toBe(500);
  });
});
