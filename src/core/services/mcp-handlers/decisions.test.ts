/**
 * Tests for MCP decision handlers:
 *   handleRecordDecision, handleListDecisions,
 *   handleApproveDecision, handleRejectDecision, handleSyncDecisions
 *
 * Strategy: mock validateDirectory to return tmpDir so real store file I/O
 * runs against the temp directory. Mock spawn (background consolidation),
 * syncApprovedDecisions, buildSpecMap, and readOpenLoreConfig.
 */

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

import { vi } from 'vitest';

vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
  return {
    ...actual,
    validateDirectory: vi.fn(async (dir: string) => dir),
  };
});

// The hardened spawnConsolidateBackground awaits the earlier of the child's
// 'spawn'/'error' event, so a mock child MUST emit one or the handler hangs.
// Default: emit 'spawn' on the next microtask (the happy path → outcome
// 'started'). The ENOENT test overrides this with a child that emits 'error'.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const child = {
      unref: vi.fn(),
      on(event: string, cb: (...a: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
        return child;
      },
    };
    queueMicrotask(() => (listeners['spawn'] ?? []).forEach((cb) => cb()));
    return child;
  }),
}));

vi.mock('../config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(async () => null),
}));

vi.mock('../../../core/drift/spec-mapper.js', () => ({
  buildSpecMap: vi.fn(async () => ({})),
  matchFileToDomains: vi.fn(() => []),
}));

vi.mock('../../decisions/syncer.js', () => ({
  syncApprovedDecisions: vi.fn(async (store: unknown) => ({
    store,
    result: { synced: [], errors: [], modifiedSpecs: [] },
  })),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DecisionStore, PendingDecision } from '../../../types/index.js';
import {
  OPENLORE_DIR,
  OPENLORE_DECISIONS_SUBDIR,
  DECISIONS_PENDING_FILE,
} from '../../../constants.js';
import {
  handleRecordDecision,
  handleListDecisions,
  handleApproveDecision,
  handleRejectDecision,
  handleSyncDecisions,
} from './decisions.js';
import { validateDirectory } from './utils.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { syncApprovedDecisions } from '../../decisions/syncer.js';
import { updateDecisionStore } from '../../decisions/store.js';
import { spawn } from 'node:child_process';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeStore(overrides: Partial<DecisionStore> = {}): DecisionStore {
  return {
    version: '1',
    sessionId: 'test-session',
    updatedAt: '2026-01-01T00:00:00.000Z',
    decisions: [],
    ...overrides,
  };
}

async function writeStore(rootPath: string, store: DecisionStore): Promise<void> {
  const dir = join(rootPath, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, DECISIONS_PENDING_FILE), JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

async function readStore(rootPath: string): Promise<DecisionStore> {
  const path = join(rootPath, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR, DECISIONS_PENDING_FILE);
  return JSON.parse(await readFile(path, 'utf-8')) as DecisionStore;
}

// ── handleRecordDecision ──────────────────────────────────────────────────────

describe('handleRecordDecision', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-decisions-test-'));
    vi.clearAllMocks();
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns error when title is empty', async () => {
    const result = await handleRecordDecision(tmpDir, '', 'some rationale') as { error: string };
    expect(result.error).toMatch(/title is required/);
  });

  it('returns error when title is whitespace only', async () => {
    const result = await handleRecordDecision(tmpDir, '   ', 'some rationale') as { error: string };
    expect(result.error).toMatch(/title is required/);
  });

  it('returns error when rationale is empty', async () => {
    const result = await handleRecordDecision(tmpDir, 'My decision', '') as { error: string };
    expect(result.error).toMatch(/rationale is required/);
  });

  it('records a draft decision and returns an id', async () => {
    const result = await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big') as { id: string; message: string };
    expect(result.id).toHaveLength(8);
    expect(result.message).toContain('Use SQLite');
  });

  it('returns the draft status and the exact command that reads the verdict', async () => {
    // The tool proposes a decision; it does not finalize one. The response must say
    // so and point at where the outcome will be readable
    // (change: explain-decision-rejection).
    const r = await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big') as {
      id: string; status: string; disposition: string; reason: string;
      readVerdictWith: string; message: string;
    };
    expect(r.status).toBe('draft');
    expect(r.disposition).toBe('pending');
    expect(r.reason).toBe('awaiting-consolidation');
    expect(r.readVerdictWith).toBe(`openlore decisions status ${r.id}`);
    expect(r.message).toMatch(/draft/i);
    expect(r.message).toContain(r.readVerdictWith);
  });

  it('returns the existing verdict when a decided draft is recorded again', async () => {
    const first = await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big') as { id: string };

    // Simulate consolidation having rejected it with a stated reason.
    const store = await readStore(tmpDir);
    store.decisions = store.decisions.map(d => d.id === first.id
      ? { ...d, status: 'rejected', disposition: 'rejected', dispositionReason: 'not-in-consolidated-set' }
      : d);
    await writeStore(tmpDir, store);

    const again = await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big') as {
      id: string; alreadyDecided: boolean; disposition: string; reason: string;
      nextAction?: string; message: string;
    };
    expect(again.alreadyDecided).toBe(true);
    expect(again.id).toBe(first.id);
    expect(again.disposition).toBe('rejected');
    expect(again.reason).toBe('not-in-consolidated-set');
    expect(again.nextAction).toMatch(/narrower subject|not architectural/i);
    expect(again.message).toMatch(/No new draft was created/);

    // …and no second draft was written.
    const after = await readStore(tmpDir);
    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0].status).toBe('rejected');
  });

  it('persists the decision with draft status to disk', async () => {
    await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big');
    const store = await readStore(tmpDir);
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0].title).toBe('Use SQLite');
    expect(store.decisions[0].status).toBe('draft');
    expect(store.decisions[0].rationale).toBe('JSON too big');
  });

  it('stores consequences and affectedFiles when provided', async () => {
    await handleRecordDecision(
      tmpDir, 'Use SQLite', 'JSON too big',
      'needs migration', ['src/store.ts'],
    );
    const store = await readStore(tmpDir);
    expect(store.decisions[0].consequences).toBe('needs migration');
    expect(store.decisions[0].affectedFiles).toEqual(['src/store.ts']);
  });

  it('stores supersedes id when provided', async () => {
    await handleRecordDecision(
      tmpDir, 'Use SQLite', 'JSON too big',
      undefined, undefined, 'deadbeef',
    );
    const store = await readStore(tmpDir);
    expect(store.decisions[0].supersedes).toBe('deadbeef');
  });

  it('does not duplicate when same title recorded twice (makeDecisionId is deterministic)', async () => {
    await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big');
    await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big');
    const store = await readStore(tmpDir);
    expect(store.decisions).toHaveLength(1);
  });

  it('stores default scope component when no promotion triggers fire', async () => {
    await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big');
    const store = await readStore(tmpDir);
    expect(store.decisions[0].scope).toBe('component');
  });

  it('respects explicit scope passed by caller', async () => {
    await handleRecordDecision(tmpDir, 'Global auth strategy', 'Use JWT everywhere',
      undefined, undefined, undefined, 'system');
    const store = await readStore(tmpDir);
    expect(store.decisions[0].scope).toBe('system');
  });

  it('structural trigger: files spanning 2+ top-level dirs → cross-domain', async () => {
    // src/api/ and src/core/ are distinct top-level dirs (2-segment key: src/api vs src/core)
    await handleRecordDecision(tmpDir, 'Shared cache layer',
      'Cache used by both API and core services',
      undefined, ['src/api/cache.ts', 'src/core/cache.ts']);
    const store = await readStore(tmpDir);
    expect(store.decisions[0].scope).toBe('cross-domain');
  });

  it('structural trigger does not fire for files in same top-level dir', async () => {
    await handleRecordDecision(tmpDir, 'Extract helper',
      'Refactor utility function',
      undefined, ['src/utils/a.ts', 'src/utils/b.ts']);
    const store = await readStore(tmpDir);
    expect(store.decisions[0].scope).toBe('component');
  });

  it('semantic trigger suppressed when rationale contains refactor keyword', async () => {
    const { matchFileToDomains } = await import('../../../core/drift/spec-mapper.js');
    vi.mocked(matchFileToDomains).mockReturnValue(['api', 'core']);
    await handleRecordDecision(tmpDir, 'Extract shared helper',
      'Refactor duplicate code into a shared utility',
      undefined, ['src/api/auth.ts']);
    const store = await readStore(tmpDir);
    expect(store.decisions[0].scope).toBe('component');
    vi.mocked(matchFileToDomains).mockReturnValue([]);
  });

  it('semantic trigger: multi-domain + contract keyword + not refactor → cross-domain', async () => {
    const { matchFileToDomains } = await import('../../../core/drift/spec-mapper.js');
    vi.mocked(matchFileToDomains).mockReturnValue(['api', 'services']);
    await handleRecordDecision(tmpDir, 'Shared auth contract',
      'Define authentication interface across API and service layer',
      undefined, ['src/auth/middleware.ts']);
    const store = await readStore(tmpDir);
    expect(store.decisions[0].scope).toBe('cross-domain');
    vi.mocked(matchFileToDomains).mockReturnValue([]);
  });

  // ── Background-consolidation robustness (harden-decision-consolidation) ──────

  it('reports consolidation started on a successful spawn', async () => {
    const result = await handleRecordDecision(tmpDir, 'A decision', 'Some rationale') as {
      id: string; consolidation: string; message: string;
    };
    expect(result.consolidation).toBe('started');
    expect(result.message).toMatch(/running in background/i);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('survives a failed spawn (ENOENT) and reports it honestly with a recovery command', async () => {
    // A missing binary makes Node emit 'error' on the child. Without the handler's
    // error listener this would be an uncaught exception in the MCP server; here it
    // must be contained and disclosed. (regression test for defect 1)
    vi.mocked(spawn).mockImplementationOnce(() => {
      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
      const child = {
        unref: vi.fn(),
        on(event: string, cb: (...a: unknown[]) => void) {
          (listeners[event] ??= []).push(cb);
          return child;
        },
      };
      const err = Object.assign(new Error('spawn openlore ENOENT'), { code: 'ENOENT' });
      queueMicrotask(() => (listeners['error'] ?? []).forEach((cb) => cb(err)));
      return child as never;
    });

    const result = await handleRecordDecision(tmpDir, 'A decision', 'Some rationale') as {
      id: string; consolidation: string; message: string;
    };

    // The decision itself was still recorded (the CAS write committed independently).
    expect(result.id).toBeTruthy();
    const store = await readStore(tmpDir);
    expect(store.decisions).toHaveLength(1);

    // The outcome is disclosed as failed, never a false "running in background".
    expect(result.consolidation).toBe('failed');
    expect(result.message).not.toMatch(/running in background/i);
    expect(result.message).toMatch(/could NOT be started/i);
    expect(result.message).toMatch(/openlore decisions --consolidate/);
  });

  it('coalesces onto an in-flight run instead of spawning a second consolidator', async () => {
    // Simulate a consolidation already underway by holding its lock (a fresh,
    // non-stale lock file). The handler must not spawn a second process.
    const decDir = join(tmpDir, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
    await mkdir(decDir, { recursive: true });
    await writeFile(join(decDir, '.consolidate.lock'), `${process.pid} ${new Date().toISOString()}`, 'utf-8');

    const result = await handleRecordDecision(tmpDir, 'A decision', 'Some rationale') as {
      id: string; consolidation: string; message: string;
    };

    expect(result.consolidation).toBe('coalesced');
    expect(result.message).toMatch(/already running/i);
    expect(spawn).not.toHaveBeenCalled();
    // The draft is still recorded so the in-flight run (or the next one) picks it up.
    const store = await readStore(tmpDir);
    expect(store.decisions).toHaveLength(1);
  });
});

// ── handleListDecisions ───────────────────────────────────────────────────────

describe('handleListDecisions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-decisions-test-'));
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns empty list when no store exists', async () => {
    const result = await handleListDecisions(tmpDir) as { total: number; decisions: unknown[] };
    expect(result.total).toBe(0);
    expect(result.decisions).toEqual([]);
  });

  it('returns all decisions when no status filter', async () => {
    const store = makeStore({
      decisions: [
        makeDecision({ id: 'aaa11111', status: 'draft', title: 'Decision A' }),
        makeDecision({ id: 'bbb22222', status: 'approved', title: 'Decision B' }),
      ],
    });
    await writeStore(tmpDir, store);
    const result = await handleListDecisions(tmpDir) as { total: number; decisions: Array<{ id: string }> };
    expect(result.total).toBe(2);
    expect(result.decisions.map((d) => d.id)).toEqual(['aaa11111', 'bbb22222']);
  });

  it('filters decisions by status', async () => {
    const store = makeStore({
      decisions: [
        makeDecision({ id: 'aaa11111', status: 'draft', title: 'Draft' }),
        makeDecision({ id: 'bbb22222', status: 'approved', title: 'Approved' }),
      ],
    });
    await writeStore(tmpDir, store);
    const result = await handleListDecisions(tmpDir, 'approved') as { total: number; decisions: Array<{ id: string; status: string }> };
    expect(result.total).toBe(1);
    expect(result.decisions[0].id).toBe('bbb22222');
    expect(result.decisions[0].status).toBe('approved');
  });

  it('returns mapped fields including proposedRequirement, syncedToSpecs, and verificationEvidence', async () => {
    const store = makeStore({
      decisions: [makeDecision({ proposedRequirement: 'REQ-001', syncedToSpecs: ['services'], verificationEvidence: 'none' })],
    });
    await writeStore(tmpDir, store);
    const result = await handleListDecisions(tmpDir) as { decisions: Array<Record<string, unknown>> };
    const d = result.decisions[0];
    expect(d.proposedRequirement).toBe('REQ-001');
    expect(d.syncedToSpecs).toEqual(['services']);
    expect(d.verificationEvidence).toBe('none');
  });

  it('keeps autopilot-synced decision prose locally unreviewed', async () => {
    const store = makeStore({
      decisions: [makeDecision({ status: 'synced', approvedBy: 'autopilot' })],
    });
    await writeStore(tmpDir, store);
    const result = await handleListDecisions(tmpDir) as {
      decisions: Array<{ confidence: string; servedContentMetadata: Record<string, unknown> }>;
    };
    expect(result.decisions[0].servedContentMetadata).toEqual({ provenance: 'local-unreviewed' });
    expect(result.decisions[0].servedContentMetadata).not.toHaveProperty('confidence');
    expect(result.decisions[0].confidence).toBeDefined();
  });
});

// ── handleApproveDecision ─────────────────────────────────────────────────────

describe('handleApproveDecision', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-decisions-test-'));
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns error when decision id is not found', async () => {
    await writeStore(tmpDir, makeStore());
    const result = await handleApproveDecision(tmpDir, 'notfound') as { error: string };
    expect(result.error).toMatch(/notfound/);
  });

  it('approves a draft decision and returns id + status + title', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'draft', title: 'Use SQLite' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    const result = await handleApproveDecision(tmpDir, 'abc12345') as { id: string; status: string; title: string };
    expect(result.id).toBe('abc12345');
    expect(result.status).toBe('approved');
    expect(result.title).toBe('Use SQLite');
  });

  it('persists the approved status to disk', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'draft' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    await handleApproveDecision(tmpDir, 'abc12345', 'LGTM');
    const store = await readStore(tmpDir);
    expect(store.decisions[0].status).toBe('approved');
    expect(store.decisions[0].reviewNote).toBe('LGTM');
  });

  it('blocks re-approving an already synced decision', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'synced' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    const result = await handleApproveDecision(tmpDir, 'abc12345') as { error: string };
    expect(result.error).toMatch(/already synced/);
    const store = await readStore(tmpDir);
    expect(store.decisions[0].status).toBe('synced');
  });

  it('refuses to approve a rejected decision, surfacing the rejection note; store unchanged', async () => {
    // fix-decision-status-transitions: approve_decision must never silently
    // reverse a recorded human rejection. The reversal path is an explicit
    // re-record, disclosed in the error.
    const decision = makeDecision({ id: 'abc12345', status: 'rejected', reviewNote: 'Adds infra we do not want' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    const result = await handleApproveDecision(tmpDir, 'abc12345') as { error: string };
    expect(result.error).toMatch(/rejected by a human/);
    expect(result.error).toMatch(/Adds infra we do not want/); // discloses the prior verdict
    expect(result.error).toMatch(/re-record/);                 // names the explicit reversal step
    const store = await readStore(tmpDir);
    expect(store.decisions[0].status).toBe('rejected');        // verdict intact
  });

  it('reports honestly (no false success) when the decision is removed during approval', async () => {
    // C9: the decision passes the pre-check, then a concurrent writer removes it
    // before the CAS commit. The handler must NOT claim success for a no-op patch.
    const decision = makeDecision({ id: 'abc12345', status: 'draft', title: 'Race me' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    // The wipe goes straight to a CAS write while approve still has loadDecisionStore
    // ahead of its own CAS, so the wipe wins the lock and the decision is gone at
    // approve's commit.
    const [result] = await Promise.all([
      handleApproveDecision(tmpDir, 'abc12345'),
      updateDecisionStore(tmpDir, (s) => ({ ...s, decisions: [] })),
    ]);

    // Honesty invariant: either a clean approval (the decision was present at the
    // approve commit) or the explicit concurrent-removal error — never a false
    // 'approved' for a decision that is not actually approved on disk.
    const r = result as { status?: string; error?: string };
    const store = await readStore(tmpDir);
    const onDisk = store.decisions.find((d) => d.id === 'abc12345');
    if (r.status === 'approved') {
      expect(onDisk?.status).toBe('approved');
    } else {
      expect(r.error).toMatch(/concurrently/);
      expect(onDisk).toBeUndefined();
    }
  });
});

// ── handleRejectDecision ──────────────────────────────────────────────────────

describe('handleRejectDecision', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-decisions-test-'));
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns error when decision id is not found', async () => {
    await writeStore(tmpDir, makeStore());
    const result = await handleRejectDecision(tmpDir, 'notfound') as { error: string };
    expect(result.error).toMatch(/notfound/);
  });

  it('rejects a decision and returns id + status + title', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'draft', title: 'Use JSON' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    const result = await handleRejectDecision(tmpDir, 'abc12345', 'Too slow') as { id: string; status: string; title: string };
    expect(result.id).toBe('abc12345');
    expect(result.status).toBe('rejected');
    expect(result.title).toBe('Use JSON');
  });

  it('persists the rejected status and note to disk', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'draft' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    await handleRejectDecision(tmpDir, 'abc12345', 'Bad idea');
    const store = await readStore(tmpDir);
    expect(store.decisions[0].status).toBe('rejected');
    expect(store.decisions[0].reviewNote).toBe('Bad idea');
  });
});

// ── handleSyncDecisions ───────────────────────────────────────────────────────

describe('handleSyncDecisions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-decisions-test-'));
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null);
  });

  it('returns error when no openlore config exists', async () => {
    const result = await handleSyncDecisions(tmpDir) as { error: string };
    expect(result.error).toMatch(/No openlore configuration/);
  });

  it('calls syncApprovedDecisions with rootPath and dryRun flag', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    await writeStore(tmpDir, makeStore());

    await handleSyncDecisions(tmpDir, true);
    expect(syncApprovedDecisions).toHaveBeenCalledWith(
      expect.objectContaining({ decisions: [] }),
      expect.objectContaining({ rootPath: tmpDir, dryRun: true }),
    );
  });

  it('returns synced/errors/modifiedSpecs and dryRun from syncer result', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    vi.mocked(syncApprovedDecisions).mockResolvedValue({
      store: makeStore(),
      result: {
        synced: [{ id: 'abc12345', title: 'Use SQLite', syncedToSpecs: ['services'] } as PendingDecision],
        errors: [],
        modifiedSpecs: ['openspec/specs/services/spec.md'],
      },
    });
    await writeStore(tmpDir, makeStore());

    const result = await handleSyncDecisions(tmpDir, false) as {
      synced: Array<{ id: string; title: string; specs: string[] }>;
      errors: unknown[];
      modifiedSpecs: string[];
      dryRun: boolean;
    };
    expect(result.dryRun).toBe(false);
    expect(result.synced).toHaveLength(1);
    expect(result.synced[0].id).toBe('abc12345');
    expect(result.modifiedSpecs).toEqual(['openspec/specs/services/spec.md']);
  });

  it('promotes a specific decision to approved before syncing when id provided', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    const decision = makeDecision({ id: 'abc12345', status: 'draft' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    await handleSyncDecisions(tmpDir, false, 'abc12345');
    expect(syncApprovedDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.arrayContaining([
          expect.objectContaining({ id: 'abc12345', status: 'approved' }),
        ]),
      }),
      expect.anything(),
    );
  });

  it('returns error when specific id not found', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    await writeStore(tmpDir, makeStore());

    const result = await handleSyncDecisions(tmpDir, false, 'notfound') as { error: string };
    expect(result.error).toMatch(/notfound/);
  });

  it('promotes the id through CAS: the promotion is persisted and a co-resident draft survives (harden-decision-consolidation)', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    const promoted = makeDecision({ id: 'aaaa1111', status: 'draft', title: 'A' });
    const other = makeDecision({ id: 'bbbb2222', status: 'draft', title: 'B' });
    await writeStore(tmpDir, makeStore({ decisions: [promoted, other] }));

    await handleSyncDecisions(tmpDir, false, 'aaaa1111');

    // The promotion is committed to the store via updateDecisionStore (the old
    // code patched only a locally-loaded copy and never persisted it) — and the
    // CAS re-applies against the latest store, so the co-resident draft is never
    // clobbered.
    const store = await readStore(tmpDir);
    const a = store.decisions.find((d) => d.id === 'aaaa1111');
    const b = store.decisions.find((d) => d.id === 'bbbb2222');
    expect(a?.status).toBe('approved');
    expect(b?.status).toBe('draft');
  });

  it('cannot resurrect a rejected decision: sync(id) errors, store unchanged, no spec write', async () => {
    // fix-decision-status-transitions: the sharpest instance — sync_decisions
    // with an explicit id must not launder a human rejection into the specs.
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    vi.mocked(syncApprovedDecisions).mockClear();
    const decision = makeDecision({ id: 'abc12345', status: 'rejected', reviewNote: 'Rejected on review' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    const result = await handleSyncDecisions(tmpDir, false, 'abc12345') as { error: string };
    expect(result.error).toMatch(/rejected by a human/);       // names the current status
    expect(result.error).toMatch(/re-record/);                 // names the required human step
    // No promotion committed, and the sync/spec-write path never ran.
    const store = await readStore(tmpDir);
    expect(store.decisions[0].status).toBe('rejected');
    expect(syncApprovedDecisions).not.toHaveBeenCalled();
  });

  it('does not re-promote an already-synced decision via sync(id)', async () => {
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    vi.mocked(syncApprovedDecisions).mockClear();
    const decision = makeDecision({ id: 'abc12345', status: 'synced' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    const result = await handleSyncDecisions(tmpDir, false, 'abc12345') as { error: string };
    expect(result.error).toMatch(/already synced/);
    const store = await readStore(tmpDir);
    expect(store.decisions[0].status).toBe('synced');
    expect(syncApprovedDecisions).not.toHaveBeenCalled();
  });
});
