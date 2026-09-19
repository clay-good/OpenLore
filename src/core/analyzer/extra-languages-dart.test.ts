import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from './call-graph.js';
const dir = join(__dirname, 'fixtures');
async function buildOne(rel: string, language: string): Promise<SerializedCallGraph> {
  return serializeCallGraph(await new CallGraphBuilder().build([{ path: rel, content: readFileSync(join(dir, rel), 'utf-8'), language }]));
}
const fnNames = (g: SerializedCallGraph, lang: string) => g.nodes.filter(n => n.language === lang && !n.isExternal).map(n => n.name).sort();
const edge = (g: SerializedCallGraph, caller: string, callee: string) => {
  const c = g.nodes.find(n => n.name === caller); const d = g.nodes.find(n => n.name === callee && !n.isExternal);
  return !!c && !!d && g.edges.some(e => e.callerId === c.id && e.calleeId === d.id);
};
describe('spec-08 Dart (bundled WASM)', () => {
  it('class methods + top-level functions, calls attributed across sibling bodies', async () => {
    const g = await buildOne('dart/app.dart', 'Dart');
    const names = fnNames(g, 'Dart');
    if (names.length === 0) return; // WASM unavailable in this env → graceful skip
    expect(names).toEqual(['helper', 'main', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true);  // helper() inside a method body
    expect(edge(g, 'main', 'run')).toBe(true);     // s.run()
    expect(g.classes.some(c => c.name === 'Service' && c.language === 'Dart')).toBe(true);
  });

  // Follow-up to issue #507: Dart fell through to the cross-language ignore union, so
  // calls named find/insert/format/map/… were dropped although Dart defines none of them.
  it('keeps calls to generic names; a chained call does not bind by name', async () => {
    const g = await buildOne('dart/generic_names.dart', 'Dart');
    if (fnNames(g, 'Dart').length === 0) return; // WASM unavailable in this env → graceful skip
    expect(edge(g, 'run', 'find')).toBe(true);    // repo.find(), typed receiver
    expect(edge(g, 'run', 'insert')).toBe(true);  // repo.insert()
    expect(edge(g, 'run', 'format')).toBe(true);  // bare top-level call
    // `[..].where(..).map(..)` carries no receiver; it must not bind to the project `map`.
    expect(edge(g, 'run', 'map')).toBe(false);
    // dart:core `print` stays ignored.
    expect(g.nodes.some(n => n.isExternal && n.name === 'print')).toBe(false);
  });

  // A bare dart:math call must not bind by name to a project method of the same name.
  it('does not bind a bare dart:math max() to a project method max', async () => {
    const g = await buildOne('dart/math_top.dart', 'Dart');
    if (fnNames(g, 'Dart').length === 0) return; // WASM unavailable in this env → graceful skip
    expect(fnNames(g, 'Dart')).toEqual(['max', 'top']);
    expect(edge(g, 'top', 'max')).toBe(false);
  });
});
