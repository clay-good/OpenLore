import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('source text integrity', () => {
  it('contains no literal NUL bytes in tracked source and tooling files', () => {
    const files = execFileSync(
      'git',
      ['ls-files', 'src', 'scripts'],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);
    const offenders = files.filter(file => readFileSync(file).includes(0));

    expect(offenders, 'literal NUL bytes make text tools treat source as binary').toEqual([]);
  });
});
