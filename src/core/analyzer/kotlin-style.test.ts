/**
 * Kotlin style fingerprint (change: add-kotlin-style-fingerprint, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { extractFileStyle } from './call-graph.js';
import { fileProfile, rollupLanguage, STYLE_EVIDENCE_FLOOR, STYLE_LANG_SPECS, type FileStyleRaw } from './style-fingerprint.js';

const styleOf = async (content: string, path = 'src/main/kotlin/A.kt'): Promise<FileStyleRaw | undefined> =>
  extractFileStyle({ path, content, language: 'Kotlin' });
const counters = async (content: string, path?: string) => (await styleOf(content, path))?.counters ?? {};

describe('Kotlin style fingerprint', () => {
  it('declares five idioms, no async idiom, and nothing enforced', () => {
    expect(STYLE_LANG_SPECS.Kotlin.idioms).toEqual(['functionForm', 'binding', 'conditionalForm', 'stringForm', 'functionNaming']);
    expect(STYLE_LANG_SPECS.Kotlin.enforced).toEqual([]);
  });

  it('measures the function body form', async () => {
    const c = await counters('fun a() = 1\nfun b(): Int = 2\nfun c() { }\nclass K { fun d() = 3; fun e() { f() } }\nfun f() {}');
    expect(c.functionForm).toEqual({ expression: 3, block: 3 });
  });

  it('counts no function that cannot have a body', async () => {
    const c = await counters('interface I { fun a(); fun b(): Int; fun c(): Int; fun d(); fun e() }\nabstract class A { abstract fun f() }\nexternal fun g()\nexpect fun h(): Int');
    expect(c.functionForm).toBeUndefined();
    // An interface function WITH a body had the choice.
    expect((await counters('interface I { fun a() = 1 }')).functionForm).toEqual({ expression: 1 });
  });

  it('measures val against var for local and member properties', async () => {
    const c = await counters('val top = 1\nclass K { val a = 1; var b = 2\n fun f() { val x = 1; var y = 2; val z = 3 } }');
    expect(c.binding).toEqual({ val: 4, var: 2 });
  });

  it('places if and when in value or statement position', async () => {
    const c = await counters([
      'fun f(a: Boolean, b: Boolean, n: Int): Int {',
      '  if (a) g()',                              // statement
      '  val v = if (a) 1 else 2',                 // value
      '  when (n) { 1 -> g(); else -> {} }',       // statement
      '  for (i in 0..n) if (a) g()',              // statement: the body of a loop
      '  h(if (b) 1 else 2)',                      // value: an argument
      '  return when { a -> 1; else -> 2 }',       // value
      '}',
      'fun k(a: Boolean) = if (a) 1 else 2',        // value: an expression body
      'fun g() {}', 'fun h(x: Int) {}',
    ].join('\n'));
    expect(c.conditionalForm).toEqual({ statement: 3, value: 4 });
  });

  it('counts an else-if chain once, and a branch conditional with the position of its owner', async () => {
    expect((await counters('fun f(a: Boolean, b: Boolean) { if (a) g() else if (b) g() else if (a) g() else g() }\nfun g() {}')).conditionalForm)
      .toEqual({ statement: 1 });
    expect((await counters('fun f(n: Int, b: Boolean) = when (n) { 1 -> if (b) 1 else 2; else -> 3 }')).conditionalForm)
      .toEqual({ value: 2 });
    expect((await counters('fun f(n: Int, b: Boolean) { when (n) { 1 -> if (b) g() else g(); else -> g() } }\nfun g() {}')).conditionalForm)
      .toEqual({ statement: 2 });
  });

  it('measures templates against concatenation with a string literal operand', async () => {
    const c = await counters('fun f(a: String, n: Int, m: Int) {\n  val t = "x $a"\n  val u = "y ${a.length}"\n  val w = "p" + a\n  val z = a + "q"\n  val plain = "no template"\n  val sum = n + m\n}');
    expect(c.stringForm).toEqual({ template: 2, concat: 2 });
  });

  it('measures naming case, without backtick names', async () => {
    const c = await counters('fun loadUser() {}\nfun saveUser() {}\nfun Screen() {}\nfun snake_case_name() {}\nfun `loads the user`() {}\nfun `camelCase in backticks`() {}\nfun single() {}');
    expect(c.functionNaming).toEqual({ camelCase: 2, PascalCase: 1, snake_case: 1 });
  });

  it('takes no naming sample from a test file, but still measures its other idioms', async () => {
    const c = await counters('class UserServiceTest {\n  fun returnsUser() { val a = 1 }\n  fun `returns null when missing`() {}\n}', 'src/test/kotlin/UserServiceTest.kt');
    expect(c.functionNaming).toBeUndefined();
    expect(c.binding).toEqual({ val: 1 });
  });

  it('has no fingerprint for a Gradle build script, and has one for another script', async () => {
    const script = 'val a = 1\nfun configure() = a\n';
    expect(await styleOf(script, 'build.gradle.kts')).toBeUndefined();
    expect(await styleOf(script, 'settings.gradle.kts')).toBeUndefined();
    expect(await styleOf(script, 'buildSrc/src/main/kotlin/conventions.gradle.kts')).toBeUndefined();
    expect((await styleOf(script, 'scripts/release.main.kts'))?.counters.binding).toEqual({ val: 1 });
  });

  it('reports the spec scenario: 30 expression bodies and 10 block bodies', async () => {
    const source = Array.from({ length: 30 }, (_, i) => `fun e${i}() = ${i}`).concat(Array.from({ length: 10 }, (_, i) => `fun b${i}() { }`)).join('\n');
    const profile = fileProfile((await styleOf(source))!);
    expect(profile.idioms.functionForm).toMatchObject({ dominant: 'expression', ratio: 0.75, samples: 40 });
    expect(profile.idioms.asyncForm).toBeUndefined();
  });

  it('reports a null signal below the evidence floor', async () => {
    const raw = (await styleOf('fun f(a: String) {\n  val t = "x $a"\n  val u = "y $a"\n  val w = "p" + a\n}'))!;
    expect(STYLE_EVIDENCE_FLOOR).toBeGreaterThan(3);
    expect(fileProfile(raw).idioms.stringForm).toEqual({ signal: null, reason: 'below_floor' });
    expect(rollupLanguage([raw], 'Kotlin').language).toBe('Kotlin');
  });

  it('survives a deep else-if chain and deep nesting', async () => {
    const chain = `fun f(n: Int) { if (n == 0) g()${' else if (n == 1) g()'.repeat(400)} }\nfun g() {}`;
    expect((await counters(chain)).conditionalForm).toEqual({ statement: 1 });
    const nested = `fun f(a: Boolean) = ${'if (a) '.repeat(60)}1${' else 0'.repeat(60)}`;
    // Beyond the hop bound a conditional is not counted, and none is miscounted as a statement.
    expect(Object.keys((await counters(nested)).conditionalForm ?? {})).toEqual(['value']);
  });
});
