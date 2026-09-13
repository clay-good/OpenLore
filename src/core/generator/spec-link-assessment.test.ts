/**
 * The file assessor behind `not-assessed` spec anchors (change: ground-generated-specs-in-the-graph).
 * An absent symbol is evidence of removal only in a file the analysis fully inventoried.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DependencyGraphResult, DependencyNode } from '../analyzer/dependency-graph.js';
import { ARTIFACT_PARSE_HEALTH, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR } from '../../constants.js';
import { buildFileAssessor } from './spec-link-service.js';

const graphOf = (...paths: string[]): DependencyGraphResult =>
  ({ nodes: paths.map(path => ({ id: path, file: { path }, exports: [] }) as unknown as DependencyNode), edges: [] }) as unknown as DependencyGraphResult;

describe('buildFileAssessor', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-assess-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('names each boundary, and vouches only for an analyzed, extracted, healthy file', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'skipped.ts'), 'export function x() {}');
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_PARSE_HEALTH), JSON.stringify({
      version: 1, files: [{ filePath: 'src/broken.ts', language: 'TypeScript', errorCount: 2, missingCount: 0, errorLines: [3] }],
    }));

    const assess = await buildFileAssessor(root, graphOf('src/ok.ts', 'src/broken.ts', 'src/job.go'));
    expect(assess('src/ok.ts')).toBeUndefined();
    expect(assess('src/job.go')).toBe('language-not-extracted');
    expect(assess('src/broken.ts')).toBe('parse-health-lower-bound');
    expect(assess('src/skipped.ts')).toBe('file-not-analyzed');
    // A file that exists nowhere is not a boundary: its absence is evidence.
    expect(assess('src/deleted.ts')).toBeUndefined();
  });
});
