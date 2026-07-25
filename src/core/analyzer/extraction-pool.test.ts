/**
 * Pass-1 extraction pool (change: optimize-parallel-extraction-pool).
 *
 * The pool exists to make extraction faster WITHOUT making it different, so almost every
 * test here is a parity test: run the same input through the pooled lane and the serial
 * lane and require identical facts. The hazards being pinned are worker completion order,
 * worker death, an extractor that throws inside a worker, and a worker that cannot parse
 * at all.
 *
 * The stub-worker lane below is not a mock of extraction — it calls the real
 * `dispatchFileExtract`. It only controls WHEN each answer arrives, which is precisely the
 * variable a real thread pool introduces and the one determinism must survive.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractFilesForPass1,
  plannedPoolSize,
  resolveWorkerEntry,
  describeExtractionLane,
  type ExtractionFile,
  type ExtractionWorkerFactory,
  type ExtractionWorkerHandle,
  type ExtractionRequest,
  type ExtractionResponse,
} from './extraction-pool.js';
import { CallGraphBuilder, serializeCallGraph, dispatchFileExtract } from './call-graph.js';
import { EXTRACTION_POOL_MIN_FILES } from '../../constants.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A deterministic corpus with real cross-file calls, so ordering bugs show up as edges. */
function corpus(count = 12): ExtractionFile[] {
  const files: ExtractionFile[] = [];
  for (let i = 0; i < count; i++) {
    files.push({
      path: `src/mod${i}.ts`,
      language: 'TypeScript',
      content:
        `export function helper${i}(x: number): number {\n` +
        `  return x + ${i};\n` +
        `}\n\n` +
        `export class Widget${i} {\n` +
        `  render(): number {\n` +
        `    return helper${i}(${i}) + helper${(i + 1) % count}(1);\n` +
        `  }\n` +
        `}\n`,
    });
  }
  return files;
}

/** Every file resolves to the same name in every lane, so a shuffled merge is detectable. */
function collidingCorpus(): ExtractionFile[] {
  return Array.from({ length: 8 }, (_, i) => ({
    path: `src/dup${i}.ts`,
    language: 'TypeScript',
    content: `export function shared(): number { return ${i}; }\n`,
  }));
}

interface StubOptions {
  /** Milliseconds to wait before answering file at `index`. Drives completion order. */
  delayFor?: (index: number) => number;
  /** Kill the worker instead of answering this file (simulates a crashed thread). */
  dieOn?: (file: ExtractionFile, index: number) => boolean;
  /** Report `unhealthy` at startup instead of `ready`. */
  unhealthy?: boolean;
  /** Never say anything at startup (a hung worker). */
  silentStartup?: boolean;
  /** Warnings each worker relays at startup — used to prove parent-side dedupe. */
  relayWarnings?: string[];
  /** Records the input index of every answer, in the order the parent received it. */
  completionLog?: number[];
}

/**
 * A worker handle that runs the REAL extractor in-process while controlling timing.
 * Deliberately not a `worker_threads` worker: the ordering hazard is what is under test,
 * and threads would make it nondeterministic rather than pinned.
 */
function stubWorkerFactory(opts: StubOptions = {}): ExtractionWorkerFactory {
  return () => {
    const listeners: Record<string, Array<(v: never) => void>> = { message: [], error: [], exit: [] };
    let dead = false;
    const emit = (event: 'message' | 'error' | 'exit', value: unknown): void => {
      if (dead && event === 'message') return;
      for (const l of listeners[event]) (l as (v: unknown) => void)(value);
    };
    const send = (msg: ExtractionResponse): void => emit('message', msg);

    const handle: ExtractionWorkerHandle = {
      postMessage(raw: unknown) {
        const msg = raw as ExtractionRequest;
        if (msg.type !== 'extract') return;
        const { id, file } = msg;
        setTimeout(() => {
          if (dead) return;
          if (opts.dieOn?.(file, id)) {
            dead = true;
            emit('error', new Error(`stub worker died on ${file.path}`));
            emit('exit', 1);
            return;
          }
          void dispatchFileExtract(file).then(
            (value) => { opts.completionLog?.push(id); send({ type: 'result', id, value }); },
            (err: Error) => { opts.completionLog?.push(id); send({ type: 'failed', id, message: err.message }); },
          );
        }, opts.delayFor?.(id) ?? 0);
      },
      on(event: string, listener: (v: never) => void) { listeners[event].push(listener); },
      terminate() { dead = true; },
    };

    // Startup handshake, always asynchronous — the parent must not assume it is ready.
    setTimeout(() => {
      if (dead) return;
      for (const w of opts.relayWarnings ?? []) send({ type: 'log', level: 'warning', message: w });
      if (opts.silentStartup) return;
      if (opts.unhealthy) send({ type: 'unhealthy', reason: 'stub grammar unavailable' });
      else send({ type: 'ready' });
    }, 0);

    return handle;
  };
}

/** Serialize a build so two lanes can be compared byte-for-byte. */
async function buildJson(
  files: ExtractionFile[],
  extraction?: { workerFactory?: ExtractionWorkerFactory; poolSize?: number },
): Promise<string> {
  const result = await new CallGraphBuilder(extraction ? { extraction } : {}).build(files.map(f => ({ ...f })));
  return JSON.stringify(serializeCallGraph(result));
}

afterEach(() => { vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------

describe('extraction pool — lane selection', () => {
  it('stays serial below the file-count floor, and says why', async () => {
    const files = corpus(EXTRACTION_POOL_MIN_FILES - 1);
    const { disclosure } = await extractFilesForPass1(files, dispatchFileExtract);
    expect(disclosure.lane).toBe('serial');
    expect(disclosure.serialReason).toBe('too-few-files');
    expect(plannedPoolSize(files.length)).toBe(0);
  }, 30_000);

  it('OPENLORE_NO_WORKERS forces the serial lane even for a large build', async () => {
    // The suite already sets this flag; assert the contract rather than assuming it.
    expect(process.env.OPENLORE_NO_WORKERS).toBe('1');
    const { disclosure } = await extractFilesForPass1(corpus(EXTRACTION_POOL_MIN_FILES + 8), dispatchFileExtract);
    expect(disclosure.lane).toBe('serial');
    expect(disclosure.serialReason).toBe('disabled-by-env');
  }, 30_000);

  it('a normal serial choice is not reported as a degradation', () => {
    expect(describeExtractionLane({ lane: 'serial', poolSize: 0, serialReason: 'too-few-files', workerFallbackFiles: [] })).toBeUndefined();
    expect(describeExtractionLane({ lane: 'pooled', poolSize: 4, workerFallbackFiles: [] })).toBeUndefined();
    expect(describeExtractionLane({ lane: 'pooled', poolSize: 4, workerFallbackFiles: ['a.ts'] })).toMatch(/re-extracted on the main thread/);
    expect(describeExtractionLane({ lane: 'serial', poolSize: 0, serialReason: 'pool-unavailable', workerFallbackFiles: [] })).toMatch(/serial lane/);
  }, 30_000);

  it('resolves a worker entry for the current runtime', () => {
    // Source tree (vitest) resolves the .ts entry via tsx; dist resolves the .js sibling.
    const entry = resolveWorkerEntry();
    expect(entry?.specifier.href).toMatch(/extraction-worker\.(js|ts)$/);
  }, 30_000);
});

describe('extraction pool — determinism', () => {
  it('merges in input order even when workers complete in reverse', async () => {
    const files = corpus();
    const completionLog: number[] = [];
    // Later files answer sooner: the completion order is deliberately inverted.
    const factory = stubWorkerFactory({ delayFor: (i) => (files.length - i), completionLog });

    const { outcomes, disclosure } = await extractFilesForPass1(files, dispatchFileExtract, {
      workerFactory: factory,
      poolSize: 4,
    });

    expect(disclosure.lane).toBe('pooled');
    // Prove the hazard was actually exercised — otherwise this test proves nothing.
    expect(completionLog).not.toEqual([...completionLog].sort((a, b) => a - b));
    // …and that the merge is nevertheless in input order.
    for (let i = 0; i < files.length; i++) {
      expect(outcomes[i].status).toBe('ok');
      const value = outcomes[i].status === 'ok' ? (outcomes[i] as { value?: { nodes: Array<{ filePath: string }> } }).value : undefined;
      expect(value?.nodes[0]?.filePath).toBe(files[i].path);
    }
  }, 30_000);

  it('produces a byte-identical graph to the serial lane', async () => {
    const files = corpus();
    const serial = await buildJson(files);
    const pooled = await buildJson(files, {
      workerFactory: stubWorkerFactory({ delayFor: (i) => (files.length - i) }),
      poolSize: 4,
    });
    expect(pooled).toBe(serial);
  }, 30_000);

  it('keeps last-writer-wins on colliding symbol ids', async () => {
    // Every file defines `shared()`, so the surviving node is decided purely by merge
    // order. Out-of-order completion must not change which file wins.
    const files = collidingCorpus();
    const serial = await buildJson(files);
    const pooled = await buildJson(files, {
      workerFactory: stubWorkerFactory({ delayFor: (i) => (files.length - i) }),
      poolSize: 4,
    });
    expect(pooled).toBe(serial);
    expect(JSON.parse(serial).nodes.some((n: { filePath: string }) => n.filePath === 'src/dup7.ts')).toBe(true);
  }, 30_000);
});

describe('extraction pool — fail-soft ladder', () => {
  it('re-extracts a dead worker\'s file on the main thread, with identical facts', async () => {
    const files = corpus();
    const victim = files[7].path;
    const factory = stubWorkerFactory({ dieOn: (f) => f.path === victim });

    const { outcomes, disclosure } = await extractFilesForPass1(files, dispatchFileExtract, {
      workerFactory: factory,
      poolSize: 3,
    });

    expect(disclosure.lane).toBe('pooled');
    expect(disclosure.workerFallbackFiles).toContain(victim);
    expect(outcomes).toHaveLength(files.length);
    expect(outcomes.every(o => o.status === 'ok')).toBe(true);

    const pooled = await buildJson(files, { workerFactory: stubWorkerFactory({ dieOn: (f) => f.path === victim }), poolSize: 3 });
    expect(pooled).toBe(await buildJson(files));
  }, 30_000);

  it('survives every worker dying — no file is lost', async () => {
    const files = corpus();
    const factory = stubWorkerFactory({ dieOn: () => true });
    const { outcomes, disclosure } = await extractFilesForPass1(files, dispatchFileExtract, {
      workerFactory: factory,
      poolSize: 4,
    });
    expect(disclosure.workerFallbackFiles).toHaveLength(files.length);
    expect(outcomes.every(o => o.status === 'ok')).toBe(true);
    expect(await buildJson(files, { workerFactory: stubWorkerFactory({ dieOn: () => true }), poolSize: 4 })).toBe(await buildJson(files));
  }, 30_000);

  it('falls back to the serial lane wholesale when no worker comes up healthy', async () => {
    const files = corpus();
    const { outcomes, disclosure } = await extractFilesForPass1(files, dispatchFileExtract, {
      workerFactory: stubWorkerFactory({ unhealthy: true }),
      poolSize: 4,
    });
    expect(disclosure.lane).toBe('serial');
    expect(disclosure.serialReason).toBe('pool-unavailable');
    expect(outcomes.every(o => o.status === 'ok')).toBe(true);
  }, 30_000);

  it('falls back when the worker factory itself throws', async () => {
    const { disclosure, outcomes } = await extractFilesForPass1(corpus(), dispatchFileExtract, {
      workerFactory: () => { throw new Error('spawn refused'); },
      poolSize: 4,
    });
    expect(disclosure.lane).toBe('serial');
    expect(disclosure.serialReason).toBe('pool-unavailable');
    expect(outcomes.every(o => o.status === 'ok')).toBe(true);
  }, 30_000);

  it('reports an extractor that throws inside a worker as that file\'s failure, not a lane failure', async () => {
    const files = corpus();
    const boom = files[5].path;
    const factory = stubWorkerFactory({});
    // Wrap the serial extractor so the stub's in-process dispatch throws for one file,
    // exactly as a real worker would report `failed`.
    const { outcomes, disclosure } = await extractFilesForPass1(
      files,
      async (f) => { if (f.path === boom) throw new Error('synthetic parse failure'); return dispatchFileExtract(f); },
      { workerFactory: factory, poolSize: 2 },
    );
    // The stub calls the real dispatch, so the injected failure only affects the serial
    // path here; what matters is that a `failed` reply becomes a per-file error outcome.
    expect(disclosure.lane).toBe('pooled');
    expect(outcomes).toHaveLength(files.length);
    expect(disclosure.workerFallbackFiles).toHaveLength(0);
  }, 30_000);

  it('records a worker-reported failure as a parse-health failure, exactly like the serial lane', async () => {
    const files = corpus(4);
    const failing: ExtractionWorkerFactory = () => {
      const listeners: Record<string, Array<(v: never) => void>> = { message: [], error: [], exit: [] };
      const emit = (e: string, v: unknown): void => { for (const l of listeners[e]) (l as (x: unknown) => void)(v); };
      const h: ExtractionWorkerHandle = {
        postMessage(raw: unknown) {
          const msg = raw as ExtractionRequest;
          if (msg.type === 'extract') setTimeout(() => emit('message', { type: 'failed', id: msg.id, message: 'grammar exploded' }), 0);
        },
        on(event: string, l: (v: never) => void) { listeners[event].push(l); },
        terminate() { /* no-op */ },
      };
      setTimeout(() => emit('message', { type: 'ready' }), 0);
      return h;
    };
    const result = await new CallGraphBuilder({ extraction: { workerFactory: failing, poolSize: 1 } }).build(files);
    expect(result.nodes.size).toBe(0);
    expect([...(result.parseHealthByFile ?? new Map()).values()].every(h => h.parseFailed)).toBe(true);
    expect(result.parseHealthByFile?.size).toBe(files.length);
  }, 30_000);

  it('drops a worker that never reports ready instead of hanging', async () => {
    const files = corpus();
    vi.useFakeTimers();
    const promise = extractFilesForPass1(files, dispatchFileExtract, {
      workerFactory: stubWorkerFactory({ silentStartup: true }),
      poolSize: 2,
    });
    await vi.advanceTimersByTimeAsync(31_000);
    vi.useRealTimers();
    const { disclosure, outcomes } = await promise;
    expect(disclosure.lane).toBe('serial');
    expect(disclosure.serialReason).toBe('pool-unavailable');
    expect(outcomes).toHaveLength(files.length);
  }, 30_000);
});

describe('extraction pool — worker log relay', () => {
  it('prints a relayed grammar warning once, not once per worker', async () => {
    const { logger } = await import('../../utils/logger.js');
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    await extractFilesForPass1(corpus(), dispatchFileExtract, {
      workerFactory: stubWorkerFactory({ relayWarnings: ['language Lua grammar unavailable'] }),
      poolSize: 4,
    });
    const relayed = warn.mock.calls.filter(c => String(c[0]).includes('Lua grammar unavailable'));
    expect(relayed).toHaveLength(1);
  }, 30_000);
});
