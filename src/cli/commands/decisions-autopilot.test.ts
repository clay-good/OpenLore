/**
 * CLI-level tests for decision autopilot (change: add-decision-autopilot):
 * the gate auto-accepts + syncs + never blocks; provenance markers land in
 * specs; `decisions review` promotes/rejects; `decisions log` renders the
 * ledger; autopilot never touches a human-rejected decision; with autopilot
 * off the blocking gate behaves exactly as before.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decisionsCommand } from './decisions.js';
import { loadDecisionStore, saveDecisionStore } from '../../core/decisions/store.js';
import { readLedger } from '../../core/decisions/ledger.js';
import type { Command, Option } from 'commander';
import type { PendingDecision, DecisionStore } from '../../types/index.js';

/**
 * Commander keeps option values between parseAsync() calls on the same command
 * instance (same quirk analyze-no-embed.test.ts works around) — a stale parent
 * `--reject` from one test would hijack the next test's `--gate` parse. Reset
 * every option on the command tree to its declared default between tests.
 */
function resetCommanderState(root: Command): void {
  const cmds: Command[] = [root, ...root.commands];
  for (const c of cmds) {
    for (const o of (c as unknown as { options: Option[] }).options) {
      c.setOptionValue(o.attributeName(), o.defaultValue);
    }
  }
}

vi.mock('../../utils/logger.js', () => ({
  logger: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), section: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn() },
}));

const BASE_CONFIG = {
  version: '1.0.0',
  projectType: 'nodejs',
  openspecPath: 'openspec',
  analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
  generation: { model: 'claude-sonnet-4-6', domains: 'auto' },
  createdAt: '2026-07-18T00:00:00Z',
  lastRun: null,
};

const CACHE_SPEC = `# Cache Spec

> Source files: src/cache.ts

## Requirements

### Requirement: Caching

The system SHALL cache.
`;

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'aaaabbbb',
    status: 'verified',
    title: 'Use Redis for caching',
    rationale: 'Reduces DB load',
    consequences: 'Cache invalidation to manage',
    proposedRequirement: null,
    affectedDomains: ['cache'],
    affectedFiles: ['src/cache.ts'],
    sessionId: 'session123',
    recordedAt: '2026-07-18T00:00:00.000Z',
    confidence: 'high',
    syncedToSpecs: [],
    ...overrides,
  };
}

function makeStore(decisions: PendingDecision[]): DecisionStore {
  return {
    version: '1',
    sessionId: 'session123',
    updatedAt: '2026-07-18T00:00:00.000Z',
    sequence: 0,
    decisions,
  };
}

describe('decision autopilot', () => {
  let dir: string;
  let prevCwd: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[];
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = join(tmpdir(), `decisions-autopilot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await mkdir(join(dir, 'openspec', 'specs', 'cache'), { recursive: true });
    await writeFile(join(dir, 'openspec', 'specs', 'cache', 'spec.md'), CACHE_SPEC, 'utf-8');
    prevCwd = process.cwd();
    process.chdir(dir);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrChunks = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderrChunks.push(args.map(String).join(' '));
    });
    process.exitCode = undefined;
    resetCommanderState(decisionsCommand);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    stdoutSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(governance?: { autopilot?: boolean }): Promise<void> {
    await writeFile(
      join(dir, '.openlore', 'config.json'),
      JSON.stringify({ ...BASE_CONFIG, ...(governance ? { governance } : {}) }, null, 2),
      'utf-8',
    );
  }

  function stdoutText(): string {
    return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  }

  async function runGate(): Promise<void> {
    await decisionsCommand.parseAsync(['--gate'], { from: 'user' });
  }

  it('auto-accepts a verified decision, syncs it with the unreviewed marker, and never blocks', async () => {
    await writeConfig({ autopilot: true });
    await saveDecisionStore(dir, makeStore([makeDecision()]));

    await runGate();

    expect(process.exitCode ?? 0).toBe(0);

    const store = await loadDecisionStore(dir);
    const d = store.decisions.find((x) => x.id === 'aaaabbbb')!;
    expect(d.status).toBe('auto-approved');
    expect(d.approvedBy).toBe('autopilot');
    expect(d.syncedToSpecs.length).toBeGreaterThan(0);

    const spec = await readFile(join(dir, 'openspec', 'specs', 'cache', 'spec.md'), 'utf-8');
    expect(spec).toContain('**ID:** aaaabbbb');
    expect(spec).toContain('**Status:** Auto-accepted (unreviewed)');

    const ledger = await readLedger(dir);
    expect(ledger.some((e) => e.from === 'verified' && e.to === 'auto-approved' && e.actor === 'autopilot')).toBe(true);

    // One advisory line, pointing at the trail.
    expect(stderrChunks.join('\n')).toContain('auto-accepted');
    expect(stderrChunks.join('\n')).toContain('openlore decisions log');
  });

  it('never resurrects a human-rejected decision', async () => {
    await writeConfig({ autopilot: true });
    await saveDecisionStore(dir, makeStore([makeDecision({ status: 'rejected', reviewNote: 'no' })]));

    await runGate();

    expect(process.exitCode ?? 0).toBe(0);
    const store = await loadDecisionStore(dir);
    expect(store.decisions.find((x) => x.id === 'aaaabbbb')!.status).toBe('rejected');
    const spec = await readFile(join(dir, 'openspec', 'specs', 'cache', 'spec.md'), 'utf-8');
    expect(spec).not.toContain('aaaabbbb');
  });

  it('does not auto-accept or sync a decision without git-diff evidence', async () => {
    await writeConfig({ autopilot: true });
    await saveDecisionStore(dir, makeStore([makeDecision({ verificationEvidence: 'none' })]));

    await runGate();

    const store = await loadDecisionStore(dir);
    expect(store.decisions[0].status).toBe('verified');
    expect(store.decisions[0].syncedToSpecs).toEqual([]);
    expect(stderrChunks.join('\n')).toContain('unevidenced decision(s) require review');
  });

  it('exits 0 even when sync infrastructure is missing (fail-soft)', async () => {
    await writeConfig({ autopilot: true });
    await rm(join(dir, 'openspec'), { recursive: true, force: true });
    await saveDecisionStore(dir, makeStore([makeDecision()]));

    await runGate();

    expect(process.exitCode ?? 0).toBe(0);
    const store = await loadDecisionStore(dir);
    // Accepted (trail intact) even though the spec write had nowhere to go.
    expect(store.decisions[0].status).toBe('auto-approved');
    expect(store.decisions[0].syncedToSpecs).toHaveLength(0);
  });

  it('with autopilot off, the blocking gate is unchanged', async () => {
    await writeConfig();
    await saveDecisionStore(dir, makeStore([makeDecision()]));

    await runGate();

    expect(process.exitCode).toBe(1);
    const store = await loadDecisionStore(dir);
    expect(store.decisions[0].status).toBe('verified');
    const payload = JSON.parse(stdoutText());
    expect(payload.gated).toBe(true);
    expect(payload.reason).toBe('verified');
  });

  it('review --reject retires the decision from specs (annotated, not deleted) and trails actor human', async () => {
    await writeConfig({ autopilot: true });
    await saveDecisionStore(dir, makeStore([makeDecision({ proposedRequirement: 'cache reads through Redis' })]));
    await runGate();

    await decisionsCommand.parseAsync(['review', '--reject', 'aaaabbbb', '--note', 'wrong call'], { from: 'user' });

    expect(process.exitCode ?? 0).toBe(0);
    const store = await loadDecisionStore(dir);
    const d = store.decisions.find((x) => x.id === 'aaaabbbb')!;
    expect(d.status).toBe('rejected');
    expect(d.humanReviewedAt).toBeTruthy();

    const spec = await readFile(join(dir, 'openspec', 'specs', 'cache', 'spec.md'), 'utf-8');
    // Entry stays (history preserved) but its authority label is rewritten…
    expect(spec).toContain('**ID:** aaaabbbb');
    expect(spec).toMatch(/\*\*Status:\*\* Rejected \(auto-acceptance reverted \d{4}-\d{2}-\d{2}\)/);
    expect(spec).not.toContain('**Status:** Auto-accepted (unreviewed)');
    // …and the synced requirement block is annotated as rejected.
    expect(spec).toMatch(/> Decision recorded: aaaabbbb\n> Rejected: \d{4}-\d{2}-\d{2}/);

    const ledger = await readLedger(dir);
    expect(ledger.some((e) => e.from === 'auto-approved' && e.to === 'rejected' && e.actor === 'human')).toBe(true);
  });

  it('review --promote drops the unreviewed marker and settles the decision as synced', async () => {
    await writeConfig({ autopilot: true });
    await saveDecisionStore(dir, makeStore([makeDecision()]));
    await runGate();

    await decisionsCommand.parseAsync(['review', '--promote', 'all'], { from: 'user' });

    expect(process.exitCode ?? 0).toBe(0);
    const store = await loadDecisionStore(dir);
    const d = store.decisions.find((x) => x.id === 'aaaabbbb');
    // Promoted decisions settle to synced; a later purge may drop them from the
    // store, but never silently: if present, provenance must be intact.
    if (d) {
      expect(d.status).toBe('synced');
      expect(d.approvedBy).toBe('autopilot');
      expect(d.humanReviewedAt).toBeTruthy();
    }
    const spec = await readFile(join(dir, 'openspec', 'specs', 'cache', 'spec.md'), 'utf-8');
    expect(spec).toContain('**Status:** Approved');
    expect(spec).not.toContain('**Status:** Auto-accepted (unreviewed)');
  });

  it('repeated gates are idempotent: no duplicate spec entries, no duplicate transitions', async () => {
    await writeConfig({ autopilot: true });
    await saveDecisionStore(dir, makeStore([makeDecision()]));

    await runGate();
    await runGate();

    const spec = await readFile(join(dir, 'openspec', 'specs', 'cache', 'spec.md'), 'utf-8');
    expect(spec.match(/\*\*ID:\*\* aaaabbbb/g)).toHaveLength(1);
    const ledger = await readLedger(dir);
    expect(ledger.filter((e) => e.to === 'auto-approved')).toHaveLength(1);
  });

  it('decisions log renders the ledger newest-first as JSON', async () => {
    await writeConfig({ autopilot: true });
    await saveDecisionStore(dir, makeStore([makeDecision()]));
    await runGate();
    stdoutSpy.mockClear();

    await decisionsCommand.parseAsync(['log', '--json'], { from: 'user' });

    const entries = JSON.parse(stdoutText());
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toHaveProperty('actor');
    expect(entries[0]).toHaveProperty('to');
  });

  it('review --json discloses verification evidence in the pending queue', async () => {
    await writeConfig({ autopilot: true });
    await saveDecisionStore(dir, makeStore([makeDecision({
      status: 'auto-approved',
      approvedBy: 'autopilot',
      verificationEvidence: 'git-diff',
    })]));

    await decisionsCommand.parseAsync(['review', '--json'], { from: 'user' });

    const payload = JSON.parse(stdoutText());
    expect(payload.awaitingReview[0].verificationEvidence).toBe('git-diff');
  });
});
