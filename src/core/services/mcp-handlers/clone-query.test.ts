/**
 * Tests for the `find_clones` handler (change: add-clone-query-tool).
 *
 * Drives the handler over a hand-written analysis cache (llm-context.json) so the
 * test is deterministic and offline — no real `analyze` run required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleFindClones } from './clone-query.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../../constants.js';

const QUERY = `function computeTotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}
`;

const EXACT = `function computeTotal(items) {
  // recalc
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}
`;

const UNRELATED = `function greet(name) {
  const msg = 'hi ' + name;
  console.log(msg);
  console.log(msg);
  return msg;
}
`;

// A C-family body that is byte-identical in TypeScript and C++ (a real cross-language clone).
// Deliberately a DIFFERENT shape from QUERY (no loop) so it does not collide with the computeTotal
// fixtures above.
const PROC = `function process(input) {
  if (input == null) {
    return false;
  }
  const size = input.length;
  return size > 0;
}
`;

interface CacheNode {
  id: string;
  name: string;
  filePath: string;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  language: string;
}

let dir: string;

function node(id: string, name: string, filePath: string, body: string): CacheNode {
  return {
    id,
    name,
    filePath,
    startIndex: 0,
    endIndex: body.length,
    startLine: 1,
    endLine: body.split('\n').length,
    language: 'TypeScript',
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clone-query-'));
  // Source files (the handler re-reads these to slice/fingerprint bodies).
  writeFileSync(join(dir, 'query.ts'), QUERY, 'utf-8');
  writeFileSync(join(dir, 'exact.ts'), EXACT, 'utf-8');
  writeFileSync(join(dir, 'other.ts'), UNRELATED, 'utf-8');
  // A C-family body byte-identical in TypeScript and C++ — a real cross-language clone, distinct from
  // computeTotal so the existing assertions are unaffected.
  writeFileSync(join(dir, 'proc.ts'), PROC, 'utf-8');
  writeFileSync(join(dir, 'proc.cpp'), PROC, 'utf-8');

  const nodes: CacheNode[] = [
    node('q', 'computeTotal', 'query.ts', QUERY),
    node('e', 'computeTotal', 'exact.ts', EXACT),
    node('o', 'greet', 'other.ts', UNRELATED),
    { ...node('pts', 'process', 'proc.ts', PROC), language: 'TypeScript' },
    { ...node('pcpp', 'process', 'proc.cpp', PROC), language: 'C++' },
    // An HTML inline-script symbol — excluded from comparison (disclosed).
    { id: 'h', name: 'onClick', filePath: 'page.html', startIndex: 0, endIndex: 80, startLine: 1, endLine: 6, language: 'JavaScript' },
    // A bodyless external/synthesized symbol (startIndex >= endIndex) — not comparable.
    { id: 'x', name: 'externalThing', filePath: 'ext.ts', startIndex: 0, endIndex: 0, startLine: 0, endLine: 0, language: 'TypeScript' },
  ];
  const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(
    join(analysisDir, ARTIFACT_LLM_CONTEXT),
    JSON.stringify({ callGraph: { nodes, edges: [] } }),
    'utf-8',
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleFindClones', () => {
  it('finds an exact clone of a symbol and excludes the symbol itself', async () => {
    const res = (await handleFindClones({ directory: dir, symbol: 'computeTotal::query.ts' })) as {
      summary: { exact: number; total: number };
      matches: Array<{ file: string; type: string }>;
      query: { mode: string };
    };
    expect(res.query.mode).toBe('symbol');
    expect(res.matches.map(m => m.file)).toContain('exact.ts');
    // The query's own instance is excluded, and the unrelated function is not a match.
    expect(res.matches.map(m => m.file)).not.toContain('query.ts');
    expect(res.matches.map(m => m.file)).not.toContain('other.ts');
    expect(res.summary.exact).toBe(1);
  });

  it('snippet mode finds an existing near-duplicate of code not in the index', async () => {
    const res = (await handleFindClones({ directory: dir, snippet: QUERY })) as {
      matches: Array<{ file: string }>;
      query: { mode: string };
    };
    expect(res.query.mode).toBe('snippet');
    // The snippet matches both indexed copies (query.ts and exact.ts) — nothing is excluded.
    expect(res.matches.map(m => m.file).sort()).toEqual(['exact.ts', 'query.ts']);
  });

  it('returns an explicit not-found (with candidates) for an unknown symbol', async () => {
    const res = (await handleFindClones({ directory: dir, symbol: 'computeTot' })) as {
      error: string;
      candidates: string[];
    };
    expect(res.error).toMatch(/No indexed function/);
    // near-miss suggestion by substring
    expect(res.candidates).toContain('computeTotal');
  });

  it('reports ambiguity when a bare name matches multiple functions', async () => {
    const res = (await handleFindClones({ directory: dir, symbol: 'computeTotal' })) as {
      error: string;
      candidates: string[];
    };
    expect(res.error).toMatch(/ambiguous/);
    expect(res.candidates.length).toBe(2);
  });

  it('rejects when neither or both query forms are supplied', async () => {
    const neither = (await handleFindClones({ directory: dir })) as { error: string };
    expect(neither.error).toMatch(/exactly one/);
    const both = (await handleFindClones({ directory: dir, symbol: 'computeTotal', snippet: 'x' })) as { error: string };
    expect(both.error).toMatch(/exactly one/);
  });

  it('reports belowThreshold for a tiny snippet', async () => {
    const res = (await handleFindClones({ directory: dir, snippet: 'const x = 1;' })) as {
      belowThreshold: boolean;
      matches: unknown[];
    };
    expect(res.belowThreshold).toBe(true);
    expect(res.matches).toHaveLength(0);
  });

  it('reports "exists but not comparable" for a bodyless/external symbol (not a false not-found)', async () => {
    const res = (await handleFindClones({ directory: dir, symbol: 'externalThing' })) as {
      error: string;
      candidates?: string[];
    };
    expect(res.error).toMatch(/in the index but has no comparable body/);
    // It must NOT offer the typed name back as a "did you mean" candidate.
    expect(res.candidates).toBeUndefined();
  });

  it('surfaces a cross-language clone with its own language (query TS, clone C++)', async () => {
    const res = (await handleFindClones({ directory: dir, symbol: 'process::proc.ts' })) as {
      query: { language?: string };
      matches: Array<{ file: string; language?: string }>;
    };
    expect(res.query.language).toBe('TypeScript');
    const cpp = res.matches.find(m => m.file === 'proc.cpp');
    expect(cpp).toBeDefined();
    expect(cpp!.language).toBe('C++'); // different from the query's TypeScript — the ⚠ case
  });

  it('discloses HTML inline-script exclusions only when present', async () => {
    const res = (await handleFindClones({ directory: dir, symbol: 'computeTotal::query.ts' })) as {
      htmlExcluded?: number;
      note: string;
    };
    expect(res.htmlExcluded).toBe(1);
    expect(res.note).toMatch(/HTML inline-script/);
  });

  it('a NaN maxResults does not produce unlimited results (NaN-safe)', async () => {
    const res = (await handleFindClones({ directory: dir, snippet: QUERY, maxResults: NaN })) as {
      matches: unknown[];
    };
    // Defaults to the bounded limit rather than slicing with NaN (which would return everything).
    expect(Array.isArray(res.matches)).toBe(true);
    expect(res.matches.length).toBeLessThanOrEqual(25);
  });

  it('a NaN minSimilarity falls back to the default floor (not a null floor)', async () => {
    const res = (await handleFindClones({ directory: dir, snippet: QUERY, minSimilarity: NaN })) as {
      similarityFloor: number;
    };
    expect(res.similarityFloor).toBe(0.7);
  });

  it('guards on missing analysis', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'clone-query-empty-'));
    try {
      const res = (await handleFindClones({ directory: empty, snippet: QUERY })) as { error: string };
      expect(res.error).toMatch(/No analysis found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
