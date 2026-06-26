import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

import { computeGetLanguageSupport, type GetLanguageSupportResult } from './language-support.js';
import { readCachedContext } from './utils.js';
import { assertConclusionShape, TOOL_OUTPUT_CLASS } from './tool-contract.js';
import type { FunctionNode, SerializedCallGraph } from '../../analyzer/call-graph.js';

function node(over: Partial<FunctionNode> & { id: string; language: string }): FunctionNode {
  return {
    name: over.id, filePath: 'x', isAsync: false, startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0,
    ...over,
  };
}
function graph(nodes: FunctionNode[]): SerializedCallGraph {
  return { nodes, edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 } } as SerializedCallGraph;
}

beforeEach(() => vi.clearAllMocks());

const run = (input: Parameters<typeof computeGetLanguageSupport>[0]) =>
  computeGetLanguageSupport(input) as Promise<GetLanguageSupportResult>;

describe('get_language_support — named-language mode (pure registry, no analysis)', () => {
  it('returns the capability set for a known language', async () => {
    const res = await run({ directory: '/p', language: 'Go' });
    expect(res.mode).toBe('language');
    const view = res.languages[0];
    expect(view.language).toBe('Go');
    expect(view.known).toBe(true);
    expect(view.supported).toContain('callGraph');
    expect(view.supported).toContain('cfgOverlay');
    expect(view.supported).toContain('typeInference');
    // Go HAS a style fingerprint (binding := vs var measured; naming-case enforced → null).
    expect(view.supported).toContain('styleFingerprint');
    // Go is NOT in the live import path → honestly unclaimed.
    expect(view.unsupported).toContain('imports');
    // named mode never reads the index
    expect(readCachedContext).not.toHaveBeenCalled();
  });

  it('fail-soft: an unknown language is labeled, not errored', async () => {
    const res = await run({ directory: '/p', language: 'Haskell' });
    const view = res.languages[0];
    expect(view.known).toBe(false);
    expect(view.supported).toEqual([]);
    expect(res.summary).toMatch(/not a recognized language/i);
  });

  it('resolves a language name case-insensitively + trims (go / GO / " Go " → Go)', async () => {
    for (const input of ['go', 'GO', ' Go ', 'gO']) {
      const view = (await run({ directory: '/p', language: input })).languages[0];
      expect(view.known, `${JSON.stringify(input)} should resolve to Go`).toBe(true);
      expect(view.language).toBe('Go');
      expect(view.supported).toContain('callGraph');
    }
    // multi-word IaC tag resolves case-insensitively too
    expect((await run({ directory: '/p', language: 'docker compose' })).languages[0].language).toBe('Docker Compose');
  });
});

describe('get_language_support — repo mode (coverage over detected languages)', () => {
  it('reports the matrix over the languages detected in the index', async () => {
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: graph([
        node({ id: 'a', language: 'TypeScript' }),
        node({ id: 'b', language: 'Go' }),
        node({ id: 'c', language: 'Kotlin' }),
        node({ id: 'ext', language: 'TypeScript', isExternal: true }), // excluded
        node({ id: 'u', language: 'unknown' }), // excluded
      ]),
    } as never);
    const res = await run({ directory: '/p' });
    expect(res.mode).toBe('repo');
    expect(res.detectedLanguages).toEqual(['Go', 'Kotlin', 'TypeScript']); // sorted, ext/unknown dropped
    const kotlin = res.languages.find(l => l.language === 'Kotlin')!;
    // Kotlin has callGraph + signatures but NOT cfgOverlay/typeInference — the interpretable gap.
    expect(kotlin.supported).toContain('callGraph');
    expect(kotlin.unsupported).toContain('cfgOverlay');
    expect(kotlin.unsupported).toContain('typeInference');
    expect(kotlin.detectedInRepo).toBe(true);
  });

  it('errors when no analysis is cached (repo mode)', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null as never);
    const res = await computeGetLanguageSupport({ directory: '/p' });
    expect(res).toHaveProperty('error');
  });

  it('a docs-only / zero-detected repo returns NO languages (not the whole registry)', async () => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph([]) } as never);
    const res = await run({ directory: '/p' });
    expect(res.detectedLanguages).toEqual([]);
    // Regression guard: the languages[] array must NOT contradict detectedLanguages by
    // expanding to all ~30 registry languages falsely marked detectedInRepo:true.
    expect(res.languages).toEqual([]);
    expect(res.summary).toMatch(/No languages detected/i);
  });
});

describe('get_language_support — contract', () => {
  it('is classified as a conclusion tool', () => {
    expect(TOOL_OUTPUT_CLASS.get_language_support).toBe('conclusion');
  });

  it('passes the conclusion-over-graph shape contract', async () => {
    const res = await run({ directory: '/p', language: 'Rust' });
    expect(() => assertConclusionShape('get_language_support', res)).not.toThrow();
    expect(res.disclosure).toMatch(/fail-soft/i);
    expect(res.capabilities.length).toBeGreaterThan(0);
  });
});
