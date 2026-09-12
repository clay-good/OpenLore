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
  parsePythonImports,
} from './import-parser.js';
import { extractMiddleware } from './middleware-extractor.js';
import { extractHtmlScripts } from './html-script-extractor.js';
import { extractUIComponents } from './ui-component-extractor.js';
import { extractSignatures } from './signature-extractor.js';
import { extractJavaRouteDefinitions } from './http-route-parser.js';
import { tokenize } from './bm25-tokenizer.js';
import { classifyYaml } from './iac/classify-yaml.js';
import { extractTerraform } from './iac/terraform.js';

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
const RATIO_FLOOR_MS = 250;
// Raised from 50ms to match the rationale above rather than undercut it. At 50ms the
// ratio was still being asserted on tens-of-milliseconds cases — the Java route
// extractor measured 3.18 against a 3.0 bound on CI while measuring ~50ms, which is
// the scheduler talking, not the parser. The cases the ratio is actually for (the
// middleware and Vue extractors) run in seconds and clear this floor by an order of
// magnitude; everything below it stays guarded by MAX_ABSOLUTE_MS, which separates
// fixed from unfixed by three orders of magnitude (5ms vs 10,866ms).

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

  it('extractSignatures(C++) survives unterminated parameter lists with no brace', async () => {
    // A chain of optional groups each ending in an unbounded `\s*`, followed by a
    // REQUIRED `[{:]` that never arrives: the optional-group x whitespace split points
    // multiplied. 4.5 s at 50 KB before the bounds, ~0.9 s at 240 KB after.
    expectLinearAndFast(
      await measure(b => { extractSignatures('hostile.cpp', 'void f' + '(a'.repeat(Math.floor(b / 2))); }),
      'C++ unterminated parameters',
    );
  }, TIMEOUT_MS);

  it('still extracts real C++ declarations across the qualifier chain', () => {
    const names = (src: string): string[] => extractSignatures('a.cpp', src).entries.map(e => e.name);
    expect(names('class Widget {\n  int load() {\n')).toEqual(expect.arrayContaining(['Widget', 'load']));
    expect(names('int   compute  ( int x, int y )   {\n')).toContain('compute');
    expect(names('int size() const {\n')).toContain('size');
    expect(names('void run() const noexcept override final {\n')).toContain('run');
    expect(names('auto make() -> std::vector<int> {\n')).toContain('make');
    expect(names('Widget::Widget(int n) : count_(n) {\n')).toContain('Widget');
    expect(names('void tabbed\t(\tint x\t)\t{\n')).toContain('tabbed');
    // CRLF: `trimmed` is one line, so the class is `[ \t\r]`, not `\s`.
    expect(names('int crlf() {\r\n')).toContain('crlf');
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

/**
 * `\s` matches `\n` — the systemic root cause, and a whitespace flood with no
 * declaration in it.
 *
 * `^\s*LITERAL` under /m (and its sibling `(^|\n)\s*LITERAL`) is quadratic on a file of
 * blank lines: at each of the n line starts, `\s*` greedily eats every remaining newline
 * to end-of-file, fails on LITERAL, then gives them back one character at a time. The
 * payload is a file of newlines — zero attacker effort, and it looks like whitespace in a
 * diff. The same shape appears with a space run wherever an unbounded `\s+`/`\s*` sits in
 * front of a required literal (`\s+as\s+`, `\s*\n\s*`, `^\s*\{?\s*"`).
 *
 * A per-file size cap is NOT a defence against a quadratic, and neither is
 * `MAX_SIGS_PER_FILE`: these payloads produce ZERO matches, so the capping loop never
 * runs and the whole cost is the regex engine's failed scans. Measured on the real
 * extractors at 50 KB — `classifyYaml` 55.6 s, `parsePythonImports` 9.1 s,
 * `extractSignatures('a.tf')` 7.9 s, `tokenize` 7.5 s, `extractTerraform` 7.5 s,
 * `parseJSImports` 7.3 s, `extractJavaRouteDefinitions` 8.3 s — and the source cap is
 * 4 MB, 80x that size, for 6,400x the time.
 *
 * Same PROPERTY assertion as the suites above: linear growth where the ratio is
 * measurable, and an absolute ceiling that also catches an over-generous bound.
 */
describe('extractors are not quadratic on a whitespace-run or blank-line flood', () => {
  const newlines = (bytes: number): string => '\n'.repeat(bytes);
  const spaces = (bytes: number): string => ' '.repeat(bytes);

  it('parseJSImports survives a giant whitespace run inside a named-import body', async () => {
    // The brace body is unbounded BY DESIGN (a 600-name generated barrel must not be
    // dropped), and it was handed straight to `split(/\s+as\s+/)`. The body is valid-looking
    // ES module syntax, so nothing upstream rejects it.
    expectLinearAndFast(
      await measure(b => { parseJSImports(`import { a${spaces(b)}b } from 'x'`); }),
      'parseJSImports as-separator',
    );
  }, TIMEOUT_MS);

  it('still resolves `X as Y` renames, and still resolves a wide barrel', () => {
    const imports = parseJSImports(
      `import { readFile as read, writeFile, type Stats as S } from 'node:fs/promises';\n`,
    );
    expect(imports).toHaveLength(1);
    expect(imports[0].importedNames).toEqual(['read', 'writeFile', 'S']);
    // The source-side identity must still strip the alias and the `type` modifier.
    expect(imports[0].importedSourceNames).toEqual(['readFile', 'writeFile', 'Stats']);
    // Alignment padding inside the bound still parses.
    const padded = parseJSImports(`import { readFile${spaces(40)}as${spaces(40)}read } from 'x';\n`);
    expect(padded[0].importedNames).toEqual(['read']);
    // And the unbounded brace body is still unbounded.
    const names = Array.from({ length: 600 }, (_, i) => `Icon${i} as I${i}`).join(', ');
    expect(parseJSImports(`import { ${names} } from './icons';\n`)[0].importedNames).toHaveLength(600);
  });

  it('extractSignatures(Terraform) survives a .tf file of blank lines', async () => {
    expectLinearAndFast(
      await measure(b => { extractSignatures('hostile.tf', newlines(b)); }),
      'Terraform signatures (newlines)',
    );
  }, TIMEOUT_MS);

  it('still extracts indented and multi-label Terraform block headers', () => {
    const entries = extractSignatures('main.tf', [
      'resource "aws_s3_bucket" "b" {',
      '  variable_like = 1',
      '}',
      '\tdata\t"aws_ami"\t"a" {',
      '}',
      '  module "m" {',
      '  }',
      'variable "v" {}',
      'output "o" {}',
      'provider aws {}',
    ].join('\n')).entries;
    expect(entries.map(e => e.name)).toEqual([
      'aws_s3_bucket.b', 'aws_ami.a', 'm', 'v', 'o', 'aws',
    ]);
  });

  it('classifyYaml survives a YAML file of blank lines', async () => {
    // Five quadratic probes over the same whole-file content, back to back — the worst
    // cost-per-byte in the audit (50 KB bought 94 s).
    expectLinearAndFast(await measure(b => { classifyYaml('hostile.yaml', newlines(b)); }), 'classifyYaml');
    // A space flood exercises the value-position runs, which stayed `\s` and are bounded.
    expectLinearAndFast(
      await measure(b => { classifyYaml('hostile.yaml', `Resources:\n  Type:${spaces(b)}x\n`); }),
      'classifyYaml value run',
    );
  }, TIMEOUT_MS);

  it('still classifies every YAML flavour it used to, at any indentation', () => {
    const c = classifyYaml;
    expect(c('t.yaml', 'AWSTemplateFormatVersion: "2010-09-09"\n')).toBe('CloudFormation');
    expect(c('t.yaml', '  AWSTemplateFormatVersion : "2010-09-09"\n')).toBe('CloudFormation');
    expect(c('t.yaml', '\tAWSTemplateFormatVersion:x\n')).toBe('CloudFormation');
    expect(c('t.yaml', 'Transform: "AWS::Serverless-2016-10-31"\n')).toBe('CloudFormation');
    // Value on the next line: kept working because value-position runs stayed `\s`.
    expect(c('t.yaml', 'Transform:\n  AWS::Serverless-2016-10-31\n')).toBe('CloudFormation');
    expect(c('t.yaml', 'Resources:\n  B:\n    Type: AWS::S3::Bucket\n')).toBe('CloudFormation');
    expect(c('t.yaml', 'Resources:\n  S:\n    Type: "Alexa::ASK::Skill"\n')).toBe('CloudFormation');
    expect(c('t.yaml', 'apiVersion: v1\nkind: Service\n')).toBe('Kubernetes');
    expect(c('t.yaml', '  apiVersion : v1\n  kind : Service\n')).toBe('Kubernetes');
    expect(c('t.yaml', 'apiVersion: v1\r\nkind: Service\r\n')).toBe('Kubernetes');
    expect(c('t.yaml', 'a: 1\n---\napiVersion: v1\nkind: Pod\n')).toBe('Kubernetes');
    expect(c('.github/workflows/ci.yml', 'on: push\njobs:\n  b:\n    runs-on: x\n')).toBe('GitHub Actions');
    expect(c('action.yml', 'runs:\n  using: node20\n')).toBe('GitHub Actions');
    expect(c('docker-compose.yml', 'services:\n  web:\n    image: nginx\n')).toBe('Docker Compose');
    expect(c('play.yaml', '- hosts: all\n  tasks: []\n')).toBe('Ansible');
    expect(c('tasks.yaml', '- name: x\n  become: true\n')).toBe('Ansible');
    // …and still refuses to classify generic YAML.
    expect(c('app.yaml', 'foo: bar\nbaz:\n  - 1\n')).toBeNull();
    expect(c('empty.yaml', newlines(200))).toBeNull();
  });

  it('the BM25 tokenizer survives one giant all-capitals identifier', async () => {
    // `tokenize` splits on `[^A-Za-z0-9]+`, so a run of capitals arrives as ONE unbounded
    // chunk, and this runs over every indexed record's text.
    expectLinearAndFast(
      await measure(b => { tokenize('A'.repeat(b)); }),
      'bm25 tokenize',
    );
  }, TIMEOUT_MS);

  it('the BM25 tokenizer still splits acronym boundaries identically', () => {
    // The token set must be UNCHANGED: `TOKENIZER_VERSION` was not bumped, so a persisted
    // index built before the fix must still agree with a query tokenized after it.
    const t = (s: string): string => tokenize(s).join('|');
    expect(t('HTTPServer')).toBe('httpserver|http|server');
    expect(t('XMLHttpRequest')).toBe('xmlhttprequest|xml|http|request');
    expect(t('ABCd')).toBe('abcd|ab|cd');
    expect(t('parseJSONData')).toBe('parsejsondata|parse|json|data');
    expect(t('ABCDe')).toBe('abcde|abc|de');
    expect(t('ABc')).toBe('abc|bc');
    expect(t('IOError')).toBe('ioerror|io|error');
    expect(t('A')).toBe('');
    expect(t('AB')).toBe('ab');
    expect(t('ABC')).toBe('abc');
    expect(t('getURLFor')).toBe('geturlfor|get|url|for');
  });

  it('parsePythonImports survives a giant whitespace run in a parenthesised import', async () => {
    expectLinearAndFast(
      await measure(b => { parsePythonImports(`from a import (${spaces(b)})`); }),
      'parsePythonImports',
    );
    expectLinearAndFast(
      await measure(b => { parsePythonImports(newlines(b)); }),
      'parsePythonImports newlines',
    );
  }, TIMEOUT_MS);

  it('still collapses a multi-line Python import and keeps its line numbers', () => {
    const imports = parsePythonImports(
      ['import os', 'from a.b import (', '    c,', '    d as e,', ')', 'import sys'].join('\n'),
    );
    expect(imports.map(i => [i.source, i.importedNames.join(','), i.line])).toEqual([
      ['os', 'os', 1],
      ['sys', 'sys', 6],
      ['a.b', 'c,e', 2],
    ]);
    expect(imports.find(i => i.source === 'a.b')?.importedSourceNames).toEqual(['c', 'd']);
    // Blank lines and ragged indentation inside the parens still collapse to one line.
    const ragged = parsePythonImports('from x import (\n\n\tp ,\n\n        q\n\n)\n');
    expect(ragged[0].importedNames).toEqual(['p', 'q']);
    // KNOWN, DELIBERATE DIFFERENCE: an import of NOTHING (`from a import ()`, which is a
    // Python syntax error) no longer yields a name-less import record. The regex form
    // turned a whitespace-only body into a phantom `", "`, so the whitespace-and-newline
    // spelling produced a record while `from a import ()` produced none. Both spellings
    // now agree, and the record it dropped carried no imported names.
    expect(parsePythonImports('from a import ()\n')).toEqual([]);
    expect(parsePythonImports('from a import (\n\n)\n')).toEqual([]);
  });

  it('extractTerraform survives a giant identifier run in a .tf and a .tf.json', async () => {
    expectLinearAndFast(
      await measure(b => {
        extractTerraform([{ path: 'a.tf', content: `resource "a" "b" {\n x = ${'a'.repeat(b)}\n}\n` }]);
      }),
      'extractTerraform hcl refs',
    );
    expectLinearAndFast(
      await measure(b => {
        extractTerraform([{
          path: 'a.tf.json',
          content: JSON.stringify({ resource: { aws_s3_bucket: { b: { x: '${' + 'a'.repeat(b) + '}' } } } }),
        }]);
      }),
      'extractTerraform json refs',
    );
  }, TIMEOUT_MS);

  it('still records Terraform references and still ignores dotless tokens', () => {
    const graph = extractTerraform([
      {
        path: 'main.tf',
        content: [
          'resource "aws_s3_bucket" "b" {',
          '  other = aws_s3_bucket.src.arn',
          '  plain = var.x',
          '  dotless = abc',
          '}',
          'resource "aws_s3_bucket" "src" {}',
          'variable "x" {}',
        ].join('\n'),
      },
      {
        path: 'j.tf.json',
        content: JSON.stringify({
          resource: { aws_s3_bucket: { c: { x: '${aws_s3_bucket.src.arn} plain ${var.x}' } } },
        }),
      },
    ]);
    const edges = graph.references
      .filter(r => r.kind === 'references')
      .map(r => `${r.fromAddress} -> ${r.toAddress}`)
      .sort();
    expect(edges).toEqual([
      'aws_s3_bucket.b -> aws_s3_bucket.src',
      'aws_s3_bucket.b -> var.x',
      'aws_s3_bucket.c -> aws_s3_bucket.src',
      'aws_s3_bucket.c -> var.x',
    ]);
  });

  it('extractSignatures(TS/JS/Java) survives a file of blank lines and stray comment tokens', async () => {
    // The WIDEST-REACH finding of this pass and not a regex at all: the JSDoc/Javadoc
    // lookups ran for EVERY line and each walked BACKWARDS to find where the block above
    // ended and began, reaching line 0 on a file of blank lines. O(n^2) `trim()` calls on
    // the hottest extractor in the repo. Measured on 200 KB of newlines: `a.ts` 240 s
    // (`.js`/`.tsx`/`.jsx`/`.mts` alike), now ~0.16 s. Both backscans are now one forward
    // pass, memoized against the `lines` array.
    for (const ext of ['ts', 'java']) {
      expectLinearAndFast(
        await measure(b => { extractSignatures(`hostile.${ext}`, newlines(b)); }),
        `${ext} signatures (newlines)`,
      );
    }
    // The block-open backscan needs its own payload: blanks alone stop at the `*/` check.
    for (const [label, token] of [['star-slash', '*/\n'], ['open-then-stars', '/**\n*\n']] as const) {
      expectLinearAndFast(
        await measure(b => { extractSignatures('hostile.ts', payload(token, b)); }),
        `ts signatures (${label})`,
      );
      expectLinearAndFast(
        await measure(b => { extractSignatures('hostile.java', payload(token, b)); }),
        `java signatures (${label})`,
      );
    }
  }, TIMEOUT_MS);

  it('still attaches JSDoc and Javadoc across blanks, annotations and earlier blocks', () => {
    // The memo must not confuse two files, and the index must agree with the rescan it
    // replaced: a blank gap, an intervening annotation, and an EARLIER unrelated block are
    // exactly the cases where a wrong "nearest preceding" index silently attaches the wrong
    // comment — a corruption no timing assertion would catch.
    const ts = extractSignatures('a.ts', [
      '/** An earlier, unrelated block. */',
      'export const x = 1;',
      '',
      '/**',
      ' * Loads the thing.',
      ' * @param n count',
      ' */',
      '',
      '',
      'export function load(n: number) {}',
      'export function undocumented() {}',
    ].join('\n')).entries;
    expect(ts.find(e => e.name === 'load')?.docstring).toBe('Loads the thing.');
    expect(ts.find(e => e.name === 'undocumented')?.docstring).toBeUndefined();

    const java = extractSignatures('A.java', [
      '/**',
      ' * Handles it.',
      ' */',
      '@Override',
      '@Deprecated',
      'public void handle() {}',
      'public void bare() {}',
    ].join('\n')).entries;
    expect(java.find(e => e.name === 'handle')?.docstring).toBe('Handles it.');
    expect(java.find(e => e.name === 'bare')?.docstring).toBeUndefined();

    // A second file must not inherit the first file's index.
    expect(extractSignatures('b.ts', 'export function fresh() {}\n').entries[0]?.docstring).toBeUndefined();
  });

  it('extractSignatures(Swift) survives a file of blank lines', async () => {
    // NOT a regex: the doc-comment lookup walked backwards over blank lines from EVERY
    // line, so a file of blank lines cost O(n^2) `trim()` calls. 291 s on 200 KB before
    // carrying the nearest non-blank line forward. The one quadratic here that a regex
    // audit cannot see.
    expectLinearAndFast(
      await measure(b => { extractSignatures('hostile.swift', newlines(b)); }),
      'Swift signatures (newlines)',
    );
  }, TIMEOUT_MS);

  it('still attaches a Swift /// doc comment across intervening blank lines', () => {
    const entries = extractSignatures('a.swift', [
      '/// Loads the thing.',
      '',
      '',
      'func load() {}',
      '',
      '/// A type.',
      'class Widget {}',
      'func undocumented() {}',
    ].join('\n')).entries;
    expect(entries.map(e => [e.name, e.docstring])).toEqual([
      ['load', 'Loads the thing.'],
      ['Widget', 'A type.'],
      ['undocumented', undefined],
    ]);
  });

  it('the generic fallback extractor survives a single line of pure whitespace', async () => {
    // `^\s*(?:MOD)?\s*KW` — two whitespace runs separated by an OPTIONAL group, so a
    // whitespace-only line partitions n x n ways. This fallback serves every extension
    // without a dedicated extractor, so a one-line `.pl` / `.erl` file reached it:
    // 127 s / 133 s on 200 KB before moving the run inside the group.
    for (const ext of ['pl', 'erl']) {
      expectLinearAndFast(
        await measure(b => { extractSignatures(`hostile.${ext}`, spaces(b)); }),
        `generic fallback .${ext}`,
      );
    }
  }, TIMEOUT_MS);

  it('the generic fallback still recognizes modified and bare declarations', () => {
    const names = (src: string): string[] => extractSignatures('a.pl', src).entries.map(e => e.name);
    expect(names('sub greet {\n')).toEqual(['greet']);
    expect(names('  public function handle(x) {\n')).toEqual(['handle']);
    expect(names('\tstatic\tclass\tWidget {\n')).toEqual(['Widget']);
    expect(names('export procedure run()\n')).toEqual(['run']);
    expect(names('async def fetch(x)\n')).toEqual(['fetch']);
    expect(names('notfunction nope\n')).toEqual([]);
    expect(names(spaces(500) + '\n')).toEqual([]);
  });

  it('extractJavaRouteDefinitions survives an annotation argument list of pure whitespace', async () => {
    // `^` without /m looks anchored and safe, but TWO `\s*` split by an optional `{` give
    // n x n split points before the required `"` fails — and the argument blob comes from
    // a balanced-paren scan with no length cap.
    expectLinearAndFast(
      await measure(async b => {
        await extractJavaRouteDefinitions(
          'Hostile.java',
          `import javax.ws.rs.Path;\n@Path(${spaces(b)})\npublic class C { @GET public String f(){return "";} }\n`,
        );
      }),
      'java annotation args',
    );
    expectLinearAndFast(
      await measure(async b => {
        await extractJavaRouteDefinitions(
          'Hostile.java',
          `@RestController\nclass C {\n  @RequestMapping(value =${spaces(b)}x)\n  public String f(){return "";}\n}\n`,
        );
      }),
      'java named annotation args',
    );
  }, TIMEOUT_MS);

  it('still reads positional, braced, named and generously-spaced annotation paths', async () => {
    const paths = async (src: string): Promise<string[]> =>
      (await extractJavaRouteDefinitions('C.java', src)).map(r => r.path);
    expect(await paths('@RestController\nclass C {\n @GetMapping("/a")\n public String a(){return "";}\n}\n')).toEqual(['/a']);
    expect(await paths('@RestController\nclass C {\n @GetMapping(   "/sp"   )\n public String a(){return "";}\n}\n')).toEqual(['/sp']);
    expect(await paths('@RestController\nclass C {\n @GetMapping({"/x", "/y"})\n public String a(){return "";}\n}\n')).toEqual(['/x']);
    expect(await paths('@RestController\nclass C {\n @GetMapping( { "/x" } )\n public String a(){return "";}\n}\n')).toEqual(['/x']);
    expect(await paths('@RestController\nclass C {\n @GetMapping(\n   "/nl"\n )\n public String a(){return "";}\n}\n')).toEqual(['/nl']);
    expect(await paths('@RestController\nclass C {\n @RequestMapping(value = "/v", method = RequestMethod.GET)\n public String a(){return "";}\n}\n')).toEqual(['/v']);
    // `@RequestMapping` needs an explicit method to emit a route (pre-existing, unrelated
    // to the whitespace bound — verified identical against the unfixed extractor).
    expect(await paths('@RestController\nclass C {\n @RequestMapping(path  =  { "/p" }, method = RequestMethod.GET)\n public String a(){return "";}\n}\n')).toEqual(['/p']);
  });
});
