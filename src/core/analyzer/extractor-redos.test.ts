/**
 * A hostile file must not wedge `openlore analyze`.
 *
 * Every extractor below used an unbounded inner quantifier (`[^}]+`, `[^)]*`,
 * `(.*?)`) that rescans to end-of-file from each of O(n) start positions when the
 * closing delimiter never arrives. The payload is trivial — an opening token
 * repeated — and the cost is quadratic: measured before the fix, a 200 KB file cost
 * ~96 s in the middleware extractor and ~8 s in the import parser, which runs on
 * every JS/TS file in the repo. The extractors run under `Promise.all` on the main
 * thread during `analyze`, so one planted file stalls the whole run.
 *
 * These assert a WALL-CLOCK budget rather than an exact shape. See `payload` for how
 * the size and budget are chosen so the assertion cannot flake on a loaded CI box and
 * still fails loudly if an unbounded quantifier comes back.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJSImports, parseJSExports } from './import-parser.js';
import { extractMiddleware } from './middleware-extractor.js';

/**
 * ~480 KB of an opening token with no closer — the whole attack.
 *
 * Sized deliberately: the cost is quadratic, so at this size the UNFIXED code takes
 * tens of seconds while the fixed code stays in the low milliseconds. That gap is
 * what makes a wall-clock assertion safe — the budget below sits ~100x above the
 * fixed cost (so a loaded CI box cannot flake it) and well under the broken cost
 * (so it still fails loudly if an unbounded quantifier returns).
 */
function payload(token: string, bytes = 480_000): string {
  return token.repeat(Math.ceil(bytes / token.length));
}

function msToRun(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const BUDGET_MS = 5000;

let dir: string;
let hostileFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openlore-redos-'));
  hostileFile = join(dir, 'hostile.ts');
  await writeFile(hostileFile, payload('app.use('));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('extractors are not quadratic on an unterminated-opener file', () => {
  it('parseJSImports survives repeated `import {`', () => {
    const ms = msToRun(() => parseJSImports(payload('import {')));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('parseJSImports survives repeated `import X, {` and `const {`', () => {
    expect(msToRun(() => parseJSImports(payload('import X, {')))).toBeLessThan(BUDGET_MS);
    expect(msToRun(() => parseJSImports(payload('const {')))).toBeLessThan(BUDGET_MS);
  });

  it('parseJSExports survives repeated `export {`', () => {
    const ms = msToRun(() => parseJSExports(payload('export {')));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('the middleware extractor survives repeated `app.use(`', async () => {
    // ~20 Express/Fastify patterns each re-scanned this independently.
    const t0 = performance.now();
    await extractMiddleware([hostileFile], dir);
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
  });

  it('still extracts a legitimate import after the bound', () => {
    // Control: the bound must not have broken ordinary parsing. Without this, a
    // regex that matches nothing at all would pass every timing test above.
    const imports = parseJSImports(`import { readFile, writeFile } from 'node:fs/promises';\n`);
    expect(imports).toHaveLength(1);
    expect(imports[0].importedNames).toEqual(['readFile', 'writeFile']);
    expect(imports[0].source).toBe('node:fs/promises');
  });
});
