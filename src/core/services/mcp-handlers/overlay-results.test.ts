/**
 * Reconciling a ranked answer with the working tree
 * (change: overlay-dirty-files-at-query-time).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlayResults } from './overlay-results.js';
import { _resetOverlayMemoForTesting } from '../../analyzer/working-tree-overlay.js';

describe('overlayResults — the answer, reconciled with what is on disk', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-overlay-results-'));
    await mkdir(join(root, 'src'), { recursive: true });
    _resetOverlayMemoForTesting();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (rel: string, source: string): Promise<void> => {
    await writeFile(join(root, rel), source, 'utf-8');
  };

  it('returns the answer untouched when nothing is stale', async () => {
    const results = [{ name: 'a', filePath: 'src/a.ts' }];

    const out = await overlayResults(root, 'a', results, []);

    expect(out.results).toEqual(results);
    expect(out.additions).toEqual([]);
    expect(out.disclosure).toBeUndefined();
  });

  it('drops a row for a symbol the working tree no longer has', async () => {
    await write('src/a.ts', 'export function stillHere() {}\n');

    const out = await overlayResults(root, 'anything', [
      { name: 'stillHere', filePath: 'src/a.ts' },
      { name: 'deletedSinceIndexing', filePath: 'src/a.ts' },
    ], ['src/a.ts']);

    expect(out.results.map(r => r.name)).toEqual(['stillHere']);
    expect(out.removed).toEqual(['deletedSinceIndexing (src/a.ts)']);
  });

  it('updates the span and signature of a surviving indexed symbol', async () => {
    await write('src/a.ts', '\n\nexport function current(value: string) {}\n');

    const out = await overlayResults(root, 'current', [
      { name: 'current', filePath: 'src/a.ts', startLine: 1, signature: 'function current()' },
    ], ['src/a.ts']);

    expect(out.results[0].startLine).toBe(3);
    expect(out.results[0].signature).toContain('value: string');
    expect((out.results[0] as Record<string, unknown>).source).toBe('working-tree-overlay');
  });

  it('surfaces a symbol the index has never seen, unranked and labelled', async () => {
    await write('src/a.ts', 'export function existing() {}\nexport function spinnerGuard() {}\n');

    const out = await overlayResults(root, 'spinner', [
      { name: 'existing', filePath: 'src/a.ts' },
    ], ['src/a.ts']);

    expect(out.additions).toHaveLength(1);
    expect(out.additions[0]).toMatchObject({
      name: 'spinnerGuard',
      filePath: 'src/a.ts',
      source: 'working-tree-overlay',
    });
    // Unranked on purpose: there is no score field to mistake for the ranker's judgment.
    expect('score' in out.additions[0]).toBe(false);
  });

  it('does not surface working-tree symbols the caller did not ask about', async () => {
    await write('src/a.ts', 'export function unrelatedHelper() {}\nexport function alsoUnrelated() {}\n');

    const out = await overlayResults(root, 'spinner', [], ['src/a.ts']);

    expect(out.additions).toEqual([]);
  });

  it('never duplicates a symbol already in the ranked answer', async () => {
    await write('src/a.ts', 'export function spinnerGuard() {}\n');

    const out = await overlayResults(root, 'spinner', [
      { name: 'spinnerGuard', filePath: 'src/a.ts' },
    ], ['src/a.ts']);

    expect(out.additions).toEqual([]);
    expect(out.results).toHaveLength(1);
  });

  it('keeps the answer and discloses when no stale file could be read', async () => {
    const results = [{ name: 'a', filePath: 'src/gone.ts' }];

    const out = await overlayResults(root, 'a', results, ['src/gone.ts']);

    expect(out.results).toEqual(results);
    expect(out.disclosure?.note).toContain('results come from the index');
  });

  it('states which files were read and that callers still come from the index', async () => {
    await write('src/a.ts', 'export function f() {}\n');

    const out = await overlayResults(root, 'f', [{ name: 'f', filePath: 'src/a.ts' }], ['src/a.ts']);

    expect(out.disclosure?.overlaidFiles).toEqual(['src/a.ts']);
    expect(out.disclosure?.note).toContain('Callers of the re-read symbols come from the index');
  });
});
