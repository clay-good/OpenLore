/**
 * Non-code masking (change: add-phantom-reference-findings): what counts as code, what counts as
 * text, and the invariant every consumer relies on — the mask is the same length as its input and
 * keeps every line break, so a scanner's reported position still refers to the original file.
 */
import { describe, it, expect } from 'vitest';
import { maskFlavorFor, maskNonCode } from './code-mask.js';

/** The mask must never move a character: same length, same newline positions. */
const invariant = (src: string, flavor: 'js' | 'python') => {
  const masked = maskNonCode(src, flavor);
  expect(masked).toHaveLength(src.length);
  expect([...masked].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0))
    .toEqual([...src].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0));
  return masked;
};

describe('maskNonCode — JavaScript and TypeScript', () => {
  it('keeps a module specifier and blanks every other string body', () => {
    const src = "import a from './keep';\nconst s = 'drop me';\nconst r = require('./keep2');\n";
    const masked = invariant(src, 'js');
    expect(masked).toContain("import a from './keep';");
    expect(masked).toContain("require('./keep2')");
    expect(masked).not.toContain('drop me');
  });

  it('blanks a template literal, including an import written inside one', () => {
    const src = ['const fixture = `', "import { ghost } from './ghost';", '`;', "import { real } from './real';"].join('\n');
    const masked = invariant(src, 'js');
    expect(masked).not.toContain('ghost');
    expect(masked).toContain("import { real } from './real';");
  });

  it('blanks line and block comments', () => {
    const src = "// import { c } from './c';\n/* import { d } from './d'; */\nimport { e } from './e';\n";
    const masked = invariant(src, 'js');
    expect(masked).not.toContain('./c');
    expect(masked).not.toContain('./d');
    expect(masked).toContain("import { e } from './e';");
  });

  it('survives a quote inside a regex literal', () => {
    const src = "const RE = /['\"]/;\nimport { foo } from './x';\n";
    expect(invariant(src, 'js')).toContain("import { foo } from './x';");
  });

  it('survives an apostrophe in JSX prose, because a quoted string cannot span a line', () => {
    const src = "export const C = () => <p>It's fine</p>;\nexport { a } from './x';\n";
    expect(invariant(src, 'js')).toContain("from './x';");
  });

  it('keeps a specifier that follows a dynamic import', () => {
    const src = "const m = await import('./lazy');\n";
    expect(invariant(src, 'js')).toContain("import('./lazy')");
  });

  it('blanks a string that merely looks like an import statement', () => {
    const src = "export const T = \"import React from 'react';\";\n";
    const masked = invariant(src, 'js');
    expect(masked).not.toContain('react');
  });

  it('leaves an unterminated template or string without losing the rest of the file', () => {
    // The invariant helper asserts the length and newline positions; what matters here is that an
    // unterminated opener does not blank the remainder of the file away from the scanners.
    expect(invariant('const a = `unclosed\nimport x from "./y";\n', 'js')).toContain('const a = `');
    expect(invariant("const a = 'unclosed\nimport x from './y';\n", 'js')).toContain('import x from');
  });
});

describe('maskNonCode — Python', () => {
  it('blanks a docstring, including an import inside it', () => {
    const src = ['"""', 'Example:', '    import ghostlib', '"""', 'import os', ''].join('\n');
    const masked = invariant(src, 'python');
    expect(masked).not.toContain('ghostlib');
    expect(masked).toContain('import os');
  });

  it('blanks a # comment and keeps the imports after it, even with an apostrophe in it', () => {
    const src = "# Don't do this: import ghostlib\nimport real\nfrom .mod import thing\n";
    const masked = invariant(src, 'python');
    expect(masked).not.toContain('ghostlib');
    expect(masked).toContain('import real');
    expect(masked).toContain('from .mod import thing');
  });

  it('does not treat a JavaScript comment marker as a comment', () => {
    const src = "x = 1  # see /* note\nimport real\n";
    expect(invariant(src, 'python')).toContain('import real');
  });

  it('blanks an ordinary single-line string', () => {
    const masked = invariant("DOC = 'import inline_ghost'\nimport real\n", 'python');
    expect(masked).not.toContain('inline_ghost');
    expect(masked).toContain('import real');
  });
});

describe('flavor selection', () => {
  it('masks only the languages whose imports this check reads', () => {
    expect(maskFlavorFor('TypeScript')).toBe('js');
    expect(maskFlavorFor('JavaScript')).toBe('js');
    expect(maskFlavorFor('Python')).toBe('python');
    expect(maskFlavorFor('Go')).toBeNull();
    expect(maskFlavorFor('Ruby')).toBeNull();
  });
});

describe('round-3 regressions', () => {
  it('reads a regex literal that follows a keyword, not as division', () => {
    const src = "export function f(s: string) { return /import y from 'phantom-pkg'/.test(s); }\n";
    expect(invariant(src, 'js')).not.toContain('phantom-pkg');
    for (const keyword of ['typeof', 'case', 'new', 'delete', 'void', 'yield', 'do', 'throw', 'await', 'in', 'of']) {
      expect(maskNonCode(`x = ${keyword} /'ghost-pkg'/;\n`, 'js')).not.toContain('ghost-pkg');
    }
  });

  it('still reads a slash after a value as division', () => {
    for (const src of ['const r = a / b / c;\n', 'const r = (x) / 2;\n', 'const r = arr[0] / 2;\n']) {
      expect(invariant(src, 'js')).toBe(src);
    }
  });

  it('blanks a template nested inside an interpolation', () => {
    const src = "const t = `wrap ${`import y from 'phantom-pkg'`} end`;\nimport { real } from './real';\n";
    const masked = invariant(src, 'js');
    expect(masked).not.toContain('phantom-pkg');
    expect(masked).toContain("import { real } from './real';");
  });

  it('blanks a template whose interpolation holds braces and quotes', () => {
    const src = "const t = `a ${ { k: '}' } } b ${ \"}\" } c`;\nimport { real } from './real';\n";
    const masked = invariant(src, 'js');
    expect(masked).toContain("import { real } from './real';");
  });

  it('is linear on an unterminated regex character class', () => {
    for (const n of [25_000, 200_000]) {
      const started = Date.now();
      maskNonCode('/['.repeat(n), 'js');
      expect(Date.now() - started, `n=${n}`).toBeLessThan(2_000);
    }
  });

  it('is linear on deeply nested templates', () => {
    const started = Date.now();
    maskNonCode('`${`'.repeat(100_000), 'js');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('cost', () => {
  it('is linear on adversarial input', () => {
    for (const src of ['/*a'.repeat(200_000), "'".repeat(400_000), '`'.repeat(200_000), 'x'.repeat(600_000)]) {
      const started = Date.now();
      maskNonCode(src, 'js');
      expect(Date.now() - started).toBeLessThan(2_000);
    }
    const started = Date.now();
    maskNonCode("#'".repeat(200_000), 'python');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('round-4 regressions', () => {
  it('does not read a property access as a keyword before a slash', () => {
    const src = "const a = obj.in / 2, b = require('./real') / 3;\n";
    expect(invariant(src, 'js')).toContain("require('./real')");
    for (const access of ['x.new', 'obj.of', 'o.return', 'a_in', 'case_']) {
      expect(maskNonCode(`const v = ${access} / 2, w = require('./real');\n`, 'js'), access).toContain("'./real'");
    }
  });

  it('keeps the file readable when an interpolation holds an unbalanced brace', () => {
    const src = "const t = `a ${s.replace(/[{]/g, '')} b`;\nimport x from './real';\n";
    expect(invariant(src, 'js')).toContain("import x from './real';");
  });

  it('blanks past an over-long unterminated regex instead of opening a comment', () => {
    const src = `const r = /[/*]${'x'.repeat(1100)}/;\nimport x from './real';\n`;
    expect(invariant(src, 'js')).toContain("import x from './real';");
  });
});
