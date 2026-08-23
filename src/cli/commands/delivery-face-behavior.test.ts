import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  writes: [] as string[],
}));

vi.mock('../../core/services/tool-dispatch.js', () => ({ dispatchTool: mocks.dispatch }));
vi.mock('../output.js', () => ({
  writeStdout: vi.fn(async (value: string) => { mocks.writes.push(value); }),
}));

import { runBlastRadiusCli } from './blast-radius.js';
import { runImpactCertificateCli } from './impact-certificate.js';
import { runCoverageGapsCli } from './coverage-gaps.js';
import { runCertifyPublicSurfaceCli } from './certify-public-surface.js';
import { runStyleFingerprintCli } from './style-fingerprint.js';
import { runBriefingSinceCli } from './briefing-since.js';
import { runFindClonesCli } from './find-clones.js';
import { runErrorPropagationCli } from './error-propagation.js';
import { runEnvImpactCli } from './env-impact.js';
import { runWorkingSetContextCli } from './working-set.js';
import { runSpecStoreStatusCli } from './spec-store.js';
import { runSearchCli } from './search.js';
import { orientCommand } from './orient.js';

const directory = '/parity/repo';
const conclusion = {
  kind: 'parity-sentinel',
  confidenceBoundary: { staleness: { detail: 'bounded fixture' } },
  truncation: { bounded: true, omitted: 3 },
  redactions: { count: 1, kinds: ['api-key'] },
};

type Case = {
  tool: string;
  args: Record<string, unknown>;
  invoke: () => Promise<number>;
};

const cases: readonly Case[] = [
  {
    tool: 'blast_radius',
    args: { directory, baseRef: 'release' },
    invoke: () => runBlastRadiusCli({ cwd: directory, base: 'release', json: true }),
  },
  {
    tool: 'change_impact_certificate',
    args: { directory, baseRef: 'release', change: 'safe-api', persist: true, allowBaseFallback: true },
    invoke: () => runImpactCertificateCli({ cwd: directory, base: 'release', change: 'safe-api', save: true, allowBaseFallback: true, json: true }),
  },
  {
    tool: 'report_coverage_gaps',
    args: { directory, maxResults: 7, filePattern: 'src/api', changedSymbols: ['serve'], diffRef: 'release' },
    invoke: () => runCoverageGapsCli({ cwd: directory, max: 7, filePattern: 'src/api', symbols: ['serve'], base: 'release', json: true }),
  },
  {
    tool: 'certify_public_surface',
    args: { directory, baseRef: 'release', maxResults: 9, allowBaseFallback: true },
    invoke: () => runCertifyPublicSurfaceCli({ cwd: directory, base: 'release', max: 9, allowBaseFallback: true, json: true }),
  },
  {
    tool: 'get_style_fingerprint',
    args: { directory, communityId: 'core', filePath: 'src/api.ts', language: 'TypeScript' },
    invoke: () => runStyleFingerprintCli({ cwd: directory, community: 'core', file: 'src/api.ts', language: 'TypeScript', json: true }),
  },
  {
    tool: 'briefing_since',
    args: { directory, baseRef: 'release', filePattern: 'src', maxResults: 11 },
    invoke: () => runBriefingSinceCli({ cwd: directory, base: 'release', filePattern: 'src', max: 11, json: true }),
  },
  {
    tool: 'find_clones',
    args: { directory, symbol: 'serve', snippet: undefined, minSimilarity: 0.8, maxResults: 4 },
    invoke: () => runFindClonesCli({ cwd: directory, symbol: 'serve', min: 0.8, max: 4, json: true }),
  },
  {
    tool: 'analyze_error_propagation',
    args: { directory, symbol: 'serve', maxDepth: 6 },
    invoke: () => runErrorPropagationCli({ cwd: directory, symbol: 'serve', maxDepth: 6, json: true }),
  },
  {
    tool: 'analyze_env_impact',
    args: { directory, name: 'API_TOKEN', maxDepth: 5 },
    invoke: () => runEnvImpactCli({ cwd: directory, name: 'API_TOKEN', maxDepth: 5, json: true }),
  },
  {
    tool: 'working_set_context',
    args: { directory, change: 'safe-api', tokenBudget: 900 },
    invoke: () => runWorkingSetContextCli({ cwd: directory, change: 'safe-api', tokenBudget: 900, json: true }),
  },
  {
    tool: 'spec_store_status',
    args: { directory },
    invoke: () => runSpecStoreStatusCli({ cwd: directory, json: true }),
  },
  {
    tool: 'search_code',
    args: { directory, query: 'serve', limit: 3, language: 'typescript', minFanIn: 2, tokenBudget: 700 },
    invoke: () => runSearchCli('serve', { cwd: directory, limit: 3, language: 'typescript', minFanIn: 2, tokenBudget: 700, json: true }),
  },
  {
    tool: 'search_specs',
    args: { directory, query: 'serve', limit: 4, domain: 'mcp-quality', section: 'requirements' },
    invoke: () => runSearchCli('serve', { cwd: directory, specs: true, limit: 4, domain: 'mcp-quality', section: 'requirements', json: true }),
  },
  {
    tool: 'explain_retrieval_miss',
    args: { directory, query: 'serve', surface: 'code', target: { kind: 'symbol', value: 'serve', filePath: 'src/api.ts' }, limit: 5, language: 'typescript' },
    invoke: () => runSearchCli('serve', { cwd: directory, explain: 'serve', targetKind: 'symbol', file: 'src/api.ts', limit: 5, language: 'typescript', json: true }),
  },
];

describe('paired CLI JSON delivery behavior', () => {
  beforeEach(() => {
    mocks.dispatch.mockReset();
    mocks.writes.length = 0;
  });

  for (const testCase of cases) {
    it(`${testCase.tool} forwards exact inputs and preserves the MCP conclusion`, async () => {
      mocks.dispatch.mockResolvedValue(conclusion);
      expect(await testCase.invoke()).toBe(0);
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
      expect(mocks.dispatch).toHaveBeenCalledWith(testCase.tool, testCase.args, directory);
      expect(JSON.parse(mocks.writes.join(''))).toEqual(conclusion);
    });
  }

  it('orient forwards exact inputs and preserves the MCP conclusion', async () => {
    mocks.dispatch.mockResolvedValue(conclusion);
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((value) => { output.push(String(value)); });
    try {
      await orientCommand.parseAsync([
        '--task', 'map delivery', '--directory', directory, '--limit', '8',
        '--token-budget', '650', '--lean', '--json',
      ], { from: 'user' });
    } finally {
      log.mockRestore();
    }
    expect(mocks.dispatch).toHaveBeenCalledWith('orient', {
      directory,
      task: 'map delivery',
      limit: 8,
      tokenBudget: 650,
      lean: true,
    }, directory);
    expect(JSON.parse(output.join(''))).toEqual(conclusion);
  });
});
