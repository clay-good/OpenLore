/**
 * Regression guards for tested_by derivation — the data `select_tests` (spec-19)
 * depends on. Two bugs (both from the relative-path normalization change) silently
 * zeroed it out on every real analyze:
 *   A. the analyze pipeline EXCLUDED test files from the call graph, and
 *   B. the import-based resolver used an absolute path that never matched the
 *      pipeline's relative file paths.
 * These tests reproduce the REAL pipeline form (repo-relative paths + co-located
 * test files) so neither can recur unnoticed.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CallGraphBuilder, serializeCallGraph } from './call-graph.js';

describe('tested_by derivation — relative paths (bug B)', () => {
  it('derives an import-based tested_by edge with repo-relative paths', async () => {
    // Repo-relative paths — exactly what the analyze pipeline passes. With the old
    // resolve()-to-absolute resolver, this produced ZERO tested_by edges.
    const files = [
      { path: 'src/calc.ts', content: 'export function add(a: number, b: number): number { return a + b; }\n', language: 'TypeScript' },
      {
        path: 'src/calc.test.ts',
        content: 'import { add } from "./calc.js";\nimport { describe, it, expect } from "vitest";\ndescribe("calc", () => { it("adds", () => { expect(add(1, 2)).toBe(3); }); });\n',
        language: 'TypeScript',
      },
    ];
    const cg = serializeCallGraph(await new CallGraphBuilder().build(files));
    const add = cg.nodes.find(n => n.name === 'add')!;
    const testedBy = cg.edges.filter(e => e.kind === 'tested_by');
    expect(testedBy.length).toBeGreaterThan(0);
    expect(testedBy.some(e => e.callerId === add.id)).toBe(true);
  });

  it('marks newly supported language conventions and derives tested_by edges', async () => {
    const files = [
      { path: 'lib/calc.rb', content: 'def add(a, b)\n  a + b\nend\n', language: 'Ruby' },
      { path: 'spec/models/calc_spec.rb', content: 'def verifies_add\n  add(1, 2)\nend\n', language: 'Ruby' },
      { path: 'src/Calc.cs', content: 'class Calc { int Add(int a, int b) { return a + b; } }', language: 'C#' },
      { path: 'src/CalcTests.cs', content: 'class CalcTests { int VerifiesAdd() { return Add(1, 2); } }', language: 'C#' },
    ];

    const cg = serializeCallGraph(await new CallGraphBuilder().build(files));
    for (const path of ['spec/models/calc_spec.rb', 'src/CalcTests.cs']) {
      expect(cg.nodes.some(node => node.filePath === path && node.isTest), path).toBe(true);
    }
    expect(cg.edges.some(edge => edge.kind === 'tested_by' && edge.callerId.endsWith('::add'))).toBe(true);
    expect(cg.edges.some(edge => edge.kind === 'tested_by' && edge.callerId.endsWith('::Calc.Add'))).toBe(true);
  });
});

describe('tested_by derivation — full analyze pipeline (bugs A + B)', () => {
  it('a real analyze includes test files and produces tested_by edges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tested-by-pipeline-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'calc.ts'), 'export function multiply(a: number, b: number): number { return a * b; }\n');
      await writeFile(
        join(dir, 'src', 'calc.test.ts'),
        'import { multiply } from "./calc.js";\nimport { describe, it, expect } from "vitest";\ndescribe("calc", () => { it("multiplies", () => { expect(multiply(2, 3)).toBe(6); }); });\n',
      );

      const { runAnalysis } = await import('../../cli/commands/analyze.js');
      const outputPath = join(dir, '.openlore', 'analysis');
      await runAnalysis(dir, outputPath, { maxFiles: 50, include: [], exclude: [] });

      const ctx = JSON.parse(await readFile(join(outputPath, 'llm-context.json'), 'utf-8')) as {
        callGraph?: { nodes: Array<{ name: string; isTest?: boolean; filePath: string }>; edges: Array<{ kind?: string; callerId: string }> };
      };
      const cg = ctx.callGraph!;
      expect(cg).toBeTruthy();
      // Bug A: the test file must be analyzed (its presence yields tested_by).
      // Bug A+B: the production fn must be tested_by the test file.
      const multiply = cg.nodes.find(n => n.name === 'multiply');
      expect(multiply, 'production function should be in the graph').toBeTruthy();
      const testedBy = cg.edges.filter(e => e.kind === 'tested_by');
      expect(testedBy.length, 'analyze must produce tested_by edges (select_tests depends on it)').toBeGreaterThan(0);
      expect(testedBy.some(e => e.callerId === multiply!.name || e.callerId.endsWith('::multiply'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
