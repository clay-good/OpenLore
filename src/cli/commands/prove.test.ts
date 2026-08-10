/**
 * Tests for the prove command's persistence + result plumbing
 * (add-prove-shareable-scorecard). The deterministic agent-eval core is covered
 * in src/core/agent-eval/agent-eval.test.ts; here we exercise saveScorecard's
 * filesystem behavior (dated, non-clobbering) against a real temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatProveIneligibleMessage, saveScorecard, parseNumericFlag, summarizeArms, type ProveResult } from './prove.js';
import { OPENLORE_PROVE_REL_PATH } from '../../constants.js';
import type { Metrics } from '../../core/agent-eval/measure.js';
import type { Scorecard, ScorecardMeta } from '../../core/agent-eval/scorecard.js';

const ok = (cost: number, turns: number, correct: boolean): Metrics =>
  ({ freshInputTokens: 1000, cacheReadTokens: 0, outputTokens: 100, costUsd: cost, numTurns: turns, durationMs: 1000, answer: 'a', correct });
const errored = (): Metrics =>
  ({ freshInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0, answer: '', correct: false, error: 'boom' });

const scorecard: Scorecard = {
  costWithout: 0.2, costWith: 0.16, costDeltaPct: -20,
  turnsWithout: 20, turnsWith: 14, turnsDeltaPct: -30,
  correctWithout: 1, correctWith: 1, freshWithout: 13000, freshWith: 4000,
  samplesPerArm: 1, verdict: 'helps',
};
const baseMeta: ScorecardMeta = {
  mode: 'estimate', generatedAt: '2026-06-22T10:00:00.000Z', repoSha: 'abc1234', model: null, tasks: 3,
};
const result = (meta: ScorecardMeta = baseMeta): ProveResult => ({
  ok: true,
  message: 'rendered',
  scorecard,
  meta,
  raw: { withoutCell: { costUsd: 0.2, freshInputTokens: 13000, cacheReadTokens: 0, numTurns: 20, durationMs: 0, correctRate: 1, runs: 1 },
    withCell: { costUsd: 0.16, freshInputTokens: 4000, cacheReadTokens: 0, numTurns: 14, durationMs: 0, correctRate: 1, runs: 1 } },
});

describe('saveScorecard', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'openlore-prove-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes a dated file under .openlore/prove/ with the serialized scorecard + raw', () => {
    const path = saveScorecard(dir, result());
    expect(path).toContain(join(OPENLORE_PROVE_REL_PATH, 'prove-2026-06-22.json'));
    expect(existsSync(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.mode).toBe('estimate');
    expect(saved.roundTrips).toEqual({ without: 20, with: 14, deltaPct: -30 });
    expect(saved.raw).toBeTruthy(); // raw metrics persisted for diffing
  });

  it('does not clobber a same-day run — it adds a numeric suffix', () => {
    const p1 = saveScorecard(dir, result());
    const p2 = saveScorecard(dir, result());
    const p3 = saveScorecard(dir, result());
    expect(p1).not.toBe(p2);
    expect(p2).not.toBe(p3);
    const files = readdirSync(join(dir, OPENLORE_PROVE_REL_PATH)).sort();
    expect(files).toEqual(['prove-2026-06-22-2.json', 'prove-2026-06-22-3.json', 'prove-2026-06-22.json']);
  });

  it('never overwrites a pre-existing same-name file (atomic wx write)', () => {
    const proveDir = join(dir, OPENLORE_PROVE_REL_PATH);
    mkdirSync(proveDir, { recursive: true });
    const base = join(proveDir, 'prove-2026-06-22.json');
    writeFileSync(base, 'SENTINEL — must not be overwritten', 'utf-8');
    const written = saveScorecard(dir, result());
    expect(written).not.toBe(base);                                                  // picked a suffix
    expect(readFileSync(base, 'utf-8')).toBe('SENTINEL — must not be overwritten');  // intact
    expect(JSON.parse(readFileSync(written, 'utf-8')).schemaVersion).toBe(1);
  });

  it('separates runs from different days into different files', () => {
    saveScorecard(dir, result());
    saveScorecard(dir, result({ ...baseMeta, generatedAt: '2026-06-23T09:00:00.000Z' }));
    const files = readdirSync(join(dir, OPENLORE_PROVE_REL_PATH)).sort();
    expect(files).toEqual(['prove-2026-06-22.json', 'prove-2026-06-23.json']);
  });

  it('throws a catchable error (not a silent corruption) when .openlore/prove is a file', () => {
    // The command wraps saveScorecard in try/catch and degrades to a clear stderr
    // message + exit 1; here we assert the failure is a normal throwable Error.
    mkdirSync(join(dir, '.openlore'), { recursive: true });
    writeFileSync(join(dir, OPENLORE_PROVE_REL_PATH), 'not a dir', 'utf-8');
    expect(() => saveScorecard(dir, result())).toThrow();
  });

  it('rounds float noise out of the persisted raw block', () => {
    const noisy = result();
    noisy.raw!.withoutCell.costUsd = 0.057999999999999996;
    noisy.raw!.withCell.costUsd = 0.043000000000000003;
    const saved = JSON.parse(readFileSync(saveScorecard(dir, noisy), 'utf-8'));
    expect(saved.raw.withoutCell.costUsd).toBe(0.058);
    expect(saved.raw.withCell.costUsd).toBe(0.043);
  });
});

describe('summarizeArms — failed runs never become a confident verdict', () => {
  it('fails loudly when EVERY run errored (no usable measurement)', () => {
    const r = summarizeArms([errored(), errored()], [errored(), errored()]);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain('no usable measurement');
    expect((r as { message: string }).message).toContain('4/4 agent runs failed');
    expect((r as { message: string }).message).toContain('boom');
  });

  it('fails loudly when one whole arm errored (asymmetric total failure)', () => {
    const r = summarizeArms([ok(0.05, 6, true), ok(0.05, 6, true)], [errored(), errored()]);
    expect(r.ok).toBe(false); // the WITH arm produced nothing comparable
  });

  it('drops errored runs from the medians on a partial failure (no zero pollution)', () => {
    // One real $0.20/20-turn sample + one errored zero: the cell must reflect the
    // real sample, NOT a median dragged toward 0 by the failed run.
    const r = summarizeArms([ok(0.20, 20, true), errored()], [ok(0.10, 8, true), errored()]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.withoutCell.costUsd).toBe(0.20);
      expect(r.withoutCell.numTurns).toBe(20);
      expect(r.withoutCell.runs).toBe(1);   // only the successful sample counted
      expect(r.withCell.costUsd).toBe(0.10);
      expect(r.withCell.correctRate).toBe(1);
    }
  });

  it('summarizes normally when nothing errored', () => {
    const r = summarizeArms([ok(0.2, 20, true), ok(0.2, 20, true)], [ok(0.1, 10, true), ok(0.1, 10, true)]);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.withoutCell.runs).toBe(2); expect(r.withCell.runs).toBe(2); }
  });
});

describe('parseNumericFlag', () => {
  it('returns the default when the flag is absent', () => {
    expect(parseNumericFlag(undefined, 'runs', true, 1, 2)).toBe(2);
  });
  it('parses and clamps a valid value to the minimum', () => {
    expect(parseNumericFlag('4', 'runs', true, 1, 2)).toBe(4);
    expect(parseNumericFlag('0', 'runs', true, 1, 2)).toBe(1);   // clamp up
    expect(parseNumericFlag('-3', 'runs', true, 1, 2)).toBe(1);  // clamp up
    expect(parseNumericFlag('1.9', 'runs', true, 1, 2)).toBe(1); // int truncation
    expect(parseNumericFlag('0.5', 'max-budget-usd', false, 0, 0.5)).toBe(0.5);
  });
  it('REJECTS a non-numeric value instead of letting NaN through', () => {
    const r = parseNumericFlag('abc', 'runs', true, 1, 2);
    expect(typeof r).toBe('object');
    expect((r as { error: string }).error).toContain('--runs must be a number');
    const b = parseNumericFlag('xyz', 'max-budget-usd', false, 0, 0.5);
    expect((b as { error: string }).error).toContain('--max-budget-usd must be a number');
  });
});

describe('sparse graph refusal', () => {
  it('names the measured count, threshold, and applicable alternatives', () => {
    const message = formatProveIneligibleMessage({
      eligibleFunctions: 0,
      requiredEligibleFunctions: 1,
      minCallers: 2,
      eligible: false,
    });
    expect(message).toContain('0 functions have ≥2 callers');
    expect(message).toContain('at least 1 is required');
    expect(message).toContain('Nothing is wrong with the installation');
    expect(message).toContain('skip this prove run');
  });
});
