/**
 * Terminal dispositions for decision drafts (change: explain-decision-rejection).
 *
 * The invariant under test: consolidation assigns EVERY input draft a verdict
 * with a stated reason. A draft can no longer stop existing silently — and where
 * attribution is ambiguous, the tool says "did not survive" rather than inventing
 * a merge target.
 */
import { describe, it, expect } from 'vitest';
import {
  DECISION_DISPOSITION_REASONS,
  applyDispositions,
  authorStatementOf,
  computeDraftDispositions,
  contentWasRewritten,
  describeDisposition,
  readDisposition,
  withVerificationOutcome,
} from './disposition.js';
import type { DecisionStore, PendingDecision } from '../../types/index.js';

function decision(over: Partial<PendingDecision> & { id: string }): PendingDecision {
  return {
    status: 'draft',
    title: `title ${over.id}`,
    rationale: `rationale ${over.id}`,
    consequences: '',
    proposedRequirement: null,
    affectedDomains: [],
    affectedFiles: [],
    sessionId: 's',
    recordedAt: '2026-01-01T00:00:00Z',
    contentOrigin: 'agent-recorded',
    confidence: 'medium',
    scope: 'component',
    syncedToSpecs: [],
    ...over,
  } as PendingDecision;
}

function store(decisions: PendingDecision[]): DecisionStore {
  return { version: '1', sessionId: 's', updatedAt: '', decisions } as DecisionStore;
}

describe('computeDraftDispositions', () => {
  it('promotes a draft whose id survives consolidation, noting a rewrite', () => {
    const draft = decision({ id: 'd1' });
    const kept = decision({ id: 'd1', status: 'consolidated' });
    const reworded = decision({ id: 'd1', status: 'consolidated', title: 'entirely different wording' });

    expect(computeDraftDispositions({ drafts: [draft], consolidated: [kept] })).toEqual([
      { id: 'd1', disposition: 'promoted', reason: 'promoted-as-recorded' },
    ]);
    expect(computeDraftDispositions({ drafts: [draft], consolidated: [reworded] })).toEqual([
      { id: 'd1', disposition: 'promoted', reason: 'promoted-with-rewrite' },
    ]);
  });

  it('treats whitespace-only differences as the same wording, not a rewrite', () => {
    const draft = decision({ id: 'd1', title: 'Use JWTs  for auth' });
    const kept = decision({ id: 'd1', status: 'consolidated', title: 'use jwts for auth' });
    expect(contentWasRewritten(draft, kept)).toBe(false);
  });

  it('rejects an explicitly superseded draft, naming supersession as the reason', () => {
    const [verdict] = computeDraftDispositions({
      drafts: [decision({ id: 'old' })],
      consolidated: [decision({ id: 'new', status: 'consolidated' })],
      supersededIds: ['old'],
    });
    expect(verdict).toEqual({ id: 'old', disposition: 'rejected', reason: 'superseded-by-later-draft' });
  });

  it('names the survivor when a draft was absorbed into the single consolidated decision', () => {
    const verdicts = computeDraftDispositions({
      drafts: [decision({ id: 'a' }), decision({ id: 'b' })],
      consolidated: [decision({ id: 'a', status: 'consolidated' })],
    });
    expect(verdicts[1]).toEqual({
      id: 'b', disposition: 'merged-into', reason: 'merged-into-consolidated', mergedIntoId: 'a',
    });
  });

  it('names the survivor when exactly one consolidated decision shares a file', () => {
    const verdicts = computeDraftDispositions({
      drafts: [decision({ id: 'b', affectedFiles: ['src/auth.ts'] })],
      consolidated: [
        decision({ id: 'x', status: 'consolidated', affectedFiles: ['src/auth.ts'] }),
        decision({ id: 'y', status: 'consolidated', affectedFiles: ['src/db.ts'] }),
      ],
    });
    expect(verdicts[0].disposition).toBe('merged-into');
    expect(verdicts[0].mergedIntoId).toBe('x');
  });

  it('refuses to invent a merge target when attribution is ambiguous', () => {
    const verdicts = computeDraftDispositions({
      drafts: [decision({ id: 'b', affectedFiles: ['src/auth.ts'] })],
      consolidated: [
        decision({ id: 'x', status: 'consolidated', affectedFiles: ['src/auth.ts'] }),
        decision({ id: 'y', status: 'consolidated', affectedFiles: ['src/auth.ts'] }),
      ],
    });
    expect(verdicts[0]).toEqual({ id: 'b', disposition: 'rejected', reason: 'not-in-consolidated-set' });
    expect(verdicts[0].mergedIntoId).toBeUndefined();
  });

  it('rejects every draft with a reason when consolidation keeps nothing', () => {
    const verdicts = computeDraftDispositions({
      drafts: [decision({ id: 'a' }), decision({ id: 'b' })],
      consolidated: [],
    });
    expect(verdicts.map(v => v.reason)).toEqual(['not-in-consolidated-set', 'not-in-consolidated-set']);
  });

  it('property: one persisted verdict per input draft, for any draft set — no silent drop', () => {
    // Deterministic pseudo-random shapes: draft counts, which ids survive, which
    // are superseded. Every case must satisfy dispositions.length === drafts.length.
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;

    for (let trial = 0; trial < 120; trial++) {
      const draftCount = 1 + rand(6);
      const drafts = Array.from({ length: draftCount }, (_, i) =>
        decision({ id: `d${trial}-${i}`, affectedFiles: rand(2) ? [`src/f${rand(3)}.ts`] : [] }));
      const consolidated = drafts
        .filter(() => rand(3) === 0)
        .map(d => decision({ id: d.id, status: 'consolidated' }));
      const supersededIds = drafts.filter(() => rand(4) === 0).map(d => d.id);

      const verdicts = computeDraftDispositions({ drafts, consolidated, supersededIds });
      expect(verdicts).toHaveLength(drafts.length);
      expect(new Set(verdicts.map(v => v.id))).toEqual(new Set(drafts.map(d => d.id)));
      for (const v of verdicts) {
        // Every emitted reason is registry-declared, and its declared disposition matches.
        expect(DECISION_DISPOSITION_REASONS[v.reason]).toBeDefined();
        expect(DECISION_DISPOSITION_REASONS[v.reason].disposition).toBe(v.disposition);
        expect(v.disposition).not.toBe('pending');
      }

      // And the verdicts persist: every draft in the store carries one.
      const persisted = applyDispositions(store(drafts), verdicts);
      expect(persisted.decisions.filter(d => d.disposition && d.disposition !== 'pending'))
        .toHaveLength(drafts.length);
    }
  });
});

describe('withVerificationOutcome', () => {
  it('overrides a promotion with no-supporting-diff when verification found the decision phantom', () => {
    const verdicts = computeDraftDispositions({
      drafts: [decision({ id: 'a' }), decision({ id: 'b' })],
      consolidated: [decision({ id: 'a', status: 'consolidated' }), decision({ id: 'b', status: 'consolidated' })],
    });
    const final = withVerificationOutcome(verdicts, new Set(['b']));
    expect(final[0].disposition).toBe('promoted');
    expect(final[1]).toEqual({ id: 'b', disposition: 'rejected', reason: 'no-supporting-diff' });
  });

  it('is a no-op when nothing was phantom', () => {
    const verdicts = computeDraftDispositions({
      drafts: [decision({ id: 'a' })],
      consolidated: [decision({ id: 'a', status: 'consolidated' })],
    });
    expect(withVerificationOutcome(verdicts, new Set())).toEqual(verdicts);
  });
});

describe('applyDispositions / readDisposition', () => {
  it('does not re-stamp a record that already reached a terminal verdict', () => {
    const decided = decision({
      id: 'a', status: 'rejected', disposition: 'rejected',
      dispositionReason: 'no-supporting-diff', dispositionAt: '2026-01-01T00:00:00Z',
    });
    const next = applyDispositions(store([decided]), [
      { id: 'a', disposition: 'promoted', reason: 'promoted-as-recorded' },
    ], '2026-02-02T00:00:00Z');
    expect(next.decisions[0].dispositionReason).toBe('no-supporting-diff');
    expect(next.decisions[0].dispositionAt).toBe('2026-01-01T00:00:00Z');
  });

  it('reads an undecided draft as pending, never as a rejection', () => {
    expect(readDisposition(decision({ id: 'a' }))).toEqual({
      disposition: 'pending', reason: 'awaiting-consolidation',
    });
  });

  it('reads a pre-existing record without a disposition as legacy-unknown, never as a rejection', () => {
    const legacy = decision({ id: 'a', status: 'synced' });
    const v = readDisposition(legacy);
    expect(v).toEqual({ disposition: 'pending', reason: 'legacy-unknown' });
    expect(DECISION_DISPOSITION_REASONS[v.reason].description).toMatch(/NOT a rejection/);
  });

  it('describes a rejection with its reason and a concrete next action', () => {
    const rejected = decision({
      id: 'a', status: 'rejected', disposition: 'rejected', dispositionReason: 'no-supporting-diff',
    });
    const line = describeDisposition(rejected);
    expect(line).toMatch(/^rejected/);
    expect(line).toContain('no-supporting-diff');
    expect(line).toMatch(/→ .*staged/);
  });

  it('describes a merge by naming the surviving decision', () => {
    const merged = decision({
      id: 'a', status: 'rejected', disposition: 'merged-into',
      dispositionReason: 'merged-into-consolidated', mergedIntoId: 'zz99',
    });
    expect(describeDisposition(merged)).toContain('survivor: zz99');
  });
});

describe('authorStatement', () => {
  it('captures the author’s recorded wording verbatim', () => {
    const draft = decision({ id: 'a', title: 'Use JWTs', rationale: 'Avoids a session store' });
    expect(authorStatementOf(draft)).toEqual({
      title: 'Use JWTs',
      rationale: 'Avoids a session store',
      recordedAt: '2026-01-01T00:00:00Z',
    });
  });
});
