import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import { buildFunctionCfg, cfgSupportsLanguage, isStructurallyValid, valueReachableLines, type CfgNode, type FunctionCfg } from './cfg.js';

// ─── parsing helpers ─────────────────────────────────────────────────────────

function parse(content: string, lang: object): Parser.Tree {
  const p = new Parser();
  p.setLanguage(lang as unknown as Parser.Language);
  return p.parse(content);
}

function firstOfType(node: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode | undefined {
  if (types.includes(node.type)) return node;
  for (const c of node.namedChildren) {
    const found = firstOfType(c, types);
    if (found) return found;
  }
  return undefined;
}

async function tsLang(): Promise<object> {
  const m = await import('tree-sitter-typescript');
  return (m.default as { typescript: object }).typescript;
}
async function pyLang(): Promise<object> {
  const m = await import('tree-sitter-python');
  return m.default as object;
}
async function goLang(): Promise<object> {
  const m = await import('tree-sitter-go');
  return m.default as object;
}
async function javaLang(): Promise<object> { return (await import('tree-sitter-java')).default as object; }
async function cppLang(): Promise<object> { return (await import('tree-sitter-cpp')).default as object; }
async function rustLang(): Promise<object> { return (await import('tree-sitter-rust')).default as object; }
async function rubyLang(): Promise<object> { return (await import('tree-sitter-ruby')).default as object; }

function cfgFor(content: string, lang: object, language: string, fnTypes: string[]): FunctionCfg {
  const tree = parse(content, lang);
  const fn = firstOfType(tree.rootNode, fnTypes);
  expect(fn, 'function node not found').toBeTruthy();
  const cfg = buildFunctionCfg(fn as unknown as CfgNode, language);
  expect(cfg, 'cfg should be produced').toBeTruthy();
  return cfg!;
}

const TS_FN = ['function_declaration', 'method_definition', 'arrow_function'];
const PY_FN = ['function_definition'];
const GO_FN = ['function_declaration', 'method_declaration'];

function hasDefUse(cfg: FunctionCfg, variable: string, predicate?: (e: { defLine: number; useLine: number; precision: string }) => boolean): boolean {
  return cfg.defUse.some(e => e.variable === variable && (!predicate || predicate(e)));
}

// ─── CFG control-flow scenarios ──────────────────────────────────────────────

describe('CFG control flow', () => {
  it('Branch produces divergent and join blocks', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(
      `function f(a: number) { let x = 0; if (a > 0) { x = 1; } else { x = 2; } return x; }`,
      lang, 'TypeScript', TS_FN,
    );
    // A branch block with both a true and false outgoing edge.
    const branch = cfg.blocks.find(b => b.kind === 'branch');
    expect(branch).toBeTruthy();
    const out = cfg.edges.filter(e => e.from === branch!.id);
    expect(out.some(e => e.kind === 'true')).toBe(true);
    expect(out.some(e => e.kind === 'false')).toBe(true);
    // A merge block both arms reach (in-degree ≥ 2).
    const indeg = new Map<number, number>();
    for (const e of cfg.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const merge = cfg.blocks.find(b => b.kind === 'merge' && (indeg.get(b.id) ?? 0) >= 2);
    expect(merge).toBeTruthy();
  });

  it('Loop produces a back edge', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(
      `function f(n: number) { let i = 0; while (i < n) { i = i + 1; } return i; }`,
      lang, 'TypeScript', TS_FN,
    );
    const back = cfg.edges.find(e => e.kind === 'back');
    expect(back).toBeTruthy();
    // The back edge targets a loop block.
    const target = cfg.blocks.find(b => b.id === back!.to);
    expect(target?.kind).toBe('loop');
  });

  it('Early return terminates a path', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(
      `function f(a: number) { if (a < 0) { return -1; } const y = a * 2; return y; }`,
      lang, 'TypeScript', TS_FN,
    );
    // Some block has an 'exit' edge (the early return); that block must not also
    // flow into the post-conditional merge.
    const exitEdges = cfg.edges.filter(e => e.kind === 'exit');
    expect(exitEdges.length).toBeGreaterThanOrEqual(1);
    for (const ee of exitEdges) {
      const others = cfg.edges.filter(e => e.from === ee.from && e.kind !== 'exit');
      expect(others.length).toBe(0);
    }
  });

  it('CFG is deterministic across runs', async () => {
    const lang = await tsLang();
    const src = `function f(a: number) { let x = 0; if (a) { x = 1; } else { x = 2; } for (let i = 0; i < a; i++) { x += i; } return x; }`;
    const a = cfgFor(src, lang, 'TypeScript', TS_FN);
    const b = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('is deterministic for call-heavy code across many builds (no node-identity flakiness)', async () => {
    // A self-referential/recursive call exercises the callee-skip path, which must
    // compare AST nodes by POSITION, not object identity — tree-sitter returns
    // fresh wrappers per access, so identity comparison is non-deterministic.
    const lang = await tsLang();
    const src = `function walk(node: any): void {\n  const visit = (n: any) => { for (const c of n.children) visit(c); use(n); };\n  visit(node);\n  walk(node);\n}`;
    const sigs = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const tree = parse(src, lang); // fresh parse each time
      const fn = firstOfType(tree.rootNode, ['function_declaration'])!;
      sigs.add(JSON.stringify(buildFunctionCfg(fn as unknown as CfgNode, 'TypeScript')));
    }
    expect(sigs.size).toBe(1);
  });

  it('Unsupported language fails soft', async () => {
    const lang = await tsLang();
    const tree = parse(`function f() {}`, lang);
    const fn = firstOfType(tree.rootNode, TS_FN)!;
    expect(cfgSupportsLanguage('Elixir')).toBe(false);
    expect(buildFunctionCfg(fn as unknown as CfgNode, 'Elixir')).toBeUndefined();
  });
});

// ─── reaching-definitions scenarios ──────────────────────────────────────────

describe('reaching definitions (def-use)', () => {
  it('Local scalar def reaches its use', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(
      `function f() { const x = compute(); return x + 1; }`,
      lang, 'TypeScript', TS_FN,
    );
    expect(hasDefUse(cfg, 'x', e => e.precision === 'exact')).toBe(true);
  });

  it('Reassignment kills the earlier definition', async () => {
    const lang = await tsLang();
    const src = `function f() {\n  let x = a();\n  x = b();\n  return x;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    // return x is on line 4; x = b() on line 3; x = a() on line 2.
    const toReturn = cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 4);
    expect(toReturn.length).toBeGreaterThanOrEqual(1);
    expect(toReturn.every(e => e.defLine === 3)).toBe(true);
    expect(toReturn.some(e => e.defLine === 2)).toBe(false);
  });

  it('Both branches of a definition reach a later use', async () => {
    const lang = await tsLang();
    const src = `function f(c: boolean) {\n  let x;\n  if (c) {\n    x = 1;\n  } else {\n    x = 2;\n  }\n  return x;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    const toReturn = cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 8);
    const defLines = new Set(toReturn.map(e => e.defLine));
    expect(defLines.has(4)).toBe(true); // then arm
    expect(defLines.has(6)).toBe(true); // else arm
  });

  it('Field write is conservatively over-approximated (may)', async () => {
    const lang = await tsLang();
    const src = `function f(obj: any) {\n  obj.field = compute();\n  return obj.field;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    const fieldEdge = cfg.defUse.find(e => e.variable === 'obj.field');
    expect(fieldEdge).toBeTruthy();
    expect(fieldEdge!.precision).toBe('may');
  });

  it('Exact and may dependences are distinguishable in one function', async () => {
    const lang = await tsLang();
    const src = `function f(obj: any) {\n  const y = 1;\n  obj.f = 2;\n  return y + obj.f;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(hasDefUse(cfg, 'y', e => e.precision === 'exact')).toBe(true);
    expect(hasDefUse(cfg, 'obj.f', e => e.precision === 'may')).toBe(true);
  });
});

// ─── exception / multi-way control flow (alternative paths must not kill) ─────

describe('try/catch and switch (alternative-path soundness)', () => {
  it('try and catch defs both reach a later use (no spurious kill)', async () => {
    const lang = await tsLang();
    const src = `function f(a:number){\n  let x = 0;\n  try {\n    x = risky(a);\n  } catch (e) {\n    x = -1;\n  }\n  return x;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    const defLines = new Set(cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 8).map(e => e.defLine));
    expect(defLines.has(4)).toBe(true); // try body value reaches the return
    expect(defLines.has(6)).toBe(true); // catch body value reaches the return
  });

  it('switch case and default defs both reach a later use', async () => {
    const lang = await tsLang();
    const src = `function f(a:number){\n  let x = 0;\n  switch (a) {\n    case 1: x = 10; break;\n    default: x = 20;\n  }\n  return x;\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    const defLines = new Set(cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 7).map(e => e.defLine));
    expect(defLines.has(4)).toBe(true); // case 1
    expect(defLines.has(5)).toBe(true); // default
  });
});

// ─── closures: captured outer variables are `may`, nested scope does not leak ──

describe('closure captures are conservative (may)', () => {
  it('a variable captured by a nested arrow is a may dependence', async () => {
    const lang = await tsLang();
    const src = `function f(a:number){\n  const base = a + 1;\n  const fn = (y:number) => base + y;\n  return fn(2);\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    const cap = cfg.defUse.find(e => e.variable === 'base' && e.useLine === 3);
    expect(cap?.precision).toBe('may');
  });

  it('a callback captures the outer var as may and does not leak its own param', async () => {
    const lang = await tsLang();
    const src = `function f(items:number[]){\n  const k = 3;\n  return items.map(x => x * k);\n}`;
    const cfg = cfgFor(src, lang, 'TypeScript', TS_FN);
    expect(cfg.defUse.find(e => e.variable === 'k')?.precision).toBe('may');
    // The arrow's own parameter `x` is bound in the nested scope — no outer edge.
    expect(cfg.defUse.some(e => e.variable === 'x')).toBe(false);
  });
});

// ─── elif chains and destructuring (no dropped branches / defs) ───────────────

describe('elif chains and destructuring', () => {
  it('Python if/elif/else: all three branch defs reach a later use', async () => {
    const lang = await pyLang();
    const src = `def f(a):\n    x = 0\n    if a == 1:\n        x = 10\n    elif a == 2:\n        x = 20\n    else:\n        x = 30\n    return x`;
    const cfg = cfgFor(src, lang, 'Python', PY_FN);
    const defLines = new Set(cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 9).map(e => e.defLine));
    expect(defLines.has(4)).toBe(true); // if
    expect(defLines.has(6)).toBe(true); // elif
    expect(defLines.has(8)).toBe(true); // else
  });

  it('object destructuring binds each name as a definition', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(obj:any){\n  const { a, b } = obj;\n  return a + b;\n}`, lang, 'TypeScript', TS_FN);
    expect(hasDefUse(cfg, 'a')).toBe(true);
    expect(hasDefUse(cfg, 'b')).toBe(true);
  });

  it('array destructuring binds each element as a definition', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(arr:number[]){\n  const [x, y] = arr;\n  return x + y;\n}`, lang, 'TypeScript', TS_FN);
    expect(hasDefUse(cfg, 'x')).toBe(true);
    expect(hasDefUse(cfg, 'y')).toBe(true);
  });
});

// ─── conditional/embedded assignment completeness (no dropped dependence) ─────

describe('logical-assignment and walrus do not drop dependences', () => {
  it('logical assignment (||=) keeps the prior def reaching (conditional write)', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(a:any){\n  let x = a;\n  x ||= def();\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    const defLines = new Set(cfg.defUse.filter(e => e.variable === 'x' && e.useLine === 4).map(e => e.defLine));
    expect(defLines.has(2)).toBe(true); // prior value survives when x was truthy
    expect(defLines.has(3)).toBe(true); // the ||= value
  });

  it('plain (=) and augmented (+=) assignment still kill the prior def', async () => {
    const lang = await tsLang();
    const eq = cfgFor(`function f(){\n  let x = a();\n  x = b();\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    expect([...new Set(eq.defUse.filter(e => e.variable === 'x' && e.useLine === 4).map(e => e.defLine))]).toEqual([3]);
    const aug = cfgFor(`function f(){\n  let x = 1;\n  x += 2;\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    expect([...new Set(aug.defUse.filter(e => e.variable === 'x' && e.useLine === 4).map(e => e.defLine))]).toEqual([3]);
  });

  it('Python walrus (:=) records the embedded definition', async () => {
    const lang = await pyLang();
    const cfg = cfgFor(`def f(a):\n    if (n := len(a)) > 0:\n        return n\n    return 0`, lang, 'Python', PY_FN);
    const e = cfg.defUse.find(d => d.variable === 'n' && d.defLine === 2 && d.useLine === 3);
    expect(e?.precision).toBe('exact');
  });
});

// ─── lexical scope, idioms & escape gaps (adversarial-audit regressions) ──────

function defLinesTo(cfg: FunctionCfg, variable: string, useLine: number): number[] {
  return [...new Set(cfg.defUse.filter(e => e.variable === variable && e.useLine === useLine).map(e => e.defLine))].sort((a, b) => a - b);
}

// ─── infinite loops: body always runs (no phantom skip-body edge) ─────────────
// An infinite loop (Rust `loop {}`, Go `for {}`, C-family `for(;;)`) always
// executes its body, so a pre-loop def is killed by the body and must NOT reach a
// post-loop use. A foreach/range or conditional loop CAN skip its body, so the
// pre-loop def MUST still reach.
describe('infinite loops do not leak a pre-loop def (no unsound exact)', () => {
  it('Rust loop {} kills the pre-loop def', async () => {
    const cfg = cfgFor('fn f() -> i32 {\n  let mut x = init();\n  loop {\n    x = next();\n    if done() { break; }\n  }\n  return x;\n}', await rustLang(), 'Rust', ['function_item']);
    expect(defLinesTo(cfg, 'x', 7)).toEqual([4]); // only the body def; line 2 must not leak
  });
  it('Go for {} kills the pre-loop def', async () => {
    const cfg = cfgFor('func f() int {\n\tx := init()\n\tfor {\n\t\tx = next()\n\t\tif done() { break }\n\t}\n\treturn x\n}', await goLang(), 'Go', ['function_declaration']);
    expect(defLinesTo(cfg, 'x', 7)).toEqual([4]);
  });
  it('C++ for(;;) kills the pre-loop def', async () => {
    const cfg = cfgFor('int f(){\n  int x = init();\n  for(;;){\n    x = next();\n    if(done()) break;\n  }\n  return x;\n}', await cppLang(), 'C++', ['function_definition']);
    expect(defLinesTo(cfg, 'x', 7)).toEqual([4]);
  });
  it('Java for(;;) kills the pre-loop def', async () => {
    const cfg = cfgFor('class C{ int f(){\n  int x = init();\n  for(;;){\n    x = next();\n    if(done()) break;\n  }\n  return x;\n} }', await javaLang(), 'Java', ['method_declaration']);
    expect(defLinesTo(cfg, 'x', 7)).toEqual([4]);
  });
  it('C# for(;;) kills the pre-loop def', async () => {
    const cfg = cfgFor('class C{ int f(){\n  int x = init();\n  for(;;){\n    x = next();\n    if(done()) break;\n  }\n  return x;\n} }', await csharpLang(), 'C#', ['method_declaration']);
    expect(defLinesTo(cfg, 'x', 7)).toEqual([4]);
  });
  it('foreach/range and conditional loops STILL let the pre-loop def reach (zero-iteration path)', async () => {
    // Rust for-in, Go range, Go for-cond, C++ for(i<n), Python for — all can skip
    // the body, so both the pre-loop (2) and body (4) defs reach the use.
    const rustForIn = cfgFor('fn f() -> i32 {\n  let mut s = 0;\n  for v in xs {\n    s = s + v;\n  }\n  return s;\n}', await rustLang(), 'Rust', ['function_item']);
    expect(defLinesTo(rustForIn, 's', 6)).toEqual([2, 4]);
    const goRange = cfgFor('func f() int {\n\ts := 0\n\tfor _, v := range xs {\n\t\ts = s + v\n\t}\n\treturn s\n}', await goLang(), 'Go', ['function_declaration']);
    expect(defLinesTo(goRange, 's', 6)).toEqual([2, 4]);
    const goForCond = cfgFor('func f() int {\n\ts := 0\n\tfor s < 10 {\n\t\ts = s + 1\n\t}\n\treturn s\n}', await goLang(), 'Go', ['function_declaration']);
    expect(defLinesTo(goForCond, 's', 6)).toEqual([2, 4]); // Go bare-condition for must keep its skip edge
    const cppFor = cfgFor('int f(){\n  int s = 0;\n  for(int i=0;i<n;i++){\n    s = s + i;\n  }\n  return s;\n}', await cppLang(), 'C++', ['function_definition']);
    expect(defLinesTo(cppFor, 's', 6)).toEqual([2, 4]);
    const pyFor = cfgFor('def f():\n    s = 0\n    for v in xs:\n        s = s + v\n    return s', await pyLang(), 'Python', ['function_definition']);
    expect(defLinesTo(pyFor, 's', 5)).toEqual([2, 4]);
  });
});

describe('lexical block scope (shadowing must not conflate variables)', () => {
  it('TS: an inner block let shadow does not reach the outer use, nor drop it', async () => {
    const lang = await tsLang();
    // line 2 outer let x; line 3 inner block let x; line 4 return x (outer).
    const cfg = cfgFor(`function f(){\n  let x = 1;\n  { let x = 2; console.log(x); }\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    expect(defLinesTo(cfg, 'x', 4)).toEqual([2]);           // outer x=1 reaches return
    expect(cfg.defUse.some(e => e.defLine === 3 && e.useLine === 4)).toBe(false); // inner shadow does NOT
  });

  it('Go: an inner-block := shadow does not reach the outer use', async () => {
    const lang = await goLang();
    const cfg = cfgFor(`func f() int {\n\tx := 1\n\tif true {\n\t\tx := 2\n\t\t_ = x\n\t}\n\treturn x\n}`, lang, 'Go', GO_FN);
    expect(defLinesTo(cfg, 'x', 7)).toEqual([2]);
  });

  it('TS: a loop counter shadowing an outer var does not corrupt the outer', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let i = 100;\n  for (let i = 0; i < 3; i++) {}\n  return i;\n}`, lang, 'TypeScript', TS_FN);
    expect(defLinesTo(cfg, 'i', 4)).toEqual([2]); // outer i=100, not the loop counter
  });

  it('Python: a comprehension variable is a separate scope (no false edge from an outer same-name)', async () => {
    const lang = await pyLang();
    const cfg = cfgFor(`def f(xs):\n    x = 5\n    ys = [x for x in xs]\n    return x`, lang, 'Python', PY_FN);
    expect(cfg.defUse.some(e => e.variable === 'x' && e.useLine === 3)).toBe(false); // no edge INTO the comprehension
    expect(defLinesTo(cfg, 'x', 4)).toEqual([2]); // outer x=5 reaches the return
  });
});

describe('idioms & escape-detection gaps', () => {
  it('x++ is recorded as a definition', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let x = 0;\n  x++;\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    expect(defLinesTo(cfg, 'x', 4)).toEqual([3]);
  });

  it('x++ inside a closure marks the outer var as may', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let n = 0;\n  [1].forEach(() => { n++; });\n  return n;\n}`, lang, 'TypeScript', TS_FN);
    expect(cfg.defUse.find(e => e.variable === 'n' && e.useLine === 4)?.precision).toBe('may');
  });

  it('Go closure that mutates an outer local (expression_list LHS) is may', async () => {
    const lang = await goLang();
    const cfg = cfgFor(`func f() int {\n\tx := 0\n\tg := func() { x = 5 }\n\tg()\n\treturn x\n}`, lang, 'Go', GO_FN);
    expect(cfg.defUse.find(e => e.variable === 'x' && e.useLine === 5)?.precision).toBe('may');
  });

  it('Python try/except/else: only except and else reach (try body overwritten by else)', async () => {
    const lang = await pyLang();
    const cfg = cfgFor(`def f():\n    x = 1\n    try:\n        x = 2\n    except Exception:\n        x = 3\n    else:\n        x = 4\n    return x`, lang, 'Python', PY_FN);
    expect(defLinesTo(cfg, 'x', 9)).toEqual([6, 8]); // except(6) or else(8); NOT try(4)
  });

  it('Go C-style for loop defines its counter and carries it', async () => {
    const lang = await goLang();
    const cfg = cfgFor(`func f() int {\n\tsum := 0\n\tfor i := 0; i < 3; i++ {\n\t\tsum = sum + i\n\t}\n\treturn sum\n}`, lang, 'Go', GO_FN);
    expect(cfg.defUse.some(e => e.variable === 'i')).toBe(true); // counter is visible
    expect(defLinesTo(cfg, 'sum', 4)).toEqual([2, 4]);           // loop-carried
  });

  it('Go range vars are scoped to the loop (no alias to an outer same-name)', async () => {
    const lang = await goLang();
    // outer i=100 (line2); range i (line3) shadows it inside the body.
    const cfg = cfgFor(`func f(xs []int) {\n\ti := 100\n\tfor i, v := range xs {\n\t\t_ = i\n\t\t_ = v\n\t}\n}`, lang, 'Go', GO_FN);
    expect(cfg.defUse.some(e => e.variable === 'v')).toBe(true);  // range val is defined
    // The body read of i must bind to the range i (line 3), never the outer i=100 (line 2).
    expect(defLinesTo(cfg, 'i', 4)).toEqual([3]);
    expect(cfg.defUse.some(e => e.variable === 'i' && e.defLine === 2 && e.precision === 'exact')).toBe(false);
  });

  it('a labeled loop keeps its loop structure and loop-carried dependence', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let r = 0;\n  outer: for (let i=0;i<3;i++) {\n    r = r + 1;\n  }\n  return r;\n}`, lang, 'TypeScript', TS_FN);
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);
    expect(defLinesTo(cfg, 'r', 4)).toEqual([2, 4]); // pre-loop and loop-carried
  });
});

// ─── wider-audit findings: global/with, multi-line value flow, perf fail-soft ──

describe('global/nonlocal and with-statement (wider audit)', () => {
  it('Python global is downgraded to may (mutable through hidden calls)', async () => {
    const lang = await pyLang();
    const cfg = cfgFor(`def f():\n    global cache\n    cache = {}\n    populate()\n    return cache`, lang, 'Python', PY_FN);
    const e = cfg.defUse.find(d => d.variable === 'cache' && d.useLine === 5);
    expect(e?.precision).toBe('may');
  });

  it('Python with ... as binds the context variable as a definition', async () => {
    const lang = await pyLang();
    const cfg = cfgFor(`def f(p):\n    with open(p) as fh:\n        data = fh.read()\n    return data`, lang, 'Python', PY_FN);
    expect(cfg.defUse.some(e => e.variable === 'fh' && e.defLine === 2)).toBe(true);
    expect(defLinesTo(cfg, 'data', 4)).toEqual([3]);
  });
});

describe('value-level forward slice chains through multi-line definitions', () => {
  it('a parameter feeding a multi-line object literal reaches the call it is passed to', async () => {
    const lang = await tsLang();
    // p flows into ctx via a multi-line object literal (b: p on line 4); ctx is
    // passed to sink() on line 7. The forward slice must reach line 7.
    const cfg = cfgFor(`function f(p: number): number {\n  const ctx = {\n    a: 1,\n    b: p,\n    c: 3,\n  };\n  return sink(ctx);\n}`, lang, 'TypeScript', TS_FN);
    const reached = valueReachableLines(cfg, 'p');
    expect(reached.has(7)).toBe(true); // sink(ctx) — the data-dependent call
  });

  it('a parameter that reaches nothing yields an empty slice (no false inclusion)', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(a: number, b: number): number {\n  return a + 1;\n}`, lang, 'TypeScript', TS_FN);
    const reachedB = valueReachableLines(cfg, 'b');
    expect(reachedB.size).toBe(0); // b is unused
  });
});

describe('do/while is a post-test loop (no leaked pre-loop def)', () => {
  it('a pre-loop def does not reach past a do/while whose body always overwrites it', async () => {
    const lang = await tsLang();
    // line 2: let x (undefined); line 4: x = compute() in the body; line 6: return x.
    const cfg = cfgFor(`function f(){\n  let x;\n  do {\n    x = compute();\n  } while (retry());\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    expect(defLinesTo(cfg, 'x', 6)).toEqual([4]);                 // only the body def, not line 2
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);    // it is still a loop
  });

  it('the do/while condition sees the body def, not the pre-loop def', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let x = 1;\n  do { x = 2; }\n  while (g(x));\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    expect(defLinesTo(cfg, 'x', 4)).toEqual([3]); // g(x) on line 4 sees x=2 (line 3), not x=1
  });

  it('a normal while still keeps the pre-loop def reaching (body may run zero times)', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let x = 1;\n  while (c()) { x = 2; }\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    expect(defLinesTo(cfg, 'x', 4)).toEqual([2, 3]); // both: skipped (x=1) or ran (x=2)
  });
});

describe('pathological input fails soft (no hang, no partial overlay)', () => {
  it('a deeply nested loop nest exceeding the fixpoint budget yields no overlay', async () => {
    const lang = await tsLang();
    let src = 'function f(){\n  let x = 0;\n';
    for (let i = 0; i < 400; i++) src += `  while (x < ${i}) {\n`;
    src += '  x = x + 1;\n';
    for (let i = 0; i < 400; i++) src += '  }\n';
    src += '  return x;\n}';
    const tree = parse(src, lang);
    const fn = firstOfType(tree.rootNode, TS_FN)!;
    const t0 = Date.now();
    const cfg = buildFunctionCfg(fn as unknown as CfgNode, 'TypeScript');
    expect(Date.now() - t0).toBeLessThan(2000); // must not hang
    expect(cfg).toBeUndefined();                // fail soft
  });
});

// ─── structural-validity safety net ───────────────────────────────────────────

describe('structural validity guard', () => {
  it('rejects a malformed overlay (dangling edge / missing entry)', () => {
    expect(isStructurallyValid({
      blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }],
      edges: [{ from: 0, to: 99, kind: 'normal' }], // dangling endpoint
      defUse: [], params: [], paramLine: 1,
    })).toBe(false);
    expect(isStructurallyValid({
      blocks: [{ id: 0, kind: 'normal' }, { id: 1, kind: 'exit' }], // no entry
      edges: [], defUse: [], params: [], paramLine: 1,
    })).toBe(false);
    expect(isStructurallyValid({
      blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }],
      edges: [], defUse: [{ variable: 'x', defLine: 0, useLine: 2, precision: 'exact' }], // bad line
      params: [], paramLine: 1,
    })).toBe(false);
  });

  it('every overlay built from a real parse satisfies the invariants', async () => {
    const samples: Array<[object, string, string[]]> = [
      [await tsLang(), 'TypeScript', TS_FN],
      [await pyLang(), 'Python', PY_FN],
      [await goLang(), 'Go', GO_FN],
    ];
    const srcs: Record<string, string> = {
      TypeScript: `function f(a:number){ let x=0; try{ x=g(a); }catch(e){ x=-1; } switch(x){case 1: return 1; default: return x;} }`,
      Python: `def f(a):\n    x = 0\n    if a == 1:\n        x = 10\n    elif a == 2:\n        x = 20\n    for i in range(a):\n        x += i\n    return x`,
      Go: `func f(a int) int {\n\tx := 0\n\tfor i := 0; i < a; i++ { x = x + i }\n\tswitch a { case 1: return 1; default: return x }\n}`,
    };
    for (const [lang, name, fnTypes] of samples) {
      const cfg = cfgFor(srcs[name], lang, name, fnTypes);
      expect(isStructurallyValid(cfg), `${name} overlay invariants`).toBe(true);
    }
  });
});

// ─── escape analysis: no unsound `exact` for mutated-via-alias variables ──────

describe('escaped variables are downgraded to may (sound exact)', () => {
  it('a local mutated inside a closure is may, not exact', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let x = 1;\n  const g = () => { x = 2; };\n  g();\n  return x;\n}`, lang, 'TypeScript', TS_FN);
    const e = cfg.defUse.find(d => d.variable === 'x' && d.useLine === 5);
    expect(e?.precision).toBe('may'); // the closure may have reassigned x
  });

  it('a Go local whose address is taken is may, not exact', async () => {
    const lang = await goLang();
    const cfg = cfgFor(`func f() int {\n\tx := 1\n\tp := &x\n\t*p = 2\n\treturn x\n}`, lang, 'Go', GO_FN);
    const e = cfg.defUse.find(d => d.variable === 'x' && d.useLine === 5);
    expect(e?.precision).toBe('may'); // a pointer can mutate x out of band
  });

  it('a read-only closure capture does not over-downgrade the outer var', async () => {
    const lang = await tsLang();
    const cfg = cfgFor(`function f(){\n  let z = 1;\n  const g = () => z + 1;\n  return z;\n}`, lang, 'TypeScript', TS_FN);
    const e = cfg.defUse.find(d => d.variable === 'z' && d.useLine === 4);
    expect(e?.precision).toBe('exact'); // g only reads z; z is not mutated
  });

  it('a Rust local mutably borrowed (&mut x) is may, not exact', async () => {
    const lang = await rustLang();
    // `let mut x = 0; g(&mut x); return x;` — g can mutate x out of band.
    const cfg = cfgFor('fn f() -> i32 {\n  let mut x = 0;\n  g(&mut x);\n  return x;\n}', lang, 'Rust', ['function_item']);
    expect(cfg.defUse.find(d => d.variable === 'x' && d.useLine === 4)?.precision).toBe('may');
  });

  it('a Rust shared borrow (&x) does not over-downgrade — stays exact', async () => {
    const lang = await rustLang();
    // `let _y = &x;` is an immutable borrow; x cannot change through it.
    const cfg = cfgFor('fn f() -> i32 {\n  let x = 0;\n  let _y = &x;\n  return x;\n}', lang, 'Rust', ['function_item']);
    expect(cfg.defUse.find(d => d.variable === 'x' && d.useLine === 4)?.precision).toBe('exact');
  });

  it('a Rust local mutably borrowed inside a macro (write!(&mut x, …)) is may', async () => {
    const lang = await rustLang();
    // `write!(&mut buf, …)` keeps `&mut buf` in a raw macro token_tree.
    const cfg = cfgFor('fn f() -> String {\n  let mut buf = String::new();\n  let _ = write!(&mut buf, "x");\n  return buf;\n}', lang, 'Rust', ['function_item']);
    expect(cfg.defUse.find(d => d.variable === 'buf' && d.useLine === 4)?.precision).toBe('may');
  });

  it('a Rust local mutably borrowed inside a closure is may, not exact', async () => {
    const lang = await rustLang();
    const cfg = cfgFor('fn f() -> i32 {\n  let mut x = 0;\n  let g = || { h(&mut x); };\n  g();\n  return x;\n}', lang, 'Rust', ['function_item']);
    expect(cfg.defUse.find(d => d.variable === 'x' && d.useLine === 5)?.precision).toBe('may');
  });

  it('JS object-shorthand destructuring reassign inside a closure is may', async () => {
    const lang = await tsLang();
    // `({a, b} = src.next())` inside a stored callback reassigns a,b out of band.
    const cfg = cfgFor('function f(src){\n  let a = 1, b = 2;\n  src.on("x", () => { ({a, b} = src.next()); });\n  return a + b;\n}', lang, 'TypeScript', TS_FN);
    expect(cfg.defUse.find(d => d.variable === 'a' && d.useLine === 4)?.precision).toBe('may');
    expect(cfg.defUse.find(d => d.variable === 'b' && d.useLine === 4)?.precision).toBe('may');
  });
});

// ─── variadic parameter extraction (value-level blast-radius regression) ──────

describe('variadic parameters are extracted', () => {
  it('TS rest parameter (...sources) is a parameter', async () => {
    const lang = await tsLang();
    const cfg = cfgFor('const deepMerge = (...sources) => { return sources; };', lang, 'TypeScript', ['arrow_function']);
    expect(cfg.params).toContain('sources');
    expect(cfg.defUse.some(e => e.variable === 'sources')).toBe(true);
  });

  it('Python *args / **kwargs are parameters', async () => {
    const lang = await pyLang();
    const cfg = cfgFor('def f(a, *args, **kwargs):\n    return args', lang, 'Python', PY_FN);
    expect(cfg.params).toEqual(expect.arrayContaining(['a', 'args', 'kwargs']));
    expect(cfg.defUse.some(e => e.variable === 'args')).toBe(true);
  });
});

// ─── per-language coverage ───────────────────────────────────────────────────

describe('multi-language CFG', () => {
  it('Python branch + def-use', async () => {
    const lang = await pyLang();
    const src = `def f(a):\n    x = compute()\n    if a:\n        x = other()\n    return x`;
    const cfg = cfgFor(src, lang, 'Python', PY_FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    expect(hasDefUse(cfg, 'x')).toBe(true);
    expect(cfg.params).toContain('a');
  });

  it('Go branch + loop + def-use', async () => {
    const lang = await goLang();
    const src = `func f(n int) int {\n\tx := 0\n\tfor i := 0; i < n; i++ {\n\t\tx = x + i\n\t}\n\treturn x\n}`;
    const cfg = cfgFor(src, lang, 'Go', GO_FN);
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);
    expect(hasDefUse(cfg, 'x')).toBe(true);
    expect(cfg.params).toContain('n');
  });
});

// ─── extended-language coverage (Java, C++, Rust, Ruby) ───────────────────────

describe('Java overlay', () => {
  const FN = ['method_declaration'];
  it('branch + loop + switch, with sound switch (cases do not kill each other)', async () => {
    const lang = await javaLang();
    const cfg = cfgFor('class C{ int f(int a){\n  int x = 0;\n  if(a>0){ x=1; } else { x=2; }\n  for(int i=0;i<a;i++){ x = x + i; }\n  switch(a){\n    case 1: x = 10; break;\n    default: x = 20;\n  }\n  return x;\n} }', lang, 'Java', FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);
    // both switch arms (line 6 case, line 7 default) reach the return — not killed.
    expect(defLinesTo(cfg, 'x', 9)).toEqual([6, 7]);
  });
  it('field/array writes are may', async () => {
    const lang = await javaLang();
    const cfg = cfgFor('class C{ void f(O o, int[] arr, int i){\n  o.field = c();\n  int y = o.field;\n  arr[i] = 5;\n} }', lang, 'Java', FN);
    expect(cfg.defUse.some(e => e.variable === 'o.field' && e.precision === 'may')).toBe(true);
  });
});

describe('C++ overlay', () => {
  const FN = ['function_definition'];
  it('branch + loop + do/while + switch', async () => {
    const lang = await cppLang();
    const cfg = cfgFor('int f(int a){\n  int x = 0;\n  if(a>0){ x=1; } else { x=2; }\n  while(a>0){ x = x + a; a--; }\n  switch(a){\n    case 1: x = 10; break;\n    default: x = 20;\n  }\n  return x;\n}', lang, 'C++', FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);
    expect(defLinesTo(cfg, 'x', 9)).toEqual([6, 7]); // both switch arms reach
  });
});

describe('Rust overlay', () => {
  const FN = ['function_item'];
  it('branch + loop + match (expression-wrapped control flow)', async () => {
    const lang = await rustLang();
    const cfg = cfgFor('fn f(a: i32) -> i32 {\n  let mut x = 0;\n  if a > 0 {\n    x = 1;\n  } else {\n    x = 2;\n  }\n  while a > 0 {\n    x = x + 1;\n  }\n  return x;\n}', lang, 'Rust', FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);
    expect(defLinesTo(cfg, 'x', 11)).toEqual([4, 6, 9]); // if/else/loop all reach
  });
  it('match arms both reach (sound); closure mutation is may', async () => {
    const lang = await rustLang();
    const m = cfgFor('fn f(a: i32) -> i32 {\n  let mut x = 0;\n  match a {\n    1 => x = 10,\n    _ => x = 20,\n  }\n  return x;\n}', lang, 'Rust', FN);
    expect(defLinesTo(m, 'x', 7)).toEqual([4, 5]);
    const cl = cfgFor('fn f() -> i32 {\n  let mut x = 0;\n  let g = || { x = 5; };\n  g();\n  return x;\n}', lang, 'Rust', FN);
    expect(cl.defUse.find(e => e.variable === 'x' && e.useLine === 5)?.precision).toBe('may');
  });
});

describe('Ruby overlay', () => {
  const FN = ['method'];
  it('if/else + while + case/else (alternative paths, no kill)', async () => {
    const lang = await rubyLang();
    const cfg = cfgFor('def f(a)\n  x = 0\n  if a > 0\n    x = 1\n  else\n    x = 2\n  end\n  case a\n  when 1\n    x = 10\n  else\n    x = 20\n  end\n  return x\nend', lang, 'Ruby', FN);
    expect(cfg.blocks.some(b => b.kind === 'branch')).toBe(true);
    // case/when (10) + case/else (12) reach the return; the if's defs were overwritten.
    expect(defLinesTo(cfg, 'x', 14)).toEqual([10, 12]);
  });

  it('visits method-call receivers and arguments without treating the method name as a variable', async () => {
    const lang = await rubyLang();
    const cfg = cfgFor('def f(a, x)\n  y = a.transform(x)\n  return y\nend', lang, 'Ruby', FN);

    expect(cfg.defUse.some(e => e.variable === 'a' && e.useLine === 2)).toBe(true);
    expect(cfg.defUse.some(e => e.variable === 'x' && e.useLine === 2)).toBe(true);
    expect(cfg.defUse.some(e => e.variable === 'transform')).toBe(false);
    expect(valueReachableLines(cfg, 'x')).toContain(2);
  });

  it('models rescue and ensure bodies without a false exact edge across a rescue kill', async () => {
    const lang = await rubyLang();
    const cfg = cfgFor(
      'def f(a)\n  x = initial(a)\n  begin\n    risky()\n  rescue StandardError\n    x = recovered(a)\n  ensure\n    audit(x)\n  end\n  return x\nend',
      lang, 'Ruby', FN,
    );

    expect(cfg.defUse.some(e => e.variable === 'x' && e.defLine === 6 && e.useLine === 8)).toBe(true);
    expect(cfg.defUse.some(e => e.variable === 'x' && e.defLine === 6 && e.useLine === 10)).toBe(true);
    expect(cfg.defUse).toContainEqual(expect.objectContaining({ variable: 'x', defLine: 2, useLine: 10, precision: 'may' }));
    expect(cfg.defUse.some(e => e.variable === 'x' && e.defLine === 2 && e.useLine === 10 && e.precision === 'exact')).toBe(false);
  });

  it('preserves Ruby getter member paths without treating the method as a scalar', async () => {
    const cfg = cfgFor('def f(a, x)\n  a.status = x\n  return a.status\nend', await rubyLang(), 'Ruby', FN);
    expect(cfg.defUse).toContainEqual(expect.objectContaining({ variable: 'a.status', defLine: 2, useLine: 3, precision: 'may' }));
    expect(cfg.defUse.some(e => e.variable === 'status')).toBe(false);
  });

  it('lets definitions in a protected region reach a Ruby rescue handler', async () => {
    const cfg = cfgFor(
      'def f(a)\n  begin\n    x = prepare(a)\n    risky()\n  rescue StandardError => error\n    report(x, error)\n  end\nend',
      await rubyLang(), 'Ruby', FN,
    );
    expect(cfg.defUse).toContainEqual(expect.objectContaining({ variable: 'x', defLine: 3, useLine: 6 }));
    expect(cfg.defUse).toContainEqual(expect.objectContaining({ variable: 'error', defLine: 5, useLine: 6, precision: 'exact' }));
  });

  it('preserves each straight-line state that can reach a Ruby rescue', async () => {
    const cfg = cfgFor(
      'def f(a)\n  begin\n    x = old(a)\n    x = risky(a)\n  rescue\n    report(x)\n  end\nend',
      await rubyLang(), 'Ruby', FN,
    );
    expect(cfg.defUse.some(e => e.variable === 'x' && e.defLine === 3 && e.useLine === 6)).toBe(true);
    expect(cfg.defUse.some(e => e.variable === 'x' && e.defLine === 4 && e.useLine === 6)).toBe(true);
  });

  it('models method-level Ruby rescue and ensure clauses', async () => {
    const cfg = cfgFor(
      'def f(a)\n  x = prepare(a)\n  risky()\nrescue StandardError\n  x = recover(a)\nensure\n  audit(x)\nend',
      await rubyLang(), 'Ruby', FN,
    );
    expect(cfg.defUse).toContainEqual(expect.objectContaining({ variable: 'x', defLine: 5, useLine: 7 }));
  });

  it('routes a Ruby return through ensure before exiting', async () => {
    const cfg = cfgFor(
      'def f(a)\n  begin\n    x = prepare(a)\n    return x\n  ensure\n    audit(x)\n  end\nend',
      await rubyLang(), 'Ruby', FN,
    );
    expect(cfg.defUse).toContainEqual(expect.objectContaining({ variable: 'x', defLine: 3, useLine: 6 }));
  });

  it('routes break and continue through ensure before their loop targets', async () => {
    const breakCfg = cfgFor(
      'def f(flag)\n  while flag\n    begin\n      x = value(flag)\n      break\n    ensure\n      audit(x)\n    end\n  end\nend',
      await rubyLang(), 'Ruby', FN,
    );
    expect(breakCfg.defUse).toContainEqual(expect.objectContaining({ variable: 'x', defLine: 4, useLine: 7 }));
    const continueCfg = cfgFor(
      'def f(flag)\n  while flag\n    begin\n      x = value(flag)\n      next\n    ensure\n      audit(x)\n    end\n  end\nend',
      await rubyLang(), 'Ruby', FN,
    );
    expect(continueCfg.defUse).toContainEqual(expect.objectContaining({ variable: 'x', defLine: 4, useLine: 7 }));
  });
});

describe('destructured parameter bindings', () => {
  it('seeds value reachability from TypeScript object-pattern parameters', async () => {
    const cfg = cfgFor(
      'function handler({ req, res }: any, plain: string) {\n  const value = normalize(req);\n  res.send(value);\n  return plain;\n}',
      await tsLang(), 'TypeScript', TS_FN,
    );

    expect(cfg.params).toEqual(expect.arrayContaining(['req', 'res', 'plain']));
    expect(valueReachableLines(cfg, 'req')).toContain(2);
    expect(valueReachableLines(cfg, 'res')).toContain(3);
  });

  it('extracts JavaScript object-pattern parameters', async () => {
    const cfg = cfgFor(
      'function handler({ req, res }, plain) {\n  res.send(req);\n  return plain;\n}',
      await tsLang(), 'JavaScript', TS_FN,
    );

    expect(cfg.params).toEqual(expect.arrayContaining(['req', 'res', 'plain']));
    expect(valueReachableLines(cfg, 'req')).toContain(2);
  });

  it('keeps destructured parameters out of the nested closure capture set', async () => {
    const cfg = cfgFor(
      'function handler({ req }: any) {\n  const callback = () => consume(req);\n  return callback;\n}',
      await tsLang(), 'TypeScript', TS_FN,
    );

    expect(cfg.params).toContain('req');
    expect(cfg.defUse).toContainEqual(expect.objectContaining({ variable: 'req', defLine: 1, useLine: 2, precision: 'may' }));
  });

  it('does not treat destructuring default expressions as parameter bindings', async () => {
    const cfg = cfgFor(
      'function handler({ req = fallback }, [res = other]: any) {\n  return req + res;\n}',
      await tsLang(), 'TypeScript', TS_FN,
    );

    expect(cfg.params).toEqual(['req', 'res']);
  });

  it('does not treat an outer parameter default as a binding', async () => {
    const cfg = cfgFor(
      'function handler({ req }: any = fallback) {\n  return req;\n}',
      await tsLang(), 'TypeScript', TS_FN,
    );
    expect(cfg.params).toEqual(['req']);
  });
});

// ─── extended-language adversarial fixes (real-repo agent findings) ───────────

describe('extended-language soundness fixes', () => {
  it('Java arrow switch (case N -> {}) is modeled (no leaked pre-switch def)', async () => {
    const lang = await javaLang();
    const cfg = cfgFor('class C{ int f(int k){\n  int x = 0;\n  switch(k){\n    case 1 -> { x = 10; }\n    default -> { x = -1; }\n  }\n  return x;\n} }', lang, 'Java', ['method_declaration']);
    expect(defLinesTo(cfg, 'x', 7)).toEqual([4, 5]); // both arms; x=0 (line 2) does not leak
  });

  it('Java enhanced-for binds the loop variable', async () => {
    const lang = await javaLang();
    const cfg = cfgFor('class C{ int f(int[] xs){\n  int s = 0;\n  for(int v : xs){\n    s = s + v;\n  }\n  return s;\n} }', lang, 'Java', ['method_declaration']);
    expect(cfg.defUse.some(e => e.variable === 'v')).toBe(true);
  });

  it('C++ extracts parameters (nested under function_declarator)', async () => {
    const lang = await cppLang();
    const cfg = cfgFor('int f(int a, int b){\n  return a + b;\n}', lang, 'C++', ['function_definition']);
    expect(cfg.params).toEqual(['a', 'b']);
    expect(cfg.defUse.some(e => e.variable === 'a' && e.useLine === 2)).toBe(true);
  });

  it('C++ reference alias and address-of downgrade the referent to may', async () => {
    const lang = await cppLang();
    const ref = cfgFor('int f(){\n  int x = 1;\n  int& r = x;\n  r = 5;\n  return x;\n}', lang, 'C++', ['function_definition']);
    expect(ref.defUse.find(e => e.variable === 'x' && e.useLine === 5)?.precision).toBe('may');
    const ptr = cfgFor('int f(){\n  int x = 1;\n  int* p = &x;\n  *p = 5;\n  return x;\n}', lang, 'C++', ['function_definition']);
    expect(ptr.defUse.find(e => e.variable === 'x' && e.useLine === 5)?.precision).toBe('may');
  });

  it('Ruby statement modifier (x = 2 if c) is conditional, not a strong kill', async () => {
    const lang = await rubyLang();
    const cfg = cfgFor('def f(a)\n  x = 1\n  x = 2 if a\n  return x\nend', lang, 'Ruby', ['method']);
    expect(defLinesTo(cfg, 'x', 4)).toEqual([2, 3]); // both the original and the conditional def reach
  });
});

// ─── spec-08 native languages (C, C#, PHP) ────────────────────────────────────

async function cLang(): Promise<object> { return (await import('tree-sitter-c')).default as object; }
async function csharpLang(): Promise<object> { return (await import('tree-sitter-c-sharp')).default as object; }
async function phpLang(): Promise<object> { const m: any = await import('tree-sitter-php'); return m.default.php as object; }

describe('C overlay (via C++ spec)', () => {
  it('branch + loop + switch (sound), params extracted', async () => {
    const lang = await cLang();
    const cfg = cfgFor('int f(int a){\n  int x = 0;\n  if(a>0){ x=1; } else { x=2; }\n  while(a>0){ x = x + a; a--; }\n  switch(a){\n    case 1: x = 10; break;\n    default: x = 20;\n  }\n  return x;\n}', lang, 'C', ['function_definition']);
    expect(cfg.params).toEqual(['a']);
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);
    expect(defLinesTo(cfg, 'x', 9)).toEqual([6, 7]); // both switch arms reach
  });

  it('write through a pointer (`*p = x`) is not an exact reassignment of `p`', async () => {
    const lang = await cLang();
    // `ns = base` (L2), `*ns = 0` (L3) writes the pointee not the binding, `return ns` (L4).
    // The real def of `ns` is L2; `*ns = 0` must NOT kill it or claim provenance.
    const cfg = cfgFor('char* f(char* base){\n  char* ns = base;\n  *ns = 0;\n  return ns;\n}', lang, 'C', ['function_definition']);
    const nsAtReturn = cfg.defUse.filter(e => e.variable === 'ns' && e.useLine === 4);
    expect(nsAtReturn.map(e => e.defLine)).toEqual([2]); // provenance is the real def, not L3
    expect(nsAtReturn.every(e => e.precision === 'exact')).toBe(true);
    // `*ns = 0` writes the pointee, so it must never appear as a def of `ns` itself
    expect(cfg.defUse.some(e => e.variable === 'ns' && e.defLine === 3)).toBe(false);
  });
});

describe('C# overlay', () => {
  it('branch + loop + switch_section (sound)', async () => {
    const lang = await csharpLang();
    const cfg = cfgFor('class C{ int f(int a){\n  int x = 0;\n  if(a>0){ x=1; } else { x=2; }\n  while(a>0){ x = x + a; a--; }\n  switch(a){\n    case 1: x = 10; break;\n    default: x = 20;\n  }\n  return x;\n} }', lang, 'C#', ['method_declaration']);
    expect(cfg.params).toEqual(['a']);
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);
    expect(defLinesTo(cfg, 'x', 9)).toEqual([6, 7]);
  });
});

describe('PHP overlay', () => {
  it('branch + loop + switch (sound), $-params extracted', async () => {
    const lang = await phpLang();
    const cfg = cfgFor('<?php function f($a){\n  $x = 0;\n  if($a > 0){ $x = 1; } else { $x = 2; }\n  while($a > 0){ $x = $x + $a; }\n  switch($a){\n    case 1: $x = 10; break;\n    default: $x = 20;\n  }\n  return $x;\n}', lang, 'PHP', ['function_definition']);
    expect(cfg.params).toEqual(['$a']);
    expect(cfg.edges.some(e => e.kind === 'back')).toBe(true);
    expect(defLinesTo(cfg, '$x', 9)).toEqual([6, 7]);
  });
});

// ─── escape detection for PHP/C# indirection (real-repo agent findings) ───────

describe('PHP/C# indirection escapes (no unsound exact)', () => {
  it('PHP anonymous closure does not leak its body into the enclosing scope', async () => {
    const lang = await phpLang();
    const cfg = cfgFor('<?php function f(){\n  $x = 1;\n  $c = function(){ $x = 99; };\n  return $x;\n}', lang, 'PHP', ['function_definition']);
    expect(defLinesTo(cfg, '$x', 4)).toEqual([2]); // closure's $x=99 must not reach the return
  });

  it('PHP by-ref capture and reference assignment downgrade to may', async () => {
    const lang = await phpLang();
    const cap = cfgFor('<?php function f(){\n  $x = 1;\n  $c = function() use (&$x){ $x = 99; };\n  $c();\n  return $x;\n}', lang, 'PHP', ['function_definition']);
    expect(cap.defUse.find(e => e.variable === '$x' && e.useLine === 5)?.precision).toBe('may');
    const ref = cfgFor('<?php function f(){\n  $x = 1;\n  $r = &$x;\n  $r = 5;\n  return $x;\n}', lang, 'PHP', ['function_definition']);
    expect(ref.defUse.find(e => e.variable === '$x' && e.useLine === 5)?.precision).toBe('may');
  });

  it('C# ref/out arguments downgrade the variable to may', async () => {
    const lang = await csharpLang();
    const r = cfgFor('class C{ int f(){\n  int x = 1;\n  Mutate(ref x);\n  return x;\n} }', lang, 'C#', ['method_declaration']);
    expect(r.defUse.find(e => e.variable === 'x' && e.useLine === 4)?.precision).toBe('may');
    const o = cfgFor('class C{ int f(){\n  int x;\n  TryGet(out x);\n  return x;\n} }', lang, 'C#', ['method_declaration']);
    expect(o.defUse.find(e => e.variable === 'x' && e.useLine === 4)?.precision).toBe('may');
  });

  it('PHP by-ref closure with a SUBSCRIPT write (use (&$x){ $x[]=… }) is may', async () => {
    const lang = await phpLang();
    // Real-world Guzzle pattern: $called[]=… inside a by-ref closure mutates the
    // outer $called out of band. addLeftIdents skips subscript writes, so only the
    // by-ref capture itself can mark $called as escaped.
    const cfg = cfgFor('<?php function f(){\n  $called = [];\n  $c = function() use (&$called){ $called[] = 1; };\n  $c();\n  return $called;\n}', lang, 'PHP', ['function_definition']);
    expect(cfg.defUse.find(e => e.variable === '$called' && e.useLine === 5)?.precision).toBe('may');
  });

  it('PHP foreach by-ref loop variable (as &$v) is may', async () => {
    const lang = await phpLang();
    const cfg = cfgFor('<?php function f($a){\n  $v = 0;\n  foreach($a as &$v){ $v = $v * 2; }\n  return $v;\n}', lang, 'PHP', ['function_definition']);
    expect(cfg.defUse.find(e => e.variable === '$v' && e.useLine === 4)?.precision).toBe('may');
  });

  it('C# ref local (ref int r = ref e) downgrades the referent to may', async () => {
    const lang = await csharpLang();
    const cfg = cfgFor('class C{ int f(){\n  int e = 0;\n  ref int r = ref e;\n  r = 9;\n  return e;\n} }', lang, 'C#', ['method_declaration']);
    expect(cfg.defUse.find(e => e.variable === 'e' && e.useLine === 5)?.precision).toBe('may');
  });
});

// ─── language contract guard (CI-protected: lock the supported/fail-soft set) ──

describe('language contract: supported set + fail-soft for everything else', () => {
  // Every code language OpenLore detects (signature-extractor.ts detectLanguage).
  const OVERLAY_LANGS = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Java', 'C++', 'Rust', 'Ruby', 'C', 'C#', 'PHP'];
  const FAIL_SOFT_LANGS = ['Kotlin', 'Swift', 'Scala', 'Dart', 'Lua', 'Elixir', 'Bash',
    'Terraform', 'Kubernetes', 'Helm', 'CloudFormation', 'Ansible', 'Dockerfile', 'Docker Compose',
    'GitHub Actions', 'unknown', 'COBOL'];

  it('cfgSupportsLanguage matches the documented overlay set exactly', () => {
    for (const l of OVERLAY_LANGS) expect(cfgSupportsLanguage(l), `${l} should be supported`).toBe(true);
    for (const l of FAIL_SOFT_LANGS) expect(cfgSupportsLanguage(l), `${l} should NOT be supported`).toBe(false);
  });

  it('buildFunctionCfg returns undefined (never throws) for every unsupported language', async () => {
    // Use a real TS function node; the language string is what gates support.
    const tree = parse('function f(){ let x = 1; return x; }', await tsLang());
    const fn = firstOfType(tree.rootNode, TS_FN)!;
    for (const l of FAIL_SOFT_LANGS) {
      expect(() => buildFunctionCfg(fn as unknown as CfgNode, l), `${l} must not throw`).not.toThrow();
      expect(buildFunctionCfg(fn as unknown as CfgNode, l), `${l} must yield no overlay`).toBeUndefined();
    }
  });
});
