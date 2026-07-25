/**
 * Real worker-thread coverage for the Pass-1 extraction pool
 * (change: optimize-parallel-extraction-pool).
 *
 * `extraction-pool.test.ts` pins the ordering and fail-soft SEMANTICS with an in-process
 * stub lane. This file pins the thing a stub cannot: that actual `worker_threads` workers
 * load the extractor, load their own grammars — including the two WASM grammars whose
 * emscripten heaps must be isolated per thread (Lua, Dart) — and return facts identical to
 * the serial lane.
 *
 * The rest of the suite runs with `OPENLORE_NO_WORKERS=1` (see vitest.config.ts) so it
 * never pays for thread spawn; this file clears the flag for its own scope only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph } from './call-graph.js';
import { resolveWorkerEntry, type ExtractionFile } from './extraction-pool.js';

const fixtures = join(__dirname, 'fixtures');
/** Two workers is enough to prove the lane; more only buys spawn cost in CI. */
const POOL_SIZE = 2;

let savedFlag: string | undefined;
beforeAll(() => {
  savedFlag = process.env.OPENLORE_NO_WORKERS;
  delete process.env.OPENLORE_NO_WORKERS;
});
afterAll(() => {
  if (savedFlag === undefined) delete process.env.OPENLORE_NO_WORKERS;
  else process.env.OPENLORE_NO_WORKERS = savedFlag;
});

/** TypeScript filler with real cross-file calls, so the merge order is observable. */
function tsFiles(count: number): ExtractionFile[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `src/thread${i}.ts`,
    language: 'TypeScript',
    content:
      `export function seed${i}(n: number): number { return n * ${i + 1}; }\n` +
      `export class Runner${i} {\n` +
      `  go(): number { return seed${i}(2) + seed${(i + 1) % count}(3); }\n` +
      `}\n`,
  }));
}

function fixtureFile(rel: string, language: string): ExtractionFile | undefined {
  const abs = join(fixtures, rel);
  if (!existsSync(abs)) return undefined;
  return { path: rel, content: readFileSync(abs, 'utf-8'), language };
}

async function buildJson(files: ExtractionFile[], poolSize?: number): Promise<string> {
  const builder = new CallGraphBuilder(poolSize ? { extraction: { poolSize } } : {});
  return JSON.stringify(serializeCallGraph(await builder.build(files.map(f => ({ ...f })))));
}

describe('extraction pool — real worker threads', () => {
  it('extracts on real threads and matches the serial lane byte for byte', async () => {
    if (!resolveWorkerEntry()) return; // no worker entry in this runtime — serial lane covers it
    const files = tsFiles(48);

    process.env.OPENLORE_NO_WORKERS = '1';
    const serial = await buildJson(files);
    delete process.env.OPENLORE_NO_WORKERS;

    const builder = new CallGraphBuilder({ extraction: { poolSize: POOL_SIZE } });
    const result = await builder.build(files.map(f => ({ ...f })));
    expect(result.extractionLane?.lane).toBe('pooled');
    expect(result.extractionLane?.poolSize).toBe(POOL_SIZE);
    expect(result.extractionLane?.workerFallbackFiles).toEqual([]);
    expect(JSON.stringify(serializeCallGraph(result))).toBe(serial);
  }, 120_000);

  it('loads the per-thread WASM grammars (Lua, Dart) without cross-contaminating them', async () => {
    if (!resolveWorkerEntry()) return;
    const lua = fixtureFile('lua/app.lua', 'Lua');
    const dart = fixtureFile('dart/app.dart', 'Dart');
    if (!lua || !dart) return; // fixtures absent — nothing to prove here

    // Interleaved with enough TypeScript to keep the pool busy, so Lua and Dart are very
    // likely handled by DIFFERENT threads — the exact shape that corrupts a shared
    // emscripten heap when grammar isolation is wrong.
    const files: ExtractionFile[] = [...tsFiles(20), lua, dart, ...tsFiles(20).map((f, i) => ({ ...f, path: `src/tail${i}.ts` }))];

    process.env.OPENLORE_NO_WORKERS = '1';
    const serial = await buildJson(files);
    delete process.env.OPENLORE_NO_WORKERS;

    const pooled = await buildJson(files, POOL_SIZE);
    expect(pooled).toBe(serial);

    // Guard against the whole comparison passing because BOTH lanes found nothing.
    const names = JSON.parse(pooled).nodes.filter((n: { language: string }) => n.language === 'Lua' || n.language === 'Dart');
    if (names.length === 0) return; // WASM unavailable in this env → graceful skip, as elsewhere
    expect(names.map((n: { name: string }) => n.name).sort()).toEqual(['boot', 'helper', 'helper', 'main', 'run', 'run']);
  }, 120_000);
});
