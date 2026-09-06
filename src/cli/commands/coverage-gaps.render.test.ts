/**
 * The human rendering of the coverage-gap report.
 *
 * This renderer had no test, and a three-bucket composition in the handler silently kept rendering
 * as two: 505 of a 794-gap remainder vanished from the printed counts, and a gap whose dead label
 * was withheld printed identically to a live one — the one-directionality rule broken on the human
 * surface by the feature whose premise is honesty. These cases exist so that cannot recur.
 */

import { describe, it, expect } from 'vitest';
import { renderHuman } from './coverage-gaps.js';

type Result = Parameters<typeof renderHuman>[0];

const base: Result = {
  scope: 'repo',
  analyzedSymbols: 10,
  reachableFromTest: 2,
  gapCount: 3,
  coverageGaps: [],
  soundness: { posture: 'gaps-only', claim: 'no-reaching-test', caveats: ['Reports only the sound direction.'] },
  coverage: { languages: ['TypeScript'], testDetection: 'full' },
};

const gap = (over: Partial<Result['coverageGaps'][number]> = {}): Result['coverageGaps'][number] => ({
  name: 'fn', file: 'src/a.ts', language: 'TypeScript', fanIn: 1, signals: [], ...over,
});

describe('renderHuman — the printed counts agree with the JSON', () => {
  it('prints all three buckets, and they add up', () => {
    const out = renderHuman({
      ...base,
      coverageGaps: [gap()],
      omitted: 794,
      composition: {
        returned: { live: 1, deadFlagged: 0 },
        omittedRemainder: { live: 151, deadFlagged: 138, boundaryWithheld: 505 },
        total: { live: 152, deadFlagged: 138, boundaryWithheld: 505 },
      },
    });
    expect(out).toContain('151 live · 138 dead-flagged · 505 reachability undecided');
    expect(out).toContain('of 152 live · 138 dead-flagged · 505 reachability undecided overall');
  });

  it('omits the third bucket entirely when nothing was withheld', () => {
    const out = renderHuman({
      ...base,
      coverageGaps: [gap()],
      composition: { returned: { live: 1, deadFlagged: 0 }, total: { live: 1, deadFlagged: 0 } },
    });
    expect(out).toContain('composition: 1 live · 0 dead-flagged');
    expect(out).not.toContain('undecided');
  });
});

describe('renderHuman — a withheld gap never reads as live', () => {
  it('carries its own tag, naming the site', () => {
    const out = renderHuman({
      ...base,
      coverageGaps: [gap({
        name: 'withheld',
        deadLabelWithheld: { reason: 'dynamic-boundary', site: { file: 'src/d.ts', line: 742, kind: 'computed-member' } },
      })],
    });
    expect(out).toContain('(reachability undecided: dynamic boundary at src/d.ts:742)');
  });

  it('a live gap, a dead-flagged gap and a withheld gap are all distinguishable', () => {
    const out = renderHuman({
      ...base,
      coverageGaps: [
        gap({ name: 'liveGap' }),
        gap({ name: 'deadGap', alsoFlaggedDead: true, deadReason: 'no-callers' }),
        gap({ name: 'withheldGap', deadLabelWithheld: { reason: 'dynamic-boundary', site: { file: 'src/d.ts', line: 9, kind: 'reflective-invoke' } } }),
      ],
    });
    const line = (n: string) => out.split('\n').find(l => l.includes(n))!;
    expect(line('liveGap')).not.toMatch(/dead-flagged|undecided/);
    expect(line('deadGap')).toContain('(dead-flagged: no callers)');
    expect(line('withheldGap')).toContain('reachability undecided');
  });
});

describe('renderHuman — the dynamic-boundary crossing reaches the terminal', () => {
  it('renders the crossing detail, from the structured boundary', () => {
    const out = renderHuman({
      ...base,
      coverageGaps: [gap()],
      confidenceBoundary: {
        knownUnknowable: [
          { kind: 'synthesized-dispatch', detail: 'a synthesized edge' },
          { kind: 'dynamic-boundary', detail: '2 dispatch site(s) the call graph cannot follow.' },
        ],
      },
    });
    expect(out).toContain('2 dispatch site(s) the call graph cannot follow.');
    // Only the dynamic-boundary crossing is surfaced here — the synthesized one has its own path.
    expect(out).not.toContain('a synthesized edge');
  });

  it('says nothing when no crossing is attached', () => {
    const out = renderHuman({ ...base, coverageGaps: [gap()] });
    expect(out).not.toMatch(/cannot follow/);
  });
});
