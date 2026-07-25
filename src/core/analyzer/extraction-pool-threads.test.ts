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

/**
 * Serialize a build. When `poolSize` is given the build MUST have run pooled — asserted
 * here, because `OPENLORE_NO_WORKERS` silently forces the serial lane and would otherwise
 * turn every comparison in this file into a vacuous serial-vs-serial pass.
 */
async function buildJson(files: ExtractionFile[], poolSize?: number): Promise<string> {
  const builder = new CallGraphBuilder(poolSize ? { extraction: { poolSize } } : {});
  const result = await builder.build(files.map(f => ({ ...f })));
  if (poolSize) {
    expect(result.extractionLane?.lane).toBe('pooled');
    expect(result.extractionLane?.workerFallbackFiles).toEqual([]);
  }
  return JSON.stringify(serializeCallGraph(result));
}

describe('extraction pool — real worker threads', () => {
  it('extracts on real threads and matches the serial lane byte for byte', async () => {
    if (!resolveWorkerEntry()) return; // no worker entry in this runtime — serial lane covers it
    const files = tsFiles(16);

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
    const files: ExtractionFile[] = [...tsFiles(8), lua, dart, ...tsFiles(8).map((f, i) => ({ ...f, path: `src/tail${i}.ts` }))];

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

  it('matches the serial lane for every native-grammar language, not just TypeScript', async () => {
    if (!resolveWorkerEntry()) return;
    // Each worker loads each grammar independently; a language that loads on the main
    // thread but not in a worker would return EMPTY rather than throw, so this pins
    // per-language parity instead of trusting one language to speak for the rest.
    const samples: Record<string, [string, string]> = {
      Python: ['py', 'def helper(x):\n    return x + 1\n\nclass Svc:\n    def run(self):\n        return helper(2)\n'],
      Go: ['go', 'package main\n\nfunc helper(x int) int { return x + 1 }\n\nfunc Run() int { return helper(2) }\n'],
      Rust: ['rs', 'fn helper(x: i32) -> i32 { x + 1 }\npub fn run() -> i32 { helper(2) }\n'],
      Ruby: ['rb', 'def helper(x)\n  x + 1\nend\n\nclass Svc\n  def run\n    helper(2)\n  end\nend\n'],
      Java: ['java', 'public class Svc {\n  static int helper(int x) { return x + 1; }\n  int run() { return helper(2); }\n}\n'],
      'C++': ['cpp', 'int helper(int x) { return x + 1; }\nint run() { return helper(2); }\n'],
      Swift: ['swift', 'func helper(_ x: Int) -> Int { return x + 1 }\nfunc run() -> Int { return helper(2) }\n'],
      JavaScript: ['js', 'export function helper(x) { return x + 1; }\nexport function run() { return helper(2); }\n'],
    };
    const files: ExtractionFile[] = [];
    for (const [language, [ext, src]] of Object.entries(samples)) {
      for (let i = 0; i < 3; i++) {
        files.push({
          path: `poly${i}_${language.replace(/\W/g, '')}.${ext}`,
          language,
          content: src.replace(/helper/g, `helper${i}`).replace(/run/g, `run${i}`),
        });
      }
    }

    process.env.OPENLORE_NO_WORKERS = '1';
    const serial = await buildJson(files);
    delete process.env.OPENLORE_NO_WORKERS;

    expect(await buildJson(files, POOL_SIZE)).toBe(serial);
    // Guard against a green comparison that passed because BOTH lanes found nothing. A
    // grammar genuinely missing from this environment yields nothing on either lane (which
    // the byte comparison already covers), so require breadth rather than a fixed list.
    const nodes: Array<{ language: string; isExternal?: boolean }> = JSON.parse(serial).nodes;
    const present = new Set(nodes.filter(n => !n.isExternal).map(n => n.language));
    expect(present.size).toBeGreaterThanOrEqual(4);
  }, 180_000);
});
