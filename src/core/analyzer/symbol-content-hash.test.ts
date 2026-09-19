/**
 * Normalized per-symbol content hashes (change: add-symbol-content-hashes).
 */

import { describe, it, expect } from 'vitest';
import { dispatchFileExtract, extractFileWithContentHashes } from './call-graph.js';
import { computeFileContentHashes, type HashTreeNode } from './symbol-content-hash.js';
import { hashSpan } from '../decisions/anchor.js';

async function hashesOf(path: string, content: string, language: string) {
  const r = await extractFileWithContentHashes({ path, content, language });
  expect(r?.contentHashes).toBeDefined();
  const bySymbol = new Map<string, string>();
  for (const s of r!.contentHashes!.symbols) bySymbol.set(s.id, s.hash);
  return { bySymbol, residual: r!.contentHashes!.residual, order: r!.contentHashes!.order, result: r! };
}

const TEN = Array.from({ length: 10 }, (_, i) => `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`).join('\n');

describe('normalized symbol content hashes', () => {
  it('a formatting- and comment-only edit hashes identically, while the raw span hash changes', async () => {
    const before = `import { a } from './a';\n\n// helper\nexport function add(x: number, y: number) {\n  return a(x) + y; // sum\n}\n`;
    const after = `import { a } from './a';\n\n/** reworded helper */\nexport function add(\n    x: number,\n    y: number\n) {\n        /* a new block comment */\n        return a(x)   +   y;\n}\n`;
    const b = await hashesOf('src/m.ts', before, 'TypeScript');
    const h = await hashesOf('src/m.ts', after, 'TypeScript');
    expect(h.bySymbol.get('src/m.ts::add')).toBe(b.bySymbol.get('src/m.ts::add'));
    expect(h.residual).toBe(b.residual);
    const span = (r: typeof b, src: string) => {
      const n = r.result.nodes.find(x => x.id === 'src/m.ts::add')!;
      return hashSpan(src.slice(n.startIndex, n.endIndex));
    };
    expect(span(h, after)).not.toBe(span(b, before));
  });

  it('hashes are 16 lowercase hex characters, the hashSpan discipline', async () => {
    const r = await hashesOf('src/m.ts', 'function f() { return 1; }\n', 'TypeScript');
    expect(r.bySymbol.get('src/m.ts::f')).toMatch(/^[0-9a-f]{16}$/);
    expect(r.residual).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a one-function edit in a ten-function file changes exactly that hash', async () => {
    const edited = TEN.replace('return x + 4;', 'return x - 4;');
    const b = await hashesOf('src/ten.ts', TEN, 'TypeScript');
    const h = await hashesOf('src/ten.ts', edited, 'TypeScript');
    const changed = [...b.bySymbol].filter(([id, hash]) => h.bySymbol.get(id) !== hash).map(([id]) => id);
    expect(changed).toEqual(['src/ten.ts::f4']);
    expect(h.residual).toBe(b.residual);
  });

  it('Python: moving a statement out of a block changes the hash (indentation is structure)', async () => {
    const inside = 'def f(a):\n    if a:\n        x()\n        y()\n    return 1\n';
    const outside = 'def f(a):\n    if a:\n        x()\n    y()\n    return 1\n';
    const b = await hashesOf('m.py', inside, 'Python');
    const h = await hashesOf('m.py', outside, 'Python');
    expect(h.bySymbol.get('m.py::f')).not.toBe(b.bySymbol.get('m.py::f'));
  });

  it('Python: a re-wrapped call and a changed comment hash identically', async () => {
    const b = await hashesOf('m.py', 'def f(a):\n    # one\n    return g(a, 1)\n', 'Python');
    const h = await hashesOf('m.py', 'def f(a):\n    # two\n    return g(\n        a,\n        1\n    )\n', 'Python');
    expect(h.bySymbol.get('m.py::f')).toBe(b.bySymbol.get('m.py::f'));
  });

  it('whitespace inside a template literal is content', async () => {
    const b = await hashesOf('src/t.ts', 'function f(a: string, b: string) { return `${a} ${b}`; }\n', 'TypeScript');
    const h = await hashesOf('src/t.ts', 'function f(a: string, b: string) { return `${a}  ${b}`; }\n', 'TypeScript');
    expect(h.bySymbol.get('src/t.ts::f')).not.toBe(b.bySymbol.get('src/t.ts::f'));
  });

  it('a module-level change moves the residual and no symbol hash', async () => {
    const b = await hashesOf('src/m.ts', `const LIMIT = 1;\nexport function f() { return LIMIT; }\n`, 'TypeScript');
    const h = await hashesOf('src/m.ts', `const LIMIT = 2;\nexport function f() { return LIMIT; }\n`, 'TypeScript');
    expect(h.bySymbol.get('src/m.ts::f')).toBe(b.bySymbol.get('src/m.ts::f'));
    expect(h.residual).not.toBe(b.residual);
  });

  it('a reorder keeps every hash but not the order; a rename keeps the residual', async () => {
    const one = 'function a() { return 1; }\nfunction b() { return 2; }\n';
    const swapped = 'function b() { return 2; }\nfunction a() { return 1; }\n';
    const renamed = 'function a2() { return 1; }\nfunction b() { return 2; }\n';
    const x = await hashesOf('src/o.ts', one, 'TypeScript');
    const y = await hashesOf('src/o.ts', swapped, 'TypeScript');
    const z = await hashesOf('src/o.ts', renamed, 'TypeScript');
    expect(y.residual).toBe(x.residual);
    expect(x.order).toEqual(['src/o.ts::a', 'src/o.ts::b']);
    expect(y.order).toEqual(['src/o.ts::b', 'src/o.ts::a']);
    expect(z.residual).toBe(x.residual);
    expect(z.bySymbol.get('src/o.ts::a2')).not.toBe(x.bySymbol.get('src/o.ts::a'));
  });

  it('Go: a directive comment is code, an ordinary comment is not', async () => {
    const base = 'package p\n\n// Doc.\nfunc F() int {\n\t// note\n\treturn 1\n}\n';
    const b = await hashesOf('p.go', base, 'Go');
    const plain = await hashesOf('p.go', base.replace('// note', '// changed note'), 'Go');
    const directive = await hashesOf('p.go', base.replace('// note', '//go:noinline'), 'Go');
    expect(plain.bySymbol.get('p.go::F')).toBe(b.bySymbol.get('p.go::F'));
    expect(directive.bySymbol.get('p.go::F')).not.toBe(b.bySymbol.get('p.go::F'));
  });

  it('a normal extraction carries no content hashes (analyze never pays for the walk)', async () => {
    const r = await dispatchFileExtract({ path: 'src/m.ts', content: 'function f() { return 1; }\n', language: 'TypeScript' });
    expect(r).toBeDefined();
    expect('contentHashes' in r!).toBe(false);
  });

  it('is iterative: a deeply nested tree does not overflow the stack', () => {
    let node: HashTreeNode = { type: 'leaf', startIndex: 0, endIndex: 1, children: [] };
    for (let i = 0; i < 200_000; i++) node = { type: 'n', startIndex: 0, endIndex: 1, children: [node] };
    const r = computeFileContentHashes(node, [{ id: 'x', startIndex: 0, endIndex: 1 }], 'a', 'TypeScript');
    expect(r.symbols[0].hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a residual when span tokens are interleaved with residual tokens', () => {
    const leaf = (type: string, s: number): HashTreeNode => ({ type, startIndex: s, endIndex: s + 1, children: [] });
    // R[0,4) = a[0,1) X[1,4); X = b c d. Span [0,3) holds a, b, c; X straddles its end.
    const root: HashTreeNode = {
      type: 'R', startIndex: 0, endIndex: 4,
      children: [leaf('a', 0), { type: 'X', startIndex: 1, endIndex: 4, children: [leaf('b', 1), leaf('c', 2), leaf('d', 3)] }],
    };
    const r = computeFileContentHashes(root, [{ id: 's', startIndex: 0, endIndex: 3 }], 'abcd', 'TypeScript');
    expect(r.residual).toBeUndefined();
    expect(r.residualUnavailable).toBe('span-not-contiguous');
    const whole = computeFileContentHashes(root, [{ id: 's', startIndex: 1, endIndex: 4 }], 'abcd', 'TypeScript');
    expect(whole.residual).toMatch(/^[0-9a-f]{16}$/);
    expect(computeFileContentHashes(root, [{ id: 'bad', startIndex: 5, endIndex: 2 }], 'abcd', 'TypeScript').residualUnavailable).toBe('invalid-span');
  });
});
