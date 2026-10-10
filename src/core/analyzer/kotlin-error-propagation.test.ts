/**
 * Kotlin error propagation (change: add-kotlin-error-propagation, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { ERROR_PROPAGATION_LANGUAGES, extractExceptionFactsFromSource } from './exception-flow.js';
import { KOTLIN_CONTRACT_THROWS, KOTLIN_INLINE_LAMBDA_CALLS } from './kotlin-exception-flow.js';
import { languageSupport } from './language-support.js';

const facts = (body: string) => extractExceptionFactsFromSource(body, 'Kotlin', 'A.kt');
const escaping = async (body: string) => (await facts(body)).throwSites.filter(t => !t.locallyHandled).map(t => `${t.type}${t.source === 'throws_clause' ? ' (declared)' : ''}`);
const handled = async (body: string) => (await facts(body)).throwSites.filter(t => t.locallyHandled).map(t => t.type);

describe('Kotlin throw sites', () => {
  it('records the constructed type of an explicit throw', async () => {
    expect(await escaping('fun f() { throw IllegalArgumentException("x") }')).toEqual(['IllegalArgumentException']);
    expect(await escaping('fun f() { throw java.io.IOException("x") }')).toEqual(['IOException']);
    expect(await escaping('fun f(id: String?): String = id ?: throw NotFound(id)')).toEqual(['NotFound']);
  });

  it('types a rethrow from the enclosing catch parameter, and anything else as dynamic', async () => {
    expect(await escaping('fun f() { try { g() } catch (e: IOException) { log(e); throw e } }\nfun g() {}\nfun log(e: Any) {}')).toEqual(['IOException']);
    expect(await escaping('fun f(cause: Throwable) { throw cause }')).toEqual(['<dynamic>']);
    expect((await facts('fun f(cause: Throwable) { throw cause }')).dynamicThrowCount).toBe(1);
  });

  it('records standard-library contract calls with the type each one throws', async () => {
    expect(await escaping('fun f(x: Int, v: String?) {\n  require(x > 0)\n  requireNotNull(v)\n  check(x < 9)\n  checkNotNull(v)\n  error("m")\n  TODO()\n}'))
      .toEqual(['IllegalArgumentException', 'IllegalArgumentException', 'IllegalStateException', 'IllegalStateException', 'IllegalStateException', 'NotImplementedError']);
    const site = (await facts('fun f(x: Int) { require(x > 0) }')).throwSites[0];
    expect(site.contractCallee).toBe('require');
    // A member call of that name is not the standard-library function.
    expect(await escaping('fun f(v: Validator) { v.require(1) }')).toEqual([]);
    expect(Object.keys(KOTLIN_CONTRACT_THROWS).sort()).toEqual(['TODO', 'check', 'checkNotNull', 'error', 'require', 'requireNotNull']);
  });

  it('records `@Throws` as declared escapes', async () => {
    expect(await escaping('@Throws(IOException::class, TimeoutException::class)\nfun f() { g() }\nfun g() {}')).toEqual(['IOException (declared)', 'TimeoutException (declared)']);
  });
});

describe('Kotlin handlers', () => {
  it('matches a typed catch by exact name, and treats Throwable as catch-all', async () => {
    const source = (type: string) => `fun f() { try { throw IllegalStateException("x") } catch (e: ${type}) { } }`;
    expect(await handled(source('IllegalStateException'))).toEqual(['IllegalStateException']);
    expect(await handled(source('Throwable'))).toEqual(['IllegalStateException']);
    // No class hierarchy: a supertype catch is not known to match, so the throw propagates.
    expect(await escaping(source('RuntimeException'))).toEqual(['IllegalStateException']);
  });

  it('does not count a handler that rethrows as handling', async () => {
    expect(await escaping('fun f() { try { throw IllegalStateException("x") } catch (e: IllegalStateException) { throw e } }'))
      .toEqual(['IllegalStateException', 'IllegalStateException']);
  });

  it('checks every clause of a multi-catch try, and outer guards', async () => {
    expect(await handled('fun f() {\n  try {\n    try { throw B("x") } catch (e: A) { }\n  } catch (e: B) { }\n}')).toEqual(['B']);
    expect(await handled('fun f() { try { throw B("x") } catch (e: A) { } catch (e: B) { } }')).toEqual(['B']);
  });

  it('adds the finally boundaries', async () => {
    expect((await facts('fun f() { try { g() } finally { cleanup() } }\nfun g() {}\nfun cleanup() {}')).boundaries)
      .toEqual(['Kotlin finally control transfer/effects are not modeled at line 1']);
    const abrupt = await facts('fun f(): Int { try { throw IllegalStateException("x") } finally { return 1 } }');
    expect(abrupt.boundaries).toEqual(['Kotlin definitely abrupt finally suppresses try-body completion at line 1']);
    expect(abrupt.throwSites[0].locallyHandled).toBe(true);
  });

  it('treats `runCatching { }` as a catch-all, unless the chain ends in `getOrThrow()`', async () => {
    expect(await handled('fun f() = runCatching { throw IllegalStateException("x") }.getOrNull()')).toEqual(['IllegalStateException']);
    expect(await handled('fun f(s: Svc) = s.runCatching { throw IllegalStateException("x") }.getOrDefault(1)')).toEqual(['IllegalStateException']);
    expect(await escaping('fun f() = runCatching { throw IllegalStateException("x") }.getOrThrow()')).toEqual(['IllegalStateException']);
  });

  it('adds the resource-cleanup boundary for `use { }`', async () => {
    expect((await facts('fun f(r: Reader) = r.use { it.read() }')).boundaries).toEqual(['Kotlin use { } resource-cleanup exceptions are not modeled at line 1']);
  });
});

describe('Kotlin lambdas', () => {
  it('lets a throw inside a standard-library inline lambda escape the enclosing function', async () => {
    expect(await escaping('fun f(xs: List<Int>) { xs.forEach { if (it < 0) throw NegativeValue(it) } }')).toEqual(['NegativeValue']);
    expect(await escaping('fun f(x: Int?) { x?.let { throw Bad(it) } }')).toEqual(['Bad']);
    expect(await handled('fun f(xs: List<Int>) { try { xs.map { throw Bad(it) } } catch (e: Bad) { } }')).toEqual(['Bad']);
    for (const name of ['let', 'run', 'apply', 'also', 'with', 'use', 'synchronized', 'repeat', 'forEach', 'map', 'filter']) {
      expect(KOTLIN_INLINE_LAMBDA_CALLS.has(name), name).toBe(true);
    }
  });

  it('does not attribute a throw inside a stored lambda or a nested function, and counts it', async () => {
    const stored = await facts('fun f(bus: Bus) {\n  bus.subscribe { throw Later("x") }\n  val handler = { x: Int -> throw Stored(x) }\n  fun nested() { throw Nested("x") }\n}');
    expect(stored.throwSites).toEqual([]);
    expect(stored.boundaries).toEqual(['3 throw(s) inside a stored lambda or nested function are not attributed to this function']);
  });
});

describe('Kotlin boundaries and call sites', () => {
  it('counts non-null assertions and unsafe casts, and does not make them throw sites', async () => {
    const result = await facts('fun f(a: String?, b: Any) = a!!.length + (b as String).length + ((b as? Int) ?: 0)');
    expect(result.throwSites).toEqual([]);
    expect(result.boundaries).toEqual(['1 non-null assertion(s) (!!) and 1 unsafe cast(s) (as) may throw at run time; implicit runtime exceptions are not throw sites']);
  });

  it('tags each call site with its receiver kind and its enclosing guards', async () => {
    const result = await facts('class C(val repo: Repo) {\n  fun f() {\n    try {\n      helper()\n      this.other()\n      this.repo.save()\n      repo.find()\n      Thing()\n    } catch (e: Throwable) { }\n  }\n  fun helper() {}\n  fun other() {}\n}');
    const f = result.callSites.filter(c => c.line >= 4 && c.line <= 8).map(c => `${c.calleeName}:${c.receiver}:${c.guards.length}`);
    expect(f).toEqual(['helper:none:1', 'other:self:1', 'save:self-field:1', 'find:other:1', 'Thing:constructor:1']);
  });

  it('Kotlin backs the errorPropagation capability', () => {
    expect(ERROR_PROPAGATION_LANGUAGES.has('Kotlin')).toBe(true);
    expect(languageSupport('Kotlin').capabilities).toContain('errorPropagation');
  });
});

// ── Through the analysis pipeline and the `analyze_error_propagation` conclusion ──────────────
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { openloreAnalyze } from '../../api/analyze.js';
import { OPENLORE_DIR } from '../../constants.js';
import { handleAnalyzeErrorPropagation } from '../services/mcp-handlers/error-propagation.js';

describe('analyze_error_propagation for Kotlin', () => {
  let root: string;
  const propagate = async (symbol: string) => await handleAnalyzeErrorPropagation({ directory: root, symbol }) as {
    escapes?: Array<{ type: string; kind: string }>; handledInternally?: Array<{ type: string }>; boundaries?: string[]; unsupported?: boolean;
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'openlore-kotlin-errors-')));
    const files: Record<string, string> = {
      'src/main/kotlin/app/Checks.kt': 'package app\n\nfun stdlibContract(x: Int) {\n    require(x > 0)\n}\n',
      'src/main/kotlin/shadow/Require.kt': 'package shadow\n\nfun require(flag: Boolean) {\n    if (!flag) throw ProjectFailure("no")\n}\n\nclass ProjectFailure(m: String) : RuntimeException(m)\n\nfun shadowed(x: Int) {\n    require(x > 0)\n}\n',
      'src/main/kotlin/app/Service.kt': 'package app\n\nclass Service {\n    fun load(id: String): String {\n        if (id.isEmpty()) throw IllegalArgumentException("id")\n        return id\n    }\n\n    fun safe(id: String): String = try {\n        load(id)\n    } catch (e: IllegalArgumentException) {\n        "none"\n    }\n\n    fun each(ids: List<String>) {\n        ids.forEach { load(it) }\n    }\n}\n',
      'src/main/java/app/Caller.java': 'package app;\n\npublic class Caller {\n    public String run(Service s) {\n        return s.load("x");\n    }\n}\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
    await mkdir(join(root, OPENLORE_DIR), { recursive: true });
    await writeFile(join(root, OPENLORE_DIR, 'config.json'), JSON.stringify({
      version: '1.0.0', projectType: 'unknown', openspecPath: './openspec',
      analysis: { maxFiles: 100000, includePatterns: [], excludePatterns: [] },
      generation: { model: 'none', domains: 'auto' }, createdAt: '2026-10-10T00:00:00.000Z', lastRun: null,
    }));
    await openloreAnalyze({ rootPath: root, force: true, quiet: true });
  }, 120_000);

  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('reports a standard-library contract call as a throw site', async () => {
    const result = await propagate('stdlibContract');
    expect(result.escapes?.map(e => e.type)).toEqual(['IllegalArgumentException']);
  });

  it('suppresses the contract site when a project function of that name is in scope', async () => {
    const result = await propagate('shadowed');
    // The project `require` throws `ProjectFailure`; the standard-library type is not reported.
    expect(result.escapes?.map(e => e.type)).toEqual(['ProjectFailure']);
  });

  it('propagates through a call edge, handles at a typed catch, and escapes through an inline lambda', async () => {
    expect((await propagate('load')).escapes?.map(e => e.type)).toEqual(['IllegalArgumentException']);
    const safe = await propagate('safe');
    expect(safe.escapes).toEqual([]);
    expect(safe.handledInternally?.map(h => h.type)).toEqual(['IllegalArgumentException']);
    expect((await propagate('each')).escapes?.map(e => e.type)).toEqual(['IllegalArgumentException']);
  });

  it('analyzes a Kotlin callee of a Java caller instead of reporting an unsupported language', async () => {
    const result = await propagate('run');
    expect(result.unsupported).toBeUndefined();
    expect(result.escapes?.map(e => e.type)).toEqual(['IllegalArgumentException']);
    expect((result.boundaries ?? []).some(b => /unsupported language/.test(b))).toBe(false);
  });

  it('always names the coroutine boundary for a Kotlin function', async () => {
    expect((await propagate('load')).boundaries?.some(b => /coroutine cancellation/.test(b))).toBe(true);
  });
});
