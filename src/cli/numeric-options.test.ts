/**
 * Numeric flags refuse nonsense (change: fix-cli-input-validation).
 *
 * `parseInt('abc', 10)` is `NaN`, and `NaN` is not nullish, so a handler's `opts.max ?? DEFAULT`
 * never fired: `certify-public-surface --max abc` answered with an EMPTY public API surface for a
 * repository that exports seven symbols, exit 0 and no caveat. A zero or negative bound skipped
 * the default the same way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidArgumentError } from 'commander';
import { positiveIntegerOption, depthOption, ratioOption } from './numeric-options.js';

describe('positiveIntegerOption', () => {
  const parse = positiveIntegerOption('--max');

  it('accepts a whole number at or above one', () => {
    expect(parse('1')).toBe(1);
    expect(parse('200')).toBe(200);
  });

  it.each(['abc', '', ' ', 'NaN', '1.5', '0', '-5', '1e', 'Infinity'])('refuses %j', (value) => {
    expect(() => parse(value)).toThrow(InvalidArgumentError);
    expect(() => parse(value)).toThrow(/--max must be a positive integer/);
  });
});

describe('depthOption', () => {
  it('refuses a depth that would traverse nothing', () => {
    expect(() => depthOption('--max-depth')('0')).toThrow(/positive integer/);
    expect(() => depthOption('--max-depth')('-1')).toThrow(/positive integer/);
    expect(depthOption('--max-depth')('12')).toBe(12);
  });
});

describe('ratioOption', () => {
  const parse = ratioOption('--min', 0.1, 1);

  it('accepts a ratio inside the documented range, inclusive', () => {
    expect(parse('0.1')).toBe(0.1);
    expect(parse('0.7')).toBe(0.7);
    expect(parse('1')).toBe(1);
  });

  it.each(['5', '-1', '0', 'abc', '1.01'])('refuses %j, which the old parseFloat accepted', (value) => {
    expect(() => parse(value)).toThrow(/--min must be a number between 0.1 and 1/);
  });
});

describe('no numeric CLI flag is coerced without validation', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'commands');
  const sources = readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => ({ file: f, src: readFileSync(join(dir, f), 'utf-8') }));

  it.each(sources.map(s => [s.file, s.src]))('%s uses a validating coercer', (file, src) => {
    // A bare parseInt/parseFloat as a commander coercer is the shape that let NaN through.
    const bare = /\.option\([^)]*?(?:\(v\) => parseInt\(v, 10\)|parseFloat|parseInt)\s*\)/s.test(src);
    expect(
      bare,
      `${file} coerces a numeric option with a bare parseInt/parseFloat. NaN is not nullish, so it `
      + 'reaches the handler and turns into an empty answer with exit 0. Use '
      + 'positiveIntegerOption / depthOption / ratioOption from src/cli/numeric-options.ts.',
    ).toBe(false);
  });
});
