import { describe, expect, it } from 'vitest';
import { evaluatePresetBenchmarkRule, parsePresetBenchmarkRule } from './protocol-verdict.js';

const rule = parsePresetBenchmarkRule({
  schemaVersion: 1,
  id: 'test-rule',
  sharedSelectionRegressionMax: 0,
  tierCorrectnessRegressionMax: 0.05,
  medianCostIncreaseMax: 0.2,
  requiredCandidateFamilies: ['navigate', 'change', 'remember', 'verify'],
});

const tiers = [
  { tier: 'small-familiar', current: { tasks: 1, correctness: 1, costUsd: 1 }, candidate: { tasks: 1, correctness: 0.95, costUsd: 1.2 } },
  { tier: 'large-unfamiliar', current: { tasks: 1, correctness: 1, costUsd: 1 }, candidate: { tasks: 1, correctness: 1, costUsd: 1 } },
];

describe('preset benchmark decision rule', () => {
  it('clears only when every pre-registered criterion passes', () => {
    expect(evaluatePresetBenchmarkRule(
      rule,
      'navigation',
      'substrate',
      ['navigate', 'change', 'remember', 'verify'],
      { sharedAccuracy: { navigation: 0.8, substrate: 0.8 } },
      tiers,
      ['small-familiar', 'large-unfamiliar'],
    )).toMatchObject({ verdict: 'FLIP' });
  });

  it('holds when a result narrowly misses the registered rule', () => {
    const result = evaluatePresetBenchmarkRule(
      rule,
      'navigation',
      'substrate',
      ['navigate', 'change', 'remember', 'verify'],
      { sharedAccuracy: { navigation: 0.8, substrate: 0.79 } },
      tiers,
      ['small-familiar', 'large-unfamiliar'],
    );
    expect(result).toMatchObject({ verdict: 'HOLD', checks: { sharedSelection: false } });
  });

  it('holds when either required tier has no task evidence', () => {
    const result = evaluatePresetBenchmarkRule(
      rule,
      'navigation',
      'substrate',
      ['navigate', 'change', 'remember', 'verify'],
      { sharedAccuracy: { navigation: 0.8, substrate: 0.8 } },
      tiers.slice(0, 1),
      ['small-familiar', 'large-unfamiliar'],
    );
    expect(result).toMatchObject({ verdict: 'HOLD', checks: { completeEvidence: false } });
  });

  it('holds when a required model-by-tier evidence cell is absent', () => {
    const result = evaluatePresetBenchmarkRule(
      rule,
      'navigation',
      'substrate',
      ['navigate', 'change', 'remember', 'verify'],
      { sharedAccuracy: { navigation: 0.8, substrate: 0.8 } },
      tiers,
      ['small-familiar', 'large-unfamiliar'],
      2,
    );
    expect(result).toMatchObject({ verdict: 'HOLD', checks: { completeEvidence: false } });
  });

  it('holds when an agent run failed instead of producing evidence', () => {
    const failed = tiers.map((tier, index) => index === 0
      ? { ...tier, candidate: { ...tier.candidate, failures: 1 } }
      : tier);
    const result = evaluatePresetBenchmarkRule(
      rule,
      'navigation',
      'substrate',
      ['navigate', 'change', 'remember', 'verify'],
      { sharedAccuracy: { navigation: 0.8, substrate: 0.8 } },
      failed,
      ['small-familiar', 'large-unfamiliar'],
    );
    expect(result).toMatchObject({ verdict: 'HOLD', checks: { completeEvidence: false } });
  });
});
