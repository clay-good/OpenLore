import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EditVerdict, EditVerdictRead, EditVerdictStoreBoundary } from '../../core/services/edit-verdict.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  config: vi.fn(),
  stdin: vi.fn(),
  writes: [] as string[],
}));

vi.mock('../../core/services/edit-verdict.js', () => ({
  readCurrentEditVerdicts: mocks.read,
}));
vi.mock('../../core/services/config-manager.js', () => ({
  readOpenLoreConfig: mocks.config,
}));
vi.mock('../../utils/stdin.js', () => ({
  readStdin: mocks.stdin,
}));
vi.mock('../output.js', () => ({
  writeStdout: vi.fn(async (value: string) => { mocks.writes.push(value); }),
}));

import {
  checkEditCommand,
  fileFromHookPayload,
  repoRelativeFile,
  runCheckEditCli,
} from './check-edit.js';

const finding = {
  code: 'edit-broken-reference',
  severity: 'error' as const,
  source: 'edit-verdict',
  subject: 'serve',
  message: 'src/caller.ts:12 still calls serve.',
  location: { path: 'src/caller.ts', line: 12 },
};

function verdict(over: Partial<EditVerdict> = {}): EditVerdict {
  return {
    file: 'src/api.ts',
    contentHash: 'a'.repeat(64),
    findings: [finding],
    reachingTests: [{ test: 'serves', file: 'src/api.test.ts', viaPath: ['serves', 'serve'], confidence: 'high' }],
    languageScope: ['TypeScript'],
    boundaries: { staleFiles: [], reachingTestsBasis: 'incremental-graph' },
    ...over,
  };
}

const current = (entries = [verdict()], storeBoundaries?: EditVerdictStoreBoundary): EditVerdictRead => ({
  status: 'current', entries, ...(storeBoundaries ? { storeBoundaries } : {}),
});

describe('check-edit path and hook payload parsing', () => {
  let root: string;
  let alias: string;
  /**
   * Whether the symlink alias could be created. Creating one on Windows needs elevated
   * privileges or Developer Mode, so only the assertions that NEED an alias are skipped there —
   * the rest of this block is platform-independent and includes the served-path convention
   * (`src/api.ts`, POSIX on every host) that is the whole point of exercising it on Windows.
   * Guarding the premise rather than the test file is what keeps that coverage.
   */
  let aliasAvailable = false;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'check-edit-path-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'api.ts'), 'export {};');
    alias = `${root}-alias`;
    try {
      await symlink(root, alias, 'dir');
      aliasAvailable = true;
    } catch {
      aliasAvailable = false;
    }
  });

  afterEach(async () => {
    await rm(alias, { force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('maps a path inside the repository to its POSIX repo-relative form, and refuses what is outside', () => {
    expect(repoRelativeFile(root, join(root, 'src', 'api.ts'))).toBe('src/api.ts');
    expect(repoRelativeFile(root, 'src/api.ts')).toBe('src/api.ts');
    expect(repoRelativeFile(root, 'src')).toBeUndefined();
    expect(repoRelativeFile(root, '../secret')).toBeUndefined();
    expect(repoRelativeFile(root, 'src/missing.ts')).toBeUndefined();
  });

  it('resolves a path reached through a symlinked repository root', async () => {
    if (!aliasAvailable) return; // premise unbuildable here; the assertions above still ran
    const canonicalRoot = await realpath(root);
    expect(repoRelativeFile(canonicalRoot, join(alias, 'src', 'api.ts'))).toBe('src/api.ts');
  });

  it('extracts a Claude PostToolUse file path and fails soft on malformed input', () => {
    expect(fileFromHookPayload(root, JSON.stringify({ tool_input: { file_path: join(root, 'src', 'api.ts') } })))
      .toBe('src/api.ts');
    expect(fileFromHookPayload(root, '{bad')).toBeUndefined();
    expect(fileFromHookPayload(root, JSON.stringify({ tool_input: { file_path: '/outside/x.ts' } })))
      .toBeUndefined();
  });

  it('extracts a hook payload path that arrives through the symlinked root', () => {
    if (!aliasAvailable) return; // premise unbuildable here; the assertions above still ran
    expect(fileFromHookPayload(root, JSON.stringify({ tool_input: { file_path: join(alias, 'src', 'api.ts') } })))
      .toBe('src/api.ts');
  });
});

describe('runCheckEditCli', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'check-edit-run-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'api.ts'), 'export {};');
    mocks.read.mockReset();
    mocks.config.mockReset();
    mocks.stdin.mockReset();
    mocks.writes.length = 0;
    mocks.config.mockResolvedValue(null);
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(async () => { stderr.mockRestore(); await rm(root, { recursive: true, force: true }); });

  it('emits one stable JSON verdict document and forwards the requested file', async () => {
    mocks.read.mockResolvedValue(current());
    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', json: true })).toBe(0);
    expect(mocks.read).toHaveBeenCalledWith(root, ['src/api.ts']);
    expect(JSON.parse(mocks.writes.join(''))).toEqual({
      kind: 'edit-verdict', version: 1, status: 'current', entries: [verdict()],
    });
  });

  it('reports missing/stale verdicts honestly without invoking a fallback', async () => {
    mocks.read.mockResolvedValue({ status: 'missing', entries: [], reason: 'No watcher verdict.' });
    expect(await runCheckEditCli({ cwd: root, json: true })).toBe(0);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.writes.join(''))).toMatchObject({ status: 'missing', reason: 'No watcher verdict.' });
  });

  it('rejects a direct path outside the repository but fails open in hook mode', async () => {
    expect(await runCheckEditCli({ cwd: root, file: '../secret', json: true })).toBe(1);
    expect(await runCheckEditCli({ cwd: root, file: '../secret', hook: true })).toBe(0);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', '{bad'],
    ['missing a file', JSON.stringify({ tool_input: {} })],
    ['outside the repository', JSON.stringify({ tool_input: { file_path: '/outside/secret.ts' } })],
  ])('fails open before reading verdicts when hook stdin is %s', async (_label, payload) => {
    mocks.stdin.mockResolvedValue(payload);

    expect(await runCheckEditCli({ cwd: root, hook: true, hookPollMs: 0 })).toBe(0);

    expect(mocks.read).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map((call: unknown[]) => String(call[0])).join(''))
      .toMatch(/stdin payload.*skipping verdict/i);
  });

  it('uses a valid hook stdin file to read only its current verdict', async () => {
    mocks.stdin.mockResolvedValue(JSON.stringify({ tool_input: { file_path: join(root, 'src', 'api.ts') } }));
    mocks.read.mockResolvedValue(current());

    expect(await runCheckEditCli({ cwd: root, hook: true, hookPollMs: 0 })).toBe(0);

    expect(mocks.stdin).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith(root, ['src/api.ts']);
  });

  it('fails open without reading verdicts when bounded stdin rejects an oversized payload', async () => {
    mocks.stdin.mockRejectedValue(new Error('Hook stdin exceeds the 65536-byte safety limit.'));

    expect(await runCheckEditCli({ cwd: root, hook: true, hookPollMs: 0 })).toBe(0);

    expect(mocks.read).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('')).toContain('65536-byte safety limit');
  });

  it('preserves an explicit hook file without reading stdin', async () => {
    mocks.stdin.mockRejectedValue(new Error('stdin must not be read'));
    mocks.read.mockResolvedValue(current());

    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true, hookPollMs: 0 })).toBe(0);

    expect(mocks.stdin).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledWith(root, ['src/api.ts']);
  });

  it('bounded-polls until the watcher publishes a current-hash verdict', async () => {
    mocks.read
      .mockResolvedValueOnce({ status: 'stale', entries: [], reason: 'hash mismatch' })
      .mockResolvedValueOnce(current());
    expect(await runCheckEditCli({
      cwd: root, file: 'src/api.ts', hook: true, hookPollMs: 30, hookPollIntervalMs: 1,
    })).toBe(0);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('')).toContain('edit-broken-reference');
  });

  it('times out stale and every infrastructure/store failure fail-open on stderr', async () => {
    mocks.read.mockResolvedValue({ status: 'stale', entries: [], reason: 'hash mismatch' });
    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true, hookPollMs: 0 })).toBe(0);
    expect(stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('')).toContain('hash mismatch');

    mocks.read.mockRejectedValue(new Error('disk unavailable'));
    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true })).toBe(0);
    expect(stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('')).toContain('disk unavailable');
  });

  it('exits 2 only when enforcement.policy explicitly blocks a present finding', async () => {
    mocks.read.mockResolvedValue(current());
    mocks.config.mockResolvedValue({ enforcement: { policy: { 'edit-broken-reference': 'blocking' } } });
    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true })).toBe(2);
    expect(stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('')).toMatch(/blocked by explicit enforcement\.policy/i);
  });

  it.each(['advisory', 'off', 'frozen'] as const)('keeps an explicit %s policy non-blocking', async (cls) => {
    mocks.read.mockResolvedValue(current());
    mocks.config.mockResolvedValue({ enforcement: { policy: { 'edit-broken-reference': cls } } });
    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true })).toBe(0);
  });

  it('no policy, malformed policy, and config read failure all fail open', async () => {
    mocks.read.mockResolvedValue(current());
    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true })).toBe(0);

    mocks.config.mockResolvedValue({ enforcement: { policy: { 'edit-broken-reference': 'yes' } } });
    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true })).toBe(0);

    mocks.config.mockRejectedValue(new Error('bad config'));
    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true })).toBe(0);
  });

  it('sanitizes repository-controlled terminal sequences in hook rendering', async () => {
    mocks.read.mockResolvedValue(current([verdict({
      findings: [{ ...finding, message: '\u001b[2Jforged' }],
    })]));
    await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true });
    const output = stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('');
    expect(output).not.toContain('\u001b');
    expect(output).toContain('forged');
  });

  it('discloses store entry eviction and byte bounding without changing hook exit behavior', async () => {
    mocks.read.mockResolvedValue(current([verdict({ findings: [] })], {
      entriesEvicted: 2,
      evictedFiles: ['src/old-a.ts', 'src/old-b.ts'],
      bytesBounded: true,
    }));

    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', hook: true })).toBe(0);

    const output = stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('');
    expect(output).toContain('evicted 2 older entries');
    expect(output).toContain('src/old-a.ts, src/old-b.ts');
    expect(output).toContain('reached its byte bound');

    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts' })).toBe(0);
    expect(mocks.writes.join('')).toContain('evicted 2 older entries');
    expect(mocks.writes.join('')).toContain('reached its byte bound');

    mocks.writes.length = 0;
    expect(await runCheckEditCli({ cwd: root, file: 'src/api.ts', json: true })).toBe(0);
    expect(JSON.parse(mocks.writes.join('')).storeBoundaries).toEqual({
      entriesEvicted: 2,
      evictedFiles: ['src/old-a.ts', 'src/old-b.ts'],
      bytesBounded: true,
    });
  });
});

describe('checkEditCommand help', () => {
  it('exposes file, JSON, and read-only hook modes', () => {
    const help = checkEditCommand.helpInformation();
    expect(help).toContain('--file');
    expect(help).toContain('--json');
    expect(help).toContain('--hook');
    expect(help).toContain('read only');
  });
});
