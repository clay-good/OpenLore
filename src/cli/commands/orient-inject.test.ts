/**
 * Tests for task-scoped context injection
 * (change: add-task-scoped-context-injection).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateTokens } from '../../core/services/llm-service.js';
import {
  INJECTION_DEFAULTS,
  POINTER_LINE,
  resolveInjectionConfig,
  passesRelevanceGate,
  renderInjectionBlock,
  extractPrompt,
  buildInjection,
  type ResolvedInjectionConfig,
} from './orient-inject.js';

const cfg = (over: Partial<ResolvedInjectionConfig> = {}): ResolvedInjectionConfig => ({
  ...INJECTION_DEFAULTS,
  ...over,
});

describe('resolveInjectionConfig', () => {
  it('applies documented defaults when the block is absent', () => {
    expect(resolveInjectionConfig(undefined)).toEqual(INJECTION_DEFAULTS);
  });

  it('honors an explicit off mode and custom budget', () => {
    const r = resolveInjectionConfig({ mode: 'off', tokenBudget: 200 });
    expect(r.mode).toBe('off');
    expect(r.tokenBudget).toBe(200);
  });

  it('ignores non-positive / invalid overrides and keeps defaults', () => {
    const r = resolveInjectionConfig({ tokenBudget: 0, relevanceMinMatches: -1 });
    expect(r.tokenBudget).toBe(INJECTION_DEFAULTS.tokenBudget);
    expect(r.relevanceMinMatches).toBe(INJECTION_DEFAULTS.relevanceMinMatches);
  });
});

describe('passesRelevanceGate', () => {
  it('gates down when fewer than relevanceMinMatches functions matched', () => {
    const r = { searchMode: 'hybrid', relevantFunctions: [{ name: 'a', filePath: 'a.ts', score: 0.9, fanIn: 9 }] };
    expect(passesRelevanceGate(r, cfg())).toBe(false);
  });

  it('passes on structural centrality (high fan-in) regardless of search mode', () => {
    const r = {
      searchMode: 'bm25_fallback',
      relevantFunctions: [
        { name: 'a', filePath: 'a.ts', score: 18, fanIn: 9 },
        { name: 'b', filePath: 'b.ts', score: 12, fanIn: 0 },
      ],
    };
    expect(passesRelevanceGate(r, cfg())).toBe(true);
  });

  it('passes on a hub match even with low fan-in numbers', () => {
    const r = {
      searchMode: 'bm25_fallback',
      relevantFunctions: [
        { name: 'a', filePath: 'a.ts', score: 1, fanIn: 1, isHub: true },
        { name: 'b', filePath: 'b.ts', score: 1, fanIn: 0 },
      ],
    };
    expect(passesRelevanceGate(r, cfg())).toBe(true);
  });

  it('uses the score path only on the bounded hybrid scale', () => {
    const weakStructural = [
      { name: 'a', filePath: 'a.ts', score: 0.42, fanIn: 0 },
      { name: 'b', filePath: 'b.ts', score: 0.1, fanIn: 0 },
    ];
    expect(passesRelevanceGate({ searchMode: 'hybrid', relevantFunctions: weakStructural }, cfg())).toBe(true);
    // Same weak-structural match under BM25 fallback gates down (score not comparable).
    expect(passesRelevanceGate({ searchMode: 'bm25_fallback', relevantFunctions: weakStructural }, cfg())).toBe(false);
  });

  it('gates down a sparse, low-score hybrid match', () => {
    const r = {
      searchMode: 'hybrid',
      relevantFunctions: [
        { name: 'a', filePath: 'a.ts', score: 0.12, fanIn: 0 },
        { name: 'b', filePath: 'b.ts', score: 0.08, fanIn: 1 },
      ],
    };
    expect(passesRelevanceGate(r, cfg())).toBe(false);
  });

  it('always gates down an error result', () => {
    expect(passesRelevanceGate({ error: 'No analysis found.' }, cfg())).toBe(false);
  });
});

describe('renderInjectionBlock', () => {
  const richResult = {
    task: 'add rate limiting to the API',
    searchMode: 'hybrid',
    relevantFiles: ['src/api/run.ts', 'src/api/limit.ts'],
    relevantFunctions: [
      { name: 'openloreRun', filePath: 'src/api/run.ts', score: 0.8, fanIn: 3 },
      { name: 'applyLimit', filePath: 'src/api/limit.ts', score: 0.7, fanIn: 1 },
    ],
    specDomains: ['api', 'cli'],
    callPaths: [
      {
        function: 'openloreRun',
        callers: [{ name: 'main', filePath: 'src/cli/index.ts' }],
        callees: [
          { name: 'applyLimit', filePath: 'src/api/limit.ts' },
          { name: 'log', filePath: 'src/utils/logger.ts' },
        ],
      },
    ],
    suggestedTools: ['orient', 'get_subgraph'],
  };

  it('is OpenLore-attributed, opens with an ignorable framing, and echoes the task', () => {
    const block = renderInjectionBlock(richResult, cfg());
    expect(block.startsWith('[OpenLore]')).toBe(true);
    expect(block.toLowerCase()).toContain('ignore');
    expect(block).toContain('Task: add rate limiting to the API');
    expect(block).toContain('openloreRun');
    expect(block).toContain('src/api/run.ts');
  });

  it('never exceeds the configured token budget (caps optional detail)', () => {
    const tight = cfg({ tokenBudget: 60 });
    const block = renderInjectionBlock(richResult, tight);
    expect(estimateTokens(block)).toBeLessThanOrEqual(60);
    // The mandatory header + task survive even under a tight budget.
    expect(block).toContain('[OpenLore]');
    expect(block).toContain('Task:');
    // …but the lower-priority detail is dropped to stay within budget.
    expect(block).not.toContain('Suggested tools');
  });

  it('includes more detail as the budget grows', () => {
    const small = renderInjectionBlock(richResult, cfg({ tokenBudget: 60 }));
    const large = renderInjectionBlock(richResult, cfg({ tokenBudget: 600 }));
    expect(large.length).toBeGreaterThan(small.length);
    expect(large).toContain('Suggested tools');
  });

  it('surfaces the regionStyle house-style line (Pi parity) when present, bounded', () => {
    const withStyle = {
      ...richResult,
      regionStyle: {
        scope: 'region',
        language: 'TypeScript',
        communityId: 'src/api/run.ts::openloreRun',
        dominantIdioms: ['binding=const (0.99)', 'functionNaming=camelCase (0.98)', 'asyncForm=await (0.97)'],
      },
    };
    const block = renderInjectionBlock(withStyle, cfg());
    expect(block).toContain('House style (TypeScript, region): binding=const (0.99)');
  });

  it('omits the house-style line when regionStyle is absent or empty (lean orient result)', () => {
    expect(renderInjectionBlock(richResult, cfg())).not.toContain('House style');
    const emptyStyle = { ...richResult, regionStyle: { scope: 'repository', language: 'Go', dominantIdioms: [] } };
    expect(renderInjectionBlock(emptyStyle, cfg())).not.toContain('House style');
  });

  it('never leaks "undefined", "[object Object]", or stray commas from a partial result', () => {
    // A forward-incompatible / partial orient payload: missing names, null array
    // elements, a call path with no function name. None must reach the agent.
    const partial = {
      task: 'partial result',
      searchMode: 'hybrid',
      relevantFiles: [undefined, 'src/a.ts'] as unknown as string[],
      relevantFunctions: [
        { name: undefined as unknown as string, filePath: 'src/a.ts', score: 0.5, fanIn: 2 },
        { name: 'ok', filePath: undefined as unknown as string },
      ],
      specDomains: [undefined as unknown as string, 'auth'],
      suggestedTools: [null as unknown as string, 'orient'],
      callPaths: [
        { function: undefined as unknown as string, callers: [{ name: 'c' }], callees: [] },
        { function: 'realFn', callers: [{ name: undefined as unknown as string }], callees: [{ name: 'd' }] },
      ],
    };
    const block = renderInjectionBlock(partial, cfg());
    expect(block).not.toContain('undefined');
    expect(block).not.toContain('[object Object]');
    expect(block).not.toMatch(/:\s*,/); // no "Spec domains: , auth" style leading comma
    expect(block).not.toMatch(/•\s+—/); // no "• — file" with a blank name
    // The well-formed bits still render.
    expect(block).toContain('src/a.ts');
    expect(block).toContain('realFn: ');
  });
});

describe('extractPrompt', () => {
  it('extracts the prompt field from a Claude Code hook JSON payload', () => {
    const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '  fix the cache  ' });
    expect(extractPrompt(payload)).toBe('fix the cache');
  });

  it('treats a raw (non-JSON) payload as the prompt', () => {
    expect(extractPrompt('add a CLI command')).toBe('add a CLI command');
  });

  it('returns empty for empty / whitespace / JSON-without-prompt', () => {
    expect(extractPrompt('')).toBe('');
    expect(extractPrompt('   ')).toBe('');
    expect(extractPrompt(JSON.stringify({ session_id: 'x' }))).toBe('');
  });
});

describe('buildInjection (fail-open integration)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-inject-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits the pointer line for an empty prompt', async () => {
    expect(await buildInjection(dir, '')).toBe(POINTER_LINE);
  });

  it('emits the pointer line when there is no analysis graph (never throws)', async () => {
    expect(await buildInjection(dir, 'some real task')).toBe(POINTER_LINE);
  });

  it('emits nothing when injection is disabled in config', async () => {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(
      join(dir, '.openlore', 'config.json'),
      JSON.stringify({ contextInjection: { mode: 'off' } }),
      'utf8'
    );
    expect(await buildInjection(dir, 'some real task')).toBe('');
  });
});
