import { describe, expect, it } from 'vitest';

import type { ImpactCertificate } from './impact-certificate.js';
import { buildProvenanceDocument, canonicalJson, validateInTotoStatement, IN_TOTO_STATEMENT_CHECK, PROVENANCE_PREDICATE_TYPE } from './change-provenance.js';

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

/**
 * The in-toto Statement v1 envelope we emit is checked structurally, locally (change:
 * add-change-provenance-certificate). SHAPE ONLY: the check proves nothing about a signature, the
 * predicate's fields, or whether the subject digest identifies an artifact.
 */
const statement = (over: Record<string, unknown> = {}): unknown => ({
  _type: 'https://in-toto.io/Statement/v1',
  subject: [{ name: 'HEAD..working-tree', digest: { sha256: 'a'.repeat(64) } }],
  predicateType: PROVENANCE_PREDICATE_TYPE,
  predicate: { producer: 'openlore' },
  ...over,
});
const reason = (s: unknown): string => validateInTotoStatement(s).join(' | ');

describe('validateInTotoStatement', () => {
  it('accepts the envelope shape we emit', () => {
    expect(validateInTotoStatement(statement())).toEqual([]);
  });

  it('accepts a known non-sha256 algorithm at its own length, and several subjects', () => {
    expect(validateInTotoStatement(statement({
      subject: [
        { name: 'a', digest: { sha512: 'b'.repeat(128) } },
        { name: 'b', digest: { sha1: 'c'.repeat(40), sha256: 'd'.repeat(64) } },
      ],
    }))).toEqual([]);
  });

  it('leaves an algorithm of unknown output size unchecked for length rather than guessing', () => {
    expect(validateInTotoStatement(statement({ subject: [{ name: 'a', digest: { blake2b: 'e'.repeat(13) } }] }))).toEqual([]);
  });

  it('names a missing _type', () => {
    const s = statement() as Record<string, unknown>;
    delete s._type;
    expect(reason(s)).toContain('`_type` is missing');
  });

  it('names a wrong _type (an older or invented statement type)', () => {
    expect(reason(statement({ _type: 'https://in-toto.io/Statement/v0.1' }))).toContain('`_type` is not "https://in-toto.io/Statement/v1"');
  });

  it('names an empty subject array', () => {
    expect(reason(statement({ subject: [] }))).toContain('`subject` is an empty array');
  });

  it('names a subject with no name', () => {
    expect(reason(statement({ subject: [{ digest: { sha256: 'a'.repeat(64) } }] }))).toContain('subject[0] has no `name` string');
  });

  it('names an uppercase digest', () => {
    expect(reason(statement({ subject: [{ name: 'a', digest: { sha256: 'A'.repeat(64) } }] }))).toContain('subject[0].digest.sha256 is not lowercase hex');
  });

  it('names a short digest against its algorithm length', () => {
    expect(reason(statement({ subject: [{ name: 'a', digest: { sha256: 'a'.repeat(63) } }] }))).toContain('subject[0].digest.sha256 is 63 hex chars, not 64');
  });

  it('names a non-object predicate', () => {
    expect(reason(statement({ predicate: 'nope' }))).toContain('`predicate` is not a JSON object (got string)');
    expect(reason(statement({ predicate: [1] }))).toContain('`predicate` is not a JSON object (got array)');
    expect(reason(statement({ predicate: null }))).toContain('`predicate` is not a JSON object (got null)');
  });

  it('names a missing or empty predicateType', () => {
    const s = statement() as Record<string, unknown>;
    delete s.predicateType;
    expect(reason(s)).toContain('`predicateType` is missing');
    expect(reason(statement({ predicateType: '' }))).toContain('`predicateType` is empty');
  });

  it('rejects a non-object statement without throwing', () => {
    expect(reason(null)).toContain('statement is not a JSON object (got null)');
    expect(reason([statement()])).toContain('statement is not a JSON object (got array)');
    expect(reason('x')).toContain('statement is not a JSON object (got string)');
  });

  it('is bounded on hostile input: 10,000 bad subjects, a 128 KB field, a deeply nested predicate', () => {
    const many = Array.from({ length: 10_000 }, () => ({ digest: { sha256: 'Z' } }));
    const started = Date.now();
    const reasons = validateInTotoStatement(statement({ subject: many }));
    expect(Date.now() - started).toBeLessThan(2_000);
    // Capped, and the cap is disclosed — silence is never reported as cleanliness.
    expect(reasons.length).toBeLessThanOrEqual(21);
    expect(reasons[reasons.length - 1]).toContain('not listed');

    const big = 'x'.repeat(128 * 1024);
    expect(validateInTotoStatement(statement({ subject: [{ name: big, digest: { sha256: 'a'.repeat(64) } }] }))).toEqual([]);
    expect(reason(statement({ subject: [{ name: 'a', digest: { sha256: big } }] }))).toContain('is not lowercase hex');

    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 50_000; i++) deep = { deep };
    expect(validateInTotoStatement(statement({ predicate: deep }))).toEqual([]);
  });

  it('exposes the check under a stable name, so the receipt cannot drift from the checker', () => {
    expect(IN_TOTO_STATEMENT_CHECK).toBe('in-toto-statement-v1-structural');
  });
});
