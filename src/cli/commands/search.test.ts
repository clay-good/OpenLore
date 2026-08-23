/** Focused contract tests for the standalone search CLI face. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/services/mcp-handlers/semantic.js', () => ({
  handleSearchCode: vi.fn(),
  handleSearchSpecs: vi.fn(),
}));

vi.mock('../../core/services/mcp-handlers/retrieval-miss.js', () => ({
  handleExplainRetrievalMiss: vi.fn(),
}));

const writes: string[] = [];
vi.mock('../output.js', () => ({
  writeStdout: vi.fn(async (text: string) => { writes.push(text); }),
}));

vi.mock('../../utils/logger.js', () => ({
  configureLogger: vi.fn(),
  logger: {
    error: vi.fn((text: string) => { writes.push(`ERROR ${text}`); }),
    info: vi.fn((label: string, text: string) => { writes.push(`${label} ${text}`); }),
  },
}));

import { handleSearchCode, handleSearchSpecs } from '../../core/services/mcp-handlers/semantic.js';
import { handleExplainRetrievalMiss } from '../../core/services/mcp-handlers/retrieval-miss.js';
import { runSearchCli, searchCommand } from './search.js';

const searchCode = vi.mocked(handleSearchCode);
const searchSpecs = vi.mocked(handleSearchSpecs);
const explainMiss = vi.mocked(handleExplainRetrievalMiss);

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
});

describe('search command configuration', () => {
  it('exposes the standalone search and target-diagnostic options', () => {
    expect(searchCommand.name()).toBe('search');
    const options = searchCommand.options.map((option) => option.long);
    expect(options).toEqual(expect.arrayContaining([
      '--specs', '--json', '--explain', '--target-kind', '--file', '--directory',
      '--limit', '--language', '--min-fan-in', '--domain', '--section', '--token-budget',
    ]));
  });
});

describe('runSearchCli', () => {
  it('calls handleSearchCode directly with the supported filters and emits identical JSON', async () => {
    const result = {
      query: 'auth handler',
      count: 1,
      results: [{ name: 'authenticate', filePath: 'src/auth.ts', matchEvidence: { field: 'symbol', terms: ['auth'], tier: 1 } }],
    };
    searchCode.mockResolvedValue(result);

    expect(await runSearchCli('auth handler', {
      cwd: '/repo', json: true, limit: 7, language: 'typescript', tokenBudget: 500,
    })).toBe(0);

    expect(searchCode).toHaveBeenCalledWith('/repo', 'auth handler', 7, 'typescript', undefined, 500);
    expect(JSON.parse(writes.join(''))).toEqual(result);
    expect(searchSpecs).not.toHaveBeenCalled();
    expect(explainMiss).not.toHaveBeenCalled();
  });

  it('calls handleSearchSpecs directly and renders its match evidence for a human', async () => {
    searchSpecs.mockResolvedValue({
      query: 'rate limiting',
      retrievalMode: 'keyword',
      count: 1,
      results: [{ title: 'RateLimitRequests', domain: 'api', section: 'Requirements', matchEvidence: { field: 'doc', terms: ['rate'], tier: 1 } }],
    });

    expect(await runSearchCli('rate limiting', {
      cwd: '/repo', specs: true, limit: 3, domain: 'api', section: 'Requirements',
    })).toBe(0);

    expect(searchSpecs).toHaveBeenCalledWith('/repo', 'rate limiting', 3, 'api', 'Requirements');
    expect(writes.join('')).toContain('Spec search');
    expect(writes.join('')).toContain('field=doc · terms=rate · tier=1');
  });

  it('passes the exact target-scoped object to handleExplainRetrievalMiss', async () => {
    const result = {
      query: 'authentication',
      target: { kind: 'symbol', value: 'verifyToken', filePath: 'src/auth.ts' },
      surfaced: false,
      cause: 'outranked',
      rank: 12,
      cutoff: 5,
    };
    explainMiss.mockResolvedValue(result);

    expect(await runSearchCli('authentication', {
      cwd: '/repo',
      explain: 'verifyToken',
      targetKind: 'symbol',
      file: 'src/auth.ts',
      limit: 5,
      language: 'typescript',
      minFanIn: 2,
    })).toBe(0);

    expect(explainMiss).toHaveBeenCalledWith('/repo', {
      query: 'authentication',
      surface: 'code',
      target: { kind: 'symbol', value: 'verifyToken', filePath: 'src/auth.ts' },
      limit: 5,
      language: 'typescript',
      minFanIn: 2,
    });
    expect(writes.join('')).toContain('cause=outranked');
    expect(searchCode).not.toHaveBeenCalled();
  });

  it('selects the spec surface for an explained requirement', async () => {
    explainMiss.mockResolvedValue({ target: { kind: 'requirement', value: 'AuthRequired' }, surfaced: false, cause: 'not-indexed' });
    await runSearchCli('auth', {
      cwd: '/repo', specs: true, json: true, explain: 'AuthRequired', targetKind: 'requirement',
    });
    expect(explainMiss).toHaveBeenCalledWith('/repo', {
      query: 'auth', surface: 'spec', target: { kind: 'requirement', value: 'AuthRequired' }, limit: 10,
    });
  });

  it('renders the handler\'s filter name and value without renaming either field', async () => {
    explainMiss.mockResolvedValue({
      target: { kind: 'symbol', value: 'verifyToken' },
      cause: 'filtered-out',
      filter: 'language',
      value: 'python',
    });
    await runSearchCli('auth', {
      cwd: '/repo', explain: 'verifyToken', targetKind: 'symbol', language: 'python',
    });
    expect(writes.join('')).toContain('filter: language=python');
  });

  it('renders the diagnostic details supplied for capability and budget causes', async () => {
    explainMiss.mockResolvedValue({
      target: { kind: 'file', value: 'src/legacy.xyz' },
      cause: 'capability-unsupported-for-language',
      language: 'unknown',
      budget: 'candidate-window',
      tokenBudget: 100,
    });
    await runSearchCli('legacy', {
      cwd: '/repo', explain: 'src/legacy.xyz', targetKind: 'file',
    });
    expect(writes.join('')).toContain('language: unknown');
    expect(writes.join('')).toContain('budget: candidate-window');
    expect(writes.join('')).toContain('token budget: 100');
  });

  it('rejects --explain without a valid target kind before calling a handler', async () => {
    expect(await runSearchCli('auth', { cwd: '/repo', explain: 'verifyToken' })).toBe(1);
    expect(writes.join('')).toContain('--explain requires --target-kind');

    writes.length = 0;
    expect(await runSearchCli('auth', {
      cwd: '/repo', json: true, explain: 'verifyToken', targetKind: 'package',
    })).toBe(1);
    expect(JSON.parse(writes.join('')).error).toContain('--target-kind must be');
    expect(explainMiss).not.toHaveBeenCalled();
  });

  it('rejects invalid numeric bounds and stray target-only options', async () => {
    expect(await runSearchCli('auth', { cwd: '/repo', limit: 0 })).toBe(1);
    expect(await runSearchCli('auth', { cwd: '/repo', tokenBudget: Number.NaN })).toBe(1);
    expect(await runSearchCli('auth', { cwd: '/repo', file: 'src/auth.ts' })).toBe(1);
    expect(await runSearchCli('auth', { cwd: '/repo', specs: true, language: 'TypeScript' })).toBe(1);
    expect(await runSearchCli('auth', { cwd: '/repo', domain: 'auth' })).toBe(1);
    expect(await runSearchCli('auth', {
      cwd: '/repo', explain: 'src/a.ts', targetKind: 'file', file: 'src/a.ts',
    })).toBe(1);
    expect(searchCode).not.toHaveBeenCalled();
  });

  it('passes handler errors through JSON and exits 1', async () => {
    searchCode.mockRejectedValue(new Error('index unavailable'));
    expect(await runSearchCli('auth', { cwd: '/repo', json: true })).toBe(1);
    expect(JSON.parse(writes.join(''))).toEqual({ error: 'index unavailable' });
  });
});
