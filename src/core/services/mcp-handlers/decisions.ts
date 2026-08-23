/**
 * MCP tool handlers: decisions
 *
 * record_decision      — agent records an architectural decision during dev
 * list_decisions       — list pending/approved/all decisions
 * approve_decision     — approve a decision for syncing
 * reject_decision      — reject a decision
 * sync_decisions       — write approved decisions to spec.md files
 */

import { spawn } from 'node:child_process';
import { validateDirectory, sanitizeMcpError, safeOpenspecDir } from './utils.js';
import { emit } from '../telemetry.js';
import {
  loadDecisionStore,
  updateDecisionStore,
  upsertDecisions,
  patchDecision,
  makeDecisionId,
  illegalPromotionToApproved,
} from '../../decisions/store.js';
import { syncApprovedDecisions } from '../../decisions/syncer.js';
import { isDecisionsLockHeld } from '../../runtime/advisory-lock.js';
import { buildSpecMap, matchFileToDomains } from '../../../core/drift/spec-mapper.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { join } from 'node:path';
import type { DecisionConstraintBlock, PendingDecision, DecisionScope } from '../../../types/index.js';
import { decisionContentProvenance } from '../served-content.js';
import {
  DECISION_DISPOSITION_REASONS,
  describeDisposition,
  readDisposition,
} from '../../decisions/disposition.js';
import { validateDecisionConstraintBlock } from '../../decisions/constraint-ledger.js';

type ConsolidateSpawnOutcome =
  | { outcome: 'started' }
  | { outcome: 'coalesced' }
  | { outcome: 'failed'; detail: string };

/**
 * Fire the detached `decisions --consolidate` that keeps the commit-time gate
 * instant. Hardened so a routine environment gap can never crash the long-lived
 * MCP server (harden-decision-consolidation):
 *   - if a consolidation run is already in flight, coalesce onto it (no second
 *     process, no new locking mechanism — the existing consolidation lock is the
 *     in-flight sentinel);
 *   - register `child.on('error')` so a pre-exec failure (ENOENT/EACCES) is a
 *     contained rejection, not an uncaught exception on the host process;
 *   - resolve the earlier of `spawn`/`error` (bounded — one event tick, not run
 *     completion, since the child is detached + unref'd) and return the outcome
 *     so the caller can report it honestly.
 */
async function spawnConsolidateBackground(rootPath: string): Promise<ConsolidateSpawnOutcome> {
  // Coalesce: a run already underway will pick up this freshly-recorded draft.
  if (await isDecisionsLockHeld(rootPath)) {
    return { outcome: 'coalesced' };
  }

  // Resolve binary: prefer local build over global install (same order as pre-commit hook)
  const localDist = join(rootPath, 'dist', 'cli', 'index.js');
  const localBin = join(rootPath, 'node_modules', '.bin', 'openlore');
  const { existsSync } = await import('node:fs');
  let cmd: string;
  let args: string[];
  if (existsSync(localBin)) {
    cmd = localBin; args = ['decisions', '--consolidate'];
  } else if (existsSync(localDist)) {
    cmd = process.execPath; args = [localDist, 'decisions', '--consolidate'];
  } else {
    cmd = 'openlore'; args = ['decisions', '--consolidate'];
  }

  return await new Promise<ConsolidateSpawnOutcome>((resolve) => {
    let settled = false;
    const settle = (o: ConsolidateSpawnOutcome) => {
      if (!settled) { settled = true; resolve(o); }
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: rootPath, detached: true, stdio: 'ignore' });
    } catch (err) {
      // Synchronous throw (rare — e.g. invalid args) is contained, never rethrown.
      settle({ outcome: 'failed', detail: (err as Error).message });
      return;
    }
    // Node emits exactly one of 'spawn' / 'error' for a spawn attempt; the error
    // listener is the fix for defect 1 — without it an ENOENT is an uncaught
    // exception in the MCP server process.
    child.on('error', (err: Error) => settle({ outcome: 'failed', detail: err.message }));
    child.on('spawn', () => {
      child!.unref();
      settle({ outcome: 'started' });
    });
  });
}

// ============================================================================
// record_decision
// ============================================================================

export async function handleRecordDecision(
  directory: string,
  title: string,
  rationale: string,
  consequences?: string,
  affectedFiles?: string[],
  supersedes?: string,
  scope?: DecisionScope,
  constraints?: DecisionConstraintBlock,
): Promise<unknown> {
  try {
    if (!title?.trim()) return { error: 'title is required and must not be empty.' };
    if (!rationale?.trim()) return { error: 'rationale is required and must not be empty.' };

    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    // Infer domain from affectedFiles via spec-map (best-effort, falls back to 'unknown')
    let primaryDomain = 'unknown';
    let inferredDomains: string[] = [];
    if (affectedFiles?.length) {
      try {
        const openloreConfig = await readOpenLoreConfig(rootPath);
        const openspecPath = safeOpenspecDir(rootPath, openloreConfig?.openspecPath);
        const specMap = await buildSpecMap({ rootPath, openspecPath });
        const domainSet = new Set<string>();
        for (const file of affectedFiles) {
          for (const domain of matchFileToDomains(file, specMap)) {
            domainSet.add(domain);
          }
        }
        inferredDomains = [...domainSet];
        if (inferredDomains.length > 0) primaryDomain = inferredDomains[0];
      } catch {
        // spec-map unavailable — keep 'unknown'
      }
    }

    const id = makeDecisionId(store.sessionId, primaryDomain, title.trim());
    if (constraints) {
      const findings = validateDecisionConstraintBlock({ id, title: title.trim(), rationale: rationale.trim() }, constraints);
      if (findings.length > 0) {
        return { error: findings.map((finding) => finding.message).join('; ') };
      }
    }

    // Re-recording something already decided must return that verdict, not open a
    // second draft the author will watch disappear the same way
    // (change: explain-decision-rejection). Match on the deterministic id (content
    // + session + domain) — the same identity the store already dedupes on.
    const existing = store.decisions.find((d) => d.id === id);
    if (existing) {
      const verdict = readDisposition(existing);
      if (verdict.disposition !== 'pending') {
        const entry = DECISION_DISPOSITION_REASONS[verdict.reason];
        return {
          id: existing.id,
          alreadyDecided: true,
          status: existing.status,
          disposition: verdict.disposition,
          reason: verdict.reason,
          reasonDescription: entry.description,
          ...(entry.nextAction ? { nextAction: entry.nextAction } : {}),
          ...(verdict.mergedIntoId ? { mergedIntoId: verdict.mergedIntoId } : {}),
          readVerdictWith: `openlore decisions status ${existing.id}`,
          message:
            `This decision was already recorded and decided: ${describeDisposition(existing)} ` +
            'No new draft was created.',
        };
      }
    }

    // Resolve scope: explicit caller value wins; otherwise auto-promote via deterministic signals.
    // Two independent triggers, either is sufficient:
    //   1. Structural: files span 2+ distinct top-level source dirs (file-topology, no LLM)
    //   2. Semantic: multiple domains inferred AND rationale contains contract/API keywords
    // Rationale-only matching is intentionally avoided — too fuzzy to be reliable under replay.
    let resolvedScope: DecisionScope = scope ?? 'component';
    if (!scope) {
      const topLevelDirs = new Set(
        (affectedFiles ?? []).map((f) => f.split('/').slice(0, 2).join('/')),
      );
      const hasStructuralCrossDomain = topLevelDirs.size >= 2;

      const lowerRationale = (rationale ?? '').toLowerCase();
      const isRefactorOrUtil =
        /\b(refactor|rename|extract|util|helper|constant|config|logging|test)\b/.test(lowerRationale);
      const hasContractKeyword =
        /\b(api|schema|contract|interface|protocol|auth|database|event|migration)\b/.test(lowerRationale);
      const hasSemanticCrossDomain = inferredDomains.length >= 2 && !isRefactorOrUtil && hasContractKeyword;

      if (hasStructuralCrossDomain || hasSemanticCrossDomain) {
        resolvedScope = 'cross-domain';
      }
    }

    // Resolve structural anchors deterministically against the call graph so the
    // decision can self-invalidate when the code it describes changes/dies. Best
    // effort: if no analysis exists yet, the decision is recorded unanchored and
    // falls back to file-level freshness from affectedFiles at recall time.
    let anchors: PendingDecision['anchors'];
    if (affectedFiles?.length) {
      const anchorCtx = AnchorContext.open(rootPath);
      if (anchorCtx) {
        try {
          const resolved = anchorCtx.resolveDecisionAnchors(
            affectedFiles,
            `${title} ${rationale} ${consequences ?? ''}`,
          );
          if (resolved.length) anchors = resolved;
        } finally {
          anchorCtx.close();
        }
      }
    }

    const decision: PendingDecision = {
      id,
      status: 'draft',
      scope: resolvedScope,
      title: title.trim(),
      rationale: rationale.trim(),
      consequences: consequences ?? '',
      proposedRequirement: null,
      affectedDomains: inferredDomains,
      affectedFiles: affectedFiles ?? [],
      anchors,
      supersedes,
      constraints,
      sessionId: store.sessionId,
      recordedAt: new Date().toISOString(),
      contentOrigin: 'agent-recorded',
      confidence: 'medium',
      syncedToSpecs: [],
    };

    // CAS upsert so concurrent record_decision calls never lose a draft: the
    // id-keyed merge is re-applied to the latest store on a write conflict.
    // The decision id is derived from the committed store's sessionId (not the
    // separately-loaded one) so repeated records in a session dedupe correctly —
    // a fresh load of an absent store mints a new random sessionId. (harden-memory-integrity-invariant)
    let recordedId = id;
    await updateDecisionStore(rootPath, (s) => {
      recordedId = makeDecisionId(s.sessionId, primaryDomain, title.trim());
      return upsertDecisions(s, [{ ...decision, id: recordedId, sessionId: s.sessionId }]);
    }, 'agent');

    // Consolidate in background so commit-time gate is instant. The decision is
    // already committed (CAS upsert above), independent of the spawn's outcome —
    // report that outcome honestly rather than an unconditional "running".
    const spawnOutcome = await spawnConsolidateBackground(rootPath);
    // The response says DRAFT, not "recorded", and names where the verdict is read.
    // The tool proposes a decision; diff-grounded consolidation decides it
    // (change: explain-decision-rejection).
    const readVerdictWith = `openlore decisions status ${recordedId}`;
    const message =
      spawnOutcome.outcome === 'failed'
        ? `Draft decision recorded: "${title}". Consolidation could NOT be started (${spawnOutcome.detail}) — run \`openlore decisions --consolidate\` to decide it now, then read the verdict with \`${readVerdictWith}\`.`
        : spawnOutcome.outcome === 'coalesced'
          ? `Draft decision recorded: "${title}". Consolidation already running — this draft will be picked up by the in-flight run. Read its verdict with \`${readVerdictWith}\`.`
          : `Draft decision recorded: "${title}". Diff-grounded consolidation is running in background and will promote, merge, or reject it with a stated reason. Read the verdict with \`${readVerdictWith}\`.`;

    return {
      id: recordedId,
      status: 'draft' as const,
      disposition: 'pending' as const,
      reason: 'awaiting-consolidation' as const,
      consolidation: spawnOutcome.outcome,
      readVerdictWith,
      message,
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// list_decisions
// ============================================================================

export async function handleListDecisions(
  directory: string,
  status?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    const decisions = status
      ? store.decisions.filter((d) => d.status === status)
      : store.decisions;

    return {
      total: decisions.length,
      sessionId: store.sessionId,
      updatedAt: store.updatedAt,
      decisions: decisions.map((d) => ({
        id: d.id,
        status: d.status,
        title: d.title,
        rationale: d.rationale,
        servedContentMetadata: { provenance: decisionContentProvenance(d) },
        confidence: d.confidence,
        affectedDomains: d.affectedDomains,
        affectedFiles: d.affectedFiles,
        proposedRequirement: d.proposedRequirement,
        recordedAt: d.recordedAt,
        syncedToSpecs: d.syncedToSpecs,
        verificationEvidence: d.verificationEvidence,
        contentOrigin: d.contentOrigin,
        // The verdict travels with the record: a caller reading the list can tell a
        // promoted decision from one still awaiting consolidation, and the author's
        // own wording survives a consolidator rewrite
        // (change: explain-decision-rejection).
        ...(() => {
          const v = readDisposition(d);
          return {
            disposition: v.disposition,
            dispositionReason: v.reason,
            ...(v.mergedIntoId ? { mergedIntoId: v.mergedIntoId } : {}),
          };
        })(),
        ...(d.authorStatement ? { authorStatement: d.authorStatement } : {}),
        // Provenance is always disclosed: an autopilot-accepted decision is
        // authoritative but never presented as human-reviewed. (add-decision-autopilot)
        ...(d.approvedBy ? { approvedBy: d.approvedBy } : {}),
        ...(d.humanReviewedAt ? { humanReviewedAt: d.humanReviewedAt } : {}),
        ...(d.constraints ? { constraints: d.constraints } : {}),
      })),
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// approve_decision
// ============================================================================

export async function handleApproveDecision(
  directory: string,
  id: string,
  note?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    const decision = store.decisions.find((d) => d.id === id);
    if (!decision) return { error: `Decision ${id} not found.` };
    // Transition guard: refuse promoting a rejected (or already-synced) decision
    // to approved — a recorded human verdict is never reversed as a side-effect.
    const illegal = illegalPromotionToApproved(id, decision.status, decision.reviewNote);
    if (illegal) return { error: illegal };

    const committed = await updateDecisionStore(rootPath, (s) => patchDecision(s, id, {
      status: 'approved',
      approvedBy: 'human',
      reviewedAt: new Date().toISOString(),
      reviewNote: note,
    }), 'human');
    // The patch no-ops if the decision was concurrently removed/synced — report
    // honestly rather than a false success.
    const after = committed.decisions.find((d) => d.id === id);
    if (!after || after.status !== 'approved') {
      return { error: `Decision ${id} could not be approved — it was concurrently removed or changed.` };
    }
    emit(rootPath, 'decisions', { event: 'decision_approved', id, title: decision.title });

    return { id, status: 'approved', title: decision.title };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// reject_decision
// ============================================================================

export async function handleRejectDecision(
  directory: string,
  id: string,
  note?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    const decision = store.decisions.find((d) => d.id === id);
    if (!decision) return { error: `Decision ${id} not found.` };

    const committed = await updateDecisionStore(rootPath, (s) => patchDecision(s, id, {
      status: 'rejected',
      reviewedAt: new Date().toISOString(),
      reviewNote: note,
    }), 'human');
    const after = committed.decisions.find((d) => d.id === id);
    if (!after || after.status !== 'rejected') {
      return { error: `Decision ${id} could not be rejected — it was concurrently removed or changed.` };
    }
    emit(rootPath, 'decisions', { event: 'decision_rejected', id, title: decision.title });

    return { id, status: 'rejected', title: decision.title };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// sync_decisions
// ============================================================================

export async function handleSyncDecisions(
  directory: string,
  dryRun = false,
  id?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const openloreConfig = await readOpenLoreConfig(rootPath);
    if (!openloreConfig) return { error: 'No openlore configuration found. Run openlore init first.' };

    const openspecPath = safeOpenspecDir(rootPath, openloreConfig.openspecPath);
    const specMap = await buildSpecMap({ rootPath, openspecPath });

    let store = await loadDecisionStore(rootPath);

    // If a specific id is given, promote it to approved before syncing. Commit
    // the promotion through the CAS store update (not a locally-loaded copy) and
    // re-verify it landed — the same patch-then-verify discipline as
    // approve_decision/reject_decision. This is what stops a draft recorded
    // concurrently between the load above and the sync from being clobbered:
    // the CAS re-applies the patch to the latest store, preserving that draft.
    if (id) {
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) return { error: `Decision ${id} not found.` };
      // Transition guard: sync must never resurrect a rejected decision (or
      // re-promote a synced one) by promoting it to approved before the write.
      const illegal = illegalPromotionToApproved(id, decision.status, decision.reviewNote);
      if (illegal) return { error: illegal };
      store = await updateDecisionStore(
        rootPath,
        (s) => patchDecision(s, id, { status: 'approved' }),
        'human',
      );
      const after = store.decisions.find((d) => d.id === id);
      if (!after || (after.status !== 'approved' && after.status !== 'synced')) {
        return { error: `Decision ${id} could not be promoted for sync — it was concurrently removed or changed.` };
      }
    }

    const { result } = await syncApprovedDecisions(store, {
      rootPath,
      openspecPath,
      specMap,
      dryRun,
    });

    emit(rootPath, 'decisions', { event: 'decisions_synced', count: result.synced.length, dry_run: dryRun });

    return {
      synced: result.synced.map((d) => ({ id: d.id, title: d.title, specs: d.syncedToSpecs })),
      errors: result.errors,
      modifiedSpecs: result.modifiedSpecs,
      dryRun,
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}
