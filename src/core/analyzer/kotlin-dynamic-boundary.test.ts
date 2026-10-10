/**
 * Kotlin dynamic-boundary sites (change: add-kotlin-dynamic-boundary, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { extractFileDynamicBoundary } from './call-graph.js';
import { supportsDynamicBoundary, supportsLiteralReflection, type DynamicBoundarySite } from './dynamic-boundary.js';

const sitesOf = async (content: string): Promise<DynamicBoundarySite[]> =>
  (await extractFileDynamicBoundary({ path: 'A.kt', content, language: 'Kotlin' }))?.sites ?? [];
const kinds = async (content: string): Promise<string[]> => (await sitesOf(content)).map(s => s.kind).sort();

describe('Kotlin dynamic-boundary sites', () => {
  it('backs dynamicBoundary and never literalReflection', () => {
    expect(supportsDynamicBoundary('Kotlin')).toBe(true);
    expect(supportsLiteralReflection('Kotlin')).toBe(false);
  });

  it('records class loading and service loading as dynamic-import', async () => {
    expect(await kinds('fun f(n: String) = Class.forName(n)')).toEqual(['dynamic-import']);
    expect(await kinds('fun f(n: String, loader: ClassLoader) = loader.loadClass(n)')).toEqual(['dynamic-import']);
    expect(await kinds('fun f(n: String) = Thread.currentThread().contextClassLoader!!.loadClass(n)')).toEqual(['dynamic-import']);
    expect(await kinds('import java.util.ServiceLoader\nfun f() = ServiceLoader.load(Plugin::class.java)')).toEqual(['dynamic-import']);
    expect(await kinds('fun f() = java.util.ServiceLoader.load(Plugin::class.java)')).toEqual(['dynamic-import']);
  });

  it('does not read a project function named loadClass or load as a site', async () => {
    expect(await kinds('fun loadClass(n: String) = n\nfun f() = loadClass("x")')).toEqual([]);
    expect(await kinds('import java.util.ServiceLoader\nfun f(c: Config) = c.load()')).toEqual([]);
    expect(await kinds('fun f(repo: Repo) = repo.loadClass("x")')).toEqual([]);
  });

  it('records Java reflection behind the import or the `.java` bridge, with its selector', async () => {
    const sites = await sitesOf('fun f(h: Handler) { Handler::class.java.getMethod("run").invoke(h) }');
    expect(sites.map(s => s.kind)).toEqual(['reflective-invoke']);
    // The literal names no symbol in a single-file derivation: the selector was read.
    expect(sites[0].refusal).toBe('unresolved-in-file-scope');
    expect(await kinds('import java.lang.reflect.Method\nfun f(m: Method, o: Any) = m.invoke(o)')).toEqual(['reflective-invoke']);
    expect(await kinds('fun f(o: Any) = o.javaClass.getDeclaredMethod("run")')).toEqual(['reflective-invoke']);
    expect(await kinds('fun f() = Widget::class.java.newInstance()')).toEqual(['reflective-invoke']);
  });

  it('reads no selector from an interpolated string', async () => {
    const sites = await sitesOf('fun f(h: Handler, p: String) { Handler::class.java.getMethod("get$p") }');
    expect(sites.map(s => s.refusal)).toEqual(['no-static-target']);
  });

  it('records a class load and the invocation chained on it as two sites', async () => {
    expect(await kinds('fun f(n: String): Any = Class.forName(n).getDeclaredConstructor().newInstance()'))
      .toEqual(['dynamic-import', 'reflective-invoke']);
    expect(await kinds('import kotlin.reflect.full.memberFunctions\nfun f(n: String) {\n  val k = Class.forName(n).kotlin\n  k.members.first { it.name == "run" }.call()\n}'))
      .toEqual(['dynamic-import', 'reflective-invoke']);
  });

  it('records Kotlin reflection behind the import or a class literal', async () => {
    expect(await kinds('import kotlin.reflect.KFunction\nfun f(fn: KFunction<*>, t: Any) = fn.call(t)')).toEqual(['reflective-invoke']);
    expect(await kinds('fun f(t: Any) = t::class.members.first().call(t)')).toEqual(['reflective-invoke']);
    expect(await kinds('fun f() = Widget::class.createInstance()')).toEqual(['reflective-invoke']);
    expect(await kinds('fun f(t: Any) { val fns = t::class.memberFunctions }')).toEqual(['reflective-invoke']);
    expect(await kinds('fun f() { val c = Widget::class.primaryConstructor }')).toEqual(['reflective-invoke']);
    expect(await kinds('import kotlin.reflect.KCallable\nfun f(fn: KCallable<*>, args: Map<Any, Any>) = fn.callBy(args)')).toEqual(['reflective-invoke']);
  });

  it('records container lookups only behind the container import', async () => {
    expect(await kinds('import org.springframework.context.ApplicationContext\nfun f(ctx: ApplicationContext) = ctx.getBean("users")')).toEqual(['container-resolution']);
    expect(await kinds('import org.koin.core.component.inject\nclass A { val repo: Repo by inject() }')).toEqual(['container-resolution']);
    expect(await kinds('import org.koin.dsl.module\nval m = module { single { Service(get()) } }')).toEqual(['container-resolution']);
    expect(await kinds('import org.koin.compose.koinInject\nfun f() { val s: Service = koinInject() }')).toEqual(['container-resolution']);
    expect(await kinds('import org.koin.core.component.getKoin\nfun f() = getKoin()')).toEqual(['container-resolution']);
    expect(await kinds('import org.kodein.di.instance\nclass A(di: DI) { val repo: Repo by di.instance() }')).toEqual(['container-resolution']);
    expect(await kinds('import org.kodein.di.direct\nimport org.kodein.di.instance\nfun f(di: DI): Repo = di.direct.instance()')).toEqual(['container-resolution']);
    expect(await kinds('class A(val cache: Cache) { fun f() = cache.get() }')).toEqual([]);
    expect(await kinds('class A(val ctx: Ctx) { fun f() = ctx.getBean("x") }')).toEqual([]);
    expect(await kinds('class A(val di: Holder) { fun f() = di.instance() }')).toEqual([]);
  });

  it('records script evaluation and dynamic proxies behind their imports', async () => {
    expect(await kinds('import javax.script.ScriptEngine\nfun f(e: ScriptEngine, code: String) = e.eval(code)')).toEqual(['code-eval']);
    expect(await kinds('import kotlin.script.experimental.jvmhost.BasicJvmScriptingHost\nfun f(src: Any, cfg: Any) = BasicJvmScriptingHost().eval(src, cfg, null)')).toEqual(['code-eval']);
    expect(await kinds('import java.lang.reflect.Proxy\nfun f(l: ClassLoader, h: Any) = Proxy.newProxyInstance(l, arrayOf(), h)')).toEqual(['metaprogrammed-definition']);
    expect(await kinds('fun f(e: Engine, code: String) = e.eval(code)')).toEqual([]);
  });

  it('does not read ordinary calls that share a reflective name', async () => {
    // OkHttp, `Callable`, a map read, and a function value.
    expect(await kinds('fun f(client: OkHttpClient, r: Request) = client.newCall(r).execute()')).toEqual([]);
    expect(await kinds('fun f(c: java.util.concurrent.Callable<Int>) = c.call()')).toEqual([]);
    expect(await kinds('fun f(m: Map<String, Int>) = m.get("a")')).toEqual([]);
    expect(await kinds('fun twice(x: Int) = x * 2\nfun f(): Int { val g: (Int) -> Int = ::twice; return g.invoke(2) }')).toEqual([]);
    expect(await kinds('fun f(m: Module) = m.functions')).toEqual([]);
    // A class literal alone is not reflection: a logger takes one.
    expect(await kinds('class A { val log = LoggerFactory.getLogger(A::class.java) }')).toEqual([]);
    expect(await kinds('fun f() = A::class.simpleName')).toEqual([]);
  });

  it('does not read an import that is only quoted in a string', async () => {
    expect(await kinds('val sample = """\nimport org.koin.core.component.inject\n"""\nclass A(val cache: Cache) { fun f() = cache.get() }')).toEqual([]);
  });

  it('attributes a site to its enclosing function', async () => {
    const [site] = await sitesOf('class Loader {\n  fun load(n: String) = Class.forName(n)\n}');
    expect(site.symbolId).toContain('Loader.load');
    expect(site.line).toBe(2);
  });
});

describe('Kotlin operator-dispatch count', () => {
  const parse = async (content: string) => {
    const { extractFileBoundaryFacts } = await import('./call-graph.js');
    return (declared: string[] = []) => extractFileBoundaryFacts({ path: 'A.kt', content, language: 'Kotlin' }, declared);
  };

  it('counts a site only when its convention function is a declared operator', async () => {
    const facts = await parse('fun f(a: Money, b: Money) = a + b');
    expect((await facts()).operatorSites).toBe(0);
    expect((await facts(['minus'])).operatorSites).toBe(0);
    expect((await facts(['plus'])).operatorSites).toBe(1);
  });

  it('counts the operators the file itself declares', async () => {
    const facts = await parse('class Money(val c: Long) { operator fun plus(o: Money) = Money(c + o.c) }\nfun f(a: Money, b: Money) = a + b');
    // `c + o.c` and `a + b`: the operand type is not computed, so both are possible callers.
    expect((await facts()).operatorSites).toBe(2);
  });

  it('maps each operator form to its convention function', async () => {
    const one = async (source: string, declared: string) => (await (await parse(`fun f() { ${source} }`))([declared])).operatorSites;
    expect(await one('a - b', 'minus')).toBe(1);
    expect(await one('a * b; a / b; a % b', 'times')).toBe(1);
    expect(await one('a..b', 'rangeTo')).toBe(1);
    expect(await one('a..<b', 'rangeUntil')).toBe(1);
    expect(await one('a in b; a !in b', 'contains')).toBe(2);
    expect(await one('a < b; a >= b', 'compareTo')).toBe(2);
    expect(await one('-a; !a', 'unaryMinus')).toBe(1);
    expect(await one('i++; --i', 'inc')).toBe(1);
    expect(await one('a[1]', 'get')).toBe(1);
    expect(await one('a[1] = 2', 'set')).toBe(1);
    expect(await one('a += b', 'plusAssign')).toBe(1);
    expect(await one('a += b', 'plus')).toBe(1);
    expect(await one('for (x in xs) {}', 'iterator')).toBe(1);
    expect(await one('val (p, q) = pair', 'component2')).toBe(1);
    expect(await one('val v by lazyValue', 'getValue')).toBe(1);
  });

  it('does not count a type check, a non-null assertion, equality, or a call', async () => {
    const facts = await parse('fun f() { a is B; x!!; a == b; a() }');
    expect((await facts(['contains', 'not', 'equals', 'invoke', 'plus'])).operatorSites).toBe(0);
  });

  it('is in the report without becoming a site', async () => {
    const { buildDynamicBoundaryReport, buildOperatorDispatchSummary } = await import('./dynamic-boundary.js');
    expect(buildOperatorDispatchSummary(['plus'], [{ filePath: 'A.kt', sites: 0 }])).toBeUndefined();
    const summary = buildOperatorDispatchSummary(['plus', 'get', 'plus'], [{ filePath: 'b/B.kt', sites: 2 }, { filePath: 'a/A.kt', sites: 1 }, { filePath: 'c/C.kt', sites: 0 }]);
    expect(summary).toEqual({ functions: ['get', 'plus'], totalSites: 3, files: [{ filePath: 'a/A.kt', sites: 1 }, { filePath: 'b/B.kt', sites: 2 }] });
    const report = buildDynamicBoundaryReport([], summary);
    expect(report).toMatchObject({ totalSites: 0, totalFiles: 0, files: [], operatorDispatch: summary });
    expect(buildDynamicBoundaryReport([])).toBeUndefined();
  });
});
