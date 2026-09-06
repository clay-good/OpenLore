/**
 * Dynamic-boundary disclosure (change: disclose-dynamic-boundary-regions).
 *
 * The scoping and one-directionality rules, asserted against the pure helpers every conclusion
 * shares. Handler-level wiring is covered by the suites of the handlers themselves; what is checked
 * here is the contract those handlers depend on:
 *   - a traversal over a clean subgraph discloses nothing, even in a repository full of sites;
 *   - a bounded disclosure carries a truncation receipt, so it never reads as the whole set;
 *   - a qualification is scoped to what can NAME the symbol, never to the repository;
 *   - a boundary can withhold a negative claim and can never assert a positive one.
 */

import { describe, it, expect } from 'vitest';
import {
  dynamicBoundaryCrossing,
  buildQualifier,
  qualificationReason,
  recordsForFiles,
  describeSite,
  renderCrossing,
  CALLER_HIDING_KINDS,
  DYNAMIC_BOUNDARY_DISCLOSURE_CAP,
} from './dynamic-boundary-disclosure.js';
import {
  DYNAMIC_BOUNDARY_KINDS,
  buildDynamicBoundaryReport,
  type DynamicBoundaryKind,
  type DynamicBoundarySite,
  type FileDynamicBoundary,
} from '../../analyzer/dynamic-boundary.js';

function site(
  line: number,
  kind: DynamicBoundaryKind = 'reflective-invoke',
): DynamicBoundarySite {
  return { line, kind, refusal: 'no-static-target', evidence: 'getattr(o, n)()', moduleLevel: true };
}

function file(
  filePath: string,
  sites: DynamicBoundarySite[],
  language = 'Python',
): FileDynamicBoundary {
  return { filePath, language, sites };
}

const report = (files: FileDynamicBoundary[]) => buildDynamicBoundaryReport(files) ?? null;

describe('disclosure is scoped to the traversal', () => {
  it('a clean subgraph discloses nothing, in a repository with sites elsewhere', () => {
    const r = report([file('src/reflective.py', [site(10)])]);
    expect(dynamicBoundaryCrossing(r, ['src/clean.py', 'src/other.py'])).toBeUndefined();
  });

  it('a traversal crossing a site discloses its file, line and kind', () => {
    const r = report([file('src/reflective.py', [site(10, 'container-resolution')])]);
    const crossing = dynamicBoundaryCrossing(r, ['src/clean.py', 'src/reflective.py'])!;
    expect(crossing.kind).toBe('dynamic-boundary');
    expect(crossing.sites).toEqual([
      { file: 'src/reflective.py', line: 10, kind: 'container-resolution' },
    ]);
    expect(crossing.count).toBe(1);
    expect(crossing.detail).toContain('src/reflective.py:10');
  });

  it('a repository with no artifact discloses nothing', () => {
    expect(dynamicBoundaryCrossing(null, ['src/a.py'])).toBeUndefined();
  });

  it('a repeated file in the traversal is counted once', () => {
    const r = report([file('a.py', [site(1)])]);
    expect(recordsForFiles(r, ['a.py', 'a.py', 'a.py'])).toHaveLength(1);
  });
});

describe('disclosure is bounded, with a receipt', () => {
  it('sites are deduplicated by kind and file', () => {
    const r = report([file('a.py', [site(5), site(9), site(20)])]);
    const crossing = dynamicBoundaryCrossing(r, ['a.py'])!;
    // Three reflective calls in one file are ONE fact about that file — but the exact count is
    // still reported, so the dedup never understates the scale.
    expect(crossing.sites).toHaveLength(1);
    expect(crossing.sites![0].line).toBe(5); // the first, deterministically
    expect(crossing.count).toBe(3);
  });

  it('an over-bound site set is truncated and the omitted count stated', () => {
    const files = Array.from({ length: DYNAMIC_BOUNDARY_DISCLOSURE_CAP + 5 }, (_, i) =>
      file(`src/f${String(i).padStart(2, '0')}.py`, [site(i + 1)]));
    const crossing = dynamicBoundaryCrossing(report(files), files.map(f => f.filePath))!;
    expect(crossing.sites).toHaveLength(DYNAMIC_BOUNDARY_DISCLOSURE_CAP);
    expect(crossing.omittedSites).toBe(5);
    expect(crossing.detail).toContain('5 group(s) omitted');
    // The receipt is arithmetically checkable: listed + omitted equals the group total.
    expect(crossing.detail).toContain(`across ${DYNAMIC_BOUNDARY_DISCLOSURE_CAP + 5} file/kind group(s)`);
  });

  it('a fully-listed set carries no receipt', () => {
    const crossing = dynamicBoundaryCrossing(report([file('a.py', [site(1)])]), ['a.py'])!;
    expect(crossing.omittedSites).toBeUndefined();
  });

  it("a truncated file record's exact count survives into the crossing", () => {
    const r = report([{ ...file('a.py', [site(1)]), totalSites: 90, truncated: true }]);
    expect(dynamicBoundaryCrossing(r, ['a.py'])!.count).toBe(90);
  });

  it('the crossing is deterministic for the same inputs in a different order', () => {
    const files = [file('b.py', [site(2)]), file('a.py', [site(1)])];
    const one = dynamicBoundaryCrossing(report(files), ['a.py', 'b.py']);
    const two = dynamicBoundaryCrossing(report([...files].reverse()), ['b.py', 'a.py']);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('the free-text rendering comes from the structured crossing, never a parallel one', () => {
    const crossing = dynamicBoundaryCrossing(report([file('a.py', [site(1)])]), ['a.py'])!;
    expect(renderCrossing(crossing)).toBe(crossing.detail);
    expect(renderCrossing(undefined)).toBeUndefined();
  });

  it('describeSite names the kind in human terms', () => {
    expect(describeSite({ file: 'a.py', line: 3, kind: 'reflective-invoke' }))
      .toBe('a.py:3 (reflective invocation)');
    // An unrecognised kind from a newer artifact echoes rather than rendering `undefined`.
    expect(describeSite({ file: 'a.py', line: 3, kind: 'future-kind' })).toContain('future-kind');
  });
});

describe('qualification is scoped to what can NAME the symbol', () => {
  const imports = new Map<string, string[]>([
    ['src/dispatcher.py', ['src/plugins.py']],
    ['src/plugins.py', ['src/util.py']],
    ['src/unrelated.py', ['src/other.py']],
  ]);

  it('a site in the symbol\'s own file qualifies', () => {
    const qualify = buildQualifier(report([file('src/plugins.py', [site(4)])]), imports);
    expect(qualify('src/plugins.py', 'Python')?.file).toBe('src/plugins.py');
  });

  it('a site in a file that transitively imports the symbol\'s module qualifies', () => {
    const qualify = buildQualifier(report([file('src/dispatcher.py', [site(4)])]), imports);
    // dispatcher → plugins → util: every one of those can name a symbol in `util`.
    expect(qualify('src/util.py', 'Python')?.file).toBe('src/dispatcher.py');
  });

  it('a site in a module that cannot reach the symbol does NOT qualify', () => {
    const qualify = buildQualifier(report([file('src/unrelated.py', [site(4)])]), imports);
    expect(qualify('src/plugins.py', 'Python')).toBeUndefined();
  });

  it('a site in another language does not qualify — reflection does not cross a runtime', () => {
    const qualify = buildQualifier(
      report([file('src/dispatcher.py', [site(4)], 'Python')]),
      imports,
    );
    expect(qualify('src/plugins.py', 'Go')).toBeUndefined();
  });

  it('only the kinds that can hide a CALLER qualify', () => {
    for (const kind of DYNAMIC_BOUNDARY_KINDS) {
      const qualify = buildQualifier(report([file('a.py', [site(1, kind)])]), new Map());
      const qualified = !!qualify('a.py', 'Python');
      expect(qualified, `${kind} qualification`).toBe(CALLER_HIDING_KINDS.includes(kind));
    }
  });

  it('with no dependency graph, a site qualifies only within its own file', () => {
    // Narrower, which is the safe direction: a missed qualification leaves the existing
    // whole-repository caveat carrying the case; a spurious one would cry wolf everywhere.
    const qualify = buildQualifier(report([file('src/dispatcher.py', [site(4)])]), new Map());
    expect(qualify('src/dispatcher.py', 'Python')).toBeDefined();
    expect(qualify('src/util.py', 'Python')).toBeUndefined();
  });

  it('an import cycle terminates rather than looping', () => {
    const cyclic = new Map([['a.py', ['b.py']], ['b.py', ['a.py']]]);
    const qualify = buildQualifier(report([file('a.py', [site(1)])]), cyclic);
    expect(qualify('b.py', 'Python')).toBeDefined();
  });

  it('a repository with no sites builds a qualifier that never fires', () => {
    expect(buildQualifier(null, imports)('a.py', 'Python')).toBeUndefined();
    expect(buildQualifier(report([]), imports)('a.py', 'Python')).toBeUndefined();
  });

  it('the reason names the specific construct, not just "dynamic language"', () => {
    const qualify = buildQualifier(report([file('src/plugins.py', [site(42)])]), imports);
    const reason = qualificationReason(qualify('src/plugins.py', 'Python')!);
    expect(reason).toContain('src/plugins.py:42');
    expect(reason).toContain('reflective invocation');
    expect(reason).toContain('absence of a caller is not established');
  });
});

describe('the disclosure is one-directional', () => {
  it('a boundary never asserts a symbol is live, tested, or unsafe', () => {
    // Structural: the disclosure surface exposes exactly two things — a crossing that says an
    // answer is a LOWER BOUND, and a qualification that withholds a negative claim. Neither carries
    // a positive verdict, and there is no code path from a site to one.
    const crossing = dynamicBoundaryCrossing(report([file('a.py', [site(1)])]), ['a.py'])!;
    expect(crossing.detail).toContain('LOWER BOUND');
    expect(crossing.detail).not.toMatch(/\bis (live|tested|reached|unsafe)\b/);
    const reason = qualificationReason(buildQualifier(report([file('a.py', [site(1)])]), new Map())('a.py', 'Python')!);
    expect(reason).not.toMatch(/\bis (live|tested|reached|unsafe)\b/);
    expect(reason).toContain('not established');
  });
});
