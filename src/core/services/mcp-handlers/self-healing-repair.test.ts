/**
 * make-index-self-healing: the read-path reason mapping (which staleness signal
 * heals, worst-first) and the repair-in-progress disclosure threaded into the
 * confidence boundary.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRepairReason } from './utils.js';
import { assembleBoundary, repairDisclosure } from './confidence-boundary.js';
import {
  repairInBackground,
  _resetRepairServiceForTesting,
} from '../cold-start-bootstrap.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_000 * HOUR; // arbitrary fixed clock

describe('computeRepairReason — worst-first read-path trigger selection', () => {
  const fresh = NOW - 1000; // artifact mtime "just now"

  it('mismatched integrity outranks everything', () => {
    expect(computeRepairReason('mismatched', true, 5, NOW - 100 * HOUR, NOW)).toBe('integrity-mismatched');
  });

  it('a schema reset heals when integrity is not mismatched', () => {
    expect(computeRepairReason('healthy', true, 0, fresh, NOW)).toBe('schema-reset');
  });

  it('an explicit stale region at/above the threshold heals', () => {
    expect(computeRepairReason(undefined, false, 1, fresh, NOW)).toBe('stale-region');
    expect(computeRepairReason(undefined, false, 0, fresh, NOW)).not.toBe('stale-region');
  });

  it('an aged analysis (older than the doctor warning threshold) heals', () => {
    // 25h old > ANALYSIS_AGE_WARNING_HOURS (24h)
    expect(computeRepairReason('healthy', false, 0, NOW - 25 * HOUR, NOW)).toBe('analysis-age');
  });

  it('a current, healthy index triggers nothing', () => {
    expect(computeRepairReason('healthy', false, 0, fresh, NOW)).toBeUndefined();
    // `degraded` is deliberately NOT a trigger (WAL-lag / already retried).
    expect(computeRepairReason('degraded', false, 0, fresh, NOW)).toBeUndefined();
  });
});

describe('repairDisclosure — served-stale answers are disclosed as repairing', () => {
  const dirs: string[] = [];
  afterEach(() => {
    _resetRepairServiceForTesting();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('marks the boundary incomplete with the repair reason while a repair is in flight', async () => {
    // Auto-init runs only inside a git work tree (change: unify-onboarding-entrypoint).
    const dir = mkdtempSync(join(tmpdir(), 'openlore-heal-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.git'), { recursive: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = repairInBackground(dir, 'integrity-mismatched', {
      analyze: async () => { await gate; },
      log: () => {},
    });

    const marker = repairDisclosure(dir);
    expect(marker).toMatchObject({ inProgress: true, reason: 'integrity-mismatched' });
    expect(marker?.detail).toMatch(/background refresh has started/i);

    const boundary = assembleBoundary({ repair: marker });
    expect(boundary.repair).toEqual(marker);
    expect(boundary.complete).toBe(false); // a repairing index is never "complete"

    release();
    await p;
    // After completion the marker is gone — a fresh answer carries no repair caveat.
    expect(repairDisclosure(dir)).toBeUndefined();
    expect(assembleBoundary({}).complete).toBe(true);
  });
});
