import { describe, expect, it } from 'vitest';
import { filesInBriefing, scoreBriefings, turnsFromTranscript } from './transcript-turns.js';

const ROOT = '/repo';
const line = (o: unknown) => JSON.stringify(o);
const user = (text: string) => line({ type: 'user', message: { content: text } });
const tool = (name: string, input: Record<string, unknown>) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

describe('turnsFromTranscript', () => {
  it('pairs each human prompt with the repository files touched before the next one', () => {
    const jsonl = [
      user('why does `detectExistingSpecDir` miss docs/specs?'),
      tool('Read', { file_path: '/repo/src/core/services/config-manager.ts' }),
      tool('Bash', { command: 'npx vitest run src/api/init.test.ts' }),
      tool('Read', { file_path: '/elsewhere/x.ts' }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      tool('Edit', { file_path: '/repo/src/api/init.ts' }),
      user('<task-notification>done</task-notification>'),
      tool('Read', { file_path: '/repo/src/ignored.ts' }),
      user('thanks, push it'),
    ].join('\n');
    expect(turnsFromTranscript(jsonl, [ROOT])).toEqual([
      { prompt: 'why does `detectExistingSpecDir` miss docs/specs?', touched: ['src/api/init.test.ts', 'src/api/init.ts', 'src/core/services/config-manager.ts'] },
      { prompt: 'thanks, push it', touched: [] },
    ]);
  });
});

describe('scoring', () => {
  const brief = 'Relevant functions [source-derived]:\n  • detectExistingSpecDir — src/core/services/config-manager.ts\nRelevant files [source-derived]: src/core/services/config-manager.ts, src/index.ts';
  it('reads the files a briefing names', () => {
    expect(filesInBriefing(brief)).toEqual(['src/core/services/config-manager.ts', 'src/index.ts']);
  });
  it('scores hits and precision only over briefings', () => {
    const s = scoreBriefings([
      { briefing: brief, touched: ['src/core/services/config-manager.ts'] },
      { briefing: '', touched: ['src/a.ts'] },
      { briefing: '[OpenLore] Prompts are briefed only when…', touched: [] },
    ]);
    expect(s).toMatchObject({ prompts: 3, briefings: 1, withHit: 1, meanPrecision: 0.5 });
  });
});
