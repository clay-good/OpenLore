/**
 * Kotlin syntax coverage (change: harden-kotlin-grammar-currency, issue #546).
 * Each corpus file goes through the real call-graph extractor, so the result includes the
 * pre-parse normalization the pipeline applies.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import { kotlinCodeMask, normalizeKotlinForParse } from './kotlin-source.js';
import {
  KOTLIN_LANGUAGE_LEVEL, KOTLIN_SYNTAX_CORPUS, KOTLIN_SYNTAX_DOC_MARKERS, KOTLIN_SYNTAX_KNOWN_GAPS,
  KOTLIN_SYNTAX_NORMALIZED, renderKotlinSyntaxSection,
} from './kotlin-syntax-corpus.js';

const DIR = fileURLToPath(new URL('./fixtures/kotlin-syntax/', import.meta.url));
const read = (file: string): string => readFileSync(`${DIR}${file}.kt`, 'utf-8');

async function analyze(path: string, content: string) {
  const result = await new CallGraphBuilder().build([{ path, content, language: 'Kotlin' }]);
  return { result, health: result.parseHealthByFile?.get(path) };
}

const version = (v: string): number => { const [major, minor] = v.split('.').map(Number); return major * 100 + minor; };

describe('Kotlin syntax corpus', () => {
  it('lists exactly the fixture files, each at or below the declared level', () => {
    const onDisk = readdirSync(DIR).filter(f => f.endsWith('.kt')).map(f => f.slice(0, -3)).sort();
    expect(KOTLIN_SYNTAX_CORPUS.map(f => f.file).sort()).toEqual(onDisk);
    for (const f of KOTLIN_SYNTAX_CORPUS) expect(version(f.stableSince), f.file).toBeLessThanOrEqual(version(KOTLIN_LANGUAGE_LEVEL));
    for (const gap of Object.keys(KOTLIN_SYNTAX_KNOWN_GAPS)) expect(onDisk).toContain(gap);
    for (const name of KOTLIN_SYNTAX_NORMALIZED) expect(onDisk).toContain(name);
  });

  it.each(KOTLIN_SYNTAX_CORPUS.map(f => [f.file, f.feature] as const))('%s parses clean or is a known gap', async (file) => {
    const { health } = await analyze(`${file}.kt`, read(file));
    const isGap = file in KOTLIN_SYNTAX_KNOWN_GAPS;
    if (isGap && !health) throw new Error(`"${file}" is listed as a known gap but now parses clean — remove it from KOTLIN_SYNTAX_KNOWN_GAPS`);
    if (!isGap && health) throw new Error(`"${file}" has a syntax error at line(s) ${health.errorLines.join(', ')} and is not a known gap`);
  });

  it.each(KOTLIN_SYNTAX_NORMALIZED.map(f => [f] as const))('%s needs the normalization (the entry is not stale)', async (file) => {
    const source = read(file);
    expect(normalizeKotlinForParse(source)).not.toBe(source);
    expect(normalizeKotlinForParse(source).length).toBe(source.length);
  });

  it('extracts a functional interface member under its interface', async () => {
    const { result } = await analyze('fun-interface.kt', read('fun-interface'));
    expect([...result.nodes.values()].find(n => n.name === 'apply')?.className).toBe('Transformer');
  });
});

describe('Kotlin known gaps degrade safely', () => {
  it.each(Object.keys(KOTLIN_SYNTAX_KNOWN_GAPS).map(f => [f] as const))('%s: declarations outside the error region keep their owner', async (file) => {
    const gap = read(file).trimEnd().split('\n').map(line => `    ${line}`).join('\n');
    const source = `class Host {\n    fun before(): Int = 1\n}\n\nobject GapHolder {\n${gap}\n}\n\nclass Tail {\n    fun after(): Int = 2\n}\n`;
    const { result, health } = await analyze('Host.kt', source);
    const owner = (name: string) => [...result.nodes.values()].find(n => n.name === name)?.className;
    expect(owner('before')).toBe('Host');
    expect(owner('after')).toBe('Tail');
    expect(health?.errorLines.length ?? 0).toBeGreaterThan(0);
    expect(Math.min(...health!.errorLines)).toBeGreaterThan(4);
  });
});

describe('normalizeKotlinForParse', () => {
  it('returns the same string when there is nothing to rewrite', () => {
    const source = 'fun f() = 1\n';
    expect(normalizeKotlinForParse(source)).toBe(source);
  });

  it('never rewrites a comment or a string', () => {
    const source = 'val a = "fun interface X and 0..<n"\n// fun interface Y 1..<2\n/* fun interface Z /* nested 0..<1 */ */\nval b = """fun interface R ..< """\n';
    expect(normalizeKotlinForParse(source)).toBe(source);
  });

  it('rewrites code inside a template expression, and only there', () => {
    const source = 'val s = "${(0..<3).count()} ..< "\n';
    expect(normalizeKotlinForParse(source)).toBe('val s = "${(0.. 3).count()} ..< "\n');
  });

  it('keeps every offset', () => {
    const source = 'fun  interface A { fun go() }\nfun r(n: Int) = (0..<n).sum()\n';
    const out = normalizeKotlinForParse(source);
    expect(out).toBe('     interface A { fun go() }\nfun r(n: Int) = (0.. n).sum()\n');
    expect(out.length).toBe(source.length);
  });

  it('masks code-shaped text in every literal kind without moving a newline', () => {
    const source = "val c = '\"'; val d = \"a\\\"b\" // tail \"\nval `fun interface` = 1\n";
    const mask = kotlinCodeMask(source);
    expect(mask.length).toBe(source.length);
    expect([...mask].filter(ch => ch === '\n').length).toBe(2);
    expect(mask).toContain('val `fun interface` = 1');
    expect(mask).not.toContain('tail');
  });
});

describe('Kotlin syntax documentation', () => {
  // Regenerate with: npx tsx scripts/render-kotlin-support.ts
  it('the syntax coverage table of docs/language-support.md equals the corpus', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../../docs/language-support.md', import.meta.url)), 'utf-8');
    const start = doc.indexOf(KOTLIN_SYNTAX_DOC_MARKERS.start);
    const end = doc.indexOf(KOTLIN_SYNTAX_DOC_MARKERS.end);
    expect(start).toBeGreaterThan(-1);
    expect(doc.slice(start, end + KOTLIN_SYNTAX_DOC_MARKERS.end.length)).toBe(renderKotlinSyntaxSection());
  });
});
