/**
 * Memory strategy — pre-flight estimate, degradation ladder, and determinism guardrails
 * (change: make-analyze-scale-to-any-repo).
 *
 * These are the CI-visible determinism guards (plain `.test.ts`, so they run in CI; the full
 * analyze-twice byte-diff lives in the integration suite CI skips). They prove the estimate is a
 * pure function of the repository, the tier is a pure function of declared constraints, and the
 * ladder sheds in the defined order and discloses reproducibly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  estimateGraphMemoryBytes,
  chooseMemoryTier,
  shedComponentsFor,
  buildMemoryDegradation,
  describeMemoryDegradation,
  resolveMemoryStrategy,
  isCfgOverlayShed,
  withCfgOverlayShed,
  formatBytes,
  MEMORY_TIERS,
  FULL_FIDELITY_HEAP_FRACTION,
  DEEP_ANALYSIS_SHED_HEAP_FRACTION,
  GRAPH_BYTES_BASE,
  FORCE_TIER_ENV,
  SHED_CFG_OVERLAY_ENV,
} from './memory-strategy.js';

const ENV_KEYS = [
  FORCE_TIER_ENV,
  SHED_CFG_OVERLAY_ENV,
  'OPENLORE_MEMORY_ESTIMATE_BYTES',
];
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe('estimateGraphMemoryBytes', () => {
  it('is a pure function of the repository — same inputs, same number', () => {
    const inputs = { analyzedFileCount: 1234, totalSourceBytes: 5_000_000 };
    const a = estimateGraphMemoryBytes(inputs);
    const b = estimateGraphMemoryBytes({ ...inputs });
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(GRAPH_BYTES_BASE);
  });

  it('grows monotonically with source bytes and file count', () => {
    const base = estimateGraphMemoryBytes({ analyzedFileCount: 100, totalSourceBytes: 1_000_000 });
    expect(estimateGraphMemoryBytes({ analyzedFileCount: 100, totalSourceBytes: 2_000_000 })).toBeGreaterThan(base);
    expect(estimateGraphMemoryBytes({ analyzedFileCount: 200, totalSourceBytes: 1_000_000 })).toBeGreaterThan(base);
  });

  it('has a floor and never returns negative for degenerate inputs', () => {
    expect(estimateGraphMemoryBytes({ analyzedFileCount: 0, totalSourceBytes: 0 })).toBe(GRAPH_BYTES_BASE);
    expect(estimateGraphMemoryBytes({ analyzedFileCount: -5, totalSourceBytes: -10 })).toBe(GRAPH_BYTES_BASE);
  });

  it('honors the OPENLORE_MEMORY_ESTIMATE_BYTES override', () => {
    setEnv('OPENLORE_MEMORY_ESTIMATE_BYTES', String(9 * 1024 * 1024 * 1024));
    expect(estimateGraphMemoryBytes({ analyzedFileCount: 1, totalSourceBytes: 1 })).toBe(9 * 1024 * 1024 * 1024);
  });
});

describe('chooseMemoryTier', () => {
  const heap = 2_000_000_000;

  it('runs full fidelity when the estimate fits with headroom', () => {
    expect(chooseMemoryTier(heap * FULL_FIDELITY_HEAP_FRACTION - 1, heap)).toBe('full');
  });

  it('sheds the overlay between the two fractions', () => {
    const mid = heap * ((FULL_FIDELITY_HEAP_FRACTION + DEEP_ANALYSIS_SHED_HEAP_FRACTION) / 2);
    expect(chooseMemoryTier(mid, heap)).toBe('shed-overlay');
  });

  it('sheds the overlay AND deep analysis past the upper fraction', () => {
    expect(chooseMemoryTier(heap * DEEP_ANALYSIS_SHED_HEAP_FRACTION + 1, heap)).toBe('shed-overlay-and-deep-analysis');
  });

  it('never degrades on an unknown/zero heap (assume it fits)', () => {
    expect(chooseMemoryTier(9_999_999_999, 0)).toBe('full');
    expect(chooseMemoryTier(9_999_999_999, Number.NaN)).toBe('full');
  });

  it('is a pure function of (estimate, heap)', () => {
    for (const est of [1e8, 1e9, 1.5e9, 1.9e9, 5e9]) {
      expect(chooseMemoryTier(est, heap)).toBe(chooseMemoryTier(est, heap));
    }
  });
});

describe('shedComponentsFor — the ladder order', () => {
  it('sheds nothing at full fidelity', () => {
    expect(shedComponentsFor('full')).toEqual([]);
  });
  it('sheds the overlay first, then deep-analysis breadth', () => {
    expect(shedComponentsFor('shed-overlay')).toEqual(['cfg-overlay']);
    expect(shedComponentsFor('shed-overlay-and-deep-analysis')).toEqual(['cfg-overlay', 'deep-analysis-breadth']);
  });
  it('covers every declared tier', () => {
    for (const t of MEMORY_TIERS) expect(() => shedComponentsFor(t)).not.toThrow();
  });
});

describe('buildMemoryDegradation + describeMemoryDegradation', () => {
  it('produces no record and no line at full fidelity', () => {
    const d = buildMemoryDegradation('full', 1, 2);
    expect(d).toBeUndefined();
    expect(describeMemoryDegradation(d)).toBeUndefined();
  });

  it('records the shed components and declared constraints, reproducibly', () => {
    const a = buildMemoryDegradation('shed-overlay-and-deep-analysis', 3_000_000_000, 2_000_000_000);
    const b = buildMemoryDegradation('shed-overlay-and-deep-analysis', 3_000_000_000, 2_000_000_000);
    expect(a).toEqual(b); // same declared constraints ⇒ identical disclosure
    expect(a!.shed).toEqual(['cfg-overlay', 'deep-analysis-breadth']);
    expect(a!.estimatedBytes).toBe(3_000_000_000);
    expect(a!.availableHeapBytes).toBe(2_000_000_000);
  });

  it('renders a one-line, lower-bound disclosure naming what was shed', () => {
    const line = describeMemoryDegradation(buildMemoryDegradation('shed-overlay', 3e9, 2e9));
    expect(line).toContain('CFG/def-use overlay');
    expect(line).toContain('LOWER BOUND');
    expect(line).not.toContain('LLM deep-analysis'); // tier 1 does not shed deep analysis
  });
});

describe('resolveMemoryStrategy — forced-tier override', () => {
  it('forces a tier deterministically (the operator/test hook)', () => {
    setEnv(FORCE_TIER_ENV, 'shed-overlay-and-deep-analysis');
    const s = resolveMemoryStrategy({ analyzedFileCount: 1, totalSourceBytes: 1 });
    expect(s.tier).toBe('shed-overlay-and-deep-analysis');
    expect(s.shedCfgOverlay).toBe(true);
    expect(s.shedDeepAnalysis).toBe(true);
    expect(s.degradation?.shed).toEqual(['cfg-overlay', 'deep-analysis-breadth']);
  });

  it('a tiny repo stays full fidelity with no override', () => {
    const s = resolveMemoryStrategy({ analyzedFileCount: 10, totalSourceBytes: 50_000 });
    expect(s.tier).toBe('full');
    expect(s.shedCfgOverlay).toBe(false);
    expect(s.degradation).toBeUndefined();
  });

  it('ignores an unrecognized forced tier', () => {
    setEnv(FORCE_TIER_ENV, 'bogus');
    expect(resolveMemoryStrategy({ analyzedFileCount: 10, totalSourceBytes: 50_000 }).tier).toBe('full');
  });
});

describe('withCfgOverlayShed / isCfgOverlayShed — worker-visible flag', () => {
  it('is off by default', () => {
    expect(isCfgOverlayShed()).toBe(false);
  });

  it('sets the flag only within the wrapped build, then restores it', async () => {
    expect(isCfgOverlayShed()).toBe(false);
    let seenInside = false;
    await withCfgOverlayShed(true, async () => { seenInside = isCfgOverlayShed(); });
    expect(seenInside).toBe(true);
    expect(isCfgOverlayShed()).toBe(false);
    expect(process.env[SHED_CFG_OVERLAY_ENV]).toBeUndefined();
  });

  it('does not touch the flag when shed is false', async () => {
    let seenInside = true;
    await withCfgOverlayShed(false, async () => { seenInside = isCfgOverlayShed(); });
    expect(seenInside).toBe(false);
  });

  it('restores the flag even when the build throws', async () => {
    await expect(withCfgOverlayShed(true, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(isCfgOverlayShed()).toBe(false);
  });
});

describe('formatBytes', () => {
  it('renders compact human sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2_000_000_000)).toBe('1.9 GB');
  });
});
