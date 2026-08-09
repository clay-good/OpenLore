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
import {
  ImportExportParser,
  parseJavaExports,
  parseJavaPackage,
  parseJSExports,
  parseJSImports,
} from './import-parser.js';
import { extractMiddleware } from './middleware-extractor.js';
import { extractHtmlScripts } from './html-script-extractor.js';
import { extractUIComponents } from './ui-component-extractor.js';
import { extractSignatures } from './signature-extractor.js';
import { extractJavaRouteDefinitions } from './http-route-parser.js';

/** An opening token repeated with no closer — the whole attack. */
function payload(token: string, bytes: number): string {
  return token.repeat(Math.ceil(bytes / token.length));
}

const SMALL = 120_000;
const LARGE = 240_000;

/**
 * Ratio above which growth is not credibly linear. Doubling the input doubles a
 * linear scan (~2.0) and quadruples a quadratic one (~4.0); 3.0 sits between them.
 */
const MAX_GROWTH = 3;

/**
 * Absolute ceiling for one hostile file, checked ALONGSIDE the ratio.
 *
 * The ratio alone has a structural blind spot: a bounded quantifier costs
 * O(n x bound), which is LINEAR — ratio ~2.0 — no matter how large the bound is. A
 * `{0,100000}` bound would burn ~12s on a single 240KB file and the ratio would call
 * it clean. So the ratio catches an unbounded quantifier, and this ceiling catches an
 * over-generous bound; neither subsumes the other.
 *
 * Sized off the measured cost of the slowest legitimate case (the middleware
 * extractor, a dozen patterns each scanning the file, ~0.6s) with room for a loaded
 * CI box — not so tight that contention trips it, not so loose that a 12s bound hides.
 */
const MAX_ABSOLUTE_MS = 4_000;

/**
 * Measure the cost at two sizes, taking the MINIMUM of several samples at each.
 *
 * Single samples are unusable here: a GC pause landing in one window and not the
 * other produced ~12% false failures per measurement (a 1.1ms case measured at
 * 30.7ms). The minimum is the sample least contaminated by pauses, which is what we
 * want when the question is "how much work does this do", not "how loaded is the box".
 */
async function measure(
  run: (bytes: number) => void | Promise<void>,
): Promise<{ ratio: number; ms: number; meaningfulRatio: boolean }> {
  const SAMPLES = 5;
  const timeOnce = async (bytes: number): Promise<number> => {
    const t0 = performance.now();
    await run(bytes);
    return performance.now() - t0;
  };
  const best = async (bytes: number): Promise<number> => {
    let min = Infinity;
    for (let i = 0; i < SAMPLES; i++) min = Math.min(min, await timeOnce(bytes));
    return min;
  };
  await timeOnce(SMALL); // warm up so JIT compilation is not charged to sample 1
  const small = await best(SMALL);
  const large = await best(LARGE);
  return { ratio: large / Math.max(small, 0.05), ms: large, meaningfulRatio: large >= RATIO_FLOOR_MS };
}

/**
 * Below this, the ratio is measuring the scheduler rather than the code.
 *
 * A correctly-fixed parser costs single-digit milliseconds on this payload, where one
 * GC pause landing in one of the two windows swamps the signal — which is exactly how
 * this test flaked on CI (ratio 4.78 on a 68ms run). The ceiling is what actually
 * guards those cases and it does so decisively: the same input against the UNFIXED
 * parser measures 10,866ms, versus 5ms fixed and a 4,000ms limit. So the ratio is
 * asserted only where it can mean something — the cases slow enough (the middleware
 * and Vue extractors, ~0.5-1.5s) that a doubling is visible above the noise.
 */
const RATIO_FLOOR_MS = 50;

/**
 * Assert the absolute cost always, and the growth ratio when it is measurable.
 *
 * The two catch different regressions and neither subsumes the other: the ratio catches
 * an unbounded quantifier whose constant is small, the ceiling catches an over-generous
 * bound (linear, so invisible to the ratio) and every quadratic on these payloads.
 */
function expectLinearAndFast(
  { ratio, ms, meaningfulRatio }: { ratio: number; ms: number; meaningfulRatio: boolean },
  label: string,
): void {
  expect(ms, `${label}: absolute cost on one ${LARGE / 1000}KB file`).toBeLessThan(MAX_ABSOLUTE_MS);
  if (meaningfulRatio) {
    expect(ratio, `${label}: growth ratio (quadratic if ~4x)`).toBeLessThan(MAX_GROWTH);
  }
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
    expectLinearAndFast(await measure(b => { parseJSImports(payload('import {', b)); }), 'parseJSImports');
  }, TIMEOUT_MS);

  it('parseJSImports survives repeated `import X, {` and `const {`', async () => {
    expectLinearAndFast(await measure(b => { parseJSImports(payload('import X, {', b)); }), 'mixed import');
    expectLinearAndFast(await measure(b => { parseJSImports(payload('const {', b)); }), 'require');
  }, TIMEOUT_MS);

  it('parseJSExports survives repeated `export {`', async () => {
    expectLinearAndFast(await measure(b => { parseJSExports(payload('export {', b)); }), 'parseJSExports');
  }, TIMEOUT_MS);

  it('the middleware extractor survives repeated `app.use(`', async () => {
    expectLinearAndFast(await measure(async (b) => {
      await writeFile(hostileFile, payload('app.use(', b));
      await extractMiddleware([hostileFile], dir);
    }), 'middleware');
  }, TIMEOUT_MS);

  it('the middleware extractor survives an unterminated block comment', async () => {
    // The comment blanker is itself an extractor input, and its first (regex) form
    // cost 5.6s on this payload — a cost added while fixing a cost, and untested.
    // The scanner form is linear by construction; this pins that.
    expectLinearAndFast(await measure(async (b) => {
      await writeFile(hostileFile, payload('/*x', b));
      await extractMiddleware([hostileFile], dir);
    }), 'unterminated block comment');
  }, TIMEOUT_MS);

  it('the HTML script scanner survives repeated `<script `', async () => {
    // Its own header claimed this blow-up class was already fixed — it was, for the
    // BODY scan; the opening-tag scan still ran `[^>]*` to EOF per opener (20s/240KB).
    expectLinearAndFast(await measure(b => { extractHtmlScripts(payload('<script ', b)); }), 'html scripts');
  }, TIMEOUT_MS);

  it('the Vue props extractor survives repeated `props:{`', async () => {
    // Sibling of a regex the first pass bounded ONE LINE ABOVE, and reachable from any
    // `.vue` file with no framework classification needed.
    const vue = join(dir, 'Widget.vue');
    expectLinearAndFast(await measure(async (b) => {
      await writeFile(vue, '<template><div/></template>\n<script>\nexport default { ' + payload('props:{', b));
      await extractUIComponents([vue], dir);
    }), 'vue props');
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

/**
 * Language-signature and Java-route extractors on a whitespace / unterminated-token
 * flood.
 *
 * Two distinct quadratic shapes, both firing on attacker-controlled repo source that
 * `openlore analyze` (and the live watcher) parse:
 *  - EXTRA_LANG_PATTERNS (C#/Kotlin/PHP/Scala) placed a bare `\s` alternative inside a
 *    modifier group adjacent to the leading `^\s*`, so a whitespace-only line could be
 *    partitioned O(n²) ways before the declaration keyword failed to arrive.
 *  - The Java method/handler regexes rescanned to end-of-input from each of O(n)
 *    `public` starts via an UNBOUNDED lazy token repetition when the closing `(` never
 *    came. The per-file 4 MB cap does not neutralize a quadratic (a 4 MB file costs
 *    hours), so a single planted file was a permanent-hang DoS.
 *
 * Same PROPERTY assertion as above: linear growth where measurable, and an absolute
 * ceiling that catches both an unbounded quantifier and an over-generous bound.
 */
describe('language extractors are not quadratic on a whitespace/token flood', () => {
  // One long run of spaces, no declaration keyword — the EXTRA_LANG_PATTERNS trigger.
  const wsFlood = (bytes: number): string => ' '.repeat(bytes);
  // Newlines create a `^` match at every position under /m; `^\s*` used to rescan
  // the entire remaining file from every one of those positions.
  const newlineFlood = (bytes: number): string => '\n'.repeat(bytes);
  // `public a public a …` with no closing `(` — the Java lazy-repetition trigger.
  const publicFlood = (bytes: number): string => 'public a '.repeat(Math.floor(bytes / 9));
  // Unterminated generic-method prefixes exercised a separate unbounded branch.
  const genericFlood = (bytes: number): string => 'public < '.repeat(Math.floor(bytes / 9));
  // The former regex comment blanker retried to EOF from every unmatched opener.
  const commentFlood = (bytes: number): string => '/*x'.repeat(Math.floor(bytes / 3));
  const mappingFlood = (name: string, bytes: number): string =>
    `@${name}(`.repeat(Math.floor(bytes / (name.length + 2)));

  for (const [lang, ext] of [
    ['C#', 'cs'], ['Kotlin', 'kt'], ['PHP', 'php'], ['Scala', 'scala'],
    ['Dart', 'dart'], ['Lua', 'lua'], ['Elixir', 'ex'], ['Bash', 'sh'],
  ] as const) {
    it(`extractSignatures(${lang}) survives a whitespace flood`, async () => {
      expectLinearAndFast(
        await measure(b => { extractSignatures(`hostile.${ext}`, wsFlood(b)); }),
        `${lang} signatures`,
      );
      expectLinearAndFast(
        await measure(b => { extractSignatures(`hostile.${ext}`, newlineFlood(b)); }),
        `${lang} signatures (newlines)`,
      );
    }, TIMEOUT_MS);
  }

  it('extractSignatures(C) survives declaration-like lines with no function', async () => {
    expectLinearAndFast(
      await measure(b => { extractSignatures('hostile.c', 'a '.repeat(Math.floor(b / 2))); }),
      'C signatures',
    );
  }, TIMEOUT_MS);

  it('C and Dart scanners survive repeated unterminated parameter lists', async () => {
    expectLinearAndFast(
      await measure(b => { extractSignatures('hostile.c', 'int f(\n'.repeat(Math.floor(b / 7))); }),
      'C unterminated parameters',
    );
    expectLinearAndFast(
      await measure(b => { extractSignatures('hostile.dart', 'f(\n'.repeat(Math.floor(b / 3))); }),
      'Dart unterminated parameters',
    );
  }, TIMEOUT_MS);

  it('C and Dart scanners survive many balanced call-like tokens on one line', async () => {
    expectLinearAndFast(
      await measure(b => { extractSignatures('hostile.c', 'a() '.repeat(Math.floor(b / 4))); }),
      'C balanced call-like tokens',
    );
    expectLinearAndFast(
      await measure(b => { extractSignatures('hostile.dart', 'a() '.repeat(Math.floor(b / 4))); }),
      'Dart balanced call-like tokens',
    );
  }, TIMEOUT_MS);

  it('parseJavaExports survives repeated `public a ` with no `(`', async () => {
    expectLinearAndFast(await measure(b => { parseJavaExports(publicFlood(b)); }), 'parseJavaExports');
    expectLinearAndFast(await measure(b => { parseJavaExports(genericFlood(b)); }), 'parseJavaExports generic');
    expectLinearAndFast(await measure(b => { parseJavaExports(commentFlood(b)); }), 'parseJavaExports comments');
  }, TIMEOUT_MS);

  it('parseJavaPackage survives newline and unterminated-comment floods', async () => {
    expectLinearAndFast(await measure(b => { parseJavaPackage(newlineFlood(b)); }), 'parseJavaPackage newlines');
    expectLinearAndFast(await measure(b => { parseJavaPackage(commentFlood(b)); }), 'parseJavaPackage comments');
  }, TIMEOUT_MS);

  it('parseJavaPackage accepts multiline and CRLF package declarations', () => {
    expect(parseJavaPackage('package\ncom.example\n;')).toBe('com.example');
    expect(parseJavaPackage('package\r\ncom.example\r\n;')).toBe('com.example');
  });

  it('extractJavaRouteDefinitions survives a giant handler-signature line', async () => {
    // The route regex runs per-line only in a Spring file after a mapping annotation,
    // so the hostile line must sit right after one.
    expectLinearAndFast(
      await measure(async b => {
        await extractJavaRouteDefinitions('Hostile.java', `@GetMapping("/x")\n${publicFlood(b)}`);
      }),
      'extractJavaRouteDefinitions',
    );
    expectLinearAndFast(
      await measure(async b => {
        await extractJavaRouteDefinitions('Hostile.java', `@GetMapping("/x")\n${genericFlood(b)}`);
      }),
      'extractJavaRouteDefinitions generic',
    );
    expectLinearAndFast(
      await measure(async b => {
        await extractJavaRouteDefinitions('Hostile.java', `@GetMapping("/x")\n${commentFlood(b)}`);
      }),
      'extractJavaRouteDefinitions comments',
    );
  }, TIMEOUT_MS);

  it('extractJavaRouteDefinitions survives unterminated Spring mapping annotations', async () => {
    expectLinearAndFast(
      await measure(async b => {
        await extractJavaRouteDefinitions('Hostile.java', mappingFlood('GetMapping', b));
      }),
      'extractJavaRouteDefinitions GetMapping annotation',
    );
    expectLinearAndFast(
      await measure(async b => {
        await extractJavaRouteDefinitions('Hostile.java', mappingFlood('RequestMapping', b));
      }),
      'extractJavaRouteDefinitions RequestMapping annotation',
    );
  }, TIMEOUT_MS);

  it('extractJavaRouteDefinitions scales across many valid mappings and line lookups', async () => {
    const routes = (bytes: number): string => {
      const declaration = '@GetMapping("/x")\npublic String handler() { return ""; }\n';
      return declaration.repeat(Math.floor(bytes / declaration.length));
    };
    expectLinearAndFast(
      await measure(async b => { await extractJavaRouteDefinitions('Many.java', routes(b)); }),
      'extractJavaRouteDefinitions many routes',
    );
  }, TIMEOUT_MS);

  it('extractJavaRouteDefinitions caches handler scans for dense same-line annotations', async () => {
    expectLinearAndFast(
      await measure(async b => {
        await extractJavaRouteDefinitions('Dense.java', '@GetMapping '.repeat(Math.floor(b / 12)));
      }),
      'extractJavaRouteDefinitions dense annotations',
    );
  }, TIMEOUT_MS);

  it('resolves distinct handlers for multiple mappings on the same line', async () => {
    const routes = await extractJavaRouteDefinitions(
      'Dense.java',
      '@RestController class C { @GetMapping("/a") public String alpha() {} @GetMapping("/b") public String beta() {} }',
    );
    expect(routes.map(r => [r.path, r.handlerName])).toEqual([
      ['/a', 'alpha'],
      ['/b', 'beta'],
    ]);
  });

  it('resolves mapping annotations interleaved with method modifiers', async () => {
    const routes = await extractJavaRouteDefinitions(
      'Inline.java',
      'class C { public @GetMapping("/a") String alpha() {} public static @GetMapping("/b") String beta() {} public String later() {} }',
    );
    expect(routes.map(r => [r.path, r.handlerName])).toEqual([
      ['/a', 'alpha'],
      ['/b', 'beta'],
    ]);
  });

  // ── Controls: the fixes must still extract real declarations (a regex that matched
  //    nothing at all would pass every timing assertion above). ──

  it('still extracts real C#/Kotlin/PHP/Scala declarations', () => {
    const names = (path: string, src: string): string[] =>
      extractSignatures(path, src).entries.map(e => e.name);
    // Includes an indented, modifier-less member and a fully-qualified modifier chain.
    expect(names('a.cs', 'public static class Widget {\n    public async Task<int> Load() {\n')).toEqual(
      expect.arrayContaining(['Widget', 'Load']),
    );
    expect(names('a.kt', 'internal open class Repo {\n    suspend fun fetch() {\n')).toEqual(
      expect.arrayContaining(['Repo', 'fetch']),
    );
    expect(names('a.php', 'abstract class Base {\n    public function handle() {\n')).toEqual(
      expect.arrayContaining(['Base', 'handle']),
    );
    expect(names('a.scala', 'class Svc {\n    private def run() = {\n')).toEqual(
      expect.arrayContaining(['Svc', 'run']),
    );
    expect(names('a.c', 'int\ncompute(\n  int x,\n  int y\n) {\n')).toContain('compute');
    expect(names('a.c', 'int compute\n(\n  int x\n) {\n')).toContain('compute');
    expect(names('a.dart', 'Future<String> fetch(\n  String url,\n  int retries,\n) {\n')).toContain('fetch');
    expect(names('a.dart', 'Future<String> fetch\n(\n  String url\n) {\n')).toContain('fetch');
    const cParams = Array.from({ length: 700 }, (_, i) => `int p${i}`).join(',\n');
    expect(names('generated.c', `int generated(\n${cParams}\n) {\n`)).toContain('generated');
    const dartParams = Array.from({ length: 300 }, (_, i) => `String p${i}`).join(',\n');
    expect(names('generated.dart', `Future<String> generated(\n${dartParams}\n) {\n`)).toContain('generated');
  });

  it('still extracts a real Java public method (generic return type with a space)', () => {
    // `Map<String, Object>` — the space inside the generic is exactly the case the
    // bounded token repetition must still span.
    const names = parseJavaExports('public Map<String, Object> config(int n) { return null; }\n').map(e => e.name);
    expect(names).toContain('config');
  });

  it('preserves valid wide and spaced Java return types without matching constructors', () => {
    const arrays = Array.from({ length: 20 }, () => ' []').join('');
    const nested = 'Map < String , Map < String , Map < String , Map < String , Integer > > > >';
    const source = [
      `public String${arrays} wide() { return null; }`,
      `public ${nested} nested() { return null; }`,
      'public <T extends Map<String, List<Integer>>> T generic() { return null; }',
      'public @Deprecated String annotated() { return ""; }',
      'public java.lang.String @ Size (max=5) [] constrained() { return null; }',
      'public java.lang.String @/* keep */Size(max=5) [] commentedAnnotation() { return null; }',
      'public Widget() {}',
      'public <T> Widget(T value) {}',
      'public record Pair(int left, int right) {}',
    ].join('\n');
    const methodNames = parseJavaExports(source).filter(e => e.kind === 'function').map(e => e.name);
    expect(methodNames).toEqual(
      expect.arrayContaining(['wide', 'nested', 'generic', 'annotated', 'constrained', 'commentedAnnotation']),
    );
    expect(methodNames).not.toEqual(
      expect.arrayContaining(['Widget', 'Pair']),
    );
  });

  it('still resolves a Spring handler name', async () => {
    const routes = await extractJavaRouteDefinitions(
      'Ctrl.java',
      '@RestController\nclass C {\n  @GetMapping("/x")\n  public String hello() { return "hi"; }\n}\n',
    );
    expect(routes.map(r => r.handlerName)).toContain('hello');
  });

  it('resolves a Spring handler with a wide spaced return type', async () => {
    const arrays = Array.from({ length: 20 }, () => ' []').join('');
    const routes = await extractJavaRouteDefinitions(
      'Ctrl.java',
      `@RestController\nclass C {\n  @GetMapping("/x")\n  public String${arrays} wide() { return null; }\n}\n`,
    );
    expect(routes.map(r => r.handlerName)).toContain('wide');
  });

  it('resolves a Spring handler after an argument-bearing type-use annotation', async () => {
    const routes = await extractJavaRouteDefinitions(
      'Ctrl.java',
      '@GetMapping("/x")\npublic java.lang.String @ Size (max=5) [] constrained() { return null; }\n',
    );
    expect(routes.map(r => r.handlerName)).toContain('constrained');
  });

  it('combines a named method-level JAX-RS path with the class prefix', async () => {
    const routes = await extractJavaRouteDefinitions(
      'Resource.java',
      [
        'import jakarta.ws.rs.*;',
        '@Path(value = "/users")',
        'class Resource {',
        '  @GET',
        '  @Path(value = "/nested")',
        '  public String nested() { return ""; }',
        '}',
      ].join('\n'),
    );
    expect(routes.map(r => r.path)).toContain('/users/nested');
    expect(routes.map(r => r.handlerName)).toContain('nested');
  });

  it('does not treat JAX-RS annotations inside Java strings as routes', async () => {
    const routes = await extractJavaRouteDefinitions(
      'Resource.java',
      [
        'import jakarta.ws.rs.*;',
        '@Path("/users")',
        'class Resource {',
        '  String documentation = "call @GET to read";',
        '  public String ordinary() { return ""; }',
        '}',
      ].join('\n'),
    );
    expect(routes).toEqual([]);
  });

  it('does not treat Spring annotations inside Java strings as routes', async () => {
    const routes = await extractJavaRouteDefinitions(
      'Strings.java',
      'class C { String example = "@GetMapping(\\"/phantom\\")"; }\n',
    );
    expect(routes).toEqual([]);
  });

  it('ImportParser rejects a Java file above the analyzer source-size cap', async () => {
    const oversized = join(dir, 'Oversized.java');
    await writeFile(oversized, ' '.repeat(4 * 1024 * 1024 + 1));
    const analysis = await new ImportExportParser().parseFile(oversized);
    expect(analysis.imports).toEqual([]);
    expect(analysis.exports).toEqual([]);
    expect(analysis.parseErrors).toContain('File exceeds the analyzer source-size limit');
  });
});
