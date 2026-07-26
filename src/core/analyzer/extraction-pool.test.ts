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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractFilesForPass1,
  plannedPoolSize,
  resolveWorkerEntry,
  describeExtractionLane,
  isWorkerFaultMessage,
  WORKER_FAULT_MESSAGE_PREFIX,
  __resetExtractionPoolStateForTests,
  type ExtractionFile,
  type ExtractionLaneDisclosure,
  type ExtractionWorkerFactory,
  type ExtractionWorkerHandle,
  type ExtractionRequest,
  type ExtractionResponse,
} from './extraction-pool.js';
import { CallGraphBuilder, serializeCallGraph, dispatchFileExtract, type FileExtractResult } from './call-graph.js';
import { EXTRACTION_POOL_MAX, EXTRACTION_POOL_MIN_FILES, EXTRACTION_POOL_STARTUP_TIMEOUT_MS } from '../../constants.js';

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
  /**
   * Answer with an EMPTY result for these languages instead of extracting — a worker whose
   * grammar for that language failed to load in its own thread.
   */
  blindTo?: (language: string) => boolean;
  /** Reply with an id that does not match the request — an off-protocol worker. */
  wrongId?: boolean;
  /**
   * Report a THROW for these languages. The per-language grammar `import`s are not wrapped,
   * so a grammar that loads on the main thread but not in this thread surfaces as an error,
   * not as an empty result.
   */
  throwsFor?: (language: string) => boolean;
  /** Answer normally for the first N files, then throw — a worker that degrades mid-run. */
  throwsAfter?: number;
  /**
   * Report a WORKER FAULT for these files — what the worker's `uncaughtException` boundary sends
   * when something faults inside the thread rather than inside the file's extraction (change:
   * fix-analyze-native-abort-and-file-cost-budget).
   */
  faultsOn?: (file: ExtractionFile) => boolean;
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
    let answered = 0;
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
          const replyId = opts.wrongId ? id + 1000 : id;
          if (opts.throwsAfter !== undefined && answered++ >= opts.throwsAfter) {
            opts.completionLog?.push(id);
            send({ type: 'failed', id: replyId, message: 'degraded mid-run' });
            return;
          }
          if (opts.faultsOn?.(file)) {
            opts.completionLog?.push(id);
            send({
              type: 'failed',
              id: replyId,
              message: `${WORKER_FAULT_MESSAGE_PREFIX}: uncaught exception while extracting ${file.path} — Maximum call stack size exceeded`,
            });
            return;
          }
          if (opts.throwsFor?.(file.language)) {
            opts.completionLog?.push(id);
            send({ type: 'failed', id: replyId, message: `Cannot find module 'tree-sitter-${file.language}'` });
            return;
          }
          if (opts.blindTo?.(file.language)) {
            opts.completionLog?.push(id);
            send({ type: 'result', id: replyId, value: { nodes: [], rawEdges: [], cfg: new Map() } });
            return;
          }
          void dispatchFileExtract(file).then(
            (value) => { opts.completionLog?.push(id); send({ type: 'result', id: replyId, value }); },
            (err: Error) => { opts.completionLog?.push(id); send({ type: 'failed', id: replyId, message: err.message }); },
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

/**
 * The same emptiness predicate production uses: a result carrying no facts at all. Only
 * ever used to decide whether a worker's SILENCE has been proven trustworthy.
 */
function isEmpty(result: FileExtractResult | undefined): boolean {
  if (!result) return false;
  return result.nodes.length === 0 && result.rawEdges.length === 0 && !result.parseHealth && !result.style;
}

/** A disclosure with the routine fields filled in, for the describe-only assertions. */
function disclosure(partial: Partial<ExtractionLaneDisclosure>): ExtractionLaneDisclosure {
  return {
    lane: 'serial', poolSize: 0, workerFallbackFiles: [], laneDefectFiles: [], unprovenRechecks: 0,
    slowFiles: [], ...partial,
  };
}

afterEach(() => { vi.restoreAllMocks(); __resetExtractionPoolStateForTests(); });

// ---------------------------------------------------------------------------

describe('extraction pool — lane selection', () => {
  it('stays serial below the file-count floor, and says why', async () => {
    const files = corpus(EXTRACTION_POOL_MIN_FILES - 1);
    const { disclosure } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty);
    expect(disclosure.lane).toBe('serial');
    expect(disclosure.serialReason).toBe('too-few-files');
    expect(plannedPoolSize(files.length)).toBe(0);
  }, 30_000);

  it('OPENLORE_NO_WORKERS forces the serial lane even for a large build', async () => {
    // The suite already sets this flag; assert the contract rather than assuming it.
    expect(process.env.OPENLORE_NO_WORKERS).toBe('1');
    const { disclosure } = await extractFilesForPass1(corpus(EXTRACTION_POOL_MIN_FILES + 8), dispatchFileExtract, isEmpty);
    expect(disclosure.lane).toBe('serial');
    expect(disclosure.serialReason).toBe('disabled-by-env');
  }, 30_000);

  it('a normal serial choice is not reported as a degradation', () => {
    expect(describeExtractionLane(disclosure({ serialReason: 'too-few-files' }))).toBeUndefined();
    expect(describeExtractionLane(disclosure({ serialReason: 'insufficient-cores' }))).toBeUndefined();
    expect(describeExtractionLane(disclosure({ serialReason: 'pool-saturated' }))).toBeUndefined();
    expect(describeExtractionLane(disclosure({ lane: 'pooled', poolSize: 4 }))).toBeUndefined();
    // An empty re-check is routine work, not a degradation — it must stay silent.
    expect(describeExtractionLane(disclosure({ lane: 'pooled', poolSize: 4, unprovenRechecks: 9 }))).toBeUndefined();
    expect(describeExtractionLane(disclosure({ lane: 'pooled', poolSize: 4, workerFallbackFiles: ['a.ts'] })))
      .toMatch(/extraction pool degraded: 1 file\(s\) re-extracted on the main thread/);
    expect(describeExtractionLane(disclosure({ lane: 'pooled', poolSize: 4, laneDefectFiles: ['a.ts'] }))).toMatch(/no symbols for 1 file/);
    // Both happened: neither may swallow the other — an earlier revision dropped the
    // fallback count whenever a defect was also present.
    const both = describeExtractionLane(disclosure({
      lane: 'pooled', poolSize: 4, laneDefectFiles: ['a.ts'], workerFallbackFiles: ['b.ts', 'c.ts'],
    }));
    expect(both).toMatch(/no symbols for 1 file/);
    expect(both).toMatch(/2 file\(s\) re-extracted on the main thread/);
    expect(describeExtractionLane(disclosure({ serialReason: 'pool-unavailable' }))).toMatch(/serial lane/);
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

    const { outcomes, disclosure } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
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

    const { outcomes, disclosure } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
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
    const { outcomes, disclosure } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: factory,
      poolSize: 4,
    });
    expect(disclosure.workerFallbackFiles).toHaveLength(files.length);
    expect(outcomes.every(o => o.status === 'ok')).toBe(true);
    expect(await buildJson(files, { workerFactory: stubWorkerFactory({ dieOn: () => true }), poolSize: 4 })).toBe(await buildJson(files));
  }, 30_000);

  it('falls back to the serial lane wholesale when no worker comes up healthy', async () => {
    const files = corpus();
    const { outcomes, disclosure } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({ unhealthy: true }),
      poolSize: 4,
    });
    expect(disclosure.lane).toBe('serial');
    expect(disclosure.serialReason).toBe('pool-unavailable');
    expect(outcomes.every(o => o.status === 'ok')).toBe(true);
  }, 30_000);

  it('falls back when the worker factory itself throws', async () => {
    const { disclosure, outcomes } = await extractFilesForPass1(corpus(), dispatchFileExtract, isEmpty, {
      workerFactory: () => { throw new Error('spawn refused'); },
      poolSize: 4,
    });
    expect(disclosure.lane).toBe('serial');
    expect(disclosure.serialReason).toBe('pool-unavailable');
    expect(outcomes.every(o => o.status === 'ok')).toBe(true);
  }, 30_000);

  it('does not let a worker that fails everything write parse failures the serial lane never would', async () => {
    // A worker that reports a failure for every file has proven nothing, so nothing it says
    // is believed: each file is re-extracted on the main thread. Believing it would have
    // written `parseFailed` records and dropped every symbol — a graph that depends on which
    // lane ran, which is the one thing this change may not do.
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
    const result = await new CallGraphBuilder({ extraction: { workerFactory: failing, poolSize: 1 } })
      .build(files.map(f => ({ ...f })));
    expect(result.nodes.size).toBeGreaterThan(0);
    expect(result.parseHealthByFile).toBeUndefined();
    expect(result.extractionLane?.laneDefectFiles).toHaveLength(files.length);
    expect(JSON.stringify(serializeCallGraph(result))).toBe(await buildJson(files));
  }, 30_000);

  it('drops a worker that never reports ready instead of hanging', async () => {
    const files = corpus();
    vi.useFakeTimers();
    const promise = extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({ silentStartup: true }),
      poolSize: 2,
    });
    await vi.advanceTimersByTimeAsync(EXTRACTION_POOL_STARTUP_TIMEOUT_MS + 1_000);
    vi.useRealTimers();
    const { disclosure: d, outcomes } = await promise;
    expect(d.lane).toBe('serial');
    expect(d.serialReason).toBe('pool-unavailable');
    expect(outcomes).toHaveLength(files.length);
  }, 30_000);
});

describe('extraction pool — worker log relay', () => {
  it('prints a relayed grammar warning once, not once per worker', async () => {
    const { logger } = await import('../../utils/logger.js');
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    await extractFilesForPass1(corpus(), dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({ relayWarnings: ['language Lua grammar unavailable'] }),
      poolSize: 4,
    });
    const relayed = warn.mock.calls.filter(c => String(c[0]).includes('Lua grammar unavailable'));
    expect(relayed).toHaveLength(1);
  }, 30_000);
});

describe('extraction pool — never trust an unproven silence', () => {
  it('re-checks a worker that reports nothing for a language it has not proven, and discloses the defect', async () => {
    // The exact silent-loss shape: the grammar loaded on the main thread but not in the
    // worker, so the worker returns EMPTY rather than throwing.
    const files = corpus();
    const { outcomes, disclosure: d } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({ blindTo: (l) => l === 'TypeScript' }),
      poolSize: 2,
    });

    expect(d.lane).toBe('pooled');
    // Every file was re-checked, and every re-check found facts the worker had missed.
    expect(d.unprovenRechecks).toBe(files.length);
    expect(d.laneDefectFiles).toHaveLength(files.length);
    expect(outcomes.every(o => o.status === 'ok' && (o.value?.nodes.length ?? 0) > 0)).toBe(true);
    expect(describeExtractionLane(d)).toMatch(/no symbols for \d+ file/);
  }, 30_000);

  it('a blind worker still yields a graph byte-identical to the serial lane', async () => {
    const files = corpus();
    const pooled = await buildJson(files, {
      workerFactory: stubWorkerFactory({ blindTo: () => true }),
      poolSize: 2,
    });
    expect(pooled).toBe(await buildJson(files));
  }, 30_000);

  it('costs nothing on a healthy worker: a file that merely has no functions is not a silence', async () => {
    // The predicate matches the no-grammar SIGNATURE (no nodes, no edges, no style, no
    // parse health) — not "no functions". A real parse of a comment- or types-only file
    // still yields style counters, so ordinary empty files never trigger a re-check.
    const files: ExtractionFile[] = [
      { path: 'src/blank0.ts', language: 'TypeScript', content: '// nothing here\n' },
      { path: 'src/types.ts', language: 'TypeScript', content: 'export interface X { a: number }\n' },
      ...corpus(6),
    ];
    const { disclosure: d } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({}),
      poolSize: 1,
    });
    expect(d.lane).toBe('pooled');
    expect(d.unprovenRechecks).toBe(0);
    expect(d.laneDefectFiles).toEqual([]);
    expect(describeExtractionLane(d)).toBeUndefined();
  }, 30_000);

  it('re-checks only until the worker proves the language, for a language with no style counters', async () => {
    // Java carries no style tally, so a genuinely empty Java file IS indistinguishable from
    // a missing grammar — and is re-checked, until a real Java file proves the worker can
    // parse Java. That bounded cost is the price of never trusting an unproven silence.
    const blank = (i: number): ExtractionFile => ({ path: `Blank${i}.java`, language: 'Java', content: '// nothing\n' });
    const real: ExtractionFile = {
      path: 'Svc.java', language: 'Java',
      content: 'class Svc {\n  static int helper(int x) { return x + 1; }\n  int run() { return helper(2); }\n}\n',
    };
    const files = [blank(0), blank(1), real, blank(2), blank(3)];
    const { disclosure: d } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({}),
      poolSize: 1,
    });
    expect(d.lane).toBe('pooled');
    // The two before the proof are re-checked; the two after are trusted.
    expect(d.unprovenRechecks).toBe(2);
    expect(d.laneDefectFiles).toEqual([]);
    expect(describeExtractionLane(d)).toBeUndefined();
  }, 30_000);


  it('re-checks a worker that THROWS for a language it has not proven', async () => {
    // The other half of the same hazard: `getPyParser` and friends do NOT wrap their
    // per-language `import`, so a grammar that loads on the main thread but not in this
    // worker surfaces as a throw. Trusting it would record `parseFailed` and zero symbols
    // for files the serial lane extracts fully — a lane-dependent graph.
    const files = corpus();
    const { outcomes, disclosure: d } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({ throwsFor: (l) => l === 'TypeScript' }),
      poolSize: 2,
    });

    expect(d.lane).toBe('pooled');
    expect(d.unprovenRechecks).toBe(files.length);
    expect(d.laneDefectFiles).toHaveLength(files.length);
    expect(outcomes.every(o => o.status === 'ok' && (o.value?.nodes.length ?? 0) > 0)).toBe(true);
  }, 30_000);

  it('a throwing worker still yields a graph byte-identical to the serial lane', async () => {
    const files = corpus();
    const pooled = await buildJson(files, {
      workerFactory: stubWorkerFactory({ throwsFor: () => true }),
      poolSize: 2,
    });
    expect(pooled).toBe(await buildJson(files));
  }, 30_000);

  it('trusts an error from a worker that has already proven the language', async () => {
    // The guard must not launder every error into a re-check: once a worker has shown it
    // can extract a language, a throw from it is a real per-file parse failure and is
    // recorded as one — exactly as the serial lane would.
    const files = corpus(6);
    const { outcomes, disclosure: d } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({ throwsAfter: 3 }),
      poolSize: 1,
    });
    expect(d.lane).toBe('pooled');
    // The first three prove TypeScript; the throws that follow are believed, not re-checked.
    expect(d.unprovenRechecks).toBe(0);
    expect(d.laneDefectFiles).toEqual([]);
    expect(outcomes.slice(3).every(o => o.status === 'error')).toBe(true);
  }, 30_000);

  it('treats a language with no extractor as a deterministic answer, not a silence', async () => {
    // `undefined` (no extractor for this language) is identical on both lanes, so it must
    // NOT trigger a main-thread re-check on every single file.
    const files: ExtractionFile[] = Array.from({ length: 6 }, (_, i) => ({
      path: `notes${i}.txt`, language: 'PlainText', content: 'nothing to extract\n',
    }));
    const { outcomes, disclosure: d } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({}),
      poolSize: 2,
    });
    expect(d.unprovenRechecks).toBe(0);
    expect(outcomes.every(o => o.status === 'ok' && o.value === undefined)).toBe(true);
  }, 30_000);
});

describe('extraction pool — scheduling independence', () => {
  it('varies which files it re-checks, and never varies the output', async () => {
    // The subtlest hazard the unproven-silence guard introduces: WHICH files get re-checked
    // on the main thread depends on scheduling (a language is proven at a different point in
    // each run). This asserts both halves — that the re-check set really does vary, and that
    // the merged graph does not — across pool sizes and randomized interleavings.
    const languages: Array<[string, string, (i: number) => string]> = [
      ['ts', 'TypeScript', (i) => `export function h${i}(x: number): number { return x + ${i}; }\n`],
      ['java', 'Java', (i) => `class S${i} {\n  static int h(int x) { return x + ${i}; }\n  int r() { return h(2); }\n}\n`],
      // Empty AND carrying no style counters — the shape that takes the re-check path.
      ['java', 'Java', () => '// nothing at all\n'],
      ['py', 'Python', (i) => `def h${i}(x):\n    return x + ${i}\n`],
    ];
    const files: ExtractionFile[] = [];
    for (let i = 0; i < 3; i++) {
      for (const [ext, language, gen] of languages) {
        files.push({ path: `sched${i}_${files.length}.${ext}`, language, content: gen(i) });
      }
    }

    const baseline = await buildJson(files);
    const observedRecheckCounts = new Set<number>();

    for (let run = 0; run < 8; run++) {
      // A deterministic pseudo-random delay per file: the interleaving differs per run, but
      // the test itself does not depend on wall-clock timing.
      let seed = run * 7919 + 13;
      const nextDelay = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return (seed / 2 ** 32) * 5;
      };
      const result = await new CallGraphBuilder({
        extraction: { workerFactory: stubWorkerFactory({ delayFor: nextDelay }), poolSize: 1 + (run % 4) },
      }).build(files.map(f => ({ ...f })));

      observedRecheckCounts.add(result.extractionLane?.unprovenRechecks ?? 0);
      expect(JSON.stringify(serializeCallGraph(result))).toBe(baseline);
    }

    // If the re-check count never varied, this test would not be exercising the hazard.
    expect(observedRecheckCounts.size).toBeGreaterThan(1);
  }, 60_000);
});

describe('extraction pool — protocol and budget', () => {
  it('retires an off-protocol worker instead of waiting forever for the reply it owes', async () => {
    // A reply whose id does not match the one outstanding request. Ignoring it would leave
    // the request armed and hang the whole pass; the worker is retired instead.
    const files = corpus();
    const { outcomes, disclosure: d } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({ wrongId: true }),
      poolSize: 2,
    });
    expect(d.lane).toBe('pooled');
    expect(d.workerFallbackFiles).toHaveLength(files.length);
    expect(outcomes.every(o => o.status === 'ok')).toBe(true);
  }, 30_000);

  it('caps workers across the process, not per build', async () => {
    // Two builds in flight at once must not each plan a full pool: a worker's resident cost
    // is per process, and the MCP daemon does run builds concurrently (a background
    // self-heal rebuild alongside a tool-call build).
    const many = EXTRACTION_POOL_MIN_FILES + 64;
    const first = plannedPoolSize(many);
    // A machine too small for any pool has nothing to cap; the cores test covers that case.
    if (first === 0) return;

    // Workers that spawn and then say nothing, so they stay live while we look at the budget.
    const silent: ExtractionWorkerFactory = () => ({
      postMessage() { /* never answers */ },
      on() { /* no events */ },
      terminate() { /* nothing to stop */ },
    });
    const trivial = async (): Promise<FileExtractResult | undefined> => undefined;

    vi.useFakeTimers();
    // Hold the whole process budget. Sizing is otherwise core-bound, so this — not a
    // partial hold — is what proves the budget is the thing doing the capping.
    const holding = extractFilesForPass1(corpus(4), trivial, isEmpty, {
      workerFactory: silent,
      poolSize: EXTRACTION_POOL_MAX,
    });
    await Promise.resolve();
    expect(plannedPoolSize(many)).toBe(0);

    await vi.advanceTimersByTimeAsync(EXTRACTION_POOL_STARTUP_TIMEOUT_MS + 1_000);
    vi.useRealTimers();
    await holding;
    // …and the budget comes back once they are gone.
    expect(plannedPoolSize(many)).toBe(first);
  }, 30_000);
});

describe('extraction pool — the disclosure reaches a human', () => {
  // The lane note is deliberately NOT logged from the builder: `build()` also runs inside
  // the stdio MCP server, whose stdout carries JSON-RPC. That makes it easy for the note to
  // become dead plumbing — computed, carried on the artifacts, and rendered by nobody, which
  // is exactly what an earlier round of this change shipped. These guards pin both halves.

  const src = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8');

  it('the builder never logs the lane note itself', () => {
    const builder = readFileSync(join(__dirname, 'call-graph.ts'), 'utf-8');
    expect(builder).not.toMatch(/logger\.\w+\([^)]*describeExtractionLane/);
    expect(builder).not.toContain('describeExtractionLane');
  });

  it('the analyze CLI renders it', () => {
    // If this fails, a lane defect — a worker returning no symbols for a file that has them
    // — is computed and then silently discarded.
    expect(src('cli/commands/analyze.ts')).toContain('extractionLaneNote');
    expect(src('core/analyzer/artifact-generator.ts')).toContain('describeExtractionLane');
  });
});

// ---------------------------------------------------------------------------
// Worker faults (change: fix-analyze-native-abort-and-file-cost-budget)
// ---------------------------------------------------------------------------

describe('extraction pool — a worker fault degrades the LANE, never the file', () => {
  it('re-extracts a faulted file on the main thread even for a language the worker had proven', async () => {
    // The pool trusts an ordinary throw from a worker that has proven the language — that is a
    // real per-file parse failure. A WORKER FAULT is different in kind: it is evidence about the
    // thread, not about the file. Trusting it would blame the source for a defect in the thread
    // reading it, and would silently shrink the graph by exactly one file.
    const files = corpus();
    const faulted = files[files.length - 1].path; // last, so TypeScript is long since proven
    const { outcomes, disclosure: d } = await extractFilesForPass1(files, dispatchFileExtract, isEmpty, {
      workerFactory: stubWorkerFactory({ faultsOn: (f) => f.path === faulted }),
      poolSize: 1,
    });

    expect(d.lane).toBe('pooled');
    expect(d.workerFallbackFiles).toContain(faulted);
    // Every file, including the faulted one, carries real facts from the main thread.
    expect(outcomes.every(o => o.status === 'ok' && (o.value?.nodes.length ?? 0) > 0)).toBe(true);
  }, 30_000);

  it('yields a graph byte-identical to the serial lane when a worker faults', async () => {
    const files = corpus();
    const pooled = await buildJson(files, {
      workerFactory: stubWorkerFactory({ faultsOn: (f) => f.path.endsWith('mod3.ts') }),
      poolSize: 2,
    });
    expect(pooled).toBe(await buildJson(files));
  }, 30_000);

  it('classifies a fault message only by its marker, so an ordinary failure is never mistaken for one', () => {
    // The marker is message-keyed because a throw crossing the worker boundary is
    // structured-cloned — its class and properties do not survive.
    expect(isWorkerFaultMessage(`${WORKER_FAULT_MESSAGE_PREFIX}: uncaught exception while extracting a.ts — x`)).toBe(true);
    for (const m of [undefined, '', 'Unexpected token', "Cannot find module 'tree-sitter-python'"]) {
      expect(isWorkerFaultMessage(m)).toBe(false);
    }
  });

  it('the worker entry installs boundaries for the faults a try/catch cannot see', () => {
    // A structural guard, because the failure it prevents is a PROCESS-level abort: a fault that
    // reaches a worker's top level with no listener kills the thread, and (when raised inside a
    // native frame) the process, with no JavaScript error anywhere to attribute it.
    const worker = readFileSync(join(__dirname, 'extraction-worker.ts'), 'utf-8');
    expect(worker).toContain("process.on('uncaughtException'");
    expect(worker).toContain("process.on('unhandledRejection'");
    expect(worker).toContain('WORKER_FAULT_MESSAGE_PREFIX');
  });
});

describe('extraction pool — a slow file is attributable', () => {
  it('names the slowest files in the lane note, and says nothing when none were slow', () => {
    expect(describeExtractionLane(disclosure({ lane: 'pooled', poolSize: 4 }))).toBeUndefined();
    const note = describeExtractionLane(disclosure({
      lane: 'pooled', poolSize: 4, slowFiles: [{ path: 'src/big.ts', ms: 7_400 }],
    }));
    expect(note).toContain('src/big.ts');
    expect(note).toContain('7.4s');
  });

  it('carries the slow-file note even on an otherwise ordinary serial run', () => {
    // "too-few-files" is a routine choice and says nothing on its own — but a user who waited
    // still deserves to know WHICH file they waited on.
    const note = describeExtractionLane(disclosure({
      lane: 'serial', serialReason: 'too-few-files', slowFiles: [{ path: 'src/vendor.js', ms: 12_000 }],
    }));
    expect(note).toContain('src/vendor.js');
  });

  it('writes the live in-flight disclosure to stderr, never stdout', () => {
    // `logger`'s non-error levels go to STDOUT, and `build()` also runs inside `openlore mcp`,
    // whose stdout carries JSON-RPC frames. A per-file line there would corrupt the protocol.
    const pool = readFileSync(join(__dirname, 'extraction-pool.ts'), 'utf-8');
    expect(pool).toContain('process.stderr.write');
    expect(pool).not.toMatch(/logger\.\w+\([^)]*still extracting/);
  });
});
