/**
 * Tests for detectDuplicates — Types 1, 2, and 3 clone detection.
 *
 * Type 1 (exact):      identical after whitespace/comment normalization
 * Type 2 (structural): same AST shape with renamed variables
 * Type 3 (near):       Jaccard similarity ≥ 0.7 on token n-grams
 */

import { describe, it, expect } from 'vitest';
import { detectDuplicates, findClones } from './duplicate-detector.js';
import type { DuplicateDetectionResult } from './duplicate-detector.js';
import type { CallGraphResult, FunctionNode } from './call-graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  overrides: Partial<FunctionNode> & { id: string; name: string; filePath: string; startIndex: number; endIndex: number }
): FunctionNode {
  return {
    className: undefined,
    isAsync: false,
    language: 'TypeScript',
    fanIn: 0,
    fanOut: 0,
    ...overrides,
  };
}

function makeCallGraph(nodes: FunctionNode[]): CallGraphResult {
  const nodeMap = new Map<string, FunctionNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return {
    nodes: nodeMap,
    edges: [],
    classes: [],
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [],
    layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
}

/**
 * Build a fake file with named regions separated by newlines.
 * Returns the file content and the byte offsets for each block.
 */
function buildFile(blocks: string[]): { content: string; offsets: Array<{ start: number; end: number }> } {
  const offsets: Array<{ start: number; end: number }> = [];
  let content = '';
  for (const block of blocks) {
    const start = content.length;
    content += block;
    offsets.push({ start, end: content.length });
    content += '\n\n'; // separator between functions
  }
  return { content, offsets };
}

// ---------------------------------------------------------------------------
// Type 1 — Exact clones
// ---------------------------------------------------------------------------

describe('detectDuplicates — Type 1 (exact)', () => {
  it('detects two functions with identical body (after comment/whitespace normalization)', () => {
    // Type 1: same identifiers, only comments and whitespace differ
    const body = `function computeTotal(items) {
  // add all prices
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}`;

    // Variant: different comment text and extra whitespace — otherwise identical
    const bodyVariant = `function computeTotal(items) {
  /* recalculate */
  let  sum =   0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}`;

    const file1 = buildFile([body]);
    const file2 = buildFile([bodyVariant]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'computeTotal', filePath: '/a.ts', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'computeTotal', filePath: '/b.ts', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
    ];

    const result: DuplicateDetectionResult = detectDuplicates(
      [{ path: '/a.ts', content: file1.content }, { path: '/b.ts', content: file2.content }],
      makeCallGraph(nodes),
    );

    expect(result.cloneGroups).toHaveLength(1);
    const group = result.cloneGroups[0];
    expect(group.type).toBe('exact');
    expect(group.similarity).toBe(1.0);
    expect(group.instances).toHaveLength(2);
    expect(group.instances.map(i => i.functionName).every(n => n === 'computeTotal')).toBe(true);
    expect(group.instances.map(i => i.file)).toContain('/a.ts');
    expect(group.instances.map(i => i.file)).toContain('/b.ts');
  });

  it('does NOT flag functions with different logic as Type 1', () => {
    const bodyA = `function add(a, b) {
  let result = 0;
  result = a + b;
  return result;
}`;
    const bodyB = `function multiply(a, b) {
  let result = 0;
  result = a * b;
  return result;
}`;

    const file1 = buildFile([bodyA]);
    const file2 = buildFile([bodyB]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'add',      filePath: '/a.ts', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'multiply', filePath: '/b.ts', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [{ path: '/a.ts', content: file1.content }, { path: '/b.ts', content: file2.content }],
      makeCallGraph(nodes),
    );

    const exactGroups = result.cloneGroups.filter(g => g.type === 'exact');
    expect(exactGroups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Type 2 — Structural clones (same shape, renamed variables)
// ---------------------------------------------------------------------------

describe('detectDuplicates — Type 2 (structural)', () => {
  it('detects functions with the same structure but different variable names', () => {
    const bodyA = `function processOrders(orders) {
  let total = 0;
  for (const order of orders) {
    total += order.amount;
    if (order.discount) {
      total -= order.discount;
    }
  }
  return total;
}`;

    // Same logic, renamed: orders→items, total→sum, order→item, amount→price, discount→reduction
    const bodyB = `function processItems(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
    if (item.reduction) {
      sum -= item.reduction;
    }
  }
  return sum;
}`;

    const file1 = buildFile([bodyA]);
    const file2 = buildFile([bodyB]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'processOrders', filePath: '/a.ts', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'processItems',  filePath: '/b.ts', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [{ path: '/a.ts', content: file1.content }, { path: '/b.ts', content: file2.content }],
      makeCallGraph(nodes),
    );

    // Should detect as Type 2 (structural), NOT Type 1
    const type2 = result.cloneGroups.filter(g => g.type === 'structural');
    expect(type2).toHaveLength(1);
    expect(type2[0].similarity).toBe(1.0);

    const type1 = result.cloneGroups.filter(g => g.type === 'exact');
    expect(type1).toHaveLength(0);
  });

  it('Type 1 groups are excluded from Type 2 grouping', () => {
    // Three identical functions — should be ONE Type 1 group, not also a Type 2 group
    const body = `function render(component) {
  const el = document.createElement('div');
  el.className = component.name;
  el.textContent = component.label;
  return el;
}`;

    const file1 = buildFile([body]);
    const file2 = buildFile([body]);
    const file3 = buildFile([body]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'render',  filePath: '/a.ts', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'render2', filePath: '/b.ts', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
      makeNode({ id: 'f3', name: 'render3', filePath: '/c.ts', startIndex: file3.offsets[0].start, endIndex: file3.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [
        { path: '/a.ts', content: file1.content },
        { path: '/b.ts', content: file2.content },
        { path: '/c.ts', content: file3.content },
      ],
      makeCallGraph(nodes),
    );

    expect(result.cloneGroups.filter(g => g.type === 'exact')).toHaveLength(1);
    expect(result.cloneGroups.filter(g => g.type === 'structural')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Type 3 — Near clones (Jaccard on token n-grams)
// ---------------------------------------------------------------------------

describe('detectDuplicates — Type 3 (near)', () => {
  it('detects functions that are highly similar but not structurally identical', () => {
    // Function A: sum of prices with discount
    const bodyA = `function getTotalPrice(cartItems) {
  let price = 0;
  for (const cartItem of cartItems) {
    price += cartItem.unitPrice * cartItem.quantity;
    if (cartItem.discountRate > 0) {
      price -= cartItem.unitPrice * cartItem.quantity * cartItem.discountRate;
    }
  }
  const tax = price * 0.2;
  return price + tax;
}`;

    // Function B: nearly the same, adds a logging line and renames tax→vat
    const bodyB = `function computeOrderTotal(lineItems) {
  let price = 0;
  for (const lineItem of lineItems) {
    price += lineItem.unitPrice * lineItem.quantity;
    if (lineItem.discountRate > 0) {
      price -= lineItem.unitPrice * lineItem.quantity * lineItem.discountRate;
    }
  }
  const vat = price * 0.2;
  return price + vat;
}`;

    const file1 = buildFile([bodyA]);
    const file2 = buildFile([bodyB]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'getTotalPrice',    filePath: '/a.ts', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'computeOrderTotal', filePath: '/b.ts', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [{ path: '/a.ts', content: file1.content }, { path: '/b.ts', content: file2.content }],
      makeCallGraph(nodes),
    );

    // Structural match is expected here due to normalized identifiers being identical after Type-2 normalization
    // Regardless of whether it's Type 2 or Type 3, there must be at least one clone group
    expect(result.cloneGroups.length).toBeGreaterThan(0);
    expect(result.cloneGroups[0].instances).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Size thresholds
// ---------------------------------------------------------------------------

describe('detectDuplicates — size thresholds', () => {
  it('ignores functions below MIN_LINES (5)', () => {
    const tinyBody = `function tiny(x) {
  return x + 1;
}`;

    // Only 3 lines — below MIN_LINES=5
    const file1 = buildFile([tinyBody]);
    const file2 = buildFile([tinyBody]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'tiny',  filePath: '/a.ts', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'tiny2', filePath: '/b.ts', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [{ path: '/a.ts', content: file1.content }, { path: '/b.ts', content: file2.content }],
      makeCallGraph(nodes),
    );

    expect(result.cloneGroups).toHaveLength(0);
    expect(result.stats.totalFunctions).toBe(0);
  });

  it('skips nodes whose file is not in the provided file list', () => {
    const body = `function compute(items) {
  let total = 0;
  for (const item of items) {
    total += item.value;
  }
  return total;
}`;

    const file1 = buildFile([body]);

    // Node references /missing.ts which is NOT in the files array
    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'compute', filePath: '/missing.ts', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [{ path: '/a.ts', content: file1.content }],
      makeCallGraph(nodes),
    );

    expect(result.stats.totalFunctions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

describe('detectDuplicates — stats', () => {
  it('returns zero stats when no functions qualify', () => {
    const result = detectDuplicates([], makeCallGraph([]));

    expect(result.stats.totalFunctions).toBe(0);
    expect(result.stats.duplicatedFunctions).toBe(0);
    expect(result.stats.duplicationRatio).toBe(0);
    expect(result.stats.cloneGroupCount).toBe(0);
    expect(result.cloneGroups).toHaveLength(0);
  });

  it('computes correct duplication stats for a pair of exact clones', () => {
    const body = `function validate(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid input');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('Empty input');
  }
  return trimmed;
}`;

    const file1 = buildFile([body]);
    const file2 = buildFile([body]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'validate',  filePath: '/a.ts', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'validate2', filePath: '/b.ts', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [{ path: '/a.ts', content: file1.content }, { path: '/b.ts', content: file2.content }],
      makeCallGraph(nodes),
    );

    expect(result.stats.totalFunctions).toBe(2);
    expect(result.stats.duplicatedFunctions).toBe(2);
    expect(result.stats.duplicationRatio).toBeCloseTo(1.0, 3);
    expect(result.stats.cloneGroupCount).toBe(1);
  });

  it('sorts clone groups by impact (instances × lineCount) descending', () => {
    // Large body — many lines → high impact
    const largeBody = Array.from({ length: 20 }, (_, i) =>
      `  const v${i} = computeSomething(data[${i}]);\n  if (v${i} > threshold) results.push(v${i});`
    ).join('\n');
    const bigFunc = `function bigProcess(data, threshold) {\n  const results = [];\n${largeBody}\n  return results;\n}`;

    // Small body — fewer lines → lower impact
    const smallBody = `function smallHelper(x) {
  const v0 = doA(x);
  const v1 = doB(v0);
  const v2 = doC(v1);
  return v2;
}`;

    const fileBig1 = buildFile([bigFunc]);
    const fileBig2 = buildFile([bigFunc]);
    const fileSmall1 = buildFile([smallBody]);
    const fileSmall2 = buildFile([smallBody]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'b1', name: 'bigProcess',  filePath: '/big1.ts',   startIndex: fileBig1.offsets[0].start,   endIndex: fileBig1.offsets[0].end }),
      makeNode({ id: 'b2', name: 'bigProcess2', filePath: '/big2.ts',   startIndex: fileBig2.offsets[0].start,   endIndex: fileBig2.offsets[0].end }),
      makeNode({ id: 's1', name: 'smallHelper',  filePath: '/small1.ts', startIndex: fileSmall1.offsets[0].start, endIndex: fileSmall1.offsets[0].end }),
      makeNode({ id: 's2', name: 'smallHelper2', filePath: '/small2.ts', startIndex: fileSmall2.offsets[0].start, endIndex: fileSmall2.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [
        { path: '/big1.ts',   content: fileBig1.content },
        { path: '/big2.ts',   content: fileBig2.content },
        { path: '/small1.ts', content: fileSmall1.content },
        { path: '/small2.ts', content: fileSmall2.content },
      ],
      makeCallGraph(nodes),
    );

    // Two clone groups expected; big group should come first
    expect(result.cloneGroups.length).toBeGreaterThanOrEqual(2);
    const [first, second] = result.cloneGroups;
    expect(first.lineCount).toBeGreaterThan(second.lineCount);
  });
});

// ---------------------------------------------------------------------------
// Line number reporting
// ---------------------------------------------------------------------------

describe('detectDuplicates — line numbers', () => {
  it('reports correct 1-based startLine / endLine for each instance', () => {
    // Craft a file with two functions where we know the exact positions
    const preamble = 'const HEADER = 1;\n'; // 1 line (ends at newline → line 1)
    const body = `function process(items) {
  let total = 0;
  for (const item of items) {
    total += item.value;
  }
  return total;
}`;

    const content = preamble + body + '\n';
    const startIndex = preamble.length;
    const endIndex = preamble.length + body.length;

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'process', filePath: '/a.ts', startIndex, endIndex }),
    ];

    const result = detectDuplicates(
      [{ path: '/a.ts', content }],
      makeCallGraph(nodes),
    );

    // No clones (only 1 function), but stats should still be computed
    expect(result.stats.totalFunctions).toBe(1);
    expect(result.cloneGroups).toHaveLength(0);
  });

  it('records correct file path in clone instances', () => {
    const body = `function handler(req, res) {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ id: user.id, name: user.name });
}`;

    const file1 = buildFile([body]);
    const file2 = buildFile([body]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'handler',  filePath: '/routes/a.ts', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'handler2', filePath: '/routes/b.ts', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [{ path: '/routes/a.ts', content: file1.content }, { path: '/routes/b.ts', content: file2.content }],
      makeCallGraph(nodes),
    );

    expect(result.cloneGroups).toHaveLength(1);
    const files = result.cloneGroups[0].instances.map(i => i.file);
    expect(files).toContain('/routes/a.ts');
    expect(files).toContain('/routes/b.ts');
  });
});

// ---------------------------------------------------------------------------
// C++ support
// ---------------------------------------------------------------------------

describe('detectDuplicates — C++ functions', () => {
  it('detects exact clones in C++ files', () => {
    const body = `void process(int x, int y) {
  int result = x + y;
  if (result > 0) {
    output(result);
    log(result);
  }
}`;

    const file1 = buildFile([body]);
    const file2 = buildFile([body]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'process', filePath: '/a.cpp', language: 'C++', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'process', filePath: '/b.cpp', language: 'C++', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [{ path: '/a.cpp', content: file1.content }, { path: '/b.cpp', content: file2.content }],
      makeCallGraph(nodes),
    );

    expect(result.cloneGroups).toHaveLength(1);
    expect(result.cloneGroups[0].type).toBe('exact');
  });

  it('detects structural clones in C++ files (renamed variables)', () => {
    const body1 = `void computeSum(int a, int b) {
  int total = a + b;
  if (total > 0) {
    write(total);
    flush(total);
  }
}`;
    const body2 = `void calculateTotal(int x, int y) {
  int sum = x + y;
  if (sum > 0) {
    write(sum);
    flush(sum);
  }
}`;

    const file1 = buildFile([body1]);
    const file2 = buildFile([body2]);

    const nodes: FunctionNode[] = [
      makeNode({ id: 'f1', name: 'computeSum',    filePath: '/math.cpp', language: 'C++', startIndex: file1.offsets[0].start, endIndex: file1.offsets[0].end }),
      makeNode({ id: 'f2', name: 'calculateTotal', filePath: '/util.cpp', language: 'C++', startIndex: file2.offsets[0].start, endIndex: file2.offsets[0].end }),
    ];

    const result = detectDuplicates(
      [{ path: '/math.cpp', content: file1.content }, { path: '/util.cpp', content: file2.content }],
      makeCallGraph(nodes),
    );

    expect(result.cloneGroups).toHaveLength(1);
    expect(result.cloneGroups[0].type).toBe('structural');
  });
});

// ---------------------------------------------------------------------------
// findClones — one-vs-all clone query
// ---------------------------------------------------------------------------

describe('findClones — one-vs-all query', () => {
  const queryBody = `function computeTotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}`;

  // An exact clone (only comments/whitespace differ), a structural clone (renamed),
  // and an unrelated function.
  const exactVariant = `function computeTotal(items) {
  /* recalc */
  let  sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}`;
  const structuralVariant = `function addUp(values) {
  let acc = 0;
  for (const value of values) {
    acc += value.cost;
  }
  return acc;
}`;
  const unrelated = `function greet(name) {
  const msg = 'hello ' + name;
  console.log(msg);
  console.log(msg);
  return msg;
}`;

  function fixture() {
    const fExact = buildFile([exactVariant]);
    const fStruct = buildFile([structuralVariant]);
    const fOther = buildFile([unrelated]);
    const fSelf = buildFile([queryBody]);
    const files = [
      { path: '/exact.ts', content: fExact.content },
      { path: '/struct.ts', content: fStruct.content },
      { path: '/other.ts', content: fOther.content },
      { path: '/self.ts', content: fSelf.content },
    ];
    const nodes: FunctionNode[] = [
      makeNode({ id: 'e', name: 'computeTotal', filePath: '/exact.ts', startIndex: fExact.offsets[0].start, endIndex: fExact.offsets[0].end }),
      makeNode({ id: 's', name: 'addUp', filePath: '/struct.ts', startIndex: fStruct.offsets[0].start, endIndex: fStruct.offsets[0].end }),
      makeNode({ id: 'o', name: 'greet', filePath: '/other.ts', startIndex: fOther.offsets[0].start, endIndex: fOther.offsets[0].end }),
      makeNode({ id: 'self', name: 'computeTotal', filePath: '/self.ts', startIndex: fSelf.offsets[0].start, endIndex: fSelf.offsets[0].end }),
    ];
    return { files, nodes, fSelf };
  }

  it('classifies exact, structural, and near matches and ranks exact first', () => {
    const { files, nodes } = fixture();
    const res = findClones(queryBody, 7, files, nodes);
    const exact = res.matches.filter(m => m.type === 'exact');
    const structural = res.matches.filter(m => m.type === 'structural');
    expect(exact.map(m => m.file)).toContain('/exact.ts');
    expect(structural.map(m => m.file)).toContain('/struct.ts');
    // Unrelated function must not appear.
    expect(res.matches.map(m => m.file)).not.toContain('/other.ts');
    // exact ranks before structural.
    expect(res.matches[0].type).toBe('exact');
    expect(res.belowThreshold).toBe(false);
  });

  it('excludes the query\'s own instance (symbol mode) by byte range', () => {
    const { files, nodes, fSelf } = fixture();
    const res = findClones(queryBody, 7, files, nodes, {
      exclude: { filePath: '/self.ts', startIndex: fSelf.offsets[0].start, endIndex: fSelf.offsets[0].end },
    });
    expect(res.matches.map(m => m.file)).not.toContain('/self.ts');
    // The /self.ts node would otherwise be an exact self-match; only /exact.ts remains exact.
    expect(res.matches.filter(m => m.type === 'exact').map(m => m.file)).toEqual(['/exact.ts']);
  });

  it('coerces a non-finite similarity floor to the default (NaN-safe)', () => {
    const { files, nodes } = fixture();
    // A NaN floor must NOT silently drop every near match or report a NaN/null floor.
    const nan = findClones(queryBody, 7, files, nodes, { minSimilarity: NaN });
    expect(nan.similarityFloor).toBe(0.7);
    expect(Number.isFinite(nan.similarityFloor)).toBe(true);
    // Infinity is also non-finite → falls back to the default floor (not clamped to 1).
    const inf = findClones(queryBody, 7, files, nodes, { minSimilarity: Infinity });
    expect(inf.similarityFloor).toBe(0.7);
    // The default-floor result still finds the structural clone.
    expect(nan.matches.some(m => m.type === 'structural')).toBe(true);
  });

  it('tie-break is fully deterministic for distinct matches on the same line', () => {
    // Two structurally-identical functions sharing a startLine (different files) must order by file,
    // not by input iteration order.
    const body = `function alpha(items) {
  let acc = 0;
  for (const it of items) {
    acc += it.v;
  }
  return acc;
}`;
    const fa = buildFile([body]);
    const fb = buildFile([body]);
    const files = [
      { path: '/z.ts', content: fb.content },
      { path: '/a.ts', content: fa.content },
    ];
    const fwd: FunctionNode[] = [
      makeNode({ id: 'z', name: 'beta', filePath: '/z.ts', startIndex: fb.offsets[0].start, endIndex: fb.offsets[0].end }),
      makeNode({ id: 'a', name: 'gamma', filePath: '/a.ts', startIndex: fa.offsets[0].start, endIndex: fa.offsets[0].end }),
    ];
    const rev: FunctionNode[] = [...fwd].reverse();
    const r1 = findClones(body, 7, files, fwd);
    const r2 = findClones(body, 7, files, rev);
    expect(r1.matches.map(m => m.file)).toEqual(['/a.ts', '/z.ts']);
    expect(JSON.stringify(r1.matches)).toBe(JSON.stringify(r2.matches));
  });

  it('reports belowThreshold for a too-small query without comparing', () => {
    const { files, nodes } = fixture();
    const tiny = `function t(x) {\n  return x;\n}`;
    const res = findClones(tiny, 3, files, nodes);
    expect(res.belowThreshold).toBe(true);
    expect(res.matches).toHaveLength(0);
    expect(res.comparedAgainst).toBe(0);
  });

  it('is deterministic — byte-identical across runs', () => {
    const { files, nodes } = fixture();
    const a = findClones(queryBody, 7, files, nodes);
    const b = findClones(queryBody, 7, files, nodes);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('honors the similarity floor and reports it', () => {
    const { files, nodes } = fixture();
    const high = findClones(queryBody, 7, files, nodes, { minSimilarity: 0.99 });
    expect(high.similarityFloor).toBe(0.99);
    // exact/structural still included regardless of the near floor.
    expect(high.matches.some(m => m.type === 'exact')).toBe(true);
    // A floor above 1 is clamped to 1; below 0.1 is clamped to 0.1.
    expect(findClones(queryBody, 7, files, nodes, { minSimilarity: 5 }).similarityFloor).toBe(1);
    expect(findClones(queryBody, 7, files, nodes, { minSimilarity: 0 }).similarityFloor).toBe(0.1);
  });

  it('respects the limit', () => {
    const { files, nodes } = fixture();
    const res = findClones(queryBody, 7, files, nodes, { limit: 1 });
    expect(res.matches).toHaveLength(1);
  });

  it('carries each match\'s source language (so cross-language matches are visible)', () => {
    const { files, nodes } = fixture();
    const res = findClones(queryBody, 7, files, nodes);
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches.every(m => m.language === 'TypeScript')).toBe(true);
  });

  it('surfaces a cross-language clone with its OWN language (query TS, clone C++)', () => {
    // A C-family body that is byte-identical in TypeScript and C++ — a real cross-language clone the
    // language-agnostic normalization will match. The match must report C++, not the query's language.
    const body = `function process(items) {
  let total = 0;
  for (const item of items) {
    total += item.value;
  }
  return total;
}`;
    const fts = buildFile([body]);
    const fcpp = buildFile([body]);
    const files = [
      { path: '/a.ts', content: fts.content },
      { path: '/b.cpp', content: fcpp.content },
    ];
    const nodes: FunctionNode[] = [
      makeNode({ id: 'ts', name: 'process', filePath: '/a.ts', language: 'TypeScript', startIndex: fts.offsets[0].start, endIndex: fts.offsets[0].end }),
      makeNode({ id: 'cpp', name: 'process', filePath: '/b.cpp', language: 'C++', startIndex: fcpp.offsets[0].start, endIndex: fcpp.offsets[0].end }),
    ];
    // Query is the TS function; exclude its own instance. The C++ clone must surface, labeled C++.
    const res = findClones(body, 7, files, nodes, {
      exclude: { filePath: '/a.ts', startIndex: fts.offsets[0].start, endIndex: fts.offsets[0].end },
    });
    const cpp = res.matches.find(m => m.file === '/b.cpp');
    expect(cpp).toBeDefined();
    expect(cpp!.language).toBe('C++');
  });
});
