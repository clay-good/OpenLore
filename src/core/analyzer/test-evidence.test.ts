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
    const { parsed, cases } = await classifyTestSource('TypeScript', 'math.test.ts', src, ADD);
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
    const { cases } = await classifyTestSource('TypeScript', 'math.test.ts', src, ADD);
    const direct = cases.find(c => c.test === 'math > direct return')!;
    expect(direct.line).toBe(src.split('\n').findIndex(l => l.includes('expect(r).toBe(3)')) + 1);
    expect(cases.find(c => c.test === 'math > stopped helper')!.reason).toMatch(/helper logAll/);
    const unrecognized = cases.find(c => c.test === 'math > unrecognized assertions')!;
    expect(unrecognized.recognized).toBe(false);
    expect(unrecognized.reason).toMatch(/no assertion this analysis recognizes/);
  });

  it('recognizes Node assert, and a call through a namespace imported from the symbol\'s module', async () => {
    const { cases } = await classifyTestSource('JavaScript', 'm.test.js', `
const assert = require('node:assert');
const calc = require('./math.js');
test('node assert', () => { assert.strictEqual(calc.add(1, 2), 3); });
`, ADD);
    expect(byTest(cases)).toEqual({ 'node assert': 'asserts-on' });
    const ctor = await classifyTestSource('JavaScript', 'm.test.js', `
const assert = require('node:assert');
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
    // A method \`Graph.delete\`: the file names Graph, so a member call may be its.
    expect((await classifyTestSource('TypeScript', 'g.test.ts', src, { name: 'delete', filePath: 'src/graph.ts', className: 'Graph' })).cases.length).toBe(2);
  });
});

describe('classifyTestSource — guards', () => {
  it('an assertion call is never a call to a production symbol of the same name', async () => {
    const src = `it('x', () => { expect(parse('a')).toBe(1); assert.ok(true); });\n`;
    expect((await classifyTestSource('TypeScript', 'p.test.ts', src, { name: 'expect', filePath: 'src/parser.ts' })).cases).toEqual([]);
    expect((await classifyTestSource('TypeScript', 'p.test.ts', src, { name: 'ok', filePath: 'src/parser.ts' })).cases).toEqual([]);
  });

  it('a file past the answer\'s parse budget is not parsed, so not classed', async () => {
    const cache = newEvidenceCache();
    cache.parsedBytes = MAX_PARSE_BYTES_PER_ANSWER;
    expect(await classifyTestSource('TypeScript', 'big.test.ts', `it('x', () => { expect(add(1, 2)).toBe(3); });`, ADD, cache))
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
    const { cases } = await classifyTestSource('Go', 'shop_test.go', src, { name: 'Price', filePath: 'shop/shop.go' });
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
