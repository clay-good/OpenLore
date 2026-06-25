/**
 * Tests for the pure symbol-identity continuity detector.
 * (change: add-symbol-identity-continuity)
 */

import { describe, it, expect } from 'vitest';
import {
  computeContinuity,
  type DisappearedSymbol,
  type AppearedSymbol,
} from './continuity.js';

function gone(p: Partial<DisappearedSymbol> & { nodeId: string; name: string }): DisappearedSymbol {
  return {
    filePath: 'src/a.ts',
    signatureShape: '(a: number)',
    ...p,
  };
}

function appeared(p: Partial<AppearedSymbol> & { id: string; name: string }): AppearedSymbol {
  return {
    filePath: 'src/a.ts',
    contentHash: 'hNEW',
    signatureShape: '(a: number)',
    ...p,
  };
}

describe('computeContinuity', () => {
  it('matches a pure rename via exact-signature (one-to-one)', () => {
    const disappeared = [gone({ nodeId: 'src/a.ts::computeTax', name: 'computeTax', contentHash: 'hOLD' })];
    const appeared_ = [appeared({ id: 'src/a.ts::calculateTax', name: 'calculateTax', contentHash: 'hNEW' })];
    const { pairs, ambiguous } = computeContinuity(disappeared, appeared_);
    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].basis).toBe('exact-signature');
    expect(pairs[0].reason).toBe('renamed');
    expect(pairs[0].to.name).toBe('calculateTax');
  });

  it('matches a pure move (same body, new file) via exact-body', () => {
    const disappeared = [gone({ nodeId: 'src/billing.ts::computeTax', name: 'computeTax', filePath: 'src/billing.ts', contentHash: 'hSAME' })];
    const appeared_ = [appeared({ id: 'src/tax.ts::computeTax', name: 'computeTax', filePath: 'src/tax.ts', contentHash: 'hSAME' })];
    const { pairs } = computeContinuity(disappeared, appeared_);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].basis).toBe('exact-body');
    expect(pairs[0].reason).toBe('moved');
  });

  it('prefers exact-body over exact-signature when both are available', () => {
    const disappeared = [gone({ nodeId: 'src/a.ts::f', name: 'f', contentHash: 'hSAME' })];
    const appeared_ = [
      // identical body — the strong match
      appeared({ id: 'src/a.ts::g', name: 'g', contentHash: 'hSAME' }),
    ];
    const { pairs } = computeContinuity(disappeared, appeared_);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].basis).toBe('exact-body');
    expect(pairs[0].reason).toBe('renamed');
  });

  it('reports renamed-and-moved when both name and file change', () => {
    const disappeared = [gone({ nodeId: 'src/a.ts::computeTax', name: 'computeTax', filePath: 'src/a.ts', contentHash: 'hOLD' })];
    const appeared_ = [appeared({ id: 'src/b.ts::calcTax', name: 'calcTax', filePath: 'src/b.ts', contentHash: 'hNEW' })];
    const { pairs } = computeContinuity(disappeared, appeared_);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason).toBe('renamed-and-moved');
  });

  it('declines an ambiguous match (two candidate destinations) and discloses them', () => {
    const disappeared = [gone({ nodeId: 'src/a.ts::helper', name: 'helper', contentHash: 'hOLD' })];
    const appeared_ = [
      appeared({ id: 'src/a.ts::helperA', name: 'helperA' }),
      appeared({ id: 'src/a.ts::helperB', name: 'helperB' }),
    ];
    const { pairs, ambiguous } = computeContinuity(disappeared, appeared_);
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].candidates.map((c) => c.id)).toEqual(['src/a.ts::helperA', 'src/a.ts::helperB']);
  });

  it('declines when one appeared symbol is the sole candidate of two disappeared (mutual uniqueness)', () => {
    const disappeared = [
      gone({ nodeId: 'src/a.ts::f1', name: 'f1', contentHash: 'hX' }),
      gone({ nodeId: 'src/a.ts::f2', name: 'f2', contentHash: 'hX' }),
    ];
    // Both f1 and f2 are byte-identical to the single appeared node → not confident.
    const appeared_ = [appeared({ id: 'src/a.ts::merged', name: 'merged', contentHash: 'hX' })];
    const { pairs, ambiguous } = computeContinuity(disappeared, appeared_);
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(2);
  });

  it('does not match a renamed-and-rewritten symbol (body changed, shape changed)', () => {
    // name changed, body changed, AND parameter shape changed → no basis matches.
    const disappeared = [gone({ nodeId: 'src/a.ts::computeTax', name: 'computeTax', contentHash: 'hOLD', signatureShape: '(a: number)' })];
    const appeared_ = [appeared({ id: 'src/a.ts::calculateTax', name: 'calculateTax', contentHash: 'hNEW', signatureShape: '(a: number, locale: string)' })];
    const { pairs, ambiguous } = computeContinuity(disappeared, appeared_);
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(0); // no continuation at all — stays orphaned, no disclosure
  });

  it('never matches on an empty signature shape alone', () => {
    const disappeared = [gone({ nodeId: 'src/a.ts::f', name: 'f', contentHash: 'hOLD', signatureShape: '' })];
    const appeared_ = [appeared({ id: 'src/a.ts::g', name: 'g', contentHash: 'hNEW', signatureShape: '' })];
    const { pairs, ambiguous } = computeContinuity(disappeared, appeared_);
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(0);
  });

  it('matches two independent renames disjointly (distinct shapes)', () => {
    const disappeared = [
      gone({ nodeId: 'src/a.ts::f1', name: 'f1', contentHash: 'h1', signatureShape: '(x: number)' }),
      gone({ nodeId: 'src/a.ts::f2', name: 'f2', contentHash: 'h2', signatureShape: '(y: string, z: string)' }),
    ];
    const appeared_ = [
      appeared({ id: 'src/a.ts::g2', name: 'g2', contentHash: 'h2new', signatureShape: '(y: string, z: string)' }),
      appeared({ id: 'src/a.ts::g1', name: 'g1', contentHash: 'h1new', signatureShape: '(x: number)' }),
    ];
    const { pairs } = computeContinuity(disappeared, appeared_);
    expect(pairs).toHaveLength(2);
    // sorted by from.nodeId
    expect(pairs[0].from.nodeId).toBe('src/a.ts::f1');
    expect(pairs[0].to.name).toBe('g1');
    expect(pairs[1].to.name).toBe('g2');
  });

  it('is deterministic regardless of input ordering', () => {
    const d1 = gone({ nodeId: 'src/a.ts::f1', name: 'f1', contentHash: 'h1', signatureShape: '(x: number)' });
    const d2 = gone({ nodeId: 'src/a.ts::f2', name: 'f2', contentHash: 'h2', signatureShape: '(y: string)' });
    const a1 = appeared({ id: 'src/a.ts::g1', name: 'g1', contentHash: 'h1n', signatureShape: '(x: number)' });
    const a2 = appeared({ id: 'src/a.ts::g2', name: 'g2', contentHash: 'h2n', signatureShape: '(y: string)' });
    const r1 = computeContinuity([d1, d2], [a1, a2]);
    const r2 = computeContinuity([d2, d1], [a2, a1]);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('returns empty when nothing disappeared or nothing appeared', () => {
    expect(computeContinuity([], [appeared({ id: 'x', name: 'x' })])).toEqual({ pairs: [], ambiguous: [] });
    expect(computeContinuity([gone({ nodeId: 'y', name: 'y', contentHash: 'h' })], [])).toEqual({ pairs: [], ambiguous: [] });
  });
});
