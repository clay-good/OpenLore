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
 *    grammar cannot be loaded, so a worker whose native bindings failed would silently
 *    contribute nothing to the graph. Before accepting any work this thread parses a
 *    known-good snippet and requires the expected node and edge; a worker that cannot do
 *    that reports itself `unhealthy` and is dropped from the pool instead of returning
 *    plausible-looking emptiness.
 *  - **Log relay.** A grammar that is genuinely unavailable warns once per thread. Left
 *    alone that prints N times and interleaves with the parent's spinner, so the logger's
 *    output is redirected to the parent, which dedupes and prints it once.
 */

import { parentPort } from 'node:worker_threads';
import { dispatchFileExtract } from './call-graph.js';
import { logger } from '../../utils/logger.js';
import type { ExtractionRequest, ExtractionResponse } from './extraction-pool.js';

/** The probe source: one function containing one call — the minimum that proves a real parse. */
const PROBE_FILE = {
  path: '__openlore_extraction_probe__.ts',
  content: 'export function __openloreProbe(): void { __openloreProbeCallee(); }\n',
  language: 'TypeScript',
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
 * cannot, or `undefined` when healthy.
 */
async function probeFailureReason(): Promise<string | undefined> {
  try {
    const result = await dispatchFileExtract(PROBE_FILE);
    if (!result) return 'probe language has no extractor in this worker';
    if (result.nodes.length === 0) return 'probe parse produced no function node (grammar unavailable in worker)';
    if (result.rawEdges.length === 0) return 'probe parse produced no call edge (query support unavailable in worker)';
    return undefined;
  } catch (err) {
    return `probe parse threw: ${(err as Error).message}`;
  }
}

async function main(): Promise<void> {
  if (!parentPort) return; // not running as a worker — nothing to serve
  relayLogging();

  const failure = await probeFailureReason();
  if (failure) {
    post({ type: 'unhealthy', reason: failure });
    return;
  }

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
      try {
        const value = await dispatchFileExtract(msg.file);
        post({ type: 'result', id: msg.id, value });
      } catch (err) {
        // Mirrors the serial lane: a throwing extractor is a parse failure for THIS file,
        // recorded as such by the parent — not a reason to fall back or retry.
        post({ type: 'failed', id: msg.id, message: (err as Error).message });
      }
    })();
  });

  post({ type: 'ready' });
}

await main();
