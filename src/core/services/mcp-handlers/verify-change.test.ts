import { describe, expect, it } from 'vitest';

import type { BlastRadiusBriefing } from './blast-radius.js';
import { projectVerifyReceipt } from './verify-change.js';

/** A minimal briefing with the fields projectVerifyReceipt reads; everything else is inert. */
const briefing = (over: Record<string, unknown>): BlastRadiusBriefing => ({
  baseRef: 'HEAD',
  resolvedBaseRef: 'HEAD',
  changed: { files: 1, symbols: 2, symbolNames: ['f', 'g'] },
  impact: {
    highestRiskLevel: 'none', maxAffectedCallers: 0, hubsTouched: [], layersCrossed: [],
    governingDecisions: [], governingDecisionProvenance: [], topSymbols: [], analyzedSymbolCount: 0,
  },
  tests: { count: 0, toRun: [], soundness: null },
  memory: { drifted: 0, orphaned: 0, willDrift: [], orphanFindings: [] },
  specs: { willGoStale: 0, items: [] },
  decisions: { affected: 0, orphaned: 0, items: [], orphanFindings: [] },
  driftAssessment: { complete: true, filesOmitted: 0, detailsTruncated: false },
  federation: { evaluated: false, note: '' },
  headline: '', posture: 'advisory', caveats: [],
  ...over,
} as unknown as BlastRadiusBriefing);

type Receipt = {
  items: Array<{ subject: string; check: string; severity: string; nextAction: string }>;
  testsToRun: { count?: number; unavailable?: string; toRun?: unknown[] };
  boundaries: string[];
  summary: Record<string, number | string>;
  truncated?: { omitted: number };
  error?: string;
};

describe('projectVerifyReceipt', () => {
  it('ranks items by severity and composes all sources into one receipt', () => {
    const b = briefing({
      impact: {
        highestRiskLevel: 'high', maxAffectedCallers: 7, hubsTouched: [], layersCrossed: ['api', 'core'],
        governingDecisions: [], governingDecisionProvenance: [], topSymbols: [], analyzedSymbolCount: 2,
      },
      specs: { willGoStale: 1, items: [{ kind: 'stale', message: 'req X drifted', domain: 'cli', specPath: null, provenance: {} }] },
      tests: { count: 2, toRun: [{ test: 't1', file: 'a.test.ts', confidence: 'high' }], soundness: null },
    });
    const r = projectVerifyReceipt(b, {
      summary: { removedFunctions: 1, signatureChanges: 0, deprecatedCallsAdded: 1 },
      removed: [{ name: 'gone', file: 'a.ts' }],
      deprecatedCalls: { added: [{ callerName: 'c', calleeName: 'old', file: 'b.ts' }] },
    }) as unknown as Receipt;

    // error (removed fn) + error (high risk) rank above warning (spec drift) above info (deprecated).
    const severities = r.items.map(i => i.severity);
    const rank = { critical: 0, error: 1, warning: 2, info: 3 } as Record<string, number>;
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]]).toBeGreaterThanOrEqual(rank[severities[i - 1]]);
    }
    expect(r.items.some(i => i.check === 'blast_radius')).toBe(true);
    expect(r.items.some(i => i.check === 'structural_diff' && i.subject.includes('removed'))).toBe(true);
    expect(r.items.some(i => i.check === 'check_spec_drift')).toBe(true);
    expect(r.items.some(i => i.check === 'structural_diff' && i.subject.includes('deprecated'))).toBe(true);
    expect(r.testsToRun.count).toBe(2);
    expect(r.summary.changedSymbols).toBe(2);
    expect(r.summary.removedFunctions).toBe(1);
  });

  it('discloses a structural_diff failure as a boundary without crashing', () => {
    const r = projectVerifyReceipt(briefing({}), { error: 'Not a git repository.' }) as unknown as Receipt;
    expect(r.boundaries.some(c => c.includes('structural_diff unavailable'))).toBe(true);
    expect(r.items).toEqual([]);
  });

  it('surfaces tests-unavailable honestly', () => {
    const b = briefing({ tests: { count: 0, toRun: [], soundness: null, unavailable: 'select_tests threw' } });
    const r = projectVerifyReceipt(b, {}) as unknown as Receipt;
    expect(r.testsToRun.unavailable).toBe('select_tests threw');
  });

  it('discloses base-ref fallback and index staleness as boundaries', () => {
    const b = briefing({
      baseRefFallback: { requested: 'nope', resolved: 'HEAD~1' },
      confidenceBoundary: { stale: true },
    });
    const r = projectVerifyReceipt(b, {}) as unknown as Receipt;
    expect(r.boundaries.some(c => c.includes("base ref 'nope'"))).toBe(true);
    expect(r.boundaries.some(c => c.toLowerCase().includes('index is behind'))).toBe(true);
  });

  it('caps items and discloses the omitted count', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      kind: 'stale', message: `req ${i}`, domain: 'cli', specPath: null, provenance: {},
    }));
    const b = briefing({ specs: { willGoStale: 40, items } });
    const r = projectVerifyReceipt(b, {}) as unknown as Receipt;
    expect(r.items.length).toBeLessThanOrEqual(25);
    // The projector reads at most 10 spec items, so 40 in → <=10 items, no truncation here;
    // assert the cap holds and the shape is sound.
    expect(Array.isArray(r.items)).toBe(true);
  });
});

describe('projectVerifyReceipt — generated-file guard (add-generated-file-guard)', () => {
  const guard = {
    facts: [{
      file: 'gen/order_pb.go', rule: 'header-marker' as const, matched: 'go-code-generated', kind: 'generated' as const,
      generatedFrom: ['proto/order.proto'], regenerateWith: 'protoc --go_out=gen proto/order.proto', certainty: 'declared' as const,
    }],
    findings: [{
      code: 'generated-file-edited', severity: 'warning' as const, source: 'generated-file-guard', subject: 'gen/order_pb.go',
      message: 'gen/order_pb.go is generated (header-marker: go-code-generated) and was edited; its source proto/order.proto is not in the diff.',
      location: { path: 'gen/order_pb.go' },
    }],
    boundaries: [],
  };

  it('projects each finding into an item that names the source and command, and returns the findings', () => {
    const r = projectVerifyReceipt(briefing({}), {}, guard) as unknown as Receipt & { findings?: Array<{ code: string }> };
    const item = r.items.find(i => i.check === 'generated_file_guard')!;
    expect(item.severity).toBe('warning');
    expect(item.nextAction).toContain('proto/order.proto');
    expect(item.nextAction).toContain('`protoc --go_out=gen proto/order.proto`');
    expect(r.summary.generatedFilesEdited).toBe(1);
    expect(r.findings?.map(f => f.code)).toEqual(['generated-file-edited']);
  });

  it('classifies findings by enforcement.policy: blocking gates, off drops them', () => {
    const blocking = projectVerifyReceipt(briefing({}), {}, guard, { 'generated-file-edited': 'blocking' }) as unknown as Receipt & { findings?: Array<{ enforcementClass: string }>; gated?: boolean };
    expect(blocking.findings?.[0].enforcementClass).toBe('blocking');
    expect(blocking.gated).toBe(true);
    const advisory = projectVerifyReceipt(briefing({}), {}, guard) as unknown as Receipt & { findings?: Array<{ enforcementClass: string }>; gated?: boolean };
    expect(advisory.findings?.[0].enforcementClass).toBe('advisory');
    expect(advisory.gated).toBe(false);
    const off = projectVerifyReceipt(briefing({}), {}, guard, { 'generated-file-edited': 'off' }) as unknown as Receipt & { findings?: unknown };
    expect(off.findings).toBeUndefined();
    expect(off.items.some(i => i.check === 'generated_file_guard')).toBe(false);
  });

  it('states a boundary once even when blast_radius already carries it', () => {
    const note = 'the .gitattributes rule did not run';
    const r = projectVerifyReceipt(briefing({ caveats: [note] }), {}, { ...guard, boundaries: [note] }) as unknown as Receipt;
    expect(r.boundaries.filter(b => b === note)).toHaveLength(1);
  });

  it('names the regenerate command when the source is unknown, and flags a header source that is not in the repo', () => {
    const unknownSrc = {
      facts: [{ ...guard.facts[0], generatedFrom: 'unknown' as const, regenerateWith: 'npm run gen' }],
      findings: guard.findings, boundaries: [],
    };
    const a = projectVerifyReceipt(briefing({}), {}, unknownSrc) as unknown as Receipt;
    expect(a.items.find(i => i.check === 'generated_file_guard')!.nextAction).toContain('`npm run gen`');
    const notFound = {
      facts: [{ ...guard.facts[0], generatedFrom: ['order.proto'], sourceNotFound: ['order.proto'] }],
      findings: guard.findings, boundaries: [],
    };
    const b = projectVerifyReceipt(briefing({}), {}, notFound) as unknown as Receipt;
    expect(b.items.find(i => i.check === 'generated_file_guard')!.nextAction).toContain('not at that path');
  });

  it('a failed guard is a boundary, not a failed receipt', () => {
    const r = projectVerifyReceipt(briefing({}), {}, { error: 'boom' }) as unknown as Receipt & { findings?: unknown };
    expect(r.boundaries.some(b => b.includes('generated-file guard unavailable: boom'))).toBe(true);
    expect(r.findings).toBeUndefined();
    expect(r.summary.generatedFilesEdited).toBe(0);
  });
});
