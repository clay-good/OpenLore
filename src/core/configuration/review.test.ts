import { describe, expect, it } from 'vitest';
import {
  reviewConfiguration,
  dismissConfigurationReview,
  type ConfigurationReviewSignal,
} from './review.js';
import type { ConfigurationInspection } from './types.js';
const inspection = {
  root: '/repo',
  complete: true,
  evidenceRevision: 'a',
} as ConfigurationInspection;
const signal: ConfigurationReviewSignal = {
  kind: 'watched-output',
  scope: 'generated/',
  action: 'Exclude declared output from watches',
  observed: true,
  material: true,
  actionable: true,
  explicitChoice: false,
};
const options = {
  mode: 'notify' as const,
  idle: true,
  operationActive: false,
  deliveryClaimed: true,
};
describe('configuration notification precision', () => {
  it('stays silent across a larger quiet-control corpus', () => {
    const controls = Array.from({ length: 200 }, (_, i) => ({
      ...inspection,
      evidenceRevision: String(i),
    }));
    for (const report of controls) {
      expect(reviewConfiguration(report, [], options).notice).toBeUndefined();
      for (const key of ['observed', 'material', 'actionable'] as const)
        expect(
          reviewConfiguration(report, [{ ...signal, [key]: false }], options).notice
        ).toBeUndefined();
      expect(
        reviewConfiguration(report, [{ ...signal, explicitChoice: true }], options).notice
      ).toBeUndefined();
    }
  });
  it('requires complete evidence, opt-in, idle delivery, and a cross-session host claim', () => {
    for (const override of [
      { mode: 'manual' as const },
      { idle: false },
      { operationActive: true },
      { deliveryClaimed: false },
    ])
      expect(
        reviewConfiguration(inspection, [signal], { ...options, ...override }).notice
      ).toBeUndefined();
    expect(
      reviewConfiguration({ ...inspection, complete: false }, [signal], options).notice
    ).toBeUndefined();
    expect(reviewConfiguration(inspection, [signal], options).notice?.conditions).toHaveLength(1);
  });
  it('preserves semantic dedupe and dismissal through harmless revision and branch changes', () => {
    const first = reviewConfiguration(inspection, [signal], options);
    const id = first.notice!.conditions[0].id;
    const dismissed = dismissConfigurationReview(first.state, id);
    expect(
      reviewConfiguration({ ...inspection, evidenceRevision: 'new-head' }, [signal], {
        ...options,
        previous: dismissed,
      }).notice
    ).toBeUndefined();
    const snoozed = dismissConfigurationReview(
      { ...first.state, conditions: { [id]: { ...first.state.conditions[id], dismissed: false } } },
      id,
      10
    );
    expect(
      reviewConfiguration(inspection, [], { ...options, previous: snoozed, now: 11 }).notice
    ).toBeUndefined();
    expect(
      reviewConfiguration(inspection, [signal], { ...options, previous: snoozed, now: 11 }).notice
    ).toBeDefined();
  });
  it('requires sustained measured resource evidence and resets on recovery', () => {
    const resource: ConfigurationReviewSignal = {
      ...signal,
      kind: 'resource-pressure',
      baseline: 'measured-baseline',
      persistent: true,
    };
    const first = reviewConfiguration(inspection, [resource], options);
    expect(first.notice).toBeUndefined();
    const second = reviewConfiguration(inspection, [resource], {
      ...options,
      previous: first.state,
    });
    expect(second.notice).toBeDefined();
    const recovered = reviewConfiguration(inspection, [{ ...resource, recovered: true }], {
      ...options,
      previous: second.state,
    });
    expect(Object.keys(recovered.state.conditions)).toHaveLength(0);
  });
});
