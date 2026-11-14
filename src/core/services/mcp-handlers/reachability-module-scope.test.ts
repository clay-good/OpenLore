/**
 * find_dead_code and calls the call graph cannot see: made at module scope, or made by whatever
 * receives a function defined inside a live one.
 *
 * Module-level code has no call-graph node, so a top-level `start()` or
 * `process.on('exit', cleanup)` is no edge, and the function it names looked uncalled. On OpenLore's
 * own index that rated `die`, `send` and a worker's `start` high-confidence dead. Drives the real
 * handler over an llm-context fixture and real source files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT, ARTIFACT_DEPENDENCY_GRAPH } from '../../../constants.js';
import { handleFindDeadCode } from './reachability.js';
import type { FunctionNode, CallEdge } from '../../analyzer/call-graph.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-module-scope-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const node = (file: string, name: string, startLine: number, endLine: number): FunctionNode => ({
  id: `${file}::${name}`, name, filePath: file, isAsync: false, language: 'TypeScript',
  startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, startLine, endLine,
});

async function setup(files: Record<string, string>, nodes: FunctionNode[], edges: CallEdge[] = []): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), text);
  }
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const callGraph = { nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 } };
  await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }), 'utf-8');
  // A dependency graph that names neither candidate, so the ladder can reach `high`.
  await writeFile(join(dir, ARTIFACT_DEPENDENCY_GRAPH), JSON.stringify({
    nodes: [{ id: 'a', file: { path: 'other/a.ts' } }, { id: 'b', file: { path: 'other/b.ts' } }],
    edges: [{ source: 'a', target: 'b', importedNames: ['SomethingElse'] }],
  }), 'utf-8');
}

type Candidate = { name: string; confidence: string; reason: string };
const run = async () => ((await handleFindDeadCode({ directory: root })) as { candidateDead: Candidate[] }).candidateDead;

describe('find_dead_code with module-scope calls', () => {
  it('caps a function its own file calls at module scope, and leaves an unused one high', async () => {
    await setup({
      'scripts/report.ts': [
        'function die(message: string): never {', // 1
        '  throw new Error(message);',               // 2
        '}',                                         // 3
        'function unused(): void {',                 // 4
        '  return;',                                 // 5
        '}',                                         // 6
        'if (!process.argv[2]) die("usage");',       // 7
      ].join('\n'),
    }, [node('scripts/report.ts', 'die', 1, 3), node('scripts/report.ts', 'unused', 4, 6)]);
    const by = Object.fromEntries((await run()).map(c => [c.name, c]));
    expect(by.die.confidence).toBe('low');
    expect(by.die.reason).toContain('names it at module scope (line 7)');
    expect(by.unused.confidence).toBe('high');
  });

  it('does not count a use inside another function as module scope', async () => {
    await setup({
      'src/a.ts': [
        'function helper(): number {', // 1
        '  return 1;',                 // 2
        '}',                           // 3
        'function caller(): number {', // 4
        '  return helper();',          // 5
        '}',                           // 6
      ].join('\n'),
    }, [node('src/a.ts', 'helper', 1, 3), node('src/a.ts', 'caller', 4, 6)]);
    const by = Object.fromEntries((await run()).map(c => [c.name, c]));
    expect(by.helper.reason).not.toContain('module scope');
  });

  it('caps a function defined inside a LIVE function (a returned visitor), but not inside a dead one', async () => {
    // A validation rule factory returns `{ Field() {…}, leave() {…} }`; graphql-js
    // calls them. They have no in-repo caller and were rated high.
    await setup({
      'src/rule.ts': [
        'export function main() {',        // 1  (a root: main-like)
        '  return {',                       // 2
        '    Field() { return 1; },',       // 3
        '  };',                             // 4
        '}',                                // 5
        'function unusedOuter() {',         // 6
        '  return { Leave() { return 2; } };', // 7
        '}',                                // 8
      ].join('\n'),
    }, [
      node('src/rule.ts', 'main', 1, 5), node('src/rule.ts', 'Field', 3, 3),
      node('src/rule.ts', 'unusedOuter', 6, 8), node('src/rule.ts', 'Leave', 7, 7),
    ]);
    const by = Object.fromEntries((await run()).map(c => [c.name, c]));
    expect(by.Field.confidence).toBe('low');
    expect(by.Field.reason).toContain('defined inside `main`, which is live');
    expect(by.Leave.reason).not.toContain('defined inside');
  });

  it('caps the constructor of a class whose members are live (`new X()` is not a call edge)', async () => {
    await setup({
      'src/ctx.ts': [
        'class Ctx {',                        // 1
        '  constructor(readonly n: number) {}', // 2
        '  run() { return this.n; }',           // 3
        '}',                                  // 4
        'export function main() { return new Ctx(1).run(); }', // 5
      ].join('\n'),
    }, [
      { ...node('src/ctx.ts', 'constructor', 2, 2), id: 'src/ctx.ts::Ctx.constructor', className: 'Ctx' },
      { ...node('src/ctx.ts', 'run', 3, 3), id: 'src/ctx.ts::Ctx.run', className: 'Ctx', fanIn: 1 },
      node('src/ctx.ts', 'main', 5, 5),
    ], [{ callerId: 'src/ctx.ts::main', calleeId: 'src/ctx.ts::Ctx.run', calleeName: 'run', confidence: 'receiver_inferred' }]);
    const ctor = (await run()).find(c => c.name === 'constructor')!;
    expect(ctor.confidence).toBe('low');
    expect(ctor.reason).toContain('`new Ctx(…)` is not a call edge');
  });
});
