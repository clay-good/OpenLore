/**
 * CLI tests for `openlore decisions record` (change: add-decisions-record-cli):
 * the command records the same draft as the record_decision MCP tool, rejects
 * bad input without writing, reports an already-decided verdict, and every CLI
 * hint names the real command.
 */

import { vi } from 'vitest';

// Background consolidation spawns a child; a mock child must emit 'spawn' or
// the handler waits (same double as mcp-handlers/decisions.test.ts).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
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
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), section: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn() },
}));

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Command, Option } from 'commander';
import { decisionsCommand } from './decisions.js';
import { loadDecisionStore, saveDecisionStore } from '../../core/decisions/store.js';
import { readLedger } from '../../core/decisions/ledger.js';
import { logger } from '../../utils/logger.js';

// Commander keeps option values between parseAsync() calls on one instance.
function resetCommanderState(root: Command): void {
  for (const c of [root, ...root.commands]) {
    for (const o of (c as unknown as { options: Option[] }).options) {
      c.setOptionValue(o.attributeName(), o.defaultValue);
    }
  }
}

describe('openlore decisions record', () => {
  let dir: string;
  let stdout: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-decisions-record-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    resetCommanderState(decisionsCommand);
    vi.mocked(logger.success).mockClear();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.warning).mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]) => decisionsCommand.parseAsync(['node', 'decisions', 'record', ...args]);
  const jsonOut = () => JSON.parse(stdout.join('')) as Record<string, unknown>;

  it('records a draft and names its id and the verdict command', async () => {
    await run('--title', 'Use UUIDs for decision IDs', '--rationale', 'Collision-free ids across sessions');

    expect(vi.mocked(logger.error).mock.calls, 'record logged an error').toEqual([]);
    const store = await loadDecisionStore(dir);
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]).toMatchObject({
      status: 'draft',
      title: 'Use UUIDs for decision IDs',
      rationale: 'Collision-free ids across sessions',
    });
    expect(process.exitCode).toBeUndefined();
    // validateDirectory also logs success; pick the record message.
    const message = vi.mocked(logger.success).mock.calls.map(([text]) => String(text)).find((text) => text.startsWith('Draft decision recorded')) ?? '';
    expect(message).toContain(`openlore decisions status ${store.decisions[0].id}`);
  });

  it('prints the handler result as JSON and forwards the optional fields', async () => {
    await run(
      '--title', 'Cache specs in memory', '--rationale', 'Avoid rereading spec files',
      '--consequences', 'Stale until restart', '--files', 'src/a.ts, src/b.ts',
      '--supersedes', 'a1b2c3d4', '--scope', 'component', '--json',
    );

    const result = jsonOut();
    expect(result.error, 'record returned an error').toBeUndefined();
    expect(result).toMatchObject({ status: 'draft', disposition: 'pending', reason: 'awaiting-consolidation' });
    expect(result.readVerdictWith).toBe(`openlore decisions status ${String(result.id)}`);
    const [decision] = (await loadDecisionStore(dir)).decisions;
    expect(decision).toMatchObject({
      consequences: 'Stale until restart',
      affectedFiles: ['src/a.ts', 'src/b.ts'],
      supersedes: 'a1b2c3d4',
      scope: 'component',
    });
  });

  it('stores nothing and exits non-zero without --rationale', async () => {
    await run('--title', 'Use UUIDs');
    expect(process.exitCode).toBe(1);
    expect(String(vi.mocked(logger.error).mock.calls[0]?.[0])).toContain('--rationale');
    expect((await loadDecisionStore(dir)).decisions).toHaveLength(0);
  });

  it('stores nothing and exits non-zero for an unknown scope', async () => {
    await run('--title', 'Use UUIDs', '--rationale', 'Why', '--scope', 'wide', '--json');
    expect(process.exitCode).toBe(1);
    expect(String(jsonOut().error)).toContain('--scope');
    expect((await loadDecisionStore(dir)).decisions).toHaveLength(0);
  });

  it('stores nothing and exits non-zero for a constraints file that is not JSON', async () => {
    const file = join(dir, 'constraints.json');
    await writeFile(file, '{ not json');
    await run('--title', 'Use UUIDs', '--rationale', 'Why', '--constraints-file', file, '--json');
    expect(process.exitCode).toBe(1);
    expect(String(jsonOut().error)).toContain('--constraints-file');
    expect((await loadDecisionStore(dir)).decisions).toHaveLength(0);
  });

  it('reports the verdict for a decision that was already decided, without a new draft', async () => {
    await run('--title', 'Use UUIDs', '--rationale', 'Collision-free ids');
    const store = await loadDecisionStore(dir);
    await saveDecisionStore(dir, {
      ...store,
      // Consolidation rejected it with a stated reason (the handler test's seeding).
      decisions: store.decisions.map((d) => ({
        ...d,
        status: 'rejected' as const,
        disposition: 'rejected' as const,
        dispositionReason: 'not-in-consolidated-set' as const,
      })),
    });

    stdout = [];
    resetCommanderState(decisionsCommand);
    await run('--title', 'Use UUIDs', '--rationale', 'Collision-free ids', '--json');

    expect(jsonOut()).toMatchObject({ alreadyDecided: true, status: 'rejected' });
    expect((await loadDecisionStore(dir)).decisions).toHaveLength(1);
  });

  // change: default-decision-autopilot-with-visible-trace
  describe('under decision autopilot (initialized repository, no gate, no API key)', () => {
    // Auto-init writes `governance.autopilot: true` into the config it creates.
    const writeConfig = async (governance: { autopilot?: boolean } = { autopilot: true }) => {
      await mkdir(join(dir, '.openlore'), { recursive: true });
      await writeFile(join(dir, '.openlore', 'config.json'), JSON.stringify({
        version: '1.0.0', projectType: 'nodejs', openspecPath: 'openspec',
        analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
        generation: { model: 'claude-sonnet-4-6', domains: 'auto' },
        createdAt: '2026-10-31T00:00:00Z', lastRun: null,
        ...(governance ? { governance } : {}),
      }));
    };
    const spawnedJobs = () => vi.mocked(spawn).mock.calls.map(([, args]) => (args as string[]).at(-1));

    beforeEach(() => {
      vi.mocked(spawn).mockClear();
    });

    it('accepts a recorded decision at once, trails actor agent, and syncs in background', async () => {
      await writeConfig();
      await writeFile(join(dir, 'cache.ts'), 'export const cache = 1;\n');
      await run('--title', 'Cache specs in memory', '--rationale', 'Avoid rereading spec files', '--files', 'cache.ts', '--json');

      const result = jsonOut();
      expect(result).toMatchObject({ status: 'auto-approved', reason: 'auto-accepted-on-record', reviewWith: 'openlore decisions review' });
      const [decision] = (await loadDecisionStore(dir)).decisions;
      expect(decision).toMatchObject({ id: result.id, status: 'auto-approved', approvedBy: 'autopilot' });
      expect(decision.humanReviewedAt).toBeUndefined();
      const ledger = await readLedger(dir);
      expect(ledger).toEqual([expect.objectContaining({ id: result.id, from: null, to: 'auto-approved', actor: 'agent' })]);
      expect(spawnedJobs()).toEqual(['--background-sync']);
    });

    it('holds a decision whose anchored file does not exist as a draft, with the reason', async () => {
      await writeConfig();
      await run('--title', 'Cache specs in memory', '--rationale', 'Why', '--files', 'missing.ts', '--json');
      const result = jsonOut();
      expect(result).toMatchObject({ status: 'draft', autopilot: { heldBack: 'anchored file not found: missing.ts' } });
      expect((await loadDecisionStore(dir)).decisions[0].status).toBe('draft');
    });

    it('holds a decision that supersedes a decision which is not live', async () => {
      await writeConfig();
      await run('--title', 'Cache specs in memory', '--rationale', 'Why', '--supersedes', 'a1b2c3d4', '--json');
      expect(jsonOut()).toMatchObject({ status: 'draft', autopilot: { heldBack: expect.stringContaining('a1b2c3d4 is not live') } });
    });

    it('never re-accepts a decision a human rejected', async () => {
      await writeConfig();
      await run('--title', 'Use UUIDs', '--rationale', 'Collision-free ids', '--json');
      const store = await loadDecisionStore(dir);
      await saveDecisionStore(dir, {
        ...store,
        decisions: store.decisions.map((d) => ({ ...d, status: 'rejected' as const, humanReviewedAt: '2026-10-31T00:00:00Z' })),
      });
      stdout = [];
      resetCommanderState(decisionsCommand);
      await run('--title', 'Use UUIDs', '--rationale', 'Collision-free ids', '--json');
      expect((await loadDecisionStore(dir)).decisions.map((d) => d.status)).toEqual(['rejected']);
      expect(jsonOut().status).toBe('rejected');
    });

    it('records a plain draft when governance.autopilot is false', async () => {
      await writeConfig({ autopilot: false });
      await run('--title', 'Use UUIDs', '--rationale', 'Collision-free ids', '--json');
      expect(jsonOut()).toMatchObject({ status: 'draft', reason: 'awaiting-consolidation' });
      expect(spawnedJobs()).toEqual(['--consolidate']);
    });
  });

  it('never points users at the non-existent `decisions --record` option', async () => {
    const root = new URL('..', import.meta.url);
    const offenders: string[] = [];
    for (const entry of await readdir(root, { recursive: true })) {
      const path = String(entry);
      if (!path.endsWith('.ts') || path.endsWith('.test.ts')) continue;
      const source = await readFile(new URL(path, root), 'utf8');
      if (source.includes('decisions --record')) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
