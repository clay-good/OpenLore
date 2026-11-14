/**
 * Every symbol-taking tool resolves `Class.method` — the form the generated digest prints a hub in.
 *
 * Before: get_minimal_context, get_cluster, find_path and locate_symbol_span answered "not found";
 * find_clones and analyze_error_propagation resolved the EXTERNAL leaf whose name is the dotted call
 * text (`Store.open`) and reported it uncomparable / unsupported. Drives the real handlers over a
 * real analysis of a two-class fixture where `open` is a shared method name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreInit } from '../../../api/init.js';
import { openloreAnalyze } from '../../../api/analyze.js';
import { handleGetMinimalContext, handleGetCluster } from './analysis.js';
import { handleFindPath } from './pathfind.js';
import { handleLocateSymbolSpan } from './symbol-span.js';
import { handleFindClones } from './clone-query.js';
import { handleAnalyzeErrorPropagation } from './error-propagation.js';
import { _resetContextCacheForTesting } from './utils.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ol-symbol-query-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  await writeFile(join(dir, 'src', 'store.ts'), [
    'export class Store {',
    '  static open(path: string): Store {',
    '    if (!path) throw new Error("no path");',
    '    const s = new Store();',
    '    s.load(path);',
    '    return s;',
    '  }',
    '  load(path: string): void {',
    '    if (path.length > 100) throw new Error("long");',
    '  }',
    '}',
    '',
  ].join('\n'));
  await writeFile(join(dir, 'src', 'file.ts'), [
    'export class FileHandle {',
    '  open(): number { return 1; }',
    '}',
    '',
  ].join('\n'));
  await writeFile(join(dir, 'src', 'main.ts'), [
    "import { Store } from './store';",
    'export function main(): void {',
    "  const store = Store.open('db');",
    '  void store;',
    '}',
    '',
  ].join('\n'));
  await openloreInit({ rootPath: dir });
  await openloreAnalyze({ rootPath: dir });
}, 60_000);
afterAll(async () => {
  // Close the cached graph store first: Windows will not delete an open SQLite file.
  _resetContextCacheForTesting();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 60_000);

const json = (r: unknown) => JSON.stringify(r);

describe('Class.method across the symbol-taking tools', () => {
  it('get_minimal_context and get_cluster', async () => {
    expect(json(await handleGetMinimalContext(dir, 'Store.open'))).not.toMatch(/not found/);
    expect(json(await handleGetCluster(dir, 'Store.open'))).not.toMatch(/not found/);
  });

  it('find_path', async () => {
    const r = await handleFindPath(dir, 'main', 'Store.open') as { error?: string; path?: unknown };
    expect(r.error).toBeUndefined();
    expect(r.path).toBeTruthy();
  });

  it('locate_symbol_span', async () => {
    const r = await handleLocateSymbolSpan({ directory: dir, symbol: 'Store.open' }) as { verdict: string; file?: string };
    expect(r.verdict).not.toBe('not-found');
    expect(r.file).toBe('src/store.ts');
  });

  it('find_clones and analyze_error_propagation name the method, not an external leaf', async () => {
    expect(json(await handleFindClones({ directory: dir, symbol: 'Store.open' }))).not.toMatch(/no comparable body/);
    const ep = await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'Store.open' }) as { unsupported?: boolean; query?: { language?: string } };
    expect(ep.unsupported).toBeUndefined();
    expect(ep.query?.language).toBe('TypeScript');
  });
});
