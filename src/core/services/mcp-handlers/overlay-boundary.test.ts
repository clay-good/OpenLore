/**
 * The completeness flag for an answer served partly from the working tree
 * (change: overlay-dirty-files-at-query-time).
 */
import { describe, expect, it } from 'vitest';
import { assembleBoundary, overlayCrossing } from './confidence-boundary.js';

describe('overlay crossing keeps an answer honestly incomplete', () => {
  it('is absent when nothing was overlaid', () => {
    expect(overlayCrossing(0)).toBeUndefined();
  });

  it('marks an overlaid answer incomplete and names the edge limit', () => {
    const crossing = overlayCrossing(2);
    const boundary = assembleBoundary({ extraCrossings: crossing ? [crossing] : [] });
    expect(boundary.complete).toBe(false);
    expect(boundary.knownUnknowable?.[0].kind).toBe('working-tree-overlay');
    expect(boundary.knownUnknowable?.[0].detail).toMatch(/incoming call edges come from the index/i);
  });

  it('leaves a non-overlaid answer complete', () => {
    expect(assembleBoundary({ extraCrossings: [] }).complete).toBe(true);
  });
});
