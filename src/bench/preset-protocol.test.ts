import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scorePresetTrajectory,
  scoreSelectionResponse,
  validatePresetBenchmarkCorpus,
  type PresetBenchmarkCorpus,
} from './preset-protocol.js';

const digest = `sha256:${'a'.repeat(64)}`;
const corpus = (overrides: Partial<PresetBenchmarkCorpus> = {}): PresetBenchmarkCorpus => ({
  schemaVersion: 1,
  id: 'test-corpus',
  environment: { image: 'example.test/bench', digest },
  agentConfig: { models: ['model-a', 'model-b'], runs: 1 },
  repoTiers: ['small-familiar', 'large-unfamiliar'],
  tasks: [{
    id: 'orient-task',
    class: 'shared',
    prompt: 'Orient to the code.',
    expectedTools: ['orient'],
    distractors: ['search_code'],
  }],
  ...overrides,
});

describe('preset benchmark corpus validation', () => {
  const known = new Set(['orient', 'search_code']);

  it('accepts a pinned, distractor-aware corpus across both surfaces', () => {
    expect(validatePresetBenchmarkCorpus(corpus(), known, {
      navigation: known,
      substrate: known,
    })).toEqual([]);
  });

  it('fails loudly when a task names a stale tool id', () => {
    const input = corpus({
      tasks: [{ ...corpus().tasks[0], expectedTools: ['removed_tool'] }],
    });
    expect(validatePresetBenchmarkCorpus(input, known, { navigation: known }))
      .toContainEqual(expect.objectContaining({
        code: 'stale-tool-id',
        taskId: 'orient-task',
        toolId: 'removed_tool',
      }));
  });

  it('names a required distractor that is absent from a tested surface', () => {
    expect(validatePresetBenchmarkCorpus(corpus(), known, {
      navigation: new Set(['orient']),
    })).toContainEqual(expect.objectContaining({
      code: 'missing-distractor',
      preset: 'navigation',
      toolId: 'search_code',
    }));
  });

  it('rejects duplicate model ids that would make the two-model gate vacuous', () => {
    const input = corpus({ agentConfig: { models: ['model-a', 'model-a'], runs: 1 } });
    expect(validatePresetBenchmarkCorpus(input, known, { navigation: known }))
      .toContainEqual(expect.objectContaining({
        code: 'invalid-corpus',
        message: 'Corpus must declare at least two distinct models.',
      }));
  });
});

describe('preset benchmark deterministic trajectory scoring', () => {
  const raw = readFileSync(join(process.cwd(), 'src', 'bench', 'fixtures', 'trajectory.txt'), 'utf8');

  it('scores the same logged transcript identically across replays without a model', () => {
    const first = scorePresetTrajectory(corpus().tasks[0], raw);
    const second = scorePresetTrajectory(corpus().tasks[0], raw);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      selectedTool: 'orient',
      selectionCorrect: true,
      steps: 1,
      tokenCost: 160,
      costUsd: 0.01,
    });
  });

  it('replays a logged selection response without a model', () => {
    const logged = JSON.stringify({
      result: '{"tool":"orient"}',
      usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 1 },
    });
    expect(scoreSelectionResponse(corpus().tasks[0], logged)).toEqual({
      selectedTool: 'orient',
      selectionCorrect: true,
      tokenCost: 16,
    });
  });
});

describe('benchmark protocol document', () => {
  it('binds every required review step', () => {
    const protocol = readFileSync(join(process.cwd(), 'bench', 'PROTOCOL.md'), 'utf8');
    for (const phrase of [
      'pre-register',
      'small-familiar',
      'large-unfamiliar',
      'at least two models',
      'results artifact',
      'governing ADR',
      'manual or scheduled',
      'LLM-as-judge',
    ]) {
      expect(protocol.toLowerCase()).toContain(phrase.toLowerCase());
    }
  });
});
