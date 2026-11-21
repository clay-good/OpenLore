import { describe, expect, it } from 'vitest';
import { classifyTestSource, linkedTestFiles, MAX_PARSE_BYTES_PER_ANSWER, newEvidenceCache, strongerClass, type CaseEvidence } from './test-evidence.js';
import type { SerializedCallGraph } from './call-graph.js';

const byTest = (cases: CaseEvidence[]): Record<string, string> => Object.fromEntries(cases.map(c => [c.test, c.class]));

const ADD = { name: 'add', filePath: 'src/math.ts' };

describe('classifyTestSource — Vitest/Jest (TypeScript)', () => {
  const src = `
import { add, log, makeTotal } from './math';

function total(a: number, b: number) { return add(a, b); }
function logAll() { add(1, 2); }
function expectPositive(n: number) { expect(n).toBeGreaterThan(0); }

describe('math', () => {
  it('direct return', () => {
    const r = add(1, 2);
    expect(r).toBe(3);
  });
  it('inline argument', () => {
    expect(add(1, 2)).toBe(3);
  });
  it('chained through a variable', () => {
    const r = add(1, 2);
    const doubled = r * 2;
    expect(doubled).toBe(6);
  });
  it('value helper', () => {
    expect(total(1, 2)).toBe(3);
  });
  it('assertion helper', () => {
    expectPositive(add(1, 2));
  });
  it('stopped helper', () => {
    logAll();
    expect(true).toBe(true);
  });
  it('side effect only', () => {
    add(1, 2);
    expect(log.length).toBe(0);
  });
  it('unrecognized assertions', () => {
    const r = add(1, 2);
    should(r).equal(3);
  });
  it('throws', () => {
    expect(() => add(Number.NaN, 1)).toThrow();
  });
  it('does not call it', () => {
    expect(makeTotal()).toBe(1);
  });
});
`;

  it('classes each case by what its assertions consume', async () => {
    const { parsed, cases } = await classifyTestSource('TypeScript', 'src/math.test.ts', src, ADD);
    expect(parsed).toBe(true);
    expect(byTest(cases)).toEqual({
      'math > direct return': 'asserts-on',
      'math > inline argument': 'asserts-on',
      'math > chained through a variable': 'asserts-on',
      'math > value helper': 'asserts-on',
      'math > assertion helper': 'asserts-on',
      'math > stopped helper': 'exercises',
      'math > side effect only': 'exercises',
      'math > unrecognized assertions': 'reaches',
      'math > throws': 'asserts-on',
    });
  });

  it('cites the assertion line, and says why a weaker class was given', async () => {
    const { cases } = await classifyTestSource('TypeScript', 'src/math.test.ts', src, ADD);
    const direct = cases.find(c => c.test === 'math > direct return')!;
    expect(direct.line).toBe(src.split('\n').findIndex(l => l.includes('expect(r).toBe(3)')) + 1);
    expect(cases.find(c => c.test === 'math > stopped helper')!.reason).toMatch(/helper logAll/);
    const unrecognized = cases.find(c => c.test === 'math > unrecognized assertions')!;
    expect(unrecognized.recognized).toBe(false);
    expect(unrecognized.reason).toMatch(/assertion form this analysis does not recognize/);
  });

  it('recognizes Node assert, and a call through a namespace imported from the symbol\'s module', async () => {
    const { cases } = await classifyTestSource('JavaScript', 'src/m.test.js', `
const assert = require('node:assert');
const calc = require('./math.js');
test('node assert', () => { assert.strictEqual(calc.add(1, 2), 3); });
`, ADD);
    expect(byTest(cases)).toEqual({ 'node assert': 'asserts-on' });
    const ctor = await classifyTestSource('JavaScript', 'src/m.test.js', `
const assert = require('node:assert');
const { Counter } = require('./counter.js');
test('constructor', () => { const c = new Counter(); assert.ok(c); });
`, { name: 'Counter', filePath: 'src/counter.js' });
    expect(byTest(ctor.cases)).toEqual({ constructor: 'asserts-on' });
  });

  it('a same-named method on another object is not a call to the symbol', async () => {
    const src = `
import { Graph } from './graph';
const seen = new Map();
it('map delete', () => { expect(seen.delete('k')).toBe(false); });
it('other module', () => { expect(util.delete('k')).toBe(true); });
`;
    // A module function \`delete\`: neither receiver is a namespace of its module.
    expect((await classifyTestSource('TypeScript', 'g.test.ts', src, { name: 'delete', filePath: 'src/store.ts' })).cases).toEqual([]);
    // A method \`Store.delete\`: the file never names Store.
    expect((await classifyTestSource('TypeScript', 'g.test.ts', src, { name: 'delete', filePath: 'src/store.ts', className: 'Store' })).cases).toEqual([]);
    // A method \`Graph.delete\`: naming Graph is not enough; the receiver must be a Graph.
    expect((await classifyTestSource('TypeScript', 'g.test.ts', src, { name: 'delete', filePath: 'src/graph.ts', className: 'Graph' })).cases).toEqual([]);
    const withInstance = `${src}it('graph', () => { const g = new Graph(); expect(g.delete('k')).toBe(true); });\n`;
    expect(byTest((await classifyTestSource('TypeScript', 'g.test.ts', withInstance, { name: 'delete', filePath: 'src/graph.ts', className: 'Graph' })).cases))
      .toEqual({ graph: 'asserts-on' });
  });
});

describe('classifyTestSource — guards', () => {
  it('an assertion call is never a call to a production symbol of the same name', async () => {
    const src = `import { expect as e, ok } from './parser';\nit('x', () => { expect(parse('a')).toBe(1); assert.ok(true); });\n`;
    expect((await classifyTestSource('TypeScript', 'p.test.ts', src, { name: 'expect', filePath: 'src/parser.ts' })).cases).toEqual([]);
    expect((await classifyTestSource('TypeScript', 'p.test.ts', src, { name: 'ok', filePath: 'src/parser.ts' })).cases).toEqual([]);
  });

  it('a file past the answer\'s parse budget is not parsed, so not classed', async () => {
    const cache = newEvidenceCache();
    cache.parsedBytes = MAX_PARSE_BYTES_PER_ANSWER;
    expect(await classifyTestSource('TypeScript', 'src/big.test.ts', `import { add } from './math';\nit('x', () => { expect(add(1, 2)).toBe(3); });`, ADD, cache))
      .toEqual({ parsed: false, cases: [] });
  });
});

describe('classifyTestSource — pytest (Python)', () => {
  const src = `
from shop import price

def _total(n):
    return price(n) * 2

def test_direct():
    r = price(3)
    assert r == 9

def test_raises():
    with pytest.raises(ValueError):
        price(-1)

def test_helper():
    assert _total(1) == 6

def test_called_only():
    price(1)
    assert True

class TestCart:
    def test_method(self):
        self.assertEqual(price(2), 6)
`;

  it('classes pytest and unittest forms', async () => {
    const { cases } = await classifyTestSource('Python', 'test_shop.py', src, { name: 'price', filePath: 'shop.py' });
    expect(byTest(cases)).toEqual({
      test_direct: 'asserts-on',
      test_raises: 'asserts-on',
      test_helper: 'asserts-on',
      test_called_only: 'exercises',
      'TestCart.test_method': 'asserts-on',
    });
  });
});

describe('classifyTestSource — Go testing and testify', () => {
  const src = `package shop

import (
  "testing"
  "github.com/stretchr/testify/assert"
)

func TestPriceIf(t *testing.T) {
  got := Price(3)
  if got != 9 {
    t.Errorf("got %d", got)
  }
}

func TestPriceInit(t *testing.T) {
  if got := Price(3); got != 9 {
    t.Fatal("bad")
  }
}

func TestPriceTestify(t *testing.T) {
  assert.Equal(t, 9, Price(3))
}

func TestPriceCalled(t *testing.T) {
  Price(1)
  assert.True(t, true)
}
`;

  it('classes an if-guarded t.Error, an initializer, and testify', async () => {
    const { cases } = await classifyTestSource('Go', 'shop/shop_test.go', src, { name: 'Price', filePath: 'shop/shop.go' });
    expect(byTest(cases)).toEqual({
      TestPriceIf: 'asserts-on',
      TestPriceInit: 'asserts-on',
      TestPriceTestify: 'asserts-on',
      TestPriceCalled: 'exercises',
    });
  });
});

describe('classifyTestSource — unsupported languages', () => {
  it('reports an unsupported language as not parsed, never as a class', async () => {
    expect(await classifyTestSource('Java', 'ATest.java', 'class ATest {}', ADD)).toEqual({ parsed: false, cases: [] });
  });
});

describe('strongerClass', () => {
  it('orders asserts-on > exercises > reaches, with null weakest', () => {
    expect(strongerClass('reaches', 'asserts-on')).toBe('asserts-on');
    expect(strongerClass('exercises', 'reaches')).toBe('exercises');
    expect(strongerClass(null, 'reaches')).toBe('reaches');
    expect(strongerClass(null, null)).toBeNull();
  });
});

describe('linkedTestFiles', () => {
  const node = (id: string, filePath: string, isTest = false) => ({ id, name: id.split('::')[1], filePath, isTest, language: 'TypeScript' });
  const cg = {
    nodes: [
      node('src/a.ts::add', 'src/a.ts'),
      node('src/b.ts::total', 'src/b.ts'),
      node('src/a.test.ts::helper', 'src/a.test.ts', true),
    ],
    edges: [
      { callerId: 'src/a.ts::add', calleeId: 'src/a.test.ts::*', calleeName: 'a.test', kind: 'tested_by' },
      { callerId: 'src/b.ts::total', calleeId: 'src/a.ts::add', calleeName: 'add' },
      { callerId: 'src/b.ts::total', calleeId: 'src/b.test.ts::*', calleeName: 'b.test', kind: 'tested_by' },
    ],
  } as unknown as SerializedCallGraph;

  it('separates files that reference the symbol from files that only reach it', () => {
    expect(linkedTestFiles(cg, 'src/a.ts::add')).toEqual({ direct: ['src/a.test.ts'], reach: ['src/b.test.ts'], truncated: false });
  });
});

// Adversarial review of PR #799: each shape once gave a false `asserts-on`.
describe('classifyTestSource — never a false asserts-on', () => {
  const cls = async (language: string, path: string, src: string, symbol: { name: string; filePath: string; className?: string }) =>
    byTest((await classifyTestSource(language, path, src, symbol)).cases);

  it('a class named in the file does not make another object\'s method its own', async () => {
    const src = `import { Cache } from './cache';\nit('m', () => { const m = new Map(); expect(m.get('k')).toBe(1); });\n// Cache\n`;
    expect(await cls('TypeScript', 'src/c.test.ts', src, { name: 'get', filePath: 'src/cache.ts', className: 'Cache' })).toEqual({});
  });

  it('a local binding shadows the symbol, in JS, Python and Go', async () => {
    expect(await cls('TypeScript', 'src/a.test.ts', `import { add } from './math';\nit('x', () => { const add = () => 1; expect(add()).toBe(1); });`, ADD)).toEqual({});
    expect(await cls('Python', 'test_a.py', `from a import add\ndef test_x():\n    add = lambda: 1\n    assert add() == 1\n`, { name: 'add', filePath: 'a.py' })).toEqual({});
    expect(await cls('Go', 'a/a_test.go', `package a\nfunc TestX(t *testing.T) {\n  Sym := func() int { return 1 }\n  if Sym() != 1 { t.Fatal("x") }\n}\n`, { name: 'Sym', filePath: 'a/a.go' })).toEqual({});
  });

  it('a module receiver must resolve to the symbol\'s own file, never a package of the same stem', async () => {
    expect(await cls('TypeScript', 'src/p.test.ts', `import path from 'path';\nit('x', () => { expect(path.join('a', 'b')).toBe('a/b'); });`, { name: 'join', filePath: 'src/path.ts' })).toEqual({});
    expect(await cls('TypeScript', 'src/p.test.ts', `import * as utils from 'lodash/utils';\nit('x', () => { expect(utils.get(1)).toBe(1); });`, { name: 'get', filePath: 'src/utils.ts' })).toEqual({});
    expect(await cls('Python', 'tests/test_m.py', `import math as m\ndef test_x():\n    assert m.floor(1.5) == 1\n`, { name: 'floor', filePath: 'src/math.py' })).toEqual({});
    expect(await cls('Go', 'x/s_test.go', `package x\nimport "strings"\nfunc TestX(t *testing.T) {\n  if !strings.Contains("ab", "a") { t.Fatal("x") }\n}\n`, { name: 'Contains', filePath: 'internal/strings/s.go' })).toEqual({});
    // The real module, by a relative path, still counts.
    expect(await cls('TypeScript', 'src/p.test.ts', `import * as p from './path.js';\nit('x', () => { expect(p.join('a', 'b')).toBe('a/b'); });`, { name: 'join', filePath: 'src/path.ts' })).toEqual({ x: 'asserts-on' });
  });

  it('only the variable the call is bound to is tainted, not its neighbours on the line', async () => {
    expect(await cls('TypeScript', 'src/a.test.ts', `import { add } from './math';\nit('x', () => { const r = add(1, 2), other = 7; expect(other).toBe(7); });`, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('Python', 'test_a.py', `from a import add\ndef test_x():\n    r, other = add(1), 7\n    assert other == 7\n`, { name: 'add', filePath: 'a.py' })).toEqual({ test_x: 'exercises' });
    expect(await cls('Go', 'a/a_test.go', `package a\nfunc TestX(t *testing.T) {\n  got, want := Sym(), 3\n  _ = got\n  if want != 3 { t.Fatal("x") }\n}\n`, { name: 'Sym', filePath: 'a/a.go' })).toEqual({ TestX: 'exercises' });
    expect(await cls('TypeScript', 'src/a.test.ts', `import { add } from './math';\nit('x', () => { let r = add(); r = 5; expect(r).toBe(5); });`, ADD)).toEqual({ x: 'exercises' });
  });

  it('a message argument is not an asserted value', async () => {
    expect(await cls('JavaScript', 'src/a.test.js', `const { add } = require('./math');\ntest('x', () => { assert.ok(true, String(add())); assert.equal(1, 1, \`\${add()}\`); });`, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('TypeScript', 'src/a.test.ts', `import { add } from './math';\nit('x', () => { expect(1, String(add())).toBe(1); });`, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('Python', 'test_a.py', `from a import add\nclass T:\n    def test_x(self):\n        self.assertEqual(1, 1, str(add(1)))\n        self.assertEqual(1, 1, msg=str(add(1)))\n`, { name: 'add', filePath: 'a.py' })).toEqual({ 'T.test_x': 'exercises' });
  });

  it('a Go failure counts only on the test\'s own *testing.T', async () => {
    const src = `package a\nfunc TestX(t *testing.T) {\n  v := Sym()\n  if v == nil { _ = fmt.Errorf("skip"); log.Fatal("x") }\n  t.Log("ok")\n}\n`;
    expect(await cls('Go', 'a/a_test.go', src, { name: 'Sym', filePath: 'a/a.go' })).toEqual({ TestX: 'reaches' });
  });

  it('a mocked symbol is at most exercised: the assertion consumes the mock', async () => {
    const src = `import { add } from './math';\nvi.mock('./math', () => ({ add: vi.fn(() => 99) }));\nit('x', () => { expect(add()).toBe(99); });\n`;
    expect(await cls('TypeScript', 'src/m.test.ts', src, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('Python', 'test_a.py', `from shop import price\n@patch("shop.price")\ndef test_x(p):\n    assert price(1) == 2\n`, { name: 'price', filePath: 'shop.py' })).toEqual({ test_x: 'exercises' });
  });

  it('only the last statement of a pytest.raises block is asserted on', async () => {
    const src = `from a import add\ndef test_x():\n    with pytest.raises(ValueError):\n        v = add(1)\n        parse("bad")\n`;
    expect(await cls('Python', 'test_a.py', src, { name: 'add', filePath: 'a.py' })).toEqual({ test_x: 'exercises' });
  });

  it('testify assert.New receivers are recognized; an unknown assertion-like call is a gap, not exercises', async () => {
    expect(await cls('Go', 'a/a_test.go', `package a\nfunc TestX(t *testing.T) {\n  a := assert.New(t)\n  a.Equal(3, Sym())\n}\n`, { name: 'Sym', filePath: 'a/a.go' })).toEqual({ TestX: 'asserts-on' });
    const suite = await classifyTestSource('Go', 'a/a_test.go', `package a\nfunc TestX(t *testing.T) {\n  assert.True(t, true)\n  s.Equal(3, Sym())\n}\n`, { name: 'Sym', filePath: 'a/a.go' });
    expect(suite.cases.map(c => [c.class, c.recognized])).toEqual([['reaches', false]]);
  });

  it('a test that calls the symbol and asserts nothing, in a recognized file, is exercises', async () => {
    const src = `import { add } from './math';\nit('a', () => { expect(1).toBe(1); });\nit('b', () => { add(1, 2); });\n`;
    expect(await cls('TypeScript', 'src/a.test.ts', src, ADD)).toEqual({ b: 'exercises' });
  });
});

// Adversarial review round 2 of PR #799: each shape once gave a false `asserts-on`.
describe('classifyTestSource — never a false asserts-on (round 2)', () => {
  const cls = async (language: string, path: string, src: string, symbol: { name: string; filePath: string; className?: string }) =>
    byTest((await classifyTestSource(language, path, src, symbol)).cases);
  const IMPORT = `import { add } from './math';\n`;

  it('a helper nested in one test is never resolved by name from another', async () => {
    const src = `${IMPORT}it('a', () => { const run = () => add(1); expect(run()).toBe(2); });\nit('b', () => { const run = () => 5; expect(run()).toBe(5); });\n`;
    expect((await cls('TypeScript', 'src/a.test.ts', src, ADD)).b).toBeUndefined();
    const py = `from a import add\ndef test_a():\n    def run():\n        return add(1)\n    assert run() == 2\ndef test_b():\n    def run():\n        return 5\n    assert run() == 5\n`;
    expect((await cls('Python', 'test_a.py', py, { name: 'add', filePath: 'a.py' })).test_b).toBeUndefined();
  });

  it('an instance name bound in one test, or reassigned, is not proof in another', async () => {
    const calc = { name: 'add', filePath: 'src/calc.ts', className: 'Calc' };
    const src = `it('a', () => { const c = new Calc(); c.add(1); });\nit('b', () => { const c = new Other(); expect(c.add(1)).toBe(1); });\nit('c', () => { let c = new Calc(); c = makeOther(); expect(c.add()).toBe(1); });\n`;
    expect(await cls('TypeScript', 'src/c.test.ts', src, calc)).toEqual({ a: 'exercises' });
  });

  it('a bare call never matches a method, and must be imported from the symbol\'s module', async () => {
    expect(await cls('TypeScript', 'src/c.test.ts', `import { add } from './math';\nit('x', () => { expect(add(1, 2)).toBe(3); });`, { name: 'add', filePath: 'src/calc.ts', className: 'Calc' })).toEqual({});
    expect(await cls('TypeScript', 'src/a.test.ts', `import { sum as add } from './other';\nit('x', () => { expect(add(1)).toBe(1); });`, ADD)).toEqual({});
    expect(await cls('TypeScript', 'src/u.test.ts', `import { format } from 'date-fns';\nit('x', () => { expect(format(1)).toBe('1'); });`, { name: 'format', filePath: 'src/util.ts' })).toEqual({});
    expect(await cls('Python', 'test_a.py', `from json import loads\ndef test_x():\n    assert loads('1') == 1\n`, { name: 'loads', filePath: 'a.py' })).toEqual({});
    // An alias of the real import counts.
    expect(await cls('TypeScript', 'src/a.test.ts', `import { add as plus } from './math';\nit('x', () => { expect(plus(1)).toBe(1); });`, ADD)).toEqual({ x: 'asserts-on' });
  });

  it('for-of, catch, with-as, except-as and comprehension bindings shadow the symbol', async () => {
    expect(await cls('TypeScript', 'src/a.test.ts', `${IMPORT}it('x', () => { for (const add of fns) expect(add()).toBe(1); });`, ADD)).toEqual({});
    expect(await cls('TypeScript', 'src/a.test.ts', `${IMPORT}it('x', () => { try { f(); } catch (add) { expect(add()).toBe(1); } });`, ADD)).toEqual({});
    expect(await cls('Python', 'test_a.py', `from a import add\ndef test_x():\n    with ctx() as add:\n        assert add() == 1\n`, { name: 'add', filePath: 'a.py' })).toEqual({});
    expect(await cls('Python', 'test_a.py', `from a import add\ndef test_x():\n    assert all(add() for add in fns)\n`, { name: 'add', filePath: 'a.py' })).toEqual({});
  });

  it('destructuring binds only the paired element, and a line of several definitions does not spread taint', async () => {
    expect(await cls('TypeScript', 'src/a.test.ts', `${IMPORT}it('x', () => { const [r, other] = [add(1), 7]; expect(other).toBe(7); });`, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('TypeScript', 'src/a.test.ts', `${IMPORT}it('x', () => { const { a, b } = { a: add(1), b: 2 }; expect(b).toBe(2); });`, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('TypeScript', 'src/a.test.ts', `${IMPORT}it('x', () => {\n  const r = add(1);\n  const a = r, b = 5;\n  expect(b).toBe(5);\n});`, ADD)).toEqual({ x: 'exercises' });
  });

  it('more mock forms are detected', async () => {
    expect(await cls('TypeScript', 'src/m.test.ts', `${IMPORT}vi.mock('@/math');\nit('x', () => { expect(add()).toBe(9); });`, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('TypeScript', 'src/m.test.ts', `${IMPORT}import * as m from './math';\nsinon.stub(m, 'add').returns(9);\nit('x', () => { expect(add()).toBe(9); });`, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('Python', 'test_a.py', `from a import add\ndef test_x(monkeypatch):\n    monkeypatch.setattr('a.add', lambda: 9)\n    assert add() == 9\n`, { name: 'add', filePath: 'a.py' })).toEqual({ test_x: 'exercises' });
  });

  it('a Go failure inside a nested if or closure does not credit the outer condition', async () => {
    const src = `package a\nfunc TestX(t *testing.T) {\n  if cfg := Sym(); cfg != nil {\n    if Other() != 1 { t.Errorf("x") }\n  }\n}\n`;
    expect((await cls('Go', 'a/a_test.go', src, { name: 'Sym', filePath: 'a/a.go' })).TestX).not.toBe('asserts-on');
  });

  it('message, logger, options and mock-call arguments are not asserted values', async () => {
    expect(await cls('JavaScript', 'src/a.test.js', `const { add } = require('./math');\ntest('x', () => { assert.fail(add(1)); });`, ADD)).not.toEqual({ x: 'asserts-on' });
    expect(await cls('TypeScript', 'src/a.test.ts', `${IMPORT}it('x', () => { expect(spy).toHaveBeenCalledWith(add(1)); });`, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('Python', 'test_a.py', `from a import add\nclass T:\n    def test_x(self):\n        m.assert_called_with(add(1))\n        assert True\n`, { name: 'add', filePath: 'a.py' })).toEqual({ 'T.test_x': 'exercises' });
  });

  it('an assertion in a callback that may never run does not count; a raises block counts only the outermost call', async () => {
    expect(await cls('TypeScript', 'src/a.test.ts', `${IMPORT}it('x', () => { setTimeout(() => expect(add()).toBe(1)); expect(true).toBe(true); });`, ADD)).toEqual({ x: 'exercises' });
    expect(await cls('Python', 'test_a.py', `from a import add\ndef test_x():\n    with pytest.raises(E):\n        parse(add(1))\n    assert True\n`, { name: 'add', filePath: 'a.py' })).toEqual({ test_x: 'exercises' });
    expect(await cls('TypeScript', 'src/a.test.ts', `${IMPORT}it('x', () => { expect(() => parse(add(1))).toThrow(); });`, ADD)).toEqual({ x: 'exercises' });
    // The symbol itself raising still counts.
    expect(await cls('TypeScript', 'src/a.test.ts', `${IMPORT}it('x', () => { expect(() => add(NaN)).toThrow(); });`, ADD)).toEqual({ x: 'asserts-on' });
  });

  it('a file of many cases classifies in time linear in its size', async () => {
    const cases = (n: number) => IMPORT + Array.from({ length: n }, (_, i) => `it('c${i}', () => { expect(add(${i})).toBe(${i}); });`).join('\n');
    const t1 = performance.now(); await classifyTestSource('TypeScript', 'src/big1.test.ts', cases(500), ADD); const small = performance.now() - t1;
    const t2 = performance.now(); await classifyTestSource('TypeScript', 'src/big2.test.ts', cases(2000), ADD); const large = performance.now() - t2;
    // 4× the cases: well under 16× (quadratic) the time.
    expect(large).toBeLessThan(small * 10 + 200);
  });
});
