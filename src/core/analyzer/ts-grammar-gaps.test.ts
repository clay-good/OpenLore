import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import { maskTypeScriptGrammarGaps } from './ts-grammar-gaps.js';

const parser = new Parser();
parser.setLanguage((TS as unknown as { typescript: Parser.Language }).typescript);
const hasError = (s: string) => parser.parse(s).rootNode.hasError;

describe('maskTypeScriptGrammarGaps', () => {
  const GAPS = [
    "const m = new Map<string, import('./a.js').T[]>();",
    "function f(x?: import('./a.js').N[]) {}",
    "const a = await g<typeof import('node:fs')>();",
    "const t = using === 'a' ? 1 : 2;",
    'let x = using;',
    'f(using);',
    'if (using) {}',
    'const s = `action (using: ${using})`;',
    "export type * from './types.js';",
  ];

  it('each construct fails to parse as written and parses cleanly once masked', () => {
    for (const s of GAPS) {
      expect(hasError(s), s).toBe(true);
      expect(hasError(maskTypeScriptGrammarGaps(s)), s).toBe(false);
    }
  });

  it('is length-preserving and keeps every line break, so offsets and lines match the file', () => {
    const src = GAPS.join('\n') + "\nconst q = import('./lazy.js').then(m => m);\n";
    const masked = maskTypeScriptGrammarGaps(src);
    expect(masked.length).toBe(src.length);
    expect([...masked].map((c, i) => (c === '\n') === (src[i] === '\n')).every(Boolean)).toBe(true);
  });

  it('leaves runtime imports, declarations, calls, members and declared names alone', () => {
    for (const s of [
      "const mod = await import('./a.js');",
      "import('./lazy.js').then(m => m.run());",
      'using r = open();',
      'await using r = open();',
      'using(1);',
      'x.using = 1;',
      'function using() {}',
      'const using = 1;',
      "type X = import('./a.js').T;",
    ]) {
      const masked = maskTypeScriptGrammarGaps(s);
      if (s.startsWith('type X')) expect(hasError(masked), s).toBe(false);
      else expect(masked, s).toBe(s);
    }
  });
});
