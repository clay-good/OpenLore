/**
 * Pre-commit gate reason machine — property tests.
 * (change: harden-memory-integrity-invariant)
 *
 * Proves the machine is TOTAL (every state maps to exactly one outcome),
 * DETERMINISTIC / IDEMPOTENT (same state ⇒ same outcome), and DEADLOCK-FREE (a
 * blocked outcome always carries an actionable reason; a passing outcome never
 * carries one). Exhaustive over a representative finite slice of the state space.
 *
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect } from 'vitest';
import { classifyGateState, matchesConsolidationReceipt, type GateState, type GateOutcome } from './gate-state.js';
import { GATE_REASONS } from '../../constants.js';

const ALL_REASONS = new Set<string>(Object.values(GATE_REASONS));

/** Enumerate a representative finite slice: counts 0..2, both booleans. */
function* enumerateStates(): Generator<GateState> {
  for (const approvedCount of [0, 1, 2])
    for (const verifiedCount of [0, 1, 2])
      for (const draftCount of [0, 1, 2])
        for (const activeCount of [0, 1, 2])
          for (const consolidatedRecently of [false, true])
            for (const isGitRepo of [false, true])
              for (const hasStagedSourceChanges of [false, true])
                yield { approvedCount, verifiedCount, draftCount, activeCount, consolidatedRecently, isGitRepo, hasStagedSourceChanges };
}

/** Independent re-derivation of the spec'd priority order — locks the machine. */
function expectedOutcome(s: GateState): GateOutcome {
  if (s.approvedCount > 0) return { gated: true, reason: GATE_REASONS.APPROVED_NOT_SYNCED };
  if (s.verifiedCount > 0) return { gated: true, reason: GATE_REASONS.VERIFIED };
  if (s.draftCount > 0) return { gated: true, reason: GATE_REASONS.DRAFTS_PENDING_CONSOLIDATION };
  if (s.consolidatedRecently) return { gated: false, reason: null };
  if (s.activeCount === 0 && s.isGitRepo && s.hasStagedSourceChanges) {
    return { gated: true, reason: GATE_REASONS.NO_DECISIONS_RECORDED };
  }
  return { gated: false, reason: null };
}

describe('classifyGateState — totality', () => {
  it('every state maps to exactly one well-formed outcome', () => {
    for (const s of enumerateStates()) {
      const o = classifyGateState(s);
      expect(typeof o.gated).toBe('boolean');
      if (o.gated) {
        expect(ALL_REASONS.has(o.reason as string), `gated state ${JSON.stringify(s)} → unknown reason ${o.reason}`).toBe(true);
      } else {
        expect(o.reason, `passing state ${JSON.stringify(s)} carries a reason`).toBeNull();
      }
    }
  });
});

describe('matchesConsolidationReceipt', () => {
  const now = Date.parse('2026-08-23T12:00:00.000Z');
  const grace = 60 * 60 * 1000;

  it('accepts only a recent receipt for the exact source snapshot', () => {
    expect(matchesConsolidationReceipt('2026-08-23T11:30:00.000Z', 'same', 'same', now, grace)).toBe(true);
    expect(matchesConsolidationReceipt('2026-08-23T11:30:00.000Z', 'old', 'new', now, grace)).toBe(false);
  });

  it('rejects future, expired, malformed, and legacy timestamp-only receipts', () => {
    expect(matchesConsolidationReceipt('2026-08-23T12:00:01.000Z', 'same', 'same', now, grace)).toBe(false);
    expect(matchesConsolidationReceipt('2026-08-23T10:59:59.000Z', 'same', 'same', now, grace)).toBe(false);
    expect(matchesConsolidationReceipt('not-a-date', 'same', 'same', now, grace)).toBe(false);
    expect(matchesConsolidationReceipt('2026-08-23T11:30:00.000Z', undefined, 'same', now, grace)).toBe(false);
  });
});

describe('classifyGateState — deadlock-free', () => {
  it('a blocked outcome always carries an actionable reason; a pass never does', () => {
    for (const s of enumerateStates()) {
      const o = classifyGateState(s);
      // No "blocked with no reason" deadlock, and no "passing but flagged" contradiction.
      expect(o.gated === (o.reason !== null), `contradictory outcome for ${JSON.stringify(s)}`).toBe(true);
    }
  });
});

describe('classifyGateState — deterministic / idempotent', () => {
  it('produces an identical outcome on repeated evaluation', () => {
    for (const s of enumerateStates()) {
      expect(classifyGateState(s)).toEqual(classifyGateState(s));
    }
  });
});

describe('classifyGateState — matches the documented priority order', () => {
  it('agrees with the independent re-derivation across the whole slice', () => {
    for (const s of enumerateStates()) {
      expect(classifyGateState(s), `mismatch at ${JSON.stringify(s)}`).toEqual(expectedOutcome(s));
    }
  });

  it('approved-not-synced outranks every other reason', () => {
    const o = classifyGateState({
      approvedCount: 1, verifiedCount: 1, draftCount: 1, activeCount: 2,
      consolidatedRecently: false, isGitRepo: true, hasStagedSourceChanges: true,
    });
    expect(o).toEqual({ gated: true, reason: GATE_REASONS.APPROVED_NOT_SYNCED });
  });

  it('verified outranks drafts and no-decisions', () => {
    const o = classifyGateState({
      approvedCount: 0, verifiedCount: 1, draftCount: 1, activeCount: 1,
      consolidatedRecently: false, isGitRepo: true, hasStagedSourceChanges: true,
    });
    expect(o).toEqual({ gated: true, reason: GATE_REASONS.VERIFIED });
  });

  it('recent consolidation passes even when source is staged', () => {
    const o = classifyGateState({
      approvedCount: 0, verifiedCount: 0, draftCount: 0, activeCount: 0,
      consolidatedRecently: true, isGitRepo: true, hasStagedSourceChanges: true,
    });
    expect(o).toEqual({ gated: false, reason: null });
  });

  it('no-decisions-recorded requires git repo AND staged source AND no active decisions', () => {
    const base = { approvedCount: 0, verifiedCount: 0, draftCount: 0, consolidatedRecently: false } as const;
    expect(classifyGateState({ ...base, activeCount: 0, isGitRepo: true, hasStagedSourceChanges: true }))
      .toEqual({ gated: true, reason: GATE_REASONS.NO_DECISIONS_RECORDED });
    // Missing any one condition → passes.
    expect(classifyGateState({ ...base, activeCount: 1, isGitRepo: true, hasStagedSourceChanges: true }).gated).toBe(false);
    expect(classifyGateState({ ...base, activeCount: 0, isGitRepo: false, hasStagedSourceChanges: true }).gated).toBe(false);
    expect(classifyGateState({ ...base, activeCount: 0, isGitRepo: true, hasStagedSourceChanges: false }).gated).toBe(false);
  });
});
