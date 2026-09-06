/**
 * The partial first-run index must be invisible in the finished product
 * (change: refine-first-run-partial-serving).
 *
 * Two properties, checked against a real analysis rather than a stub: a build that flushed
 * partial indexes produces byte-identical artifacts to one that did not, and nothing of the
 * partial index survives the publish. If either failed, partial serving would have turned a
 * deterministic pipeline into a history-dependent one — the exact trade this change refuses
 * to make.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAnalysisCore } from './analysis-core.js';
import { partialIndexDirOf, partialStampPathOf } from '../runtime/partial-index.js';

/** Artifacts whose bytes are the analysis's observable output. */
const ARTIFACTS = ['llm-context.json', 'repo-structure.json', 'dependency-graph.json'] as const;

let root: string;
let out: string;

async function plantRepo(dir: string): Promise<void> {
  await mkdir(join(dir, 'src', 'core'), { recursive: true });
  await writeFile(join(dir, 'src', 'core', 'math.ts'),
    'export function add(a: number, b: number): number { return a + b; }\n'
    + 'export function double(n: number): number { return add(n, n); }\n');
  await writeFile(join(dir, 'src', 'report.ts'),
    "import { double } from './core/math.js';\n"
    + 'export function report(n: number): string { return `${double(n)}`; }\n');
  await writeFile(join(dir, 'src', 'app.ts'),
    "import { report } from './report.js';\n"
    + 'export function main(): string { return report(21); }\n');
  await writeFile(join(dir, 'src', 'app.test.ts'),
    "import { main } from './app.js';\n"
    + "test('main', () => { expect(main()).toBe('42'); });\n");
  await writeFile(join(dir, 'helper.py'), 'def helper():\n    return 1\n');
  await writeFile(join(dir, 'README.md'), '# demo\n');
}

/** Analysis reports seen by the last {@link analyze} call. */
let reports: string[] = [];

async function analyze(partialServing: boolean): Promise<void> {
  reports = [];
  await runAnalysisCore(root, out, {
    maxFiles: 200,
    include: [],
    exclude: [],
    partialServing,
    reporter: { report: (event) => { if (event.detail) reports.push(event.detail); } },
  });
}

/** Did the run actually flush a partial index? The convergence claim is vacuous without this. */
function flushed(): boolean {
  return reports.some(detail => detail.startsWith('Partial index available'));
}

async function artifactBytes(): Promise<Record<string, string>> {
  const bytes: Record<string, string> = {};
  for (const name of ARTIFACTS) {
    bytes[name] = await readFile(join(out, name), 'utf8');
  }
  return bytes;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-partial-converge-'));
  out = join(root, '.openlore', 'analysis');
  await plantRepo(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a flushing build converges to the single-write output', () => {
  it('produces byte-identical artifacts with and without the flush lane', async () => {
    await analyze(true);
    // Non-vacuity: if the lane never armed, the byte comparison below would compare two
    // identical single-write builds and prove nothing.
    expect(flushed(), 'the flushing lane never actually flushed').toBe(true);
    const flushing = await artifactBytes();

    // Remove the whole `.openlore` tree, not just the artifacts: the walker skips that
    // directory, and leaving it would make the second run's corpus differ by one skipped
    // entry — a difference in the harness, not in the lanes under test.
    await rm(join(root, '.openlore'), { recursive: true, force: true });

    await analyze(false);
    const singleWrite = await artifactBytes();

    for (const name of ARTIFACTS) {
      expect(flushing[name], `${name} differs between the flushing and single-write lanes`)
        .toBe(singleWrite[name]);
    }
  });

  it('leaves no partial index behind once the analysis publishes', async () => {
    await analyze(true);
    expect(flushed()).toBe(true);

    expect(existsSync(partialStampPathOf(out))).toBe(false);
    expect(existsSync(partialIndexDirOf(out))).toBe(false);
  });

  it('writes no partial index at all when the lane is off', async () => {
    await analyze(false);
    expect(flushed()).toBe(false);
    expect(existsSync(partialIndexDirOf(out))).toBe(false);
  });

  it('publishes normally when the partial index cannot be written at all', async () => {
    // A file where the runtime directory must go: every partial write fails. The analysis
    // is what matters, and a first-run convenience must never be able to take it down.
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'runtime'), 'not a directory', 'utf8');

    await analyze(true);

    for (const name of ARTIFACTS) {
      expect(existsSync(join(out, name)), `${name} was not published`).toBe(true);
    }
    expect(existsSync(join(out, 'generation.json'))).toBe(true);
  });

  it('stays off for a re-analysis, which already has a published index to serve', async () => {
    await analyze(false);
    // Second run WITH the lane requested: a published generation exists, so the lane must
    // not arm — there is something strictly better than a partial index to answer from.
    await analyze(true);
    expect(flushed()).toBe(false);
    expect(existsSync(partialIndexDirOf(out))).toBe(false);
  });
});
