import { describe, expect, it } from 'vitest';

import type { ImpactCertificate } from './impact-certificate.js';
import { buildProvenanceDocument, canonicalJson } from './change-provenance.js';

const cert = (over: Record<string, unknown> = {}): ImpactCertificate => ({
  kind: 'impact-certificate',
  version: 1,
  baseRef: 'HEAD',
  resolvedBaseRef: 'HEAD',
  change: 'working-tree',
  changed: { files: 2, symbols: 3 },
  surfaces: [],
  newlyOpenedPaths: [],
  impact: { unavailable: 'n/a' },
  tests: { unavailable: 'n/a' },
  specs: { unavailable: 'n/a' },
  lease: { anchors: [] },
  findings: [],
  highestSurfaceSeverity: 'none',
  posture: 'advisory',
  caveats: ['index is current'],
  headline: 'no new path into a declared surface',
  ...over,
} as unknown as ImpactCertificate);

const structural = { addedFunctions: 1, removedFunctions: 0, signatureChanges: 2, deprecatedCallsAdded: 0 };

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it('preserves array order and nests', () => {
    expect(canonicalJson({ xs: [3, 1, 2], o: { z: 1, a: 2 } }))
      .toBe('{"o":{"a":2,"z":1},"xs":[3,1,2]}');
  });
});

describe('buildProvenanceDocument', () => {
  it('is reproducible: same inputs produce the same digest', () => {
    const a = buildProvenanceDocument(cert(), structural);
    const b = buildProvenanceDocument(cert(), structural);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the digest changes when the change content changes', () => {
    const a = buildProvenanceDocument(cert({ changed: { files: 2, symbols: 3 } }), structural);
    const b = buildProvenanceDocument(cert({ changed: { files: 9, symbols: 9 } }), structural);
    expect(a.digest).not.toBe(b.digest);
  });

  it('carries the semantic record: structural delta, surfaces, specs, tests, boundaries', () => {
    const { predicate } = buildProvenanceDocument(cert(), structural);
    expect(predicate.schema).toBe('change-provenance/v1');
    expect(predicate.structuralDelta).toEqual(structural);
    expect(predicate.boundaries).toEqual(['index is current']);
    expect(predicate.resolvedBaseRef).toBe('HEAD');
    expect(predicate.producer).toBe('openlore');
  });

  it('propagates a disclosed base-ref fallback into the predicate', () => {
    const { predicate } = buildProvenanceDocument(
      cert({ baseRefFallback: { requested: 'nope', resolved: 'HEAD~1' } }),
      structural,
    );
    expect(predicate.baseRefFallback).toEqual({ requested: 'nope', resolved: 'HEAD~1' });
  });
});
