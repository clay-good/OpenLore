/**
 * Pass-1 extraction worker entry (change: optimize-parallel-extraction-pool).
 *
 * One instance of this module runs per pool worker. It holds this thread's own
 * tree-sitter parser and grammar singletons (the module-level caches in
 * `call-graph.ts` are per-module-registry, so a worker thread gets its own set for
 * free) and answers one request at a time:
 *
 *   parent → { type: 'extract', id, file }   worker → { type: 'result', id, value }
 *                                                   | { type: 'failed', id, message }
 *
 * It contains NO extraction logic of its own — it calls the same
 * `dispatchFileExtract` the serial lane calls, which is what makes the two lanes
 * provably identical rather than merely similar.
 *
 * Two honesty rules are implemented here:
 *
 *  - **Startup probe.** The extractors return an empty result (they do not throw) when a
 *    grammar cannot be loaded, so a worker whose bindings failed would silently contribute
 *    nothing to the graph. Before accepting work this thread parses a known-good snippet in
 *    the language the parent named and requires the expected node and edge; a worker that
 *    cannot do that reports itself `unhealthy` and is dropped. This is a FAST-FAIL, not the
 *    guarantee: it covers one language, and the pool's per-language unproven-silence guard
 *    is what actually makes an empty result trustworthy.
 *  - **Log relay.** A grammar that is genuinely unavailable warns once per thread. Left
 *    alone that prints N times, interleaves with the parent's spinner, and — because a
 *    worker inherits no console patching — could write to a stdout that is carrying
 *    JSON-RPC. So the logger is redirected to the parent, which dedupes and prints once.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { dispatchFileExtract } from './call-graph.js';
import { setWorkerCfgOverlayShed } from './memory-strategy.js';
import { logger } from '../../utils/logger.js';
import { WORKER_FAULT_MESSAGE_PREFIX } from './extraction-pool.js';
import type { ExtractionRequest, ExtractionResponse, ExtractionWorkerData } from './extraction-pool.js';

/**
 * Probe sources, per language: one function containing one call — the minimum that proves a
 * real parse produced both a node and an edge.
 *
 * The parent picks which language to probe from the build's OWN files, because every
 * grammar is an optional dependency: probing TypeScript in a Python repo could disable the
 * pool over a grammar that repo never needed. A language absent from this table simply
 * skips the probe — the per-language unproven-silence guard in the pool still covers it,
 * so the probe is a fast-fail optimization, never the sole line of defense.
 */
export const PROBES: Record<string, { path: string; content: string }> = {
  TypeScript: { path: '__openlore_probe__.ts', content: 'export function olProbe(): void { olProbeCallee(); }\n' },
  JavaScript: { path: '__openlore_probe__.js', content: 'export function olProbe() { olProbeCallee(); }\n' },
  Python: { path: '__openlore_probe__.py', content: 'def ol_probe():\n    ol_probe_callee()\n' },
  Go: { path: '__openlore_probe__.go', content: 'package p\n\nfunc OlProbe() { olProbeCallee() }\n' },
  Rust: { path: '__openlore_probe__.rs', content: 'fn ol_probe() { ol_probe_callee(); }\n' },
  Ruby: { path: '__openlore_probe__.rb', content: 'def ol_probe\n  ol_probe_callee\nend\n' },
  Java: { path: '__openlore_probe__.java', content: 'class OlProbe { void probe() { callee(); } }\n' },
  'C++': { path: '__openlore_probe__.cpp', content: 'void olProbe() { olProbeCallee(); }\n' },
  Swift: { path: '__openlore_probe__.swift', content: 'func olProbe() { olProbeCallee() }\n' },
};

function post(message: ExtractionResponse): void {
  parentPort?.postMessage(message);
}

/**
 * Route this thread's logger through the parent. `logger.warning` is the channel the
 * grammar loaders use to disclose an unavailable language, and it must survive — deduped
 * — rather than be swallowed or printed once per worker.
 */
function relayLogging(): void {
  const relay = (level: 'warning' | 'debug') => (message: string): void => post({ type: 'log', level, message });
  // Instance-level override, scoped to this worker thread only.
  const sink = logger as unknown as Record<string, (message: string) => void>;
  sink.warning = relay('warning');
  sink.debug = relay('debug');
}

/**
 * Prove this thread can actually parse before it accepts work. Returns the reason it
 * cannot, or `undefined` when healthy (including when there is nothing to probe).
 */
async function probeFailureReason(language: string | undefined): Promise<string | undefined> {
  if (!language) return undefined; // nothing named — the pool's per-language guard covers it
  const probe = PROBES[language];
  if (!probe) return undefined; // no probe for this language — same guard covers it
  try {
    const result = await dispatchFileExtract({ ...probe, language });
    if (!result) return `${language} has no extractor in this worker`;
    if (result.nodes.length === 0) return `${language} probe produced no function node (grammar unavailable in worker)`;
    if (result.rawEdges.length === 0) return `${language} probe produced no call edge (query support unavailable in worker)`;
    return undefined;
  } catch (err) {
    return `${language} probe threw: ${(err as Error).message}`;
  }
}

/**
 * Convert the faults a plain `try`/`catch` around `dispatchFileExtract` cannot see into a
 * structured per-file failure (change: fix-analyze-native-abort-and-file-cost-budget).
 *
 * The `catch` in the request handler covers a throw the extractor *returns through*. It does not
 * cover a throw raised from a callback the native binding invoked, a rejection that escaped an
 * un-awaited promise, or an error raised between turns — those reach the thread's top level, and
 * a worker with no `uncaughtException` listener dies there. The parent notices (it listens for
 * `error` and `exit`) but only as "the worker holding file N vanished", which costs the pool a
 * worker and re-runs the file on the main thread — where, if the fault is deterministic, the same
 * thing happens with no thread boundary left to absorb it.
 *
 * So the fault is answered for the file it happened on, with the marker that makes the parent
 * record `worker-fault` rather than blaming the source. Then the thread retires: an
 * `uncaughtException` means unknown state, and a worker that keeps serving from unknown state
 * could return facts that are wrong rather than absent — which is the worse failure by this
 * codebase's rules. Retiring is cheap; the parent already handles a worker leaving mid-run.
 */
function installFaultBoundaries(
  peek: () => { id: number; path: string } | undefined,
  clear: () => void,
): void {
  let retiring = false;
  const onFault = (kind: string, err: unknown): void => {
    if (retiring) return;
    retiring = true;
    const current = peek();
    clear();
    const detail = err instanceof Error ? err.message : String(err);
    if (current) {
      post({
        type: 'failed',
        id: current.id,
        message: `${WORKER_FAULT_MESSAGE_PREFIX}: ${kind} while extracting ${current.path} — ${detail}`,
      });
    }
    // Close the channel rather than `process.exit`: closing lets the queued `failed` message
    // above actually flush, and the parent sees a clean `exit` it already knows how to handle.
    // `process.exit` here would race the post and strip the file's attribution.
    parentPort?.close();
  };
  process.on('uncaughtException', (err) => onFault('uncaught exception', err));
  process.on('unhandledRejection', (reason) => onFault('unhandled rejection', reason));
}

async function main(): Promise<void> {
  // Serve only when this thread is an extraction worker THIS pool spawned. Importing this
  // module for its `PROBES` table (the probe-snippet guard test does) must never attach a
  // message handler — and `parentPort !== null` cannot tell "I am an extraction worker"
  // from "I am running inside someone else's worker thread", e.g. a test runner using a
  // thread pool rather than forked processes.
  const data = workerData as ExtractionWorkerData | null;
  if (!parentPort || data?.openloreExtractionWorker !== true) return;
  relayLogging();

  // Latch this build's overlay-shed decision (change: make-analyze-scale-to-any-repo). A worker
  // isolate serves exactly one build, so a module flag is safe here; the main thread forwarded the
  // decision through `workerData` because the worker cannot see its async-context store.
  setWorkerCfgOverlayShed(data.skipCfgOverlay === true);

  const failure = await probeFailureReason(data.probeLanguage);
  if (failure) {
    post({ type: 'unhealthy', reason: failure });
    return;
  }

  // The file this thread is currently working on. Read by the fault boundaries below so a fault
  // can be attributed to a file rather than reaching the parent as an anonymous thread death.
  let inFlight: { id: number; path: string } | undefined;

  installFaultBoundaries(() => inFlight, () => { inFlight = undefined; });

  // Requests are served strictly one at a time: the parent never has more than one
  // in-flight file per worker, so no queueing or interleaving is needed here.
  parentPort.on('message', (raw: unknown) => {
    const msg = raw as ExtractionRequest;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'shutdown') {
      parentPort?.close();
      return;
    }
    if (msg.type !== 'extract') return;
    void (async () => {
      inFlight = { id: msg.id, path: msg.file.path };
      try {
        const value = await dispatchFileExtract(msg.file);
        post({ type: 'result', id: msg.id, value });
      } catch (err) {
        // Mirrors the serial lane: a throwing extractor is a parse failure for THIS file,
        // recorded as such by the parent — not a reason to fall back or retry.
        post({ type: 'failed', id: msg.id, message: (err as Error).message });
      } finally {
        inFlight = undefined;
      }
    })();
  });

  post({ type: 'ready' });
}

await main();
