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
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Command, Option } from 'commander';
import { decisionsCommand } from './decisions.js';
import { loadDecisionStore, saveDecisionStore } from '../../core/decisions/store.js';
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
