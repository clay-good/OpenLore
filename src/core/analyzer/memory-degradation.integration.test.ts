/**
 * Graceful memory degradation + determinism — end-to-end against the real built CLI binary.
 *
 * The unit tests cover the pure tier math ({@link chooseMemoryTier}, {@link resolveMemoryStrategy}).
 * This file spawns `node dist/cli/index.js analyze` on real fixtures and asserts the two
 * end-user-observable guarantees of `src/core/analyzer/memory-strategy.ts`:
 *
 *   1. Determinism under memory management — the produced artifact is a function of the repository,
 *      NOT of the machine's memory. Analyzing the same fixture under two different real heap sizes
 *      (`--max-old-space-size=2048` vs `=4096`, both with adaptive sizing off so neither re-execs)
 *      yields a BYTE-IDENTICAL `llm-context.json`. Same for two different CFG-overlay buffer/spill
 *      thresholds (`OPENLORE_CFG_OVERLAY_MEMORY_BYTES`): a memory-management knob must never leak
 *      into the artifact.
 *
 *   2. Over-capacity → usable, disclosed, reduced index, not a crash. Forcing the bottom tier
 *      (`OPENLORE_FORCE_MEMORY_TIER=shed-overlay-and-deep-analysis`) on a fixture large enough to
 *      engage the extraction worker pool (>= 32 files) still exits 0 with a non-empty call graph,
 *      writes ZERO `cfg_overlay` rows to `call-graph.db`, and discloses what it shed in
 *      `parse-health.json` (a `memoryDegradation` record) — the same discipline as an excluded-file
 *      boundary, so a downstream reader treats reduced coverage as reduced, never as genuine absence.
 *
 * Skipped automatically when dist/ is not built (so it never breaks cold CI; this is an
 * *.integration.test.ts, excluded from `npm run test:run`). Run with:
 *   npm run build && npx vitest run --config vitest.integration.config.ts src/core/analyzer/memory-degradation.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const CLI = join(REPO_ROOT, 'dist/cli/index.js');
const haveCli = existsSync(CLI);

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the built CLI. `extraEnv` is layered over the inherited environment; a value of `undefined`
 * deletes the key (used to UNSET `OPENLORE_NO_WORKERS`, which the integration config sets to force
 * the serial lane, so the over-capacity test can genuinely engage the worker pool).
 */
function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined>,
  cwd: string,
  extraNodeArgs: string[] = [],
): Run {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  const r = spawnSync('node', [...extraNodeArgs, CLI, ...args], { cwd, encoding: 'utf-8', env });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function cfgOverlayRowCount(repo: string): number {
  const db = new DatabaseSync(join(repo, '.openlore', 'analysis', 'call-graph.db'));
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM cfg_overlay').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function callGraphNodeCount(repo: string): number {
  const ctx = JSON.parse(
    readFileSync(join(repo, '.openlore', 'analysis', 'llm-context.json'), 'utf-8'),
  ) as { callGraph?: { nodes?: unknown[] } };
  return ctx.callGraph?.nodes?.length ?? 0;
}

function readParseHealth(repo: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repo, '.openlore', 'analysis', 'parse-health.json'), 'utf-8'));
}

/** Raw bytes of the produced llm-context.json, for byte-identity comparison. */
function llmContextBytes(repo: string): Buffer {
  return readFileSync(join(repo, '.openlore', 'analysis', 'llm-context.json'));
}

function initRepo(repo: string): void {
  try {
    execFileSync('node', [CLI, 'init'], { cwd: repo, stdio: 'ignore' });
  } catch {
    /* init is best-effort; a missing config surfaces as a clear analyze failure */
  }
}

// ============================================================================
// 1. DETERMINISM UNDER MEMORY MANAGEMENT
// ============================================================================

describe.skipIf(!haveCli)('memory management does not leak into the artifact (e2e)', () => {
  let repo = '';

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'mem-determinism-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    // A handful of files with real control flow (branches/loops → a non-trivial CFG overlay), so
    // the overlay buffer/spill knob has something to act on.
    for (let i = 0; i < 4; i++) {
      writeFileSync(
        join(repo, 'src', `mod${i}.ts`),
        `export function f${i}(n: number): string {\n` +
          `  if (n < 0) { return 'neg${i}'; }\n` +
          `  for (let k = 0; k < n; k++) { if (k % 2 === 0) { continue; } }\n` +
          `  return n > ${i} ? 'big' : 'small';\n` +
          `}\n`,
      );
    }
    initRepo(repo);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('two different real heap sizes → byte-identical llm-context.json', () => {
    // Both runs pin the heap AND opt out of adaptive sizing, so neither re-execs and the ONLY
    // difference between them is the heap limit — which must not reach the artifact.
    const small = runCli(['analyze', '--no-embed', '--force'], { OPENLORE_NO_AUTO_HEAP: '1' }, repo, [
      '--max-old-space-size=2048',
    ]);
    expect(small.status, small.stderr).toBe(0);
    const bytesSmall = llmContextBytes(repo);

    const big = runCli(['analyze', '--no-embed', '--force'], { OPENLORE_NO_AUTO_HEAP: '1' }, repo, [
      '--max-old-space-size=4096',
    ]);
    expect(big.status, big.stderr).toBe(0);
    const bytesBig = llmContextBytes(repo);

    expect(bytesBig.equals(bytesSmall)).toBe(true);
  }, 120_000);

  it('two different CFG-overlay buffer/spill thresholds → byte-identical llm-context.json', () => {
    // 1 byte forces the overlay to spill to disk immediately; a large value keeps it fully buffered
    // in memory. The persisted overlay — and the whole artifact — must be identical either way.
    const spill = runCli(
      ['analyze', '--no-embed', '--force'],
      { OPENLORE_NO_AUTO_HEAP: '1', OPENLORE_CFG_OVERLAY_MEMORY_BYTES: '1' },
      repo,
    );
    expect(spill.status, spill.stderr).toBe(0);
    const bytesSpill = llmContextBytes(repo);

    const buffered = runCli(
      ['analyze', '--no-embed', '--force'],
      { OPENLORE_NO_AUTO_HEAP: '1', OPENLORE_CFG_OVERLAY_MEMORY_BYTES: '1000000000' },
      repo,
    );
    expect(buffered.status, buffered.stderr).toBe(0);
    const bytesBuffered = llmContextBytes(repo);

    expect(bytesBuffered.equals(bytesSpill)).toBe(true);
  }, 120_000);
});

// ============================================================================
// 2. OVER-CAPACITY → USABLE, DISCLOSED, REDUCED, NOT A CRASH
// ============================================================================

describe.skipIf(!haveCli)('over-capacity repo degrades gracefully via the worker pool (e2e)', () => {
  let repo = '';
  const FILE_COUNT = 40; // > EXTRACTION_POOL_MIN_FILES (32) so the extraction worker pool engages

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'mem-overcap-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(
        join(repo, 'src', `mod${i}.ts`),
        `export function f${i}(n: number): string {\n` +
          `  if (n < 0) { return 'neg${i}'; }\n` +
          `  for (let k = 0; k < n; k++) { if (k % 2 === 0) { continue; } }\n` +
          `  return n > ${i} ? 'big' : 'small';\n` +
          `}\n`,
      );
    }
    initRepo(repo);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('forced bottom tier: exit 0, non-empty graph, ZERO overlay rows, disclosed in parse-health', () => {
    // Unset OPENLORE_NO_WORKERS (the integration config forces it on) so the worker pool actually
    // runs — this exercises the WORKER-side overlay-shed path (workerData → setWorkerCfgOverlayShed),
    // not just the main thread.
    const r = runCli(
      ['analyze', '--no-embed', '--force'],
      {
        OPENLORE_NO_AUTO_HEAP: '1',
        OPENLORE_NO_WORKERS: undefined,
        OPENLORE_FORCE_MEMORY_TIER: 'shed-overlay-and-deep-analysis',
      },
      repo,
    );

    // Usable, not a crash.
    expect(r.status, r.stderr).toBe(0);
    expect(callGraphNodeCount(repo)).toBeGreaterThan(0);

    // Reduced: the shed overlay produces zero cfg_overlay rows (the table exists, but is empty).
    expect(cfgOverlayRowCount(repo)).toBe(0);

    // Disclosed: parse-health.json carries the memoryDegradation record with the forced tier and
    // the shed list, so downstream reads reduced coverage as reduced, never as genuine absence.
    const health = readParseHealth(repo);
    const deg = health.memoryDegradation as
      | { tier: string; shed: string[] }
      | undefined;
    expect(deg).toBeDefined();
    expect(deg!.tier).toBe('shed-overlay-and-deep-analysis');
    expect(deg!.shed).toEqual(['cfg-overlay', 'deep-analysis-breadth']);
  }, 120_000);

  it('control: full fidelity over the same fixture DOES write overlay rows (shed is meaningful)', () => {
    // Without the forced tier and on a tiny fixture, the estimate fits the heap → full fidelity →
    // a populated overlay. This proves the zero above is the ladder shedding, not simply a fixture
    // that never had an overlay to begin with.
    const r = runCli(
      ['analyze', '--no-embed', '--force'],
      { OPENLORE_NO_AUTO_HEAP: '1', OPENLORE_NO_WORKERS: undefined },
      repo,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(cfgOverlayRowCount(repo)).toBeGreaterThan(0);

    // A full-fidelity run sheds nothing, so it carries no memoryDegradation disclosure.
    const healthPath = join(repo, '.openlore', 'analysis', 'parse-health.json');
    if (existsSync(healthPath)) {
      const health = JSON.parse(readFileSync(healthPath, 'utf-8')) as Record<string, unknown>;
      expect(health.memoryDegradation).toBeUndefined();
    }
  }, 120_000);
});
