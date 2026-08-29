import { describe, expect, it } from 'vitest';
import { resolveBenchmarkResultPath } from './result-path.js';

describe('benchmark results path', () => {
  it('accepts a direct JSON child of bench/results', () => {
    expect(resolveBenchmarkResultPath('/repo', 'bench/results/run.json')).toBe('/repo/bench/results/run.json');
  });

  it('rejects traversal outside bench/results', () => {
    expect(() => resolveBenchmarkResultPath('/repo', 'bench/results/../../package.json'))
      .toThrow('Live runs require --out bench/results/<name>.json.');
  });
});
