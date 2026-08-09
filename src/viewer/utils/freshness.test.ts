import { freshnessFromResponse, mergeFreshness } from './freshness.js';

describe('viewer artifact freshness', () => {
  it('reads additive freshness headers from an artifact response', () => {
    const headers = new Headers({
      'X-OpenLore-Analysis-Freshness': 'stale',
      'X-OpenLore-Generated-At': '2026-08-09T00:00:00.000Z',
      'X-OpenLore-Analyzed-Commit': 'abc',
      'X-OpenLore-Current-Commit': 'def',
      'X-OpenLore-Files-Changed-Since': '2',
    });
    expect(freshnessFromResponse({ headers })).toEqual({
      status: 'stale', generatedAt: '2026-08-09T00:00:00.000Z',
      analyzedCommit: 'abc', currentCommit: 'def', filesChangedSince: 2,
    });
  });

  it('keeps the least trustworthy status across all rendered artifacts', () => {
    const current = { status: 'current' };
    const unknown = { status: 'unassessable' };
    const stale = { status: 'stale' };
    expect(mergeFreshness(current, unknown)).toBe(unknown);
    expect(mergeFreshness(unknown, stale)).toBe(stale);
    expect(mergeFreshness(stale, current)).toBe(stale);
  });
});
