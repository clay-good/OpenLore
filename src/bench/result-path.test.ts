import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveBenchmarkResultPath } from './result-path.js';

// The function returns a RESOLVED path, so the expectation must be resolved the same way rather
// than spelled as a POSIX literal: on Windows `resolve('/repo', ...)` yields `D:\repo\...`, and a
// hardcoded `/repo/...` compares a real path against a string that platform never produces.
describe('benchmark results path', () => {
  it('accepts a direct JSON child of bench/results', () => {
    expect(resolveBenchmarkResultPath('/repo', 'bench/results/run.json'))
      .toBe(resolve('/repo', 'bench/results/run.json'));
  });

  it('rejects traversal outside bench/results', () => {
    expect(() => resolveBenchmarkResultPath('/repo', 'bench/results/../../package.json'))
      .toThrow('Live runs require --out bench/results/<name>.json.');
  });
});
