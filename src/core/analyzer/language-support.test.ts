import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  ALL_LANGUAGES,
  CODE_LANGUAGES,
  LANGUAGE_SUPPORT,
  languageSupport,
  languageCoverageMatrix,
  renderCoverageMatrixMarkdown,
  type Capability,
} from './language-support.js';
import { cfgSupportsLanguage } from './cfg.js';
import { isIacLanguage, IAC_LANGUAGES } from './iac/types.js';
import { CALLGRAPH_LANGUAGES, CallGraphBuilder, serializeCallGraph } from './call-graph.js';
import { TYPE_INFERENCE_LANGUAGES as TI, inferTypesFromSource } from './type-inference-engine.js';
import { SIGNATURE_LANGUAGES as SIG, extractSignatures, detectLanguage } from './signature-extractor.js';
import { IMPORT_RESOLUTION_LANGUAGES as IMP, buildBaseImportMap } from './import-resolver-bridge.js';

// ── registry is DERIVED from the live sources: exact cross-checks ──

describe('language-support registry — faithful to live extractor sources', () => {
  it('cfgOverlay cell === cfgSupportsLanguage(lang) for EVERY language (exact, drift-proof)', () => {
    for (const lang of ALL_LANGUAGES) {
      const claims = languageSupport(lang).capabilities.includes('cfgOverlay');
      expect(claims, `cfgOverlay mismatch for ${lang}`).toBe(cfgSupportsLanguage(lang));
    }
  });

  it('iacProjection cell === isIacLanguage(lang) for EVERY language (exact, drift-proof)', () => {
    for (const lang of ALL_LANGUAGES) {
      const claims = languageSupport(lang).capabilities.includes('iacProjection');
      expect(claims, `iacProjection mismatch for ${lang}`).toBe(isIacLanguage(lang));
    }
  });

  it('callGraph / signatures / typeInference / imports cells === their authoritative set membership', () => {
    for (const lang of ALL_LANGUAGES) {
      const caps = languageSupport(lang).capabilities;
      expect(caps.includes('callGraph'), `callGraph ${lang}`).toBe(CALLGRAPH_LANGUAGES.has(lang));
      expect(caps.includes('signatures'), `signatures ${lang}`).toBe(SIG.has(lang));
      expect(caps.includes('typeInference'), `typeInference ${lang}`).toBe(TI.has(lang));
      expect(caps.includes('imports'), `imports ${lang}`).toBe(IMP.has(lang));
    }
  });

  it('styleFingerprint is unsupported for every language (unbuilt)', () => {
    for (const lang of ALL_LANGUAGES) {
      expect(languageSupport(lang).capabilities).not.toContain('styleFingerprint');
    }
  });
});

// ── the authoritative SETS match the live extractors' actual behavior on fixtures ──

describe('exported capability sets match real extractor behavior (no over-claim)', () => {
  it('typeInference set matches inferTypesFromSource behavior (member → non-empty, non-member → empty)', () => {
    const fixtures: Record<string, string> = {
      Python: 'x = Foo()',
      TypeScript: 'const x = new Foo();',
      Go: 'x := Foo{}',
      Java: 'Foo x = new Foo();',
      Ruby: 'x = Foo.new',
      'C#': 'var x = new Foo();',
    };
    for (const [lang, src] of Object.entries(fixtures)) {
      expect(TI.has(lang), `${lang} should be a typeInference language`).toBe(true);
      expect(inferTypesFromSource(src, lang).size, `${lang} infers a type`).toBeGreaterThan(0);
    }
    // A non-member yields an empty map (fail-soft), proving the set isn't over-claimed.
    expect(TI.has('Kotlin')).toBe(false);
    expect(inferTypesFromSource('val x = Foo()', 'Kotlin').size).toBe(0);
  });

  it('signatures set members produce ≥1 dedicated signature entry', () => {
    const fixtures: Array<[string, string]> = [
      ['x.ts', 'export function foo(a: number): number { return a; }'],
      ['x.py', 'def foo(a):\n    return a'],
      ['x.go', 'func Foo(a int) int { return a }'],
      ['x.rb', 'def foo(a)\n  a\nend'],
    ];
    for (const [path, content] of fixtures) {
      expect(SIG.has(detectLanguage(path))).toBe(true);
      expect(extractSignatures(path, content).entries.length, `${path} signatures`).toBeGreaterThan(0);
    }
  });

  it('imports set resolves relative imports for members; a non-member yields nothing', () => {
    const ts = buildBaseImportMap([{ path: 'a.ts', content: "import { x } from './b';", language: 'TypeScript' }]);
    expect(ts.size).toBe(1);
    const py = buildBaseImportMap([{ path: 'a.py', content: 'from .b import x', language: 'Python' }]);
    expect(py.size).toBe(1);
    // Go is NOT in the live import path (parsers exist but are unwired) — honestly unclaimed.
    expect(IMP.has('Go')).toBe(false);
    expect(buildBaseImportMap([{ path: 'a.go', content: 'import "fmt"', language: 'Go' }]).size).toBe(0);
  });

  it('callGraph set members extract ≥1 node on a fixture (reliable native grammars)', async () => {
    const fixtures: Array<[string, string, string]> = [
      ['TypeScript', 'a.ts', 'function foo() { bar(); }\nfunction bar() {}'],
      ['Python', 'a.py', 'def foo():\n    bar()\ndef bar():\n    pass'],
      ['Go', 'a.go', 'package m\nfunc Foo() { Bar() }\nfunc Bar() {}'],
      ['Java', 'A.java', 'class A { void foo() { bar(); } void bar() {} }'],
    ];
    for (const [language, path, content] of fixtures) {
      expect(CALLGRAPH_LANGUAGES.has(language)).toBe(true);
      const snap = serializeCallGraph(await new CallGraphBuilder().build([{ path, content, language }]));
      expect(snap.nodes.filter(n => !n.isExternal).length, `${language} nodes`).toBeGreaterThan(0);
    }
  });
});

// ── completeness, fail-soft, determinism ──

describe('completeness + fail-soft + determinism', () => {
  it('every language any capability source references is a registry key', () => {
    const keys = new Set(ALL_LANGUAGES);
    // Includes IAC_LANGUAGES so every IaC ecosystem (incl. Pulumi/CDK/CDKTF, which a node
    // CAN be tagged with) must have a row — a regression guard for the dogfood-found gap.
    const referenced = new Set<string>([
      ...CALLGRAPH_LANGUAGES, ...SIG, ...TI, ...IMP, ...IAC_LANGUAGES,
    ]);
    for (const lang of referenced) {
      expect(keys.has(lang), `${lang} (referenced by a capability source) is missing from the registry`).toBe(true);
    }
  });

  it('every IaC ecosystem tag backs iacProjection (and nothing it does not)', () => {
    for (const lang of IAC_LANGUAGES) {
      expect(languageSupport(lang).capabilities, `${lang} should back iacProjection`).toContain('iacProjection');
    }
  });

  it('every code language has at least one detectLanguage extension mapping to it', () => {
    const ext: Record<string, string> = {
      TypeScript: 'x.ts', JavaScript: 'x.js', Python: 'x.py', Go: 'x.go', Rust: 'x.rs',
      Ruby: 'x.rb', Java: 'x.java', Kotlin: 'x.kt', PHP: 'x.php', 'C#': 'x.cs',
      'C++': 'x.cpp', C: 'x.c', Swift: 'x.swift', Scala: 'x.scala', Dart: 'x.dart',
      Lua: 'x.lua', Elixir: 'x.ex', Bash: 'x.sh', Terraform: 'x.tf', Bicep: 'x.bicep',
    };
    for (const lang of CODE_LANGUAGES) {
      const path = ext[lang];
      expect(path, `no test extension for ${lang}`).toBeDefined();
      // .h resolves to C++ by default; everything else is exact.
      expect(detectLanguage(path), `${path} → ${lang}`).toBe(lang);
    }
  });

  it('fail-soft: an unknown language yields nothing, never an error', () => {
    const rec = languageSupport('Haskell');
    expect(rec.known).toBe(false);
    expect(rec.capabilities).toEqual([]);
    const m = languageCoverageMatrix(['Haskell']);
    expect(m.rows[0].known).toBe(false);
    expect(m.rows[0].supportedCount).toBe(0);
    for (const c of CAPABILITIES) expect(m.rows[0].supported[c]).toBe(false);
  });

  it('coverage matrix is deterministic (two derivations byte-identical)', () => {
    expect(JSON.stringify(languageCoverageMatrix())).toBe(JSON.stringify(languageCoverageMatrix()));
    const sub = ['Go', 'TypeScript', 'Kotlin'];
    expect(JSON.stringify(languageCoverageMatrix(sub))).toBe(JSON.stringify(languageCoverageMatrix(sub)));
    // sorted regardless of input order
    expect(languageCoverageMatrix(['Rust', 'Go', 'C']).rows.map(r => r.language)).toEqual(['C', 'Go', 'Rust']);
  });

  it('markdown render is a complete table (header + separator + one row per language)', () => {
    const m = languageCoverageMatrix(['Go', 'TypeScript']);
    const md = renderCoverageMatrixMarkdown(m);
    expect(md[0]).toContain('| Language |');
    expect(md.length).toBe(2 + m.rows.length);
    expect(md.some(l => l.startsWith('| Go |'))).toBe(true);
  });

  it('registry covers every known language and a fully-supported language is represented', () => {
    expect(LANGUAGE_SUPPORT.size).toBe(ALL_LANGUAGES.length);
    // TypeScript backs the most capabilities — sanity that derivation produced real data.
    const ts = languageSupport('TypeScript').capabilities;
    for (const c of ['signatures', 'callGraph', 'imports', 'cfgOverlay', 'typeInference'] as Capability[]) {
      expect(ts, `TypeScript should support ${c}`).toContain(c);
    }
  });
});
