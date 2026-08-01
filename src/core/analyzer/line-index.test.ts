/**
 * Byte offset → line number (change: bulletproof-background-index).
 *
 * This replaces `content.substring(0, position).split('\n').length`, which was 50% of an entire
 * `analyze` run on a 2 MB single-file fixture. A line number that is merely CLOSE to the old one
 * would be worse than the slowness it fixes: every import edge, export, and route anchor in the
 * graph is placed by this number, and an off-by-one would be invisible in aggregate and wrong in
 * every individual answer.
 *
 * So the test is a differential oracle against the exact expression that was removed.
 */
import { describe, it, expect } from 'vitest';

import { buildLineIndex, lineFromIndex } from './line-index.js';
import { parseJSImports } from './import-parser.js';

/** Verbatim, the implementation this replaced. */
const oracle = (content: string, position: number): number =>
  content.substring(0, position).split('\n').length;

const lineOf = (content: string, position: number): number =>
  lineFromIndex(buildLineIndex(content), position);

describe('lineFromIndex — identical to the expression it replaced', () => {
  const cases: Array<[string, string]> = [
    ['empty', ''],
    ['no newline at all', 'const x = 1;'],
    ['trailing newline', 'a\nb\nc\n'],
    ['no trailing newline', 'a\nb\nc'],
    ['leading newline', '\na'],
    ['consecutive newlines', 'a\n\n\nb'],
    ['only newlines', '\n\n\n'],
    ['CRLF', 'a\r\nb\r\nc'],
    ['unicode before the offset', 'const emoji = "🎉🎉🎉";\nimport x from "y";\n'],
    ['long single line', 'x'.repeat(5000)],
  ];

  for (const [name, content] of cases) {
    it(`agrees at every offset — ${name}`, () => {
      for (let i = 0; i <= content.length; i++) {
        expect(lineOf(content, i), `offset ${i} of ${JSON.stringify(name)}`).toBe(oracle(content, i));
      }
    });
  }

  it('agrees at every offset of a realistic multi-line file', () => {
    const content = Array.from(
      { length: 400 },
      (_, i) => (i % 9 === 0 ? '' : `export function f${i}(a: number) { return a + ${i}; }`)
    ).join('\n');

    for (let i = 0; i <= content.length; i++) {
      expect(lineOf(content, i), `offset ${i}`).toBe(oracle(content, i));
    }
  });

  it('agrees on randomized content, at randomized offsets', () => {
    // Fixed seed: a failure must be reproducible, and this file's whole purpose is to be trusted.
    let seed = 0x5eed;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let t = 0; t < 200; t++) {
      const len = Math.floor(rnd() * 300);
      let content = '';
      for (let i = 0; i < len; i++) content += rnd() < 0.2 ? '\n' : 'abcdef'[Math.floor(rnd() * 6)];
      for (let k = 0; k < 20; k++) {
        const pos = Math.floor(rnd() * (content.length + 1));
        expect(lineOf(content, pos), `trial ${t} offset ${pos} of ${JSON.stringify(content)}`)
          .toBe(oracle(content, pos));
      }
    }
  });

  it('is built once and reused, which is the entire point', () => {
    // A guard against "fixing" this by calling buildLineIndex per lookup: that is still O(n) per
    // lookup and every assertion above would still pass.
    const content = ('line\n'.repeat(20_000));
    const index = buildLineIndex(content);
    expect(index.length).toBe(20_000);

    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20_000; i++) lineFromIndex(index, i * 5);
    const perLookupNs = Number(process.hrtime.bigint() - t0) / 20_000;

    // A prefix scan over this content averages ~50,000 char reads per lookup. A binary search is
    // ~15 comparisons. The bound is loose enough to be immune to CI noise and still fails by
    // orders of magnitude if the scan comes back.
    expect(perLookupNs, `${perLookupNs.toFixed(0)}ns per lookup suggests a scan, not a search`)
      .toBeLessThan(20_000);
  });
});

describe('import-parser — the shared line index does not leak between files', () => {
  it('reports the second file\'s own line numbers, not the first\'s', () => {
    // `getLineNumber` memoizes one file's index so the ~29 call sites share it. If that memo does
    // not invalidate on new content, every file after the first gets the PREVIOUS file's line
    // numbers — silently, with no error anywhere, and every import in the graph mis-anchored.
    // Analyzing one file cannot catch this; it takes two, with different layouts.
    const first = [
      'import { a } from "./a.js";',
      '',
      '',
      '',
      '',
      'import { b } from "./b.js";',
    ].join('\n');
    const second = [
      '// a different shape entirely',
      'import { c } from "./c.js";',
    ].join('\n');

    parseJSImports(first);
    const got = parseJSImports(second);

    const c = got.find(i => i.source === './c.js');
    expect(c, 'the import was not found at all').toBeDefined();
    expect(c!.line, 'a stale line index from the previous file leaked through').toBe(2);
  });

  it('still reports the first file correctly when the same content is parsed twice', () => {
    const content = ['', '', 'import { d } from "./d.js";'].join('\n');
    const once = parseJSImports(content);
    const twice = parseJSImports(content);
    expect(once.find(i => i.source === './d.js')?.line).toBe(3);
    expect(twice.find(i => i.source === './d.js')?.line).toBe(3);
  });
});
