import { describe, it, expect } from 'vitest';
import {
  applyPolicyPrecedence,
  resolveEnforcementClass,
  normalizeEnforcementPolicy,
  unknownPolicyCodes,
  lowerLegacyBlockConfig,
  effectivePolicy,
  classifyFindings,
  isKnownFindingCode,
  sourceDefaultClass,
  FINDING_CODE_REGISTRY,
  CORPUS_INTENT_FINDING_CODES,
  type GovernanceFinding,
  type EnforcementPolicy,
} from './enforcement-policy.js';
import { CORPUS_INTENT_RULES } from '../../drift/corpus-intent-review.js';

// @ts-expect-error `warning` is the canonical spelling; legacy `warn` is rejected.
const invalidSeverity: GovernanceFinding = { code: 'x', severity: 'warn', source: 'x', subject: 'x', message: 'x' };
void invalidSeverity;

const CORPUS_DEFAULT_CLASSES = {
  'corpus-reference-unresolved': 'blocking',
  'corpus-reference-ambiguous': 'blocking',
  'corpus-self-reference': 'blocking',
  'corpus-duplicate-identifier': 'blocking',
  'corpus-edge-unsupported': 'blocking',
  'corpus-target-type-mismatch': 'blocking',
  'corpus-target-retired': 'advisory',
  'corpus-supersession-cycle': 'blocking',
  'corpus-anchor-target-missing': 'advisory',
  'corpus-reference-undeclared': 'advisory',
} as const;

describe('applyPolicyPrecedence — pure precedence core', () => {
  // Spec: off > blocking > advisory > source default. Exercises the "source default
  // is blocking" branch the registry never uses, proving precedence independently.
  it('off wins over a blocking source default (silences a would-block finding)', () => {
    expect(applyPolicyPrecedence('off', 'blocking')).toBe('off');
  });
  it('explicit blocking wins over an advisory default', () => {
    expect(applyPolicyPrecedence('blocking', 'advisory')).toBe('blocking');
  });
  it('explicit advisory wins over a blocking default', () => {
    expect(applyPolicyPrecedence('advisory', 'blocking')).toBe('advisory');
  });
  it('explicit frozen selects the baseline-ratchet class', () => {
    expect(applyPolicyPrecedence('frozen', 'advisory')).toBe('frozen');
  });
  it('absent explicit class falls through to the source default', () => {
    expect(applyPolicyPrecedence(undefined, 'blocking')).toBe('blocking');
    expect(applyPolicyPrecedence(undefined, 'advisory')).toBe('advisory');
  });
});

describe('resolveEnforcementClass', () => {
  it('an unregistered/unnamed code defaults to advisory (advisory by default)', () => {
    expect(resolveEnforcementClass('stale-decision-reference', undefined)).toBe('advisory');
    expect(resolveEnforcementClass('stale-decision-reference', {})).toBe('advisory');
  });

  it('a declared policy maps a code to its class; severity never changes the class', () => {
    const policy: EnforcementPolicy = { 'stale-decision-reference': 'blocking' };
    expect(resolveEnforcementClass('stale-decision-reference', policy, 'info')).toBe('blocking');
    expect(resolveEnforcementClass('stale-decision-reference', policy, 'error')).toBe('blocking');
  });

  it('resolution is independent of policy declaration order', () => {
    const a: EnforcementPolicy = { 'surface-critical': 'blocking', 'stale-decision-reference': 'off' };
    const b: EnforcementPolicy = { 'stale-decision-reference': 'off', 'surface-critical': 'blocking' };
    for (const code of ['surface-critical', 'stale-decision-reference']) {
      expect(resolveEnforcementClass(code, a)).toBe(resolveEnforcementClass(code, b));
    }
  });
});

describe('FINDING_CODE_REGISTRY', () => {
  it('keeps every pre-existing source advisory by default and declares complete metadata', () => {
    for (const [code, spec] of Object.entries(FINDING_CODE_REGISTRY)) {
      expect(['blocking', 'frozen', 'advisory', 'off'], code).toContain(spec.defaultClass);
      expect(spec.source, code).not.toBe('');
      expect(spec.description, code).not.toBe('');
      if (!(code in CORPUS_DEFAULT_CLASSES)) expect(spec.defaultClass, code).toBe('advisory');
    }
  });
  it('registers the stale-decision-reference code and the lowered surface codes', () => {
    for (const code of ['stale-decision-reference', 'surface-info', 'surface-warn', 'surface-critical',
      'orphans-anchored-memory', 'orphans-anchored-decision']) {
      expect(isKnownFindingCode(code)).toBe(true);
    }
    expect(sourceDefaultClass('not-a-real-code')).toBe('advisory');
  });
  it('registers the footprint-escape codes so a policy can govern them (add-footprint-escape-detection)', () => {
    for (const code of ['footprint-escape', 'footprint-escape-new-conflict', 'mis-declared-append']) {
      expect(isKnownFindingCode(code)).toBe(true);
      expect(FINDING_CODE_REGISTRY[code].source).toBe('footprint-escape');
    }
  });
  it('registers edit-verdict findings as advisory and policy-governable', () => {
    for (const code of ['edit-broken-reference', 'edit-arity-mismatch', 'edit-import-breakage']) {
      expect(FINDING_CODE_REGISTRY[code]).toMatchObject({
        source: 'edit-verdict',
        defaultClass: 'advisory',
      });
      expect(resolveEnforcementClass(code, { [code]: 'blocking' })).toBe('blocking');
    }
  });
  it('registers every corpus-integrity code with its specified source default', () => {
    for (const [code, defaultClass] of Object.entries(CORPUS_DEFAULT_CLASSES)) {
      expect(isKnownFindingCode(code), code).toBe(true);
      expect(FINDING_CODE_REGISTRY[code]).toMatchObject({
        source: 'corpus-integrity',
        defaultClass,
      });
      expect(sourceDefaultClass(code)).toBe(defaultClass);
    }
  });
  it('registers every corpus-intent finding as advisory', () => {
    expect(CORPUS_INTENT_FINDING_CODES).toHaveLength(7);
    expect(CORPUS_INTENT_FINDING_CODES).toEqual(CORPUS_INTENT_RULES.map((rule) => rule.code));
    for (const code of CORPUS_INTENT_FINDING_CODES) {
      expect(FINDING_CODE_REGISTRY[code]).toMatchObject({
        source: 'corpus-intent-review',
        defaultClass: 'advisory',
      });
      expect(isKnownFindingCode(code)).toBe(true);
    }
  });
});

describe('normalizeEnforcementPolicy — tolerant of malformed config', () => {
  it('absent block degrades to an empty policy without throwing', () => {
    expect(normalizeEnforcementPolicy(undefined)).toEqual({});
    expect(normalizeEnforcementPolicy({})).toEqual({});
  });
  it('drops entries whose value is not a valid class', () => {
    const raw = { policy: { 'stale-decision-reference': 'blocking', 'surface-critical': 'nope', x: 5 } } as never;
    expect(normalizeEnforcementPolicy(raw)).toEqual({ 'stale-decision-reference': 'blocking' });
  });
  it('accepts the categorical frozen class', () => {
    expect(normalizeEnforcementPolicy({ policy: { 'stale-decision-reference': 'frozen' } }))
      .toEqual({ 'stale-decision-reference': 'frozen' });
  });
  it('a non-object policy degrades to empty', () => {
    expect(normalizeEnforcementPolicy({ policy: [] as never })).toEqual({});
    expect(normalizeEnforcementPolicy({ policy: 'blocking' as never })).toEqual({});
  });
  it('retains an unknown code and surfaces it as a non-failing finding', () => {
    const policy = normalizeEnforcementPolicy({ policy: { 'future-code': 'blocking', 'surface-warn': 'off' } });
    expect(policy['future-code']).toBe('blocking');
    expect(unknownPolicyCodes(policy)).toEqual(['future-code']);
  });
});

describe('lowerLegacyBlockConfig — legacy block sugar lowers onto the unified policy', () => {
  it('impactCertificate.block ["critical"] lowers to surface-critical: blocking', () => {
    const lowered = lowerLegacyBlockConfig({ impactCertificate: { block: ['critical'] } });
    expect(lowered).toEqual({ 'surface-critical': 'blocking' });
  });
  it('blastRadius.block patterns lower 1:1 to their codes', () => {
    const lowered = lowerLegacyBlockConfig({ blastRadius: { block: ['orphans-anchored-decision'] } });
    expect(lowered).toEqual({ 'orphans-anchored-decision': 'blocking' });
  });
  it('a block:["critical"] config and the equivalent enforcement.policy resolve identically', () => {
    const legacy = effectivePolicy({ impactCertificate: { block: ['critical'] } });
    const explicit = effectivePolicy({ enforcement: { policy: { 'surface-critical': 'blocking' } } });
    expect(resolveEnforcementClass('surface-critical', legacy)).toBe(resolveEnforcementClass('surface-critical', explicit));
    expect(resolveEnforcementClass('surface-critical', legacy)).toBe('blocking');
  });
  it('an explicit enforcement.policy entry overrides inherited legacy sugar', () => {
    // legacy says block surface-critical; explicit policy silences it → off wins.
    const policy = effectivePolicy({
      impactCertificate: { block: ['critical'] },
      enforcement: { policy: { 'surface-critical': 'off' } },
    });
    expect(resolveEnforcementClass('surface-critical', policy)).toBe('off');
  });
});

describe('classifyFindings — one gate over one policy', () => {
  const findings: GovernanceFinding[] = [
    { code: 'stale-decision-reference', severity: 'warning', source: 'stale-decision-reference', subject: 'memory:abc1', message: 'cites retired b' },
    { code: 'surface-critical', severity: 'error', source: 'impact-certificate', subject: 'client', message: 'new path' },
  ];

  it('with no policy nothing blocks — all advisory', () => {
    const r = classifyFindings(findings, {});
    expect(r.gated).toBe(false);
    expect(r.advisory).toHaveLength(2);
    expect(r.blocking).toHaveLength(0);
  });

  it('a blocking-classed finding gates; off is listed but never gates', () => {
    const policy: EnforcementPolicy = { 'stale-decision-reference': 'blocking', 'surface-critical': 'off' };
    const r = classifyFindings(findings, policy);
    expect(r.gated).toBe(true);
    expect(r.blocking.map((f) => f.code)).toEqual(['stale-decision-reference']);
    expect(r.off.map((f) => f.code)).toEqual(['surface-critical']);
  });

  it('output is sorted by a stable key regardless of input order', () => {
    const a = classifyFindings(findings, {});
    const b = classifyFindings([...findings].reverse(), {});
    expect(a.classified.map((f) => f.subject)).toEqual(b.classified.map((f) => f.subject));
  });

  it('collapses exact duplicate emissions in every partition', () => {
    const duplicated = [findings[0]!, findings[0]!, findings[1]!];
    const r = classifyFindings(duplicated, { 'stale-decision-reference': 'frozen' });
    expect(r.classified).toHaveLength(2);
    expect(r.frozen).toHaveLength(1);
    expect(r.advisory).toHaveLength(1);
  });

  it('does not alter a finding severity', () => {
    const r = classifyFindings(findings, { 'surface-critical': 'blocking' });
    const sc = r.classified.find((f) => f.code === 'surface-critical')!;
    expect(sc.severity).toBe('error');
    expect(sc.enforcementClass).toBe('blocking');
  });

  it('partitions frozen findings without gating before baseline reconciliation', () => {
    const r = classifyFindings(findings, { 'stale-decision-reference': 'frozen' });
    expect(r.gated).toBe(false);
    expect(r.frozen.map((f) => f.code)).toEqual(['stale-decision-reference']);
  });
});
