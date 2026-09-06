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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DYNAMIC_BOUNDARY } from '../../../constants.js';
import {
  dynamicBoundaryCrossing,
  buildQualifier,
  qualificationReason,
  recordsForFiles,
  describeSite,
  CALLER_HIDING_KINDS,
  DYNAMIC_BOUNDARY_DISCLOSURE_CAP,
  loadDynamicBoundaryReport,
  __resetDynamicBoundaryMemo,
} from './dynamic-boundary-disclosure.js';
import {
  DYNAMIC_BOUNDARY_KINDS,
  DYNAMIC_BOUNDARY_SCHEMA_VERSION,
  buildDynamicBoundaryReport,
  type DynamicBoundaryKind,
  type DynamicBoundarySite,
  type FileDynamicBoundary,
} from '../../analyzer/dynamic-boundary.js';

function site(
  line: number,
  kind: DynamicBoundaryKind = 'reflective-invoke',
): DynamicBoundarySite {
  return { line, kind, refusal: 'no-static-target', evidence: 'getattr(o, n)()', unattributed: true };
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

  it('a free-text surface has one sentence to render, carried on the crossing itself', () => {
    // `analyze_error_propagation` and `change_impact_certificate` push `crossing.detail` into their
    // own disclosure lists rather than assembling a second sentence, so the two cannot diverge.
    const crossing = dynamicBoundaryCrossing(report([file('a.py', [site(1)])]), ['a.py'])!;
    expect(crossing.detail).toContain('a.py:1');
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

  it('only the kinds that can hide a CALLER qualify, and only in their own file', () => {
    for (const kind of DYNAMIC_BOUNDARY_KINDS) {
      const qualify = buildQualifier(report([file('a.py', [site(1, kind)])]), new Map());
      const qualified = !!qualify('a.py', 'Python');
      expect(qualified, `${kind} qualification`).toBe(CALLER_HIDING_KINDS.includes(kind));
    }
  });

  it('a computed member reaches only its own file — its receiver is a local expression', () => {
    // Measured on this repository: two `paint[r.status](…)`-style lookups in one CLI file
    // qualified 431 of 845 files through the import closure and moved 505 dead-flagged coverage
    // gaps to "undecided", on the strength of a colour table that can reach none of them.
    const reaching = new Map([['src/doctor.ts', ['src/other.ts']]]);
    const computed = buildQualifier(
      report([file('src/doctor.ts', [site(7, 'computed-member')], 'Python')]), reaching,
    );
    expect(computed('src/doctor.ts', 'Python'), 'its own file still qualifies').toBeDefined();
    expect(computed('src/other.ts', 'Python'), 'an imported file must not').toBeUndefined();

    // A reflective invoke DOES reach: its receiver is a parameter that can hold anything.
    const reflective = buildQualifier(
      report([file('src/doctor.ts', [site(7, 'reflective-invoke')], 'Python')]), reaching,
    );
    expect(reflective('src/other.ts', 'Python')).toBeDefined();
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

describe('the loader fails open on anything it cannot trust', () => {
  let root: string;

  async function write(body: unknown): Promise<void> {
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_DYNAMIC_BOUNDARY),
      typeof body === 'string' ? body : JSON.stringify(body));
    __resetDynamicBoundaryMemo();
  }
  const load = () => loadDynamicBoundaryReport(root);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-dyn-load-'));
    __resetDynamicBoundaryMemo();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('an absent artifact is no boundary, not an error', async () => {
    expect(await load()).toBeNull();
  });

  it('malformed JSON, a wrong shape, and a null record all fail open', async () => {
    // A DISCLOSURE sidecar must never be able to take down the conclusions it exists to annotate:
    // seven handlers read this file on the serving path.
    for (const body of ['not json', '[]', '{}', { files: 'no' }, { version: 1, files: [null] }]) {
      await write(body);
      expect(await load()).toBeNull();
    }
  });

  it('a record missing a field it would RENDER is dropped, not printed as undefined', async () => {
    await write({ version: 1, files: [{ filePath: 'a.py', language: 'Python', sites: [{ line: 1, kind: 'reflective-invoke' }] }] });
    expect(await load()).toBeNull(); // no `refusal` — it is rendered, so it is required
  });

  it('a record whose kind or refusal is not in the closed vocabulary is dropped', async () => {
    // `typeof === 'string'` is not enough: `"constructor"` and `"toString"` resolve off
    // `Object.prototype` in the label lookups, so the `??` fallback never fires and the disclosure
    // renders a native function into a sentence an agent reads.
    const bad = (over: Record<string, unknown>) => ({
      filePath: 'a.py', language: 'Python',
      sites: [{ line: 1, kind: 'reflective-invoke', refusal: 'no-static-target', evidence: 'x', ...over }],
    });
    for (const over of [{ kind: 'constructor' }, { refusal: 'toString' }, { line: '1' }]) {
      await write({ version: DYNAMIC_BOUNDARY_SCHEMA_VERSION, files: [bad(over)] });
      expect(await load(), JSON.stringify(over)).toBeNull();
    }
  });

  it('a totalSites that is not a plausible integer is refused, not summed into a count', async () => {
    // It is rendered into a sentence a human reads: `"09"`, `1e308` and an object each turn the
    // count into a string, an infinity, or "0[object Object]".
    for (const totalSites of ['09', 1e308, -5, {}, 0.5]) {
      await write({
        version: DYNAMIC_BOUNDARY_SCHEMA_VERSION,
        files: [{
          filePath: 'a.py', language: 'Python',
          sites: [{ line: 1, kind: 'reflective-invoke', refusal: 'no-static-target', evidence: 'x' }],
          totalSites,
        }],
      });
      expect(await load(), `totalSites ${JSON.stringify(totalSites)}`).toBeNull();
    }
  });

  it('a stale schema version is refused rather than served as current', async () => {
    const record = {
      filePath: 'a.py', language: 'Python',
      sites: [{ line: 1, kind: 'reflective-invoke', refusal: 'no-static-target', evidence: 'x' }],
    };
    await write({ version: 999, files: [record] });
    expect(await load()).toBeNull();
    await write({ version: DYNAMIC_BOUNDARY_SCHEMA_VERSION, files: [record] });
    expect((await load())?.files).toHaveLength(1);
  });

  it('one bad record does not discard its valid siblings', async () => {
    await write({
      version: DYNAMIC_BOUNDARY_SCHEMA_VERSION,
      files: [
        null,
        { filePath: 'ok.py', language: 'Python', sites: [{ line: 2, kind: 'reflective-invoke', refusal: 'no-static-target', evidence: 'x' }] },
      ],
    });
    expect((await load())?.files.map(f => f.filePath)).toEqual(['ok.py']);
  });

  it('the report is memoized per directory and released by the reset hook', async () => {
    const record = {
      filePath: 'a.py', language: 'Python',
      sites: [{ line: 1, kind: 'reflective-invoke', refusal: 'no-static-target', evidence: 'x' }],
    };
    await write({ version: DYNAMIC_BOUNDARY_SCHEMA_VERSION, files: [record] });
    const first = await load();
    expect(first?.files).toHaveLength(1);
    // Rewritten underneath, but inside the memo window: the composed handlers of one briefing must
    // not each re-read and re-parse it.
    await writeFile(
      join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DYNAMIC_BOUNDARY),
      JSON.stringify({ version: DYNAMIC_BOUNDARY_SCHEMA_VERSION, files: [] }),
    );
    expect(await loadDynamicBoundaryReport(root)).toBe(first);
    // A later call past the window re-reads.
    expect(await loadDynamicBoundaryReport(root, Date.now() + 60_000)).toBeNull();
  });
});

describe('a qualification never renders a missing value', () => {
  it('an unrecognised refusal echoes rather than printing undefined', () => {
    const reason = qualificationReason({
      file: 'a.py',
      site: { line: 3, kind: 'reflective-invoke', refusal: 'future-reason' as never, evidence: 'x' },
    });
    expect(reason).toContain('future-reason');
    expect(reason).not.toContain('undefined');
  });
});


describe('a repository-controlled value cannot forge an output line', () => {
  it('a newline in a file path is stripped before it is rendered', () => {
    // File names may legally contain a newline, and `.openlore/` is repository-controlled. The CLI
    // writer keeps newlines because it treats its input as an OpenLore-authored MESSAGE; a newline
    // in a VALUE inside that message forges an extra terminal line — a forged "all clear" printed
    // under a warning block.
    const forged = 'a.py\n   OK: nothing else reaches these symbols';
    const crossing = dynamicBoundaryCrossing(
      report([{ filePath: forged, language: 'Python', sites: [site(1)] }]), [forged],
    )!;
    expect(crossing.detail).not.toContain('\n');
    expect(crossing.detail).toContain('OK: nothing else reaches these symbols'); // inert, one line
    expect(describeSite({ file: forged, line: 1, kind: 'reflective-invoke' })).not.toContain('\n');
  });

  it('a prototype-chain key never renders as a native function', () => {
    // `kind: "constructor"` resolves off `Object.prototype`, so a `??` fallback never fires and the
    // disclosure would render `function Object() { [native code] }` to an agent.
    expect(describeSite({ file: 'a.py', line: 1, kind: 'constructor' }))
      .not.toContain('native code');
    expect(qualificationReason({
      file: 'a.py',
      site: { line: 1, kind: 'constructor' as never, refusal: 'toString' as never, evidence: 'x' },
    })).not.toContain('native code');
  });
});
