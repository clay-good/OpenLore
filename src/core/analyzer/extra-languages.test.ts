import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from './call-graph.js';

const dir = join(__dirname, 'fixtures');

async function buildOne(rel: string, language: string): Promise<SerializedCallGraph> {
  const content = readFileSync(join(dir, rel), 'utf-8');
  const result = await new CallGraphBuilder().build([{ path: rel, content, language }]);
  return serializeCallGraph(result);
}
const fnNames = (g: SerializedCallGraph, lang: string) =>
  g.nodes.filter(n => n.language === lang && !n.isExternal).map(n => n.name).sort();
const edge = (g: SerializedCallGraph, caller: string, callee: string) => {
  const c = g.nodes.find(n => n.name === caller);
  const d = g.nodes.find(n => n.name === callee && !n.isExternal);
  return !!c && !!d && g.edges.some(e => e.callerId === c.id && e.calleeId === d.id);
};

describe('spec-08 additional languages', () => {
  it('C# — phantom bug fixed: real nodes, classes, and edges', async () => {
    const g = await buildOne('csharp/App.cs', 'C#');
    expect(fnNames(g, 'C#')).toEqual(['Boot', 'Helper', 'Log', 'Run']);
    expect(edge(g, 'Run', 'Helper')).toBe(true);   // this.Helper()
    expect(edge(g, 'Run', 'Log')).toBe(true);      // Util.Log() static call
    // ClassNode groups its methods: Service.methodIds references both Run and Helper.
    const service = g.classes.find(c => c.name === 'Service');
    const run = g.nodes.find(n => n.name === 'Run')!;
    const helper = g.nodes.find(n => n.name === 'Helper')!;
    expect(service?.methodIds).toContain(run.id);
    expect(service?.methodIds).toContain(helper.id);
  });

  it('Kotlin — members + extension function + calls', async () => {
    const g = await buildOne('kotlin/App.kt', 'Kotlin');
    expect(fnNames(g, 'Kotlin')).toContain('run');
    expect(fnNames(g, 'Kotlin')).toContain('helper');
    expect(fnNames(g, 'Kotlin')).toContain('shout'); // extension fun String.shout()
    expect(g.nodes.find(n => n.name === 'shout')?.className).toBe('String');
    expect(edge(g, 'run', 'helper')).toBe(true);
    expect(edge(g, 'main', 'run')).toBe(true);
    expect(edge(g, 'main', 'shout')).toBe(true);  // "hi".shout() extension call resolves
  });

  it('Kotlin — a free function is NOT mis-filed under a parameter/return type', async () => {
    // Regression: extraClassName picked the first user_type child, so a plain
    // `fun f(x: Int): Int` (no receiver) was wrongly attributed to a phantom class
    // `Int`. A receiver only exists as a user_type BEFORE the function name.
    const result = await new CallGraphBuilder().build([{
      path: 'k/Free.kt', language: 'Kotlin',
      content:
        'fun checkIndex(index: Int): Int { return index + 1 }\n' +
        'fun List<String>.firstOrEmpty(): String { return this.firstOrNull() ?: "" }\n',
    }]);
    const g = serializeCallGraph(result);
    const free = g.nodes.find(n => n.name === 'checkIndex');
    expect(free).toBeDefined();
    expect(free?.className).toBeUndefined();           // free function, not a method of `Int`
    expect(g.classes.some(c => c.name === 'Int')).toBe(false); // no phantom `Int` class
    // A genuine extension still attributes to its receiver (user_type before the name).
    expect(g.nodes.find(n => n.name === 'firstOrEmpty')?.className).toBe('List<String>');
  });

  it('PHP — $this->m(), Class::m(), free function calls', async () => {
    const g = await buildOne('php/app.php', 'PHP');
    expect(fnNames(g, 'PHP')).toEqual(['boot', 'helper', 'helper_free', 'run', 'save']);
    expect(edge(g, 'run', 'helper')).toBe(true);   // $this->helper()
    expect(edge(g, 'run', 'save')).toBe(true);      // Util::save()
    expect(edge(g, 'boot', 'helper_free')).toBe(true);
    expect(g.classes.some(c => c.name === 'Service')).toBe(true);
  });

  it('C — phantom bug fixed: functions + calls, no classes', async () => {
    const g = await buildOne('c/app.c', 'C');
    expect(fnNames(g, 'C')).toEqual(['add', 'compute', 'main']);
    expect(edge(g, 'compute', 'add')).toBe(true);
    expect(edge(g, 'main', 'compute')).toBe(true);
    // C has no real classes — only the synthetic file-scope module grouping (as Go).
    expect(g.classes.filter(c => c.language === 'C').every(c => c.isModule)).toBe(true);
  });

  it('Scala — object/class methods and calls', async () => {
    const g = await buildOne('scala/App.scala', 'Scala');
    expect(fnNames(g, 'Scala')).toEqual(['go', 'helper', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true);
    expect(edge(g, 'go', 'run')).toBe(true);      // Service.run()
    expect(g.classes.some(c => c.name === 'Service')).toBe(true);
  });

  it('Elixir — defmodule grouping, def/defp, local + remote (Mod.fun) calls', async () => {
    const g = await buildOne('elixir/app.ex', 'Elixir');
    expect(fnNames(g, 'Elixir')).toEqual(['go', 'helper', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true);   // local fun()
    expect(edge(g, 'go', 'run')).toBe(true);        // remote Service.run()
    expect(g.classes.some(c => c.name === 'Service')).toBe(true);
    expect(g.classes.some(c => c.name === 'Client')).toBe(true);
  });

  // Issue #507: Elixir fell through to the cross-language ignore union, so bare
  // calls to ordinary functions named map/find/new/parse/insert/delete/format vanished.
  it('Elixir — bare calls to generic names resolve; Kernel builtins and function heads do not', async () => {
    const g = await buildOne('elixir/generic_names.ex', 'Elixir');
    expect(fnNames(g, 'Elixir')).toEqual([
      'delete', 'fallback', 'find', 'format', 'insert', 'map', 'new', 'normalize', 'parse', 'run', 'send',
      'to_string', 'visit', 'walk', 'with_default',
    ]);
    expect(edge(g, 'new', 'parse')).toBe(true);
    expect(edge(g, 'new', 'format')).toBe(true);   // piped
    expect(edge(g, 'new', 'insert')).toBe(true);   // piped
    expect(edge(g, 'insert', 'delete')).toBe(true);
    expect(edge(g, 'find', 'map')).toBe(true);     // body of a guarded head
    expect(edge(g, 'with_default', 'fallback')).toBe(true); // default argument
    // Calls in a multi-clause function's later clauses keep their caller.
    expect(edge(g, 'walk', 'visit')).toBe(true);
    expect(edge(g, 'visit', 'normalize')).toBe(true);
    // A head declares its function; it is not a call to it. `walk` recurses for real.
    const byId = new Map(g.nodes.map(n => [n.id, n.name]));
    const selfEdges = g.edges.filter(e => e.callerId === e.calleeId).map(e => byId.get(e.callerId));
    expect(selfEdges).toEqual(['walk']);
    // Kernel forms and functions are not graph nodes.
    const external = g.nodes.filter(n => n.isExternal).map(n => n.name);
    for (const k of ['if', 'with', 'case', 'raise', 'send', 'self', 'inspect', 'is_map', 'is_list', 'length']) {
      expect(external).not.toContain(k);
    }
    // Remote `Enum.map` reaches resolution by bare name; it must not bind to `map`.
    expect(edge(g, 'delete', 'map')).toBe(false);
    // A project function sharing a Kernel name at another arity is still called;
    // the piped `x |> to_string()` is Kernel's to_string/1 and adds no external node.
    expect(edge(g, 'run', 'to_string')).toBe(true);
    expect(edge(g, 'run', 'send')).toBe(true);
    expect(external).not.toContain('to_string');
  });

  it('Bash — defined-function call, NO edge to external binaries', async () => {
    const g = await buildOne('bash/app.sh', 'Bash');
    expect(fnNames(g, 'Bash')).toEqual(['helper', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true);
    // grep is an external binary, not a project function — no node, no edge.
    expect(g.nodes.some(n => n.name === 'grep' && !n.isExternal)).toBe(false);
  });

  // Dart and Lua (WASM-backed) live in their own test files — vitest's module
  // sandbox corrupts web-tree-sitter's shared WASM heap when two grammars run in
  // one file (production node does not; see extra-languages-{dart,lua}.test.ts).

  // Guards the precise bug spec-08 fixes: these four were detected by
  // detectLanguage but had no dispatch branch, yielding counted-but-empty graphs.
  it('phantom-regression: C#, Kotlin, PHP, C never return an empty graph', async () => {
    for (const [rel, lang] of [['csharp/App.cs', 'C#'], ['kotlin/App.kt', 'Kotlin'], ['php/app.php', 'PHP'], ['c/app.c', 'C']] as const) {
      const g = await buildOne(rel, lang);
      expect(g.nodes.filter(n => n.language === lang && !n.isExternal).length).toBeGreaterThan(0);
      const calls = g.edges.filter(e => !e.kind || e.kind === 'calls');
      expect(calls.length).toBeGreaterThan(0);
    }
  });
});
