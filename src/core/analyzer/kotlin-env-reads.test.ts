/**
 * Kotlin environment-variable reads (change: add-kotlin-env-var-reads, issue #546).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { countKotlinDynamicEnvReads, extractEnvReadSites, extractEnvVars, extractKotlinEnvReads } from './env-extractor.js';

const read = (expression: string, path = 'A.kt') => extractKotlinEnvReads(`val v = ${expression}\n`, path).map(r => [r.name, r.required]);

describe('Kotlin env read forms', () => {
  it('reads `System.getenv("X")` and the forms on the `System.getenv()` map', () => {
    expect(read('System.getenv("A_VAR")')).toEqual([['A_VAR', true]]);
    expect(read('System.getenv()["B_VAR"]')).toEqual([['B_VAR', true]]);
    expect(read('System.getenv().get("C_VAR")')).toEqual([['C_VAR', true]]);
    expect(read('System.getenv().getValue("D_VAR")')).toEqual([['D_VAR', true]]);
    expect(read('System.getenv().getOrDefault("E_VAR", "d")')).toEqual([['E_VAR', false]]);
    expect(read('System.getenv().getOrElse("F_VAR") { "d" }')).toEqual([['F_VAR', false]]);
  });

  it('reads dotenv-kotlin lookups only in a file that imports the library', () => {
    const body = 'val dotenv = dotenv { }\nval env = Dotenv.load()\nval a = dotenv["A_VAR"]\nval b = env.get("B_VAR")\nval c = dotenv.get("C_VAR", "d")\n';
    expect(extractKotlinEnvReads(`import io.github.cdimascio.dotenv.dotenv\n${body}`, 'A.kt').map(r => [r.name, r.required]))
      .toEqual([['A_VAR', true], ['B_VAR', true], ['C_VAR', false]]);
    expect(extractKotlinEnvReads(body, 'A.kt')).toEqual([]);
  });

  it('reads a Gradle provider only in a Gradle Kotlin build script, tagged build-script', () => {
    const source = 'val region = providers.environmentVariable("ACME_REGION").orElse("local")\nval strict = providers.environmentVariable("ACME_KEY")\nval port = System.getenv("PORT")\n';
    expect(extractKotlinEnvReads(source, 'build.gradle.kts')).toEqual([
      { name: 'ACME_REGION', index: source.indexOf('providers'), required: false, tag: 'build-script' },
      { name: 'ACME_KEY', index: source.indexOf('providers', 20), required: true, tag: 'build-script' },
      { name: 'PORT', index: source.indexOf('System'), required: true, tag: 'build-script' },
    ]);
    expect(extractKotlinEnvReads(source, 'src/main/kotlin/A.kt').map(r => r.name)).toEqual(['PORT']);
  });

  it('does not read a lookup on an ordinary map, a lower-case name, or a comment', () => {
    expect(read('settings.get("A_VAR")')).toEqual([]);
    expect(read('config["A_VAR"]')).toEqual([]);
    expect(read('System.getenv("lowercase")')).toEqual([]);
    expect(read('1 // System.getenv("A_VAR")')).toEqual([]);
    expect(read('1 /* System.getenv("A_VAR") */')).toEqual([]);
    expect(read('System.getProperty("A_VAR")')).toEqual([]);
  });

  it('counts a non-literal name as a dynamic read and never lists it', () => {
    const source = 'fun f(name: String) = System.getenv(name)\nfun g() = System.getenv("${PREFIX}_X")\nfun h() = System.getenv()\nfun i() = System.getenv("A_VAR")\n';
    expect(countKotlinDynamicEnvReads(source)).toBe(1);
    expect(extractKotlinEnvReads(source, 'A.kt').map(r => r.name)).toEqual(['A_VAR']);
  });
});

describe('Kotlin env reads: required or optional', () => {
  it('is optional when the same expression supplies a value', () => {
    expect(read('System.getenv("X_VAR") ?: "8080"')).toEqual([['X_VAR', false]]);
    expect(read('(System.getenv("X_VAR") ?: "8080").toInt()')).toEqual([['X_VAR', false]]);
    expect(read('System.getenv("X_VAR")?.toInt() ?: 8080')).toEqual([['X_VAR', false]]);
    expect(read('System.getenv().get("X_VAR") ?: "d"')).toEqual([['X_VAR', false]]);
    expect(read('System.getenv()["X_VAR"] ?: "d"')).toEqual([['X_VAR', false]]);
  });

  it('is required when asserted non-null, when the fallback throws, and with no fallback', () => {
    expect(read('System.getenv("X_VAR")!!')).toEqual([['X_VAR', true]]);
    expect(read('requireNotNull(System.getenv("X_VAR"))')).toEqual([['X_VAR', true]]);
    expect(read('checkNotNull(System.getenv("X_VAR")) { "missing" }')).toEqual([['X_VAR', true]]);
    expect(read('System.getenv("X_VAR") ?: error("X_VAR is required")')).toEqual([['X_VAR', true]]);
    expect(read('System.getenv("X_VAR") ?: throw IllegalStateException("x")')).toEqual([['X_VAR', true]]);
    expect(read('System.getenv("X_VAR")')).toEqual([['X_VAR', true]]);
    expect(read('System.getenv("X_VAR").toInt()')).toEqual([['X_VAR', true]]);
  });
});

describe('Kotlin env reads in the inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'openlore-kotlin-env-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, content: string): string => {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  it('lists `.kt` and `.kts` reads, tags build-script reads, and skips test sources', async () => {
    const files = [
      write('src/main/kotlin/a/Env.kt', 'object Env {\n  fun port() = (System.getenv("ACME_PORT") ?: "8080").toInt()\n  fun url() = System.getenv("ACME_DATABASE_URL") ?: error("required")\n}\n'),
      write('build.gradle.kts', 'val region = providers.environmentVariable("ACME_REGION").orElse("local")\n'),
      write('scripts/deploy.main.kts', 'val token = System.getenv("ACME_TOKEN")!!\n'),
      write('src/test/kotlin/a/EnvTest.kt', 'val t = System.getenv("ONLY_IN_TESTS")\n'),
    ];
    const vars = await extractEnvVars(files, root);
    expect(vars.map(v => [v.name, v.required, v.tags ?? []])).toEqual([
      ['ACME_DATABASE_URL', true, []],
      ['ACME_PORT', false, []],
      ['ACME_REGION', false, ['build-script']],
      ['ACME_TOKEN', true, []],
    ]);
  });

  it('gives line-precise read sites', () => {
    const source = 'object Env {\n  fun port() = System.getenv("ACME_PORT") ?: "1"\n\n  fun url() = System.getenv("ACME_URL")!!\n}\n';
    expect(extractEnvReadSites(source, 'Env.kt', '.kt')).toEqual([
      { name: 'ACME_PORT', file: 'Env.kt', line: 2, required: false },
      { name: 'ACME_URL', file: 'Env.kt', line: 4, required: true },
    ]);
  });
});
