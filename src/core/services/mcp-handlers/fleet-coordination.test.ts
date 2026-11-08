import { describe, expect, it } from 'vitest';

import { classifyRecords, lifecycleSubjectFor, stateForFreshness, type VerificationRecord } from './fleet-coordination.js';

const record = (over: Partial<VerificationRecord> = {}): VerificationRecord => ({
  id: 'r1', verdict: 'blast-radius-clean', branch: 'feat/x', baseCommit: 'abc123',
  producedBy: 'blast_radius', anchors: [{ filePath: 'a.ts' } as never], ...over,
});

describe('stateForFreshness', () => {
  it('maps the freshness lease verdicts to record states', () => {
    expect(stateForFreshness('fresh', true)).toBe('still-valid');
    expect(stateForFreshness('drifted', true)).toBe('invalidated');
    expect(stateForFreshness('orphaned', true)).toBe('needs-reverification');
  });

  it('never serves fresh by default: unknown or unanchored is needs-reverification', () => {
    expect(stateForFreshness('something-else', true)).toBe('needs-reverification');
    expect(stateForFreshness('fresh', false)).toBe('needs-reverification');
  });
});

describe('classifyRecords', () => {
  it('with no graph view, every record is needs-reverification (never silently fresh)', () => {
    const out = classifyRecords([record(), record({ id: 'r2', branch: 'feat/y' })], null);
    expect(out).toHaveLength(2);
    expect(out.every(c => c.state === 'needs-reverification')).toBe(true);
    expect(out[0]).toMatchObject({ id: 'r1', branch: 'feat/x', verdict: 'blast-radius-clean', baseCommit: 'abc123' });
    expect(out[0].reason).toMatch(/could not be located|graph is unavailable/);
  });

  it('carries the producing tool and base commit onto each classified record', () => {
    const [c] = classifyRecords([record({ producedBy: 'certify_merge', verdict: 'merge-compatible' })], null);
    expect(c.producedBy).toBe('certify_merge');
    expect(c.verdict).toBe('merge-compatible');
  });
});

describe('lifecycleSubjectFor', () => {
  it('omits the field a predicate needs rather than letting its absence mean "ended"', () => {
    // A record written before the lifecycle existed: no recordedAt, no worktree.
    const s = lifecycleSubjectFor(record());
    expect(s.lastSeenAt).toBeUndefined();   // the 30-minute idle rule cannot apply
    expect(s.worktree).toBeUndefined();     // never matched against the clone's worktree list
    expect(s.root).toBeUndefined();         // existsSync(undefined) must not read as "removed"
  });

  it('carries recordedAt as the last-seen timestamp the idle rule reads', () => {
    expect(lifecycleSubjectFor(record({ recordedAt: '2026-11-07T10:00:00.000Z' })).lastSeenAt)
      .toBe('2026-11-07T10:00:00.000Z');
  });

  it('offers the recorded directory as the root, not as a worktree of the clone', () => {
    // The record's `worktree` is the analysis directory, which may be a package INSIDE the
    // worktree: matching it against `git worktree list` would be a false worktree-removed.
    const s = lifecycleSubjectFor(record({ worktree: '/repo/packages/api' }));
    expect(s.root).toBe('/repo/packages/api');
    expect(s.worktree).toBeUndefined();
  });

  it('hex-validates the peer-written baseCommit before it can stand in for a revision', () => {
    const hex = 'a'.repeat(40);
    expect(lifecycleSubjectFor(record({ baseCommit: hex })).baseAtDeclare).toBe(hex);
    // Not a commit id: the merged predicate is unknown, and nothing is passed to git.
    for (const bad of ['abc', '--upload-pack=touch /tmp/x', 'HEAD~1', 'a'.repeat(39), 'A'.repeat(40), `${hex} --help`, '']) {
      expect(lifecycleSubjectFor(record({ baseCommit: bad })).baseAtDeclare).toBeUndefined();
    }
  });

  it('carries the branch through as recorded (the decider decides whether it is usable)', () => {
    expect(lifecycleSubjectFor(record({ branch: 'feat/x' })).branch).toBe('feat/x');
  });
});

describe('lifecycleSubjectFor — timestamps and branch evidence', () => {
  it('drops a recordedAt that cannot be parsed, so the idle rule reports unknown instead of expired', () => {
    for (const bad of ['just now', '', 'not-a-date', '2026-13-45T99:99:99Z']) {
      expect(lifecycleSubjectFor(record({ recordedAt: bad })).lastSeenAt).toBeUndefined();
    }
  });

  it('passes the branch evidence only when it was recorded as a real local branch', () => {
    expect(lifecycleSubjectFor(record({ branchWasLocalRef: true })).branchKnownRef).toBe(true);
    expect(lifecycleSubjectFor(record({ branchWasLocalRef: false })).branchKnownRef).toBeUndefined();
    expect(lifecycleSubjectFor(record()).branchKnownRef).toBeUndefined();
  });
});
