/**
 * Terminal dispositions for decision drafts (change: explain-decision-rejection).
 *
 * `record_decision` writes a draft and a background consolidator decides its
 * fate. Before this module a draft that was not promoted simply stopped
 * existing: no verdict, no reason, nothing the author could read. Guessing
 * whether the call failed, the wording was wrong, or the evidence was missing is
 * not a reasonable thing to ask of a caller.
 *
 * Every input draft now reaches one of four states, each with a stable reason
 * code from the registry below:
 *   pending      — consolidation has not run yet (an honest "not decided",
 *                  never a rejection by omission)
 *   promoted     — it survived, as recorded or with re-derived wording
 *   merged-into  — it was absorbed, and the surviving decision is named
 *   rejected     — it did not survive, and the reason says why
 *
 * The mapping is DERIVED, deterministic, and computed with no LLM: it reads the
 * consolidation output against the input drafts. Where attribution is genuinely
 * ambiguous — a draft absent from a multi-decision consolidated set with no
 * unique overlap — it reports `rejected / not-in-consolidated-set` rather than
 * inventing a merge target. An honest "it did not survive" beats a fabricated
 * lineage.
 */

import { isDeepStrictEqual } from 'node:util';
import type {
  AuthorStatement,
  DecisionDisposition,
  DecisionDispositionReason,
  DecisionStore,
  PendingDecision,
} from '../../types/index.js';
import { patchDecision, replaceDecisions } from './store.js';

/**
 * Source-declared reason registry. A code that is not here cannot be emitted;
 * the description is what a human reads, and `nextAction` is what they do about
 * it. Same discipline as the governance FINDING_CODE_REGISTRY.
 */
export const DECISION_DISPOSITION_REASONS: Record<
  DecisionDispositionReason,
  { disposition: DecisionDisposition; description: string; nextAction?: string }
> = {
  'promoted-as-recorded': {
    disposition: 'promoted',
    description: 'Consolidation kept this decision with the wording you recorded.',
  },
  'promoted-with-rewrite': {
    disposition: 'promoted',
    description:
      'Consolidation kept this decision but re-derived its wording from the diff; your original text is preserved as authorStatement.',
  },
  'merged-into-consolidated': {
    disposition: 'merged-into',
    description: 'This draft was absorbed into another consolidated decision.',
    nextAction: 'Read the surviving decision named in mergedIntoId.',
  },
  'superseded-by-later-draft': {
    disposition: 'rejected',
    description: 'A later draft explicitly superseded this one.',
    nextAction: 'Read the superseding decision; re-record only if the reversal was wrong.',
  },
  'not-in-consolidated-set': {
    disposition: 'rejected',
    description:
      'Consolidation did not carry this draft into the final set, and no single surviving decision could be identified as its target.',
    nextAction:
      'Re-record it with a narrower subject and a rationale that names the constraint it introduces, or accept that it was not architectural.',
  },
  'no-supporting-diff': {
    disposition: 'rejected',
    description:
      'Verification found no change in the diff supporting this decision (recorded as phantom).',
    nextAction:
      'Record it again once the supporting code change is staged, so the decision is anchored to real evidence.',
  },
  'awaiting-consolidation': {
    disposition: 'pending',
    description: 'Recorded as a draft; background consolidation has not decided it yet.',
    nextAction: 'Run `openlore decisions --consolidate` to decide it now.',
  },
  'legacy-unknown': {
    disposition: 'pending',
    description:
      'Recorded before dispositions existed — its outcome was never captured. This is an unknown, NOT a rejection.',
  },
};

/** One draft's verdict. */
export interface DraftDisposition {
  id: string;
  disposition: DecisionDisposition;
  reason: DecisionDispositionReason;
  /** Set exactly when `disposition` is `merged-into`. */
  mergedIntoId?: string;
  /** Internal lineage used to prove that a verification replacement was persisted. */
  replacementId?: string;
}

/** Normalize whitespace so a formatting-only difference is not read as a rewrite. */
function normalize(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when consolidation re-derived the wording rather than keeping the author's. */
export function contentWasRewritten(draft: PendingDecision, consolidated: PendingDecision): boolean {
  return normalize(draft.title) !== normalize(consolidated.title)
    || normalize(draft.rationale) !== normalize(consolidated.rationale);
}

/** The author's words, kept verbatim for a decision whose content was re-derived. */
export function authorStatementOf(draft: PendingDecision): AuthorStatement {
  return { title: draft.title, rationale: draft.rationale, recordedAt: draft.recordedAt };
}

/**
 * Derive one verdict per input draft. Total by construction: the returned array
 * has exactly one entry per draft, in input order.
 *
 * Attribution rules, in order:
 *   1. The draft's id appears in the consolidated set  → promoted (rewrite noted).
 *   2. The draft was explicitly superseded             → rejected/superseded.
 *   3. Exactly one consolidated decision exists, or exactly one shares a file
 *      with the draft                                  → merged-into that id.
 *   4. Otherwise                                       → rejected/not-in-set.
 */
export function computeDraftDispositions(input: {
  drafts: readonly PendingDecision[];
  consolidated: readonly PendingDecision[];
  supersededIds?: readonly string[];
}): DraftDisposition[] {
  const consolidatedById = new Map(input.consolidated.map(d => [d.id, d]));
  const superseded = new Set(input.supersededIds ?? []);

  return input.drafts.map((draft): DraftDisposition => {
    const survivor = consolidatedById.get(draft.id);
    if (survivor) {
      return {
        id: draft.id,
        disposition: 'promoted',
        reason: contentWasRewritten(draft, survivor) ? 'promoted-with-rewrite' : 'promoted-as-recorded',
      };
    }
    if (superseded.has(draft.id)) {
      return { id: draft.id, disposition: 'rejected', reason: 'superseded-by-later-draft' };
    }

    // Absorbed? Only when the target is UNAMBIGUOUS — a lone consolidated
    // decision, or exactly one sharing a file with this draft. Anything else is
    // reported as "did not survive", never as an invented merge.
    const target = uniqueMergeTarget(draft, input.consolidated);
    if (target) {
      return { id: draft.id, disposition: 'merged-into', reason: 'merged-into-consolidated', mergedIntoId: target };
    }
    return { id: draft.id, disposition: 'rejected', reason: 'not-in-consolidated-set' };
  });
}

function uniqueMergeTarget(
  draft: PendingDecision,
  consolidated: readonly PendingDecision[],
): string | undefined {
  if (consolidated.length === 0) return undefined;
  if (consolidated.length === 1) return consolidated[0].id;
  const draftFiles = new Set(draft.affectedFiles ?? []);
  if (draftFiles.size === 0) return undefined;
  const overlapping = consolidated.filter(c => (c.affectedFiles ?? []).some(f => draftFiles.has(f)));
  return overlapping.length === 1 ? overlapping[0].id : undefined;
}

/**
 * Fold the verification outcome into the verdicts: a decision the verifier could
 * not tie to a change in the diff (phantom) is rejected with `no-supporting-diff`,
 * even if consolidation had promoted it. Verification is the later, stronger
 * signal — and "no evidence in the diff" is precisely the reason an author most
 * needs to be told.
 */
export function withVerificationOutcome(
  dispositions: readonly DraftDisposition[],
  phantomIds: ReadonlySet<string>,
): DraftDisposition[] {
  if (phantomIds.size === 0) return [...dispositions];
  return dispositions.map(d =>
    phantomIds.has(d.id) || (d.mergedIntoId !== undefined && phantomIds.has(d.mergedIntoId))
      ? {
          id: d.id,
          disposition: 'rejected' as const,
          reason: 'no-supporting-diff' as const,
          replacementId: d.mergedIntoId ?? d.id,
        }
      : d);
}

/**
 * Atomically apply every state transition produced by one consolidation run.
 * `originalDraftIds` is captured before the LLM call, so drafts recorded while
 * consolidation is in flight remain untouched in the fresh CAS snapshot.
 *
 * Rejected originals stay in the store as an audit trail; verified/phantom
 * survivors replace source drafts with the same deterministic id. Dispositions
 * are applied last so both survivors and absorbed originals carry their verdict.
 */
export function applyConsolidationOutcome(
  store: DecisionStore,
  result: {
    originalDraftIds: ReadonlySet<string>;
    originalDrafts?: readonly PendingDecision[];
    capturedDecisions?: readonly PendingDecision[];
    verified: readonly PendingDecision[];
    phantom: readonly PendingDecision[];
    unassessed?: readonly PendingDecision[];
    supersededIds: readonly string[];
    dispositions: readonly DraftDisposition[];
  },
): DecisionStore {
  let next = store;
  const capturedById = new Map(
    (result.capturedDecisions ?? result.originalDrafts ?? []).map((decision) => [decision.id, decision]),
  );
  const protectedIds = new Set<string>();
  for (const id of result.originalDraftIds) {
    const current = store.decisions.find((decision) => decision.id === id);
    const captured = capturedById.get(id);
    if (!current || current.status !== 'draft' || (captured && !sameDecisionRevision(current, captured))) {
      protectedIds.add(id);
    }
  }

  // Superseded targets may be established verified/approved decisions rather
  // than input drafts. Compare them with the same captured snapshot so a human
  // verdict written during consolidation wins over the stale supersession.
  for (const id of result.supersededIds) {
    const current = store.decisions.find((decision) => decision.id === id);
    const captured = capturedById.get(id);
    if ((current && !captured)
        || (!current && captured)
        || (current && captured && !sameDecisionRevision(current, captured))) {
      protectedIds.add(id);
    }
  }

  const candidateSurvivors = [...result.verified, ...result.phantom, ...(result.unassessed ?? [])];
  // A newly generated survivor id was not part of the captured draft set. If it
  // appeared while consolidation was in flight, it belongs to the concurrent
  // writer and must not be overwritten by stale LLM output.
  for (const survivor of candidateSurvivors) {
    if (!result.originalDraftIds.has(survivor.id)
        && store.decisions.some((decision) => decision.id === survivor.id)) {
      protectedIds.add(survivor.id);
    }
  }

  const survivors = candidateSurvivors
    .filter((decision) => !protectedIds.has(decision.id));
  const survivorIds = new Set(survivors.map((decision) => decision.id));
  const phantomIds = new Set(survivors
    .filter((decision) => decision.status === 'phantom')
    .map((decision) => decision.id));
  const dispositionsById = new Map(result.dispositions.map((disposition) => [disposition.id, disposition]));
  const rejectedOriginalIds = new Set<string>();

  const persistedReplacementFor = (draftId: string): string | undefined => {
    if (survivorIds.has(draftId)) return draftId;
    const disposition = dispositionsById.get(draftId);
    const replacementId = disposition?.mergedIntoId ?? disposition?.replacementId;
    return replacementId && survivorIds.has(replacementId) ? replacementId : undefined;
  };
  const hasPersistedSuperseder = (targetId: string): boolean =>
    (result.originalDrafts ?? []).some((draft) =>
      draft.supersedes === targetId && persistedReplacementFor(draft.id) !== undefined);

  for (const id of result.originalDraftIds) {
    if (protectedIds.has(id) || survivorIds.has(id)) continue;
    const disposition = dispositionsById.get(id);
    const replacementPersisted =
      (disposition?.mergedIntoId !== undefined && survivorIds.has(disposition.mergedIntoId))
      || (disposition?.reason === 'superseded-by-later-draft' && hasPersistedSuperseder(id))
      || (disposition?.reason === 'no-supporting-diff'
        && phantomIds.has(disposition.replacementId ?? id));
    if (replacementPersisted) {
      next = patchDecision(next, id, { status: 'rejected' });
      rejectedOriginalIds.add(id);
    }
  }

  for (const id of result.supersededIds) {
    if (!protectedIds.has(id) && hasPersistedSuperseder(id)) {
      next = patchDecision(next, id, { status: 'rejected' });
    }
  }
  next = replaceDecisions(next, survivors);

  const applicableDispositions = result.dispositions.filter((disposition) =>
    !protectedIds.has(disposition.id)
    && !(disposition.mergedIntoId && protectedIds.has(disposition.mergedIntoId))
    && (survivorIds.has(disposition.id) || rejectedOriginalIds.has(disposition.id)),
  );
  return applyDispositions(next, applicableDispositions);
}

function sameDecisionRevision(current: PendingDecision, captured: PendingDecision): boolean {
  return isDeepStrictEqual(current, captured);
}

/**
 * Write the verdicts onto the store. Pure — the caller persists through the CAS
 * path. A decision that already carries a terminal disposition is not re-stamped;
 * a `pending` one is.
 */
export function applyDispositions(
  store: DecisionStore,
  dispositions: readonly DraftDisposition[],
  at: string = new Date().toISOString(),
): DecisionStore {
  let next = store;
  for (const d of dispositions) {
    const current = next.decisions.find(x => x.id === d.id);
    if (current && current.disposition && current.disposition !== 'pending') continue;
    next = patchDecision(next, d.id, {
      disposition: d.disposition,
      dispositionReason: d.reason,
      dispositionAt: at,
      ...(d.mergedIntoId ? { mergedIntoId: d.mergedIntoId } : {}),
    });
  }
  return next;
}

/**
 * The disposition of a stored record, filling in the honest defaults: a draft
 * with no disposition is awaiting consolidation; any other status with no
 * disposition predates this field and reads `legacy-unknown` — an unknown
 * outcome, explicitly not a rejection.
 */
export function readDisposition(d: PendingDecision): {
  disposition: DecisionDisposition;
  reason: DecisionDispositionReason;
  mergedIntoId?: string;
} {
  if (d.disposition && d.dispositionReason) {
    return {
      disposition: d.disposition,
      reason: d.dispositionReason,
      ...(d.mergedIntoId ? { mergedIntoId: d.mergedIntoId } : {}),
    };
  }
  return d.status === 'draft'
    ? { disposition: 'pending', reason: 'awaiting-consolidation' }
    : { disposition: 'pending', reason: 'legacy-unknown' };
}

/** One human-readable line: the verdict, why, and what to do next. */
export function describeDisposition(d: PendingDecision): string {
  const { disposition, reason, mergedIntoId } = readDisposition(d);
  const entry = DECISION_DISPOSITION_REASONS[reason];
  const target = mergedIntoId ? ` (survivor: ${mergedIntoId})` : '';
  const next = entry.nextAction ? ` → ${entry.nextAction}` : '';
  return `${disposition}${target} [${reason}]: ${entry.description}${next}`;
}
