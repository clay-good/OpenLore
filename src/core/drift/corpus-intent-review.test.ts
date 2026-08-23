import { describe, expect, it } from 'vitest';
import {
  CORPUS_INTENT_RULES,
  CORPUS_INTENT_SOURCE_FIELDS,
  reviewCorpusIntent,
  type CorpusIntentCode,
} from './corpus-intent-review.js';

function spec(requirements: Array<{ name: string; text: string; scenarios?: string[] }>): string {
  return `# Test\n\n## Requirements\n\n${requirements.map((requirement) => `### Requirement: ${requirement.name}\n\n${requirement.text}\n\n${(requirement.scenarios ?? ['works']).map((name) => `#### Scenario: ${name}\n- **GIVEN** a state\n- **WHEN** it runs\n- **THEN** the result is ${name}`).join('\n\n')}`).join('\n\n')}`;
}

function files(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function codes(result: ReturnType<typeof reviewCorpusIntent>): CorpusIntentCode[] {
  return result.findings.map((finding) => finding.code);
}

describe('CORPUS_INTENT_RULES', () => {
  it('is a closed table containing exactly the seven declared finding codes', () => {
    expect(CORPUS_INTENT_RULES.map((rule) => rule.code)).toEqual([
      'corpus-normative-weakened',
      'corpus-scenario-removed',
      'corpus-requirement-removed',
      'corpus-specificity-lost',
      'corpus-boundary-clause-removed',
      'corpus-decision-status-regressed',
      'corpus-delta-orphaned',
    ]);
    const fields = new Set(CORPUS_INTENT_SOURCE_FIELDS);
    expect(CORPUS_INTENT_RULES.every((rule) =>
      rule.sourceFields.length > 0 && rule.sourceFields.every((field) => fields.has(field))))
      .toBe(true);
  });
});

describe('reviewCorpusIntent', () => {
  it('reports a normative rank drop but not an equal-strength SHALL to MUST edit', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Auth', text: 'The system SHALL reject invalid input.' }]) });
    const weakened = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Auth', text: 'The system SHOULD reject invalid input.' }]) });
    const equal = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Auth', text: 'The system MUST reject invalid input.' }]) });

    expect(codes(reviewCorpusIntent(base, weakened))).toEqual(['corpus-normative-weakened']);
    expect(reviewCorpusIntent(base, equal).findings).toEqual([]);
  });

  it('reports removed scenarios on an exact-name requirement match', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Auth', text: 'The system SHALL authenticate.', scenarios: ['password', 'token', 'key'] }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Auth', text: 'The system SHALL authenticate.', scenarios: ['password'] }]) });

    const result = reviewCorpusIntent(base, head);
    expect(codes(result)).toEqual(['corpus-scenario-removed']);
    expect(result.findings[0].baseValue).toEqual(['key', 'token']);
  });

  it('does not report a scenario rename when the scenario count is unchanged', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Auth', text: 'The system SHALL authenticate.', scenarios: ['password', 'token'] }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Auth', text: 'The system SHALL authenticate.', scenarios: ['password', 'api token'] }]) });

    expect(codes(reviewCorpusIntent(base, head))).not.toContain('corpus-scenario-removed');
  });

  it('matches a rename by a unique identical scenario set and does not report removal', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'OldName', text: 'The system SHALL authenticate.', scenarios: ['password', 'token'] }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{ name: 'NewName', text: 'The system SHALL authenticate.', scenarios: ['token', 'password'] }]) });

    expect(reviewCorpusIntent(base, head).findings).toEqual([]);
  });

  it('does not guess an ambiguous scenario-set rename', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'OldName', text: 'The system SHALL authenticate.', scenarios: ['same'] }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([
      { name: 'CandidateA', text: 'The system SHALL authenticate.', scenarios: ['same'] },
      { name: 'CandidateB', text: 'The system SHALL authenticate.', scenarios: ['same'] },
    ]) });

    expect(codes(reviewCorpusIntent(base, head))).toEqual(['corpus-requirement-removed']);
  });

  it('reserves exact-name matches before considering scenario-set renames', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([
      { name: 'Removed', text: 'The system SHALL do A.', scenarios: ['shared'] },
      { name: 'Kept', text: 'The system SHALL do B.', scenarios: ['old'] },
    ]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([
      { name: 'Kept', text: 'The system SHALL do B.', scenarios: ['shared'] },
    ]) });

    const result = reviewCorpusIntent(base, head);
    expect(result.findings.filter((finding) => finding.code === 'corpus-requirement-removed'))
      .toMatchObject([{ requirement: 'Removed' }]);
  });

  it('does not claim rename continuity when the base scenario set is also ambiguous', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([
      { name: 'OldA', text: 'The system SHALL do A.', scenarios: ['same'] },
      { name: 'OldB', text: 'The system SHALL do B.', scenarios: ['same'] },
    ]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([
      { name: 'New', text: 'The system SHALL do something.', scenarios: ['same'] },
    ]) });

    expect(reviewCorpusIntent(base, head).findings
      .filter((finding) => finding.code === 'corpus-requirement-removed'))
      .toHaveLength(2);
  });

  it('reports lost numeric, enumerated-set, and named-threshold specificity', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Budget', text: 'The system SHALL finish within 200 ms, return one of `fresh`, `stale`, or `missing`, and obey `QUERY_BUDGET_THRESHOLD`.' }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Budget', text: 'The system SHALL finish quickly and return a useful state.' }]) });

    const result = reviewCorpusIntent(base, head);
    expect(codes(result)).toEqual(['corpus-specificity-lost']);
    expect(result.findings[0].baseValue).toEqual([
      '200 ms',
      'one of `fresh`, `stale`, or `missing`',
      '`QUERY_BUDGET_THRESHOLD`',
    ]);
  });

  it('reports a lost percentage but ignores ordinary identifier fragments', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{
      name: 'Coverage',
      text: 'The system SHALL cover 25% of requests using `capabilityRegistry` and `budgetingMode`.',
    }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{
      name: 'Coverage',
      text: 'The system SHALL cover many requests using `replacementRegistry`.',
    }]) });

    const result = reviewCorpusIntent(base, head);
    expect(codes(result)).toEqual(['corpus-specificity-lost']);
    expect(result.findings[0].baseValue).toEqual(['25%']);
  });

  it('canonicalizes unit formatting and recognizes plain sets and named thresholds', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{
      name: 'Policy',
      text: 'The system SHALL respond within 200 ms, choose one of accepted, rejected, or pending, and obey the threshold named maxRetries.',
    }]) });
    const equivalent = files({ 'openspec/specs/api/spec.md': spec([{
      name: 'Policy',
      text: 'The system SHALL respond within 200MS, choose one of accepted, rejected, or pending, and obey the threshold named maxRetries.',
    }]) });
    const weakened = files({ 'openspec/specs/api/spec.md': spec([{
      name: 'Policy',
      text: 'The system SHALL respond promptly with a valid choice and retry as needed.',
    }]) });

    expect(codes(reviewCorpusIntent(base, equivalent))).not.toContain('corpus-specificity-lost');
    expect(codes(reviewCorpusIntent(base, weakened))).toContain('corpus-specificity-lost');
  });

  it('recognizes a two-member plain enumerated set', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'State', text: 'The system SHALL be one of accepted or rejected.' }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{ name: 'State', text: 'The system SHALL be valid.' }]) });
    expect(codes(reviewCorpusIntent(base, head))).toContain('corpus-specificity-lost');
  });

  it('reports removal of a disclosed-boundary or honesty clause', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Honesty', text: 'The system SHALL return results. The system SHALL disclose truncated regions. The system SHALL NOT claim completeness.' }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Honesty', text: 'The system SHALL return results.' }]) });

    const result = reviewCorpusIntent(base, head);
    expect(codes(result)).toEqual(['corpus-boundary-clause-removed']);
    expect(result.findings[0].baseValue).toEqual([
      'The system SHALL NOT claim completeness.',
      'The system SHALL disclose truncated regions.',
    ]);
  });

  it('does not treat an ordinary reporting obligation as a boundary clause', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Report', text: 'The system SHALL report test results.' }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Report', text: 'The system SHALL return test results.' }]) });

    expect(codes(reviewCorpusIntent(base, head))).not.toContain('corpus-boundary-clause-removed');
  });

  it('does not report a retained boundary obligation with added detail', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Honesty', text: 'The system SHALL disclose truncated regions.' }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Honesty', text: 'The system SHALL disclose truncated regions to callers.' }]) });

    expect(codes(reviewCorpusIntent(base, head))).not.toContain('corpus-boundary-clause-removed');
  });

  it('recognizes a retained boundary obligation with modifiers', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Honesty', text: 'The system SHALL disclose truncated regions.' }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Honesty', text: 'The system SHALL clearly disclose all truncated regions.' }]) });

    expect(codes(reviewCorpusIntent(base, head))).not.toContain('corpus-boundary-clause-removed');
  });

  it('preserves multiplicity for distinct boundary obligations', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{
      name: 'Honesty',
      text: 'The system SHALL disclose unsupported languages. The system SHALL disclose unsupported frameworks.',
    }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{
      name: 'Honesty',
      text: 'The system SHALL disclose unsupported languages.',
    }]) });

    expect(codes(reviewCorpusIntent(base, head))).toContain('corpus-boundary-clause-removed');
  });

  it('reports an authoritative decision status regression without a superseder', () => {
    const base = files({ 'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\naccepted\n' });
    const head = files({ 'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\nrejected\n' });

    expect(codes(reviewCorpusIntent(base, head))).toEqual(['corpus-decision-status-regressed']);
  });

  it('accepts a decision regression when an active decision explicitly supersedes it', () => {
    const base = files({ 'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\naccepted\n' });
    const head = files({
      'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\nrejected\n',
      'openspec/decisions/adr-0002-replacement.md': '# ADR-0002: Replacement\n\n## Status\n\naccepted\n\nSupersedes: ADR-0001\n',
    });

    expect(reviewCorpusIntent(base, head).findings).toEqual([]);
  });

  it('does not accept supersession text embedded in ordinary prose', () => {
    const base = files({ 'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\naccepted\n' });
    const head = files({
      'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\nrejected\n',
      'openspec/decisions/adr-0002-example.md': '# ADR-0002: Example\n\n## Status\n\naccepted\n\nA malformed example says Supersedes: ADR-0001 but does not.\n',
    });

    expect(codes(reviewCorpusIntent(base, head))).toEqual(['corpus-decision-status-regressed']);
  });

  it('ignores decision metadata forged inside fences and HTML comments', () => {
    const base = files({
      'openspec/decisions/adr-0001-choice.md': '# Choice\n\n## Status\n\naccepted\n\n> Decision ID: stableid\n',
    });
    const head = files({
      'openspec/decisions/adr-0001-choice.md':
        '```markdown\n## Status\n\naccepted\n> Decision ID: forged\nSupersedes: ADR-0001\n```\n' +
        '<!--\n## Status\naccepted\n> Decision ID: hidden\n-->\n' +
        '# Choice\n\n## Status\n\nrejected\n\n> Decision ID: stableid\n',
    });
    expect(codes(reviewCorpusIntent(base, head))).toEqual(['corpus-decision-status-regressed']);
  });

  it('does not treat a fence-marker content line as a closing fence', () => {
    const base = files({
      'openspec/decisions/adr-0001-choice.md': '# Choice\n\n## Status\n\naccepted\n',
    });
    const head = files({
      'openspec/decisions/adr-0001-choice.md':
        '```markdown\n```still-code\n## Status\n\naccepted\n```\n# Choice\n\n## Status\n\nrejected\n',
    });
    expect(codes(reviewCorpusIntent(base, head))).toEqual(['corpus-decision-status-regressed']);
  });

  it('matches decision continuity by artifact when an explicit ID is removed', () => {
    const base = files({
      'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\naccepted\n\n> Decision ID: abcdef12\n',
    });
    const head = files({
      'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\nrejected\n',
    });

    expect(codes(reviewCorpusIntent(base, head))).toEqual(['corpus-decision-status-regressed']);
  });

  it('prefers stable decision identity over a reused artifact path', () => {
    const base = files({
      'openspec/decisions/adr-0001-old.md': '# Old\n\n## Status\n\naccepted\n\n> Decision ID: oldid\n',
    });
    const head = files({
      'openspec/decisions/adr-0003-old.md': '# Old moved\n\n## Status\n\naccepted\n\n> Decision ID: oldid\n',
      'openspec/decisions/adr-0001-old.md': '# Replacement\n\n## Status\n\nrejected\n\n> Decision ID: newid\n',
    });

    expect(codes(reviewCorpusIntent(base, head))).not.toContain('corpus-decision-status-regressed');
  });

  it('accepts a legacy reciprocal superseded-by record when the named ADR is authoritative', () => {
    const base = files({
      'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\naccepted\n\n> Decision ID: oldhash1\n',
    });
    const head = files({
      'openspec/decisions/adr-0001-choice.md': '# ADR-0001: Choice\n\n## Status\n\nsuperseded by ADR-0002\n\n> Decision ID: oldhash1\n',
      'openspec/decisions/adr-0002-replacement.md': '# ADR-0002: Replacement\n\n## Status\n\naccepted\n\n> Decision ID: newhash2\n',
    });

    expect(reviewCorpusIntent(base, head).findings).toEqual([]);
  });

  it('reports a head delta whose MODIFIED target disappeared from the main corpus', () => {
    const base = files({
      'openspec/specs/api/spec.md': spec([{ name: 'Existing', text: 'The system SHALL work.' }]),
      'openspec/changes/change/specs/api/spec.md': '## MODIFIED Requirements\n\n### Requirement: Existing\n\nThe system SHALL work.\n',
    });
    const head = files({
      'openspec/specs/api/spec.md': spec([{ name: 'Other', text: 'The system SHALL work.', scenarios: ['other'] }]),
      'openspec/changes/change/specs/api/spec.md': '## MODIFIED Requirements\n\n### Requirement: Existing\n\nThe system SHALL work.\n',
    });

    expect(codes(reviewCorpusIntent(base, head))).toContain('corpus-delta-orphaned');
  });

  it('does not report a pre-existing orphan as a between-revision disappearance', () => {
    const delta = '## MODIFIED Requirements\n\n### Requirement: NeverExisted\n\nThe system SHALL work.\n';
    const base = files({
      'openspec/specs/api/spec.md': spec([{ name: 'Other', text: 'The system SHALL work.' }]),
      'openspec/changes/change/specs/api/spec.md': delta,
    });
    const head = files({
      'openspec/specs/api/spec.md': spec([{ name: 'Other', text: 'The system SHALL work.' }]),
      'openspec/changes/change/specs/api/spec.md': delta,
    });

    expect(codes(reviewCorpusIntent(base, head))).not.toContain('corpus-delta-orphaned');
  });

  it('scopes orphaned delta targets to their spec domain', () => {
    const base = files({
      'openspec/specs/api/spec.md': spec([{ name: 'SharedName', text: 'The system SHALL expose an API.' }]),
      'openspec/specs/cli/spec.md': spec([{ name: 'SharedName', text: 'The system SHALL expose a CLI.' }]),
    });
    const head = files({
      'openspec/specs/api/spec.md': spec([{ name: 'Other', text: 'The system SHALL expose an API.' }]),
      'openspec/specs/cli/spec.md': spec([{ name: 'SharedName', text: 'The system SHALL expose a CLI.' }]),
      'openspec/changes/change/specs/api/spec.md':
        '## MODIFIED Requirements\n\n### Requirement: SharedName\n\nThe system SHALL expose an API.\n',
    });

    expect(codes(reviewCorpusIntent(base, head))).toContain('corpus-delta-orphaned');
  });

  it('does not report requirement removal when an archived REMOVED delta records it', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Retired', text: 'The system SHALL work.' }]) });
    const head = files({
      'openspec/specs/api/spec.md': spec([{ name: 'Other', text: 'The system SHALL work.' }]),
      'openspec/changes/archive/2026-08-23-retire/specs/api/spec.md':
        '## REMOVED Requirements\n\n### Requirement: Retired\n\nThe system SHALL work.\n',
    });

    expect(codes(reviewCorpusIntent(base, head))).not.toContain('corpus-requirement-removed');
  });

  it('does not let a historical archive record hide a later removal', () => {
    const archive = '## REMOVED Requirements\n\n### Requirement: Retired\n\nThe system SHALL work.\n';
    const base = files({
      'openspec/specs/api/spec.md': spec([{ name: 'Retired', text: 'The system SHALL work.' }]),
      'openspec/changes/archive/2026-01-01-old-retirement/specs/api/spec.md': archive,
    });
    const head = files({
      'openspec/specs/api/spec.md': spec([{ name: 'Other', text: 'The system SHALL work.', scenarios: ['other'] }]),
      'openspec/changes/archive/2026-01-01-old-retirement/specs/api/spec.md': archive,
    });

    expect(codes(reviewCorpusIntent(base, head))).toContain('corpus-requirement-removed');
  });

  it('does not let a fenced archive example forge a removal record', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{ name: 'Critical', text: 'The system SHALL work.' }]) });
    const head = files({
      'openspec/specs/api/spec.md': spec([{ name: 'Other', text: 'The system SHALL work.', scenarios: ['other'] }]),
      'openspec/changes/archive/2026-01-01-example/specs/api/spec.md':
        '```markdown\n## REMOVED Requirements\n\n### Requirement: Critical\n\nThe system SHALL work.\n```\n',
    });

    expect(codes(reviewCorpusIntent(base, head))).toContain('corpus-requirement-removed');
  });

  it('is silent for equivalent-strength, scenario-preserving, specificity-preserving edits', () => {
    const base = files({ 'openspec/specs/api/spec.md': spec([{
      name: 'Stable',
      text: 'The system SHALL disclose a 200 ms truncation boundary and return one of `a`, `b`, or `c`.',
      scenarios: ['one', 'two'],
    }]) });
    const head = files({ 'openspec/specs/api/spec.md': spec([{
      name: 'Stable',
      text: 'The system MUST disclose a 200 ms truncation boundary and return one of `a`, `b`, or `c`.',
      scenarios: ['two', 'one'],
    }]) });

    expect(reviewCorpusIntent(base, head).findings).toEqual([]);
  });

  it('returns deterministic sorted findings, reasons, and no-review-needed for identical files', () => {
    const base = files({
      'openspec/specs/z/spec.md': spec([{ name: 'Zed', text: 'The system SHALL finish within 5 ms.' }]),
      'openspec/specs/a/spec.md': spec([{ name: 'Alpha', text: 'The system SHALL disclose omissions.' }]),
    });
    const head = files({
      'openspec/specs/z/spec.md': spec([{ name: 'Zed', text: 'The system MAY finish quickly.' }]),
      'openspec/specs/a/spec.md': spec([{ name: 'Alpha', text: 'The system SHALL return results.' }]),
    });

    const first = reviewCorpusIntent(base, head);
    const second = reviewCorpusIntent(new Map([...base].reverse()), new Map([...head].reverse()));
    expect(first).toEqual(second);
    expect(first.verdict).toBe('review-recommended');
    expect(first.findings.map((finding) => finding.artifact)).toEqual([...first.findings.map((finding) => finding.artifact)].sort());
    expect(first.reasons).toEqual(first.findings);

    expect(reviewCorpusIntent(base, base)).toEqual({ verdict: 'no-review-needed', findings: [], reasons: [] });
  });
});
