/**
 * Memory claim verdicts (change: add-memory-claim-verdicts).
 *
 * A memory's anchor can stay byte-identical while a fact it asserts stops being true ("`helper`
 * is dead" — until someone calls it). A memory can therefore carry structural claims in
 * `verify_claim`'s grammar. `remember` refuses a claim that is not confirmed when recorded, and
 * `recall` checks each claim again against the current graph:
 *
 *   confirmed    → `evidence-holds`
 *   refuted      → `evidence-refuted`     (the memory leaves the authoritative set)
 *   unverifiable → `evidence-unverifiable` (the memory leaves the authoritative set)
 *
 * Each check is `handleVerifyClaim` itself — the same verdict and receipt a human would get — so
 * there is no second claim evaluator to drift from the first. No LLM. The verifier is loaded lazily:
 * the shape check below runs on light paths (the prompt hook) that never check a claim.
 */

import type { ClaimKind } from './claim-verification.js';
import type { MemoryClaim } from '../../../types/index.js';

/** Most claims one memory may carry: every recall re-checks each one. */
export const MAX_MEMORY_CLAIMS = 10;
/** Longest claim subject/object: a symbol name or a decision id, never free text. */
const MAX_CLAIM_TERM = 256;

const MEMORY_CLAIM_KINDS: ReadonlySet<string> = new Set<MemoryClaim['kind']>([
  'calls', 'reaches', 'dead', 'impacts', 'safe-to-change', 'decision-current',
]);

export type ClaimEvidence = 'evidence-holds' | 'evidence-refuted' | 'evidence-unverifiable';

export interface ClaimCheck {
  kind: MemoryClaim['kind'];
  subject: string;
  object?: string;
  verdict: ClaimEvidence;
  reason: string;
  /** The `verify_claim` receipt: for `evidence-refuted`, the counter-evidence. */
  receipt?: unknown;
}

function isTerm(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_CLAIM_TERM;
}

/**
 * A stored claim OpenLore could have written. `notes.json` is committed repo content, so the read
 * path checks the shape as well as the write path.
 */
export function isWellFormedClaim(c: unknown): c is MemoryClaim {
  if (c === null || typeof c !== 'object') return false;
  const r = c as Record<string, unknown>;
  return typeof r.kind === 'string' && MEMORY_CLAIM_KINDS.has(r.kind) &&
    isTerm(r.subject) &&
    (r.object === undefined || isTerm(r.object)) &&
    (r.recordedIndexCommit === undefined || typeof r.recordedIndexCommit === 'string');
}

/** Parse caller-supplied claims, or say what is wrong with them. Verdicts are not checked here. */
export function parseClaims(claims: unknown): { claims: MemoryClaim[] } | { error: string } {
  if (!Array.isArray(claims)) return { error: 'claims must be an array of { kind, subject, object? }.' };
  if (claims.length > MAX_MEMORY_CLAIMS) {
    return { error: `too many claims: ${claims.length} (max ${MAX_MEMORY_CLAIMS}). Keep the claims the memory actually rests on.` };
  }
  const out: MemoryClaim[] = [];
  for (const [i, c] of claims.entries()) {
    const r = (c ?? {}) as Record<string, unknown>;
    if (typeof r.kind !== 'string' || !MEMORY_CLAIM_KINDS.has(r.kind)) {
      return { error: `claims[${i}].kind must be one of: ${[...MEMORY_CLAIM_KINDS].join(', ')}.` };
    }
    if (!isTerm(r.subject)) return { error: `claims[${i}].subject must be a symbol name or decision id (1-${MAX_CLAIM_TERM} characters).` };
    if (r.object !== undefined && !isTerm(r.object)) return { error: `claims[${i}].object must be a symbol name (1-${MAX_CLAIM_TERM} characters).` };
    out.push({ kind: r.kind as MemoryClaim['kind'], subject: r.subject, ...(r.object !== undefined ? { object: r.object as string } : {}) });
  }
  return { claims: out };
}

const EVIDENCE: Record<string, ClaimEvidence> = {
  confirmed: 'evidence-holds',
  refuted: 'evidence-refuted',
  unverifiable: 'evidence-unverifiable',
};

/**
 * Check claims against the current graph. `memo` shares a check between memories that carry the
 * same claim within one call; it never outlives the call, so a re-analyzed graph is always seen.
 */
export async function checkClaims(
  directory: string,
  claims: readonly MemoryClaim[],
  memo: Map<string, Promise<ClaimCheck>> = new Map(),
): Promise<ClaimCheck[]> {
  return Promise.all(claims.map((c) => {
    const key = JSON.stringify([c.kind, c.subject, c.object ?? null]);
    let check = memo.get(key);
    if (!check) {
      check = checkOne(directory, c);
      memo.set(key, check);
    }
    return check;
  }));
}

async function checkOne(directory: string, c: MemoryClaim): Promise<ClaimCheck> {
  const base = { kind: c.kind, subject: c.subject, ...(c.object !== undefined ? { object: c.object } : {}) };
  const { handleVerifyClaim } = await import('./claim-verification.js');
  const r = await handleVerifyClaim({ directory, kind: c.kind as ClaimKind, subject: c.subject, object: c.object }) as
    { verdict?: string; reason?: string; receipt?: unknown; error?: string };
  const verdict = r.verdict !== undefined ? EVIDENCE[r.verdict] : undefined;
  if (!verdict) {
    // No verdict at all (no analysis, no call graph, a malformed claim): the evidence cannot be checked.
    return { ...base, verdict: 'evidence-unverifiable', reason: r.error ?? 'The claim could not be checked.' };
  }
  return { ...base, verdict, reason: r.reason ?? '', ...(r.receipt !== undefined ? { receipt: r.receipt } : {}) };
}

/** The receipt's index commit, when the check produced one. */
export function receiptIndexCommit(check: ClaimCheck): string | undefined {
  const commit = (check.receipt as { indexCommit?: unknown } | undefined)?.indexCommit;
  return typeof commit === 'string' ? commit : undefined;
}
