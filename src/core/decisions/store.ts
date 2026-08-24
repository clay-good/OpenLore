/**
 * Decision store — CRUD for .openlore/decisions/pending.json
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  OPENLORE_DIR,
  OPENLORE_DECISIONS_SUBDIR,
  DECISIONS_PENDING_FILE,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';
import { atomicWriteFile, casUpdate, quarantineCorrupt } from './atomic-store.js';
import { appendLedgerEntries, currentHeadCommit, diffStoreTransitions, type LedgerActor } from './ledger.js';
import type { PendingDecision, DecisionStore, DecisionStatus } from '../../types/index.js';
import { safeJoin } from '../../utils/path-confinement.js';

export function decisionsDir(rootPath: string): string {
  return safeJoin(resolve(rootPath), join(OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR));
}

function decisionsPath(rootPath: string): string {
  return safeJoin(resolve(rootPath), join(OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR, DECISIONS_PENDING_FILE));
}

export async function loadDecisionStore(rootPath: string): Promise<DecisionStore> {
  const path = decisionsPath(rootPath);
  if (!(await fileExists(path))) {
    return emptyStore();
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    // A genuine read fault (not corruption) — quarantine so the file is preserved
    // and the loss is loud, never a silent empty store.
    await quarantineCorrupt(path, `read failed: ${(err as Error).message}`);
    return emptyStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Torn / hand-corrupted JSON: quarantine, never silently empty. Silent memory
    // loss presents absence as current fact. (harden-memory-integrity-invariant)
    await quarantineCorrupt(path, `invalid JSON: ${(err as Error).message}`);
    return emptyStore();
  }
  // Untrusted artifact: validate top-level shape before use. A malformed store
  // (non-object, or no `decisions` array) is quarantined rather than letting a
  // poisoned shape reach `store.decisions.*` downstream (mcp-security).
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { decisions?: unknown }).decisions)) {
    await quarantineCorrupt(path, 'invalid shape (missing decisions array)');
    return emptyStore();
  }
  const store = parsed as DecisionStore;
  if (typeof store.sequence !== 'number') store.sequence = 0; // legacy default
  store.decisions = store.decisions.map((decision) => ({
    ...decision,
    contentOrigin: decision.contentOrigin ?? 'legacy-unknown',
  }));
  return store;
}

export async function saveDecisionStore(rootPath: string, store: DecisionStore): Promise<void> {
  const updated: DecisionStore = {
    ...store,
    updatedAt: new Date().toISOString(),
    sequence: (store.sequence ?? 0) + 1,
  };
  await atomicWriteFile(decisionsPath(rootPath), JSON.stringify(updated, null, 2) + '\n', 0o600);
}

/**
 * Concurrency-safe read-modify-write of the decision store. Loads, applies
 * `mutate` (a pure id-keyed merge such as {@link upsertDecisions} /
 * {@link patchDecision}), and commits under compare-and-swap so two concurrent
 * writers never lose a decision — on a conflict the mutate is re-applied to the
 * newer store. (harden-memory-integrity-invariant)
 *
 * Every committed status transition (and creation) is trailed on the append-only
 * decision ledger, attributed to `actor` (change: add-decision-autopilot). The
 * diff is taken against the exact snapshot the winning mutate ran on, so a CAS
 * retry never double-logs. Default actor 'sync' marks a system write; callers
 * acting for a human, an agent, or the autopilot pass that explicitly.
 */
export async function updateDecisionStore(
  rootPath: string,
  mutate: (store: DecisionStore) => DecisionStore,
  actor: LedgerActor = 'sync',
): Promise<DecisionStore> {
  // casUpdate re-invokes mutate on a conflict; the last invocation's input is
  // the snapshot the committed result was derived from.
  let winningBefore: DecisionStore | undefined;
  const committed = await casUpdate<DecisionStore>({
    storePath: decisionsPath(rootPath),
    load: () => loadDecisionStore(rootPath),
    mutate: (current) => {
      winningBefore = current;
      return { ...mutate(current), updatedAt: new Date().toISOString() };
    },
    serialize: (next) => JSON.stringify(next, null, 2) + '\n',
  });
  if (winningBefore) {
    const entries = diffStoreTransitions(
      winningBefore, committed, actor, new Date().toISOString(),
      await currentHeadCommit(rootPath),
    );
    await appendLedgerEntries(rootPath, entries);
  }
  return committed;
}

/**
 * Merge incoming decisions into the store, deduplicating by id.
 * Existing decisions are never overwritten.
 */
export function upsertDecisions(store: DecisionStore, incoming: PendingDecision[]): DecisionStore {
  const byId = new Map(store.decisions.map((d) => [d.id, d]));
  for (const d of incoming) {
    if (!byId.has(d.id)) byId.set(d.id, d);
  }
  return { ...store, decisions: [...byId.values()] };
}

/**
 * Merge incoming decisions into the store, always overwriting by id.
 * Use this for consolidation output — consolidated decisions share IDs with
 * their original drafts (makeDecisionId is deterministic), so upsertDecisions
 * would silently no-op after patchDecision marks the originals rejected.
 */
export function replaceDecisions(store: DecisionStore, incoming: PendingDecision[]): DecisionStore {
  const byId = new Map(store.decisions.map((d) => [d.id, d]));
  for (const d of incoming) {
    byId.set(d.id, d);
  }
  return { ...store, decisions: [...byId.values()] };
}

/** Patch a single decision by id. Returns the updated store (not yet saved). */
export function patchDecision(
  store: DecisionStore,
  id: string,
  patch: Partial<PendingDecision>
): DecisionStore {
  return {
    ...store,
    decisions: store.decisions.map((d) => (d.id === id ? { ...d, ...patch } : d)),
  };
}

/**
 * Apply a consolidation result to the store: mark each superseded draft `rejected`,
 * then merge the verified + phantom decisions with {@link replaceDecisions} (NOT
 * upsert). Consolidated decisions reuse their source drafts' deterministic ids, so an
 * upsert would treat the id as already-present and silently no-op — the draft would
 * never transition to its verified/phantom status. Pure; the caller persists the result
 * through the CAS path. (The CLI consolidation path performs the equivalent merge inline.)
 */
export function applyConsolidationResult(
  store: DecisionStore,
  result: { verified: PendingDecision[]; phantom: PendingDecision[]; supersededIds: string[] }
): DecisionStore {
  let next = store;
  for (const id of result.supersededIds) {
    next = patchDecision(next, id, { status: 'rejected' });
  }
  return replaceDecisions(next, [...result.verified, ...result.phantom]);
}

export function getDecisionsByStatus(
  store: DecisionStore,
  status: DecisionStatus
): PendingDecision[] {
  return store.decisions.filter((d) => d.status === status);
}

export function getDecisionCount(store: DecisionStore): number {
  return store.decisions.length;
}

/** Status blocks the commit gate until resolved. */
export function isBlockingStatus(status: DecisionStatus): boolean {
  return status === 'verified' || status === 'approved';
}

/** Status requires a --sync run before committing. */
export function requiresSync(status: DecisionStatus): boolean {
  return status === 'approved';
}

/** Statuses excluded from the "activeDecisions" gate guard. */
export const INACTIVE_STATUSES: ReadonlySet<DecisionStatus> = new Set([
  'rejected', 'synced', 'phantom',
]);

/**
 * Explicit status-transition table for promotion to `approved`. Promotion is
 * the one status change that approve_decision and sync_decisions perform, and
 * the one a human verdict must gate. A decision may be promoted to `approved`
 * only from one of these statuses.
 *
 * Two statuses are deliberately excluded and can never be promoted to `approved`
 * as a side-effect of any operation:
 *   - `rejected`: a recorded human verdict. Reversing it requires an explicit
 *     re-record (which returns the decision to `draft`), never a promote/sync.
 *   - `synced`: already written to the spec files; not re-promoted.
 */
export const PROMOTABLE_TO_APPROVED: ReadonlySet<DecisionStatus> = new Set<DecisionStatus>([
  'draft', 'consolidated', 'verified', 'phantom', 'approved', 'auto-approved',
]);

/**
 * Guard the `→ approved` transition. If promoting the decision is illegal from
 * its current status, return an error message naming that status and the human
 * step required to make the promotion legal; otherwise return `null`. Shared by
 * every promotion site (approve_decision, sync_decisions, the API sync, the CLI
 * `--approve`) so all refuse the same transitions identically — one table, one
 * verdict, no door left unlocked.
 *
 * This governs WHICH transitions are legal; the compare-and-swap commit of a
 * legal one is governed separately (`harden-decision-consolidation`).
 */
export function illegalPromotionToApproved(
  id: string,
  status: DecisionStatus,
  reviewNote?: string,
): string | null {
  if (PROMOTABLE_TO_APPROVED.has(status)) return null;
  if (status === 'rejected') {
    const note = reviewNote ? ` (rejection note: "${reviewNote}")` : '';
    return `Decision ${id} was rejected by a human${note} and will not be silently promoted to approved. To reverse a recorded rejection, re-record the decision (record_decision) so the approval is an explicit, reviewable act.`;
  }
  if (status === 'synced') {
    return `Decision ${id} is already synced to spec files and will not be re-promoted.`;
  }
  // Fail closed: any future status added to the vocabulary without being placed
  // in PROMOTABLE_TO_APPROVED is refused rather than silently promoted.
  return `Decision ${id} cannot be promoted to approved from status '${status}'.`;
}

/** Drop all inactive decisions — their content is already in ADRs / spec.md. */
export function purgeInactiveDecisions(store: DecisionStore): DecisionStore {
  return {
    ...store,
    decisions: store.decisions.filter((d) =>
      d.durableLifecycleConflict || !INACTIVE_STATUSES.has(d.status)),
  };
}

/** Stable 8-char ID derived from session + domain + title. */
export function makeDecisionId(sessionId: string, domain: string, title: string): string {
  return createHash('sha256').update(`${sessionId}:${domain}:${title}`).digest('hex').slice(0, 8);
}

/** Generate a new session ID for a commit cycle. */
export function newSessionId(): string {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12);
}

function emptyStore(): DecisionStore {
  return {
    version: '1',
    sessionId: newSessionId(),
    updatedAt: new Date().toISOString(),
    sequence: 0,
    decisions: [],
  };
}
