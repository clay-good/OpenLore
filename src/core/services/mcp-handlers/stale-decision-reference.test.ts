import { describe, it, expect } from 'vitest';
import {
  findStaleDecisionReferences,
  buildRetirementGraph,
  type StaleReferenceInputs,
} from './stale-decision-reference.js';
import type { PendingDecision, AnchoredMemory, MemoryFreshness } from '../../../types/index.js';

function decision(p: Partial<PendingDecision> & { id: string }): PendingDecision {
  return {
    id: p.id,
    status: p.status ?? 'approved',
    title: p.title ?? `decision ${p.id}`,
    rationale: p.rationale ?? '',
    consequences: p.consequences ?? '',
    proposedRequirement: p.proposedRequirement ?? null,
    affectedDomains: p.affectedDomains ?? [],
    affectedFiles: p.affectedFiles ?? [],
    anchors: p.anchors,
    supersedes: p.supersedes,
    sessionId: p.sessionId ?? 's1',
    recordedAt: p.recordedAt ?? '2026-06-23T00:00:00Z',
    contentOrigin: p.contentOrigin ?? 'agent-recorded',
    confidence: p.confidence ?? 'high',
    syncedToSpecs: p.syncedToSpecs ?? [],
  };
}

function memory(p: Partial<AnchoredMemory> & { id: string; content: string }): AnchoredMemory {
  return {
    id: p.id,
    kind: 'note',
    content: p.content,
    anchors: p.anchors ?? [{ filePath: 'src/x.ts', symbolName: 'x', nodeId: 'src/x.ts::x' }],
    recordedAt: p.recordedAt ?? '2026-06-23T00:00:00Z',
    invalidatedAt: p.invalidatedAt,
  };
}

const allFresh = (): MemoryFreshness => 'fresh';

function run(partial: Partial<StaleReferenceInputs>) {
  return findStaleDecisionReferences({
    decisions: partial.decisions ?? [],
    memories: partial.memories ?? [],
    specs: partial.specs ?? [],
    freshnessOf: partial.freshnessOf ?? allFresh,
  });
}

// B superseded by C (the canonical retirement) used across scenarios.
const B = decision({ id: 'bbbbbbbb', title: 'use bcrypt' });
const C = decision({ id: 'cccccccc', title: 'use argon2', supersedes: 'bbbbbbbb', rationale: 'replaces bbbbbbbb' });

describe('buildRetirementGraph', () => {
  it('maps a retired decision to its active superseder', () => {
    const g = buildRetirementGraph([B, C]);
    expect(g.supersededBy.get('bbbbbbbb')).toBe('cccccccc');
  });
  it('a rejected superseder does not retire its target', () => {
    const rejectedC = decision({ id: 'cccccccc', supersedes: 'bbbbbbbb', status: 'rejected' });
    expect(buildRetirementGraph([B, rejectedC]).supersededBy.size).toBe(0);
  });
});

describe('findStaleDecisionReferences', () => {
  // Scenario: a live decision still cites a superseded decision.
  it('flags an approved decision whose rationale cites the retired decision', () => {
    const A = decision({ id: 'aaaaaaaa', title: 'auth flow', rationale: 'builds on bbbbbbbb for hashing' });
    const out = run({ decisions: [A, B, C] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: 'stale-decision-reference',
      severity: 'warning',
      referencingArtifact: { kind: 'decision', id: 'aaaaaaaa' },
      retiredDecision: 'bbbbbbbb',
      supersededBy: 'cccccccc',
    });
  });

  // Scenario: the superseding decision is not flagged for its own supersedes edge.
  it('exempts the superseding decision — C citing B via supersedes produces no finding', () => {
    // C.rationale also mentions bbbbbbbb, but C is the superseder (exempt edge).
    const out = run({ decisions: [B, C] });
    expect(out).toHaveLength(0);
  });

  // Scenario: a reference to a live decision is clean.
  it('does not flag a memory that references a live (non-retired) decision', () => {
    const mem = memory({ id: 'm1111111', content: 'follow cccccccc when hashing' });
    const out = run({ decisions: [B, C], memories: [mem] });
    expect(out).toHaveLength(0);
  });

  it('flags a non-orphaned memory that cites the retired decision', () => {
    const mem = memory({ id: 'm2222222', content: 'hashing per bbbbbbbb' });
    const out = run({ decisions: [B, C], memories: [mem] });
    expect(out).toHaveLength(1);
    expect(out[0].referencingArtifact).toMatchObject({ kind: 'memory', id: 'm2222222' });
  });

  // Scenario: an orphaned memory is not treated as authoritative.
  it('does NOT flag an orphaned memory even if it cites the retired decision', () => {
    const mem = memory({ id: 'm3333333', content: 'hashing per bbbbbbbb' });
    const out = run({ decisions: [B, C], memories: [mem], freshnessOf: () => 'orphaned' });
    expect(out).toHaveLength(0);
  });

  it('does NOT flag an invalidated memory (history, not authoritative)', () => {
    const mem = memory({ id: 'm4444444', content: 'hashing per bbbbbbbb', invalidatedAt: '2026-06-22T00:00:00Z' });
    const out = run({ decisions: [B, C], memories: [mem] });
    expect(out).toHaveLength(0);
  });

  it('flags a spec requirement that still names the retired decision', () => {
    const spec = {
      file: 'openspec/specs/auth/spec.md',
      text: '# Auth\n\n### Requirement: Hashing\n\n> Decision recorded: bbbbbbbb\n',
    };
    const out = run({ decisions: [B, C], specs: [spec] });
    expect(out).toHaveLength(1);
    expect(out[0].referencingArtifact.kind).toBe('spec');
    expect(out[0].referencingArtifact.label).toContain('Requirement: Hashing');
  });

  it('a draft decision is not authoritative — not flagged', () => {
    const draft = decision({ id: 'dddddddd', status: 'draft', rationale: 'uses bbbbbbbb' });
    expect(run({ decisions: [draft, B, C] })).toHaveLength(0);
  });

  it('emits nothing when no decision is superseded', () => {
    const A = decision({ id: 'aaaaaaaa', rationale: 'uses bbbbbbbb' });
    const liveB = decision({ id: 'bbbbbbbb' }); // not superseded by anyone
    expect(run({ decisions: [A, liveB] })).toHaveLength(0);
  });

  it('output is deterministic and order-independent', () => {
    const A = decision({ id: 'aaaaaaaa', rationale: 'uses bbbbbbbb' });
    const mem = memory({ id: 'm2222222', content: 'per bbbbbbbb' });
    const a = run({ decisions: [A, B, C], memories: [mem] });
    const b = run({ decisions: [C, B, A], memories: [mem] });
    expect(a).toEqual(b);
  });
});

// ── adversarial hardening (PR #190 review: H1/H3/M1) ──────────────────────────
describe('findStaleDecisionReferences — adversarial edge cases', () => {
  // H1: a superseder's OWN synced ADR legitimately names the id it retired; it must
  // NOT be flagged. A separate requirement that cites the retired id MUST still flag.
  it('does NOT flag the spec block that documents the supersession (superseder ADR)', () => {
    const spec = {
      file: 'openspec/specs/auth/spec.md',
      text: [
        '## Decisions',
        '',
        '### Use argon2',
        '**ID:** cccccccc',
        'Replaces the prior bcrypt decision (bbbbbbbb) for password hashing.',
        '> Decision recorded: cccccccc',
        '',
        '### Requirement: LegacyHashing',
        'This requirement still rests on decision bbbbbbbb.',
      ].join('\n'),
    };
    const out = run({ decisions: [B, C], specs: [spec] });
    // exactly one finding — the LegacyHashing requirement, not the argon2 ADR block
    expect(out).toHaveLength(1);
    expect(out[0].referencingArtifact.label).toContain('LegacyHashing');
  });

  // H3: two active decisions supersede the same target — the chosen superseder must be
  // deterministic (lexicographically smallest), independent of store order.
  it('is deterministic when two decisions supersede the same target', () => {
    const c1 = decision({ id: 'c1c1c1c1', supersedes: 'bbbbbbbb', title: 'first reversal' });
    const c2 = decision({ id: 'c2c2c2c2', supersedes: 'bbbbbbbb', title: 'second reversal' });
    const mem = memory({ id: 'm2222222', content: 'per bbbbbbbb' });
    const a = run({ decisions: [B, c1, c2], memories: [mem] });
    const b = run({ decisions: [B, c2, c1], memories: [mem] });
    expect(a).toEqual(b);
    expect(a[0].supersededBy).toBe('c1c1c1c1'); // smallest id wins
  });

  it('buildRetirementGraph picks the smallest superseder id deterministically', () => {
    const c1 = decision({ id: 'c1c1c1c1', supersedes: 'bbbbbbbb' });
    const c2 = decision({ id: 'c2c2c2c2', supersedes: 'bbbbbbbb' });
    expect(buildRetirementGraph([c2, c1, B]).supersededBy.get('bbbbbbbb')).toBe('c1c1c1c1');
  });

  // M1: chain A←B←C. A live decision citing A must report the LIVE terminal C, not the
  // dead intermediate B.
  it('resolves a supersession chain to the live terminal superseder', () => {
    const dA = decision({ id: 'a0a0a0a0', title: 'gen 1' });
    const dB = decision({ id: 'b0b0b0b0', title: 'gen 2', supersedes: 'a0a0a0a0' });
    const dC = decision({ id: 'c0c0c0c0', title: 'gen 3', supersedes: 'b0b0b0b0' });
    const live = decision({ id: 'eeeeeeee', title: 'cites gen 1', rationale: 'still relies on a0a0a0a0' });
    const out = run({ decisions: [dA, dB, dC, live] });
    const forA = out.find((f) => f.retiredDecision === 'a0a0a0a0')!;
    expect(forA).toBeDefined();
    expect(forA.supersededBy).toBe('c0c0c0c0'); // terminal, not the dead b0b0b0b0
  });

  it('discloses deterministic cycle membership without inventing a live superseder', () => {
    // pathological: A supersedes B and B supersedes A. Neither is an authoritative
    // terminal replacement, and in particular neither may resolve to itself.
    const a = decision({ id: 'aaaaaaaa', supersedes: 'bbbbbbbb' });
    const b = decision({ id: 'bbbbbbbb', supersedes: 'aaaaaaaa' });
    const forward = buildRetirementGraph([a, b]);
    const reverse = buildRetirementGraph([b, a]);
    expect(forward.supersededBy.size).toBe(0);
    expect(forward.cycles).toEqual([['aaaaaaaa', 'bbbbbbbb']]);
    expect(reverse.cycles).toEqual(forward.cycles);
  });

  it('canonicalizes multiple cycles despite competing superseders and shuffled input', () => {
    const a = decision({ id: 'aaaaaaaa', supersedes: 'bbbbbbbb' });
    const b = decision({ id: 'bbbbbbbb', supersedes: 'aaaaaaaa' });
    const c = decision({ id: 'cccccccc', supersedes: 'aaaaaaaa' });
    const d = decision({ id: 'dddddddd', supersedes: 'eeeeeeee' });
    const e = decision({ id: 'eeeeeeee', supersedes: 'ffffffff' });
    const f = decision({ id: 'ffffffff', supersedes: 'dddddddd' });
    const g = buildRetirementGraph([f, c, d, b, e, a]);
    expect(g.cycles).toEqual([
      ['aaaaaaaa', 'bbbbbbbb'],
      ['dddddddd', 'eeeeeeee', 'ffffffff'],
    ]);
    expect(g.supersededBy.has('cccccccc')).toBe(false); // superseder, not retired target
    expect(g.supersededBy.size).toBe(0);
  });

  // H2: a retired id embedded in a longer hex blob (e.g. a 40-char git SHA) has no word
  // boundary and must NOT match; a standalone token must.
  it('does not false-match a retired id embedded inside a 40-char git SHA', () => {
    const retired = decision({ id: 'deadbeef', title: 'old' });
    const superc = decision({ id: 'cafef00d', supersedes: 'deadbeef' });
    const embedded = {
      file: 'openspec/specs/x/spec.md',
      text: '### Requirement: Embedded\nCommit deadbeef0123456789abcdef0123456789abcdef touched this.',
    };
    const standalone = {
      file: 'openspec/specs/y/spec.md',
      text: '### Requirement: Standalone\nStill rests on decision deadbeef directly.',
    };
    const out = run({ decisions: [retired, superc], specs: [embedded, standalone] });
    expect(out).toHaveLength(1);
    expect(out[0].referencingArtifact.label).toContain('Standalone');
  });
});
