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

  const nodes: CacheNode[] = [
    node('q', 'computeTotal', 'query.ts', QUERY),
    node('e', 'computeTotal', 'exact.ts', EXACT),
    node('o', 'greet', 'other.ts', UNRELATED),
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
