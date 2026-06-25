/**
 * Tests for the pure re-anchor transform of the continuity carry-forward.
 * (change: add-symbol-identity-continuity)
 *
 * The disk orchestration (`carryForwardContinuity`) is exercised end-to-end by the
 * analyze integration test; here we pin the pure transform that decides how an
 * anchor is rewritten.
 */

import { describe, it, expect } from 'vitest';
import { reanchorAnchors } from './continuity-carry-forward.js';
import type { StructuralAnchor } from '../../types/index.js';
import type { ContinuityPair, AmbiguousContinuity } from '../analyzer/continuity.js';

function pair(p: Partial<ContinuityPair> & Pick<ContinuityPair, 'from' | 'to'>): ContinuityPair {
  return { reason: 'renamed', basis: 'exact-signature', ...p };
}

describe('reanchorAnchors', () => {
  const baseAnchor: StructuralAnchor = {
    nodeId: 'src/a.ts::computeTax',
    stableId: 'sid:computeTax(a)',
    symbolName: 'computeTax',
    filePath: 'src/a.ts',
    contentHash: 'hOLD',
  };

  it('re-points an anchor across a pair and stamps carriedAcross, preserving contentHash', () => {
    const pairs = new Map([['src/a.ts::computeTax', pair({
      from: { nodeId: 'src/a.ts::computeTax', name: 'computeTax', filePath: 'src/a.ts' },
      to: { id: 'src/a.ts::calculateTax', stableId: 'sid:calculateTax(a)', name: 'calculateTax', filePath: 'src/a.ts', contentHash: 'hNEW', spanText: 'function calculateTax(a){}', normBodyHash: 'nh' },
      reason: 'renamed', basis: 'exact-signature',
    })]]);
    const { anchors, changed } = reanchorAnchors([baseAnchor], pairs, new Map(), 'abc123');
    expect(changed).toBe(true);
    const a = anchors[0];
    expect(a.nodeId).toBe('src/a.ts::calculateTax');
    expect(a.stableId).toBe('sid:calculateTax(a)');
    expect(a.symbolName).toBe('calculateTax');
    expect(a.contentHash).toBe('hOLD'); // baseline preserved → drives fresh/drifted at recall
    expect(a.carriedAcross).toEqual({
      from: { symbolName: 'computeTax', filePath: 'src/a.ts' },
      reason: 'renamed',
      basis: 'exact-signature',
      atCommit: 'abc123',
    });
  });

  it('attaches possiblyMovedTo for an ambiguous old symbol, leaving identity intact', () => {
    const amb = new Map<string, AmbiguousContinuity>([['src/a.ts::computeTax', {
      from: { nodeId: 'src/a.ts::computeTax', name: 'computeTax', filePath: 'src/a.ts' },
      candidates: [
        { id: 'src/a.ts::calcA', name: 'calcA', filePath: 'src/a.ts' },
        { id: 'src/b.ts::calcB', name: 'calcB', filePath: 'src/b.ts' },
      ],
    }]]);
    const { anchors, changed } = reanchorAnchors([baseAnchor], new Map(), amb);
    expect(changed).toBe(true);
    expect(anchors[0].nodeId).toBe('src/a.ts::computeTax'); // unchanged identity → still orphaned
    expect(anchors[0].possiblyMovedTo).toEqual(['src/a.ts::calcA', 'src/b.ts::calcB']);
  });

  it('leaves file-level anchors and unmatched anchors untouched', () => {
    const fileAnchor: StructuralAnchor = { filePath: 'src/a.ts', contentHash: 'fh' };
    const other: StructuralAnchor = { nodeId: 'src/z.ts::keep', symbolName: 'keep', filePath: 'src/z.ts', contentHash: 'h' };
    const { anchors, changed } = reanchorAnchors([fileAnchor, other], new Map(), new Map());
    expect(changed).toBe(false);
    expect(anchors[0]).toBe(fileAnchor);
    expect(anchors[1]).toBe(other);
  });

  it('is idempotent for an already-attached possiblyMovedTo', () => {
    const withHint: StructuralAnchor = { ...baseAnchor, possiblyMovedTo: ['src/a.ts::calcA'] };
    const amb = new Map<string, AmbiguousContinuity>([['src/a.ts::computeTax', {
      from: { nodeId: 'src/a.ts::computeTax', name: 'computeTax', filePath: 'src/a.ts' },
      candidates: [{ id: 'src/a.ts::calcA', name: 'calcA', filePath: 'src/a.ts' }],
    }]]);
    const { changed } = reanchorAnchors([withHint], new Map(), amb);
    expect(changed).toBe(false);
  });

  it('clears a stale possiblyMovedTo when the symbol is now confidently carried', () => {
    const withHint: StructuralAnchor = { ...baseAnchor, possiblyMovedTo: ['src/a.ts::calcA'] };
    const pairs = new Map([['src/a.ts::computeTax', pair({
      from: { nodeId: 'src/a.ts::computeTax', name: 'computeTax', filePath: 'src/a.ts' },
      to: { id: 'src/a.ts::calculateTax', name: 'calculateTax', filePath: 'src/a.ts', contentHash: 'hNEW', spanText: 'function calculateTax(a){}', normBodyHash: 'nh' },
    })]]);
    const { anchors } = reanchorAnchors([withHint], pairs, new Map());
    expect(anchors[0].possiblyMovedTo).toBeUndefined();
    expect(anchors[0].carriedAcross).toBeDefined();
  });
});
