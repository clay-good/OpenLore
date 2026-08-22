import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openloreRun } from './run.js';
import { openloreInit } from './init.js';
import { openloreAnalyze } from './analyze.js';
import { openloreGenerate } from './generate.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { OpenLoreError, errors } from '../utils/errors.js';
import { resolve } from 'node:path';

vi.mock('./init.js', () => ({ openloreInit: vi.fn() }));
vi.mock('./analyze.js', () => ({ openloreAnalyze: vi.fn() }));
vi.mock('./generate.js', () => ({ openloreGenerate: vi.fn() }));
vi.mock('../core/services/config-manager.js', () => ({ readOpenLoreConfig: vi.fn() }));

const initResult = {
  configPath: '.openlore/config.json',
  openspecPath: 'openspec',
  projectType: 'nodejs',
  created: false,
};
const analysisResult = {
  repoMap: {},
  depGraph: {},
  artifacts: {
    llmContext: {
      phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
      phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
      phase3_validation: { purpose: 'validation', files: [] },
    },
  },
  fromCache: true,
  duration: 0,
};
const generationResult = {
  dryRun: false as const,
  report: { filesWritten: [] },
  pipelineResult: {},
  duration: 1,
};

describe('openloreRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(openloreInit).mockResolvedValue(initResult);
    vi.mocked(openloreAnalyze).mockResolvedValue(analysisResult as unknown as Awaited<ReturnType<typeof openloreAnalyze>>);
    vi.mocked(openloreGenerate).mockResolvedValue(generationResult as unknown as Awaited<ReturnType<typeof openloreGenerate>>);
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null);
  });

  it('composes the public init, analyze, and generate APIs in order', async () => {
    const order: string[] = [];
    vi.mocked(openloreInit).mockImplementation(async () => { order.push('init'); return initResult; });
    vi.mocked(openloreAnalyze).mockImplementation(async () => { order.push('analyze'); return analysisResult as never; });
    vi.mocked(openloreGenerate).mockImplementation(async () => { order.push('generate'); return generationResult as never; });

    const result = await openloreRun({ rootPath: '/repo' });

    expect(order).toEqual(['init', 'analyze', 'generate']);
    expect(result).toMatchObject({
      dryRun: false,
      init: initResult,
      analysis: analysisResult,
      generation: generationResult,
    });
  });

  it('normalizes a relative root before forwarding it to every stage', async () => {
    await openloreRun({ rootPath: 'relative/project' });

    const rootPath = resolve('relative/project');
    expect(openloreInit).toHaveBeenCalledWith(expect.objectContaining({ rootPath }));
    expect(openloreAnalyze).toHaveBeenCalledWith(expect.objectContaining({ rootPath }));
    expect(openloreGenerate).toHaveBeenCalledWith(expect.objectContaining({ rootPath }));
  });

  it.each([
    ['init', openloreInit],
    ['analysis', openloreAnalyze],
    ['generation', openloreGenerate],
  ] as const)('wraps a raw %s failure with its cause', async (_stage, stage) => {
    const cause = new Error('sentinel failure');
    vi.mocked(stage as typeof openloreInit).mockRejectedValueOnce(cause);

    await expect(openloreRun({ rootPath: '/repo' })).rejects.toMatchObject({
      code: 'pipeline-failed',
      cause,
    });
  });

  it('preserves an existing typed stage error', async () => {
    const typed = errors.noConfig('custom.json');
    vi.mocked(openloreInit).mockRejectedValueOnce(typed);

    await expect(openloreRun({ rootPath: '/repo' })).rejects.toBe(typed);
    expect(typed).toBeInstanceOf(OpenLoreError);
  });

  it('passes keyless provider configuration through to generation', async () => {
    await openloreRun({ rootPath: '/repo', provider: 'codex-cli', model: 'gpt-5-codex' });

    expect(openloreGenerate).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex-cli',
      model: 'gpt-5-codex',
    }));
  });

  it('resolves a configured keyless provider before requesting generation consent', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValue({
      version: '1.0.0',
      generation: { provider: 'codex-cli', model: 'gpt-5-codex' },
    } as never);
    const confirmGeneration = vi.fn(async () => true);

    await openloreRun({ rootPath: '/repo', confirmGeneration });

    expect(confirmGeneration).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex-cli',
      model: 'gpt-5-codex',
    }));
    expect(openloreGenerate).toHaveBeenCalledTimes(1);
  });

  it('does not enter generation when the host declines the cost estimate', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValue({
      version: '1.0.0',
      generation: { provider: 'codex-cli', model: 'gpt-5-codex' },
    } as never);

    await expect(openloreRun({
      rootPath: '/repo',
      confirmGeneration: async () => false,
    })).rejects.toMatchObject({ code: 'pipeline-failed' });
    expect(openloreGenerate).not.toHaveBeenCalled();
  });

  it('preserves force as a rebuild across all composed stages', async () => {
    await openloreRun({ rootPath: '/repo', force: true });

    expect(openloreInit).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(openloreAnalyze).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(openloreGenerate).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it('forces one healing analysis before generation when the dependency graph is degraded', async () => {
    const degraded = { ...analysisResult, depGraph: undefined, degraded: { artifact: 'dependency-graph.json', reason: 'corrupt' as const } };
    vi.mocked(openloreAnalyze)
      .mockResolvedValueOnce(degraded as never)
      .mockResolvedValueOnce(analysisResult as never);

    const result = await openloreRun({ rootPath: '/repo' });

    expect(openloreAnalyze).toHaveBeenCalledTimes(2);
    expect(openloreAnalyze).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
    expect(openloreGenerate).toHaveBeenCalledTimes(1);
    if (result.dryRun) throw new Error('expected completed run');
    expect(result.analysis).toBe(analysisResult);
  });

  it('preserves honest dry-run results without constructing a pipeline result', async () => {
    const result = await openloreRun({ rootPath: '/repo', dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      plan: { init: true, analyze: true, generate: true },
      generation: {
        dryRun: true,
        report: {
          openloreVersion: '2.2.0',
          configSchemaVersion: 'unknown',
          filesWritten: [],
        },
      },
    });
    expect('pipelineResult' in result.generation).toBe(false);
    expect(openloreInit).not.toHaveBeenCalled();
    expect(openloreAnalyze).not.toHaveBeenCalled();
    expect(openloreGenerate).not.toHaveBeenCalled();
  });

  it('reads a custom config path without running stages during dry run', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ version: '2.5.0' } as never);

    const result = await openloreRun({ rootPath: '/repo', configPath: 'config/openlore.json', dryRun: true });

    expect(readOpenLoreConfig).toHaveBeenCalledWith('/repo', 'config/openlore.json');
    expect(result.generation.report.configSchemaVersion).toBe('2.5.0');
    expect(openloreInit).not.toHaveBeenCalled();
    expect(openloreAnalyze).not.toHaveBeenCalled();
    expect(openloreGenerate).not.toHaveBeenCalled();
  });

  it('forwards quiet and emits run-level progress around composed stages', async () => {
    const events: string[] = [];
    const onProgress = (event: { phase: string; step: string; status: string }) => {
      if (event.phase === 'run') events.push(`${event.step}:${event.status}`);
    };

    await openloreRun({ rootPath: '/repo', quiet: true, onProgress });

    expect(openloreInit).toHaveBeenCalledWith(expect.objectContaining({ quiet: true, onProgress }));
    expect(openloreAnalyze).toHaveBeenCalledWith(expect.objectContaining({ quiet: true, onProgress }));
    expect(openloreGenerate).toHaveBeenCalledWith(expect.objectContaining({ quiet: true, onProgress }));
    expect(events).toEqual([
      'Initialization:start', 'Initialization:complete',
      'Analysis:start', 'Analysis:complete',
      'Generation:start', 'Generation:complete',
    ]);
  });
});
