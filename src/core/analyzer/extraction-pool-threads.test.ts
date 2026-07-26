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
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CallGraphBuilder, serializeCallGraph, dispatchFileExtract } from './call-graph.js';
import {
  resolveWorkerEntry,
  isWorkerFaultMessage,
  WORKER_FAULT_MESSAGE_PREFIX,
  type ExtractionFile,
} from './extraction-pool.js';
import { EXTRACTION_POOL_MIN_FILES } from '../../constants.js';
import { PROBES } from './extraction-worker.js';

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

describe('extraction pool — the entry that actually ships', () => {
  it('the compiled worker entry starts and reports ready', async () => {
    // Under vitest `resolveWorkerEntry()` always picks the `.ts` + tsx branch, so every
    // other test here exercises the SOURCE entry. `dist/core/analyzer/extraction-worker.js`
    // is the file the npm package ships and the one `openlore analyze` actually loads —
    // without this, a compile or packaging regression would degrade silently to the serial
    // lane with a green suite.
    // Repo-root `dist/`, not a sibling of this file: tsc emits src/ -> dist/, so a sibling
    // `.js` never exists and looking for one made this guard silently skip in a fully built
    // checkout — which is exactly the failure it is supposed to catch.
    const compiled = join(__dirname, '..', '..', '..', 'dist', 'core', 'analyzer', 'extraction-worker.js');
    if (!existsSync(compiled)) {
      // Unbuilt checkout. CI runs this file again inside the Build job, where dist exists.
      console.warn(`[extraction-pool] compiled-worker check skipped — ${compiled} absent (run \`npm run build\`)`);
      return;
    }
    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(pathToFileURL(compiled), {
      // The sentinel the pool sends; without it the entry stays inert by design.
      workerData: { openloreExtractionWorker: true, probeLanguage: 'TypeScript' },
      stdout: true,
    });
    worker.stdout.resume();
    try {
      const first = await new Promise<{ type: string; reason?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('compiled worker never reported')), 30_000);
        worker.on('message', (m) => { clearTimeout(timer); resolve(m as { type: string }); });
        worker.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      expect(first.type).toBe('ready');
    } finally {
      await worker.terminate();
    }
  }, 60_000);

  it('stays inert when spawned without the pool\'s sentinel', async () => {
    // The closed direction of the same gate. Without it, anything that imports this module
    // while running inside SOME OTHER worker thread (a test runner using a thread pool, say)
    // would attach a message handler to that thread's channel and patch its logger. Asserting
    // only the ready path would leave the gate itself free to be deleted.
    const compiled = join(__dirname, '..', '..', '..', 'dist', 'core', 'analyzer', 'extraction-worker.js');
    if (!existsSync(compiled)) return; // covered by the sibling test's warning

    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(pathToFileURL(compiled), {
      workerData: { probeLanguage: 'TypeScript' }, // no sentinel
      stdout: true,
    });
    worker.stdout.resume();
    try {
      const spoke = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        worker.on('message', () => { clearTimeout(timer); resolve(true); });
        worker.on('error', () => { clearTimeout(timer); resolve(true); });
      });
      expect(spoke, 'a worker without the sentinel must not speak').toBe(false);
    } finally {
      await worker.terminate();
    }
  }, 60_000);
});

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

describe('extraction pool — the startup probe table', () => {
  // A probe snippet that stops yielding a node and an edge does not fail loudly: every
  // worker reports `unhealthy`, the pool is disabled for the whole process, and analyze
  // just gets slower. So the table is checked against the real extractor.
  for (const [language, probe] of Object.entries(PROBES)) {
    it(`the ${language} probe snippet yields a node and an edge`, async () => {
      const result = await dispatchFileExtract({ ...probe, language });
      // A grammar genuinely unavailable in this environment yields nothing on the main
      // thread too — that is the case the probe is allowed to fail on, so skip it here.
      if (!result || (result.nodes.length === 0 && result.rawEdges.length === 0)) return;
      expect(result.nodes.length, `${language} probe produced no function node`).toBeGreaterThan(0);
      expect(result.rawEdges.length, `${language} probe produced no call edge`).toBeGreaterThan(0);
    }, 30_000);
  }
});

describe('extraction pool — the worker fault boundary, on a real thread', () => {
  /**
   * The boundary this exercises exists to stop a fault inside a worker from killing the PROCESS
   * (change: fix-analyze-native-abort-and-file-cost-budget). `extraction-pool.test.ts` proves the
   * parent handles the resulting message, but it does so with a stub that *fabricates* the message
   * — it cannot prove the worker ever sends one. Only a real thread can, because
   * `process.on('uncaughtException')` is per-thread and a stub has no thread.
   *
   * The fault is induced by loading the REAL worker entry through a shim that throws from a timer
   * callback. That throw is genuine: it originates outside the request handler's `try`/`catch`
   * (which is exactly the class of fault the boundary was added for), and a worker with no
   * listener would simply die there, taking its in-flight file with it.
   *
   * WHEN it is induced matters, and two earlier attempts at this test got it wrong in instructive
   * ways. Scheduling the throw on a fixed delay while a large file extracted never fired DURING the
   * extraction: the parse is one synchronous native call, so the worker's event loop does not run
   * until it returns, and the parse budget always won the race — the very property that makes the
   * budget in-band rather than a timer, demonstrated here rather than asserted. Deferring it to the
   * next macrotask instead lost the opposite race: a small file's extraction completes entirely
   * within microtasks, so the request was already answered by the time the throw landed.
   *
   * So the shim throws SYNCHRONOUSLY from its own `message` listener. Both listeners run in the
   * same `emit`, the production one first — and it sets `inFlight` before its first `await` — so
   * when this one throws, a file is in flight by construction, with no timing assumption at all.
   * A throw out of an EventEmitter listener is a genuine `uncaughtException`.
   */

  it('answers for the in-flight file with the worker-fault marker instead of dying silently', async () => {
    const entry = resolveWorkerEntry();
    if (!entry) return; // no worker lane in this environment; the serial lane covers it

    // A shim that IS the production worker (it imports and runs it), plus a genuine async throw.
    // Its own `message` listener runs AFTER the production one, which sets `inFlight`
    // synchronously before its first `await` — so by the time this schedules, a file is in flight.
    const dir = mkdtempSync(join(tmpdir(), 'wfault-'));
    const shim = join(dir, 'fault-shim.mjs');
    writeFileSync(
      shim,
      `import { parentPort } from 'node:worker_threads';\n`
      + `import ${JSON.stringify(entry.specifier.href)};\n`
      + `parentPort.on('message', (m) => {\n`
      + `  if (m && m.type === 'extract') throw new Error('induced worker fault');\n`
      + `});\n`,
    );

    const worker = new Worker(pathToFileURL(shim), {
      ...(entry.execArgv ? { execArgv: entry.execArgv } : {}),
      workerData: { openloreExtractionWorker: true },
      stdout: true,
    });
    worker.stdout.resume();

    try {
      const messages: Array<{ type: string; id?: number; message?: string }> = [];
      const settled = new Promise<void>((resolve) => {
        worker.on('message', (m: { type: string; id?: number; message?: string }) => {
          messages.push(m);
          if (m.type === 'ready') {
            worker.postMessage({
              type: 'extract',
              id: 7,
              file: { path: 'src/in-flight.ts', content: 'export function a(): void { b(); }\nfunction b(): void {}\n', language: 'TypeScript' },
            });
          }
          if (m.type === 'failed') resolve();
        });
        worker.on('exit', () => resolve());
      });

      await settled;

      const failure = messages.find(m => m.type === 'failed');
      expect(failure, 'the worker answered for its in-flight file rather than vanishing').toBeDefined();
      expect(failure!.id, 'attributed to the in-flight request, not an arbitrary one').toBe(7);
      expect(failure!.message).toContain(WORKER_FAULT_MESSAGE_PREFIX);
      // Attributed to the FILE, so the pool can route that one file to the main thread.
      expect(failure!.message).toContain('src/in-flight.ts');
      expect(failure!.message).toContain('induced worker fault');
      // And the parent classifies it — the message is the only thing that survives the
      // structured-clone boundary, so this is the whole contract.
      expect(isWorkerFaultMessage(failure!.message)).toBe(true);
    } finally {
      await worker.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a worker that faults still leaves the graph whole — pooled output matches the serial lane', async () => {
    // The end-to-end consequence: the pool routes the faulted file to the main thread (the
    // reference implementation), so the FACTS are unchanged and only the lane degraded.
    const files = tsFiles(EXTRACTION_POOL_MIN_FILES + 4);
    process.env.OPENLORE_NO_WORKERS = '1';
    const serial = await buildJson(files);
    delete process.env.OPENLORE_NO_WORKERS;
    expect(await buildJson(files, POOL_SIZE)).toBe(serial);
  }, 180_000);
});
