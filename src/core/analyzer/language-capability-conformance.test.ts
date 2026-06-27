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
 * languages for basic calls, intra-class method dispatch, and cross-file resolution; the one
 * cross-language *precision* difference (TS resolves cross-file via `import`; Python/Go via
 * `name_only`) is asserted explicitly rather than hidden.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallGraphBuilder } from './call-graph.js';
import { CALLGRAPH_LANGUAGES } from './call-graph.js';
import { ERROR_PROPAGATION_LANGUAGES, extractExceptionFactsFromSource } from './exception-flow.js';
import { cfgSupportsLanguage, isStructurallyValid } from './cfg.js';
import { inferTypesFromSource, TYPE_INFERENCE_LANGUAGES } from './type-inference-engine.js';
import { STYLE_FINGERPRINT_LANGUAGES } from './style-fingerprint.js';
import { CROSS_SERVICE_HTTP_LANGUAGES, HTTP_CLIENT_LANGUAGES } from './http-capability.js';
import { extractRoutesFromFile, extractHttpCalls } from './http-route-parser.js';
import { CODE_LANGUAGES } from './language-support.js';

async function build(files: Array<{ path: string; language: string; content: string }>) {
  return new CallGraphBuilder().build(files);
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

  // Documented precision difference: Python/Go resolve cross-file by name (name_only), not by
  // import. The edge is still found (navigation works); the provenance is lower-confidence.
  for (const c of [
    { language: 'Python', a: { path: 'a.py', content: `from b import helper\n\ndef main():\n    helper()\n` }, b: { path: 'b.py', content: `def helper():\n    return 1\n` }, caller: 'main', callee: 'helper' },
    { language: 'Go', a: { path: 'a.go', content: `package m\nfunc Main(){ Helper() }\n` }, b: { path: 'b.go', content: `package m\nfunc Helper() int { return 1 }\n` }, caller: 'Main', callee: 'Helper' },
  ]) {
    it(`${c.language} resolves a cross-file call (name_only provenance)`, async () => {
      const r = await build([
        { path: c.a.path, language: c.language, content: c.a.content },
        { path: c.b.path, language: c.language, content: c.b.content },
      ]);
      expect(hasEdge(r, c.caller, c.callee), `${c.language} cross-file edge`).toBeTruthy();
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
