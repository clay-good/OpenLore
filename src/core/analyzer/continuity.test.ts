/**
 * Tests for the pure symbol-identity continuity detector.
 * (change: add-symbol-identity-continuity)
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeContinuity,
  renameIdentifier,
  normalizedBodyHash,
  bodyMatchesModuloName,
  type DisappearedSymbol,
  type AppearedSymbol,
} from './continuity.js';
import { hashSpan } from '../decisions/anchor.js';

/** The detector's internal span hash must match the freshness engine's hashSpan. */
function spanHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function gone(p: Partial<DisappearedSymbol> & { nodeId: string; name: string }): DisappearedSymbol {
  return { filePath: 'src/a.ts', ...p };
}

function appeared(p: Partial<AppearedSymbol> & { id: string; name: string; spanText: string }): AppearedSymbol {
  return {
    filePath: 'src/a.ts',
    contentHash: hashSpan(p.spanText),
    normBodyHash: normalizedBodyHash(p.spanText, p.name),
    ...p,
  };
}

/** Build a uniqueness map from a set of appeared symbols (each unique by default). */
function uniq(...syms: AppearedSymbol[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of syms) m.set(s.normBodyHash, (m.get(s.normBodyHash) ?? 0) + 1);
  return m;
}

describe('span hash parity', () => {
  it('the detector spanHash matches decisions/anchor hashSpan', () => {
    expect(spanHash('hello world')).toBe(hashSpan('hello world'));
  });
});

describe('renameIdentifier', () => {
  it('replaces whole-identifier occurrences only', () => {
    expect(renameIdentifier('function computeTax(x){return computeTax(x-1)}', 'computeTax', 'calcTax'))
      .toBe('function calcTax(x){return calcTax(x-1)}');
  });
  it('leaves embedded substrings alone', () => {
    expect(renameIdentifier('computeTaxRate + computeTax', 'computeTax', 'X')).toBe('computeTaxRate + X');
  });
  it('does not split a name adjacent to a Unicode identifier char (C1 regression)', () => {
    // An ASCII-only boundary would wrongly rewrite the `tax` inside `taxé`.
    expect(renameIdentifier('taxé + tax', 'tax', 'X')).toBe('taxé + X');
  });
  it('handles a Unicode symbol name', () => {
    expect(renameIdentifier('function café(x){ return café(x); }', 'café', 'coffee'))
      .toBe('function coffee(x){ return coffee(x); }');
  });
});

describe('bodyMatchesModuloName', () => {
  const oldSpan = 'function computeTax(a){ return a * 0.2; }';
  const oldHash = hashSpan(oldSpan);
  it('matches a body that differs only by the symbol name', () => {
    const newSpan = 'function calculateTax(a){ return a * 0.2; }';
    expect(bodyMatchesModuloName(newSpan, 'calculateTax', 'computeTax', oldHash)).toBe(true);
  });
  it('matches a recursive rename (self-call renamed too)', () => {
    const oldRec = 'function fact(n){ return n<=1?1:n*fact(n-1); }';
    const newRec = 'function factorial(n){ return n<=1?1:n*factorial(n-1); }';
    expect(bodyMatchesModuloName(newRec, 'factorial', 'fact', hashSpan(oldRec))).toBe(true);
  });
  it('rejects a body that differs beyond the name', () => {
    const newSpan = 'function calculateTax(a){ return a * 0.3; }'; // 0.2 -> 0.3
    expect(bodyMatchesModuloName(newSpan, 'calculateTax', 'computeTax', oldHash)).toBe(false);
  });
  it('rejects when the name did not change (that is the exact-body case)', () => {
    expect(bodyMatchesModuloName(oldSpan, 'computeTax', 'computeTax', oldHash)).toBe(false);
  });
  it('rejects when the new span already references the old name (C2 false-carry regression)', () => {
    // Unrelated `b` that CALLS the deleted `a()`; substituting b→a would spuriously
    // reconstruct a's recursive body. The old-name-present guard must reject it.
    const oldRec = 'function a(){ helper(); a(); }';
    const unrelated = 'function b(){ helper(); a(); }';
    expect(bodyMatchesModuloName(unrelated, 'b', 'a', hashSpan(oldRec))).toBe(false);
  });
});

describe('computeContinuity', () => {
  it('matches a pure rename via exact-signature (same body, only the name changed)', () => {
    const oldSpan = 'function computeTax(a){ return a * 0.2; }';
    const newSpan = 'function calculateTax(a){ return a * 0.2; }';
    const d = gone({ nodeId: 'src/a.ts::computeTax', name: 'computeTax', contentHash: hashSpan(oldSpan) });
    const a = appeared({ id: 'src/a.ts::calculateTax', name: 'calculateTax', spanText: newSpan });
    const { pairs, ambiguous } = computeContinuity([d], [a], uniq(a));
    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].basis).toBe('exact-signature');
    expect(pairs[0].reason).toBe('renamed');
    expect(pairs[0].to.name).toBe('calculateTax');
  });

  it('matches a pure move (byte-identical span, new file) via exact-body', () => {
    const span = 'function computeTax(a){ return a * 0.2; }';
    const d = gone({ nodeId: 'src/billing.ts::computeTax', name: 'computeTax', filePath: 'src/billing.ts', contentHash: hashSpan(span) });
    const a = appeared({ id: 'src/tax.ts::computeTax', name: 'computeTax', filePath: 'src/tax.ts', spanText: span });
    const { pairs } = computeContinuity([d], [a], uniq(a));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].basis).toBe('exact-body');
    expect(pairs[0].reason).toBe('moved');
  });

  it('reports renamed-and-moved when both name and file change', () => {
    const oldSpan = 'function computeTax(a){ return a * 0.2; }';
    const newSpan = 'function calcTax(a){ return a * 0.2; }';
    const d = gone({ nodeId: 'src/a.ts::computeTax', name: 'computeTax', filePath: 'src/a.ts', contentHash: hashSpan(oldSpan) });
    const a = appeared({ id: 'src/b.ts::calcTax', name: 'calcTax', filePath: 'src/b.ts', spanText: newSpan });
    const { pairs } = computeContinuity([d], [a], uniq(a));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason).toBe('renamed-and-moved');
  });

  // ── The soundness regression: a DELETED symbol must NOT carry onto an unrelated
  //    newcomer that merely shares a signature shape. (PR #206 adversarial finding) ──
  it('does NOT carry onto an unrelated same-shape newcomer with a different body', () => {
    const oldSpan = 'function isAdmin(u){ return u.role === "admin"; }';
    // checkFlag has the SAME parameter shape but a DIFFERENT body — a real
    // delete-plus-unrelated-add, not a rename.
    const newSpan = 'function checkFlag(u){ return u.enabled === true; }';
    const d = gone({ nodeId: 'src/a.ts::isAdmin', name: 'isAdmin', contentHash: hashSpan(oldSpan) });
    const a = appeared({ id: 'src/b.ts::checkFlag', name: 'checkFlag', filePath: 'src/b.ts', spanText: newSpan });
    const { pairs, ambiguous } = computeContinuity([d], [a], uniq(a));
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(0); // no continuation → stays orphaned, no false disclosure
  });

  it('does NOT carry when an identical-body clone exists elsewhere (normalized body not unique)', () => {
    const oldSpan = 'function isAdmin(u){ return u.role === "admin"; }';
    const newSpan = 'function checkAdmin(u){ return u.role === "admin"; }'; // same body modulo name
    const d = gone({ nodeId: 'src/a.ts::isAdmin', name: 'isAdmin', contentHash: hashSpan(oldSpan) });
    const a = appeared({ id: 'src/b.ts::checkAdmin', name: 'checkAdmin', filePath: 'src/b.ts', spanText: newSpan });
    // A clone of the same normalized body exists somewhere in the new graph → count 2.
    const count = new Map<string, number>([[a.normBodyHash, 2]]);
    const { pairs, ambiguous } = computeContinuity([d], [a], count);
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(0);
  });

  it('declines an ambiguous match (two identical-body-modulo-name candidates) and discloses them', () => {
    const oldSpan = 'function helper(a){ return a + 1; }';
    const s1 = 'function helperA(a){ return a + 1; }';
    const s2 = 'function helperB(a){ return a + 1; }';
    const d = gone({ nodeId: 'src/a.ts::helper', name: 'helper', contentHash: hashSpan(oldSpan) });
    const a1 = appeared({ id: 'src/a.ts::helperA', name: 'helperA', spanText: s1 });
    const a2 = appeared({ id: 'src/a.ts::helperB', name: 'helperB', spanText: s2 });
    // Each normalized body is unique on its own, so uniqueness passes; ambiguity is
    // caught by both being candidates for the one disappeared symbol.
    const { pairs, ambiguous } = computeContinuity([d], [a1, a2], uniq(a1, a2));
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].candidates.map((c) => c.id)).toEqual(['src/a.ts::helperA', 'src/a.ts::helperB']);
  });

  it('declines when one appeared symbol is the sole candidate of two disappeared (mutual uniqueness)', () => {
    const span = 'function thing(a){ return a; }';
    const d1 = gone({ nodeId: 'src/a.ts::f1', name: 'f1', contentHash: hashSpan(span) });
    const d2 = gone({ nodeId: 'src/a.ts::f2', name: 'f2', contentHash: hashSpan(span) });
    // The single appeared node is byte-identical (exact-body) to both old bodies.
    const a = appeared({ id: 'src/a.ts::merged', name: 'merged', spanText: span });
    const { pairs, ambiguous } = computeContinuity([d1, d2], [a], uniq(a));
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(2);
  });

  it('does not match a renamed-and-rewritten symbol (body changed beyond the name)', () => {
    const oldSpan = 'function computeTax(a){ return a * 0.2; }';
    const newSpan = 'function calculateTax(a, locale){ return a * rate(locale); }';
    const d = gone({ nodeId: 'src/a.ts::computeTax', name: 'computeTax', contentHash: hashSpan(oldSpan) });
    const a = appeared({ id: 'src/a.ts::calculateTax', name: 'calculateTax', spanText: newSpan });
    const { pairs, ambiguous } = computeContinuity([d], [a], uniq(a));
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(0);
  });

  it('never matches a disappeared symbol with no recorded baseline contentHash', () => {
    const span = 'function g(a){ return a; }';
    const d = gone({ nodeId: 'src/a.ts::f', name: 'f' }); // no contentHash
    const a = appeared({ id: 'src/a.ts::g', name: 'g', spanText: span });
    const { pairs, ambiguous } = computeContinuity([d], [a], uniq(a));
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(0);
  });

  it('matches two independent renames disjointly', () => {
    const o1 = 'function f1(x){ return x * 2; }';
    const o2 = 'function f2(y){ return y + "!"; }';
    const n1 = 'function g1(x){ return x * 2; }';
    const n2 = 'function g2(y){ return y + "!"; }';
    const d1 = gone({ nodeId: 'src/a.ts::f1', name: 'f1', contentHash: hashSpan(o1) });
    const d2 = gone({ nodeId: 'src/a.ts::f2', name: 'f2', contentHash: hashSpan(o2) });
    const a1 = appeared({ id: 'src/a.ts::g1', name: 'g1', spanText: n1 });
    const a2 = appeared({ id: 'src/a.ts::g2', name: 'g2', spanText: n2 });
    const { pairs } = computeContinuity([d1, d2], [a2, a1], uniq(a1, a2));
    expect(pairs).toHaveLength(2);
    expect(pairs[0].from.nodeId).toBe('src/a.ts::f1');
    expect(pairs[0].to.name).toBe('g1');
    expect(pairs[1].to.name).toBe('g2');
  });

  it('is deterministic regardless of input ordering', () => {
    const o1 = 'function f1(x){ return x * 2; }';
    const o2 = 'function f2(y){ return y - 1; }';
    const n1 = 'function g1(x){ return x * 2; }';
    const n2 = 'function g2(y){ return y - 1; }';
    const d1 = gone({ nodeId: 'src/a.ts::f1', name: 'f1', contentHash: hashSpan(o1) });
    const d2 = gone({ nodeId: 'src/a.ts::f2', name: 'f2', contentHash: hashSpan(o2) });
    const a1 = appeared({ id: 'src/a.ts::g1', name: 'g1', spanText: n1 });
    const a2 = appeared({ id: 'src/a.ts::g2', name: 'g2', spanText: n2 });
    const r1 = computeContinuity([d1, d2], [a1, a2], uniq(a1, a2));
    const r2 = computeContinuity([d2, d1], [a2, a1], uniq(a1, a2));
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('returns empty when nothing disappeared or nothing appeared', () => {
    const a = appeared({ id: 'x', name: 'x', spanText: 'function x(){}' });
    expect(computeContinuity([], [a], uniq(a))).toEqual({ pairs: [], ambiguous: [] });
    expect(computeContinuity([gone({ nodeId: 'y', name: 'y', contentHash: 'h' })], [], new Map()))
      .toEqual({ pairs: [], ambiguous: [] });
  });
});
