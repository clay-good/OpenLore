/**
 * Deprecation markers (change: add-deprecation-propagation): only each language's standard
 * structural marker counts, never the word "deprecated" in prose. Plain .test.ts so CI runs it.
 */
import { describe, it, expect } from 'vitest';
import { extractDeprecation, extractDocstringBefore, MAX_DEPRECATION_HINT, DEPRECATION_MARKER_LANGUAGES } from './call-graph-extract.js';
import { CallGraphBuilder, serializeCallGraph } from './call-graph.js';
import { languageSupport, ALL_LANGUAGES } from './language-support.js';

/** The marker on the declaration that starts at `decl` inside `src`. */
function at(src: string, decl: string, language: string) {
  const i = src.indexOf(decl);
  if (i < 0) throw new Error(`fixture has no "${decl}"`);
  return extractDeprecation(src, i, language);
}

describe('TypeScript / JavaScript: JSDoc @deprecated', () => {
  it('reads the tag and its hint, up to the next tag', () => {
    const src = '/**\n * Old.\n * @deprecated Use newApi\n *   instead.\n * @param x it\n */\nfunction oldApi(x) {}\n';
    expect(at(src, 'function oldApi', 'TypeScript')).toEqual({ hint: 'Use newApi instead.' });
    expect(at(src, 'function oldApi', 'JavaScript')).toEqual({ hint: 'Use newApi instead.' });
  });
  it('reads a one-line block and a tag with no hint', () => {
    expect(at('/** @deprecated */\nexport function f() {}', 'export function f', 'TypeScript')).toEqual({ hint: '' });
  });
  it('ignores prose, plain block comments, and a block that is not immediately before', () => {
    expect(at('/** This used to be @deprecated but is fine. */\nfunction f() {}', 'function f', 'TypeScript')).toBeUndefined();
    expect(at('// @deprecated\nfunction f() {}', 'function f', 'TypeScript')).toBeUndefined();
    expect(at('/* @deprecated */\nfunction f() {}', 'function f', 'TypeScript')).toBeUndefined();
    expect(at('/** @deprecated */\nconst x = 1;\nfunction f() {}', 'function f', 'TypeScript')).toBeUndefined();
    expect(at('/** @deprecatedish */\nfunction f() {}', 'function f', 'TypeScript')).toBeUndefined();
  });
  it('bounds the hint', () => {
    const r = at(`/** @deprecated ${'x '.repeat(400)} */\nfunction f() {}`, 'function f', 'TypeScript');
    expect(r!.hint.length).toBe(MAX_DEPRECATION_HINT);
  });
});

describe('Go: a Deprecated: paragraph', () => {
  it('reads a paragraph after a blank comment line, with continuation lines', () => {
    const src = 'package p\n\n// Old does x.\n//\n// Deprecated: use New\n// instead.\nfunc Old() {}\n';
    expect(at(src, 'func Old', 'Go')).toEqual({ hint: 'use New instead.' });
  });
  it('reads a comment that starts with the paragraph', () => {
    expect(at('package p\n// Deprecated: gone.\nfunc Old() {}\n', 'func Old', 'Go')).toEqual({ hint: 'gone.' });
  });
  it('ignores "Deprecated:" in the middle of a paragraph and prose mentions', () => {
    expect(at('package p\n// Old does x.\n// Deprecated: not a paragraph.\nfunc Old() {}\n', 'func Old', 'Go')).toBeUndefined();
    expect(at('package p\n// This API is deprecated.\nfunc Old() {}\n', 'func Old', 'Go')).toBeUndefined();
  });
});

describe('Python: PEP 702 decorators', () => {
  it('reads @warnings.deprecated, @typing_extensions.deprecated, and @deprecated with their message', () => {
    expect(at('@warnings.deprecated("use g")\ndef f():\n    pass\n', '@warnings', 'Python')).toEqual({ hint: 'use g' });
    expect(at("@typing_extensions.deprecated('use h')\ndef f(): pass\n", '@typing', 'Python')).toEqual({ hint: 'use h' });
    expect(at('@cache\n@deprecated(reason="old")\nasync def f(): pass\n', '@cache', 'Python')).toEqual({ hint: 'old' });
    expect(at('@deprecated\ndef f(): pass\n', '@deprecated', 'Python')).toEqual({ hint: '' });
  });
  it('ignores other decorators, docstrings, and decorators of a later function', () => {
    expect(at('@deprecated_alias("x")\ndef f(): pass\n', '@deprecated_alias', 'Python')).toBeUndefined();
    expect(at('def f():\n    """Deprecated: use g."""\n    pass\n', 'def f', 'Python')).toBeUndefined();
    expect(at('def f():\n    pass\n@deprecated("x")\ndef g(): pass\n', 'def f', 'Python')).toBeUndefined();
  });
});

describe('scope', () => {
  it('reads nothing for a language it does not cover', () => {
    expect(at('/** @deprecated */\nvoid f() {}', 'void f', 'Java')).toBeUndefined();
  });
  it('the registry claims deprecationMarkers for exactly the covered languages', () => {
    for (const lang of ALL_LANGUAGES) {
      expect(languageSupport(lang).capabilities.includes('deprecationMarkers'), lang).toBe(DEPRECATION_MARKER_LANGUAGES.has(lang));
    }
  });
});

describe('the live extractor records the marker on the node', () => {
  it('for every covered language (so the registry cannot over-claim)', async () => {
    const g = serializeCallGraph(await new CallGraphBuilder().build([
      { path: 'a.ts', language: 'TypeScript', content: '/** @deprecated use b */\nexport function a() {}\nexport class K {\n  /** @deprecated */\n  public static m() {}\n}\nexport function b() {}\n' },
      { path: 'j.js', language: 'JavaScript', content: '/** @deprecated use k */\nfunction j() {}\n' },
      { path: 'g.go', language: 'Go', content: 'package p\n\n// Deprecated: use New.\nfunc Old() {}\n' },
      { path: 'p.py', language: 'Python', content: 'import warnings\n@warnings.deprecated("use q")\ndef p():\n    pass\n' },
    ]));
    const dep = Object.fromEntries(g.nodes.filter(n => !n.isExternal).map(n => [n.id, n.deprecation]));
    expect(dep).toMatchObject({
      'a.ts::a': 'use b', 'a.ts::K.m': '', 'j.js::j': 'use k', 'g.go::Old': 'use New.', 'p.py::p': 'use q',
    });
    expect(dep['a.ts::b']).toBeUndefined();
    // JS nodes are tagged TypeScript by the shared extractor, so coverage is checked by fixture file.
    const fileLanguage: Record<string, string> = { 'a.ts': 'TypeScript', 'j.js': 'JavaScript', 'g.go': 'Go', 'p.py': 'Python' };
    const covered = new Set(g.nodes.filter(n => n.deprecation !== undefined).map(n => fileLanguage[n.filePath]));
    for (const lang of DEPRECATION_MARKER_LANGUAGES) expect(covered.has(lang), lang).toBe(true);
  });
});

describe('TypeScript declaration prefixes', () => {
  it('looks past export / modifiers and a const binding', () => {
    const src = '/** @deprecated use g */\nexport const f = () => 1;\n/** @deprecated */\nexport default async function h() {}\n';
    expect(at(src, '() => 1', 'TypeScript')).toEqual({ hint: 'use g' });
    expect(at(src, 'async function h', 'TypeScript')).toEqual({ hint: '' });
    expect(at('/** @deprecated */\nexport const x: Foo<Bar> = () => 1;', '() => 1', 'TypeScript')).toEqual({ hint: '' });
  });
});

describe('docstrings use the same declaration-prefix rule', () => {
  it('keeps the JSDoc line of exported and const-bound functions', () => {
    const src = '/** Adds one. */\nexport function inc(x) { return x + 1; }\n/** Doubles. */\nexport const dbl = (x) => x * 2;\n/** Plain. */\nfunction p() {}\n';
    expect(extractDocstringBefore(src, src.indexOf('function inc'), 'TypeScript')).toBe('Adds one.');
    expect(extractDocstringBefore(src, src.indexOf('(x) => x * 2'), 'TypeScript')).toBe('Doubles.');
    expect(extractDocstringBefore(src, src.indexOf('function p'), 'JavaScript')).toBe('Plain.');
    expect(extractDocstringBefore('const y = 1;\nexport function q() {}', 'const y = 1;\nexport '.length, 'TypeScript')).toBeUndefined();
  });
});
