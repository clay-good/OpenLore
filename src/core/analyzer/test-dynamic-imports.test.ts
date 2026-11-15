import { describe, expect, it } from 'vitest';
import { dynamicImportNames } from './test-dynamic-imports.js';

const names = (src: string) => dynamicImportNames(src).map(n => `${n.name}@${n.specifier}`);

describe('dynamicImportNames', () => {
  it('reads destructured names, including renamed and multi-line ones', () => {
    expect(names("const { a, b: c } = await import('./x.js');")).toEqual(['a@./x.js', 'b@./x.js']);
    expect(names('const {\n  runHook,\n  ...rest\n} = await import("../hook.js");')).toEqual(['runHook@../hook.js']);
  });

  it('reads a member of the awaited module and a typeof import', () => {
    expect(names("return (await import('./hook.js')).runHook;")).toEqual(['runHook@./hook.js']);
    expect(names("type R = typeof import('./hook.js').runHook;")).toEqual(['runHook@./hook.js']);
  });

  it('reads the members used through a namespace variable', () => {
    const src = "const api = await import('./index.js');\nawait api.openloreInit(x);\napi.openloreRun();\nother.api.no();";
    expect(names(src)).toEqual(['openloreInit@./index.js', 'openloreRun@./index.js']);
  });

  it('ignores package specifiers and static imports', () => {
    expect(names("const { x } = await import('node:fs');\nimport { y } from './y.js';")).toEqual([]);
  });

  it('stays linear on a long unterminated line', () => {
    const src = 'const { ' + 'a, '.repeat(50_000) + "= await import('./x";
    const t = performance.now();
    dynamicImportNames(src);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('objectLiteralSpan', () => {
  it('spans an exported object literal, skipping braces in strings, templates and comments', async () => {
    const { objectLiteralSpan } = await import('./test-dynamic-imports.js');
    const src = "export const adapter: Adapter = {\n  name: '{',\n  // }\n  /* } */\n  async apply() { return `}${'x'}`; },\n};\nexport function after() {}\n";
    const span = objectLiteralSpan(src, 'adapter')!;
    expect(src.slice(span[0], span[1])).toMatch(/^\{[\s\S]*apply[\s\S]*\}$/);
    expect(src.slice(span[1])).toBe(';\nexport function after() {}\n');
    expect(objectLiteralSpan(src, 'missing')).toBeUndefined();
    expect(objectLiteralSpan('const x = 1;\n', 'x')).toBeUndefined();
  });
});
