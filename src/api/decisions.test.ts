/**
 * Tests for the openlore decisions programmatic API — the promotion guard on
 * openloreSyncDecisions.
 *
 * fix-decision-status-transitions: the API's id-scoped sync must refuse to
 * promote a rejected (or already-synced) decision to approved, the same way the
 * MCP handler and the CLI do — one shared transition table, every door locked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';

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

import { openloreConsolidateDecisions, openloreRecordDecision, openloreSyncDecisions } from './decisions.js';
import { INACTIVE_STATUSES, loadDecisionStore, updateDecisionStore } from '../core/decisions/store.js';
import { syncApprovedDecisions } from '../core/decisions/syncer.js';
import { consolidateDrafts } from '../core/decisions/consolidator.js';
import { verifyDecisions } from '../core/decisions/verifier.js';
import { projectDecisions } from '../core/decisions/project.js';
import { isGitRepositoryRoot } from '../core/drift/index.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { logger } from '../utils/logger.js';
import type { DecisionStore, PendingDecision } from '../types/index.js';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_COMPAT_API_KEY;
  delete process.env.OPENAI_COMPAT_BASE_URL;
});

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

describe('decision API boundary contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes the root and honors configPath during sync', async () => {
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([]));

    await openloreSyncDecisions({
      rootPath: 'relative-project',
      configPath: 'config/custom.json',
      dryRun: true,
    });

    expect(readOpenLoreConfig).toHaveBeenCalledWith(resolve('relative-project'), 'config/custom.json');
    expect(loadDecisionStore).toHaveBeenCalledWith(resolve('relative-project'));
  });

  it('normalizes the root when recording a decision', async () => {
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([]));

    await openloreRecordDecision({
      rootPath: 'relative-project',
      title: 'Use stable API errors',
      rationale: 'Callers need machine-readable failures',
    });

    expect(loadDecisionStore).toHaveBeenCalledWith(resolve('relative-project'));
    expect(updateDecisionStore).toHaveBeenCalledWith(resolve('relative-project'), expect.any(Function));
  });

  it('is silent by default even when a decision helper logs an error', async () => {
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([]));
    vi.mocked(syncApprovedDecisions).mockImplementationOnce(async (store) => {
      logger.error('hidden decision diagnostic');
      return { store, result: { synced: [], errors: [], modifiedSpecs: [] } };
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await openloreSyncDecisions({ rootPath: '/test/project', dryRun: true });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('returns the named no-config error for a missing explicit config', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValueOnce(null);

    await expect(openloreSyncDecisions({
      rootPath: '/test/project',
      configPath: 'config/missing.json',
    })).rejects.toMatchObject({ code: 'no-config' });
  });

  it('wraps unexpected decision failures with a typed error and original cause', async () => {
    const cause = new Error('store unreadable');
    vi.mocked(loadDecisionStore).mockRejectedValueOnce(cause);

    await expect(openloreConsolidateDecisions({
      rootPath: '/test/project',
      provider: 'anthropic',
    })).rejects.toMatchObject({ code: 'pipeline-failed', cause });
  });

  it('requires the credential for the selected configured provider', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValueOnce({
      version: '1.0.0',
      openspecPath: './openspec',
      generation: { provider: 'openai', model: 'gpt-5' },
    } as never);

    await expect(openloreConsolidateDecisions({ rootPath: '/test/project' }))
      .rejects.toMatchObject({ code: 'no-api-key' });
    expect(createLLMService).not.toHaveBeenCalled();
  });

  it('uses configured generation settings for OpenAI-compatible consolidation', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_COMPAT_API_KEY = 'compat-key';
    process.env.OPENAI_COMPAT_BASE_URL = 'https://trusted.example/v1';
    vi.mocked(readOpenLoreConfig).mockResolvedValueOnce({
      version: '1.0.0',
      openspecPath: './openspec',
      generation: {
        provider: 'openai-compat',
        model: 'custom-model',
        timeout: 4567,
        disableResponseFormat: true,
      },
    } as never);
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([]));
    vi.mocked(consolidateDrafts).mockResolvedValue({ decisions: [], supersededIds: [], dispositions: [] });

    await openloreConsolidateDecisions({ rootPath: '/test/project' });

    expect(createLLMService).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai-compat',
      model: 'custom-model',
      openaiCompatBaseUrl: 'https://trusted.example/v1',
      timeout: 4567,
      disableResponseFormat: true,
    }));
  });
});

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
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) => mutate(store));
    vi.mocked(consolidateDrafts).mockResolvedValue({ decisions: [draft], supersededIds: [], dispositions: [{ id: draft.id, disposition: "promoted", reason: "promoted-as-recorded" }] });

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
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) => mutate(store));
    vi.mocked(consolidateDrafts).mockResolvedValue({ decisions: [draft], supersededIds: [], dispositions: [{ id: draft.id, disposition: "promoted", reason: "promoted-as-recorded" }] });
    vi.mocked(isGitRepositoryRoot).mockResolvedValue(true);
    vi.mocked(verifyDecisions).mockImplementation(async () => {
      expect(mocks.saveLogs).not.toHaveBeenCalled();
      return { verified: [draft], phantom: [], unassessed: [], missing: [] };
    });

    await openloreConsolidateDecisions({ rootPath: '/test/project', provider: 'anthropic' });

    expect(verifyDecisions).toHaveBeenCalledOnce();
    expect(mocks.saveLogs).toHaveBeenCalledOnce();
  });

  it('settles absorbed drafts and preserves a draft recorded during consolidation', async () => {
    const kept = makeDecision({ id: 'keep0001' });
    const absorbed = makeDecision({ id: 'drop0002', title: 'Related draft' });
    const concurrent = makeDecision({ id: 'later003', title: 'Recorded concurrently' });
    const initial = makeStore([kept, absorbed]);
    const fresh = makeStore([kept, absorbed, concurrent]);
    vi.mocked(loadDecisionStore).mockResolvedValue(initial);
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) => mutate(fresh));
    vi.mocked(isGitRepositoryRoot).mockResolvedValue(false);
    vi.mocked(consolidateDrafts).mockResolvedValue({
      decisions: [{ ...kept, status: 'consolidated' }],
      supersededIds: [],
      dispositions: [
        { id: kept.id, disposition: 'promoted', reason: 'promoted-as-recorded' },
        { id: absorbed.id, disposition: 'merged-into', reason: 'merged-into-consolidated', mergedIntoId: kept.id },
      ],
    });

    const result = await openloreConsolidateDecisions({ rootPath: '/test/project', provider: 'anthropic' });

    expect(result.store.decisions.find(d => d.id === kept.id)).toMatchObject({
      status: 'verified', disposition: 'promoted', dispositionReason: 'promoted-as-recorded',
    });
    expect(result.store.decisions.find(d => d.id === absorbed.id)).toMatchObject({
      status: 'rejected', disposition: 'merged-into',
      dispositionReason: 'merged-into-consolidated', mergedIntoId: kept.id,
    });
    expect(result.store.decisions.find(d => d.id === concurrent.id)).toEqual(concurrent);
  });

  it('retains every original draft when consolidation keeps nothing', async () => {
    const first = makeDecision({ id: 'draft001' });
    const second = makeDecision({ id: 'draft002', title: 'Non-architectural refactor' });
    const initial = makeStore([first, second]);
    vi.mocked(loadDecisionStore).mockResolvedValue(initial);
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) => mutate(initial));
    vi.mocked(isGitRepositoryRoot).mockResolvedValue(false);
    vi.mocked(consolidateDrafts).mockResolvedValue({
      decisions: [],
      supersededIds: [],
      dispositions: [
        { id: first.id, disposition: 'rejected', reason: 'not-in-consolidated-set' },
        { id: second.id, disposition: 'rejected', reason: 'not-in-consolidated-set' },
      ],
    });

    const result = await openloreConsolidateDecisions({ rootPath: '/test/project', provider: 'anthropic' });

    expect(result.unassessed).toEqual([first, second]);
    expect(result.store.decisions).toEqual([first, second]);
  });

  it('rejects an absorbed draft instead of pointing it at a phantom survivor', async () => {
    const survivor = makeDecision({ id: 'phantom1', affectedFiles: ['src/example.ts'] });
    const absorbed = makeDecision({ id: 'merged02', affectedFiles: ['src/example.ts'] });
    const initial = makeStore([survivor, absorbed]);
    const phantom = { ...survivor, status: 'phantom' as const };
    vi.mocked(loadDecisionStore).mockResolvedValue(initial);
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) => mutate(initial));
    vi.mocked(consolidateDrafts).mockResolvedValue({
      decisions: [{ ...survivor, status: 'consolidated' }],
      supersededIds: [],
      dispositions: [
        { id: survivor.id, disposition: 'promoted', reason: 'promoted-as-recorded' },
        { id: absorbed.id, disposition: 'merged-into', reason: 'merged-into-consolidated', mergedIntoId: survivor.id },
      ],
    });
    vi.mocked(isGitRepositoryRoot).mockResolvedValue(true);
    vi.mocked(verifyDecisions).mockResolvedValue({ verified: [], phantom: [phantom], unassessed: [], missing: [] });

    const result = await openloreConsolidateDecisions({ rootPath: '/test/project', provider: 'anthropic' });

    expect(result.store.decisions.find(d => d.id === survivor.id)).toMatchObject({
      status: 'phantom', disposition: 'rejected', dispositionReason: 'no-supporting-diff',
    });
    expect(result.store.decisions.find(d => d.id === absorbed.id)).toMatchObject({
      status: 'rejected', disposition: 'rejected', dispositionReason: 'no-supporting-diff',
    });
    expect(result.store.decisions.find(d => d.id === absorbed.id)?.mergedIntoId).toBeUndefined();
  });

  it('retains and returns a decision omitted by verification as an unassessed draft', async () => {
    const assessed = makeDecision({ id: 'assess01', affectedFiles: ['src/example.ts'] });
    const absorbed = makeDecision({ id: 'absorb02', title: 'Absorbed intent', affectedFiles: ['src/example.ts'] });
    const omitted = makeDecision({ id: 'omit0002', title: 'Original title', affectedFiles: ['src/example.ts'] });
    const rewritten = { ...omitted, status: 'consolidated' as const, title: 'Rewritten survivor', rationale: 'Includes both intents' };
    const initial = makeStore([assessed, omitted, absorbed]);
    vi.mocked(loadDecisionStore).mockResolvedValue(initial);
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) => mutate(initial));
    vi.mocked(consolidateDrafts).mockResolvedValue({
      decisions: [
        { ...assessed, status: 'consolidated' },
        rewritten,
      ],
      supersededIds: [],
      dispositions: [
        { id: assessed.id, disposition: 'promoted', reason: 'promoted-as-recorded' },
        { id: omitted.id, disposition: 'promoted', reason: 'promoted-as-recorded' },
        { id: absorbed.id, disposition: 'merged-into', reason: 'merged-into-consolidated', mergedIntoId: omitted.id },
      ],
    });
    vi.mocked(isGitRepositoryRoot).mockResolvedValue(true);
    vi.mocked(verifyDecisions).mockResolvedValue({
      verified: [{ ...assessed, status: 'verified' }],
      phantom: [],
      unassessed: [rewritten],
      missing: [],
    });

    const result = await openloreConsolidateDecisions({ rootPath: '/test/project', provider: 'anthropic' });

    expect(result.unassessed).toEqual([
      expect.objectContaining({ id: omitted.id, status: 'draft', title: 'Rewritten survivor' }),
    ]);
    expect(result.store.decisions.find(({ id }) => id === omitted.id)).toMatchObject({
      id: omitted.id,
      status: 'draft',
      title: 'Rewritten survivor',
      rationale: 'Includes both intents',
      recordedAt: omitted.recordedAt,
    });
    expect(INACTIVE_STATUSES.has(result.store.decisions.find(({ id }) => id === omitted.id)!.status)).toBe(false);
    expect(projectDecisions(result.store).nodes).toContainEqual(
      expect.objectContaining({ decisionId: omitted.id, status: 'draft', title: 'Rewritten survivor' }),
    );
    expect(result.store.decisions.find(({ id }) => id === absorbed.id)).toMatchObject({
      status: 'rejected',
      disposition: 'merged-into',
      mergedIntoId: omitted.id,
    });
  });

  it('returns the committed human verdict when it races a verified classification', async () => {
    const draft = makeDecision({ affectedFiles: ['src/example.ts'] });
    const rejected = { ...draft, status: 'rejected' as const, reviewedAt: '2026-08-16T00:00:00.000Z' };
    const initial = makeStore([draft]);
    vi.mocked(loadDecisionStore).mockResolvedValue(initial);
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) => mutate(makeStore([rejected])));
    vi.mocked(consolidateDrafts).mockResolvedValue({
      decisions: [{ ...draft, status: 'consolidated' }],
      supersededIds: [],
      dispositions: [{ id: draft.id, disposition: 'promoted', reason: 'promoted-as-recorded' }],
    });
    vi.mocked(isGitRepositoryRoot).mockResolvedValue(true);
    vi.mocked(verifyDecisions).mockResolvedValue({
      verified: [{ ...draft, status: 'verified' }],
      phantom: [],
      unassessed: [],
      missing: [],
    });

    const result = await openloreConsolidateDecisions({ rootPath: '/test/project', provider: 'anthropic' });

    expect(result.verified).toEqual([rejected]);
    expect(result.store.decisions).toEqual([rejected]);
  });

  it('returns committed records for every unassessed id when consolidation has no survivor', async () => {
    const draft = makeDecision();
    const approved = { ...draft, status: 'approved' as const, reviewedAt: '2026-08-16T00:00:00.000Z' };
    const initial = makeStore([draft]);
    vi.mocked(loadDecisionStore).mockResolvedValue(initial);
    vi.mocked(updateDecisionStore).mockImplementation(async (_root, mutate) => mutate(makeStore([approved])));
    vi.mocked(consolidateDrafts).mockResolvedValue({
      decisions: [],
      supersededIds: [],
      dispositions: [{ id: draft.id, disposition: 'rejected', reason: 'not-in-consolidated-set' }],
    });

    const result = await openloreConsolidateDecisions({ rootPath: '/test/project', provider: 'anthropic' });

    expect(result.unassessed).toEqual([approved]);
    expect(result.store.decisions).toEqual([approved]);
  });
});
