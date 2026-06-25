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
  type GovernanceFinding,
  type EnforcementPolicy,
} from './enforcement-policy.js';

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
  it('every registered code defaults to advisory (blocking is always opt-in)', () => {
    for (const spec of Object.values(FINDING_CODE_REGISTRY)) {
      expect(spec.defaultClass).toBe('advisory');
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
    { code: 'stale-decision-reference', severity: 'warn', source: 'stale-decision-reference', subject: 'memory:abc1', message: 'cites retired b' },
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

  it('does not alter a finding severity', () => {
    const r = classifyFindings(findings, { 'surface-critical': 'blocking' });
    const sc = r.classified.find((f) => f.code === 'surface-critical')!;
    expect(sc.severity).toBe('error');
    expect(sc.enforcementClass).toBe('blocking');
  });
});
