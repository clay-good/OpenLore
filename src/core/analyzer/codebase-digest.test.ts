/**
 * Tests for codebase-digest — generateCodebaseDigest
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCodebaseDigest } from './codebase-digest.js';
import type { LLMContext } from './artifact-generator.js';
import type { SerializedCallGraph } from './call-graph.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCallGraph(overrides: Partial<SerializedCallGraph> = {}): SerializedCallGraph {
  return {
    nodes: [],
    edges: [],
    classes: [],
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [],
    layerViolations: [],
    stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    ...overrides,
  };
}

function makeContext(cg?: SerializedCallGraph): LLMContext {
  return {
    phase1_survey: { purpose: '', files: [], totalTokens: 0 },
    phase2_deep: { purpose: '', files: [], totalTokens: 0 },
    phase3_validation: { purpose: '', files: [], totalTokens: 0 },
    callGraph: cg,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateCodebaseDigest', () => {
  it('returns true and writes CODEBASE.md to outputDir', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const ctx = makeContext();

    const result = await generateCodebaseDigest(ctx, null, { rootPath: tmpDir, outputDir: tmpDir });

    expect(result).toBe(true);
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');
    expect(content).toContain('# Codebase — architecture digest');
    expect(content).toContain('openlore MCP workflow');
  });

  it('includes Overview section when call graph is present', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const cg = makeCallGraph({
      nodes: [
        { id: 'a::fn', name: 'fn', filePath: 'a.ts', fanIn: 0, fanOut: 2, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 100 },
      ],
      stats: { totalNodes: 1, totalEdges: 1, avgFanIn: 0.5, avgFanOut: 0.5 },
    });

    await generateCodebaseDigest(makeContext(cg), null, { rootPath: tmpDir, outputDir: tmpDir });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');

    expect(content).toContain('## Overview');
    expect(content).toContain('**1**');
    expect(content).toContain('avg fan-in');
  });

  it('includes a Language coverage matrix for detected languages', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const cg = makeCallGraph({
      nodes: [
        { id: 'a::fn', name: 'fn', filePath: 'a.ts', fanIn: 0, fanOut: 0, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 1 },
        { id: 'b::fn', name: 'fn', filePath: 'b.go', fanIn: 0, fanOut: 0, isAsync: false, language: 'Go', startIndex: 0, endIndex: 1 },
      ],
      stats: { totalNodes: 2, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    });
    await generateCodebaseDigest(makeContext(cg), null, { rootPath: tmpDir, outputDir: tmpDir });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');
    expect(content).toContain('## Language coverage');
    expect(content).toContain('| Language | signatures | callGraph |');
    expect(content).toMatch(/\| Go \| ✓ \| ✓ \|/);          // Go: signatures + callGraph
    expect(content).toContain('get_language_support');       // points to the runtime tool
  });

  it('includes Entry points section when entryPoints are present', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const cg = makeCallGraph({
      nodes: [],
      entryPoints: [
        { id: 'src/a.ts::start', name: 'start', filePath: `${tmpDir}/src/a.ts`, fanIn: 0, fanOut: 3, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10 },
      ],
    });

    await generateCodebaseDigest(makeContext(cg), null, { rootPath: tmpDir, outputDir: tmpDir });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');

    expect(content).toContain('## Entry points');
    expect(content).toContain('start');
  });

  it('includes "more" row when entry points exceed maxEntryPoints', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `src/a.ts::fn${i}`, name: `fn${i}`, filePath: 'src/a.ts',
      fanIn: 0, fanOut: 1, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10,
    }));
    const cg = makeCallGraph({ entryPoints: entries });

    await generateCodebaseDigest(makeContext(cg), null, { rootPath: tmpDir, outputDir: tmpDir, maxEntryPoints: 8 });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');

    expect(content).toContain('4 more');
  });

  it('includes Critical hubs section when hubFunctions are present', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const cg = makeCallGraph({
      hubFunctions: [
        { id: 'src/core.ts::hub', name: 'hub', filePath: 'src/core.ts', fanIn: 10, fanOut: 2, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10 },
      ],
    });

    await generateCodebaseDigest(makeContext(cg), null, { rootPath: tmpDir, outputDir: tmpDir });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');

    expect(content).toContain('## Critical hubs');
    expect(content).toContain('hub');
  });

  it('includes God functions section when nodes with high fanOut exist', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const cg = makeCallGraph({
      nodes: [
        { id: 'src/god.ts::godFn', name: 'godFn', filePath: 'src/god.ts', fanIn: 1, fanOut: 12, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10 },
      ],
    });

    await generateCodebaseDigest(makeContext(cg), null, { rootPath: tmpDir, outputDir: tmpDir });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');

    expect(content).toContain('## God functions');
    expect(content).toContain('godFn');
  });

  it('excludes test and external nodes from god functions and overview counts', async () => {
    // Regression (#138): on Java projects, a high-fan-out test helper such as
    // FooTest.checkOption was surfacing as a "god function" and inflating the
    // function/entry-point counts. The digest is production-only.
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const cg = makeCallGraph({
      nodes: [
        { id: 'src/main/Prod.java::Prod.orchestrate', name: 'orchestrate', className: 'Prod', filePath: 'src/main/Prod.java', fanIn: 1, fanOut: 12, isAsync: false, language: 'Java', startIndex: 0, endIndex: 10 },
        { id: 'src/test/FooTest.java::FooTest.checkOption', name: 'checkOption', className: 'FooTest', filePath: 'src/test/FooTest.java', fanIn: 0, fanOut: 27, isAsync: false, language: 'Java', startIndex: 0, endIndex: 10, isTest: true },
        { id: 'java.util.List::add', name: 'add', filePath: 'java.util.List', fanIn: 0, fanOut: 9, isAsync: false, language: 'Java', startIndex: 0, endIndex: 10, isExternal: true },
      ],
      entryPoints: [
        { id: 'src/main/Prod.java::Prod.orchestrate', name: 'orchestrate', className: 'Prod', filePath: 'src/main/Prod.java', fanIn: 0, fanOut: 12, isAsync: false, language: 'Java', startIndex: 0, endIndex: 10 },
      ],
    });

    await generateCodebaseDigest(makeContext(cg), null, { rootPath: tmpDir, outputDir: tmpDir });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');

    // God functions: production orchestrator only — no test helper, no library call.
    expect(content).toContain('orchestrate');
    expect(content).not.toContain('checkOption');
    expect(content).not.toContain('java.util.List');
    // Overview counts production nodes (1) and the filtered entry-point list (1).
    expect(content).toContain('**1** functions / methods analyzed');
    expect(content).toContain('**1** entry points');
  });

  it('includes layer violations section when violations are present', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const cg = makeCallGraph({
      layerViolations: [
        { callerId: 'a::fn', calleeId: 'b::fn', callerLayer: 'api', calleeLayer: 'db', reason: 'name_only' },
      ],
    });

    await generateCodebaseDigest(makeContext(cg), null, { rootPath: tmpDir, outputDir: tmpDir });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');

    expect(content).toContain('## Layer violations');
    expect(content).toContain('api');
  });

  it('includes Most imported files section when depGraph is provided', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));

    const depGraph = {
      nodes: [
        { id: 'n1', file: { path: 'src/constants.ts', absolutePath: '/proj/src/constants.ts' }, metrics: { inDegree: 5, outDegree: 0 } },
      ],
      edges: [],
    } as never;

    await generateCodebaseDigest(makeContext(), depGraph, { rootPath: tmpDir, outputDir: tmpDir });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');

    expect(content).toContain('## Most imported files');
    expect(content).toContain('src/constants.ts');
  });

  it('returns false when writeFile fails (outputDir does not exist)', async () => {
    const ctx = makeContext();
    const result = await generateCodebaseDigest(ctx, null, {
      rootPath: '/nonexistent',
      outputDir: '/nonexistent/deep/path/that/does/not/exist',
    });
    expect(result).toBe(false);
  });

  it('uses className in entry point name when present', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'digest-test-'));
    const cg = makeCallGraph({
      entryPoints: [
        { id: 'src/a.ts::MyClass.start', name: 'start', className: 'MyClass', filePath: 'src/a.ts', fanIn: 0, fanOut: 1, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10 },
      ],
    });

    await generateCodebaseDigest(makeContext(cg), null, { rootPath: tmpDir, outputDir: tmpDir });
    const content = await readFile(join(tmpDir, 'CODEBASE.md'), 'utf-8');

    expect(content).toContain('MyClass.start');
  });
});
