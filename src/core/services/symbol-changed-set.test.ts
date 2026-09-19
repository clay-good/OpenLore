/**
 * Symbol-level changed-sets over a real git repository (change: add-symbol-content-hashes).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from '../analyzer/call-graph.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import {
  computeSymbolChangedSet,
  granularityCaveat,
  granularityReceipt,
  importsAddedCaveat,
  noChangeClaim,
  narrowSeedsToChangedSymbols,
  type DiffEntry,
  type SymbolGranularChange,
} from './symbol-changed-set.js';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(repo, dirname(path)), { recursive: true });
  await writeFile(join(repo, path), content);
}

async function commitAll(): Promise<void> {
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'c');
}

/** Index the working tree the way analyze would, relative to `root`. */
async function index(root: string, paths: string[]): Promise<SerializedCallGraph> {
  const files = await Promise.all(paths.map(async p => ({
    path: p,
    content: await readFile(join(root, p), 'utf-8'),
    language: detectLanguage(p),
  })));
  return serializeCallGraph(await new CallGraphBuilder().build(files));
}

async function changedSet(diff: DiffEntry[], paths: string[], opts: { root?: string; maxFiles?: number; maxBytes?: number; budgetMs?: number } = {}) {
  const root = opts.root ?? repo;
  const callGraph = await index(root, paths);
  const set = await computeSymbolChangedSet({ absDir: root, baseRef: 'HEAD', diff, callGraph, maxFiles: opts.maxFiles, maxBytes: opts.maxBytes, budgetMs: opts.budgetMs });
  return { set, callGraph };
}

const TEN = Array.from({ length: 10 }, (_, i) => `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`).join('\n');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ol-symset-'));
  git('init', '-q');
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

describe('computeSymbolChangedSet', () => {
  it('a one-function edit in a ten-function file seeds exactly that function', async () => {
    await put('src/ten.ts', TEN);
    await commitAll();
    await put('src/ten.ts', TEN.replace('return x + 4;', 'return x * 4;'));
    const { set, callGraph } = await changedSet([{ path: 'src/ten.ts', status: 'modified' }], ['src/ten.ts']);
    expect(set.byFile.get('src/ten.ts')).toEqual({
      granularity: 'symbol', changed: ['src/ten.ts::f4'], appeared: [], disappeared: [], referencing: [], dynamicDispatch: [],
    });
    const seeds = narrowSeedsToChangedSymbols(callGraph.nodes.filter(n => !n.isExternal), set);
    expect(seeds.map(n => n.id)).toEqual(['src/ten.ts::f4']);
    expect(granularityReceipt(set)).toMatchObject({ symbolExactFiles: 1, fileGranularFiles: 0 });
    expect(granularityCaveat(granularityReceipt(set))).toBeUndefined();
  });

  it('a formatting- and comment-only edit produces an empty changed-set', async () => {
    await put('src/ten.ts', TEN);
    await commitAll();
    await put('src/ten.ts', TEN.replace(/\n {2}return/g, '\n      // reformatted\n      return'));
    const { set, callGraph } = await changedSet([{ path: 'src/ten.ts', status: 'modified' }], ['src/ten.ts']);
    const change = set.byFile.get('src/ten.ts') as SymbolGranularChange;
    expect(change.granularity).toBe('symbol');
    expect([...change.changed, ...change.appeared, ...change.disappeared]).toEqual([]);
    expect(narrowSeedsToChangedSymbols(callGraph.nodes, set).filter(n => !n.isExternal)).toEqual([]);
  });

  it('a module-level change keeps the whole file seeded, with the reason', async () => {
    await put('src/m.ts', 'const LIMIT = 1;\nexport function a() { return LIMIT; }\nexport function b() { return 2; }\n');
    await commitAll();
    await put('src/m.ts', 'const LIMIT = 9;\nexport function a() { return LIMIT; }\nexport function b() { return 2; }\n');
    const { set, callGraph } = await changedSet([{ path: 'src/m.ts', status: 'modified' }], ['src/m.ts']);
    expect(set.byFile.get('src/m.ts')).toEqual({ granularity: 'file', reason: 'module-level-change' });
    expect(narrowSeedsToChangedSymbols(callGraph.nodes.filter(n => !n.isExternal), set).map(n => n.name).sort()).toEqual(['a', 'b']);
    expect(granularityCaveat(granularityReceipt(set))).toContain('module-level-change (1)');
  });

  it('a pure reorder of symbols is a module-level change, not "nothing changed"', async () => {
    await put('src/o.ts', 'function a() { return 1; }\nfunction b() { return 2; }\n');
    await commitAll();
    await put('src/o.ts', 'function b() { return 2; }\nfunction a() { return 1; }\n');
    const { set } = await changedSet([{ path: 'src/o.ts', status: 'modified' }], ['src/o.ts']);
    expect(set.byFile.get('src/o.ts')).toEqual({ granularity: 'file', reason: 'module-level-change' });
  });

  it('a rename is reported as carried, and both names stay seeded', async () => {
    await put('src/r.ts', 'export function computeTax(x: number) { return x * 0.2; }\nexport function other() { return 1; }\n');
    await commitAll();
    await put('src/r.ts', 'export function calculateTax(x: number) { return x * 0.2; }\nexport function other() { return 1; }\n');
    const { set } = await changedSet([{ path: 'src/r.ts', status: 'modified' }], ['src/r.ts']);
    const change = set.byFile.get('src/r.ts') as SymbolGranularChange;
    expect(change).toMatchObject({ granularity: 'symbol', changed: [], appeared: ['src/r.ts::calculateTax'], disappeared: ['src/r.ts::computeTax'] });
    expect(set.carried).toEqual([{ from: 'src/r.ts::computeTax', to: 'src/r.ts::calculateTax', reason: 'renamed', basis: 'exact-signature' }]);
  });

  it('keeps a same-file symbol that references a changed one without a resolved call', async () => {
    const src = (k: number) => `export function helper(x: number) { return x + ${k}; }\n` +
      'export function useIt(xs: number[]) { return xs.map(helper); }\n' +
      'export function unrelated() { return 0; }\n';
    await put('src/ref.ts', src(1));
    await commitAll();
    await put('src/ref.ts', src(2));
    const { set } = await changedSet([{ path: 'src/ref.ts', status: 'modified' }], ['src/ref.ts']);
    expect(set.byFile.get('src/ref.ts')).toMatchObject({
      granularity: 'symbol', changed: ['src/ref.ts::helper'], referencing: ['src/ref.ts::useIt'],
    });
  });

  it('keeps a same-file symbol holding a dynamic-dispatch site', async () => {
    const src = (k: number) => `export function target() { return ${k}; }\n` +
      'export function dispatch(obj: any, key: string) { return obj[key](); }\n' +
      'export function unrelated() { return 0; }\n';
    await put('src/dyn.ts', src(1));
    await commitAll();
    await put('src/dyn.ts', src(2));
    const { set } = await changedSet([{ path: 'src/dyn.ts', status: 'modified' }], ['src/dyn.ts']);
    const change = set.byFile.get('src/dyn.ts') as SymbolGranularChange;
    expect(change.changed).toEqual(['src/dyn.ts::target']);
    expect(change.dynamicDispatch).toEqual(['src/dyn.ts::dispatch']);
  });

  it('Python: moving a statement out of a block is a change', async () => {
    await put('m.py', 'def f(a):\n    if a:\n        x()\n        y()\n    return 1\n\ndef g():\n    return 2\n');
    await commitAll();
    await put('m.py', 'def f(a):\n    if a:\n        x()\n    y()\n    return 1\n\ndef g():\n    return 2\n');
    const { set } = await changedSet([{ path: 'm.py', status: 'modified' }], ['m.py']);
    expect(set.byFile.get('m.py')).toMatchObject({ granularity: 'symbol', changed: ['m.py::f'] });
  });

  it('adding a function narrows to the new function, not the whole file', async () => {
    await put('src/ten.ts', TEN);
    await commitAll();
    await put('src/ten.ts', `${TEN}\nexport function fresh(): number {\n  return 11;\n}\n`);
    const { set } = await changedSet([{ path: 'src/ten.ts', status: 'modified' }], ['src/ten.ts']);
    expect(set.byFile.get('src/ten.ts')).toMatchObject({
      granularity: 'symbol', changed: [], appeared: ['src/ten.ts::fresh'], disappeared: [],
    });
  });

  it('deleting a function narrows to that function', async () => {
    await put('src/ten.ts', TEN);
    await commitAll();
    await put('src/ten.ts', TEN.replace('export function f3(x: number): number {\n  return x + 3;\n}\n', ''));
    const { set } = await changedSet([{ path: 'src/ten.ts', status: 'modified' }], ['src/ten.ts']);
    expect(set.byFile.get('src/ten.ts')).toMatchObject({
      granularity: 'symbol', changed: [], appeared: [], disappeared: ['src/ten.ts::f3'],
    });
  });

  it('module-level code moving across a symbol keeps the file whole', async () => {
    await put('src/lay.ts', 'main();\nexport function main() { return 1; }\nexport function other() { return 2; }\n');
    await commitAll();
    await put('src/lay.ts', 'export function main() { return 1; }\nmain();\nexport function other() { return 2; }\n');
    const { set } = await changedSet([{ path: 'src/lay.ts', status: 'modified' }], ['src/lay.ts']);
    expect(set.byFile.get('src/lay.ts')).toEqual({ granularity: 'file', reason: 'module-level-change' });
  });

  it('a module-level alias of a changed symbol keeps the file whole', async () => {
    const src = (k: number) => `export function get(): number { return ${k}; }\n` +
      'const h = get;\n' +
      'export function use(): number { return h(); }\n';
    await put('src/alias.ts', src(1));
    await commitAll();
    await put('src/alias.ts', src(2));
    const { set, callGraph } = await changedSet([{ path: 'src/alias.ts', status: 'modified' }], ['src/alias.ts']);
    expect(set.byFile.get('src/alias.ts')).toEqual({ granularity: 'file', reason: 'module-level-reference' });
    expect(narrowSeedsToChangedSymbols(callGraph.nodes.filter(n => !n.isExternal), set).map(n => n.name).sort()).toEqual(['get', 'use']);
  });

  it('a changed code file the index holds no symbol for is still assessed', async () => {
    await put('src/constants.ts', 'export const LIMIT = 1;\n');
    await put('src/ten.ts', TEN);
    await commitAll();
    await put('src/constants.ts', 'export const LIMIT = 2;\n');
    const { set } = await changedSet(
      [{ path: 'src/constants.ts', status: 'modified' }], ['src/ten.ts'],
    );
    // It seeds nothing (no indexed symbol), but it must not vanish: a caller that saw an empty
    // changed-set here would claim the diff was formatting only.
    expect(set.byFile.get('src/constants.ts')).toEqual({ granularity: 'file', reason: 'module-level-change' });
    expect(granularityReceipt(set).fileGranularFiles).toBe(1);
  });

  it('stops hashing past the byte budget and discloses it', async () => {
    const big = `${TEN}\n// ${'x'.repeat(4000)}\n`;
    await put('src/a.ts', big);
    await put('src/b.ts', big);
    await commitAll();
    await put('src/a.ts', big.replace('return x + 1;', 'return 1;'));
    await put('src/b.ts', big.replace('return x + 1;', 'return 1;'));
    const { set } = await changedSet(
      [{ path: 'src/a.ts', status: 'modified' }, { path: 'src/b.ts', status: 'modified' }],
      ['src/a.ts', 'src/b.ts'],
      { maxBytes: big.length * 2 + 10 },
    );
    expect(set.byFile.get('src/a.ts')).toMatchObject({ granularity: 'symbol' });
    expect(set.byFile.get('src/b.ts')).toEqual({ granularity: 'file', reason: 'size-cap' });
  });

  it('an added import plus an edited function stays symbol-exact, and seeds whoever names the import', async () => {
    const before = "import { a } from './a';\nexport function one() { return a(1); }\nexport function two() { return 2; }\nexport function three() { return 3; }\n";
    const after = "import { a } from './a';\nimport { b } from './b';\nexport function one() { return a(1) + b(); }\nexport function two() { return 2; }\nexport function three() { return b ? 3 : 4; }\n";
    await put('src/i.ts', before);
    await commitAll();
    await put('src/i.ts', after);
    const { set } = await changedSet([{ path: 'src/i.ts', status: 'modified' }], ['src/i.ts']);
    const change = set.byFile.get('src/i.ts') as SymbolGranularChange;
    expect(change.granularity).toBe('symbol');
    expect(change.importsAdded).toBe(true);
    expect(change.changed).toEqual(['src/i.ts::one', 'src/i.ts::three']);
    expect(granularityReceipt(set).importsAddedFiles).toBe(1);
    expect(importsAddedCaveat(granularityReceipt(set))).toContain('load-time side effects');
  });

  it('a rewritten or removed import keeps the file whole, and so does a bare side-effect import', async () => {
    const base = "import { a } from './a';\nexport function one() { return a(1); }\nexport function two() { return 2; }\n";
    await put('src/r1.ts', base);
    await put('src/r2.ts', base);
    await commitAll();
    await put('src/r1.ts', base.replace("from './a'", "from './other'"));   // rebinds `a`
    await put('src/r2.ts', `import './polyfill';\n${base}`);                 // runs code, binds nothing
    const { set } = await changedSet(
      [{ path: 'src/r1.ts', status: 'modified' }, { path: 'src/r2.ts', status: 'modified' }],
      ['src/r1.ts', 'src/r2.ts'],
    );
    expect(set.byFile.get('src/r1.ts')).toEqual({ granularity: 'file', reason: 'module-level-change' });
    expect(set.byFile.get('src/r2.ts')).toEqual({ granularity: 'file', reason: 'module-level-change' });
  });

  it('a realistic mixed diff: narrowing only ever removes seeds, and never the edited ones', async () => {
    const util = (k: number) => `export function helper(x: number) { return x + ${k}; }\n` +
      'export function untouched() { return 0; }\n' +
      'export function alsoUntouched() { return 1; }\n';
    const svc = (comment: string) => "import { helper } from './util';\n" +
      `export function serve(x: number) {\n  // ${comment}\n  return helper(x);\n}\n` +
      'export function idle() { return 7; }\n';
    const other = 'export const TABLE = { a: 1 };\nexport function reads() { return TABLE.a; }\n';
    await put('src/util.ts', util(1));
    await put('src/svc.ts', svc('note'));
    await put('src/other.ts', other);
    await commitAll();
    // one body edit, one added function, one added import, one comment-only edit, one module-level edit
    await put('src/util.ts', `${util(2)}export function added() { return 9; }\n`);
    await put('src/svc.ts', `import { added } from './util';\n${svc('reworded note')}`);
    await put('src/other.ts', other.replace('{ a: 1 }', '{ a: 2 }'));
    const diff: DiffEntry[] = [
      { path: 'src/util.ts', status: 'modified' },
      { path: 'src/svc.ts', status: 'modified' },
      { path: 'src/other.ts', status: 'modified' },
    ];
    const { set, callGraph } = await changedSet(diff, ['src/util.ts', 'src/svc.ts', 'src/other.ts']);
    const fileSeeds = callGraph.nodes.filter(n => !n.isExternal && !n.isTest);
    const narrowed = narrowSeedsToChangedSymbols(fileSeeds, set);
    const ids = narrowed.map(n => n.id).sort();

    // Narrowing only ever removes: it can never invent a seed.
    expect(fileSeeds.map(n => n.id)).toEqual(expect.arrayContaining(ids));
    // The edited and added symbols are seeded.
    expect(ids).toContain('src/util.ts::helper');
    expect(ids).toContain('src/util.ts::added');
    // The module-level edit keeps its whole file.
    expect(ids).toContain('src/other.ts::reads');
    // The comment-only edit does not seed its file's untouched sibling…
    expect(ids).not.toContain('src/svc.ts::idle');
    // …and neither do the untouched siblings of the edited function.
    expect(ids).not.toContain('src/util.ts::untouched');
    expect(ids).not.toContain('src/util.ts::alsoUntouched');
    // `serve` itself did not change: only its comment and a new import above it. It is a CALLER of
    // the changed `helper`, and callers are reached by the backward walk over the graph — seeding it
    // is not what selects its tests.
    expect(ids).not.toContain('src/svc.ts::serve');
    expect(ids).toEqual(['src/other.ts::reads', 'src/util.ts::added', 'src/util.ts::helper']);
  });

  it('refuses a carried pair when an identical body also sits in a file kept whole', async () => {
    const body = 'export function old(x: number) { return x * 3 + 1; }\n';
    await put('src/a.ts', `${body}export function keep() { return 1; }\n`);
    await put('src/b.ts', 'export const SETTING = 1;\nexport function existing() { return 2; }\n');
    await put('src/c.ts', 'export function other() { return 4; }\n');
    await commitAll();
    // `old` really moves to b.ts as `moved`; b.ts is kept whole (its constant changed), and a decoy
    // with the same body appears in c.ts. Carrying onto the decoy would be a wrong conclusion.
    await put('src/a.ts', 'export function keep() { return 1; }\n');
    await put('src/b.ts', 'export const SETTING = 2;\nexport function existing() { return 2; }\nexport function moved(x: number) { return x * 3 + 1; }\n');
    await put('src/c.ts', 'export function other() { return 4; }\nexport function decoy(x: number) { return x * 3 + 1; }\n');
    const { set } = await changedSet([
      { path: 'src/a.ts', status: 'modified' }, { path: 'src/b.ts', status: 'modified' }, { path: 'src/c.ts', status: 'modified' },
    ], ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(set.byFile.get('src/b.ts')).toEqual({ granularity: 'file', reason: 'module-level-change' });
    expect(set.carried).toEqual([]);
  });

  it('a moved import is a module-level change, while an added one is not', async () => {
    const base = "import { a } from './a';\nexport const READY = compute();\nexport function one() { return a(1); }\n";
    await put('src/mv.ts', base);
    await commitAll();
    await put('src/mv.ts', "export const READY = compute();\nimport { a } from './a';\nexport function one() { return a(1); }\n");
    const { set } = await changedSet([{ path: 'src/mv.ts', status: 'modified' }], ['src/mv.ts']);
    expect(set.byFile.get('src/mv.ts')).toEqual({ granularity: 'file', reason: 'module-level-change' });
  });

  it('a wildcard or blank import is never treated as purely additive', async () => {
    const py = 'from a import *\n\ndef user():\n    return run()\n';
    await put('w.py', py);
    await put('g.go', 'package p\n\nimport "fmt"\n\nfunc F() { fmt.Println() }\n');
    await commitAll();
    await put('w.py', 'from a import *\nfrom b import *\n\ndef user():\n    return run()\n');
    await put('g.go', 'package p\n\nimport (\n\t"fmt"\n\t_ "net/http/pprof"\n)\n\nfunc F() { fmt.Println() }\n');
    const { set } = await changedSet(
      [{ path: 'w.py', status: 'modified' }, { path: 'g.go', status: 'modified' }], ['w.py', 'g.go'],
    );
    expect(set.byFile.get('w.py')).toEqual({ granularity: 'file', reason: 'module-level-change' });
    expect(set.byFile.get('g.go')).toEqual({ granularity: 'file', reason: 'module-level-change' });
  });

  it('a symbol that changed but is absent from the index is reported as not indexed, never unchanged', async () => {
    await put('src/ten.ts', TEN);
    await commitAll();
    const callGraph = await index(repo, ['src/ten.ts']);   // indexed BEFORE the edit
    await put('src/ten.ts', `${TEN}\nexport function brandNew() { return 11; }\n`);
    const set = await computeSymbolChangedSet({ absDir: repo, baseRef: 'HEAD', diff: [{ path: 'src/ten.ts', status: 'modified' }], callGraph });
    const indexed = new Set(callGraph.nodes.map(n => n.id));
    const receipt = granularityReceipt(set, id => indexed.has(id));
    expect(receipt).toMatchObject({ changedSymbolsFound: 1, changedSymbolsNotIndexed: 1 });
    const claim = noChangeClaim(receipt);
    expect(claim.kind).toBe('not-indexed');
    expect(claim.text).toContain('Re-run analyze_codebase');
  });

  it('stops hashing when the time budget is spent, and says so', async () => {
    await put('src/ten.ts', TEN);
    await commitAll();
    await put('src/ten.ts', TEN.replace('return x + 1;', 'return 1;'));
    const { set, callGraph } = await changedSet([{ path: 'src/ten.ts', status: 'modified' }], ['src/ten.ts'], { budgetMs: 0 });
    expect(set.byFile.get('src/ten.ts')).toEqual({ granularity: 'file', reason: 'time-cap' });
    // Degrading is always the conservative direction: every symbol stays seeded.
    expect(narrowSeedsToChangedSymbols(callGraph.nodes.filter(n => !n.isExternal), set)).toHaveLength(10);
  });

  it('a working-tree entry that is not a regular file is unreadable, never a hang', async () => {
    await put('src/ten.ts', TEN);
    await commitAll();
    const callGraph = await index(repo, ['src/ten.ts']);   // index it while it is still a file
    await rm(join(repo, 'src/ten.ts'));
    execFileSync('mkfifo', [join(repo, 'src/ten.ts')]);
    const set = await computeSymbolChangedSet({
      absDir: repo, baseRef: 'HEAD', diff: [{ path: 'src/ten.ts', status: 'modified' }], callGraph,
    });
    expect(set.byFile.get('src/ten.ts')).toEqual({ granularity: 'file', reason: 'unreadable' });
  }, 15_000);

  it('a path git prints C-quoted is disclosed, not dropped', async () => {
    await put('src/ten.ts', TEN);
    await commitAll();
    const { set } = await changedSet(
      [{ path: '"src/we\\011ird.ts"', status: 'modified' }, { path: 'src/ten.ts', status: 'modified' }],
      ['src/ten.ts'],
    );
    expect([...set.byFile.entries()].some(([, c]) => c.granularity === 'file' && c.reason === 'not-assessed')).toBe(true);
  });

  it('parse errors on either side keep the file whole', async () => {
    await put('src/p.ts', 'export function a() { return 1; }\nexport function b() { return 2; }\n');
    await commitAll();
    await put('src/p.ts', 'export function a() { return 1; }\nexport function b() { return (2; }\n');
    const { set } = await changedSet([{ path: 'src/p.ts', status: 'modified' }], ['src/p.ts']);
    expect(set.byFile.get('src/p.ts')).toEqual({ granularity: 'file', reason: 'parse-errors' });
  });

  it('an index that lists a symbol neither revision has is an index mismatch', async () => {
    await put('src/i.ts', 'export function a() { return 1; }\n');
    await commitAll();
    await put('src/i.ts', 'export function ghost() { return 0; }\nexport function a() { return 1; }\n');
    const callGraph = await index(repo, ['src/i.ts']); // indexed with `ghost`
    await put('src/i.ts', 'export function a() { return 2; }\n');
    const set = await computeSymbolChangedSet({ absDir: repo, baseRef: 'HEAD', diff: [{ path: 'src/i.ts', status: 'modified' }], callGraph });
    expect(set.byFile.get('src/i.ts')).toEqual({ granularity: 'file', reason: 'index-mismatch' });
  });

  it('added and deleted files are all-appeared and all-disappeared', async () => {
    await put('src/old.ts', 'export function gone() { return 1; }\n');
    await commitAll();
    const callGraph = await index(repo, ['src/old.ts']);
    await rm(join(repo, 'src/old.ts'));
    await put('src/new.ts', 'export function fresh() { return 1; }\n');
    const both = serializeCallGraph(await new CallGraphBuilder().build([
      { path: 'src/new.ts', content: 'export function fresh() { return 1; }\n', language: 'TypeScript' },
    ]));
    const set = await computeSymbolChangedSet({
      absDir: repo, baseRef: 'HEAD',
      diff: [{ path: 'src/old.ts', status: 'deleted' }, { path: 'src/new.ts', status: 'added' }],
      callGraph: { ...callGraph, nodes: [...callGraph.nodes, ...both.nodes] },
    });
    expect(set.byFile.get('src/old.ts')).toMatchObject({ granularity: 'symbol', disappeared: ['src/old.ts::gone'] });
    expect(set.byFile.get('src/new.ts')).toMatchObject({ granularity: 'symbol', appeared: ['src/new.ts::fresh'] });
  });

  it('a moved file keeps every symbol seeded and reports the moves as carried', async () => {
    await put('src/a.ts', TEN);
    await commitAll();
    git('mv', 'src/a.ts', 'src/b.ts');
    const { set, callGraph } = await changedSet([{ path: 'src/b.ts', status: 'renamed', oldPath: 'src/a.ts' }], ['src/b.ts']);
    const change = set.byFile.get('src/b.ts') as SymbolGranularChange;
    // Every symbol has a NEW id that the index has never seen, and every importer must be updated:
    // a move is never "formatting only".
    expect(change.appeared).toHaveLength(10);
    expect(change.disappeared).toHaveLength(10);
    expect(narrowSeedsToChangedSymbols(callGraph.nodes.filter(n => !n.isExternal), set)).toHaveLength(10);
    expect(set.carried).toHaveLength(10);
    expect(set.carried[0]).toMatchObject({ from: 'src/a.ts::f0', to: 'src/b.ts::f0', reason: 'moved', basis: 'exact-body' });
  });

  it('a moved-and-edited file still seeds everything it moved', async () => {
    await put('src/a.ts', TEN);
    await commitAll();
    git('mv', 'src/a.ts', 'src/b.ts');
    await put('src/b.ts', TEN.replace('return x + 7;', 'return x + 70;'));
    const { set } = await changedSet([{ path: 'src/b.ts', status: 'renamed', oldPath: 'src/a.ts' }], ['src/b.ts']);
    const change = set.byFile.get('src/b.ts') as SymbolGranularChange;
    expect(change.appeared).toContain('src/b.ts::f7');
    expect(change.appeared).toHaveLength(10);
    expect(set.carried.map(c => c.to)).not.toContain('src/b.ts::f7'); // edited: no carry
  });

  it('maps repository paths into an analyzed subdirectory', async () => {
    await put('pkg/src/ten.ts', TEN);
    await commitAll();
    await put('pkg/src/ten.ts', TEN.replace('return x + 2;', 'return x + 20;'));
    const { set } = await changedSet([{ path: 'pkg/src/ten.ts', status: 'modified' }, { path: 'other/x.ts', status: 'modified' }], ['src/ten.ts'], { root: join(repo, 'pkg') });
    expect([...set.byFile.keys()]).toEqual(['src/ten.ts']);
    expect(set.byFile.get('src/ten.ts')).toMatchObject({ granularity: 'symbol', changed: ['src/ten.ts::f2'] });
  });

  it('files past the cap stay file-granular with a disclosed reason', async () => {
    await put('src/a.ts', TEN);
    await put('src/b.ts', TEN);
    await commitAll();
    await put('src/a.ts', TEN.replace('return x + 1;', 'return 1;'));
    await put('src/b.ts', TEN.replace('return x + 1;', 'return 1;'));
    const diff: DiffEntry[] = [{ path: 'src/b.ts', status: 'modified' }, { path: 'src/a.ts', status: 'modified' }];
    const { set } = await changedSet(diff, ['src/a.ts', 'src/b.ts'], { maxFiles: 1 });
    expect(set.byFile.get('src/a.ts')).toMatchObject({ granularity: 'symbol' });
    expect(set.byFile.get('src/b.ts')).toEqual({ granularity: 'file', reason: 'file-cap' });
  });

  it('a file whose base blob cannot be read stays file-granular', async () => {
    await put('src/a.ts', TEN);
    await commitAll();
    await put('src/a.ts', TEN.replace('return x + 1;', 'return 1;'));
    // Claim a rename from a path that never existed: the base read fails.
    const { set } = await changedSet([{ path: 'src/a.ts', status: 'renamed', oldPath: 'src/nope.ts' }], ['src/a.ts']);
    expect(set.byFile.get('src/a.ts')).toEqual({ granularity: 'file', reason: 'unreadable' });
  });

  it('ignores files the index holds no production symbols for', async () => {
    await put('README.md', '# x\n');
    await put('src/ten.ts', TEN);
    await commitAll();
    await put('README.md', '# y\n');
    const { set } = await changedSet([{ path: 'README.md', status: 'modified' }], ['src/ten.ts']);
    expect(set.byFile.size).toBe(0);
  });
});
