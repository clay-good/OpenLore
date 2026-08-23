/**
 * Content-addressed stable symbol identity (change: add-content-addressed-stable-symbol-ids).
 *
 * Plain .test.ts so CI runs it: these guard the analyzer-spec requirements
 * ContentAddressedStableSymbolId and AdditiveStableIdentity — derivation,
 * rename-survival, overload distinction, anonymous exclusion, determinism, and
 * additive persistence through the edge store.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type FunctionNode } from '../analyzer/call-graph.js';
import { arityOf, stableSymbolId, stableClassId, signatureShape } from './moniker.js';
import { EdgeStore } from '../services/edge-store.js';

type InFile = { path: string; content: string; language: string };
const ts = (path: string, content: string): InFile => ({ path, content, language: 'TypeScript' });

async function build(files: InFile[]): Promise<FunctionNode[]> {
  const g = serializeCallGraph(await new CallGraphBuilder().build(files));
  return g.nodes.filter(n => !n.isExternal);
}
const byName = (nodes: FunctionNode[], name: string) => nodes.find(n => n.name === name);

describe('stableSymbolId (unit)', () => {
  it('SCIP arity prefers live-AST metadata and refuses a collapsed overload', () => {
    const node = {
      name: 'f', signature: 'function f(a, b, c)',
      callArity: { required: 1, total: 2, variadic: false, hasOptionalOrDefault: true, implicitReceiverCount: 0 },
    } as FunctionNode;
    expect(arityOf(node)).toBe(2);
    expect(arityOf({
      ...node,
      callArity: { ...node.callArity!, total: 1, variadic: true, variadicParameterCount: 1, implicitReceiverCount: 1 },
    })).toBe(3); // one fixed + one source receiver + one variadic declaration parameter
    expect(arityOf({
      ...node,
      callArity: { ...node.callArity!, total: 1, variadic: true, variadicParameterCount: 2, implicitReceiverCount: 1 },
    })).toBe(4); // Python may declare both *args and **kwargs
    expect(arityOf({ ...node, callArity: { ...node.callArity!, overloaded: true } })).toBeUndefined();
  });

  it('excludes the file path by construction', () => {
    const node = { name: 'foo', filePath: 'src/a.ts', signature: 'function foo(x: number): void' } as FunctionNode;
    const id = stableSymbolId(node)!;
    expect(id).toBeDefined();
    expect(id).not.toContain('src/a.ts');
    expect(id).not.toContain('::');
  });

  it('uses the signature shape as the overload disambiguator', () => {
    const a = { name: 'f', signature: 'function f(x: number): void' } as FunctionNode;
    const b = { name: 'f', signature: 'function f(x: number, y: string): void' } as FunctionNode;
    expect(stableSymbolId(a)).not.toEqual(stableSymbolId(b));
    expect(stableSymbolId(a)).toContain(signatureShape(a.signature));
  });

  it('ignores leading modifiers (rename/async/export) — they are not in the shape', () => {
    const plain = { name: 'f', signature: 'function f(x: number): void' } as FunctionNode;
    const asyncd = { name: 'f', signature: 'export async function f(x: number): void' } as FunctionNode;
    expect(stableSymbolId(plain)).toEqual(stableSymbolId(asyncd));
  });

  it('uses empty parentheses when no signature is available', () => {
    const node = { name: 'f' } as FunctionNode;
    expect(stableSymbolId(node)).toBe('sid:f()');
  });

  it('is body-invariant for expression-bodied arrows (shape is the param group only)', () => {
    // The analyzer captures the whole `const f = (a) => <body>` as the signature.
    // The id must depend only on the parameter group, never the body, so a body
    // edit keeps the id (a moved-and-edited symbol must resolve drifted, not orphaned).
    const v1 = { name: 'widget', signature: 'const widget = (a: string) => a.length;' } as FunctionNode;
    const v2 = { name: 'widget', signature: 'const widget = (a: string) => a.length + 1;' } as FunctionNode;
    expect(stableSymbolId(v1)).toBe('sid:widget(a: string)');
    expect(stableSymbolId(v2)).toBe(stableSymbolId(v1));
  });

  it('is body-invariant for paren-less defs whose captured body contains a call', () => {
    // Ruby/Scala (and paren-less arrows) capture the body in the signature. The
    // parameter group is `name(...)`, NOT the first `(` — a body call like
    // `helper(1, 2)` must not be mistaken for the parameters, or a body edit would
    // flip the id and a moved-and-edited symbol would read orphaned, not drifted.
    const ruby1 = { name: 'compute', className: 'Repo', language: 'Ruby', signature: 'def compute helper(1, 2) end' } as FunctionNode;
    const ruby2 = { name: 'compute', className: 'Repo', language: 'Ruby', signature: 'def compute helper(9, 9, 9) end' } as FunctionNode;
    expect(stableSymbolId(ruby1)).toBe('sid:Repo.compute()');
    expect(stableSymbolId(ruby2)).toBe(stableSymbolId(ruby1));

    const scala1 = { name: 'total', className: 'Repo', language: 'Scala', signature: 'def total = compute(5, 6)' } as FunctionNode;
    const scala2 = { name: 'total', className: 'Repo', language: 'Scala', signature: 'def total = compute(7)' } as FunctionNode;
    expect(stableSymbolId(scala1)).toBe('sid:Repo.total()');
    expect(stableSymbolId(scala2)).toBe(stableSymbolId(scala1));

    const arrow1 = { name: 'f', signature: 'const f = a => g(a)' } as FunctionNode;
    const arrow2 = { name: 'f', signature: 'const f = a => h(a, b, c)' } as FunctionNode;
    expect(stableSymbolId(arrow1)).toBe('sid:f()');
    expect(stableSymbolId(arrow2)).toBe(stableSymbolId(arrow1));

    // A real parameter list that follows the name is still captured (not dropped),
    // and an arg'd decorator preceding the def is skipped — the params win.
    const real = { name: 'list_users', signature: '@app.route("/u", methods=["GET"]) def list_users(req)' } as FunctionNode;
    expect(stableSymbolId(real)).toBe('sid:list_users(req)');
  });

  it('excludes the return type from the shape (return-type change keeps the id)', () => {
    const a = { name: 'f', signature: 'function f(x: number): void' } as FunctionNode;
    const b = { name: 'f', signature: 'function f(x: number): Promise<void>' } as FunctionNode;
    expect(stableSymbolId(a)).toBe('sid:f(x: number)');
    expect(stableSymbolId(b)).toBe(stableSymbolId(a));
  });

  it('handles nested parens in the parameter group (callback params)', () => {
    const node = { name: 'on', signature: 'function on(ev: string, cb: (x: number) => void): void' } as FunctionNode;
    expect(stableSymbolId(node)).toBe('sid:on(ev: string, cb: (x: number) => void)');
  });

  it('skips a Go method receiver — shape is the params, not the receiver (Go only)', () => {
    // `func (r *Repo) Save(x int) error` — the first (...) is the receiver.
    const save = { name: 'Save', className: 'Repo', language: 'Go', signature: 'func (r *Repo) Save(x int) error' } as FunctionNode;
    const load = { name: 'Load', className: 'Repo', language: 'Go', signature: 'func (r *Repo) Load(y string) error' } as FunctionNode;
    expect(signatureShape(save.signature, 'Go')).toBe('(x int)');
    expect(stableSymbolId(save)).toBe('sid:Repo.Save(x int)');
    // Two methods on the same receiver get DISTINCT ids (keyed on real params/name),
    // not a collision on the receiver group.
    expect(stableSymbolId(save)).not.toBe(stableSymbolId(load));
    // A free Go function keeps its first (...) as the params.
    expect(signatureShape('func Helper(a int)', 'Go')).toBe('(a int)');
  });

  it('a Go method id is invariant to renaming the receiver variable', () => {
    const a = { name: 'Save', className: 'Repo', language: 'Go', signature: 'func (r *Repo) Save(x int) error' } as FunctionNode;
    const b = { name: 'Save', className: 'Repo', language: 'Go', signature: 'func (repo *Repo) Save(x int) error' } as FunctionNode;
    expect(stableSymbolId(a)).toBe(stableSymbolId(b)); // receiver var name is not identity
  });

  it('does NOT treat a non-Go symbol named `func` as a Go receiver (language-gated)', () => {
    // `func` is a legal identifier in JS/TS/Python/etc.; a method named `func` has
    // signature `func(a)` whose prefix trims to `func`. The receiver-skip must NOT
    // fire for non-Go, or the real parameter group is silently dropped.
    const tsMethod = { name: 'func', className: 'C', language: 'TypeScript', signature: 'func(a: number, b: number): number' } as FunctionNode;
    expect(signatureShape(tsMethod.signature, 'TypeScript')).toBe('(a: number, b: number)');
    expect(stableSymbolId(tsMethod)).toBe('sid:C.func(a: number, b: number)');
    // Default (no language) also keeps the group — only explicit Go skips.
    expect(signatureShape('func(a: number)')).toBe('(a: number)');
  });

  it('a signatureless function never collides with a class of the same name', () => {
    const fn = { name: 'Foo' } as FunctionNode;
    expect(stableSymbolId(fn)).toBe('sid:Foo()');
    expect(stableClassId('Foo')).toBe('sid:Foo'); // no parens → distinct
    expect(stableSymbolId(fn)).not.toBe(stableClassId('Foo'));
  });

  it('returns undefined for anonymous / synthetic names', () => {
    expect(stableSymbolId({ name: '' } as FunctionNode)).toBeUndefined();
    expect(stableSymbolId({ name: '*' } as FunctionNode)).toBeUndefined();
    expect(stableSymbolId({ name: 'src/a.ts::*' } as FunctionNode)).toBeUndefined();
    expect(stableSymbolId({ name: '<anonymous>' } as FunctionNode)).toBeUndefined();
  });

  it('stableClassId returns undefined for synthetic module groupings', () => {
    expect(stableClassId('[anon]', true)).toBeUndefined();
    expect(stableClassId('RealClass', false)).toBe('sid:RealClass');
  });
});

describe('ContentAddressedStableSymbolId (analyzer spec)', () => {
  it('Stable id survives a file rename', async () => {
    const src = 'export function widget(a: string): number { return a.length; }\n';
    const before = byName(await build([ts('src/a.ts', src)]), 'widget')!;
    const after = byName(await build([ts('src/b.ts', src)]), 'widget')!;
    expect(before.stableId).toBeDefined();
    expect(after.stableId).toBe(before.stableId);
  });

  it('Overloads get distinct stable ids', async () => {
    // TypeScript: a method with two distinct signatures in one class.
    const nodes = await build([ts('src/o.ts',
      `export class C {\n  m(a: number): void {}\n  go() { this.m(1); }\n}\n` +
      `export function m(a: number, b: number): void {}\n`)]);
    const method = nodes.find(n => n.name === 'm' && n.className === 'C')!;
    const free = nodes.find(n => n.name === 'm' && !n.className)!;
    expect(method.stableId).toBeDefined();
    expect(free.stableId).toBeDefined();
    expect(method.stableId).not.toBe(free.stableId);
  });

  it('Stable id is deterministic across runs', async () => {
    const files = [ts('src/x.ts', 'export function alpha(): void {}\nexport function beta(n: number): number { return n; }\n')];
    const run1 = await build(files);
    const run2 = await build(files);
    const ids1 = run1.map(n => `${n.name}=${n.stableId ?? '∅'}`).sort();
    const ids2 = run2.map(n => `${n.name}=${n.stableId ?? '∅'}`).sort();
    expect(ids1).toEqual(ids2);
  });

  it('homonyms (same name + param shape in different files) share one stable id', async () => {
    // No position-dependent ordinal: distinct same-shape symbols get the SAME id.
    const nodes = await build([
      ts('src/a.ts', 'export function dup(n: number): number { return n; }\n'),
      ts('src/b.ts', 'export function dup(n: number): number { return n + 1; }\n'), // different body
    ]);
    const ids = nodes.filter(n => n.name === 'dup').map(n => n.stableId);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]); // shared — body is not part of the id
    expect(ids[0]).toBe('sid:dup(n: number)');
  });

  it('a surviving homonym keeps its stable id when a same-base sibling is added or removed', async () => {
    // The regression that the positional-ordinal scheme had: an unrelated file
    // entering/leaving the build must NOT rewrite an untouched symbol's identity.
    const dup = 'export function dup(n: number): number { return n; }\n';
    const solo = byName(await build([ts('src/b.ts', dup)]), 'dup')!;
    const withSibling = (await build([ts('src/a.ts', dup), ts('src/b.ts', dup)]))
      .filter(n => n.name === 'dup');
    // b.ts's id is identical whether or not a.ts (a same-base sibling) is present,
    // and survives a.ts being "renamed" to z.ts.
    expect(withSibling.every(n => n.stableId === solo.stableId)).toBe(true);
    const afterRename = (await build([ts('src/z.ts', dup), ts('src/b.ts', dup)]))
      .find(n => n.filePath === 'src/b.ts')!;
    expect(afterRename.stableId).toBe(solo.stableId);
  });

  it('a const-assigned arrow keeps its stable id across a body edit and a file move', async () => {
    const before = byName(await build([ts('src/a.ts', 'export const f = (a: string) => a.length;\n')]), 'f')!;
    const movedAndEdited = byName(await build([ts('src/b.ts', 'export const f = (a: string) => a.length * 2;\n')]), 'f')!;
    expect(before.stableId).toBe('sid:f(a: string)');
    expect(movedAndEdited.stableId).toBe(before.stableId); // moved file + edited body → same id
  });

  it('same-file container-name collapse keeps one node that resolves uniquely (completeness limit, not a wrong resolution)', async () => {
    // Two distinct symbols in ONE file collide on the path id `file::Config.load`
    // because the analyzer does not qualify by the enclosing namespace. The
    // analyzer drops one at node aggregation (last-write-wins) BEFORE stableId is
    // computed, so exactly one node carries the stableId and it resolves uniquely
    // to a GENUINE symbol — the dropped twin is invisible everywhere (path id and
    // stableId alike). This pins the documented behavior: a completeness gap the
    // stableId derivation inherits, never a resolution to the wrong symbol.
    const nodes = await build([ts('src/cfg.ts',
      'export namespace A { export class Config { load(x: number): void {} } }\n' +
      'export namespace B { export class Config { load(x: number): void {} } }\n')]);
    const collapsed = nodes.filter(n => n.name === 'load' && n.className === 'Config');
    expect(collapsed.length).toBe(1); // last-write-wins on the path id, not two nodes
    expect(collapsed[0].id).toBe('src/cfg.ts::Config.load');
    expect(collapsed[0].stableId).toBe('sid:Config.load(x: number)');

    const dir = mkdtempSync(join(tmpdir(), 'stable-collapse-'));
    try {
      const store = EdgeStore.open(join(dir, 'graph.db'));
      store.insertNodes(nodes);
      // Resolves uniquely to the sole surviving node — never to a fabricated twin.
      expect(store.getNodeByStableId('sid:Config.load(x: number)')?.id).toBe('src/cfg.ts::Config.load');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('in-parameter comments participate in the shape (documented sensitivity, fails safe)', () => {
    // signatureShape normalizes whitespace but does NOT strip comments inside the
    // parameter list (a literal-aware stripper was deliberately omitted — a naive
    // strip would corrupt string-literal defaults like URLs). Editing such a
    // comment flips the stableId, so the symbol falls back to remove+add / orphaned
    // rather than ever resolving to a WRONG identity. Pin the safe-direction limit.
    const withComment = { name: 'f', signature: 'function f(a: number /* id */, b: string): void' } as FunctionNode;
    const without = { name: 'f', signature: 'function f(a: number, b: string): void' } as FunctionNode;
    expect(stableSymbolId(withComment)).not.toBe(stableSymbolId(without));
    // The change is confined to identity (a benign miss), never a collision between
    // two genuinely different symbols: the comment text is part of the key, so it
    // can only make ids MORE distinct, not merge distinct symbols.
  });

  it('Anonymous functions get no stable id (real analyzer output)', async () => {
    // An inline callback the analyzer never turns into a named node, plus the
    // synthetic per-file module grouping — neither carries a stableId.
    const g = serializeCallGraph(await new CallGraphBuilder().build([
      ts('src/a.ts', 'export function run(xs: number[]) { return xs.map(n => n + 1).filter(x => x > 0); }\n'),
    ]));
    const internal = g.nodes.filter(n => !n.isExternal);
    // The only real node is `run`; the bare arrows produced no node at all.
    expect(internal.map(n => n.name)).toEqual(['run']);
    // Synthetic module groupings (isModule) never receive a stableId.
    expect(g.classes.filter(c => c.isModule).every(c => c.stableId === undefined)).toBe(true);
  });
});

describe('AdditiveStableIdentity (analyzer spec) — persistence', () => {
  it('Path-based id is unchanged and stable_id round-trips through the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stable-store-'));
    try {
      const nodes = await build([ts('src/a.ts', 'export function persisted(n: number): number { return n; }\n')]);
      const node = byName(nodes, 'persisted')!;
      expect(node.id).toBe('src/a.ts::persisted'); // path-based id is byte-for-byte unchanged
      expect(node.stableId).toBeDefined();

      const store = EdgeStore.open(join(dir, 'graph.db'));
      store.insertNodes(nodes);
      const reread = store.getNode(node.id)!;
      expect(reread.id).toBe(node.id);
      expect(reread.stableId).toBe(node.stableId);
      // getNodeByStableId resolves the unique node.
      expect(store.getNodeByStableId(node.stableId!)?.id).toBe(node.id);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Absent stable id is handled gracefully (node with no stableId)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stable-store-'));
    try {
      const store = EdgeStore.open(join(dir, 'graph.db'));
      const node: FunctionNode = {
        id: 'src/a.ts::legacy', name: 'legacy', filePath: 'src/a.ts',
        isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 5, fanIn: 0, fanOut: 0,
      };
      store.insertNodes([node]);
      const reread = store.getNode(node.id)!;
      expect(reread.stableId).toBeUndefined();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getNodeByStableId returns null on an ambiguous collision (no guessing)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stable-store-'));
    try {
      const store = EdgeStore.open(join(dir, 'graph.db'));
      // Two nodes deliberately sharing a stable id — the store must not guess.
      const mk = (id: string): FunctionNode => ({
        id, name: 'x', filePath: id.split('::')[0], stableId: 'sid:x()',
        isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0,
      });
      store.insertNodes([mk('src/a.ts::x'), mk('src/b.ts::x')]);
      expect(store.getNodeByStableId('sid:x()')).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
