/**
 * Whole-payload token-budget fitting (change: refine-orient-context-budgeting).
 */

import { describe, it, expect } from 'vitest';
import { fitPayloadToBudget } from './budget-fit.js';
import { estimateTokens } from '../llm-service.js';

const entry = (i: number) => ({ name: `function${i}`, filePath: `src/module${i}.ts`, detail: 'x'.repeat(40) });
const payload = () => ({
  task: 'fit me',
  core: Array.from({ length: 10 }, (_, i) => entry(i)),
  peripheral: Array.from({ length: 10 }, (_, i) => entry(100 + i)),
  governance: Array.from({ length: 3 }, (_, i) => entry(200 + i)),
});
const decorate = (trimmed: ReturnType<typeof payload>, omitted: Record<string, number>) =>
  Object.keys(omitted).length > 0 ? { ...trimmed, omitted } : trimmed;
const tokensOf = (value: unknown) => estimateTokens(JSON.stringify(value));

describe('fitPayloadToBudget', () => {
  it('returns the payload unchanged when it already fits', () => {
    const fit = fitPayloadToBudget(payload(), 100_000, ['peripheral', 'core'], {}, decorate);
    expect(fit.payload).toEqual(payload());
    expect(fit.omitted).toEqual({});
    expect(fit.fits).toBe(true);
  });

  it('drains the peripheral section before touching a ranked one, dropping trailing entries whole', () => {
    const full = tokensOf(payload());
    const fit = fitPayloadToBudget(payload(), full - 60, ['peripheral', 'core'], {}, decorate);
    const fitted = fit.payload as ReturnType<typeof payload>;
    expect(fit.fits).toBe(true);
    expect(fit.estimatedTokens).toBeLessThanOrEqual(full - 60);
    expect(fitted.core).toEqual(payload().core);
    expect(fitted.peripheral).toEqual(payload().peripheral.slice(0, fitted.peripheral.length));
    expect(fit.omitted).toEqual({ peripheral: 10 - fitted.peripheral.length });
  });

  it('finds the fewest removals that fit, including the receipt in the cost', () => {
    const order = ['peripheral', 'core'];
    // Oracle: the same removal sequence, tried at every count.
    const cut = (removals: number) => {
      const base = payload();
      const steps = order.flatMap(section => Array(section === 'core' ? base.core.length - 1 : base.peripheral.length).fill(section) as string[]);
      const omitted: Record<string, number> = {};
      for (const section of steps.slice(0, removals)) omitted[section] = (omitted[section] ?? 0) + 1;
      return decorate({
        ...base,
        peripheral: base.peripheral.slice(0, base.peripheral.length - (omitted.peripheral ?? 0)),
        core: base.core.slice(0, base.core.length - (omitted.core ?? 0)),
      }, omitted);
    };
    const full = tokensOf(payload());
    for (let budget = full; budget > 100; budget -= 37) {
      const fit = fitPayloadToBudget(payload(), budget, order, { core: 1 }, decorate);
      const removed = Object.values(fit.omitted).reduce((a, b) => a + b, 0);
      let smallest = 0;
      while (smallest < 19 && tokensOf(cut(smallest)) > budget) smallest++;
      expect(removed).toBe(smallest);
      expect(tokensOf(fit.payload)).toBe(fit.estimatedTokens);
    }
  });

  it('finds a smaller cut a binary search would skip when a receipt makes cost non-monotone', () => {
    const skewed = { big: ['x'.repeat(400)], tiny: Array.from({ length: 64 }, () => '') };
    const receipt = (trimmed: typeof skewed, omitted: Record<string, number>) =>
      Object.keys(omitted).length > 0 ? { ...trimmed, omitted } : trimmed;
    const budget = tokensOf(receipt({ big: [], tiny: skewed.tiny }, { big: 1 }));
    const fit = fitPayloadToBudget(skewed, budget, ['big', 'tiny'], {}, receipt);
    expect(fit.omitted).toEqual({ big: 1 });
  });

  it('costs the rendering the caller passes', () => {
    const pretty = (value: Record<string, unknown>) => estimateTokens(JSON.stringify(value, null, 2));
    const budget = tokensOf(payload());
    const fit = fitPayloadToBudget(payload(), budget, ['peripheral', 'core'], {}, decorate, pretty);
    expect(pretty(fit.payload)).toBe(fit.estimatedTokens);
    expect(fit.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(Object.keys(fit.omitted).length).toBeGreaterThan(0);
  });

  it('never trims unnamed sections or below the minimum, and reports when the budget cannot be met', () => {
    const fit = fitPayloadToBudget(payload(), 10, ['peripheral', 'core'], { core: 1 }, decorate);
    const fitted = fit.payload as ReturnType<typeof payload>;
    expect(fit.fits).toBe(false);
    expect(fitted.core).toHaveLength(1);
    expect(fitted.peripheral).toHaveLength(0);
    expect(fitted.governance).toEqual(payload().governance);
    expect(fit.omitted).toEqual({ peripheral: 10, core: 9 });
  });

  it('is deterministic', () => {
    const a = fitPayloadToBudget(payload(), 300, ['peripheral', 'core'], { core: 1 }, decorate);
    const b = fitPayloadToBudget(payload(), 300, ['peripheral', 'core'], { core: 1 }, decorate);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
