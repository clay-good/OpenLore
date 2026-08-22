/**
 * openlore decisions — programmatic API
 *
 * Record, consolidate, and sync architectural decisions.
 * Never controls the process and is console-silent by default.
 */

import { join, resolve } from 'node:path';
import {
  OPENLORE_DIR,
  OPENLORE_LOGS_SUBDIR,
  OPENSPEC_SPECS_SUBDIR,
  DECISIONS_EXTRACTION_MAX_FILES,
  DECISIONS_DIFF_MAX_CHARS,
} from '../constants.js';
import { fileExists } from '../utils/command-helpers.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { isLlmLoggingEnabled } from '../core/services/llm-logging-policy.js';
import { isGitRepositoryRoot, getChangedFiles, getFileDiff, getCommitMessages, resolveBaseRef, buildSpecMap } from '../core/drift/index.js';
import {
  loadDecisionStore,
  updateDecisionStore,
  upsertDecisions,
  makeDecisionId,
  illegalPromotionToApproved,
} from '../core/decisions/store.js';
import { consolidateDrafts } from '../core/decisions/consolidator.js';
import { applyConsolidationOutcome, withVerificationOutcome } from '../core/decisions/disposition.js';
import { markVerificationEvidenceAbsent, verifyDecisions } from '../core/decisions/verifier.js';
import { syncApprovedDecisions } from '../core/decisions/syncer.js';
import type { PendingDecision, DecisionStore } from '../types/index.js';
import type { SyncResult } from '../core/decisions/syncer.js';
import type { BaseOptions, ProgressCallback } from './types.js';
import { resolveOpenspecDir } from '../utils/openspec-dir.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify } from '../core/services/repo-config-trust.js';
import { errors, isOpenLoreError } from '../utils/errors.js';
import { withLoggerOptions } from '../utils/logger.js';
import { resolveGenerationProvider, type ProviderName } from '../core/runtime/generation-core.js';

function progress(cb: ProgressCallback | undefined, step: string, status: 'start' | 'complete' | 'skip', detail?: string): void {
  cb?.({ phase: 'decisions', step, status, detail });
}

// ============================================================================
// OPTION TYPES
// ============================================================================

export interface RecordDecisionOptions {
  rootPath?: string;
  title: string;
  rationale: string;
  consequences?: string;
  affectedFiles?: string[];
  supersedes?: string;
}

export interface ConsolidateOptions extends BaseOptions {
  provider?: string;
  model?: string;
  apiBase?: string;
  openaiCompatBaseUrl?: string;
  sslVerify?: boolean;
  timeout?: number;
  baseRef?: string;
}

export interface SyncDecisionsOptions extends BaseOptions {
  ids?: string[];
  dryRun?: boolean;
}

export interface ConsolidateResult {
  verified: PendingDecision[];
  phantom: PendingDecision[];
  unassessed: PendingDecision[];
  missing: Array<{ file: string; description: string }>;
  store: DecisionStore;
}

// ============================================================================
// RECORD
// ============================================================================

/**
 * Record a new architectural decision draft.
 * Called by agents during development (via MCP or directly).
 * Returns the ID of the recorded decision.
 */
async function recordDecision(options: RecordDecisionOptions): Promise<{ id: string }> {
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const store = await loadDecisionStore(rootPath);

  const domain = 'unknown';
  const id = makeDecisionId(store.sessionId, domain, options.title);

  const decision: PendingDecision = {
    id,
    status: 'draft',
    title: options.title,
    rationale: options.rationale,
    consequences: options.consequences ?? '',
    proposedRequirement: null,
    affectedDomains: [],
    affectedFiles: options.affectedFiles ?? [],
    supersedes: options.supersedes,
    sessionId: store.sessionId,
    recordedAt: new Date().toISOString(),
    contentOrigin: 'agent-recorded',
    confidence: 'medium',
    syncedToSpecs: [],
  };

  // CAS upsert so concurrent writers never lose a draft; derive the id from the
  // committed store's sessionId so repeated records in a session dedupe correctly.
  let recordedId = id;
  await updateDecisionStore(rootPath, (s) => {
    recordedId = makeDecisionId(s.sessionId, domain, options.title);
    return upsertDecisions(s, [{ ...decision, id: recordedId, sessionId: s.sessionId }]);
  });

  return { id: recordedId };
}

export function openloreRecordDecision(options: RecordDecisionOptions): Promise<{ id: string }> {
  return withLoggerOptions({ quiet: true }, async () => {
    try {
      return await recordDecision(options);
    } catch (error) {
      if (isOpenLoreError(error)) throw error;
      throw errors.pipelineFailed(`Decision recording failed: ${(error as Error).message}`, error);
    }
  });
}

// ============================================================================
// CONSOLIDATE + VERIFY
// ============================================================================

/**
 * Consolidate draft decisions via LLM, then cross-verify against git diff.
 * Returns verified, phantom, and missing decision sets.
 */
async function consolidateDecisions(
  options: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const { onProgress } = options;

  const openloreConfig = await readOpenLoreConfig(rootPath, options.configPath);
  if (!openloreConfig) throw errors.noConfig(options.configPath);

  const resolved = resolveGenerationProvider(openloreConfig, {
    provider: options.provider as ProviderName | undefined,
    model: options.model,
    openaiCompatBaseUrl: options.openaiCompatBaseUrl,
  });
  if (!resolved) throw errors.apiNoApiKey();

  const llm = createLLMService({
    provider: resolved.provider,
    model: resolved.model,
    apiBase: resolveTrustedApiBase(options.apiBase, openloreConfig.llm?.apiBase),
    openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
    sslVerify: resolveTrustedSslVerify(
        options.sslVerify === undefined ? undefined : !options.sslVerify,
        openloreConfig.llm?.sslVerify,
      ),
    timeout: options.timeout ?? openloreConfig.generation?.timeout,
    disableResponseFormat: openloreConfig.generation?.disableResponseFormat,
    enableLogging: isLlmLoggingEnabled(),
    logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
    logRoot: rootPath,
  });

  const store = await loadDecisionStore(rootPath);
  const originalDrafts = store.decisions.filter((decision) => decision.status === 'draft');
  const originalDraftIds = new Set(originalDrafts.map((decision) => decision.id));

  const openspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
  const specMap = await buildSpecMap({ rootPath, openspecPath }).catch(() => undefined);

  progress(onProgress, 'Consolidating drafts', 'start');
  const { decisions: consolidated, supersededIds, dispositions } = await consolidateDrafts(store, llm, specMap);
  progress(onProgress, 'Consolidating drafts', 'complete', `${consolidated.length} decisions`);

  if (consolidated.length === 0) {
    await llm.saveLogs().catch(() => {});
    // Without a persisted replacement, omission cannot become rejection.
    const withVerdicts = dispositions.length
      ? await updateDecisionStore(rootPath, (s) => applyConsolidationOutcome(s, {
          originalDraftIds,
          originalDrafts,
          capturedDecisions: store.decisions,
          verified: [],
          phantom: [],
          supersededIds,
          dispositions,
        }))
      : store;
    const persistedUnassessed = originalDrafts.map((decision) =>
      withVerdicts.decisions.find((stored) => stored.id === decision.id) ?? decision);
    return { verified: [], phantom: [], unassessed: persistedUnassessed, missing: [], store: withVerdicts };
  }

  // Build combined diff + commit messages for verification
  let combinedDiff = '';
  let commitMessages = '';
  // Root-only: getFileDiff below the repo root receives repo-root-relative paths as
  // cwd-relative pathspecs and returns empty diffs, which would misclassify real
  // decisions as phantom. Gate on the root to preserve the prior "skip git" behavior.
  if (await isGitRepositoryRoot(rootPath)) {
    progress(onProgress, 'Building git diff', 'start');
    try {
      const baseRef = await resolveBaseRef(rootPath, options.baseRef ?? 'auto');
      const gitResult = await getChangedFiles({ rootPath, baseRef, includeUnstaged: false });
      const relevant = gitResult.files.slice(0, DECISIONS_EXTRACTION_MAX_FILES);
      const diffs = await Promise.all(
        relevant.map((f) => getFileDiff(rootPath, f.path, baseRef, DECISIONS_DIFF_MAX_CHARS))
      );
      combinedDiff = diffs.join('\n\n');
      commitMessages = await getCommitMessages(rootPath, baseRef).catch(() => '');
      progress(onProgress, 'Building git diff', 'complete', `${relevant.length} files`);
    } catch {
      progress(onProgress, 'Building git diff', 'skip', 'diff unavailable');
    }
  }

  progress(onProgress, 'Verifying decisions', 'start');
  const { verified, phantom, unassessed, missing } = combinedDiff
    ? await verifyDecisions(consolidated, combinedDiff, llm, commitMessages)
    : { verified: markVerificationEvidenceAbsent(consolidated), phantom: [], unassessed: [], missing: [] };
  await llm.saveLogs().catch(() => {});
  progress(onProgress, 'Verifying decisions', 'complete', `${verified.length} verified`);

  // CAS persist onto the freshest store so a concurrently-recorded draft is kept.
  // replaceDecisions (via applyConsolidationOutcome), NOT upsert: consolidated decisions
  // reuse their drafts' deterministic ids, so an upsert would silently drop the verified
  // status. Matches the CLI consolidation path.
  const unassessedIds = new Set(unassessed.map((decision) => decision.id));
  const unassessedForPersist = unassessed.map((decision) => ({
    ...decision,
    status: 'draft' as const,
    recordedAt: store.decisions.find((original) => original.id === decision.id)?.recordedAt
      ?? decision.recordedAt,
  }));
  const finalDispositions = withVerificationOutcome(
    dispositions.filter((disposition) => !unassessedIds.has(disposition.id)),
    new Set(phantom.map((d) => d.id)),
  );
  const updatedStore = await updateDecisionStore(rootPath, (s) =>
    applyConsolidationOutcome(s, {
      originalDraftIds,
      originalDrafts,
      capturedDecisions: store.decisions,
      verified,
      phantom,
      unassessed: unassessedForPersist,
      supersededIds,
      dispositions: finalDispositions,
    }),
  );
  const fromCommittedStore = (decisions: readonly PendingDecision[]): PendingDecision[] =>
    decisions.map((decision) =>
      updatedStore.decisions.find((stored) => stored.id === decision.id) ?? decision);

  return {
    verified: fromCommittedStore(verified),
    phantom: fromCommittedStore(phantom),
    unassessed: fromCommittedStore(unassessedForPersist),
    missing,
    store: updatedStore,
  };
}

export function openloreConsolidateDecisions(
  options: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  return withLoggerOptions({ quiet: options.quiet ?? true }, async () => {
    try {
      return await consolidateDecisions(options);
    } catch (error) {
      if (isOpenLoreError(error)) throw error;
      throw errors.pipelineFailed(`Decision consolidation failed: ${(error as Error).message}`, error);
    }
  });
}

// ============================================================================
// SYNC
// ============================================================================

/**
 * Sync all approved decisions into spec.md files and create ADRs.
 */
async function syncDecisions(
  options: SyncDecisionsOptions = {},
): Promise<SyncResult> {
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const { onProgress } = options;

  const openloreConfig = await readOpenLoreConfig(rootPath, options.configPath);
  if (!openloreConfig) throw errors.noConfig(options.configPath);

  const openspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
  const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);
  if (!(await fileExists(specsPath))) throw new Error('No specs found. Run openloreGenerate() first.');

  const specMap = await buildSpecMap({ rootPath, openspecPath });
  let store = await loadDecisionStore(rootPath);

  // Optionally filter to specific IDs
  if (options.ids?.length) {
    const promote = (current: DecisionStore): DecisionStore => {
      for (const reqId of options.ids!) {
        const d = current.decisions.find((x) => x.id === reqId);
        if (!d) continue;
        const illegal = illegalPromotionToApproved(reqId, d.status, d.reviewNote);
        if (illegal) throw new Error(illegal);
      }
      return {
        ...current,
        decisions: current.decisions.map((d) =>
          options.ids!.includes(d.id) && d.status !== 'approved'
            ? { ...d, status: 'approved' as const }
            : d,
        ),
      };
    };
    // Commit the promotion against the freshest CAS snapshot before any spec write.
    // A rejection that lands after the initial read is therefore observed by the
    // transition guard instead of being overwritten by the stale approved copy.
    store = options.dryRun ? promote(store) : await updateDecisionStore(rootPath, promote);
  } else {
    // Do not hand the syncer a snapshot older than spec-map construction.
    store = await loadDecisionStore(rootPath);
  }

  progress(onProgress, 'Syncing decisions', 'start');
  const { result } = await syncApprovedDecisions(store, {
    rootPath,
    openspecPath,
    specMap,
    dryRun: options.dryRun,
  });
  progress(onProgress, 'Syncing decisions', 'complete', `${result.synced.length} synced`);

  return result;
}

export function openloreSyncDecisions(
  options: SyncDecisionsOptions = {},
): Promise<SyncResult> {
  return withLoggerOptions({ quiet: options.quiet ?? true }, async () => {
    try {
      return await syncDecisions(options);
    } catch (error) {
      if (isOpenLoreError(error)) throw error;
      throw errors.pipelineFailed(`Decision sync failed: ${(error as Error).message}`, error);
    }
  });
}
