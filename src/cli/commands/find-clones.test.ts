/**
 * Tests for the `openlore find-clones` CLI renderer (change: add-clone-query-tool) —
 * specifically the cross-language ⚠ flag in the human output.
 */

import { describe, it, expect } from 'vitest';
import { renderHuman, type CloneQueryView } from './find-clones.js';

function view(matchLang: string, queryLang = 'TypeScript'): CloneQueryView {
  return {
    query: { mode: 'symbol', symbol: 'process::a.ts', language: queryLang, startLine: 1, endLine: 7 },
    similarityFloor: 0.7,
    comparedAgainst: 2,
    summary: { exact: 1, structural: 0, near: 0, total: 1 },
    matches: [
      { type: 'exact', similarity: 1, file: 'b.cpp', functionName: 'process', startLine: 1, endLine: 7, language: matchLang },
    ],
  };
}

describe('find-clones renderHuman — cross-language flag', () => {
  it('flags a match in a different language than the query with ⚠ <language>', () => {
    const out = renderHuman(view('C++'));
    expect(out).toContain('⚠ C++');
  });

  it('does NOT flag a same-language match', () => {
    const out = renderHuman(view('TypeScript'));
    expect(out).not.toContain('⚠');
  });

  it('does not flag when the query language is unknown (snippet mode)', () => {
    const out = renderHuman({
      query: { mode: 'snippet', lines: 7 },
      similarityFloor: 0.7,
      comparedAgainst: 2,
      summary: { exact: 1, structural: 0, near: 0, total: 1 },
      matches: [{ type: 'exact', similarity: 1, file: 'b.cpp', functionName: 'process', startLine: 1, endLine: 7, language: 'C++' }],
    });
    // No query language to compare against → no cross-language claim.
    expect(out).not.toContain('⚠');
  });
});
