import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITIES,
  ALL_LANGUAGES,
  CODE_LANGUAGES,
  LANGUAGE_SUPPORT,
  languageSupport,
  languageCoverageMatrix,
  renderCoverageMatrixMarkdown,
  resolveLanguageName,
  type Capability,
} from './language-support.js';
import { cfgSupportsLanguage, CFG_LANGUAGES } from './cfg.js';
import { isIacLanguage, IAC_LANGUAGES } from './iac/types.js';
import { CALLGRAPH_LANGUAGES, CallGraphBuilder, serializeCallGraph, extractFileStyle } from './call-graph.js';
import { TYPE_INFERENCE_LANGUAGES as TI, inferTypesFromSource } from './type-inference-engine.js';
import { SIGNATURE_LANGUAGES as SIG, extractSignatures, detectLanguage } from './signature-extractor.js';
import { IMPORT_RESOLUTION_LANGUAGES as IMP, buildBaseImportMap } from './import-resolver-bridge.js';
import { STYLE_FINGERPRINT_LANGUAGES as STY } from './style-fingerprint.js';

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

  it('styleFingerprint cell === STYLE_FINGERPRINT_LANGUAGES membership for EVERY language (exact, drift-proof)', () => {
    for (const lang of ALL_LANGUAGES) {
      const claims = languageSupport(lang).capabilities.includes('styleFingerprint');
      expect(claims, `styleFingerprint mismatch for ${lang}`).toBe(STY.has(lang));
    }
  });
});

// styleFingerprint is behaviorally exercised against the live tally (no silent over-claim): every
// STYLE_FINGERPRINT_LANGUAGES member must actually produce idiom counters on a real fixture.
const STYLE_FIXTURES: Record<string, string> = {
  TypeScript: 'a.ts||const f = () => { const x = c ? 1 : 2; return `v${x}`; };',
  JavaScript: 'a.js||const f = () => { const x = c ? 1 : 2; return `v${x}`; };',
  Python: 'a.py||def my_fn():\n    return 1 if c else 2',
  Go: 'a.go||package m\nfunc Foo() { x := 1; var y int = 2 }',
};
describe('styleFingerprint is behaviorally faithful (no silent over-claim)', () => {
  for (const lang of STY) {
    it(`${lang}: the live tally produces counters`, async () => {
      const fx = STYLE_FIXTURES[lang];
      expect(fx, `add a STYLE_FIXTURES entry for ${lang}`).toBeTruthy();
      const [path, content] = fx.split('||');
      const style = await extractFileStyle({ path, content, language: lang });
      expect(style, `${lang} should tally a fingerprint`).toBeTruthy();
      expect(Object.keys(style!.counters).length, `${lang} produced no counters`).toBeGreaterThan(0);
    });
  }
});

// ── EVERY set member is behaviorally exercised against the live extractor (no over-claim) ──
// The feature's core promise is "the matrix cannot silently over-claim". A membership-only
// check is a tautology (the registry is derived from the set); these tests cross-check each
// set member against the REAL extractor producing output — and fail if a member has no
// fixture, so the guard can't rot when a language is added to a set.

// A minimal source per language that exercises each capability. One per SET member.
const TYPE_INFERENCE_FIXTURES: Record<string, string> = {
  Python: 'x = Foo()', 'C++': 'Foo x;', TypeScript: 'const x = new Foo();',
  JavaScript: 'const x = new Foo();', Go: 'x := Foo{}', Rust: 'let x = Foo::new();',
  Java: 'Foo x = new Foo();', 'C#': 'var x = new Foo();', Ruby: 'x = Foo.new',
};
const SIGNATURE_FIXTURES: Record<string, string> = {
  Python: 'x.py||def foo(a):\n    return a',
  TypeScript: 'x.ts||export function foo(a: number): number { return a; }',
  JavaScript: 'x.js||export function foo(a) { return a; }',
  Go: 'x.go||func Foo(a int) int { return a }',
  Rust: 'x.rs||pub fn foo(a: i32) -> i32 { a }',
  Ruby: 'x.rb||def foo(a)\n  a\nend',
  'C++': 'x.cpp||int foo(int a) { return a; }',
  Swift: 'x.swift||func foo(a: Int) -> Int { return a }',
  Java: 'A.java||class A { int foo(int a) { return a; } }',
  Terraform: 'x.tf||resource "aws_s3_bucket" "b" {}',
  Bicep: "x.bicep||resource b 'Microsoft.Storage/storageAccounts@2021-09-01' = { name: 'n' }",
  'C#': 'A.cs||class A { int Foo(int a) { return a; } }',
  Kotlin: 'x.kt||fun foo(a: Int): Int { return a }',
  PHP: 'x.php||<?php\nfunction foo($a) { return $a; }',
  C: 'x.c||int foo(int a) { return a; }',
  Scala: 'x.scala||object M { def foo(a: Int): Int = a }',
  Dart: 'x.dart||int foo(int a) { return a; }',
  Lua: 'x.lua||function foo(a) return a end',
  Elixir: 'x.ex||defmodule M do\n  def foo(a), do: a\nend',
  Bash: 'x.sh||foo() { echo "$1"; }',
};
const CALLGRAPH_FIXTURES: Record<string, [string, string]> = {
  TypeScript: ['a.ts', 'function foo() { bar(); }\nfunction bar() {}'],
  JavaScript: ['a.js', 'function foo() { bar(); }\nfunction bar() {}'],
  Python: ['a.py', 'def foo():\n    bar()\ndef bar():\n    pass'],
  Go: ['a.go', 'package m\nfunc Foo() { Bar() }\nfunc Bar() {}'],
  Rust: ['a.rs', 'fn foo() { bar(); }\nfn bar() {}'],
  Ruby: ['a.rb', 'def foo\n  bar\nend\ndef bar\nend'],
  Java: ['A.java', 'class A { void foo() { bar(); } void bar() {} }'],
  'C++': ['a.cpp', 'void bar() {}\nvoid foo() { bar(); }'],
  Swift: ['a.swift', 'func bar() {}\nfunc foo() { bar() }'],
  Elixir: ['a.ex', 'defmodule M do\n  def foo, do: bar()\n  def bar, do: :ok\nend'],
  Dart: ['a.dart', 'void bar() {}\nvoid foo() { bar(); }'],
  'C#': ['A.cs', 'class A { void Foo() { Bar(); } void Bar() {} }'],
  Kotlin: ['a.kt', 'fun bar() {}\nfun foo() { bar() }'],
  PHP: ['a.php', '<?php function bar() {}\nfunction foo() { bar(); }'],
  C: ['a.c', 'int bar() { return 0; }\nint foo() { return bar(); }'],
  Scala: ['a.scala', 'object M { def bar() = {}\n def foo() = { bar() } }'],
  Lua: ['a.lua', 'function bar() end\nfunction foo() bar() end'],
  Bash: ['a.sh', 'bar() { echo 1; }\nfoo() { bar; }'],
};

describe('every capability-set member is exercised against the real extractor (no over-claim)', () => {
  it('typeInference: every member infers ≥1 type; a non-member yields none', () => {
    for (const lang of TI) {
      const fx = TYPE_INFERENCE_FIXTURES[lang];
      expect(fx, `missing typeInference fixture for set member ${lang}`).toBeDefined();
      expect(inferTypesFromSource(fx, lang).size, `${lang} infers a type`).toBeGreaterThan(0);
    }
    expect(TI.has('Kotlin')).toBe(false);
    expect(inferTypesFromSource('val x = Foo()', 'Kotlin').size).toBe(0);
  });

  it('signatures: every member produces ≥1 dedicated entry', () => {
    for (const lang of SIG) {
      const fx = SIGNATURE_FIXTURES[lang];
      expect(fx, `missing signature fixture for set member ${lang}`).toBeDefined();
      const [path, content] = fx.split('||');
      expect(detectLanguage(path)).toBe(lang);
      expect(extractSignatures(path, content).entries.length, `${lang} signatures`).toBeGreaterThan(0);
    }
  });

  it('imports: every member resolves a relative import; a non-member yields nothing', () => {
    for (const lang of IMP) {
      const ext = lang === 'Python' ? 'py' : lang === 'JavaScript' ? 'js' : 'ts';
      const content = lang === 'Python' ? 'from .b import x' : "import { x } from './b';";
      expect(buildBaseImportMap([{ path: `a.${ext}`, content, language: lang }]).size, `${lang} import`).toBe(1);
    }
    // Go/Rust/Ruby/Java parsers exist but are unwired in the live path → honestly unclaimed.
    for (const non of ['Go', 'Rust', 'Ruby', 'Java']) expect(IMP.has(non)).toBe(false);
    expect(buildBaseImportMap([{ path: 'a.go', content: 'import "fmt"', language: 'Go' }]).size).toBe(0);
  });

  it('callGraph: every member extracts ≥1 node on a fixture', async () => {
    // One build() over all fixtures amortizes per-grammar setup (18 separate builds blow
    // the default timeout). Then assert each set member produced ≥1 node — catching any
    // over-claim where the set lists a language the dispatch does not actually handle.
    // Unique path per language so we can attribute nodes by FILE (the JS/TS extractor is
    // shared, so a node's `language` tag is ambiguous, but its `filePath` is not).
    const files = [...CALLGRAPH_LANGUAGES].map(lang => {
      const fx = CALLGRAPH_FIXTURES[lang];
      expect(fx, `missing callGraph fixture for set member ${lang}`).toBeDefined();
      return { lang, path: `${lang.replace(/[^a-z0-9]/gi, '_')}/${fx[0]}`, content: fx[1], language: lang };
    });
    const snap = serializeCallGraph(await new CallGraphBuilder().build(files.map(f => ({ path: f.path, content: f.content, language: f.language }))));
    const internal = snap.nodes.filter(n => !n.isExternal);
    for (const f of files) {
      const got = internal.some(n => n.filePath === f.path);
      expect(got, `${f.lang} claims callGraph but extracted no node from its fixture`).toBe(true);
    }
  }, 60_000);

  // cfgOverlay's authoritative source is `cfgSupportsLanguage` (== keys of SPEC_BY_LANGUAGE).
  // The registry cross-checks the cell against that predicate exactly, but the predicate is
  // only honest if the pipeline ACTUALLY builds a CFG for each such language. This asserts it:
  // `CallGraphBuilder.build()` invokes `buildCfgFor` per language, and `result.cfgs` must carry
  // a CFG for every CFG_LANGUAGES member (a branch fixture) — so a SPEC entry that silently
  // produced no overlay would fail here, not just pass the predicate tautology.
  it('cfgOverlay: every CFG_LANGUAGES member actually yields a CFG from the pipeline', async () => {
    const branchFixtures: Record<string, [string, string]> = {
      TypeScript: ['cfg_TypeScript.ts', 'function f(x){ if(x>0){return x;} return -x; }'],
      JavaScript: ['cfg_JavaScript.js', 'function f(x){ if(x>0){return x;} return -x; }'],
      Python: ['cfg_Python.py', 'def f(x):\n    if x>0:\n        return x\n    return -x'],
      Go: ['cfg_Go.go', 'package m\nfunc F(x int) int { if x>0 { return x }\n return -x }'],
      Java: ['Cfg_Java.java', 'class A { int f(int x){ if(x>0){return x;} return -x; } }'],
      'C++': ['cfg_Cpp.cpp', 'int f(int x){ if(x>0){return x;} return -x; }'],
      C: ['cfg_C.c', 'int f(int x){ if(x>0){return x;} return -x; }'],
      'C#': ['Cfg_Cs.cs', 'class A { int F(int x){ if(x>0){return x;} return -x; } }'],
      PHP: ['cfg_Php.php', '<?php\nfunction f($x){ if($x>0){return $x;} return -$x; }'],
      Rust: ['cfg_Rust.rs', 'fn f(x: i32) -> i32 { if x>0 { x } else { -x } }'],
      Ruby: ['cfg_Ruby.rb', 'def f(x)\n  if x>0\n    x\n  else\n    -x\n  end\nend'],
    };
    const files = [...CFG_LANGUAGES].map(lang => {
      const fx = branchFixtures[lang];
      expect(fx, `missing CFG fixture for set member ${lang}`).toBeDefined();
      return { path: fx[0], content: fx[1], language: lang };
    });
    const result = await new CallGraphBuilder().build(files);
    const cfgPaths = new Set([...(result.cfgs ?? new Map()).keys()].map(k => k.split('::')[0]));
    for (const lang of CFG_LANGUAGES) {
      expect(cfgPaths.has(branchFixtures[lang][0]), `${lang} claims cfgOverlay but the pipeline built no CFG`).toBe(true);
    }
  }, 60_000);
});

// ── completeness, fail-soft, determinism ──

describe('completeness + fail-soft + determinism', () => {
  it('every language any capability source references is a registry key', () => {
    const keys = new Set(ALL_LANGUAGES);
    // Includes IAC_LANGUAGES so every IaC ecosystem (incl. Pulumi/CDK/CDKTF, which a node
    // CAN be tagged with) must have a row — a regression guard for the dogfood-found gap.
    const referenced = new Set<string>([
      ...CALLGRAPH_LANGUAGES, ...SIG, ...TI, ...IMP, ...IAC_LANGUAGES, ...CFG_LANGUAGES,
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

  // The check above is derivation-exact but TAUTOLOGICAL (iacProjection is derived from the same
  // `isIacLanguage`/`IAC_LANGUAGES` it asserts) — it would still pass if a bogus tag with no parser
  // were added to IAC_LANGUAGES. The other six capabilities are exercised against the live extractor;
  // this closes the last gap behaviorally: run the REAL analyze pipeline over a fixture per ecosystem
  // and require every IAC_LANGUAGES member to be emitted as a non-external node language. A new tag
  // that no parser actually backs can therefore no longer silently claim iacProjection.
  describe('iacProjection is behaviorally faithful (no silent over-claim)', () => {
    const iacBase = join(__dirname, 'iac', 'fixtures');
    const fx = (rel: string, language: string) => ({ path: rel, content: readFileSync(join(iacBase, rel), 'utf-8'), language });

    // Inline fixtures (mirroring iac/integration.test.ts) for the ecosystems with no single file.
    const dockerfile = ['FROM python:3.12-slim AS builder', 'RUN pip install -r requirements.txt'].join('\n');
    const compose = ['services:', '  api:', '    build: ./api', '    depends_on:', '      - db', '  db:', '    image: postgres:16'].join('\n');
    const workflow = ['name: CI', 'on: [push]', 'jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4'].join('\n');

    // language → the fixture file(s) whose REAL parser must emit that tag. A new IAC_LANGUAGES member
    // with no entry here fails the completeness assertion below, so this guard cannot rot.
    const contributors: Record<string, Array<{ path: string; content: string; language: string }>> = {
      Terraform: [fx('terraform/main.tf', 'Terraform')],
      Kubernetes: [fx('kubernetes/app.yaml', 'Kubernetes')],
      Helm: [fx('helm/mychart/Chart.yaml', 'Helm'), fx('helm/mychart/values.yaml', 'Helm'), fx('helm/mychart/templates/deployment.yaml', 'Helm')],
      CloudFormation: [fx('cloudformation/template.yaml', 'CloudFormation')],
      Ansible: [fx('ansible/site.yml', 'Ansible'), fx('ansible/roles/web/tasks/main.yml', 'Ansible')],
      Pulumi: [fx('pulumi/index.ts', 'TypeScript')],
      CDK: [fx('cdk/aws-cdk-app.ts', 'TypeScript')],
      CDKTF: [fx('cdk/cdktf-main.ts', 'TypeScript')],
      Dockerfile: [{ path: 'api/Dockerfile', content: dockerfile, language: 'Dockerfile' }],
      'Docker Compose': [{ path: 'docker-compose.yml', content: compose, language: 'Docker Compose' }],
      'GitHub Actions': [{ path: '.github/workflows/ci.yml', content: workflow, language: 'GitHub Actions' }],
      Bicep: [fx('bicep/main.bicep', 'Bicep')],
    };

    it('every IAC_LANGUAGES member has a fixture contributor wired (guard cannot rot)', () => {
      for (const lang of IAC_LANGUAGES) {
        expect(contributors[lang], `no fixture wired for IAC_LANGUAGES member ${lang}`).toBeDefined();
      }
    });

    it('the real analyze pipeline emits a non-external node for every IAC_LANGUAGES tag', async () => {
      const files = Object.values(contributors).flat();
      const graph = serializeCallGraph(await new CallGraphBuilder().build(files));
      const emitted = new Set(graph.nodes.filter(n => !n.isExternal && n.language).map(n => n.language));
      for (const lang of IAC_LANGUAGES) {
        expect(emitted.has(lang), `${lang} claims iacProjection but no parser emitted a node for it`).toBe(true);
      }
    }, 60_000);
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

  it('matrix: undefined means ALL, but [] means NONE (the docs-only-repo regression)', () => {
    expect(languageCoverageMatrix().rows.length).toBe(ALL_LANGUAGES.length); // undefined → all
    expect(languageCoverageMatrix([]).rows).toEqual([]);                      // [] → none, not all
  });

  it('resolveLanguageName is case-insensitive + trimming; unknown → null', () => {
    expect(resolveLanguageName('go')).toBe('Go');
    expect(resolveLanguageName('  TYPESCRIPT ')).toBe('TypeScript');
    expect(resolveLanguageName('c++')).toBe('C++');
    expect(resolveLanguageName('docker compose')).toBe('Docker Compose');
    expect(resolveLanguageName('cobol')).toBeNull();
    expect(resolveLanguageName('')).toBeNull();
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
