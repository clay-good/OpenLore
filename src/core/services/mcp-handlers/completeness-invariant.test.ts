/**
 * mcp-quality — NoCompleteBesideADisclosure (change: never-claim-complete-beside-a-refusal).
 *
 * `confidenceBoundary.complete: true` must be UNSAYABLE in the same response as a
 * disclosed refusal, cap, fallback, degradation or discarded input. Five independently
 * found instances shipped that way; this file pins each, and the structural guard below
 * is the part that matters more than the five — it fails when a NEW tool introduces a
 * disclosure-shaped field without classifying it.
 *
 * Plain `.test.ts` (NOT `.integration.test.ts`), like `tool-contract.test.ts`, so CI
 * enforces it. The per-instance checks run the real response shapes through the real
 * reconciler — exactly what `dispatchTool` does — rather than against a live
 * `.openlore/analysis` fixture, which is gitignored and absent in CI.
 */

import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISCLOSURE_CHANNELS,
  NON_DISCLOSURE_RESPONSE_FIELDS,
  assembleBoundary,
  reconcileCompleteness,
  type ConfidenceBoundary,
} from './confidence-boundary.js';
import { noPathHint } from './pathfind.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The boundary a handler assembles on a clean index with nothing crossed. */
const cleanBoundary = (): ConfidenceBoundary => assembleBoundary({});

const boundaryOf = (result: unknown): ConfidenceBoundary =>
  (result as { confidenceBoundary: ConfidenceBoundary }).confidenceBoundary;

/** Every reason text on a reconciled answer, joined — so a test can assert the cause is named. */
const whyIncomplete = (result: unknown): string =>
  (boundaryOf(result).incompleteBecause ?? []).map(r => `${r.channel}: ${r.detail}`).join(' | ');

// ===========================================================================
// The five shipped instances
// ===========================================================================

describe('NoCompleteBesideADisclosure: the five shipped instances', () => {
  it('1. verify_claim: an "unverifiable" verdict is not a complete answer', () => {
    // The shipped shape: verify_claim {"kind":"decision-current","subject":"c6d1ad07"}
    // refused ("No decision … is recorded in this repository's decision store") and
    // stamped complete: true on the refusal.
    const shipped = {
      claim: { kind: 'decision-current', subject: 'c6d1ad07' },
      verdict: 'unverifiable',
      reason: 'No decision "c6d1ad07" is recorded in this repository\'s decision store.',
      confidenceBoundary: cleanBoundary(),
    };
    expect(shipped.confidenceBoundary.complete).toBe(true); // what the handler asserts today

    const reconciled = reconcileCompleteness(shipped);
    expect(boundaryOf(reconciled).complete).toBe(false);
    expect(whyIncomplete(reconciled)).toContain('verdict');
    expect(whyIncomplete(reconciled)).toContain('refusal');
  });

  it('1b. verify_claim: a "refuted" verdict IS a complete answer (a conclusion, not a refusal)', () => {
    const refuted = {
      claim: { kind: 'decision-current', subject: 'abc12345' },
      verdict: 'refuted',
      reason: 'decision abc12345 was superseded by def67890. Cite def67890 instead.',
      confidenceBoundary: cleanBoundary(),
    };
    expect(boundaryOf(reconcileCompleteness(refuted)).complete).toBe(true);
  });

  it('2. briefing_since: a time-capped briefing is not a complete answer', () => {
    // The shipped shape: 29 of 34 files degraded to file granularity by an internal time
    // cap, and complete: true beside it.
    const shipped = {
      baseRef: 'HEAD~8',
      changedFiles: 34,
      changeGranularity: { reasons: { 'module-level-change': 3, 'parse-errors': 2, 'time-cap': 29 } },
      confidenceBoundary: cleanBoundary(),
    };
    const reconciled = reconcileCompleteness(shipped);
    expect(boundaryOf(reconciled).complete).toBe(false);
    expect(whyIncomplete(reconciled)).toContain('changeGranularity.reasons');
    expect(whyIncomplete(reconciled)).toContain('time-cap: 29');
  });

  it('2b. briefing_since: standing methodology caveats alone keep the answer complete', () => {
    // The trap this invariant must avoid: two of briefing_since's caveats are permanent
    // methodology notes. If a caveat alone flipped `complete`, the flag would be false on
    // every answer and would carry no information at all.
    const clean = assembleBoundary({ disclosures: [] });
    const answer = {
      caveats: [
        'Significance is a tier label from existing classifiers … not a weighted score.',
        'Scope is hand-authored source code: infrastructure (IaC) resources … are excluded.',
      ],
      truncation: { bounded: false, returned: 4, omitted: 0, lowestTierReached: 'ordinary-change' },
      confidenceBoundary: clean,
    };
    expect(boundaryOf(reconcileCompleteness(answer)).complete).toBe(true);
  });

  it('2c. briefing_since: an unresolved base ref is a disclosed fallback', () => {
    const unresolved = {
      baseRef: 'HEAD~8',
      baseRefFallback: { requested: 'v9.9.9', resolved: 'HEAD~1' },
      confidenceBoundary: cleanBoundary(),
    };
    const reconciled = reconcileCompleteness(unresolved);
    expect(boundaryOf(reconciled).complete).toBe(false);
    expect(whyIncomplete(reconciled)).toContain('v9.9.9');
  });

  it('3. recall: a discarded asOf filter is not a complete answer', () => {
    // The shipped shape: recall {"asOf":"not-a-commit"} disclosed the drop in `note` and
    // stamped complete: true on an answer whose requested time filter was thrown away.
    // `note` is prose the dispatch sweep deliberately does not read, so recall declares
    // the live part through assembleBoundary({ disclosures }).
    const warning = 'asOf "not-a-commit" did not resolve to a commit — ignoring it.';
    const boundary = assembleBoundary({ disclosures: [warning] });
    expect(boundary.complete).toBe(false);
    expect(boundary.incompleteBecause?.some(r => r.detail === warning)).toBe(true);

    // And a recall with nothing dropped still says complete.
    expect(assembleBoundary({ disclosures: [] }).complete).toBe(true);
  });

  it('4. find_path: a bounded no-path answer is not complete, and its hint no longer asserts disconnection', () => {
    const shipped = {
      from: 'a',
      to: 'b',
      path: null,
      noPath: { reason: 'No call path from "a" to "b" within call-distance 12.', reachedNodes: 418 },
      confidenceBoundary: cleanBoundary(),
    };
    const reconciled = reconcileCompleteness(shipped);
    expect(boundaryOf(reconciled).complete).toBe(false);
    expect(whyIncomplete(reconciled)).toContain('noPath');

    // The hint: never an assertion that the endpoints are in different components.
    const unambiguous = noPathHint('a', 'b', 1, 1, true);
    expect(unambiguous).toContain('none within the bound');
    expect(unambiguous).toContain('Not a proof that no path exists.');
    expect(unambiguous).not.toContain('different connected components');

    // With a same-name collision the ambiguity leads, because it is the likelier cause.
    const ambiguous = noPathHint('resolveCallSite', 'b', 3, 1, true);
    expect(ambiguous).toContain('matched 3 functions');
    expect(ambiguous).toContain('name::path');
    expect(ambiguous.indexOf('matched 3 functions')).toBeLessThan(ambiguous.indexOf('bounded at'));
  });

  it('4b. get_subgraph / analyze_impact: unbound call sites in scope are not a complete traversal', () => {
    const shipped = {
      nodes: [{ name: 'seed', file: 'src/a.ts' }],
      edges: [],
      ambiguousCallSites: { count: 2, note: 'Call sites the resolver refused to bind…', sample: [] },
      confidenceBoundary: cleanBoundary(),
    };
    const reconciled = reconcileCompleteness(shipped);
    expect(boundaryOf(reconciled).complete).toBe(false);
    expect(whyIncomplete(reconciled)).toContain('2 call site(s)');
  });

  it('5. find_dead_code: a filePattern matching zero files is an empty scope, not an empty result', () => {
    const shipped = {
      candidateDead: [],
      truncated: 0,
      filePatternMatch: { pattern: 'zzz-no-such-dir/', matchedFiles: 0, detail: 'matched 0 of the indexed files' },
      confidenceBoundary: cleanBoundary(),
    };
    const reconciled = reconcileCompleteness(shipped);
    expect(boundaryOf(reconciled).complete).toBe(false);
    expect(whyIncomplete(reconciled)).toContain('zzz-no-such-dir/');
    expect(whyIncomplete(reconciled)).toContain('EMPTY scope');
  });

  it('5b. find_dead_code: a filePattern that matches files keeps the answer complete', () => {
    const matched = {
      candidateDead: [],
      truncated: 0,
      filePatternMatch: { pattern: 'src/core/', matchedFiles: 141 },
      confidenceBoundary: cleanBoundary(),
    };
    expect(boundaryOf(reconcileCompleteness(matched)).complete).toBe(true);
  });
});

// ===========================================================================
// The positive case: `complete` still means something
// ===========================================================================

describe('`complete: true` is still reachable (the fix is not "always false")', () => {
  it('leaves a genuinely complete answer complete, and carries no reason', () => {
    const answer = {
      verdict: 'confirmed',
      reason: 'resolveCallSite calls safeJoin directly at src/a.ts:42.',
      receipt: { indexCommit: 'abc1234' },
      truncated: 0,
      truncation: { bounded: false, returned: 3, omitted: 0 },
      notAssessed: [],
      boundaries: [],
      confidenceBoundary: cleanBoundary(),
    };
    const reconciled = reconcileCompleteness(answer);
    expect(boundaryOf(reconciled).complete).toBe(true);
    expect(boundaryOf(reconciled).incompleteBecause).toBeUndefined();
    // Nothing fired, so the response object is returned untouched (no needless copy).
    expect(reconciled).toBe(answer);
  });

  it('does not invent a boundary on a response that carries none', () => {
    const answer = { caveats: ['a standing note'], notAssessed: ['x'] };
    expect(reconcileCompleteness(answer)).toBe(answer);
  });

  it('is idempotent — reconciling twice adds no duplicate reason', () => {
    const once = reconcileCompleteness({ verdict: 'unverifiable', confidenceBoundary: cleanBoundary() });
    const twice = reconcileCompleteness(once);
    expect(boundaryOf(twice).incompleteBecause).toEqual(boundaryOf(once).incompleteBecause);
  });

  it('does not coerce a malformed outcome from untrusted data', () => {
    const answer = {...JSON.parse('{"outcome":{"toString":"not-callable"}}'),confidenceBoundary:cleanBoundary()};
    expect(() => reconcileCompleteness(answer)).not.toThrow();
  });

  it('passes a non-object result through untouched', () => {
    expect(reconcileCompleteness('a bare string')).toBe('a bare string');
    expect(reconcileCompleteness(null)).toBe(null);
    expect(reconcileCompleteness([1, 2])).toEqual([1, 2]);
  });
});

// ===========================================================================
// Every `complete: false` names its cause
// ===========================================================================

describe('every incomplete answer names WHICH part is incomplete', () => {
  it('each registered channel, when it fires, produces a reason naming that channel', () => {
    const firingValue: Record<string, unknown> = {
      disclosures: [{code:'verification-pending',detail:'Watcher observation is missing.'}],
      outcome:'applied-pending-verification',
      verdict: 'unverifiable',
      withheld: 'shallow-history',
      unsupported: true,
      notReady: true,
      notAssessed: ['openapi.yaml'],
      boundaries: ['an external callee was not analyzed'],
      truncated: 7,
      'truncation.bounded': true,
      baseRefFallback: { requested: 'v9', resolved: 'HEAD~1' },
      'changeGranularity.reasons': { 'time-cap': 3 },
      'changeGranularity.fallbacks': [{ file: 'src/a.ts' }],
      filePatternMatch: { pattern: 'nope/', matchedFiles: 0 },
      noPath: { reason: 'none within the bound' },
      ambiguousCallSites: { count: 1 },
      staleTriggeredMemories: [{ id: 'm1' }],
      unreconciled: [{ id: 'm1' }],
      evidenceRefuted: [{ id: 'm1' }],
      evidenceUnverifiable: [{ id: 'm1' }],
      opaqueEnvSources: ['a secrets manager'],
      'partialIndex.partial': true,
    };
    // Guard the table itself: a new channel must be exercised here, not silently skipped.
    expect(Object.keys(firingValue).sort()).toEqual(DISCLOSURE_CHANNELS.map(c => c.path).sort());

    for (const channel of DISCLOSURE_CHANNELS) {
      const segments = channel.path.split('.');
      const response: Record<string, unknown> = { confidenceBoundary: cleanBoundary() };
      response[segments[0]] = segments.length === 1
        ? firingValue[channel.path]
        : { [segments[1]]: firingValue[channel.path] };

      const reconciled = reconcileCompleteness(response);
      const boundary = boundaryOf(reconciled);
      expect(boundary.complete, `${channel.path} must flip complete`).toBe(false);
      const reasons = boundary.incompleteBecause ?? [];
      expect(reasons.map(r => r.channel), `${channel.path} must name itself`).toContain(channel.path);
      for (const reason of reasons) {
        expect(reason.detail.length, `${channel.path} reason must not be empty`).toBeGreaterThan(20);
      }
    }
  });

  it('names every boundary part that made the answer incomplete, not just the first', () => {
    const boundary = assembleBoundary({
      basis: { directEdges: 1, synthesizedEdges: 2, synthesizedByRule: { 'message-topology': 2 } },
      staleness: { indexCommit: 'abc1234', filesChangedSince: 4, detail: '4 source file(s) changed since abc1234.' },
      repair: { inProgress: true, reason: 'stale-region', detail: 'A background repair is rebuilding this index.' },
      disclosures: ['asOf "nope" did not resolve to a commit — ignoring it.'],
    });
    expect(boundary.complete).toBe(false);
    expect(boundary.incompleteBecause?.map(r => r.channel)).toEqual([
      'knownUnknowable', 'staleness', 'repair', 'disclosures',
    ]);
  });

  it('merges a handler-named reason with a channel the dispatch sweep found', () => {
    const boundary = assembleBoundary({ disclosures: ['a filter was discarded'] });
    const reconciled = reconcileCompleteness({ verdict: 'unverifiable', confidenceBoundary: boundary });
    expect(boundaryOf(reconciled).incompleteBecause?.map(r => r.channel)).toEqual(['disclosures', 'verdict']);
  });

  it('ignores a blank handler-supplied disclosure rather than flipping on nothing', () => {
    expect(assembleBoundary({ disclosures: ['', '   '] }).complete).toBe(true);
  });
});

// ===========================================================================
// The structural guard: a NEW tool cannot reintroduce the defect
// ===========================================================================

/**
 * The handlers that actually assemble a `confidenceBoundary` — i.e. every handler whose
 * answer CAN violate the invariant. Derived from the sources, not listed by hand, so a
 * new boundary-carrying handler is in scope the moment it is written.
 */
async function boundaryEmittingHandlers(): Promise<Array<{ file: string; text: string }>> {
  const entries = await readdir(HERE, { withFileTypes: true });
  const out: Array<{ file: string; text: string }> = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
    if (e.name === 'confidence-boundary.ts') continue; // the registry itself
    const text = await readFile(join(HERE, e.name), 'utf-8');
    if (!text.includes('assembleBoundary(')) continue;
    out.push({ file: e.name, text });
  }
  return out;
}

/**
 * Field names that MEAN "something about this answer is incomplete". A declared response
 * field matching one of these must be classified: registered as a disclosure channel, or
 * recorded in NON_DISCLOSURE_RESPONSE_FIELDS with the reason it is not one.
 */
const DISCLOSURE_SHAPED = /^(not[A-Z]|un(assessed|supported|verifiable|reconciled|resolved|known)|withheld|truncat|omitted|degrad|capped|discarded|ignored|fallback|opaque|stale|ambiguous|boundaries|caveats|partial)/;

describe('structural guard: a disclosure-shaped response field must be classified', () => {
  it('every registered channel has a unique path of at most two segments', () => {
    const paths = DISCLOSURE_CHANNELS.map(c => c.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) {
      expect(p.split('.').length, `${p} must be depth 1 or 2 — the sweep never walks a payload`).toBeLessThanOrEqual(2);
    }
  });

  it('no field is both a channel and an excluded non-disclosure', () => {
    const channelRoots = new Set(DISCLOSURE_CHANNELS.map(c => c.path.split('.')[0]));
    const both = Object.keys(NON_DISCLOSURE_RESPONSE_FIELDS).filter(f => channelRoots.has(f) && !f.includes('.'));
    // `truncation` and `changeGranularity` are excluded as WHOLE objects while their
    // nested firing form is a channel; that is the one legal overlap, and it is explicit.
    expect(both.sort()).toEqual(['changeGranularity', 'truncation']);
  });

  it('every excluded field records WHY it is not a completeness signal', () => {
    for (const [field, why] of Object.entries(NON_DISCLOSURE_RESPONSE_FIELDS)) {
      expect(why.length, `${field} needs a reason, not an empty string`).toBeGreaterThan(20);
    }
  });

  it('no boundary-carrying handler declares a disclosure-shaped field that is unclassified', async () => {
    const classified = new Set<string>([
      ...DISCLOSURE_CHANNELS.flatMap(c => c.path.split('.')),
      ...Object.keys(NON_DISCLOSURE_RESPONSE_FIELDS),
      // The boundary's own parts. They ARE the completeness receipt, so they are already
      // derived into `complete` by assembleBoundary and need no channel.
      'basis', 'knownUnknowable', 'staleness', 'integrity', 'repair', 'incompleteBecause',
    ]);
    // Interface/type property declarations in the handler sources — the shape a tool
    // response is declared with. A new tool adding `degradedRegions` or `cappedAt` to its
    // response type fails here until it is registered as a channel or excluded with a
    // reason, which is the regression that actually matters: the sixth instance.
    const unclassified = new Map<string, string[]>();
    for (const { file, text } of await boundaryEmittingHandlers()) {
      for (const match of text.matchAll(/^\s{2}(?:readonly\s+)?([a-z][A-Za-z0-9]*)\??:/gm)) {
        const field = match[1];
        if (!DISCLOSURE_SHAPED.test(field) || classified.has(field)) continue;
        const seen = unclassified.get(field) ?? [];
        if (!seen.includes(file)) seen.push(file);
        unclassified.set(field, seen);
      }
    }
    expect(
      [...unclassified].map(([f, files]) => `${f} (${files.join(', ')})`).sort(),
      'Classify each field in DISCLOSURE_CHANNELS or NON_DISCLOSURE_RESPONSE_FIELDS (confidence-boundary.ts)',
    ).toEqual([]);
  });

  it('the dispatch boundary applies the reconciler to every tool result', async () => {
    // The invariant is worth only as much as its single application point. If
    // `dispatchTool` stops funnelling results through `reconcileCompleteness`, a tool can
    // claim a complete answer beside a disclosure again, and no per-tool test would show
    // it — so the funnel itself is asserted here.
    const dispatch = await readFile(join(HERE, '..', 'tool-dispatch.ts'), 'utf-8');
    expect(dispatch).toContain('reconcileCompleteness');
    expect(dispatch).toMatch(/return reconcileCompleteness\(/);
  });
});

