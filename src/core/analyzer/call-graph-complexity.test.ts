import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import {
  COMPLEXITY_LANGUAGES,
  computeCyclomaticComplexity,
} from './call-graph-complexity.js';

const C_FAMILY_SHAPE = 'if (a) {} while (b) {} for (;;) {} do {} while (d); case 1: catch (e) {} a && b || c';

const SHAPE_FIXTURES: Record<string, { body: string; expected: number }> = {
  TypeScript: {
    body: 'if (a) {} if (b) {} if (c) {} for (;;) {} case 1:',
    expected: 6,
  },
  JavaScript: { body: C_FAMILY_SHAPE, expected: 9 },
  Python: {
    body: 'if x:\nelif y:\nwhile z:\nfor i in xs:\nexcept Error:\na and b or c',
    expected: 8,
  },
  Go: {
    body: 'if a {} if b {} if c {} for i := 0; i < 1; i++ {} case 1:',
    expected: 6,
  },
  Rust: {
    body: 'if a {} while b {} for c in xs {} loop {} match value { 1 => a, 2 => b, _ => c }',
    expected: 7,
  },
  Swift: {
    body: 'if a {} guard b else {} while c {} for d in xs {} case 1: break catch {}',
    expected: 7,
  },
  Ruby: {
    body: 'if a\nend\nelsif b\nwhile c\nend',
    expected: 4,
  },
  Elixir: {
    body: 'if a do end\nunless b do end\ncase c do\n  1 -> a\n  2 -> b\n  _ -> c\nend\ncond do\n  a -> b\n  true -> c\nend\nrescue e',
    expected: 7,
  },
  Java: { body: C_FAMILY_SHAPE, expected: 9 },
  C: { body: C_FAMILY_SHAPE, expected: 9 },
  'C++': { body: C_FAMILY_SHAPE, expected: 9 },
  'C#': { body: `${C_FAMILY_SHAPE} foreach (var item in items) {}`, expected: 10 },
  PHP: {
    body: 'if ($a) {} elseif ($b) {} while ($c) {} for (;;) {} foreach ($xs as $x) {} do {} while ($d); case 1: catch ($e) {} $a && $b || $c',
    expected: 11,
  },
  Kotlin: {
    body: 'if (a) {} while (b) {} for (c in xs) {} when (x) { 1 -> a; 2 -> b; else -> c } catch (e: Error) {}',
    expected: 7,
  },
  Dart: { body: C_FAMILY_SHAPE, expected: 9 },
  Scala: {
    body: 'if a then {} while b do {} for c <- xs do {} case 1 => catch {}',
    expected: 6,
  },
};

// Calibrate the estimator/CFG intersection. Overlay gaps (for example Rust
// `loop`, Ruby `unless`, and PHP `elseif`) belong to fix-overlay-language-fidelity.
const CFG_CALIBRATION_FIXTURES = [
  {
    language: 'Go',
    path: 'fixture.go',
    expected: 6,
    content: `package fixture
func score(x int) {
  if x > 0 {};
  if x > 1 {};
  if x > 2 {};
  for i := 0; i < x; i++ {}
  switch x { case 1: }
}`,
  },
  {
    language: 'Rust',
    path: 'fixture.rs',
    expected: 6,
    content: `fn score(x: i32) {
  if x > 0 {}
  while false {}
  for _i in 0..x {}
  match x { 1 => {} 2 => {} _ => {} }
}`,
  },
  {
    language: 'Ruby',
    path: 'fixture.rb',
    expected: 3,
    content: `def score(x)
  if x > 0
  end
  while x > 2
    break
  end
end`,
  },
  {
    language: 'PHP',
    path: 'fixture.php',
    expected: 3,
    content: `<?php
function score($x, $xs) {
  if ($x) {}
  foreach ($xs as $value) {}
}`,
  },
] as const;

const PARSER_FIXTURES = [
  { language: 'TypeScript', path: 'fixture.ts', expected: 2, content: 'function score(x: number) { if (x > 0) {} }' },
  { language: 'JavaScript', path: 'fixture.js', expected: 2, content: 'function score(x) { if (x > 0) {} }' },
  { language: 'Python', path: 'fixture.py', expected: 2, content: 'def score(x):\n    if x > 0:\n        return 1' },
  { language: 'Go', path: 'fixture.go', expected: 2, content: 'package fixture\nfunc score(x int) { if x > 0 {} }' },
  { language: 'Rust', path: 'fixture.rs', expected: 2, content: 'fn score(x: i32) { if x > 0 {} }' },
  {
    language: 'Swift',
    path: 'fixture.swift',
    expected: 7,
    content: `func score(_ x: Int) {
  if x > 0 {}
  guard x > 1 else { return }
  while false {}
  for _ in [1] {}
  switch x { case 1: break; default: break }
  do {} catch {}
}`,
  },
  { language: 'Ruby', path: 'fixture.rb', expected: 2, content: 'def score(x)\n  if x > 0\n  end\nend' },
  {
    language: 'Elixir',
    path: 'fixture.ex',
    expected: 7,
    content: `defmodule Fixture do
  def score(x) do
    if x > 0, do: x
    unless x > 1, do: x
    case x do
      1 -> 1
      2 -> 2
      _ -> 0
    end
    cond do
      x > 0 -> x
      true -> 0
    end
    try do
      x
    rescue
      _ -> 0
    end
  end
end`,
  },
  { language: 'Java', path: 'Fixture.java', expected: 2, content: 'class Fixture { void score(int x) { if (x > 0) {} } }' },
  { language: 'C', path: 'fixture.c', expected: 2, content: 'void score(int x) { if (x > 0) {} }' },
  { language: 'C++', path: 'fixture.cpp', expected: 2, content: 'void score(int x) { if (x > 0) {} }' },
  { language: 'C#', path: 'Fixture.cs', expected: 2, content: 'class Fixture { void score(int x) { if (x > 0) {} } }' },
  { language: 'PHP', path: 'fixture.php', expected: 2, content: '<?php function score($x) { if ($x > 0) {} }' },
  { language: 'Kotlin', path: 'fixture.kt', expected: 2, content: 'fun score(x: Int) { if (x > 0) {} }' },
  { language: 'Dart', path: 'fixture.dart', expected: 2, content: 'void score(int x) { if (x > 0) {} }' },
  { language: 'Scala', path: 'fixture.scala', expected: 2, content: 'object Fixture { def score(x: Int): Int = { if (x > 0) 1 else 0 } }' },
] as const;

describe('per-language cyclomatic complexity', () => {
  for (const [language, fixture] of Object.entries(SHAPE_FIXTURES)) {
    it(`${language} counts its decision-keyword shape`, () => {
      expect(computeCyclomaticComplexity(fixture.body, language)).toBe(fixture.expected);
    });
  }

  it('keeps Go and identically shaped paren-style TypeScript in parity', () => {
    expect(computeCyclomaticComplexity(SHAPE_FIXTURES.Go.body, 'Go')).toBe(
      computeCyclomaticComplexity(SHAPE_FIXTURES.TypeScript.body, 'TypeScript'),
    );
  });

  it('anchors keywords at word boundaries', () => {
    expect(computeCyclomaticComplexity('iffy format showcase catcher', 'Go')).toBe(1);
    expect(computeCyclomaticComplexity('different elsifValue meanwhile', 'Ruby')).toBe(1);
  });

  it('counts each non-default multi-arm alternative', () => {
    expect(computeCyclomaticComplexity('match x { 1 => a, _ => b }', 'Rust')).toBe(2);
    expect(computeCyclomaticComplexity('match x { 1 => a, 2 => b, 3 => c, _ => d }', 'Rust')).toBe(4);
    expect(computeCyclomaticComplexity('when (x) { 1 -> a; else -> b }', 'Kotlin')).toBe(2);
    expect(computeCyclomaticComplexity('when (x) { 1 -> a; 2 -> b; 3 -> c; else -> d }', 'Kotlin')).toBe(4);
    expect(computeCyclomaticComplexity('match x { 1 => {} 2 => {} _ => {} }', 'Rust')).toBe(3);
    expect(computeCyclomaticComplexity('case x do 1 -> :one; 2 -> :two; _ -> :other end', 'Elixir')).toBe(3);
  });

  it('does not count anonymous-function arrows as branch arms', () => {
    expect(computeCyclomaticComplexity('fun score(xs: List<Int>) { xs.map { x -> x + 1 } }', 'Kotlin')).toBe(1);
    expect(computeCyclomaticComplexity('def score(x) do Enum.map(x, fn y -> y end) end', 'Elixir')).toBe(1);
  });

  it('counts nested branch constructs without counting their lambda bodies', () => {
    expect(computeCyclomaticComplexity('match x { 1 => match y { 2 => a, _ => b }, _ => c }', 'Rust')).toBe(3);
    expect(computeCyclomaticComplexity('when (x) { 1 -> when (y) { 2 -> a; else -> b }; else -> c }', 'Kotlin')).toBe(3);
    expect(computeCyclomaticComplexity('case x do\n  1 -> case y do\n    2 -> :ok\n    _ -> :error\n  end\n  _ -> :error\nend', 'Elixir')).toBe(3);
  });

  it('balances brace-bearing branch subjects', () => {
    expect(computeCyclomaticComplexity('when (run { x }) { 1 -> a; 2 -> b; else -> c }', 'Kotlin')).toBe(3);
    expect(computeCyclomaticComplexity('match (Foo { x: 1 }) { Foo { x: 1 } => a, _ => b }', 'Rust')).toBe(2);
    expect(computeCyclomaticComplexity('match { compute() } { 1 => a, 2 => b, _ => c }', 'Rust')).toBe(3);
  });

  it('ignores structural delimiters in strings and comments', () => {
    expect(computeCyclomaticComplexity('when (x) { 1 -> "}"; 2 -> b; 3 -> c; else -> d }', 'Kotlin')).toBe(4);
    expect(computeCyclomaticComplexity('match x { 1 => "}", 2 => b, 3 => c, _ => d }', 'Rust')).toBe(4);
    expect(computeCyclomaticComplexity('case x do 1 -> "end"; 2 -> :b; 3 -> :c; _ -> :d end', 'Elixir')).toBe(4);
  });

  it('preserves literal branch patterns while masking their contents', () => {
    expect(computeCyclomaticComplexity('match s { "a" => a, "b" => b, _ => d }', 'Rust')).toBe(3);
    expect(computeCyclomaticComplexity('when (s) { "a" -> a; "b" -> b; else -> d }', 'Kotlin')).toBe(3);
    expect(computeCyclomaticComplexity('case s do "a" -> :a; "b" -> :b; _ -> :d end', 'Elixir')).toBe(3);
    expect(computeCyclomaticComplexity("match ch { 'a' => a, 'b' => b, _ => d }", 'Rust')).toBe(3);
  });

  it('masks native raw, multiline, and percent literals', () => {
    expect(computeCyclomaticComplexity('match x { 1 => r#""}"#, 2 => b, 3 => c, _ => d }', 'Rust')).toBe(4);
    expect(computeCyclomaticComplexity('when (x) { 1 -> """}"""; 2 -> b; 3 -> c; else -> d }', 'Kotlin')).toBe(4);
    expect(computeCyclomaticComplexity('def score():\n    """text " if while for"""\n    return 1', 'Python')).toBe(1);
    expect(computeCyclomaticComplexity('def score; value = %q{ if while }; end', 'Ruby')).toBe(1);
    expect(computeCyclomaticComplexity('fn score() { let text = r#"text " if while"#; }', 'Rust')).toBe(1);
  });

  it('preserves multiline literal patterns as branch arms', () => {
    expect(computeCyclomaticComplexity('when (s) { """a\nb""" -> a; "c" -> c; else -> d }', 'Kotlin')).toBe(3);
    expect(computeCyclomaticComplexity('match s { r#"a\nb"# => a, "c" => c, _ => d }', 'Rust')).toBe(3);
    expect(computeCyclomaticComplexity('case s do """a\nb""" -> :a; "c" -> :c; _ -> :d end', 'Elixir')).toBe(3);
    expect(computeCyclomaticComplexity('match s { "a\nline" => a, "b" => b, _ => d }', 'Rust')).toBe(3);
    expect(computeCyclomaticComplexity('case s do "a\nline" -> :a; "b" -> :b; _ -> :d end', 'Elixir')).toBe(3);
  });

  it('preserves ordinary multiline literal arms through the real parser', async () => {
    const fixtures = [
      { language: 'Rust', path: 'fixture.rs', content: 'fn score(s: &str) { match s { "a\nline" => (), "b" => (), _ => () } }' },
      { language: 'Elixir', path: 'fixture.ex', content: 'defmodule Fixture do\n  def score(s) do case s do "a\nline" -> :a; "b" -> :b; _ -> :d end end\nend' },
    ];
    for (const fixture of fixtures) {
      const graph = await new CallGraphBuilder().build([fixture]);
      const score = [...graph.nodes.values()].find(node => node.name === 'score');
      expect(score?.cyclomaticComplexity).toBe(3);
    }
  });

  it('distinguishes Rust lifetimes and labels from character literals', () => {
    expect(computeCyclomaticComplexity("fn score(x: &'_ str) { if ready {} while wait {} }", 'Rust')).toBe(3);
    expect(computeCyclomaticComplexity("'outer: loop { if ready { break 'outer; } }", 'Rust')).toBe(3);
  });

  it('distinguishes Scala symbol literals from character literals', async () => {
    const body = "def score = { val sym = 'foo; if ready then 1 else 0 }";
    expect(computeCyclomaticComplexity(body, 'Scala')).toBe(2);
    const graph = await new CallGraphBuilder().build([{ language: 'Scala', path: 'fixture.scala', content: `object Fixture { ${body} }` }]);
    const score = [...graph.nodes.values()].find(node => node.name === 'score');
    expect(score?.cyclomaticComplexity).toBe(2);
  });

  it('preserves Rust lifetimes and labels through the real call-graph parser', async () => {
    const graph = await new CallGraphBuilder().build([{
      language: 'Rust',
      path: 'fixture.rs',
      content: "fn score<'a>(x: &'a str) { 'outer: loop { if x.is_empty() { break 'outer; } } }",
    }]);
    const score = [...graph.nodes.values()].find(node => node.name === 'score');
    expect(score?.cyclomaticComplexity).toBe(3);
  });

  it('masks nested block comments before structural scanning', () => {
    expect(computeCyclomaticComplexity('when (x) { 1 -> a /* outer /* inner */ } still */; 2 -> b; 3 -> c; else -> d }', 'Kotlin')).toBe(4);
    expect(computeCyclomaticComplexity('match x { 1 => a /* outer /* inner */ } still */, 2 => b, 3 => c, _ => d }', 'Rust')).toBe(4);
  });

  it('does not count unconditional binding arms as decisions', () => {
    expect(computeCyclomaticComplexity('match x { other => other }', 'Rust')).toBe(1);
    expect(computeCyclomaticComplexity('match x { mut other => other }', 'Rust')).toBe(1);
    expect(computeCyclomaticComplexity('match x { ref mut other => other }', 'Rust')).toBe(1);
    expect(computeCyclomaticComplexity('match b { true => a, false => b }', 'Rust')).toBe(3);
    expect(computeCyclomaticComplexity('case x do other -> other end', 'Elixir')).toBe(1);
    expect(computeCyclomaticComplexity('case x do _other -> _other end', 'Elixir')).toBe(1);
    expect(computeCyclomaticComplexity('case x do true -> :yes; false -> :no end', 'Elixir')).toBe(3);
    expect(computeCyclomaticComplexity('cond do true -> :fallback end', 'Elixir')).toBe(1);
    expect(computeCyclomaticComplexity('cond do true and x -> :conditional end', 'Elixir')).toBe(3);
  });

  it('keeps anonymous-function arrows linear through the real call-graph parser', async () => {
    const fixtures = [
      { language: 'Kotlin', path: 'fixture.kt', content: 'fun score(xs: List<Int>) { xs.map { x -> x + 1 } }' },
      { language: 'Elixir', path: 'fixture.ex', content: 'defmodule Fixture do\n  def score(x) do Enum.map(x, fn y -> y end) end\nend' },
    ];
    for (const fixture of fixtures) {
      const graph = await new CallGraphBuilder().build([fixture]);
      const score = [...graph.nodes.values()].find(node => node.name === 'score');
      expect(score?.cyclomaticComplexity).toBe(1);
    }
  });

  it('counts compact Elixir arms through the real call-graph parser', async () => {
    const graph = await new CallGraphBuilder().build([{
      language: 'Elixir',
      path: 'fixture.ex',
      content: 'defmodule Fixture do\n  def score(x) do case x do 1 -> :one; 2 -> :two; _ -> :other end end\nend',
    }]);
    const score = [...graph.nodes.values()].find(node => node.name === 'score');
    expect(score?.cyclomaticComplexity).toBe(3);
  });

  it('balances branch subjects through the real call-graph parser', async () => {
    const fixtures = [
      { language: 'Kotlin', path: 'fixture.kt', content: 'fun score(x: Int) = when (run { x }) { 1 -> 1; 2 -> 2; else -> 0 }' },
      { language: 'Rust', path: 'fixture.rs', content: 'fn score() -> i32 { match { compute() } { 1 => 1, 2 => 2, _ => 0 } }\nfn compute() -> i32 { 1 }' },
    ];
    for (const fixture of fixtures) {
      const graph = await new CallGraphBuilder().build([fixture]);
      const score = [...graph.nodes.values()].find(node => node.name === 'score');
      expect(score?.cyclomaticComplexity).toBe(3);
    }
  });

  it('counts a valid do-while loop once', () => {
    expect(computeCyclomaticComplexity('do {} while (condition);', 'TypeScript')).toBe(2);
    expect(computeCyclomaticComplexity('do {} while ($condition);', 'PHP')).toBe(2);
  });

  it('counts Swift if-case and guard-case as one conditional each', () => {
    expect(computeCyclomaticComplexity('if case let .some(x) = value {}', 'Swift')).toBe(2);
    expect(computeCyclomaticComplexity('guard case let .some(x) = value else {}', 'Swift')).toBe(2);
    expect(computeCyclomaticComplexity('while case let .some(x) = iterator.next() {}', 'Swift')).toBe(2);
  });

  it('requires a fixture for every supported language', () => {
    expect([...COMPLEXITY_LANGUAGES].sort()).toEqual(Object.keys(SHAPE_FIXTURES).sort());
    expect([...COMPLEXITY_LANGUAGES].sort()).toEqual(PARSER_FIXTURES.map(fixture => fixture.language).sort());
  });

  it('returns no value for a language without a pattern', () => {
    expect(computeCyclomaticComplexity('if condition; then echo yes; fi', 'Bash')).toBeUndefined();
  });

  it('leaves complexity absent on an unsupported-language call-graph node', async () => {
    const graph = await new CallGraphBuilder().build([{
      path: 'fixture.sh',
      language: 'Bash',
      content: 'main() { if true; then echo yes; fi; }',
    }]);
    const main = [...graph.nodes.values()].find(node => node.name === 'main');
    expect(main).toBeDefined();
    expect(main).not.toHaveProperty('cyclomaticComplexity');
  });

  for (const fixture of CFG_CALIBRATION_FIXTURES) {
    it(`${fixture.language} call-graph complexity is calibrated to a real CFG-backed fixture`, async () => {
      const graph = await new CallGraphBuilder().build([fixture]);
      const score = [...graph.nodes.values()].find(node => node.name === 'score');
      expect(score?.cyclomaticComplexity).toBe(fixture.expected);
      const cfg = score && graph.cfgs?.get(score.id);
      expect(cfg).toBeDefined();
      expect(cfg!.edges.length - cfg!.blocks.length + 2).toBe(fixture.expected);
    });
  }

  for (const fixture of PARSER_FIXTURES) {
    it(`${fixture.language} assigns complexity through the real call-graph parser`, async () => {
      const graph = await new CallGraphBuilder().build([fixture]);
      const score = [...graph.nodes.values()].find(node => node.name === 'score');
      expect(score?.cyclomaticComplexity).toBe(fixture.expected);
    });
  }
});
