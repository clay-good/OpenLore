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

async function changedSet(diff: DiffEntry[], paths: string[], opts: { root?: string; maxFiles?: number } = {}) {
  const root = opts.root ?? repo;
  const callGraph = await index(root, paths);
  const set = await computeSymbolChangedSet({ absDir: root, baseRef: 'HEAD', diff, callGraph, maxFiles: opts.maxFiles });
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

  it('a renamed file compares against its old path', async () => {
    await put('src/a.ts', TEN);
    await commitAll();
    git('mv', 'src/a.ts', 'src/b.ts');
    await put('src/b.ts', TEN.replace('return x + 7;', 'return x + 70;'));
    const { set } = await changedSet([{ path: 'src/b.ts', status: 'renamed', oldPath: 'src/a.ts' }], ['src/b.ts']);
    expect(set.byFile.get('src/b.ts')).toMatchObject({ granularity: 'symbol', changed: ['src/b.ts::f7'], appeared: [], disappeared: [] });
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
