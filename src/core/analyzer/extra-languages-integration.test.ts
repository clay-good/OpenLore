import { describe, it, expect } from 'vitest';
import { __setGrammarImporterForTests } from './grammar-entry.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, __resetGrammarCacheForTests, type SerializedCallGraph } from './call-graph.js';
import { resolveHeaderLanguage } from './signature-extractor.js';

const dir = join(__dirname, 'fixtures');
const load = (rel: string, language: string) => ({ path: rel, content: readFileSync(join(dir, rel), 'utf-8'), language });
const edge = (g: SerializedCallGraph, caller: string, callee: string) => {
  const c = g.nodes.find(n => n.name === caller);
  const d = g.nodes.find(n => n.name === callee && !n.isExternal);
  return !!c && !!d && g.edges.some(e => e.callerId === c.id && e.calleeId === d.id);
};

describe('spec-08 .h disambiguation', () => {
  it('C-only project → header is C; project with C++ sources → header is C++', () => {
    expect(resolveHeaderLanguage(true, false)).toBe('C');   // .c present, no C++
    expect(resolveHeaderLanguage(true, true)).toBe('C++');  // .cpp present
    expect(resolveHeaderLanguage(false, false)).toBe('C++'); // standalone → default C++
  });
});

describe('spec-08 polyglot integration (tools unchanged)', () => {
  it('surfaces nodes/edges across multiple new languages in one graph', async () => {
    const files = [
      load('polyglot/svc.cs', 'C#'),
      load('polyglot/util.c', 'C'),
      load('polyglot/deploy.sh', 'Bash'),
      load('polyglot/main.scala', 'Scala'),
      { path: 'polyglot/app.ts', content: 'export function boot(){ return run(); }\nfunction run(){ return 1; }', language: 'TypeScript' },
    ];
    const g = serializeCallGraph(await new CallGraphBuilder().build(files));
    // Each language contributes nodes.
    for (const lang of ['C#', 'C', 'Bash', 'Scala', 'TypeScript']) {
      expect(g.nodes.some(n => n.language === lang && !n.isExternal)).toBe(true);
    }
    // Intra-language edges resolve in each.
    expect(edge(g, 'A', 'B')).toBe(true);           // C#
    expect(edge(g, 'driver', 'helper')).toBe(true); // C
    expect(edge(g, 'deploy', 'setup')).toBe(true);  // Bash
    expect(edge(g, 'start', 'init')).toBe(true);    // Scala
    expect(edge(g, 'boot', 'run')).toBe(true);      // TS still works (no regression)
  });
});

describe('spec-08 graceful degradation', () => {
  it('an unavailable grammar degrades without aborting analyze or other languages', async () => {
    __resetGrammarCacheForTests();
    // Grammars are imported by resolved entry FILE now (DEP0151), so a
    // specifier-keyed module mock no longer intercepts them — use the importer seam.
    __setGrammarImporterForTests((specifier, loadReal) => {
      if (specifier === 'tree-sitter-c-sharp') throw new Error('simulated missing grammar');
      return loadReal(specifier);
    });
    const files = [
      load('polyglot/svc.cs', 'C#'),  // grammar simulated-unavailable → no nodes
      load('polyglot/util.c', 'C'),    // unaffected
    ];
    const g = serializeCallGraph(await new CallGraphBuilder().build(files));
    expect(g.nodes.some(n => n.language === 'C#' && !n.isExternal)).toBe(false);
    expect(g.nodes.some(n => n.language === 'C' && !n.isExternal)).toBe(true);
    expect(edge(g, 'driver', 'helper')).toBe(true);
    __setGrammarImporterForTests(null);
    __resetGrammarCacheForTests();
  });
});

describe('spec-08 determinism', () => {
  it('re-analyzing an unchanged tree yields an identical graph per language', async () => {
    for (const [rel, lang] of [['csharp/App.cs', 'C#'], ['c/app.c', 'C'], ['scala/App.scala', 'Scala'], ['php/app.php', 'PHP'], ['bash/app.sh', 'Bash'], ['elixir/app.ex', 'Elixir']] as const) {
      const a = serializeCallGraph(await new CallGraphBuilder().build([load(rel, lang)]));
      const b = serializeCallGraph(await new CallGraphBuilder().build([load(rel, lang)]));
      const norm = (g: SerializedCallGraph) => ({
        nodes: g.nodes.map(n => n.id).sort(),
        edges: g.edges.map(e => `${e.callerId}|${e.calleeId}|${e.kind ?? 'calls'}`).sort(),
      });
      expect(norm(a)).toEqual(norm(b));
    }
  });
});
