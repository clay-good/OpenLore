/**
 * The query-time working-tree overlay (change: overlay-dirty-files-at-query-time).
 *
 * The property that makes it safe to run by default: exceeding any bound returns exactly
 * what the product does today — answer from the index, disclose the staleness. So every
 * bound is tested for the fallback, not just for the happy path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OVERLAY_MAX_FILES,
  _overlayMemoSizeForTesting,
  _resetOverlayMemoForTesting,
  buildOverlayDisclosure,
  buildWorkingTreeOverlay,
} from './working-tree-overlay.js';

describe('buildWorkingTreeOverlay — the edited files, read from disk', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-overlay-'));
    await mkdir(join(root, 'src'), { recursive: true });
    _resetOverlayMemoForTesting();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (rel: string, source: string): Promise<void> => {
    await writeFile(join(root, rel), source, 'utf-8');
  };

  it('returns the symbols a file has NOW, including one the index never saw', async () => {
    await write('src/a.ts', 'export function indexed() {}\nexport function justAdded() {}\n');

    const overlay = await buildWorkingTreeOverlay(root, ['src/a.ts']);

    expect(overlay.coveredFiles).toEqual(['src/a.ts']);
    expect(overlay.nodes.map(n => n.name).sort()).toEqual(['indexed', 'justAdded']);
  });

  it('does not re-extract a file whose bytes it has already seen this session', async () => {
    await write('src/a.ts', 'export function f() {}\n');

    const first = await buildWorkingTreeOverlay(root, ['src/a.ts']);
    expect(_overlayMemoSizeForTesting()).toBe(1);
    const second = await buildWorkingTreeOverlay(root, ['src/a.ts']);

    // Same answer, one extraction: Pass 1 is a pure function of (language, content).
    expect(second.nodes.map(n => n.id)).toEqual(first.nodes.map(n => n.id));
    expect(_overlayMemoSizeForTesting()).toBe(1);
  });

  it('re-extracts once the file changes, and memoizes the new bytes', async () => {
    await write('src/a.ts', 'export function f() {}\n');
    await buildWorkingTreeOverlay(root, ['src/a.ts']);

    await write('src/a.ts', 'export function f() {}\nexport function g() {}\n');
    const after = await buildWorkingTreeOverlay(root, ['src/a.ts']);

    expect(after.nodes.map(n => n.name).sort()).toEqual(['f', 'g']);
    expect(_overlayMemoSizeForTesting()).toBe(2);
  });

  it('touches only the stale set, never a file outside it', async () => {
    await write('src/edited.ts', 'export function edited() {}\n');
    await write('src/untouched.ts', 'export function untouched() {}\n');

    const overlay = await buildWorkingTreeOverlay(root, ['src/edited.ts']);

    expect(overlay.coveredFiles).toEqual(['src/edited.ts']);
    expect(overlay.nodes.map(n => n.name)).not.toContain('untouched');
    expect(_overlayMemoSizeForTesting()).toBe(1);
  });

  it('does not bring back a symbol the working tree deleted', async () => {
    await write('src/a.ts', 'export function survivor() {}\n');

    const overlay = await buildWorkingTreeOverlay(root, ['src/a.ts']);

    expect(overlay.nodes.map(n => n.name)).toEqual(['survivor']);
    expect(overlay.nodes.map(n => n.name)).not.toContain('deleted');
  });

  it('marks that incoming edges still come from the index', async () => {
    await write('src/a.ts', 'export function f() {}\n');

    const overlay = await buildWorkingTreeOverlay(root, ['src/a.ts']);

    expect(overlay.edgesFromIndex).toBe(true);
  });

  it('answers from the index when the stale set exceeds the file cap', async () => {
    const files: string[] = [];
    for (let i = 0; i <= OVERLAY_MAX_FILES; i++) {
      await write(`src/f${i}.ts`, `export function f${i}() {}\n`);
      files.push(`src/f${i}.ts`);
    }

    const overlay = await buildWorkingTreeOverlay(root, files);

    expect(overlay.skipped).toBe('too-many-files');
    expect(overlay.nodes).toEqual([]);
    expect(overlay.coveredFiles).toEqual([]);
  });

  it('stops at the time budget and names the files it did not reach', async () => {
    await write('src/a.ts', 'export function a() {}\n');
    await write('src/b.ts', 'export function b() {}\n');
    let calls = 0;
    // A clock that jumps past the budget after the first file is inspected.
    const now = (): number => (calls++ === 0 ? 0 : 10_000);

    const overlay = await buildWorkingTreeOverlay(root, ['src/a.ts', 'src/b.ts'], { now });

    expect(overlay.skipped).toBe('time-budget-exceeded');
    expect(overlay.uncoveredFiles.map(f => f.filePath)).toContain('src/b.ts');
  });

  it('reports an unparsable file instead of failing the query', async () => {
    await write('src/broken.ts', 'export function ( { { { unterminated\n');

    const overlay = await buildWorkingTreeOverlay(root, ['src/broken.ts']);

    // Either the extractor recovered nothing or it refused — both are reported, neither throws.
    expect(overlay.coveredFiles.length + overlay.uncoveredFiles.length).toBe(1);
  });

  it('reports a file that is gone rather than raising', async () => {
    const overlay = await buildWorkingTreeOverlay(root, ['src/never-existed.ts']);

    expect(overlay.uncoveredFiles).toEqual([{ filePath: 'src/never-existed.ts', status: 'unreadable' }]);
    expect(overlay.nodes).toEqual([]);
  });

  it('refuses a path that escapes the repository', async () => {
    const overlay = await buildWorkingTreeOverlay(root, ['../../etc/passwd']);

    expect(overlay.coveredFiles).toEqual([]);
    expect(overlay.uncoveredFiles[0].status).toBe('unreadable');
  });

  it('reports an empty stale set as nothing to do', async () => {
    const overlay = await buildWorkingTreeOverlay(root, []);

    expect(overlay.skipped).toBe('no-stale-files');
    expect(overlay.edgesFromIndex).toBe(false);
  });
});

describe('buildOverlayDisclosure — what the caller is told', () => {
  it('says which files were read from disk and which still come from the index', () => {
    const disclosure = buildOverlayDisclosure({
      nodes: [],
      coveredFiles: ['src/a.ts'],
      uncoveredFiles: [{ filePath: 'src/b.ts', status: 'unparsable' }],
      edgesFromIndex: true,
    });

    expect(disclosure?.overlaidFiles).toEqual(['src/a.ts']);
    expect(disclosure?.indexedFiles).toEqual(['src/b.ts']);
    expect(disclosure?.note).toContain('still served from the index');
    // The limit is stated, never implied.
    expect(disclosure?.note).toContain('Callers of the re-read symbols come from the index');
  });

  it('names the skip reason when nothing could be read', () => {
    const disclosure = buildOverlayDisclosure({
      nodes: [],
      coveredFiles: [],
      uncoveredFiles: [{ filePath: 'src/a.ts', status: 'unreadable' }],
      skipped: 'too-many-files',
      edgesFromIndex: false,
    });

    expect(disclosure?.note).toContain('too-many-files');
    expect(disclosure?.note).toContain('results come from the index');
  });

  it('discloses nothing when there was no stale set at all', () => {
    expect(buildOverlayDisclosure({
      nodes: [], coveredFiles: [], uncoveredFiles: [], edgesFromIndex: false,
    })).toBeUndefined();
  });
});
