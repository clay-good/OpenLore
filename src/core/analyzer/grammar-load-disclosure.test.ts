/** Regression coverage for change: harden-grammar-load-disclosure. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../utils/logger.js';
import {
  CallGraphBuilder,
  __resetGrammarCacheForTests,
  __setNativeQueryForTests,
  grammarStatus,
} from './call-graph.js';

const tsFiles = [
  { path: 'src/a.ts', language: 'TypeScript', content: 'export function a() { return 1; }' },
  { path: 'src/b.ts', language: 'TypeScript', content: 'export function b() { return a(); }' },
];

afterEach(() => {
  vi.doUnmock('tree-sitter-javascript');
  vi.doUnmock('tree-sitter-typescript');
  vi.restoreAllMocks();
  __resetGrammarCacheForTests();
});

describe('core grammar availability disclosure', () => {
  it('warns once and emits one exact language boundary when a core grammar is absent', async () => {
    __resetGrammarCacheForTests();
    vi.doMock('tree-sitter-typescript', () => ({ default: undefined }));
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    const result = await new CallGraphBuilder().build(tsFiles);

    expect(result.nodes.size).toBe(0);
    expect(result.parseHealthByFile).toBeUndefined();
    expect(result.grammarUnavailable).toEqual([{
      language: 'TypeScript',
      fileCount: 2,
      reason: 'load-failure',
      detail: expect.stringContaining('tree-sitter'),
    }]);
    expect(grammarStatus('TypeScript')).toBe('unavailable');
    expect(warning.mock.calls.filter(call => String(call[0]).includes('TypeScript grammar unavailable')))
      .toHaveLength(1);
    expect(String(warning.mock.calls[0]?.[0])).toContain('indexed for search but not graphed');
  });

  it('turns an incompatible native query into the same disclosed boundary', async () => {
    // Warm the real parser/grammar, then emulate a grammar version whose node vocabulary rejects
    // OpenLore's pinned query. The source parser still works; only query construction drifts.
    await new CallGraphBuilder().build([tsFiles[0]]);
    class IncompatibleQuery {
      constructor() {
        throw new Error('invalid node type at position 17');
      }
    }
    __setNativeQueryForTests(IncompatibleQuery as never);
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    const result = await new CallGraphBuilder().build(tsFiles);

    expect(result.grammarUnavailable).toEqual([{
      language: 'TypeScript',
      fileCount: 2,
      reason: 'query-incompatible',
      detail: expect.stringContaining('invalid node type'),
    }]);
    expect(result.nodes.size).toBe(0);
    expect(grammarStatus('TypeScript')).toBe('unavailable');
    expect(warning.mock.calls.filter(call => String(call[0]).includes('TypeScript grammar unavailable')))
      .toHaveLength(1);
  });

  it('discloses every unavailable lane in a mixed-language script container', async () => {
    const file = {
      path: 'src/App.vue',
      language: 'Vue',
      content: [
        '<script>function plain() {}</script>',
        '<script lang="ts">function typed(value: number) { return value; }</script>',
      ].join('\n'),
    };
    await new CallGraphBuilder().build([file]);
    class IncompatibleQuery {
      constructor() {
        throw new Error('invalid node type at position 17');
      }
    }
    __setNativeQueryForTests(IncompatibleQuery as never);
    vi.spyOn(logger, 'warning').mockImplementation(() => {});

    const result = await new CallGraphBuilder().build([file]);

    expect(result.grammarUnavailable?.map(boundary => boundary.language))
      .toEqual(['JavaScript', 'TypeScript']);
  });
});
