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
    const full = tokensOf(payload());
    for (const budget of [full - 30, full - 200, full - 500]) {
      const fit = fitPayloadToBudget(payload(), budget, ['peripheral', 'core'], { core: 1 }, decorate);
      expect(tokensOf(fit.payload)).toBe(fit.estimatedTokens);
      expect(fit.estimatedTokens).toBeLessThanOrEqual(budget);
      const removed = Object.values(fit.omitted).reduce((a, b) => a + b, 0);
      // One fewer removal would not fit.
      const lessTrimmed = fitPayloadToBudget(payload(), fit.estimatedTokens - 1, ['peripheral', 'core'], { core: 1 }, decorate);
      expect(Object.values(lessTrimmed.omitted).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(removed);
    }
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
