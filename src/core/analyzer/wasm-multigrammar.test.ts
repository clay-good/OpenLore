import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from './call-graph.js';

const dir = join(__dirname, 'fixtures');
const load = (rel: string, language: string) => ({ path: rel, content: readFileSync(join(dir, rel), 'utf-8'), language });
const fnNames = (g: SerializedCallGraph, lang: string) => g.nodes.filter(n => n.language === lang && !n.isExternal).map(n => n.name).sort();
const edge = (g: SerializedCallGraph, caller: string, callee: string) => {
  const c = g.nodes.find(n => n.name === caller); const d = g.nodes.find(n => n.name === callee && !n.isExternal);
  return !!c && !!d && g.edges.some(e => e.callerId === c.id && e.calleeId === d.id);
};

// Regression: the WASM lane (Dart) and the native lane (Lua) in ONE build() must each
// produce a COMPLETE graph, in either order. web-tree-sitter is a singleton emscripten
// module with a shared heap, and this pairing is where that used to show: both languages
// were WASM-backed, loading both grammars into one instance silently corrupted the second
// one's parses (Lua lost half its functions), so each grammar loads in its own module
// instance. Lua has since moved to the native lane (#472), which leaves Dart the lane's
// only caller — so the two-WASM-grammar case now has no second caller to exercise it, and
// the per-grammar isolation in `loadWasmGrammarSoft` stays keyed per grammar for the next
// one. What this file still proves is that the two lanes coexist in one build without
// either disturbing the other.
describe('spec-08 lane coexistence (WASM Dart + native Lua together)', () => {
  it('both Dart and Lua graph fully when analyzed in the same run', async () => {
    const g = serializeCallGraph(await new CallGraphBuilder().build([
      load('dart/app.dart', 'Dart'),
      load('lua/app.lua', 'Lua'),
    ]));
    if (fnNames(g, 'Dart').length === 0 && fnNames(g, 'Lua').length === 0) return; // grammars unavailable
    expect(fnNames(g, 'Dart')).toEqual(['helper', 'main', 'run']);
    expect(fnNames(g, 'Lua')).toEqual(['boot', 'helper', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true); // resolves within each
  });

  it('is order-independent (Lua before Dart)', async () => {
    const g = serializeCallGraph(await new CallGraphBuilder().build([
      load('lua/app.lua', 'Lua'),
      load('dart/app.dart', 'Dart'),
    ]));
    if (fnNames(g, 'Dart').length === 0 && fnNames(g, 'Lua').length === 0) return;
    expect(fnNames(g, 'Lua')).toEqual(['boot', 'helper', 'run']);
    expect(fnNames(g, 'Dart')).toEqual(['helper', 'main', 'run']);
  });
});
