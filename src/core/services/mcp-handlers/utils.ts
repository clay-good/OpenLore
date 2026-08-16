/**
 * Shared utilities for MCP tool handlers.
 */

import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat, type FileHandle } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import type { LLMContext } from '../../analyzer/artifact-generator.js';
import { EdgeStore } from '../edge-store.js';
import {
  REQUIRED_ANALYSIS_ARTIFACTS,
  artifactMatchesGeneration,
  readCurrentGeneration,
} from '../../runtime/analysis-generation.js';
import { readAttestation, reconcile, type IndexIntegrity } from '../../analyzer/index-attestation.js';
import { recordGraphDigest } from './traversal.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import { ANALYSIS_AGE_WARNING_HOURS, ANALYSIS_STALE_THRESHOLD_MS, ARTIFACT_CALL_GRAPH_DB, ARTIFACT_FINGERPRINT, ARTIFACT_INDEX_ATTESTATION, ARTIFACT_LLM_CONTEXT, MAX_QUERY_LENGTH, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR, STALE_REGION_REPAIR_THRESHOLD } from '../../../constants.js';
import { repairInBackground, type RepairReason } from '../cold-start-bootstrap.js';

/**
 * LLMContext with optional SQLite edge store attached (present when call-graph.db
 * exists) and the index integrity verdict (present when an attestation was written and
 * could be reconciled against the store — change: add-index-integrity-attestation).
 */
export type CachedContext = LLMContext & {
  edgeStore?: EdgeStore;
  integrity?: IndexIntegrity;
  /**
   * Mtime of the exact llm-context generation represented by this object.
   * Non-enumerable at runtime so watcher persistence never writes cache metadata
   * back into the analysis artifact.
   */
  artifactMtimeMs?: number;
};

function bindArtifactMtime(ctx: CachedContext, mtime: number): void {
  Object.defineProperty(ctx, 'artifactMtimeMs', {
    value: mtime,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/**
 * Reconcile the on-disk edge store against its build-time attestation, returning the
 * integrity verdict (`healthy | degraded | mismatched`) or undefined when the index is
 * unverifiable (legacy index with no attestation, or a read fault). Pure-ish: a few
 * COUNT(*) queries + a JSON read. A first-pass `degraded` triggers a WAL checkpoint and
 * one recount to rule out a WAL-lag false positive before the verdict is committed.
 *
 * MUST be called while the store handle is open and BEFORE any wasReset/empty guard
 * may close it, so a schema-bumped (now-empty) store still yields a `mismatched`
 * verdict instead of a silent unverifiable.
 */
async function computeIndexIntegrity(es: EdgeStore, analysisDir: string): Promise<IndexIntegrity | undefined> {
  const attestation = await readAttestation(analysisDir);
  if (!attestation) return undefined; // unverifiable — never fabricate a healthy verdict
  const read = (): IndexIntegrity => reconcile(attestation, {
    schemaVersion: es.getSchemaVersion(),
    files: es.countFiles(),
    functions: es.countNodes(),
    edges: es.countEdges(),
    classes: es.countClasses(),
  });
  let verdict = read();
  if (verdict.verdict === 'degraded') {
    es.checkpoint();
    verdict = read();
  }
  return verdict;
}
import { logger } from '../../../utils/logger.js';
import { emit } from '../telemetry.js';
import { redactSecretString } from '../secret-redaction.js';

const ANALYSIS_AGE_WARNING_MS = ANALYSIS_AGE_WARNING_HOURS * 60 * 60 * 1000;

async function readUtf8Bounded(handle: FileHandle, maxBytes: number): Promise<string | null> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset > maxBytes ? null : buffer.toString('utf8', 0, offset);
}

/**
 * Which read-path staleness signal (if any) should heal — a pure, testable
 * decision. Priority is worst-first: `mismatched` (materially wrong index) →
 * schema reset → an explicit stale region → an aged analysis. `degraded` is
 * deliberately NOT a trigger (it already gets a WAL-checkpoint retry and may be a
 * transient WAL-lag artifact). Returns undefined when the index looks current.
 */
export function computeRepairReason(
  integrityVerdict: string | undefined,
  schemaFault: boolean,
  staleCount: number,
  artifactMtimeMs: number,
  now: number = Date.now(),
): RepairReason | undefined {
  if (integrityVerdict === 'mismatched') return 'integrity-mismatched';
  // A read-path schema mismatch or a quarantined (corrupt) store both need a rebuild.
  if (schemaFault) return 'schema-reset';
  if (staleCount >= STALE_REGION_REPAIR_THRESHOLD) return 'stale-region';
  if (now - artifactMtimeMs > ANALYSIS_AGE_WARNING_MS) return 'analysis-age';
  return undefined;
}

/**
 * Fire the shared at-most-once background repair for the strongest read-path
 * staleness signal, if any. Fires only when a repair builder is registered (the
 * MCP server); a no-op otherwise, so CLI/tests keep today's detection-only
 * behavior. Never throws, never blocks the read.
 */
function maybeTriggerBackgroundRepair(
  directory: string,
  integrityVerdict: string | undefined,
  schemaFault: boolean,
  staleCount: number,
  artifactMtimeMs: number,
): void {
  const reason = computeRepairReason(integrityVerdict, schemaFault, staleCount, artifactMtimeMs);
  if (!reason) return;
  try {
    repairInBackground(directory, reason);
  } catch {
    // repairInBackground is fail-soft by contract; this guard is belt-and-braces
    // so the read path can never be perturbed by the repair trigger.
  }
}

/**
 * Resolve and validate a user-supplied directory path.
 *
 * Ensures the path resolves to an existing directory, which prevents path
 * traversal attacks where a client supplies `"../../../../etc"` or a plain
 * file path instead of a project directory.
 */
export async function validateDirectory(directory: string, maxDepth?: number): Promise<string> {
  logger.debug(`Validating directory: ${directory}`);
  return validateDirectoryImpl(directory, maxDepth);
}

export async function validateDirectoryImpl(directory: string, maxDepth?: number): Promise<string> {
  if (!directory || typeof directory !== 'string') {
    logger.warning('Directory validation failed: directory parameter is required and must be a string');
    throw new Error('directory parameter is required and must be a string');
  }
  const absDir = resolve(directory);
  logger.debug(`Resolved directory path: ${absDir}`);

  // Validate directory traversal depth if maxDepth is specified
  if (maxDepth !== undefined) {
    validateDirectoryDepth(absDir, maxDepth);
  }

  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(absDir);
  } catch {
    logger.error(`Directory validation failed: Directory not found: ${absDir}`);
    throw new Error(`Directory not found: ${absDir}`);
  }
  if (!s.isDirectory()) {
    logger.error(`Directory validation failed: Not a directory: ${absDir}`);
    throw new Error(`Not a directory: ${absDir}`);
  }
  logger.success(`Successfully validated directory: ${absDir}`);
  return absDir;
}

function calculateDirectoryDepth(path: string): number {
  const normalizedPath = path.replace(/^\\|\\$/g, '');
  const segments = normalizedPath.split(/[\\/]/);
  return segments.length;
}

export function validateDirectoryDepth(absDir: string, maxDepth: number): void {
  const depth = calculateDirectoryDepth(absDir);
  if (depth > maxDepth) {
    logger.error(`Directory validation failed: Directory depth ${depth} exceeds maximum allowed depth of ${maxDepth}`);
    throw new Error(`Directory depth ${depth} exceeds maximum allowed depth of ${maxDepth}`);
  }
}

/**
 * Strip common API key and token patterns from an error message before
 * returning it to MCP clients, to prevent secret leakage via error responses.
 * 
 * @param err - The error to sanitize
 * @param format - Output format: "string" (default) or "json"
 * @returns Sanitized error as string or {message, code} object when format is "json"
 */
export function sanitizeMcpError(err: unknown, format: 'string' | 'json' = 'string'): string | { message: string; code: number } {
  const rawMessage = err instanceof Error ? err.message : String(err);
  // Shared credential-redaction patterns (see secret-redaction.ts) so error text
  // and every other output channel scrub the same set.
  const sanitized = redactSecretString(rawMessage);

  if (format === 'json') {
    const errCode = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
    const code = typeof errCode === 'number' ? errCode : 500;
    return { message: sanitized, code };
  }
  
  return sanitized;
}

// Path confinement lives in `src/utils/path-confinement.ts` — a leaf module, so the
// CLI, the decision syncer and the analyzer can share this one guard rather than
// re-deriving it (they previously had no guard at all). Re-exported here because
// these names are part of the handlers' established surface.
export { safeJoin, safeOpenspecDir, isConfinedPath } from '../../../utils/path-confinement.js';

/**
 * Bound a free-text query/description argument before it drives an embedding call
 * or BM25 tokenization (mcp-security: Bounded Computation — a hostile caller could
 * otherwise send a multi-megabyte string and force unbounded work or a huge
 * provider request). Returns an `{ error }` object to return verbatim when the
 * input exceeds MAX_QUERY_LENGTH, or null when it is within bounds.
 */
export function queryTooLongError(query: unknown, field = 'query'): { error: string } | null {
  if (typeof query === 'string' && query.length > MAX_QUERY_LENGTH) {
    return { error: `${field} too long: ${query.length} characters (max ${MAX_QUERY_LENGTH}). Shorten the ${field}.` };
  }
  return null;
}

/**
 * Why a graph-dependent tool cannot answer yet (change: refine-happy-path-and-defaults
 * / ReadyOrHonestFirstUse):
 *  - `index-absent`     — no analysis artifact exists at all (never built).
 *  - `graph-unavailable`— an analysis exists but its call-graph/edge index is missing,
 *                         typically because a version upgrade reset the graph index
 *                         until the next `analyze`.
 */
export type NotReadyReason = 'index-absent' | 'graph-unavailable';

/** A structured "not ready" conclusion — see {@link notReadyResult}. */
export interface NotReadyResult {
  error: string;
  /** Machine-readable flag so an agent can branch without parsing the message. */
  notReady: true;
  reason: NotReadyReason;
  /** The single command that makes the tool ready. */
  remedy: string;
}

/**
 * Build a structured, ready-or-honest "not ready" result. A graph-dependent tool
 * invoked before a usable index exists SHALL return one of these — never a
 * silently-degraded empty result. The human-readable `error` is preserved verbatim
 * (so existing callers/tests that read `.error` keep working); the `notReady` flag,
 * `reason` discriminator, and exact `remedy` command are added so an agent can act
 * on the cause deterministically and consistently across every tool.
 */
export function notReadyResult(error: string, reason: NotReadyReason): NotReadyResult {
  return { error, notReady: true, reason, remedy: 'openlore analyze' };
}

interface ContextCacheEntry {
  ctx: CachedContext;
  mtime: number;
  /** Committed analysis generation this entry was read under, when one exists. */
  generation: string | null;
}

/**
 * One entry per project directory. Invalidated when EITHER the artifact mtime or
 * the committed analysis generation changes, so an external analyze cannot leave
 * a daemon serving the previous generation's paths.
 */
const _contextCache = new Map<string, ContextCacheEntry>();

/** Grace period before closing an evicted EdgeStore so concurrent in-flight
 * requests holding the old handle across an await can drain first. */
const STALE_STORE_CLOSE_DELAY_MS = 30_000;

/** Hard ceiling on the analysis artifact (.openlore/analysis/llm-context.json)
 * before we deserialize it. Real contexts are single-digit MB; this generous cap
 * exists only to fail closed on a poisoned/oversized artifact rather than OOM. */
const ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;

/** Test-only: clear in-memory context cache to force cold path. */
export function _resetContextCacheForTesting(): void {
  for (const entry of _contextCache.values()) entry.ctx.edgeStore?.close();
  _contextCache.clear();
}

/** Release the parsed context and EdgeStore owned by one long-lived host. */
export function releaseContextCache(directory: string): void {
  const entry = _contextCache.get(directory);
  if (!entry) return;
  _contextCache.delete(directory);
  try { entry.ctx.edgeStore?.close(); } catch { /* already closed by an in-process consumer */ }
}

/** Test seam for lifecycle assertions; production code uses {@link releaseContextCache}. */
export function _contextCacheSizeForTesting(): number {
  return _contextCache.size;
}

/**
 * Watch-mode handoff (Spec 13.1). Push an updated context into the in-memory
 * read cache so the next tool call is a cache HIT — no 2.1 MB disk re-parse —
 * even though the watcher only patched a few signatures. Keyed identically to
 * {@link readCachedContext} (resolved project directory).
 *
 * The cached `mtime` is set to the current on-disk `llm-context.json` mtime so
 * the entry stays valid until the file genuinely changes on disk again:
 *   • watcher patches in memory but defers the disk write → disk mtime is
 *     unchanged → this entry matches → hit returns the patched context;
 *   • watcher writes the file then primes → disk mtime is the just-written one
 *     → this entry matches → hit, no cold re-parse of what we just wrote;
 *   • some other process (e.g. `openlore analyze`) rewrites the file → its mtime
 *     differs from this entry → next read MISSes and re-reads disk → correct.
 */
export async function primeContextCache(directory: string, ctx: CachedContext): Promise<void> {
  const analysisDir = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  const filePath = join(analysisDir, ARTIFACT_LLM_CONTEXT);
  let mtime: number;
  try {
    mtime = (await stat(filePath)).mtimeMs;
  } catch {
    return; // no artifact on disk yet — nothing to stay fresh against
  }
  const existing = _contextCache.get(directory);
  // Preserve an already-open EdgeStore handle if the new ctx doesn't carry one.
  if (existing?.ctx.edgeStore && !ctx.edgeStore) {
    ctx.edgeStore = existing.ctx.edgeStore;
  }
  bindArtifactMtime(ctx, mtime);
  const generation = (await readCurrentGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]))?.generationId ?? null;
  _contextCache.set(directory, { ctx, mtime, generation });
}

export async function readCachedContext(directory: string, timeout?: number): Promise<CachedContext | null> {
  const analysisDir = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  const filePath = join(analysisDir, ARTIFACT_LLM_CONTEXT);

  async function load(): Promise<CachedContext | null> {
    try {
      // Keep one descriptor from metadata check through read. A path-based stat
      // followed by a path-based read lets an untrusted repository swap the file
      // between those operations and bypass the size check.
      const handle = await open(filePath, 'r');
      try {
      const st = await handle.stat();
      const mtime = st.mtimeMs;
      // Key on the committed generation as well as the artifact mtime. An mtime
      // alone cannot distinguish "same file" from "republished with identical
      // timestamp granularity", which is how a daemon could keep serving paths
      // that only existed in the previous generation (change
      // `harden-spec-workflow-lifecycle`, decision 64e6eb87).
      const generationManifest = await readCurrentGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
      if (!generationManifest) {
        emit(directory, 'cache', { event: 'cache_read', hit: false, reason: 'analysis_generation_unavailable' });
        return null;
      }
      const generation = generationManifest?.generationId ?? null;
      // A writer updates artifacts in place and publishes the manifest last. During
      // that interval the old generation id is still visible, so id+mtime alone can
      // bless uncommitted bytes. Bind this read to the manifest's content digest.
      if (generationManifest
        && !await artifactMatchesGeneration(analysisDir, generationManifest, ARTIFACT_LLM_CONTEXT)) {
        emit(directory, 'cache', { event: 'cache_read', hit: false, reason: 'analysis_generation_changed' });
        return null;
      }
      const cached = _contextCache.get(directory);
      if (cached && cached.mtime === mtime && cached.generation === generation) {
        emit(directory, 'cache', { event: 'cache_read', hit: true });
        return cached.ctx;
      }
      // mcp-security (Untrusted Artifact Deserialization): the analysis artifact
      // lives under .openlore/ and is treated as untrusted input. Bound its size
      // before reading so a poisoned/oversized file can't OOM the server; legit
      // contexts are single-digit MB, far below this ceiling.
      if (st.size > ARTIFACT_MAX_BYTES) {
        emit(directory, 'cache', { event: 'cache_read', hit: false, reason: 'artifact_too_large', size: st.size });
        return null;
      }
      // Cache miss — read 3.7MB JSON and open EdgeStore connection
      const raw = await readUtf8Bounded(handle, ARTIFACT_MAX_BYTES);
      if (raw === null) {
        emit(directory, 'cache', { event: 'cache_read', hit: false, reason: 'artifact_too_large' });
        return null;
      }
      const afterGeneration = await readCurrentGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
      const expectedContext = afterGeneration?.artifacts.find(record => record.path === ARTIFACT_LLM_CONTEXT);
      const rawMatches = afterGeneration?.compatibility === 'legacy'
        || (expectedContext !== undefined
          && Buffer.byteLength(raw) === expectedContext.bytes
          && createHash('sha256').update(raw).digest('hex') === expectedContext.sha256);
      if (afterGeneration?.generationId !== generation
        || !rawMatches
        || (afterGeneration
          && !await artifactMatchesGeneration(analysisDir, afterGeneration, ARTIFACT_LLM_CONTEXT))) {
        emit(directory, 'cache', { event: 'cache_read', hit: false, reason: 'analysis_generation_changed' });
        return null;
      }
      const parsed: unknown = JSON.parse(raw);
      // Validate top-level shape before use: a valid context is a non-null,
      // non-array object. Fail closed on null/scalar/array so a malformed or
      // schema-mismatched artifact yields a clean "re-run analyze" result
      // downstream instead of propagating attacker-shaped values.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        emit(directory, 'cache', { event: 'cache_read', hit: false, reason: 'artifact_shape_invalid' });
        return null;
      }
      const ctx = parsed as CachedContext;
      // Bind freshness fallbacks to THIS parsed generation. A later analyze may
      // replace the artifact while a handler is still composing its response;
      // re-statting at response time could otherwise bless stale cached data with
      // the newer generation's timestamp.
      bindArtifactMtime(ctx, mtime);
      // Normalize a present callGraph so `nodes`/`edges` are always arrays. A truncated
      // or hand-edited artifact (`{"callGraph": {}}`) — or a minimal one carrying only
      // entryPoints/hubFunctions — would otherwise throw when a handler does
      // `cg.nodes.map(...)`. Coerce the missing/invalid arrays to [] (graceful empty)
      // rather than dropping the whole graph: other handlers (architecture overview)
      // legitimately read entryPoints/hubFunctions without touching nodes/edges. A
      // callGraph that isn't even an object is unusable, so drop that.
      if (ctx.callGraph !== undefined) {
        if (typeof ctx.callGraph === 'object' && ctx.callGraph !== null) {
          const cg = ctx.callGraph as { nodes?: unknown; edges?: unknown };
          if (!Array.isArray(cg.nodes)) cg.nodes = [];
          if (!Array.isArray(cg.edges)) cg.edges = [];
          // Bind this generation's graph to the persisted traversal structure by the
          // graph digest `analyze` wrote INTO the context, so the structure is accepted
          // only when it describes THIS graph (change:
          // shrink-traversal-index-invalidation-scope). Recorded on the parsed object,
          // never on the context we might re-serialize.
          //
          // No hashing on this path. The previous key was the SHA-256 of the whole
          // artifact, charged to EVERY cache miss and every tool — `orient`,
          // `search_code`, `get_spec` — not only the traversal ones (measured at 29 ms
          // over this repo's 11.7 MB context). The key now rides in the JSON already
          // parsed, so establishing currency is a field read: O(1), no crypto. A legacy
          // context that predates this field records no key, so no persisted structure
          // is consulted and the traversal is built in memory — today's behavior.
          if (typeof ctx.graphDigest === 'string') {
            recordGraphDigest(ctx.callGraph as SerializedCallGraph, ctx.graphDigest);
          }
        } else {
          ctx.callGraph = undefined;
        }
      }
      // Read-path staleness signals captured while the store is open, so the
      // background repair trigger below can fire even when the empty/not-ready guard
      // closes the store (change: make-index-self-healing).
      let schemaFault = false;
      let staleCount = 0;
      if (EdgeStore.exists(analysisDir)) {
        const es = EdgeStore.open(EdgeStore.dbPath(analysisDir));
        if (es.notReady) {
          // ReadPathsNeverDestroyTheIndex / CorruptGraphStoreQuarantineParity: a
          // schema-mismatched or quarantined store is left intact on disk (or moved to
          // *.corrupt-<n>) and reported — never served as an empty graph. Trigger the
          // shared background repair and disclose via the freshness-note channel below
          // (change: harden-index-store-lifecycle).
          schemaFault = true;
          es.close();
        } else {
          // Index integrity attestation (change: add-index-integrity-attestation).
          // Reconcile the just-opened store against its build-time attestation BEFORE the
          // empty guard may close it. Best-effort + additive: any fault here leaves the
          // verdict unset (unverifiable), never blocks the load.
          try {
            const verdict = await computeIndexIntegrity(es, analysisDir);
            if (verdict) {
              ctx.integrity = verdict;
              if (verdict.verdict !== 'healthy') {
                // Recoverable signal: a non-healthy index is reported, never silently
                // served as complete. Tools disclose it via the confidence boundary.
                emit(directory, 'cache', { event: 'index_integrity', verdict: verdict.verdict });
              }
            }
          } catch {
            // Attestation reconciliation is additive; never block the load.
          }
          try { staleCount = es.countStaleFiles(); } catch { /* pre-migration store — no stale_files table */ }
          // Empty-store guard: if the store is empty but the JSON analysis still has
          // production nodes, the two are out of sync — do NOT serve the empty store.
          // Edge-store tools then return "Re-run analyze_codebase" instead of silent
          // empty results; the next analyze repopulates and re-attaches.
          const jsonProdNodes = Array.isArray(ctx.callGraph?.nodes)
            ? ctx.callGraph.nodes.filter(n => !n.isExternal && !n.isTest).length
            : 0;
          if (es.countNodes() === 0 && jsonProdNodes > 0) {
            es.close();
          } else {
            ctx.edgeStore = es;
          }
        }
      }
      // Opening and attesting the database happens after the JSON generation check above.
      // Re-check the commit point now so promotion cannot pair old context with a newly
      // replaced call-graph.db in one cached object.
      const finalGeneration = await readCurrentGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
      const boundGraphArtifactsMatch = !finalGeneration
        || !finalGeneration.artifacts.some(record => record.path === ARTIFACT_CALL_GRAPH_DB)
        || (await artifactMatchesGeneration(analysisDir, finalGeneration, ARTIFACT_CALL_GRAPH_DB)
          && await artifactMatchesGeneration(analysisDir, finalGeneration, ARTIFACT_INDEX_ATTESTATION));
      if (finalGeneration?.generationId !== generation || !boundGraphArtifactsMatch) {
        try { ctx.edgeStore?.close(); } catch { /* best-effort close on rejected snapshot */ }
        emit(directory, 'cache', { event: 'cache_read', hit: false, reason: 'analysis_generation_changed' });
        return null;
      }
      // Self-healing: any read-path staleness signal that today only produces a
      // verdict also triggers the shared at-most-once background repair — detection
      // finally closes the loop into repair (change: make-index-self-healing). The
      // rebuild never blocks this read; the answer is served now and disclosed as
      // stale-with-refresh-started (see repairStatusFor callers).
      maybeTriggerBackgroundRepair(directory, ctx.integrity?.verdict, schemaFault, staleCount, mtime);
      // Evict + close the previous entry's EdgeStore — otherwise each cache miss
      // (every `analyze` rewrites llm-context.json's mtime) leaks an open SQLite
      // connection + its WAL fd for the life of a long-lived daemon. The close is
      // DEFERRED: serve dispatches requests concurrently, and a handler may hold
      // the old handle across an await (e.g. get_subgraph awaits a vector search
      // between edgeStore reads). A grace delay lets in-flight requests drain
      // before release, bounding live handles to ~grace/reanalyze-interval.
      const prev = _contextCache.get(directory);
      _contextCache.set(directory, { ctx, mtime, generation });
      if (prev?.ctx.edgeStore && prev.ctx.edgeStore !== ctx.edgeStore) {
        const stale = prev.ctx.edgeStore;
        const t = setTimeout(() => { try { stale.close(); } catch { /* already closed */ } }, STALE_STORE_CLOSE_DELAY_MS);
        t.unref?.();
      }
      emit(directory, 'cache', { event: 'cache_read', hit: true });
      return ctx;
      } finally {
        await handle.close();
      }
    } catch {
      emit(directory, 'cache', { event: 'cache_read', hit: false });
      return null;
    }
  }

  if (timeout !== undefined && timeout > 0) {
    return Promise.race([
      load(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error(`readCachedContext timed out after ${timeout}ms`)), timeout)
      ),
    ]);
  }

  return load();
}

/**
 * Wait for graph rebuild to complete after schema mismatch.
 *
 * When a schema version change is detected, EdgeStore resets itself and
 * McpWatcher spawns a background `openlore analyze --reanalyze`. This helper
 * polls until the rebuild completes (edgeStore is populated) or timeout.
 *
 * Used by graph tools (analyze_impact, trace_execution_path) to auto-heal
 * after version upgrades instead of failing immediately.
 *
 * @returns true if rebuild completed (edgeStore now available), false on timeout
 */
export async function waitForGraphRebuild(
  directory: string,
  timeoutMs = 60_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 2000;

  while (Date.now() < deadline) {
    const ctx = await readCachedContext(directory);
    if (ctx?.edgeStore) {
      logger.debug(`[waitForGraphRebuild] Graph rebuild completed after ${Date.now() - (deadline - timeoutMs)}ms`);
      return true;
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise(r => setTimeout(r, Math.min(pollIntervalMs, remaining)));
    }
  }

  logger.warning(
    `[waitForGraphRebuild] Graph rebuild did not complete within ${timeoutMs}ms timeout. ` +
    'Run "openlore analyze --force" manually to rebuild the call graph.'
  );
  return false;
}

// ============================================================================
// PROJECT FINGERPRINT — content-hash based cache invalidation
// ============================================================================

const FINGERPRINT_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.openlore',
  'coverage', '.cache', '__pycache__', '.venv', 'venv', 'target',
  '.dart_tool', '.pub-cache',
]);

const FINGERPRINT_SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.cs',
]);

async function walkForFingerprint(
  dir: string,
  root: string,
  out: Array<{ path: string; mtime: number; size: number }>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Skip the static skip set AND every OpenLore-managed dir (any `.openlore`
      // prefix: `.openlore` analysis output, `.openlore-live-cache` cloned
      // fixtures, …). These churn independently of the user's source — including
      // them makes the content-hash flap, so isCacheFresh would force needless
      // re-analysis whenever the live-data fixture cache is refreshed.
      if (!FINGERPRINT_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.openlore')) {
        await walkForFingerprint(join(dir, entry.name), root, out);
      }
    } else if (entry.isFile() && FINGERPRINT_SOURCE_EXTS.has(extname(entry.name))) {
      try {
        const s = await stat(join(dir, entry.name));
        out.push({ path: relative(root, join(dir, entry.name)), mtime: s.mtimeMs, size: s.size });
      } catch {
        // skip unreadable
      }
    }
  }
}

/** Compute a SHA-256 fingerprint of all source file mtimes+sizes under rootDir. */
export async function computeProjectFingerprint(rootDir: string): Promise<string> {
  const files: Array<{ path: string; mtime: number; size: number }> = [];
  await walkForFingerprint(rootDir, rootDir, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const payload = files.map(f => `${f.path}:${f.mtime}:${f.size}`).join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Returns true if the cached analysis matches the current source files.
 * Uses content-hash fingerprint when available; falls back to TTL check.
 */
export async function isCacheFresh(directory: string): Promise<boolean> {
  const fingerprintPath = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_FINGERPRINT);
  try {
    const stored = JSON.parse(await readFile(fingerprintPath, 'utf-8')) as { hash: string };
    const current = await computeProjectFingerprint(directory);
    return current === stored.hash;
  } catch {
    // No fingerprint yet — fall back to TTL
    try {
      const s = await stat(join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT));
      return Date.now() - s.mtimeMs < ANALYSIS_STALE_THRESHOLD_MS;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// BIDIRECTIONAL CODE ↔ SPEC LINKING (#4)
// ============================================================================

export interface MappingEntry {
  requirement: string;
  service: string;
  domain: string;
  specFile: string;
  functions: Array<{ name: string; file: string; line: number; kind: string; confidence: string }>;
}

export interface MappingIndex {
  /** filePath → list of mapping entries that reference it */
  byFile: Map<string, MappingEntry[]>;
  /** domain → list of mapping entries for that domain */
  byDomain: Map<string, MappingEntry[]>;
  entries: MappingEntry[];
}

/** Cache for mapping indices, keyed by directory path */
const mappingCache = new Map<string, MappingIndex>();

/** Load and index mapping.json for bidirectional lookup. Returns null if not found. */
export async function loadMappingIndex(absDir: string, retryCount: number = 1): Promise<MappingIndex | null> {
  // Check cache first
  const cacheKey = absDir;
  const cached = mappingCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  
  const loadAttempt = async (attempt: number): Promise<MappingIndex | null> => {
    try {
      const raw = await readFile(join(absDir, '.openlore', 'analysis', 'mapping.json'), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      // Untrusted artifact: validate top-level shape before use. A malformed
      // mapping.json (non-object, or no `mappings` array) fails closed — retrying
      // can't fix a shape mismatch, so return null directly.
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { mappings?: unknown }).mappings)) {
        return null;
      }
      const data = parsed as { mappings: MappingEntry[] };
      const entries = data.mappings ?? [];
      
      const byFile = new Map<string, MappingEntry[]>();
      const byDomain = new Map<string, MappingEntry[]>();
      
      for (const entry of entries) {
        // index by domain
        const domainList = byDomain.get(entry.domain) ?? [];
        domainList.push(entry);
        byDomain.set(entry.domain, domainList);
        
        // index by each referenced file
        for (const fn of entry.functions) {
          if (!fn.file || fn.file === '*') continue;
          const fileList = byFile.get(fn.file) ?? [];
          // avoid duplicates (same requirement may appear multiple times per file)
          if (!fileList.includes(entry)) fileList.push(entry);
          byFile.set(fn.file, fileList);
        }
      }
      
      const result = { byFile, byDomain, entries };
      // Cache the result
      mappingCache.set(cacheKey, result);
      return result;
    } catch (error) {
      if (attempt < retryCount && error instanceof Error) {
        const delay = Math.pow(2, attempt) * 100; // Exponential backoff: 200ms, 400ms, 800ms...
        await new Promise(resolve => setTimeout(resolve, delay));
        return loadAttempt(attempt + 1);
      }
      return null;
    }
  };
  
  return loadAttempt(1);
}

/** Clear the mapping cache. Useful for tests to reset state. */
export function clearMappingCache(): void {
  mappingCache.clear();
}

/** Summarise which specs cover a given file path (for search_code enrichment). */
export function specsForFile(index: MappingIndex, filePath: string): Array<{ requirement: string; domain: string; specFile: string }> {
  const entries = index.byFile.get(filePath) ?? [];
  // deduplicate by requirement
  const seen = new Set<string>();
  return entries
    .filter(e => { const k = `${e.domain}::${e.requirement}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(e => ({ requirement: e.requirement, domain: e.domain, specFile: e.specFile }));
}

/** Return functions that implement a given domain/specFile (for search_specs enrichment). */
export function functionsForDomain(index: MappingIndex, domain: string): Array<{ name: string; file: string; line: number; kind: string; confidence: string; requirement: string }> {
  const entries = index.byDomain.get(domain) ?? [];
  const result: Array<{ name: string; file: string; line: number; kind: string; confidence: string; requirement: string }> = [];
  for (const entry of entries) {
    for (const fn of entry.functions) {
      if (fn.name === '*') continue;
      result.push({ ...fn, requirement: entry.requirement });
    }
  }
  return result;
}
