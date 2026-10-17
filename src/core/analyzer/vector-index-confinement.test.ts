/** A committed `vector-index` symlink must not let analyze write outside the repository. */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VectorIndex } from './vector-index.js';

// Directory symlinks need elevation on Windows.
describe.skipIf(process.platform === 'win32')('vector index confinement', () => {
  let root: string;
  let outputDir: string;
  let outside: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-vi-confine-')));
    outputDir = join(root, 'repo', '.openlore', 'analysis');
    outside = join(root, 'outside');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(outside);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('refuses a vector-index symlink that leaves the analysis directory', () => {
    symlinkSync(outside, join(outputDir, 'vector-index'));
    expect(() => VectorIndex.exists(outputDir)).toThrow(/Path escape blocked/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('still accepts a symlink that stays inside the analysis directory', () => {
    mkdirSync(join(outputDir, 'real-index'));
    symlinkSync(join(outputDir, 'real-index'), join(outputDir, 'vector-index'));
    expect(() => VectorIndex.exists(outputDir)).not.toThrow();
  });
});
