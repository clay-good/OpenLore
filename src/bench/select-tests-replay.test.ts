import { describe, expect, it } from 'vitest';
import { replayCase, scoreReplay, summarize } from './select-tests-replay.js';

describe('select_tests replay scoring', () => {
  it('applies production files and scores the modified tests, not the added ones', () => {
    const c = replayCase('abc', 'fix: x', 'M\tsrc/a.ts\nA\tsrc/new.ts\nD\tsrc/gone.ts\nM\tsrc/a.test.ts\nA\tsrc/b.test.ts\nM\tdocs/x.md\nR100\tsrc/old.ts\tsrc/moved.ts\n');
    expect(c).toEqual({ commit: 'abc', subject: 'fix: x', applied: ['src/a.ts', 'src/new.ts', 'src/moved.ts'], truth: ['src/a.test.ts'] });
  });

  it('skips a commit with no production change or no modified test', () => {
    expect(replayCase('a', 's', 'M\tsrc/a.test.ts\n')).toBeNull();
    expect(replayCase('a', 's', 'M\tsrc/a.ts\nA\tsrc/a.test.ts\n')).toBeNull();
  });

  it('scores each confidence tier cumulatively, a file at its best tier', () => {
    const c = replayCase('a', 's', 'M\tsrc/a.ts\nM\tsrc/a.test.ts\nM\tsrc/b.test.ts\n')!;
    const s = scoreReplay(c, [
      { file: 'src/a.test.ts', confidence: 'low' }, { file: 'src/a.test.ts', confidence: 'high' },
      { file: 'src/b.test.ts', confidence: 'medium' }, { file: 'src/x.test.ts', confidence: 'low' },
    ]);
    expect(s.tiers).toEqual({ high: { files: 1, hits: 1 }, medium: { files: 2, hits: 2 }, low: { files: 3, hits: 2 } });
    expect(summarize([s]).tiers).toEqual({ high: { recall: 0.5, meanFiles: 1 }, medium: { recall: 1, meanFiles: 2 }, low: { recall: 1, meanFiles: 3 } });
  });

  it('counts hits and misses per case and overall', () => {
    const c = replayCase('a', 's', 'M\tsrc/a.ts\nM\tsrc/a.test.ts\nM\tsrc/b.test.ts\n')!;
    const s = scoreReplay(c, ['src/a.test.ts', 'src/c.test.ts']);
    expect(s).toMatchObject({ truth: 2, hits: 1, misses: ['src/b.test.ts'], selectedFiles: 2 });
    expect(summarize([s, { ...s, hits: 2, misses: [], selectedFiles: 4 }])).toMatchObject({ cases: 2, truth: 4, hits: 3, recall: 0.75, meanSelectedFiles: 3 });
  });
});
