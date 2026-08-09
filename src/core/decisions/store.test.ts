/**
 * Tests for decision store — pure functions + fs I/O
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  makeDecisionId,
  newSessionId,
  upsertDecisions,
  replaceDecisions,
  applyConsolidationResult,
  patchDecision,
  purgeInactiveDecisions,
  getDecisionsByStatus,
  loadDecisionStore,
  saveDecisionStore,
  decisionsDir,
  illegalPromotionToApproved,
  PROMOTABLE_TO_APPROVED,
} from './store.js';
import type { PendingDecision, DecisionStore } from '../../types/index.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), section: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn() },
}));

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `decisions-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'aaaabbbb',
    status: 'draft',
    title: 'Use Redis for caching',
    rationale: 'Reduces DB load',
    consequences: 'Need to manage cache invalidation',
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

function emptyStore(sessionId = 'sess001'): DecisionStore {
  return { version: '1', sessionId, updatedAt: '2026-01-01T00:00:00.000Z', decisions: [] };
}

// ============================================================================
// makeDecisionId
// ============================================================================

describe('makeDecisionId', () => {
  it('returns an 8-char hex string', () => {
    const id = makeDecisionId('session1', 'auth', 'Use JWTs');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = makeDecisionId('s1', 'auth', 'Use JWTs');
    const b = makeDecisionId('s1', 'auth', 'Use JWTs');
    expect(a).toBe(b);
  });

  it('differs when title changes', () => {
    const a = makeDecisionId('s1', 'auth', 'Use JWTs');
    const b = makeDecisionId('s1', 'auth', 'Use sessions');
    expect(a).not.toBe(b);
  });

  it('differs when domain changes', () => {
    const a = makeDecisionId('s1', 'auth', 'Use JWTs');
    const b = makeDecisionId('s1', 'cache', 'Use JWTs');
    expect(a).not.toBe(b);
  });

  it('differs when sessionId changes', () => {
    const a = makeDecisionId('s1', 'auth', 'Use JWTs');
    const b = makeDecisionId('s2', 'auth', 'Use JWTs');
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// newSessionId
// ============================================================================

describe('newSessionId', () => {
  it('returns a 12-char hex string', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('generates different IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newSessionId()));
    expect(ids.size).toBe(20);
  });
});

// ============================================================================
// upsertDecisions
// ============================================================================

describe('upsertDecisions', () => {
  it('adds new decisions to an empty store', () => {
    const store = emptyStore();
    const d = makeDecision();
    const result = upsertDecisions(store, [d]);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].id).toBe('aaaabbbb');
  });

  it('does not overwrite an existing decision with the same id', () => {
    const d = makeDecision({ title: 'Original' });
    const store: DecisionStore = { ...emptyStore(), decisions: [d] };
    const incoming = makeDecision({ title: 'Updated' });
    const result = upsertDecisions(store, [incoming]);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].title).toBe('Original');
  });

  it('adds a new decision while keeping the existing one', () => {
    const d1 = makeDecision({ id: 'aaaa0001', title: 'First' });
    const store: DecisionStore = { ...emptyStore(), decisions: [d1] };
    const d2 = makeDecision({ id: 'bbbb0002', title: 'Second' });
    const result = upsertDecisions(store, [d2]);
    expect(result.decisions).toHaveLength(2);
  });

  it('handles an empty incoming list gracefully', () => {
    const d = makeDecision();
    const store: DecisionStore = { ...emptyStore(), decisions: [d] };
    const result = upsertDecisions(store, []);
    expect(result.decisions).toHaveLength(1);
  });
});

// ============================================================================
// replaceDecisions
// ============================================================================

describe('replaceDecisions', () => {
  it('adds new decisions to an empty store', () => {
    const d = makeDecision({ id: 'aaaa0001' });
    const store: DecisionStore = { ...emptyStore(), decisions: [] };
    const result = replaceDecisions(store, [d]);
    expect(result.decisions).toHaveLength(1);
  });

  it('overwrites an existing decision with the same id', () => {
    const existing = makeDecision({ id: 'aaaa0001', status: 'rejected', title: 'Old' });
    const incoming = makeDecision({ id: 'aaaa0001', status: 'verified', title: 'New' });
    const store: DecisionStore = { ...emptyStore(), decisions: [existing] };
    const result = replaceDecisions(store, [incoming]);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].status).toBe('verified');
    expect(result.decisions[0].title).toBe('New');
  });

  it('models the consolidation scenario: rejected draft replaced by verified', () => {
    // Simulate: patchDecision marks draft rejected, then replaceDecisions overwrites with verified
    const draft = makeDecision({ id: 'aaaa0001', status: 'draft', title: 'Use SQLite' });
    let store: DecisionStore = { ...emptyStore(), decisions: [draft] };
    store = patchDecision(store, 'aaaa0001', { status: 'rejected' });
    expect(store.decisions[0].status).toBe('rejected');
    // replaceDecisions must overwrite the rejected placeholder
    const verified = makeDecision({ id: 'aaaa0001', status: 'verified', title: 'Use SQLite' });
    store = replaceDecisions(store, [verified]);
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0].status).toBe('verified');
  });

  it('preserves unrelated decisions when replacing a subset', () => {
    const d1 = makeDecision({ id: 'aaaa0001', status: 'approved' });
    const d2 = makeDecision({ id: 'bbbb0002', status: 'draft' });
    const store: DecisionStore = { ...emptyStore(), decisions: [d1, d2] };
    const replacement = makeDecision({ id: 'bbbb0002', status: 'verified' });
    const result = replaceDecisions(store, [replacement]);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.find(d => d.id === 'aaaa0001')?.status).toBe('approved');
    expect(result.decisions.find(d => d.id === 'bbbb0002')?.status).toBe('verified');
  });
});

// ============================================================================
// applyConsolidationResult
// ============================================================================

describe('applyConsolidationResult', () => {
  it('transitions a draft to verified when the consolidated decision reuses its id', () => {
    // The bug this guards: consolidated decisions reuse their drafts' deterministic ids.
    // An upsert would see the id already present and silently drop the verified status,
    // leaving the decision stuck as a draft. applyConsolidationResult must overwrite it.
    const draft = makeDecision({ id: 'aaaa0001', status: 'draft', title: 'Use SQLite' });
    const store: DecisionStore = { ...emptyStore(), decisions: [draft] };
    const verified = makeDecision({ id: 'aaaa0001', status: 'verified', title: 'Use SQLite' });

    const result = applyConsolidationResult(store, { verified: [verified], phantom: [], supersededIds: [] });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].status).toBe('verified');
    // Contrast: the buggy upsert path would leave it as a draft.
    const upserted = upsertDecisions(store, [verified]);
    expect(upserted.decisions[0].status).toBe('draft');
  });

  it('marks superseded drafts rejected and persists phantom decisions', () => {
    const primary = makeDecision({ id: 'aaaa0001', status: 'draft' });
    const absorbed = makeDecision({ id: 'bbbb0002', status: 'draft' });
    const store: DecisionStore = { ...emptyStore(), decisions: [primary, absorbed] };
    const verified = makeDecision({ id: 'aaaa0001', status: 'verified' });
    const phantom = makeDecision({ id: 'cccc0003', status: 'phantom' });

    const result = applyConsolidationResult(store, {
      verified: [verified],
      phantom: [phantom],
      supersededIds: ['bbbb0002'],
    });

    expect(result.decisions.find(d => d.id === 'aaaa0001')?.status).toBe('verified');
    expect(result.decisions.find(d => d.id === 'bbbb0002')?.status).toBe('rejected');
    expect(result.decisions.find(d => d.id === 'cccc0003')?.status).toBe('phantom');
  });
});

// ============================================================================
// purgeInactiveDecisions
// ============================================================================

describe('purgeInactiveDecisions', () => {
  it('removes synced decisions', () => {
    const store: DecisionStore = {
      ...emptyStore(),
      decisions: [
        makeDecision({ id: 'aaaa0001', status: 'synced' }),
        makeDecision({ id: 'bbbb0002', status: 'approved' }),
      ],
    };
    const result = purgeInactiveDecisions(store);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].id).toBe('bbbb0002');
  });

  it('removes rejected and phantom decisions', () => {
    const store: DecisionStore = {
      ...emptyStore(),
      decisions: [
        makeDecision({ id: 'aaaa0001', status: 'rejected' }),
        makeDecision({ id: 'bbbb0002', status: 'phantom' }),
        makeDecision({ id: 'cccc0003', status: 'verified' }),
      ],
    };
    const result = purgeInactiveDecisions(store);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].id).toBe('cccc0003');
  });

  it('preserves all active statuses', () => {
    const store: DecisionStore = {
      ...emptyStore(),
      decisions: [
        makeDecision({ id: 'aaaa0001', status: 'draft' }),
        makeDecision({ id: 'bbbb0002', status: 'consolidated' }),
        makeDecision({ id: 'cccc0003', status: 'verified' }),
        makeDecision({ id: 'dddd0004', status: 'approved' }),
      ],
    };
    const result = purgeInactiveDecisions(store);
    expect(result.decisions).toHaveLength(4);
  });

  it('returns empty decisions when all inactive', () => {
    const store: DecisionStore = {
      ...emptyStore(),
      decisions: [
        makeDecision({ id: 'aaaa0001', status: 'synced' }),
        makeDecision({ id: 'bbbb0002', status: 'rejected' }),
      ],
    };
    const result = purgeInactiveDecisions(store);
    expect(result.decisions).toHaveLength(0);
  });
});

// ============================================================================
// patchDecision
// ============================================================================

describe('patchDecision', () => {
  it('updates only the specified decision', () => {
    const d1 = makeDecision({ id: 'aaaa0001', status: 'draft' });
    const d2 = makeDecision({ id: 'bbbb0002', status: 'draft' });
    const store: DecisionStore = { ...emptyStore(), decisions: [d1, d2] };
    const result = patchDecision(store, 'aaaa0001', { status: 'approved' });
    expect(result.decisions.find(d => d.id === 'aaaa0001')?.status).toBe('approved');
    expect(result.decisions.find(d => d.id === 'bbbb0002')?.status).toBe('draft');
  });

  it('returns an unchanged store when the id is not found', () => {
    const d = makeDecision({ id: 'aaaa0001' });
    const store: DecisionStore = { ...emptyStore(), decisions: [d] };
    const result = patchDecision(store, 'notexist', { status: 'approved' });
    expect(result.decisions[0].status).toBe('draft');
  });

  it('merges partial patch without losing other fields', () => {
    const d = makeDecision({ id: 'aaaa0001', status: 'draft', title: 'Original' });
    const store: DecisionStore = { ...emptyStore(), decisions: [d] };
    const result = patchDecision(store, 'aaaa0001', { status: 'approved', reviewedAt: '2026-01-02T00:00:00.000Z' });
    const patched = result.decisions[0];
    expect(patched.status).toBe('approved');
    expect(patched.title).toBe('Original');
    expect(patched.reviewedAt).toBe('2026-01-02T00:00:00.000Z');
  });
});

// ============================================================================
// getDecisionsByStatus
// ============================================================================

describe('getDecisionsByStatus', () => {
  it('returns only decisions matching the given status', () => {
    const store: DecisionStore = {
      ...emptyStore(),
      decisions: [
        makeDecision({ id: '0001', status: 'draft' }),
        makeDecision({ id: '0002', status: 'approved' }),
        makeDecision({ id: '0003', status: 'draft' }),
      ],
    };
    const drafts = getDecisionsByStatus(store, 'draft');
    expect(drafts).toHaveLength(2);
    expect(drafts.every(d => d.status === 'draft')).toBe(true);
  });

  it('returns empty array when no decisions match', () => {
    const store: DecisionStore = {
      ...emptyStore(),
      decisions: [makeDecision({ id: '0001', status: 'draft' })],
    };
    expect(getDecisionsByStatus(store, 'synced')).toHaveLength(0);
  });
});

// ============================================================================
// loadDecisionStore / saveDecisionStore (real fs)
// ============================================================================

describe('loadDecisionStore', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('returns an empty store with a fresh sessionId when no file exists', async () => {
    const store = await loadDecisionStore(tmpDir);
    expect(store.decisions).toHaveLength(0);
    expect(store.version).toBe('1');
    expect(store.sessionId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('round-trips a store via saveDecisionStore + loadDecisionStore', async () => {
    const d = makeDecision();
    const original: DecisionStore = { version: '1', sessionId: 'abc123def456', updatedAt: '2026-01-01T00:00:00.000Z', decisions: [d] };
    await saveDecisionStore(tmpDir, original);
    const loaded = await loadDecisionStore(tmpDir);
    expect(loaded.sessionId).toBe('abc123def456');
    expect(loaded.decisions).toHaveLength(1);
    expect(loaded.decisions[0].id).toBe('aaaabbbb');
  });

  it('labels pre-provenance decisions as legacy/unknown', async () => {
    const dir = decisionsDir(tmpDir);
    await mkdir(dir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    const legacy = { ...makeDecision() } as Partial<PendingDecision>;
    delete legacy.contentOrigin;
    await writeFile(join(dir, 'pending.json'), JSON.stringify({ ...emptyStore(), decisions: [legacy] }), 'utf-8');
    const loaded = await loadDecisionStore(tmpDir);
    expect(loaded.decisions[0].contentOrigin).toBe('legacy-unknown');
  });

  it('quarantines (never silently empties) a corrupt store on JSON parse error', async () => {
    // harden-memory-integrity-invariant: a torn store must not be silently
    // substituted with empty — it is moved aside to *.corrupt-<n> and signaled.
    const { logger } = await import('../../utils/logger.js');
    const dir = decisionsDir(tmpDir);
    await mkdir(dir, { recursive: true });
    const { writeFile, readdir } = await import('node:fs/promises');
    await writeFile(join(dir, 'pending.json'), 'not valid json', 'utf-8');
    const store = await loadDecisionStore(tmpDir);
    expect(store.decisions).toHaveLength(0); // degrades to empty (no crash)
    expect(vi.mocked(logger.warning)).toHaveBeenCalledWith(
      expect.stringContaining('store quarantine'),
    );
    // The corrupt bytes are preserved on disk, not dropped.
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith('pending.json.corrupt-'))).toBe(true);
  });
});

describe('saveDecisionStore', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('creates the decisions directory if it does not exist', async () => {
    const store = emptyStore();
    await saveDecisionStore(tmpDir, store);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(decisionsDir(tmpDir), 'pending.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('updates updatedAt on save', async () => {
    const store: DecisionStore = { version: '1', sessionId: 'abc', updatedAt: '2000-01-01T00:00:00.000Z', decisions: [] };
    await saveDecisionStore(tmpDir, store);
    const loaded = await loadDecisionStore(tmpDir);
    expect(loaded.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });
});

// ── illegalPromotionToApproved (the status-transition table) ──────────────────
// fix-decision-status-transitions: one explicit table over the full status
// vocabulary decides which statuses may be promoted to `approved`.
describe('illegalPromotionToApproved', () => {
  it('allows every promotable status (legal lifecycle is unchanged)', () => {
    for (const status of ['draft', 'consolidated', 'verified', 'phantom', 'approved', 'auto-approved'] as const) {
      expect(PROMOTABLE_TO_APPROVED.has(status)).toBe(true);
      expect(illegalPromotionToApproved('abc12345', status)).toBeNull();
    }
  });

  it('refuses a rejected decision and names the required human step', () => {
    const err = illegalPromotionToApproved('abc12345', 'rejected', 'not worth the infra');
    expect(err).not.toBeNull();
    expect(err).toMatch(/rejected by a human/);
    expect(err).toMatch(/not worth the infra/); // discloses the recorded verdict
    expect(err).toMatch(/re-record/);           // the explicit reversal path
    expect(PROMOTABLE_TO_APPROVED.has('rejected')).toBe(false);
  });

  it('refuses an already-synced decision', () => {
    const err = illegalPromotionToApproved('abc12345', 'synced');
    expect(err).toMatch(/already synced/);
    expect(PROMOTABLE_TO_APPROVED.has('synced')).toBe(false);
  });

  it('omits the note clause when a rejected decision has no review note', () => {
    const err = illegalPromotionToApproved('abc12345', 'rejected');
    expect(err).toMatch(/rejected by a human and will not/);
    expect(err).not.toMatch(/rejection note/);
  });
});
