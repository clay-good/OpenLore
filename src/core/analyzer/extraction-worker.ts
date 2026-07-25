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
import { logger } from '../../utils/logger.js';
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

async function main(): Promise<void> {
  if (!parentPort) return; // not running as a worker — nothing to serve
  relayLogging();

  const failure = await probeFailureReason((workerData as ExtractionWorkerData | null)?.probeLanguage);
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
