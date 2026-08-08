/**
 * ReversalAwareness — shared do-not-repeat logic (add-cross-agent-intent-handoff).
 *
 * Reverted/superseded intent surfaced as a cautionary "do not re-attempt" warning,
 * so an agent does not re-introduce an approach a prior agent/human already tried and
 * removed. Used by BOTH `orient` (the briefing surface) and `recall` (the dedicated
 * memory-retrieval surface) — they differ only in how they derive the scope; the
 * selection, rendering, ordering, and bounded-omission rules live here.
 *
 * Reverted intent is NEVER served as authoritative current context.
 */
import type { AnchoredMemory, PendingDecision } from '../../../types/index.js';
import { decisionContentProvenance, type ServedContentProvenance } from '../served-content.js';

/** A reverted/superseded piece of intent surfaced as a do-not-repeat warning. */
export interface Reversal {
  /** Where the reverted record came from. `note` marks an omission placeholder. */
  source: 'memory' | 'decision' | 'note';
  provenance: ServedContentProvenance;
  /** Id of the reverted memory/decision. Absent on a `note` placeholder. */
  id?: string;
  /** The reverted approach: the old memory content or decision title. Absent on a `note`. */
  what?: string;
  /** Recorded reason for the reversal (the superseding item's content/rationale). */
  reason?: string;
  /**
   * SHA at which the approach was retired — present only for memory reversals
   * (`invalidatedByCommit` = HEAD when the superseding memory was recorded). This is the
   * commit the note was retired *as of*, NOT a verified "this commit reverted the code"
   * claim; the data model does not capture the specific reverting diff.
   */
  revertedAtCommit?: string;
  /** Transaction-time the reversal was recorded (ISO). */
  revertedAt?: string;
  /** Id of the memory/decision that superseded this one. */
  supersededBy?: string;
  /** Pre-rendered conclusion the agent can act on directly. */
  warning: string;
}

/** Render the do-not-repeat conclusion for a reverted record. Deterministic, no LLM. */
export function renderReversalWarning(what: string, commit?: string, reason?: string): string {
  const where = commit ? ` (retired as of commit ${commit.slice(0, 8)})` : ' (retired)';
  const why = reason ? ` — recorded reason: ${reason}` : '';
  return `Do not re-attempt: ${what}${where}${why}`;
}

/** Default cap on reversals surfaced, with an explicit omission note past it. */
export const MAX_REVERSALS = 10;

/**
 * A decision B *effectively* supersedes its target iff B carries a `supersedes` link and
 * B is not itself `rejected`/`phantom` — a rejected supersession leaves the original
 * standing, and a phantom decision was never a real recorded decision. `synced`,
 * `approved`, `verified`, and `draft` all count (the supersession stands or is pending
 * consolidation). The superseded target may still be `draft`/`approved`/`verified` when
 * consolidation has not run (e.g. no LLM configured), so supersession is determined by
 * the link, not by waiting for the target's status to flip to `rejected`.
 */
export function isEffectiveSuperseder(b: PendingDecision): boolean {
  // `supersedes !== id` mirrors the memory path's self-supersede guard (memory.ts): a
  // decision that names its own (content-derived) id supersedes nothing and must not
  // retire itself.
  return !!b.supersedes && b.supersedes !== b.id && b.status !== 'rejected' && b.status !== 'phantom';
}

/**
 * Ids of decisions that are superseded by an effective superseder in this set. Shared by
 * the authoritative filter (which excludes them) and {@link collectReversals} (which warns
 * about them) so the two surfaces can never disagree — a superseded decision is shown as a
 * do-not-repeat reversal and is NEVER also served as authoritative current context, even in
 * the pre-consolidation window before its status flips to `rejected`.
 */
export function supersededDecisionIds(decisions: readonly PendingDecision[]): Set<string> {
  const ids = new Set<string>();
  for (const b of decisions) if (isEffectiveSuperseder(b)) ids.add(b.supersedes!);
  return ids;
}

export interface ReversalScope {
  /** True if this reverted memory is in the caller's scope (orient: by file; recall: by task). */
  memoryInScope: (m: AnchoredMemory) => boolean;
  /** True if this reverted decision (the superseded one) is in the caller's scope. */
  decisionInScope: (superseded: PendingDecision) => boolean;
}

/** Scope predicates anchored to a fixed set of files/domains — the orient-style scope. */
export function fileScope(scopeFiles: ReadonlySet<string>, relevantDomainSet?: ReadonlySet<string>): ReversalScope {
  return {
    memoryInScope: (m) => m.anchors.some((a) => !!a.filePath && scopeFiles.has(a.filePath)),
    decisionInScope: (a) =>
      (relevantDomainSet !== undefined && a.affectedDomains.some((dom) => relevantDomainSet.has(dom))) ||
      a.affectedFiles.some((f) => scopeFiles.has(f)),
  };
}

/**
 * Collect reverted intent in scope as do-not-repeat warnings, sorted most-recent
 * first and bounded with an explicit omission note (history is never silently
 * truncated). Returns `undefined` when nothing in scope was reverted.
 *
 * - A reverted **memory** is one with `invalidatedAt` set that the caller's
 *   `memoryInScope` accepts; the commit it was retired as of is `invalidatedByCommit`
 *   (HEAD when superseded) and its reason is the content of the memory that superseded
 *   it (via the supersedes link).
 * - A reverted **decision** A is one explicitly superseded by another decision B
 *   (`B.supersedes === A.id`) that the caller's `decisionInScope` accepts; the reason
 *   is B's rationale. Decisions carry no commit SHA, so none is surfaced for that path.
 */
export function collectReversals(
  memories: readonly AnchoredMemory[],
  decisions: readonly PendingDecision[],
  scope: ReversalScope,
  maxReversals: number = MAX_REVERSALS,
): Reversal[] | undefined {
  const rev: Reversal[] = [];

  const supersederByTarget = new Map<string, AnchoredMemory>();
  for (const n of memories) if (n.supersedes) supersederByTarget.set(n.supersedes, n);
  for (const m of memories) {
    if (!m.invalidatedAt) continue;
    if (!scope.memoryInScope(m)) continue;
    const by = supersederByTarget.get(m.id);
    rev.push({
      source: 'memory',
      provenance: 'local-unreviewed',
      id: m.id,
      what: m.content,
      reason: by?.content,
      revertedAtCommit: m.invalidatedByCommit,
      revertedAt: m.invalidatedAt,
      supersededBy: by?.id,
      warning: renderReversalWarning(m.content, m.invalidatedByCommit, by?.content),
    });
  }

  const decById = new Map(decisions.map((d) => [d.id, d]));
  for (const b of decisions) {
    if (!isEffectiveSuperseder(b)) continue;
    const a = decById.get(b.supersedes!);
    if (!a) continue;
    if (!scope.decisionInScope(a)) continue;
    rev.push({
      source: 'decision',
      provenance: decisionContentProvenance(a.status),
      id: a.id,
      what: a.title,
      reason: b.rationale,
      revertedAt: b.recordedAt,
      supersededBy: b.id,
      warning: renderReversalWarning(a.title, undefined, b.rationale),
    });
  }

  if (rev.length === 0) return undefined;
  // Most-recent reversal first; bounded with an explicit omission note.
  rev.sort((x, y) => (y.revertedAt ?? '').localeCompare(x.revertedAt ?? ''));
  const out = rev.slice(0, maxReversals);
  if (rev.length > maxReversals) {
    // Omission placeholder — no id/what so a `find(x => x.id === …)` consumer can't
    // match it; the warning carries the count.
    out.push({
      source: 'note',
      provenance: 'local-unreviewed',
      warning: `${rev.length - maxReversals} more reverted item(s) in scope not shown — raise the limit or query recall for the full history.`,
    });
  }
  return out;
}
