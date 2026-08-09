/**
 * Background index repair service (changes: add-zero-interaction-onboarding →
 * make-index-self-healing).
 *
 * Originally the cold-start self-bootstrap: if an agent wired the OpenLore MCP
 * server but never ran `openlore install`, the very first session had no index
 * and every tool returned "run analyze first." That warmed an ABSENT index once,
 * in the background.
 *
 * `make-index-self-healing` generalizes it: every read-path staleness signal that
 * today only produces a warning (integrity `mismatched`, an over-threshold stale
 * region, a schema reset, an aged analysis) now triggers the SAME at-most-once,
 * non-blocking background rebuild — so detection finally closes the loop into
 * repair instead of stopping at disclosure.
 *
 * Guarantees (unchanged from the bootstrap it grew out of):
 *   - AT MOST ONCE per process per repo. A completed repair that still observes
 *     its trigger discloses and stops — it never loops or thrashes. The guard is
 *     cleared only on FAILURE, so a transient build error can retry.
 *   - NEVER blocks the caller: the build runs detached from the call path; reads
 *     during it are served from the stale index with an honest "refresh started"
 *     disclosure, never held.
 *   - NEVER throws: a build failure leaves the graceful guidance in place.
 *   - Opt-out via `OPENLORE_NO_AUTO_ANALYZE` or `.openlore/config.json` `autoInit:false`.
 *
 * Deterministic, no LLM, no new dependency.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  OPENLORE_ANALYSIS_REL_PATH,
} from '../../constants.js';
import { resolveOpenLoreConfigPath } from './config-manager.js';

/**
 * Why a background repair was started. `index-absent` is the original cold-start
 * case (no artifact at all); the rest are the self-healing triggers layered on by
 * make-index-self-healing.
 */
export type RepairReason =
  | 'index-absent'
  | 'integrity-mismatched'
  | 'stale-region'
  | 'schema-reset'
  | 'analysis-age';

/** Human-facing label for each reason, used in the "refresh started" disclosure. */
export const REPAIR_REASON_DETAIL: Record<RepairReason, string> = {
  'index-absent': 'no index found',
  'integrity-mismatched': 'the index did not reconcile against its build attestation',
  'stale-region': 'part of the index is explicitly stale',
  'schema-reset': 'the index schema was reset by a version upgrade',
  'analysis-age': 'the analysis is older than the freshness threshold',
};

/** Directories already repaired (or in flight) this process — build at most once each. */
const attempted = new Set<string>();

/** In-flight repairs, keyed by directory, so a read can disclose "refresh started". */
const inFlight = new Map<string, { reason: RepairReason; startedAt: number }>();

/**
 * The default index builder, registered once by the MCP server at startup. Lets a
 * read-path caller (mcp-handlers/utils.ts) — which deliberately never imports the
 * analyzer or install layer — trigger a repair without threading a builder through
 * every handler. When nothing is registered (CLI, tests, a non-server host), a
 * read-path repair is a silent no-op: detection and disclosure are unchanged, only
 * the automatic rebuild is skipped.
 */
let registeredBuilder: ((directory: string) => Promise<void>) | null = null;

/**
 * A long-lived host's non-blocking handoff for files found stale by a cited-file
 * read check. Returning true means the host accepted the repair request (it may
 * coalesce it with work already queued); false means disclosure must remain
 * repair-agnostic. The callback must not await the repair itself.
 */
export type RepairHost = (staleFiles: readonly string[]) => boolean;

interface RepairHostRegistration {
  callback: RepairHost;
  token: symbol;
}

/** Repair hosts keyed by canonical repository root; never process-wide by accident. */
const repairHosts = new Map<string, RepairHostRegistration>();

/** Resolve path aliases to the same stable repository identity. */
function canonicalRoot(directory: string): string {
  let root: string;
  try {
    root = realpathSync.native(resolve(directory));
  } catch {
    root = resolve(directory);
  }
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

/**
 * Register the repair path owned by one watcher/serve host. Registrations are
 * exact-root scoped: hosting repo A never authorizes repair work in repo B.
 *
 * The disposer is identity-safe. If a replacement host registers for the same
 * root before the old host tears down, the old disposer cannot remove the new
 * registration.
 */
export function registerRepairHost(directory: string, callback: RepairHost): () => void {
  const root = canonicalRoot(directory);
  const registration = { callback, token: Symbol(root) };
  repairHosts.set(root, registration);
  return () => {
    if (repairHosts.get(root)?.token === registration.token) repairHosts.delete(root);
  };
}

/**
 * Offer cited stale files to the host for this exact repository. Returns true
 * only when a registered host accepted the request. Missing or throwing hosts
 * fail soft so a read can still serve its factual staleness disclosure.
 */
export function requestRepairFromHost(directory: string, staleFiles: readonly string[]): boolean {
  if (!directory || staleFiles.length === 0) return false;
  const host = repairHosts.get(canonicalRoot(directory));
  if (!host) return false;
  try {
    return host.callback([...staleFiles]) === true;
  } catch {
    return false;
  }
}

/** Register the process-wide repair builder (the MCP server injects install's forced buildIndex). */
export function registerRepairBuilder(fn: (directory: string) => Promise<void>): void {
  registeredBuilder = fn;
}

/** True once an `openlore analyze` artifact exists for the directory. */
export function hasAnalysis(directory: string): boolean {
  return existsSync(join(directory, OPENLORE_ANALYSIS_REL_PATH, 'llm-context.json'));
}

/** True when `.openlore/config.json` explicitly sets `autoInit: false`. Fail-open. */
function autoInitDisabled(directory: string): boolean {
  try {
    const raw = readFileSync(resolveOpenLoreConfigPath(directory), 'utf-8');
    return (JSON.parse(raw) as { autoInit?: unknown }).autoInit === false;
  } catch {
    return false; // no config / unreadable → auto-init not disabled
  }
}

export interface RepairOptions {
  /**
   * The index builder to run. Optional: when omitted, the process-wide builder
   * registered via {@link registerRepairBuilder} is used. Production registers
   * install's forced buildIndex (init + structural analyze + BM25 search corpus,
   * no API key) so `orient` heals to FULL parity, not just the structural graph.
   */
  analyze?: (directory: string) => Promise<void>;
  /** Opt out entirely (env OPENLORE_NO_AUTO_ANALYZE, or a caller flag). */
  disabled?: boolean;
  /** Status sink (defaults to process.stderr). Never stdout — that is protocol. */
  log?: (msg: string) => void;
  /** Injected at-most-once guard set (tests). */
  seen?: Set<string>;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Kick a one-time background repair for `directory` using the caller-supplied or
 * process-registered builder. Returns the in-flight build promise (so tests can
 * await it), or null when nothing was started (already repaired this process,
 * disabled, no builder available, or empty directory). NEVER throws, NEVER blocks.
 */
export function repairInBackground(
  directory: string,
  reason: RepairReason,
  opts: RepairOptions = {},
): Promise<void> | null {
  const seen = opts.seen ?? attempted;
  if (opts.disabled || process.env.OPENLORE_NO_AUTO_ANALYZE) return null;
  if (!directory) return null;
  if (seen.has(directory)) return null; // at-most-once per process per repo
  if (autoInitDisabled(directory)) return null;

  const build = opts.analyze ?? registeredBuilder;
  if (!build) return null; // no builder registered (CLI/tests) — detection unchanged, repair skipped

  seen.add(directory);
  const now = opts.now ?? Date.now;
  inFlight.set(directory, { reason, startedAt: now() });
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));

  const run = async (): Promise<void> => {
    try {
      log(`[openlore] Index repair (${reason}) — rebuilding in the background (non-blocking, no API key)…`);
      await build(directory);
      // Verify, do not assume. The builder reports some failures (an unwritable
      // directory, EACCES on `.openlore`) by LOGGING and returning normally rather
      // than throwing, so the catch below never fires and this line would claim
      // "Index rebuilt" over the top of the builder's own error — the exact
      // false-success this substrate is supposed to never produce. Ask the
      // filesystem whether an artifact actually exists now.
      if (hasAnalysis(directory)) {
        log('[openlore] Index rebuilt — the next tool call serves fresh results.');
      } else {
        // Deliberately does NOT clear the at-most-once latch. A build that completed
        // without producing an artifact (an unwritable `.openlore`, an empty repo)
        // will fail the same way every time, and retrying it on each tool call is the
        // thrashing the latch exists to prevent. Report honestly and stop.
        log('[openlore] Background index repair completed without producing an index — results stay stale. See the error above.');
      }
      // Guard stays set: a completed repair that still observes its trigger
      // discloses and stops (at-most-once latch), never thrashes.
    } catch (err) {
      // Fail-soft: leave the graceful guidance in place; allow a later retry.
      seen.delete(directory);
      log(`[openlore] Background index repair skipped: ${(err as Error).message}`);
    } finally {
      inFlight.delete(directory);
    }
  };

  return run();
}

/**
 * The in-progress repair for `directory`, or undefined when none is running. The
 * read path threads this into the response so a stale answer is served with an
 * honest "background refresh started" marker — never presented as fresh.
 */
export function repairStatusFor(
  directory: string,
): { inProgress: true; reason: RepairReason } | undefined {
  const rec = inFlight.get(directory);
  return rec ? { inProgress: true, reason: rec.reason } : undefined;
}

/**
 * Cold-start self-bootstrap for an ABSENT index — the original entry point, kept
 * as a thin wrapper over {@link repairInBackground} so existing callers/tests are
 * unchanged. Only fires when no analysis artifact exists yet.
 */
export function bootstrapAnalysisInBackground(
  directory: string,
  opts: RepairOptions & { analyze: (directory: string) => Promise<void> },
): Promise<void> | null {
  const seen = opts.seen ?? attempted;
  if (opts.disabled || process.env.OPENLORE_NO_AUTO_ANALYZE) return null;
  if (!directory) return null;
  if (seen.has(directory)) return null;
  if (hasAnalysis(directory)) {
    seen.add(directory);
    return null;
  }
  return repairInBackground(directory, 'index-absent', opts);
}

/** Test-only: clear the process-wide repair guards and registered builder. */
export function _resetRepairServiceForTesting(): void {
  attempted.clear();
  inFlight.clear();
  repairHosts.clear();
  registeredBuilder = null;
}
