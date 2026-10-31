import { describe, expect, it } from 'vitest';

import { classifyRecords, stateForFreshness, type VerificationRecord } from './fleet-coordination.js';

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
