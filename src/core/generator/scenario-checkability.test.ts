import { describe, expect, it } from 'vitest';
import { checkScenarioShape, lintScenarioCorpus } from './scenario-checkability.js';

describe('scenario checkability', () => {
  it('accepts WHEN without GIVEN and an observable THEN', () => {
    expect(checkScenarioShape('- **WHEN** `chargeCard()` runs\n- **THEN** the `status` field is "paid"')).toBeNull();
  });

  it('quotes the offending clause for every malformed shape', () => {
    expect(checkScenarioShape('- **GIVEN** a card\n- **THEN** `status` is "paid"')).toEqual({
      reason: 'missing-when', clause: '- **GIVEN** a card',
    });
    expect(checkScenarioShape('- **WHEN** a card is charged')).toEqual({
      reason: 'missing-then', clause: '- **WHEN** a card is charged',
    });
    expect(checkScenarioShape('- **WHEN** a card is charged\n- **THEN** it works well')).toEqual({
      reason: 'unobservable-then', clause: '- **THEN** it works well',
    });
    expect(checkScenarioShape('- **WHEN** work runs\n- **THEN** it returns a result')).toEqual({
      reason: 'unobservable-then', clause: '- **THEN** it returns a result',
    });
  });

  it('lints incomplete scenarios the test generator would skip', () => {
    const findings = lintScenarioCorpus([{
      domain: 'billing', specFile: 'openspec/specs/billing/spec.md',
      content: '## Requirements\n### Requirement: Charge\nThe system SHALL charge.\n#### Scenario: Broken\n- **WHEN** a card is charged\n- **THEN** it works well\n',
    }]);
    expect(findings).toEqual([expect.objectContaining({
      specFile: 'openspec/specs/billing/spec.md', requirement: 'Charge',
      scenario: 'Broken', reason: 'unobservable-then', clause: '- **THEN** it works well',
    })]);
  });
});
