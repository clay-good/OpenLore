/**
 * Tests for the decision transition ledger (change: add-decision-autopilot):
 * pure diffing, append/read round-trip, malformed-line tolerance, and the
 * automatic trail written by updateDecisionStore.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdir, rm, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diffStoreTransitions, appendLedgerEntries, readLedger, ledgerPath } from './ledger.js';
import { loadDecisionStore, saveDecisionStore, updateDecisionStore, patchDecision } from './store.js';
import { logger } from '../../utils/logger.js';
import type { PendingDecision, DecisionStore } from '../../types/index.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), section: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn() },
}));

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `decisions-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'aaaabbbb',
    status: 'draft',
    title: 'Use Redis for caching',
    rationale: 'Reduces DB load',
    consequences: 'Cache invalidation to manage',
    proposedRequirement: null,
    affectedDomains: ['cache'],
    affectedFiles: ['src/cache.ts'],
    sessionId: 'session123',
    recordedAt: '2026-01-01T00:00:00.000Z',
    contentOrigin: 'agent-recorded',
    confidence: 'medium',
    syncedToSpecs: [],
    ...overrides,
  };
}

function makeStore(decisions: PendingDecision[]): DecisionStore {
  return {
    version: '1',
    sessionId: 'session123',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sequence: 0,
    decisions,
  };
}

describe('diffStoreTransitions', () => {
  it('emits a creation entry (from: null) for a new decision', () => {
    const before = makeStore([]);
    const after = makeStore([makeDecision()]);
    const entries = diffStoreTransitions(before, after, 'agent', '2026-07-18T00:00:00.000Z', 'abc1234');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'aaaabbbb', from: null, to: 'draft', actor: 'agent', commit: 'abc1234' });
  });

  it('emits one entry per status change and none for unchanged decisions', () => {
    const before = makeStore([
      makeDecision({ id: 'aaaabbbb', status: 'verified' }),
      makeDecision({ id: 'ccccdddd', status: 'draft', title: 'Other' }),
    ]);
    const after = makeStore([
      makeDecision({ id: 'aaaabbbb', status: 'auto-approved' }),
      makeDecision({ id: 'ccccdddd', status: 'draft', title: 'Other' }),
    ]);
    const entries = diffStoreTransitions(before, after, 'autopilot', '2026-07-18T00:00:00.000Z');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'aaaabbbb', from: 'verified', to: 'auto-approved', actor: 'autopilot' });
    expect(entries[0].commit).toBeUndefined();
  });
});

describe('ledger append/read', () => {
  it('round-trips entries and preserves earlier entries on later appends', async () => {
    const dir = await createTempDir();
    try {
      await appendLedgerEntries(dir, [
        { id: 'aaaabbbb', title: 'First', from: null, to: 'draft', actor: 'agent', at: '2026-07-18T00:00:00.000Z' },
      ]);
      await appendLedgerEntries(dir, [
        { id: 'aaaabbbb', title: 'First', from: 'draft', to: 'verified', actor: 'sync', at: '2026-07-18T00:01:00.000Z' },
      ]);
      const entries = await readLedger(dir);
      expect(entries).toHaveLength(2);
      expect(entries[0].to).toBe('draft');
      expect(entries[1].to).toBe('verified');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips malformed lines without losing valid ones', async () => {
    const dir = await createTempDir();
    try {
      await appendLedgerEntries(dir, [
        { id: 'aaaabbbb', title: 'First', from: null, to: 'draft', actor: 'agent', at: '2026-07-18T00:00:00.000Z' },
      ]);
      await appendFile(ledgerPath(dir), '{"torn": tru\n', 'utf-8');
      await appendLedgerEntries(dir, [
        { id: 'aaaabbbb', title: 'First', from: 'draft', to: 'verified', actor: 'sync', at: '2026-07-18T00:01:00.000Z' },
      ]);
      const entries = await readLedger(dir);
      expect(entries).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('append failure is fail-soft (never throws)', async () => {
    const dir = await createTempDir();
    try {
      // Make the ledger path unwritable by placing a directory where the file goes.
      await mkdir(ledgerPath(dir), { recursive: true });
      await expect(appendLedgerEntries(dir, [
        { id: 'aaaabbbb', title: 'X', from: null, to: 'draft', actor: 'agent', at: '2026-07-18T00:00:00.000Z' },
      ])).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Decision ledger append failed'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('updateDecisionStore ledger trail', () => {
  it('trails every committed status transition with the given actor', async () => {
    const dir = await createTempDir();
    try {
      await saveDecisionStore(dir, makeStore([makeDecision({ status: 'verified' })]));
      await updateDecisionStore(dir, (s) => patchDecision(s, 'aaaabbbb', {
        status: 'auto-approved', approvedBy: 'autopilot',
      }), 'autopilot');

      const entries = await readLedger(dir);
      const transition = entries.find((e) => e.to === 'auto-approved');
      expect(transition).toBeDefined();
      expect(transition).toMatchObject({ id: 'aaaabbbb', from: 'verified', actor: 'autopilot' });

      const store = await loadDecisionStore(dir);
      expect(store.decisions[0].status).toBe('auto-approved');
      expect(store.decisions[0].approvedBy).toBe('autopilot');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a no-op mutate appends nothing', async () => {
    const dir = await createTempDir();
    try {
      await saveDecisionStore(dir, makeStore([makeDecision()]));
      await updateDecisionStore(dir, (s) => s, 'human');
      const entries = await readLedger(dir);
      expect(entries).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ledger lines are valid JSONL a human can audit', async () => {
    const dir = await createTempDir();
    try {
      await saveDecisionStore(dir, makeStore([]));
      await updateDecisionStore(dir, (s) => ({
        ...s, decisions: [makeDecision()],
      }), 'agent');
      const raw = await readFile(ledgerPath(dir), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed).toMatchObject({ id: 'aaaabbbb', from: null, to: 'draft', actor: 'agent' });
      expect(typeof parsed.at).toBe('string');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
