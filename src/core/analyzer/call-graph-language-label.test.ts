/** A function's `language` is its file's language (ROADMAP P0, #724: JS and JSX were labeled TypeScript). */
import { describe, expect, it } from 'vitest';
import { extractFileWithContentHashes } from './call-graph.js';

const SRC = 'export function greet(name) { return helper(name); }\nfunction helper(n) { return n; }\n';

describe('call-graph language label', () => {
  it.each([
    ['src/a.js', 'JavaScript', 'JavaScript'],
    ['src/a.mjs', 'JavaScript', 'JavaScript'],
    ['src/a.cjs', 'JavaScript', 'JavaScript'],
    ['src/a.jsx', 'JavaScript', 'JavaScript'],
    ['src/a.ts', 'TypeScript', 'TypeScript'],
    ['src/a.tsx', 'TypeScript', 'TypeScript'],
  ])('%s → %s', async (path, fileLanguage, expected) => {
    const r = await extractFileWithContentHashes({ path, content: SRC, language: fileLanguage });
    expect([...new Set(r?.nodes.map(n => n.name))].sort()).toEqual(['greet', 'helper']);
    expect(new Set(r?.nodes.map(n => n.language))).toEqual(new Set([expected]));
  });
});
