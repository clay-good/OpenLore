/**
 * Tests for the openlore decisions programmatic API — the promotion guard on
 * openloreSyncDecisions.
 *
 * fix-decision-status-transitions: the API's id-scoped sync must refuse to
 * promote a rejected (or already-synced) decision to approved, the same way the
 * MCP handler and the CLI do — one shared transition table, every door locked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ saveLogs: vi.fn(async () => {}) }));

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('../utils/command-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/command-helpers.js')>();
  return { ...actual, fileExists: vi.fn(async () => true) };
});

vi.mock('../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(async () => ({ version: '1.0.0', openspecPath: './openspec' })),
}));

vi.mock('../core/services/llm-service.js', () => ({
  createLLMService: vi.fn(() => ({ saveLogs: mocks.saveLogs })),
}));

vi.mock('../core/decisions/consolidator.js', () => ({
  consolidateDrafts: vi.fn(),
}));

vi.mock('../core/drift/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/drift/index.js')>();
  return {
    ...actual,
    buildSpecMap: vi.fn(async () => ({})),
    isGitRepositoryRoot: vi.fn(async () => false),
    resolveBaseRef: vi.fn(async () => 'main'),
    getChangedFiles: vi.fn(async () => ({ files: [{ path: 'src/example.ts' }] })),
    getFileDiff: vi.fn(async () => 'diff --git a/src/example.ts b/src/example.ts\n+changed'),
    getCommitMessages: vi.fn(async () => 'feat: change'),
  };
});

vi.mock('../core/decisions/verifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/decisions/verifier.js')>();
  return { ...actual, verifyDecisions: vi.fn() };
});

vi.mock('../core/decisions/syncer.js', () => ({
  syncApprovedDecisions: vi.fn(async (store: unknown) => ({
    store,
    result: { synced: [], errors: [], modifiedSpecs: [] },
  })),
}));

// Keep the real store module (real illegalPromotionToApproved) but stub the disk read.
vi.mock('../core/decisions/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/decisions/store.js')>();
  return {
    ...actual,
    loadDecisionStore: vi.fn(),
    updateDecisionStore: vi.fn(),
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { openloreConsolidateDecisions, openloreSyncDecisions } from './decisions.js';
import { loadDecisionStore, updateDecisionStore } from '../core/decisions/store.js';
import { syncApprovedDecisions } from '../core/decisions/syncer.js';
import { consolidateDrafts } from '../core/decisions/consolidator.js';
import { verifyDecisions } from '../core/decisions/verifier.js';
import { isGitRepositoryRoot } from '../core/drift/index.js';
import type { DecisionStore, PendingDecision } from '../types/index.js';

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'abc12345',
    status: 'draft',
    title: 'Use SQLite for edges',
    rationale: 'JSON too large at scale',
    consequences: 'Requires migration',
    proposedRequirement: null,
    affectedDomains: [],
    affectedFiles: [],
    sessionId: 'test-session',
    recordedAt: '2026-01-01T00:00:00.000Z',
    contentOrigin: 'agent-recorded',
    confidence: 'medium',
    syncedToSpecs: [],
    ...overrides,
  };
}

function makeStore(decisions: PendingDecision[]): DecisionStore {
  return { version: '1', sessionId: 'test-session', updatedAt: '2026-01-01T00:00:00.000Z', decisions };
}

describe('openloreSyncDecisions — status-transition guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) =>
      mutate(await vi.mocked(loadDecisionStore).mock.results.at(-1)!.value),
    );
  });

  it('refuses to promote a rejected decision by id; sync never runs', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'rejected', reviewNote: 'Rejected on review' });
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([decision]));

    await expect(
      openloreSyncDecisions({ rootPath: '/test/project', ids: ['abc12345'] }),
    ).rejects.toThrow(/rejected by a human/);
    expect(syncApprovedDecisions).not.toHaveBeenCalled();
  });

  it('refuses to re-promote an already-synced decision by id', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'synced' });
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([decision]));

    await expect(
      openloreSyncDecisions({ rootPath: '/test/project', ids: ['abc12345'] }),
    ).rejects.toThrow(/already synced/);
    expect(syncApprovedDecisions).not.toHaveBeenCalled();
  });

  it('promotes and syncs a legal (verified) decision by id — lifecycle unchanged', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'verified' });
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([decision]));

    await openloreSyncDecisions({ rootPath: '/test/project', ids: ['abc12345'] });

    expect(syncApprovedDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.arrayContaining([
          expect.objectContaining({ id: 'abc12345', status: 'approved' }),
        ]),
      }),
      expect.anything(),
    );
  });

  it('observes a rejection committed after the initial read and before promotion', async () => {
    const verified = makeDecision({ status: 'verified' });
    const rejected = makeDecision({ status: 'rejected', reviewNote: 'Rejected concurrently' });
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([verified]));
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) => mutate(makeStore([rejected])));

    await expect(openloreSyncDecisions({ rootPath: '/test/project', ids: [verified.id] }))
      .rejects.toThrow(/rejected by a human/);
    expect(syncApprovedDecisions).not.toHaveBeenCalled();
  });
});

describe('openloreConsolidateDecisions — verification evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks non-git decisions as having no verification evidence and saves LLM logs', async () => {
    const draft = makeDecision();
    const store = makeStore([draft]);
    vi.mocked(loadDecisionStore).mockResolvedValue(store);
    vi.mocked(updateDecisionStore).mockResolvedValue(store);
    vi.mocked(consolidateDrafts).mockResolvedValue({ decisions: [draft], supersededIds: [] });

    const result = await openloreConsolidateDecisions({ rootPath: '/test/project', provider: 'anthropic' });

    expect(result.verified).toEqual([
      expect.objectContaining({ id: draft.id, status: 'verified', verificationEvidence: 'none' }),
    ]);
    expect(mocks.saveLogs).toHaveBeenCalledOnce();
  });

  it('saves logs after git-diff verification has made its LLM request', async () => {
    const draft = makeDecision({ affectedFiles: ['src/example.ts'] });
    const store = makeStore([draft]);
    vi.mocked(loadDecisionStore).mockResolvedValue(store);
    vi.mocked(updateDecisionStore).mockResolvedValue(store);
    vi.mocked(consolidateDrafts).mockResolvedValue({ decisions: [draft], supersededIds: [] });
    vi.mocked(isGitRepositoryRoot).mockResolvedValue(true);
    vi.mocked(verifyDecisions).mockImplementation(async () => {
      expect(mocks.saveLogs).not.toHaveBeenCalled();
      return { verified: [draft], phantom: [], missing: [] };
    });

    await openloreConsolidateDecisions({ rootPath: '/test/project', provider: 'anthropic' });

    expect(verifyDecisions).toHaveBeenCalledOnce();
    expect(mocks.saveLogs).toHaveBeenCalledOnce();
  });
});
