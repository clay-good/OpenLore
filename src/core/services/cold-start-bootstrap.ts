/**
 * Cold-start self-bootstrap (change: add-zero-interaction-onboarding).
 *
 * If an agent wires the OpenLore MCP server but never ran `openlore install`
 * (or ran it with --no-analyze), the very first session has no structural index
 * and every tool returns "run analyze first." This warms that cold start
 * automatically: when the server begins watching a directory with no analysis,
 * it builds the index ONCE, in the BACKGROUND.
 *
 * Why background and not blocking: a synchronous full analyze on the first tool
 * call could take many seconds and would hang the agent's turn (and risk an MCP
 * client timeout). So the build runs detached from the call path; the first
 * call or two may still see the graceful "no analysis yet" guidance, and within
 * seconds the index is warm. This is strictly better than today, where the
 * server never self-builds.
 *
 * Deterministic, no LLM, no new dependency. Guarded once-per-directory and
 * fail-soft: a build failure never propagates.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';

/** Directories already bootstrapped (or in flight) this process — build at most once each. */
const bootstrapped = new Set<string>();

/** True once an `openlore analyze` artifact exists for the directory. */
export function hasAnalysis(directory: string): boolean {
  return existsSync(join(directory, OPENLORE_ANALYSIS_REL_PATH, 'llm-context.json'));
}

export interface BootstrapOptions {
  /**
   * The index builder to run for a cold directory. REQUIRED and injected by the
   * caller — this module deliberately stays dependency-light and never imports
   * the analyzer or install layer itself, so it cannot pick a builder for you.
   *
   * Production passes install's `buildIndex` (init + structural analyze + the
   * BM25 search corpus, no API key) so `orient` warms to FULL parity. A builder
   * that skips the BM25/search index would leave keyword retrieval cold while
   * the graph looks warm — a silent half-build. Making this required turns that
   * footgun into a compile-time decision the caller must make explicitly, rather
   * than a wrong-by-default fallback hidden in this module.
   */
  analyze: (directory: string) => Promise<void>;
  /** Opt out entirely (env OPENLORE_NO_AUTO_ANALYZE, or a caller flag). */
  disabled?: boolean;
  /** Status sink (defaults to process.stderr). Never stdout — that is protocol. */
  log?: (msg: string) => void;
  /** Injected guard set (tests). */
  seen?: Set<string>;
}

/**
 * Kick a one-time background index build for `directory` if none exists yet,
 * using the caller-supplied `opts.analyze` builder.
 * Returns the in-flight build promise (so tests can await it), or null when
 * nothing was started (already analyzed, already bootstrapped, or disabled).
 * NEVER throws and NEVER blocks the caller.
 */
export function bootstrapAnalysisInBackground(
  directory: string,
  opts: BootstrapOptions,
): Promise<void> | null {
  const seen = opts.seen ?? bootstrapped;
  if (opts.disabled || process.env.OPENLORE_NO_AUTO_ANALYZE) return null;
  if (!directory) return null;
  if (seen.has(directory)) return null;
  if (hasAnalysis(directory)) {
    seen.add(directory);
    return null;
  }

  seen.add(directory);
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));

  const run = async (): Promise<void> => {
    try {
      log('[openlore] No index found — building it in the background (first run, no API key)…');
      await opts.analyze(directory);
      log('[openlore] Index built — orient() and the other tools are now warm.');
    } catch (err) {
      // Fail-soft: leave the graceful "run analyze" guidance in place; allow a
      // later retry by clearing the guard.
      seen.delete(directory);
      log(`[openlore] Background index build skipped: ${(err as Error).message}`);
    }
  };

  return run();
}
