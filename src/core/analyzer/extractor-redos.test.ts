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
 * These assert the PROPERTY (cost grows linearly, not quadratically) rather than an
 * absolute wall-clock budget. Doubling the input doubles a linear scan and quadruples
 * a quadratic one, so the ratio separates them by a wide margin — and because
 * contention slows BOTH measurements, the ratio survives a loaded CI box where an
 * absolute budget flakes. (It flaked exactly that way while this branch was written.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJSImports, parseJSExports } from './import-parser.js';
import { extractMiddleware } from './middleware-extractor.js';
import { extractHtmlScripts } from './html-script-extractor.js';
import { extractUIComponents } from './ui-component-extractor.js';

/** An opening token repeated with no closer — the whole attack. */
function payload(token: string, bytes: number): string {
  return token.repeat(Math.ceil(bytes / token.length));
}

const SMALL = 120_000;
const LARGE = 240_000;

/**
 * Ratio above which growth is not credibly linear. Doubling the input doubles a
 * linear scan (~2.0) and quadruples a quadratic one (~4.0); 3.0 sits between them
 * with room for measurement noise.
 */
const MAX_GROWTH = 3;

/** Wall time is only ever compared against ITSELF at the other size. */
async function growth(run: (bytes: number) => void | Promise<void>): Promise<number> {
  const time = async (bytes: number): Promise<number> => {
    const t0 = performance.now();
    await run(bytes);
    return performance.now() - t0;
  };
  await time(SMALL); // warm up, so JIT does not inflate the first measurement
  const small = await time(SMALL);
  const large = await time(LARGE);
  // Below a few milliseconds the clock is noisier than the signal, and anything that
  // fast on a 240KB hostile file is self-evidently not quadratic.
  if (large < 20) return 1;
  return large / Math.max(small, 0.05);
}

/** Generous: these tests are ABOUT slow code, and CI runs them under contention. */
const TIMEOUT_MS = 120_000;

let dir: string;
let hostileFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openlore-redos-'));
  hostileFile = join(dir, 'hostile.ts');
  await writeFile(hostileFile, payload('app.use(', SMALL));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('extractors are not quadratic on an unterminated-opener file', () => {
  it('parseJSImports survives repeated `import {`', async () => {
    expect(await growth(b => { parseJSImports(payload('import {', b)); })).toBeLessThan(MAX_GROWTH);
  }, TIMEOUT_MS);

  it('parseJSImports survives repeated `import X, {` and `const {`', async () => {
    expect(await growth(b => { parseJSImports(payload('import X, {', b)); })).toBeLessThan(MAX_GROWTH);
    expect(await growth(b => { parseJSImports(payload('const {', b)); })).toBeLessThan(MAX_GROWTH);
  }, TIMEOUT_MS);

  it('parseJSExports survives repeated `export {`', async () => {
    expect(await growth(b => { parseJSExports(payload('export {', b)); })).toBeLessThan(MAX_GROWTH);
  }, TIMEOUT_MS);

  it('the middleware extractor survives repeated `app.use(`', async () => {
    const ratio = await growth(async (b) => {
      await writeFile(hostileFile, payload('app.use(', b));
      await extractMiddleware([hostileFile], dir);
    });
    expect(ratio).toBeLessThan(MAX_GROWTH);
  }, TIMEOUT_MS);

  it('the HTML script scanner survives repeated `<script `', async () => {
    // Its own header claimed this blow-up class was already fixed — it was, for the
    // BODY scan; the opening-tag scan still ran `[^>]*` to EOF per opener (20s/240KB).
    expect(await growth(b => { extractHtmlScripts(payload('<script ', b)); })).toBeLessThan(MAX_GROWTH);
  }, TIMEOUT_MS);

  it('the Vue props extractor survives repeated `props:{`', async () => {
    // Sibling of a regex the first pass bounded ONE LINE ABOVE, and reachable from any
    // `.vue` file with no framework classification needed.
    const vue = join(dir, 'Widget.vue');
    const ratio = await growth(async (b) => {
      await writeFile(vue, '<template><div/></template>\n<script>\nexport default { ' + payload('props:{', b));
      await extractUIComponents([vue], dir);
    });
    expect(ratio).toBeLessThan(MAX_GROWTH);
  }, TIMEOUT_MS);

  it('still detects middleware wrapped in explanatory comments', async () => {
    // The control the first pass omitted — and its absence is exactly what let a
    // bound regression through: comments sit in the span the pattern bounds, so a
    // commented `app.use(cors(...))` silently vanished from the inventory.
    const app = join(dir, 'app.ts');
    await writeFile(app, [
      'app.use(',
      '  // Enable CORS for the single-page app.',
      '  // See docs/cors.md for the allow-list rationale.',
      '  cors(corsOptions)',
      ');',
    ].join('\n'));
    const found = await extractMiddleware([app], dir);
    expect(found.map(e => e.name)).toContain('cors');
    // …and the blanking must be length-preserving, so the line number stays true.
    expect(found.find(e => e.name === 'cors')?.line).toBe(1);
  });

  it('still resolves a large generated barrel re-export', () => {
    // A length bound is the tempting second line of defense, and it is the wrong one:
    // a 600-name icon barrel is ~7.7KB, so any bound worth setting drops the whole
    // re-export from the graph — silently, producing false dead code and missing
    // edges. Excluding `{` already makes the scan linear, so no bound is needed.
    const names = Array.from({ length: 600 }, (_, i) => `IconName${i}`).join(', ');
    const exports = parseJSExports(`export { ${names} } from './icons';\n`);
    expect(exports).toHaveLength(600);
    expect(exports[0].reExportSource).toBe('./icons');
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
