import { describe, expect, it } from 'vitest';
import type { FunctionNode } from './call-graph-types.js';
import {
  combineStaleFileCompositions,
  composeStaleFiles,
  formatStaleRegionComposition,
  spendClosureBudget,
} from './incremental-closure.js';

function node(filePath: string, name: string, fanIn: number, fanOut: number, isTest = false): FunctionNode {
  return {
    id: `${filePath}::${name}`, name, filePath, language: 'TypeScript', isAsync: false,
    startIndex: 0, endIndex: 1, fanIn, fanOut, isTest,
  };
}

describe('incremental closure significance', () => {
  it('spends an over-budget phase on the highest fan-in files deterministically', () => {
    const candidates = ['src/leaf-b.ts', 'src/hub.ts', 'src/leaf-a.ts'];
    const nodes = [
      node('src/leaf-a.ts', 'a', 1, 1),
      node('src/leaf-b.ts', 'b', 1, 1),
      node('src/hub.ts', 'hub', 12, 2),
    ];
    expect(spendClosureBudget(candidates, 2, nodes)).toEqual({
      selected: ['src/hub.ts', 'src/leaf-a.ts'], dropped: ['src/leaf-b.ts'], usedPathFallback: false,
    });
    expect(spendClosureBudget(candidates, 2, nodes)).toEqual(spendClosureBudget(candidates, 2, nodes));
  });

  it('uses the same winning node fan-out, ranks node-less files last, and preserves under-budget order', () => {
    const candidates = ['src/none.ts', 'src/b.ts', 'src/a.ts'];
    const nodes = [
      node('src/a.ts', 'winner', 5, 2),
      node('src/a.ts', 'wider-but-lower', 4, 99),
      node('src/b.ts', 'winner', 5, 1),
    ];
    expect(spendClosureBudget(candidates, 2, nodes).selected).toEqual(['src/a.ts', 'src/b.ts']);
    expect(spendClosureBudget(candidates, 2, nodes).usedPathFallback).toBe(true);
    expect(spendClosureBudget(candidates, 3, nodes).selected).toEqual(candidates);
  });

  it('reserves a bounded slot for test callers in an over-budget mixed phase', () => {
    const candidates = ['src/hub.ts', 'src/leaf.ts', 'test/hub.test.ts'];
    const nodes = [
      node('src/hub.ts', 'hub', 20, 2), node('src/leaf.ts', 'leaf', 3, 1),
      node('test/hub.test.ts', 'testHub', 0, 7, true),
    ];
    expect(spendClosureBudget(candidates, 2, nodes).selected).toEqual(['src/hub.ts', 'test/hub.test.ts']);
  });
});

describe('stale-region composition', () => {
  it('counts hubs and chokepoints and safely renders the top symbol', () => {
    const files = ['src/a.ts', 'src/b.ts'];
    const perFile = composeStaleFiles(files, [
      node('src/a.ts', '\u001b[2Jforge\nline', 9, 2),
      node('src/a.ts', 'wide', 5, 9),
      node('src/b.ts', 'leaf', 1, 0),
    ]);
    const composition = combineStaleFileCompositions([...perFile.values()], files.length);
    expect(composition).toMatchObject({ fileCount: 2, symbolCount: 3, hubCount: 2, chokepointCount: 1 });
    expect(composition.topSymbol?.name).toContain('\u001b');
    expect(formatStaleRegionComposition(composition)).toBe(
      '2 files, 2 hubs, 1 chokepoint, top [2Jforgeline (src/a.ts)',
    );
  });
});
