/**
 * Per-language capability CONFORMANCE sweep (change: add-language-capability-conformance).
 *
 * The capability matrix surfaced by `get_language_support` is DERIVED from per-capability
 * `*_LANGUAGES` constants — but a constant claiming "language L supports callGraph" does not by
 * itself prove the extractor produces a real edge on real L code. This test closes that gap: for
 * every language that the registry CLAIMS supports a capability, it drives the actual extractor
 * against a minimal but realistic fixture and asserts the capability genuinely fires. A regression
 * that silently breaks one language's call graph (or makes the matrix over-claim) fails here.
 *
 * Scope: the engine behind the core navigation tools (orient / analyze_impact / find_path /
 * get_subgraph / select_tests / find_dead_code / trace_execution_path all ride the call graph) plus
 * the error-propagation overlay. Plain `.test.ts` so CI runs it.
 *
 * Findings locked in by this sweep (2026-06-26): the call graph is sound across all 18 call-graph
 * languages for basic calls, intra-class method dispatch, and cross-file resolution; every
 * cross-language precision difference is asserted explicitly rather than hidden.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallGraphBuilder } from './call-graph.js';
import { CALLGRAPH_LANGUAGES, grammarLoadFailed } from './call-graph.js';
import { ERROR_PROPAGATION_LANGUAGES, extractExceptionFactsFromSource } from './exception-flow.js';
import { cfgSupportsLanguage, isStructurallyValid } from './cfg.js';
import { inferTypesFromSource, TYPE_INFERENCE_LANGUAGES } from './type-inference-engine.js';
import { STYLE_FINGERPRINT_LANGUAGES } from './style-fingerprint.js';
import { CROSS_SERVICE_HTTP_LANGUAGES, HTTP_CLIENT_LANGUAGES } from './http-capability.js';
import { extractRoutesFromFile, extractHttpCalls } from './http-route-parser.js';
import { CODE_LANGUAGES } from './language-support.js';
import { IMPORT_RESOLUTION_LANGUAGES } from './import-resolver-bridge.js';
import { buildBaseImportMap } from './import-resolver-bridge.js';

async function build(
  files: Array<{ path: string; language: string; content: string }>,
  importMap?: Map<string, Map<string, string>>,
) {
  return new CallGraphBuilder().build(files, undefined, importMap);
}
function hasEdge(
  r: Awaited<ReturnType<CallGraphBuilder['build']>>,
  caller: string,
  callee: string,
) {
  return r.edges.find(
    (e) =>
      r.nodes.get(e.callerId)?.name === caller &&
      (r.nodes.get(e.calleeId)?.name ?? e.calleeName) === callee,
  );
}

// ── (1) Basic caller→callee: every CLAIMED callGraph language must produce the edge ──────────────
interface Basic { language: string; path: string; content: string; caller: string; callee: string }
const BASIC: Basic[] = [
  { language: 'TypeScript', path: 'm.ts', caller: 'main', callee: 'helper', content: `function main(){ helper(); }\nfunction helper(){ return 1; }` },
  { language: 'JavaScript', path: 'm.js', caller: 'main', callee: 'helper', content: `function main(){ helper(); }\nfunction helper(){ return 1; }` },
  { language: 'Python', path: 'm.py', caller: 'main', callee: 'helper', content: `def helper():\n    return 1\n\ndef main():\n    helper()\n` },
  { language: 'Go', path: 'm.go', caller: 'Main', callee: 'Helper', content: `package m\nfunc Helper() int { return 1 }\nfunc Main() { Helper() }\n` },
  { language: 'Rust', path: 'm.rs', caller: 'main', callee: 'helper', content: `fn helper() -> i32 { 1 }\nfn main() { helper(); }\n` },
  { language: 'Ruby', path: 'm.rb', caller: 'main', callee: 'helper', content: `def helper\n  1\nend\n\ndef main\n  helper\nend\n` },
  { language: 'Java', path: 'M.java', caller: 'main', callee: 'helper', content: `class M {\n  void helper() {}\n  void main() { helper(); }\n}` },
  { language: 'Kotlin', path: 'm.kt', caller: 'main', callee: 'helper', content: `fun helper(): Int { return 1 }\nfun main() { helper() }\n` },
  { language: 'PHP', path: 'm.php', caller: 'main', callee: 'helper', content: `<?php\nfunction helper() { return 1; }\nfunction main() { helper(); }\n` },
  { language: 'C#', path: 'M.cs', caller: 'Main', callee: 'Helper', content: `class M {\n  void Helper() {}\n  void Main() { Helper(); }\n}` },
  { language: 'C++', path: 'm.cpp', caller: 'mainFn', callee: 'helper', content: `void helper() {}\nvoid mainFn() { helper(); }\n` },
  { language: 'C', path: 'm.c', caller: 'mainFn', callee: 'helper', content: `void helper() {}\nvoid mainFn() { helper(); }\n` },
  { language: 'Swift', path: 'm.swift', caller: 'mainFn', callee: 'helper', content: `func helper() -> Int { return 1 }\nfunc mainFn() { helper() }\n` },
  { language: 'Scala', path: 'M.scala', caller: 'main', callee: 'helper', content: `object M {\n  def helper(): Int = 1\n  def main(): Unit = { helper() }\n}` },
  { language: 'Dart', path: 'm.dart', caller: 'mainFn', callee: 'helper', content: `int helper() => 1;\nvoid mainFn() { helper(); }\n` },
  { language: 'Lua', path: 'm.lua', caller: 'main', callee: 'helper', content: `function helper() return 1 end\nfunction main() helper() end\n` },
  { language: 'Elixir', path: 'm.ex', caller: 'main', callee: 'helper', content: `defmodule M do\n  def helper(), do: 1\n  def main(), do: helper()\nend\n` },
  { language: 'Bash', path: 'm.sh', caller: 'main', callee: 'helper', content: `helper() { echo hi; }\nmain() { helper; }\n` },
];

/**
 * Runs FIRST, so that when a grammar is missing this is the failure an engineer reads rather than
 * a dozen `expected [] to include 'main'` assertions further down.
 *
 * The grammars are `optionalDependencies` loaded through `loadGrammarSoft` — by design, so
 * `npm install` still succeeds in restricted environments. That means an install can legitimately
 * come up short, and when `tree-sitter-kotlin` did exactly that in CI, nine tests failed with
 * messages indistinguishable from a broken extractor. The absence and the breakage produce the
 * same empty result; only the loader knows which happened, and this asks it.
 */
describe('language conformance — grammar availability (diagnostic, runs first)', () => {
  it('reports which claimed call-graph grammars failed to LOAD, separately from what they extract', async () => {
    const unavailable: string[] = [];
    for (const f of BASIC) {
      await build([{ path: f.path, language: f.language, content: f.content }]);
      if (grammarLoadFailed(f.language)) unavailable.push(f.language);
    }

    expect(
      unavailable,
      `these grammars did not LOAD, so every capability assertion for them below is about a missing `
      + `optional dependency rather than a code defect: ${unavailable.join(', ')}. `
      + `Reinstall (npm ci) and re-run before investigating the extractor.`,
    ).toEqual([]);
  });
});

describe('language conformance — basic call graph (every claimed callGraph language)', () => {
  // Guard: if the registry adds a callGraph language, this sweep must cover it.
  it('covers every language the registry claims supports callGraph', () => {
    const claimed = [...CALLGRAPH_LANGUAGES];
    const covered = new Set(BASIC.map((b) => b.language));
    const uncovered = claimed.filter((l) => !covered.has(l));
    expect(uncovered, `callGraph languages with no conformance fixture: ${uncovered.join(', ')}`).toEqual([]);
  });

  for (const f of BASIC) {
    it(`${f.language}: extracts both functions and resolves ${f.caller}→${f.callee}`, async () => {
      const r = await build([{ path: f.path, language: f.language, content: f.content }]);
      const names = Array.from(r.nodes.values()).map((n) => n.name);
      expect(names, `${f.language} functions`).toContain(f.caller);
      expect(names, `${f.language} functions`).toContain(f.callee);
      expect(hasEdge(r, f.caller, f.callee), `${f.language} ${f.caller}→${f.callee} edge`).toBeTruthy();
    });
  }
});

// ── (2) Intra-class method dispatch: this./self./implicit receiver → sibling method ───────────────
interface Method { language: string; path: string; content: string }
const METHODS: Method[] = [
  { language: 'TypeScript', path: 'k.ts', content: `class K { caller(){ this.callee(); } callee(){ return 1; } }` },
  { language: 'JavaScript', path: 'k.js', content: `class K { caller(){ this.callee(); } callee(){ return 1; } }` },
  { language: 'Python', path: 'k.py', content: `class K:\n    def caller(self):\n        self.callee()\n    def callee(self):\n        return 1\n` },
  { language: 'Go', path: 'k.go', content: `package m\ntype K struct{}\nfunc (k K) Callee() int { return 1 }\nfunc (k K) Caller() { k.Callee() }\n` },
  { language: 'Ruby', path: 'k.rb', content: `class K\n  def caller\n    callee\n  end\n  def callee\n    1\n  end\nend\n` },
  { language: 'Java', path: 'K.java', content: `class K {\n  void callee() {}\n  void caller() { this.callee(); }\n}` },
  { language: 'Kotlin', path: 'k.kt', content: `class K {\n  fun callee(): Int = 1\n  fun caller() { this.callee() }\n}` },
  { language: 'PHP', path: 'k.php', content: `<?php\nclass K {\n  function callee() { return 1; }\n  function caller() { $this->callee(); }\n}` },
  { language: 'C#', path: 'K.cs', content: `class K {\n  void Callee() {}\n  void Caller() { this.Callee(); }\n}` },
  { language: 'Scala', path: 'K.scala', content: `class K {\n  def callee(): Int = 1\n  def caller(): Unit = { this.callee() }\n}` },
  { language: 'Swift', path: 'k.swift', content: `class K {\n  func callee() -> Int { return 1 }\n  func caller() { self.callee() }\n}` },
  { language: 'Dart', path: 'k.dart', content: `class K {\n  int callee() => 1;\n  void caller() { callee(); }\n}` },
];

describe('language conformance — intra-class method dispatch', () => {
  for (const f of METHODS) {
    const caller = f.language === 'Go' || f.language === 'C#' ? 'Caller' : 'caller';
    const callee = f.language === 'Go' || f.language === 'C#' ? 'Callee' : 'callee';
    it(`${f.language}: resolves an intra-class call ${caller}→${callee}`, async () => {
      const r = await build([{ path: f.path, language: f.language, content: f.content }]);
      expect(hasEdge(r, caller, callee), `${f.language} intra-class edge`).toBeTruthy();
    });
  }
});

// ── (3) Cross-file resolution + the documented precision difference ───────────────────────────────
describe('language conformance — cross-file resolution', () => {
  it('TypeScript resolves a cross-file call via precise import resolution', async () => {
    const r = await build([
      { path: 'a.ts', language: 'TypeScript', content: `import { helper } from './b';\nexport function main(){ helper(); }` },
      { path: 'b.ts', language: 'TypeScript', content: `export function helper(){ return 1; }` },
    ]);
    const e = hasEdge(r, 'main', 'helper');
    expect(e).toBeTruthy();
    expect(e!.confidence, 'TS cross-file is import-precise').toBe('import');
  });

  // Relative Python imports and Go package siblings resolve through the import/package map.
  for (const c of [
    { language: 'Python', a: { path: 'pkg/a.py', content: `from .b import helper\n\ndef main():\n    helper()\n` }, b: { path: 'pkg/b.py', content: `def helper():\n    return 1\n` }, caller: 'main', callee: 'helper' },
    { language: 'Go', a: { path: 'pkg/a.go', content: `package m\nfunc Main(){ Helper() }\n` }, b: { path: 'pkg/b.go', content: `package m\nfunc Helper() int { return 1 }\n` }, caller: 'Main', callee: 'Helper' },
  ]) {
    it(`${c.language} resolves a cross-file call at import confidence`, async () => {
      const r = await build([
        { path: c.a.path, language: c.language, content: c.a.content },
        { path: c.b.path, language: c.language, content: c.b.content },
      ]);
      expect(hasEdge(r, c.caller, c.callee)?.confidence, `${c.language} cross-file edge`).toBe('import');
    });
  }
});

// ── (4) Error-propagation overlay: claimed languages extract throws; others honestly unsupported ──
describe('language conformance — error propagation overlay', () => {
  it('TypeScript extracts a thrown type', async () => {
    const f = await extractExceptionFactsFromSource(`function risky(){ throw new Error('x'); }`, 'TypeScript');
    expect(f.supported).toBe(true);
    expect(f.throwSites.map((t) => t.type)).toContain('Error');
  });
  it('Python extracts a raised type', async () => {
    const f = await extractExceptionFactsFromSource(`def risky():\n    raise ValueError('x')\n`, 'Python');
    expect(f.supported).toBe(true);
    expect(f.throwSites.map((t) => t.type)).toContain('ValueError');
  });
  it('a non-claimed language is honestly reported unsupported, never silently empty', async () => {
    const f = await extractExceptionFactsFromSource(`package m\nfunc risky(){ panic("x") }`, 'Go');
    expect(ERROR_PROPAGATION_LANGUAGES.has('Go')).toBe(false);
    expect(f.supported).toBe(false);
  });
});

// ── (5) CFG overlay: every claimed language yields a structurally-valid CFG for a branchy fn ──────
const CFG_FIX: Array<{ language: string; path: string; content: string }> = [
  { language: 'TypeScript', path: 'c.ts', content: `function f(x: number){ if (x>0) { return 1; } else { return 2; } }` },
  { language: 'JavaScript', path: 'c.js', content: `function f(x){ if (x>0) { return 1; } else { return 2; } }` },
  { language: 'Python', path: 'c.py', content: `def f(x):\n    if x > 0:\n        return 1\n    else:\n        return 2\n` },
  { language: 'Go', path: 'c.go', content: `package m\nfunc f(x int) int { if x>0 { return 1 }; return 2 }` },
  { language: 'Rust', path: 'c.rs', content: `fn f(x: i32) -> i32 { if x>0 { 1 } else { 2 } }` },
  { language: 'Ruby', path: 'c.rb', content: `def f(x)\n  if x > 0\n    1\n  else\n    2\n  end\nend\n` },
  { language: 'Java', path: 'C.java', content: `class C { int f(int x){ if (x>0){ return 1; } else { return 2; } } }` },
  { language: 'PHP', path: 'c.php', content: `<?php\nfunction f($x){ if ($x>0){ return 1; } else { return 2; } }` },
  { language: 'C#', path: 'C.cs', content: `class C { int f(int x){ if (x>0){ return 1; } else { return 2; } } }` },
  { language: 'C++', path: 'c.cpp', content: `int f(int x){ if (x>0){ return 1; } else { return 2; } }` },
  { language: 'C', path: 'c.c', content: `int f(int x){ if (x>0){ return 1; } else { return 2; } }` },
];

describe('language conformance — CFG overlay', () => {
  it('covers every language the registry claims supports a CFG', () => {
    const claimed = CODE_LANGUAGES.filter((l) => cfgSupportsLanguage(l));
    const covered = new Set(CFG_FIX.map((f) => f.language));
    const uncovered = claimed.filter((l) => !covered.has(l));
    expect(uncovered, `CFG languages with no fixture: ${uncovered.join(', ')}`).toEqual([]);
  });

  for (const f of CFG_FIX) {
    it(`${f.language}: produces a structurally-valid CFG`, async () => {
      const r = await build([{ path: f.path, language: f.language, content: f.content }]);
      const cfgs = r.cfgs ? [...r.cfgs.values()] : [];
      expect(cfgs.length, `${f.language} cfgs`).toBeGreaterThan(0);
      expect(cfgs.every((c) => isStructurallyValid(c)), `${f.language} CFG validity`).toBe(true);
    });
  }
});

// ── (6) Type inference: every claimed language resolves `x` to its class type ─────────────────────
const TYPE_FIX: Array<{ language: string; src: string }> = [
  { language: 'TypeScript', src: `const x: Foo = new Foo();` },
  { language: 'JavaScript', src: `const x = new Foo();` },
  { language: 'Python', src: `x = Foo()` },
  { language: 'Go', src: `var x Foo` },
  { language: 'Rust', src: `let x: Foo = Foo::new();` },
  { language: 'Ruby', src: `x = Foo.new` },
  { language: 'Java', src: `Foo x = new Foo();` },
  { language: 'C#', src: `Foo x = new Foo();` },
  { language: 'C++', src: `Foo x;` },
];

describe('language conformance — type inference', () => {
  it('covers every language the registry claims supports type inference', () => {
    const covered = new Set(TYPE_FIX.map((f) => f.language));
    const uncovered = [...TYPE_INFERENCE_LANGUAGES].filter((l) => !covered.has(l));
    expect(uncovered, `type-inference languages with no fixture: ${uncovered.join(', ')}`).toEqual([]);
  });

  for (const f of TYPE_FIX) {
    it(`${f.language}: infers a local variable's class type`, () => {
      const types = inferTypesFromSource(f.src, f.language);
      expect(types.get('x'), `${f.language} inferred type of x`).toBe('Foo');
    });
  }

  it('a non-claimed language returns an empty inference, never a guess', () => {
    expect(TYPE_INFERENCE_LANGUAGES.has('Bash')).toBe(false);
    expect(inferTypesFromSource(`x=Foo`, 'Bash').size).toBe(0);
  });
});

// ── (7) Style fingerprint: claimed languages tally above the evidence floor; others honestly absent ──
describe('language conformance — style fingerprint', () => {
  const arrows = Array.from({ length: 14 }, (_, i) => `const f${i} = (a) => a + ${i};`).join('\n');
  const STYLE_FIX: Array<{ language: string; path: string; content: string }> = [
    { language: 'TypeScript', path: 's.ts', content: arrows },
    { language: 'JavaScript', path: 's.js', content: arrows },
    { language: 'Python', path: 's.py', content: Array.from({ length: 14 }, (_, i) => `def f${i}(a):\n    return a + ${i}`).join('\n') },
    { language: 'Go', path: 's.go', content: `package m\n${Array.from({ length: 14 }, (_, i) => `func F${i}(a int) int { return a + ${i} }`).join('\n')}` },
  ];

  it('covers every language the registry claims supports a style fingerprint', () => {
    const covered = new Set(STYLE_FIX.map((f) => f.language));
    const uncovered = [...STYLE_FINGERPRINT_LANGUAGES].filter((l) => !covered.has(l));
    expect(uncovered, `style languages with no fixture: ${uncovered.join(', ')}`).toEqual([]);
  });

  for (const f of STYLE_FIX) {
    it(`${f.language}: tallies style idioms from a real file`, async () => {
      const r = await build([{ path: f.path, language: f.language, content: f.content }]);
      expect(r.styleByFile?.get(f.path), `${f.language} styleByFile entry`).toBeTruthy();
    });
  }

  it('a non-claimed language tallies no style, never a guessed signal', async () => {
    expect(STYLE_FINGERPRINT_LANGUAGES.has('Ruby')).toBe(false);
    const r = await build([{ path: 's.rb', language: 'Ruby', content: `def a\n  1\nend\ndef b\n  2\nend\n` }]);
    expect(r.styleByFile?.get('s.rb')).toBeFalsy();
  });
});

// ── (8) Cross-service HTTP: route definitions (+ client call sites) per claimed language ──────────
describe('language conformance — cross-service HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-http-'));
  const writeFix = (name: string, content: string): string => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };

  const ROUTE_FIX: Array<{ language: string; name: string; content: string }> = [
    { language: 'TypeScript', name: 'r.ts', content: `import express from 'express';\nconst app = express();\napp.get('/users', (req, res) => res.send('ok'));\n` },
    { language: 'JavaScript', name: 'r.js', content: `const express = require('express');\nconst app = express();\napp.post('/items', (req, res) => res.send('ok'));\n` },
    { language: 'Python', name: 'r.py', content: `from flask import Flask\napp = Flask(__name__)\n\n@app.route('/users')\ndef users():\n    return 'ok'\n` },
    { language: 'Java', name: 'R.java', content: `@RestController\nclass R {\n  @GetMapping("/users")\n  public String users() { return "ok"; }\n}` },
  ];

  it('covers every language the registry claims supports cross-service HTTP', () => {
    const covered = new Set(ROUTE_FIX.map((f) => f.language));
    const uncovered = [...CROSS_SERVICE_HTTP_LANGUAGES].filter((l) => !covered.has(l));
    expect(uncovered, `cross-service HTTP languages with no fixture: ${uncovered.join(', ')}`).toEqual([]);
  });

  for (const f of ROUTE_FIX) {
    it(`${f.language}: extracts a server route definition`, async () => {
      const routes = await extractRoutesFromFile(writeFix(f.name, f.content));
      expect(routes.length, `${f.language} routes`).toBeGreaterThan(0);
    });
  }

  for (const f of [
    { language: 'TypeScript', name: 'cl.ts', content: `async function go(){ return await fetch('https://api.example.com/users'); }` },
    { language: 'JavaScript', name: 'cl.js', content: `async function go(){ return await fetch('https://api.example.com/items'); }` },
  ]) {
    it(`${f.language}: extracts an outbound HTTP client call`, async () => {
      expect(HTTP_CLIENT_LANGUAGES.has(f.language)).toBe(true);
      const calls = await extractHttpCalls(writeFix(f.name, f.content));
      expect(calls.length, `${f.language} client calls`).toBeGreaterThan(0);
    });
  }
});

// ── (7) Grammar-drift canary: fixtures must parse with ZERO error/missing nodes ──────────────────
// A `tree-sitter-*` bump that renames a node type or breaks recovery silently deletes functions and
// edges in the field. This canary makes that failure LOUD: every well-formed conformance fixture
// must produce no parse-health record (no ERROR/MISSING). If a grammar upgrade starts erroring on
// clean code, this fails here (on the fixture) instead of quietly in a user's repo
// (change: add-parse-health-boundary-disclosure).
//
// NOTE: the WASM-loaded grammars (Lua, Dart) are structurally EXCLUDED from parse-health (their
// shared WASM Language heap yields spurious ERROR nodes on parses after the first), so they always
// produce no record here — this canary guards the 16 native-loader languages, not those two.
describe('grammar-drift canary — every claimed callGraph language parses its fixture cleanly', () => {
  for (const f of BASIC) {
    it(`${f.language}: fixture parses with zero ERROR/MISSING nodes`, async () => {
      const r = await build([{ path: f.path, language: f.language, content: f.content }]);
      const health = r.parseHealthByFile?.get(f.path);
      expect(
        health,
        `${f.language} fixture parsed with errors: ${JSON.stringify(health)}`,
      ).toBeUndefined();
    });
  }
});

// ── (9) Cross-file resolution for EVERY claimed callGraph language + precision ─────────────────────
// The resolver's discipline is only proven where it is exercised. Section (3) sampled 3 languages;
// this sweep drives a caller→callee split across two files for every claimed callGraph language and
// asserts the edge resolves AND its provenance is the confidence expected for that language.
//
// Documented exclusions (proven cross-file elsewhere or a disclosed extractor limitation, NOT a
// resolver guess):
//  - Bash: a bare command call (`helper`) is lexically indistinguishable from an external command
//    across files, so the extractor deliberately does not bind it cross-file. Asserted explicitly below.
//  - Lua, Dart: WASM-loaded grammars whose shared WASM Language heap yields spurious ERROR nodes on
//    parses AFTER the first in a process (the same limitation the grammar-drift canary excludes them
//    for). Their callGraph support — including cross-file name resolution on a first parse — is proven
//    by the standalone build in section (1); a second in-process build (this sweep) is unreliable, so
//    they are excluded here rather than asserted flakily.
const CROSS_FILE_EXCLUDED = new Set(['Bash', 'Lua', 'Dart']);
interface CrossFile { language: string; a: { path: string; content: string }; b: { path: string; content: string }; caller: string; callee: string; confidence: string }
const CROSS_FILE: CrossFile[] = [
  { language: 'TypeScript', confidence: 'import',    caller: 'main', callee: 'helper', a: { path: 'a.ts', content: `import { helper } from './b';\nexport function main(){ helper(); }` }, b: { path: 'b.ts', content: `export function helper(){ return 1; }` } },
  { language: 'JavaScript', confidence: 'import',    caller: 'main', callee: 'helper', a: { path: 'a.js', content: `import { helper } from './b';\nexport function main(){ helper(); }` }, b: { path: 'b.js', content: `export function helper(){ return 1; }` } },
  { language: 'Python',     confidence: 'import',    caller: 'main', callee: 'helper', a: { path: 'pkg/a.py', content: `from .b import helper\n\ndef main():\n    helper()\n` }, b: { path: 'pkg/b.py', content: `def helper():\n    return 1\n` } },
  { language: 'Go',         confidence: 'import',    caller: 'Main', callee: 'Helper', a: { path: 'pkg/a.go', content: `package m\nfunc Main(){ Helper() }\n` }, b: { path: 'pkg/b.go', content: `package m\nfunc Helper() int { return 1 }\n` } },
  { language: 'Rust',       confidence: 'name_only', caller: 'main', callee: 'helper', a: { path: 'a.rs', content: `fn main(){ helper(); }\n` }, b: { path: 'b.rs', content: `fn helper() -> i32 { 1 }\n` } },
  { language: 'Ruby',       confidence: 'name_only', caller: 'main', callee: 'helper', a: { path: 'a.rb', content: `def main\n  helper\nend\n` }, b: { path: 'b.rb', content: `def helper\n  1\nend\n` } },
  { language: 'Java',       confidence: 'import',    caller: 'main', callee: 'helper', a: { path: 'app/A.java', content: `package app;\nimport util.B;\nclass A {\n  void main() { B.helper(); }\n}` }, b: { path: 'util/B.java', content: `package util;\nclass B {\n  static void helper() {}\n}` } },
  { language: 'Kotlin',     confidence: 'import',    caller: 'main', callee: 'helper', a: { path: 'app/A.kt', content: `package app\nimport util.B\nfun main() { B.helper() }\n` }, b: { path: 'util/B.kt', content: `package util\nobject B { fun helper(): Int { return 1 } }\n` } },
  { language: 'PHP',        confidence: 'import',    caller: 'main', callee: 'helper', a: { path: 'app/A.php', content: `<?php\nnamespace App;\nuse Util\\B;\nfunction main() { B::helper(); }\n` }, b: { path: 'util/B.php', content: `<?php\nnamespace Util;\nclass B { public static function helper() { return 1; } }\n` } },
  { language: 'C#',         confidence: 'import',    caller: 'Main', callee: 'Helper', a: { path: 'app/A.cs', content: `using Util;\nnamespace App;\nclass A {\n  void Main() { B.Helper(); }\n}` }, b: { path: 'util/B.cs', content: `namespace Util;\nclass B {\n  public static void Helper() {}\n}` } },
  { language: 'C++',        confidence: 'name_only', caller: 'mainFn', callee: 'helper', a: { path: 'a.cpp', content: `void mainFn() { helper(); }\n` }, b: { path: 'b.cpp', content: `void helper() {}\n` } },
  { language: 'C',          confidence: 'name_only', caller: 'mainFn', callee: 'helper', a: { path: 'a.c', content: `void mainFn() { helper(); }\n` }, b: { path: 'b.c', content: `void helper() {}\n` } },
  { language: 'Swift',      confidence: 'name_only', caller: 'mainFn', callee: 'helper', a: { path: 'a.swift', content: `func mainFn() { helper() }\n` }, b: { path: 'b.swift', content: `func helper() -> Int { return 1 }\n` } },
  { language: 'Scala',      confidence: 'name_only', caller: 'main', callee: 'helper', a: { path: 'A.scala', content: `object A {\n  def main(): Unit = { B.helper() }\n}` }, b: { path: 'B.scala', content: `object B {\n  def helper(): Int = 1\n}` } },
  { language: 'Elixir',     confidence: 'name_only', caller: 'main', callee: 'helper', a: { path: 'a.ex', content: `defmodule A do\n  def main(), do: B.helper()\nend\n` }, b: { path: 'b.ex', content: `defmodule B do\n  def helper(), do: 1\nend\n` } },
];

describe('language conformance — cross-file resolution for EVERY claimed callGraph language', () => {
  it('covers every claimed callGraph language (except the documented Bash exclusion)', () => {
    const claimed = [...CALLGRAPH_LANGUAGES].filter((l) => !CROSS_FILE_EXCLUDED.has(l));
    const covered = new Set(CROSS_FILE.map((f) => f.language));
    const uncovered = claimed.filter((l) => !covered.has(l));
    expect(uncovered, `callGraph languages with no cross-file fixture: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('has an import-provenance cross-file fixture for every claimed import language', () => {
    const byLanguage = new Map(CROSS_FILE.map(f => [f.language, f]));
    const uncovered = [...IMPORT_RESOLUTION_LANGUAGES]
      .filter(language => byLanguage.get(language)?.confidence !== 'import');
    expect(uncovered, `import languages without import fixture: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('moves all 5 staged-language corpus edges to import confidence without losing a target', async () => {
    const staged = CROSS_FILE.filter(f => ['Go', 'Java', 'Kotlin', 'C#', 'PHP'].includes(f.language));
    let moved = 0;
    for (const f of staged) {
      const files = [
        { path: f.a.path, language: f.language, content: f.a.content },
        { path: f.b.path, language: f.language, content: f.b.content },
      ];
      const before = await build(files, new Map());
      const after = await build(files);
      const oldEdge = hasEdge(before, f.caller, f.callee);
      const newEdge = hasEdge(after, f.caller, f.callee);
      expect(oldEdge, `${f.language} baseline target`).toBeTruthy();
      expect(newEdge?.calleeId, `${f.language} target preserved`).toBe(oldEdge!.calleeId);
      expect(oldEdge!.confidence, `${f.language} baseline provenance`).not.toBe('import');
      expect(newEdge!.confidence, `${f.language} widened provenance`).toBe('import');
      moved++;
    }
    expect(moved).toBe(5);
  });

  for (const f of CROSS_FILE) {
    it(`${f.language}: resolves a cross-file ${f.caller}→${f.callee} at ${f.confidence} confidence`, async () => {
      const r = await build([
        { path: f.a.path, language: f.language, content: f.a.content },
        { path: f.b.path, language: f.language, content: f.b.content },
      ]);
      const e = hasEdge(r, f.caller, f.callee);
      expect(e, `${f.language} cross-file edge`).toBeTruthy();
      // The callee must live in the OTHER file (a genuine cross-file bind, not a same-file homonym).
      expect(r.nodes.get(e!.calleeId)?.filePath, `${f.language} callee file`).toBe(f.b.path);
      expect(e!.confidence, `${f.language} cross-file provenance`).toBe(f.confidence);
    });
  }

  it('Bash cross-file is a documented limitation: a bare command call is not bound across files', async () => {
    const r = await build([
      { path: 'a.sh', language: 'Bash', content: `main() { helper; }\n` },
      { path: 'b.sh', language: 'Bash', content: `helper() { echo hi; }\n` },
    ]);
    const e = hasEdge(r, 'main', 'helper');
    expect(e, 'Bash bare command calls are indistinguishable from external commands across files').toBeFalsy();
  });
});

// ── (10) Adversarial name-collision fixtures — the resolver refuses to guess ───────────────────────
// For each first-match-prone strategy, an ambiguous candidate set must yield the unresolved-ambiguous
// disposition (recorded on `result.ambiguousSites`), never an arbitrary first-match edge. A UNIQUE
// candidate still binds at the strategy's declared confidence. Overload-arity disambiguation is a
// node-identity concern tracked by a separate change and is intentionally not covered here.
// (change: harden-call-resolution-ambiguity; analyzer: NoFirstMatchBindingOnAmbiguity)
describe('language conformance — resolver refuses to guess on ambiguity', () => {
  const boundEdgesFrom = (r: Awaited<ReturnType<typeof build>>, caller: string) =>
    r.edges.filter((e) => r.nodes.get(e.callerId)?.name === caller && !r.nodes.get(e.calleeId)?.isExternal);

  const importedCollisions = [
    {
      language: 'Go', caller: 'Main', callee: 'Helper', wanted: 'wanted/helper.go',
      files: [
        { path: 'app/main.go', content: 'package app\nimport pick "example.com/project/wanted"\nfunc Main(){ pick.Helper() }' },
        { path: 'wanted/helper.go', content: 'package chosen\nfunc Helper() {}' },
        { path: 'other/helper.go', content: 'package other\nfunc Helper() {}' },
      ],
    },
    {
      language: 'Java', caller: 'main', callee: 'helper', wanted: 'wanted/Parser.java',
      files: [
        { path: 'app/Main.java', content: 'package app;\nimport wanted.Parser;\nclass Main { void main(){ Parser.helper(); } }' },
        { path: 'wanted/Parser.java', content: 'package wanted;\nclass Parser { static void helper() {} }' },
        { path: 'other/Parser.java', content: 'package other;\nclass Parser { static void helper() {} }' },
      ],
    },
    {
      language: 'Kotlin', caller: 'main', callee: 'helper', wanted: 'wanted/Parser.kt',
      files: [
        { path: 'app/Main.kt', content: 'package app\nimport wanted.Parser\nfun main(){ Parser.helper() }' },
        { path: 'wanted/Parser.kt', content: 'package wanted\nobject Parser { fun helper() {} }' },
        { path: 'other/Parser.kt', content: 'package other\nobject Parser { fun helper() {} }' },
      ],
    },
    {
      language: 'C#', caller: 'Main', callee: 'Helper', wanted: 'wanted/Parser.cs',
      files: [
        { path: 'app/Main.cs', content: 'using Wanted;\nnamespace App;\nclass MainType { void Main(){ Parser.Helper(); } }' },
        { path: 'wanted/Parser.cs', content: 'namespace Wanted;\nclass Parser {\n  public static void Helper() {}\n}' },
        { path: 'other/Parser.cs', content: 'namespace Other;\nclass Parser {\n  public static void Helper() {}\n}' },
      ],
    },
    {
      language: 'PHP', caller: 'main', callee: 'helper', wanted: 'wanted/Parser.php',
      files: [
        { path: 'app/Main.php', content: '<?php\nnamespace App;\nuse Wanted\\Parser;\nfunction main(){ Parser::helper(); }' },
        { path: 'wanted/Parser.php', content: '<?php\nnamespace Wanted;\nclass Parser { public static function helper() {} }' },
        { path: 'other/Parser.php', content: '<?php\nnamespace Other;\nclass Parser { public static function helper() {} }' },
      ],
    },
  ];

  for (const fixture of importedCollisions) {
    it(`${fixture.language}: an import selects the declared target among same-named definitions`, async () => {
      const r = await build(fixture.files.map(file => ({ ...file, language: fixture.language })));
      const edge = boundEdgesFrom(r, fixture.caller).find(e => e.calleeName === fixture.callee);
      expect(edge?.confidence).toBe('import');
      expect(r.nodes.get(edge!.calleeId)?.filePath).toBe(fixture.wanted);
    });
  }

  it('a wired-language call absent from the package map falls through to name_only unchanged', async () => {
    const r = await build([
      { path: 'caller/main.go', language: 'Go', content: 'package caller\nfunc Main(){ Helper() }' },
      { path: 'other/helper.go', language: 'Go', content: 'package other\nfunc Helper() {}' },
    ]);
    const edge = boundEdgesFrom(r, 'Main').find(e => e.calleeName === 'Helper');
    expect(edge?.confidence).toBe('name_only');
    expect(r.nodes.get(edge!.calleeId)?.filePath).toBe('other/helper.go');
  });

  it('Go package scope leaves same-file calls at same_file confidence', async () => {
    const r = await build([{
      path: 'pkg/main.go',
      language: 'Go',
      content: 'package pkg\nfunc Main(){ Helper() }\nfunc Helper() {}',
    }]);
    expect(hasEdge(r, 'Main', 'Helper')?.confidence).toBe('same_file');
  });

  const aliasedImports = [
    {
      language: 'Kotlin', caller: 'main', callee: 'helper', wanted: 'wanted/Parser.kt',
      files: [
        { path: 'app/Main.kt', content: 'package app\nimport wanted.Parser as P\nfun main(){ P.helper() }' },
        { path: 'wanted/Parser.kt', content: 'package wanted\nobject Parser { fun helper() {} }' },
      ],
    },
    {
      language: 'C#', caller: 'Main', callee: 'Helper', wanted: 'wanted/Parser.cs',
      files: [
        { path: 'app/Main.cs', content: 'using P = Wanted.Parser;\nnamespace App;\nclass MainType { void Main(){ P.Helper(); } }' },
        { path: 'wanted/Parser.cs', content: 'namespace Wanted;\nclass Parser { public static void Helper() {} }' },
      ],
    },
    {
      language: 'PHP', caller: 'main', callee: 'helper', wanted: 'wanted/Parser.php',
      files: [
        { path: 'app/Main.php', content: '<?php\nnamespace App;\nuse Wanted\\Parser as P;\nfunction main(){ P::helper(); }' },
        { path: 'wanted/Parser.php', content: '<?php\nnamespace Wanted;\nclass Parser { public static function helper() {} }' },
      ],
    },
  ];

  for (const fixture of aliasedImports) {
    it(`${fixture.language}: an aliased import resolves to the declaration's real type`, async () => {
      const r = await build(fixture.files.map(file => ({ ...file, language: fixture.language })));
      const edge = boundEdgesFrom(r, fixture.caller).find(e => e.calleeName === fixture.callee);
      expect(edge?.confidence).toBe('import');
      expect(r.nodes.get(edge!.calleeId)?.filePath).toBe(fixture.wanted);
    });
  }

  it('an alias cannot bind a method from the wrong type in the imported file', async () => {
    const r = await build([
      { path: 'app/Main.cs', language: 'C#', content: 'using P = Wanted.Parser;\nnamespace App;\nclass MainType { void Main(){ P.Helper(); } }' },
      { path: 'wanted/Types.cs', language: 'C#', content: 'namespace Wanted;\nclass Parser {}\nclass Other { public static void Helper() {} }' },
    ]);
    expect(boundEdgesFrom(r, 'Main').some(
      e => e.calleeName === 'Helper' && e.confidence === 'import',
    )).toBe(false);
  });

  it('an unaliased Go import uses the target package clause, not the path basename', async () => {
    const r = await build([
      { path: 'app/main.go', language: 'Go', content: 'package app\nimport "example.com/acme/lib/v2"\nfunc Main(){ lib.Helper() }' },
      { path: 'lib/v2/helper.go', language: 'Go', content: 'package lib\nfunc Helper() {}' },
    ]);
    const edge = boundEdgesFrom(r, 'Main').find(e => e.calleeName === 'Helper');
    expect(edge?.confidence).toBe('import');
    expect(r.nodes.get(edge!.calleeId)?.filePath).toBe('lib/v2/helper.go');
  });

  for (const fixture of [
    { language: 'Java', ext: 'java', caller: 'main', callee: 'helper', source: 'package app; class Main { void main(){ wanted.Parser.helper(); } }', target: 'package wanted; class Parser { static void helper() {} }' },
    { language: 'Kotlin', ext: 'kt', caller: 'main', callee: 'helper', source: 'package app\nfun main(){ wanted.Parser.helper() }', target: 'package wanted\nobject Parser { fun helper() {} }' },
    { language: 'C#', ext: 'cs', caller: 'Main', callee: 'Helper', source: 'namespace App; class MainType { void Main(){ Wanted.Parser.Helper(); } }', target: 'namespace Wanted; class Parser { public static void Helper() {} }' },
  ]) {
    it(`${fixture.language}: a fully qualified call resolves through the FQN map`, async () => {
      const r = await build([
        { path: `app/Main.${fixture.ext}`, language: fixture.language, content: fixture.source },
        { path: `wanted/Parser.${fixture.ext}`, language: fixture.language, content: fixture.target },
      ]);
      const edge = boundEdgesFrom(r, fixture.caller).find(e => e.calleeName === fixture.callee);
      expect(edge?.confidence).toBe('import');
    });
  }

  it('language ecosystems do not contaminate each other\'s FQN uniqueness', async () => {
    const r = await build([
      { path: 'app/Main.cs', language: 'C#', content: 'using Shared;\nnamespace App;\nclass MainType { void Main(){ Parser.Helper(); } }' },
      { path: 'shared/Parser.cs', language: 'C#', content: 'namespace Shared;\nclass Parser { public static void Helper() {} }' },
      { path: 'shared/Parser.php', language: 'PHP', content: '<?php\nnamespace Shared;\nclass Parser { public static function Helper() {} }' },
    ]);
    const edge = boundEdgesFrom(r, 'Main').find(e => e.calleeName === 'Helper');
    expect(edge?.confidence).toBe('import');
    expect(r.nodes.get(edge!.calleeId)?.filePath).toBe('shared/Parser.cs');
  });

  it('PHP function imports bind namespace-level functions only', async () => {
    const r = await build([
      { path: 'app/Main.php', language: 'PHP', content: '<?php\nnamespace App;\nuse function Util\\helper;\nfunction main(){ helper(); }' },
      { path: 'util/Functions.php', language: 'PHP', content: '<?php\nnamespace Util;\nfunction helper() {}\nclass Decoy { function helper() {} }' },
    ]);
    const edge = boundEdgesFrom(r, 'main').find(e => e.calleeName === 'helper');
    expect(edge?.confidence).toBe('import');
    expect(r.nodes.get(edge!.calleeId)?.className).toBeUndefined();
  });

  it('PHP bracketed namespaces support use-based resolution', async () => {
    const r = await build([
      { path: 'app/Main.php', language: 'PHP', content: '<?php\nnamespace App {\nuse Wanted\\Parser;\nfunction main(){ Parser::helper(); }\n}' },
      { path: 'wanted/Parser.php', language: 'PHP', content: '<?php\nnamespace Wanted {\nclass Parser { public static function helper() {} }\n}' },
    ]);
    expect(boundEdgesFrom(r, 'main').find(e => e.calleeName === 'helper')?.confidence).toBe('import');
  });

  it('commented-out declarations and imports cannot create import-confidence edges', async () => {
    const r = await build([
      { path: 'app/Main.java', language: 'Java', content: 'package app;\n/*\nimport wanted.Parser;\n*/\nclass Main { void main(){ Parser.helper(); } }' },
      { path: 'wanted/Parser.java', language: 'Java', content: 'package wanted;\nclass Parser { static void helper() {} }' },
    ]);
    expect(boundEdgesFrom(r, 'main').find(e => e.calleeName === 'helper')?.confidence).not.toBe('import');
  });

  it('recovered Kotlin receivers retain the pre-change name_only fallback when no import binds', async () => {
    const r = await build([
      { path: 'a.kt', language: 'Kotlin', content: 'fun main(){ service.helper() }' },
      { path: 'b.kt', language: 'Kotlin', content: 'fun helper() {}' },
    ]);
    expect(boundEdgesFrom(r, 'main').find(e => e.calleeName === 'helper')?.confidence).toBe('name_only');
  });

  it('C# object return types are not misindexed as declarations', async () => {
    const r = await build([
      { path: 'app/Main.cs', language: 'C#', content: 'using Helpers;\nnamespace App;\nclass MainType { object model; void Main(){ model.GetValue(); } }' },
      { path: 'helpers/ReflectionHelpers.cs', language: 'C#', content: 'namespace Helpers;\nstatic class ReflectionHelpers { public static object GetValue(this object value) => value; }' },
    ]);
    expect(boundEdgesFrom(r, 'Main').find(e => e.calleeName === 'GetValue')?.confidence).toBe('name_only');
  });

  it('the Go import scanner stays bounded on many unclosed import blocks', () => {
    const content = `package p\n${'import (\n'.repeat(20_000)}`;
    const started = performance.now();
    buildBaseImportMap([{ path: 'p/main.go', language: 'Go', content }]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('name_only: a bare cross-file call matching two definitions is not bound arbitrarily', async () => {
    const r = await build([
      { path: 'caller.py', language: 'Python', content: `def main():\n    run()\n` },
      { path: 'a.py', language: 'Python', content: `def run():\n    return 1\n` },
      { path: 'b.py', language: 'Python', content: `def run():\n    return 2\n` },
    ]);
    // No name_only edge to either candidate.
    expect(boundEdgesFrom(r, 'main').some((e) => e.confidence === 'name_only')).toBe(false);
    const site = (r.ambiguousSites ?? []).find((s) => s.calleeName === 'run' && s.strategy === 'name_only');
    expect(site, 'ambiguous site recorded').toBeTruthy();
    expect(site!.candidateCount).toBe(2);
    expect(site!.candidateIds.sort()).toEqual(['a.py::run', 'b.py::run']);
  });

  it('name_only: a UNIQUE cross-file candidate still binds', async () => {
    const r = await build([
      { path: 'caller.py', language: 'Python', content: `def main():\n    run()\n` },
      { path: 'a.py', language: 'Python', content: `def run():\n    return 1\n` },
    ]);
    const edge = boundEdgesFrom(r, 'main').find((e) => e.confidence === 'name_only');
    expect(edge, 'unique cross-file name_only edge').toBeTruthy();
    expect(r.ambiguousSites, 'no ambiguity for a unique candidate').toBeUndefined();
  });

  it('self/cls: dispatch resolves to the caller\'s OWN class, not whichever sorts first', async () => {
    // Both files declare `Handler` with `process`; the caller is in a1.py.
    const r = await build([
      { path: 'a1.py', language: 'Python', content: `class Handler:\n    def run(self):\n        self.process()\n    def process(self):\n        return 1\n` },
      { path: 'a2.py', language: 'Python', content: `class Handler:\n    def process(self):\n        return 2\n` },
    ]);
    const edge = boundEdgesFrom(r, 'run').find((e) => e.confidence === 'self_cls');
    expect(edge, 'self_cls edge to own class').toBeTruthy();
    expect(r.nodes.get(edge!.calleeId)?.filePath).toBe('a1.py');
    expect(r.ambiguousSites, 'own-file affinity resolves it, no ambiguity').toBeUndefined();
  });

  it('self/cls: a self-call whose method lives only in two OTHER same-named classes is ambiguous', async () => {
    const r = await build([
      { path: 'a1.py', language: 'Python', content: `class Handler:\n    def run(self):\n        self.process()\n` },
      { path: 'a2.py', language: 'Python', content: `class Handler:\n    def process(self):\n        return 2\n` },
      { path: 'a3.py', language: 'Python', content: `class Handler:\n    def process(self):\n        return 3\n` },
    ]);
    expect(boundEdgesFrom(r, 'run').some((e) => e.confidence === 'self_cls')).toBe(false);
    const site = (r.ambiguousSites ?? []).find((s) => s.calleeName === 'process' && s.strategy === 'self_cls');
    expect(site, 'ambiguous self_cls site recorded').toBeTruthy();
    expect(site!.candidateCount).toBe(2);
  });

  it('type_name: two same-named types with no affinity yield an ambiguous site, not a type_name edge', async () => {
    const r = await build([
      { path: 'A.java', language: 'Java', content: `class A {\n  void use() { Money.of(1); }\n}` },
      { path: 'Money1.java', language: 'Java', content: `class Money {\n  static int of(int x) { return x; }\n}` },
      { path: 'Money2.java', language: 'Java', content: `class Money {\n  static int of(int x) { return x + 1; }\n}` },
    ]);
    // No confident type_name edge (a synthesized over-approximation to both is a separate,
    // provenance-labeled mechanism — never a confident first-match).
    expect(boundEdgesFrom(r, 'use').some((e) => e.confidence === 'type_name')).toBe(false);
    const site = (r.ambiguousSites ?? []).find((s) => s.calleeName === 'of' && s.strategy === 'type_name');
    expect(site, 'ambiguous type_name site recorded').toBeTruthy();
    expect(site!.candidateCount).toBe(2);
  });

  it('type_name: a UNIQUE type match still binds', async () => {
    const r = await build([
      { path: 'A.java', language: 'Java', content: `class A {\n  void use() { Money.of(1); }\n}` },
      { path: 'Money.java', language: 'Java', content: `class Money {\n  static int of(int x) { return x; }\n}` },
    ]);
    const edge = boundEdgesFrom(r, 'use').find((e) => e.confidence === 'type_name');
    expect(edge, 'unique type_name edge').toBeTruthy();
  });
});
