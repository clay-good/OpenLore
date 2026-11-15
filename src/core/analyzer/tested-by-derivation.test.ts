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

  it('derives tested_by from a test that loads its module with a dynamic import', async () => {
    // The module is loaded after mocks are set up: no static import, and the calls sit inside
    // anonymous `it` callbacks that have no node. Before, no edge reached these tests.
    const files = [
      { path: 'src/calc.ts', content: 'export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\nexport function mul(a: number, b: number) { return a * b; }\n', language: 'TypeScript' },
      { path: 'src/a.test.ts', content: 'const { add } = await import("./calc.js");\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n', language: 'TypeScript' },
      { path: 'src/b.test.ts', content: 'async function load() { return (await import("./calc.js")).sub; }\nit("subs", async () => { expect((await load())(2, 1)).toBe(1); });\n', language: 'TypeScript' },
      { path: 'src/c.test.ts', content: 'const calc = await import("./calc.js");\nit("muls", () => { expect(calc.mul(2, 3)).toBe(6); });\n', language: 'TypeScript' },
    ];
    const cg = serializeCallGraph(await new CallGraphBuilder().build(files));
    const testedBy = (name: string) => cg.edges
      .filter(e => e.kind === 'tested_by' && e.callerId === `src/calc.ts::${name}`)
      .map(e => e.calleeId);
    expect(testedBy('add')).toContain('src/a.test.ts::*');
    expect(testedBy('sub')).toContain('src/b.test.ts::*');
    expect(testedBy('mul')).toContain('src/c.test.ts::*');
  });

  it('an imported object literal links its methods; a renamed import links the original name', async () => {
    const files = [
      { path: 'src/adapter.ts', content: 'export const adapter = {\n  name: "x",\n  async apply(ctx) { return write(ctx); },\n  uninstall() { return 1; },\n};\nexport function outside() { return 2; }\nfunction write(c) { return c; }\n', language: 'TypeScript' },
      { path: 'src/calc.ts', content: 'export function add(a: number, b: number) { return a + b; }\n', language: 'TypeScript' },
      { path: 'src/adapter.test.ts', content: 'import { adapter } from "./adapter.js";\nit("applies", async () => { await adapter.apply({}); });\n', language: 'TypeScript' },
      { path: 'src/calc.test.ts', content: 'import { add as plus } from "./calc.js";\nit("adds", () => { expect(plus(1, 2)).toBe(3); });\n', language: 'TypeScript' },
    ];
    const cg = serializeCallGraph(await new CallGraphBuilder().build(files));
    const testedBy = (id: string) => cg.edges.filter(e => e.kind === 'tested_by' && e.callerId === id).map(e => e.calleeId);
    const methodId = (name: string) => cg.nodes.find(n => n.filePath === 'src/adapter.ts' && n.name === name)!.id;
    expect(testedBy(methodId('apply'))).toContain('src/adapter.test.ts::*');
    expect(testedBy(methodId('uninstall'))).toContain('src/adapter.test.ts::*');
    expect(testedBy(methodId('outside'))).not.toContain('src/adapter.test.ts::*');
    expect(testedBy('src/calc.ts::add')).toContain('src/calc.test.ts::*');
  });

  it('an imported class links its methods', async () => {
    // The methods are called inside anonymous `it` callbacks, which have no node.
    const files = [
      { path: 'src/watcher.ts', content: 'export class Watcher {\n  start() { return 1; }\n  stop() { return 2; }\n}\nexport function helper() { return 3; }\n', language: 'TypeScript' },
      { path: 'src/watcher.test.ts', content: 'import { Watcher } from "./watcher.js";\nit("starts", () => { const w = new Watcher(); expect(w.start()).toBe(1); w.stop(); });\n', language: 'TypeScript' },
    ];
    const cg = serializeCallGraph(await new CallGraphBuilder().build(files));
    const linked = cg.edges.filter(e => e.kind === 'tested_by' && e.calleeId === 'src/watcher.test.ts::*').map(e => e.callerId).sort();
    expect(linked).toEqual(expect.arrayContaining(['src/watcher.ts::Watcher.start', 'src/watcher.ts::Watcher.stop']));
    expect(linked).not.toContain('src/watcher.ts::helper');
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
