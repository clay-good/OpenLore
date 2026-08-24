/**
 * Pure pre-commit gate reason machine.
 * (change: harden-memory-integrity-invariant)
 *
 * The commit gate maps the current decision-store state to exactly one outcome:
 * either it passes, or it blocks with one of the canonical {@link GATE_REASONS}.
 * That mapping used to live inline in the CLI command, tangled with stdout, git,
 * and TTY I/O — impossible to prove total or deterministic. Extracting it as this
 * pure function makes the machine a tested contract:
 *
 *   - **total**     — every reachable state yields exactly one outcome;
 *   - **deterministic / idempotent** — same state ⇒ same outcome, every time;
 *   - **deadlock-free** — no state maps to "blocked with no actionable reason."
 *
 * The CLI gathers the booleans (store counts, consolidation recency, staged git
 * changes) and builds the user-facing payload; this function is the single
 * arbiter of *which* reason applies.
 */

import { GATE_REASONS, type GateReason } from '../../constants.js';

/** The minimal state the gate decision depends on. All inputs are data, not I/O. */
export interface GateState {
  /** Decisions in `approved` status (synced to specs not yet done). */
  approvedCount: number;
  /** Decisions in `verified` status (await human approval). */
  verifiedCount: number;
  /** Decisions in `draft` status (recorded, not yet consolidated). */
  draftCount: number;
  /** True when consolidation ran within the grace period — trust it found nothing. */
  consolidatedRecently: boolean;
  /** Count of non-inactive decisions (excludes rejected/synced/phantom). */
  activeCount: number;
  /** Whether the working directory is a git repo (gates the staged-source check). */
  isGitRepo: boolean;
  /** Whether staged changes include a recognized source file. */
  hasStagedSourceChanges: boolean;
}

export type GateOutcome =
  | { gated: false; reason: null }
  | { gated: true; reason: GateReason };

/** A grace receipt is valid only for the exact source snapshot it assessed. */
export function matchesConsolidationReceipt(
  consolidatedAt: string | undefined,
  recordedFingerprint: string | undefined,
  currentFingerprint: string | undefined,
  nowMs: number,
  gracePeriodMs: number,
): boolean {
  if (!consolidatedAt || !recordedFingerprint || !currentFingerprint) return false;
  const age = nowMs - new Date(consolidatedAt).getTime();
  return Number.isFinite(age)
    && age >= 0
    && age < gracePeriodMs
    && recordedFingerprint === currentFingerprint;
}

/**
 * Classify a gate state into exactly one outcome. The priority order mirrors the
 * commit gate: a not-yet-synced approval blocks first, then verified decisions
 * awaiting approval, then unconsolidated drafts, then (only when nothing is
 * recorded and source is staged) the no-decisions prompt; otherwise it passes.
 */
export function classifyGateState(s: GateState): GateOutcome {
  // 1. Approved but not synced — must write to specs before committing.
  if (s.approvedCount > 0) return { gated: true, reason: GATE_REASONS.APPROVED_NOT_SYNCED };

  // 2. Verified decisions await human approval.
  if (s.verifiedCount > 0) return { gated: true, reason: GATE_REASONS.VERIFIED };

  // 3. Drafts recorded but consolidation never completed.
  if (s.draftCount > 0) return { gated: true, reason: GATE_REASONS.DRAFTS_PENDING_CONSOLIDATION };

  // 4. Consolidation ran recently and found nothing → pass.
  if (s.consolidatedRecently) return { gated: false, reason: null };

  // 5. Nothing recorded but source is staged → prompt for a fallback extraction.
  if (s.activeCount === 0 && s.isGitRepo && s.hasStagedSourceChanges) {
    return { gated: true, reason: GATE_REASONS.NO_DECISIONS_RECORDED };
  }

  // 6. Otherwise the commit is clean.
  return { gated: false, reason: null };
}
