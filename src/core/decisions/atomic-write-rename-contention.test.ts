/**
 * Issue #451 — the atomic write must survive a Windows rename that lost a race.
 *
 * POSIX `rename(2)` replaces the destination unconditionally. Windows does not:
 * `MoveFileExW(REPLACE_EXISTING)` needs DELETE access to the target, so it fails
 * with `EPERM`/`EACCES`/`EBUSY` while any other handle is open on it without
 * `FILE_SHARE_DELETE` — an antivirus or Search Indexer scanning the file it just
 * saw written, or a reader that opened it a millisecond earlier.
 *
 * This is not a hypothesis. A Windows CI runner produced exactly this while
 * running the watcher's durability suite:
 *
 *   [mcp-watcher] error: EPERM: operation not permitted, rename
 *     '…\.llm-context.json.tmp-5316-5' -> '…\llm-context.json'
 *
 * The artifact was left at its previous content with no other trace — one of the
 * two mechanisms behind #451.
 *
 * `rename` is retried rather than worked around: the temp file is still there and
 * fully fsync'd, so each attempt is the same single atomic replace and atomicity
 * is untouched. The retries are bounded, and a genuine permission problem still
 * fails with its own message rather than being swallowed or masked.
 *
 * `node:fs/promises` is mocked here so the race is deterministic on every
 * platform; it cannot be provoked on POSIX, and provoking it on Windows would
 * mean racing a scanner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/** Node's own phrasing per code, so a synthetic error reads like the real one. */
const RENAME_MESSAGES: Record<string, string> = {
  EPERM: 'operation not permitted',
  EACCES: 'permission denied',
  EBUSY: 'resource busy or locked',
  ENOSPC: 'no space left on device',
};

/** Fail the next `failures` renames with `code`, then let the real one through. */
let renameFailures = 0;
let renameCode = 'EPERM';
let renameCalls = 0;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameCalls++;
      if (renameFailures > 0) {
        renameFailures--;
        const err = new Error(
          `${renameCode}: ${RENAME_MESSAGES[renameCode] ?? 'rename failed'}, rename '${from}' -> '${to}'`,
        ) as NodeJS.ErrnoException;
        err.code = renameCode;
        throw err;
      }
      return actual.rename(from, to);
    },
  };
});

const { atomicWriteFile } = await import('./atomic-store.js');

let dir: string;
let target: string;

beforeEach(async () => {
  renameFailures = 0;
  renameCode = 'EPERM';
  renameCalls = 0;
  dir = await mkdtemp(join(tmpdir(), 'ol-rename-contention-'));
  target = join(dir, 'llm-context.json');
});

afterEach(async () => {
  // No restoreAllMocks: there are no spies here, and it cannot undo a `vi.mock`
  // factory anyway — the module mock is per-file and goes away with the file.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Temp files the writer left behind (its own `.<name>.tmp-<pid>-<n>` shape). */
async function leftoverTempFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes('.tmp-'));
}

describe('atomicWriteFile — a contended rename (issue #451)', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    it(`retries a ${code} rename and commits the write`, async () => {
      renameCode = code;
      renameFailures = 2;

      await atomicWriteFile(target, '{"signatures":["written"]}');

      expect(JSON.parse(await readFile(target, 'utf-8'))).toEqual({ signatures: ['written'] });
      expect(renameCalls).toBe(3); // two contended attempts, then the commit
      expect(await leftoverTempFiles()).toEqual([]);
    });
  }

  it('overwrites existing content rather than leaving the previous version in place', async () => {
    // The #451 symptom precisely: the artifact stayed at what was already on disk.
    await atomicWriteFile(target, '{"signatures":[]}');
    renameFailures = 3;

    await atomicWriteFile(target, '{"signatures":["delta"]}');

    expect(await readFile(target, 'utf-8')).toContain('delta');
  });

  it('gives up after a bounded number of attempts and rethrows the original error', async () => {
    renameFailures = Number.MAX_SAFE_INTEGER;

    // The ORIGINAL error, not a wrapper: an operator must see the real cause, and
    // callers that branch on `code` must still be able to.
    await expect(atomicWriteFile(target, 'never lands')).rejects.toMatchObject({
      code: 'EPERM',
      message: expect.stringContaining('rename'),
    });
    // Bounded: one try plus one per backoff step. A permanently unwritable
    // destination must fail, not retry forever.
    expect(renameCalls).toBe(9);
    // A failed write leaves no litter behind in the store directory.
    expect(await leftoverTempFiles()).toEqual([]);
  });

  it('waits on a REF\'d timer, so a retry cannot be lost to process exit', async () => {
    // Regression guard for a real defect in this change's own first cut. An
    // unref'd timer does not hold the event loop open: if the retry sleep were
    // the last handle, the process would drain and exit 0 with the write never
    // committed, the temp never cleaned up, and the commit lock never released —
    // no error, no rejection, no trace. A behavioural test would need a child
    // process whose only pending work is this sleep; reading the source states
    // the invariant more directly than staging that.
    const src = readFileSync(new URL('./atomic-store.ts', import.meta.url), 'utf-8');
    const start = src.indexOf('const sleepMs');
    expect(start).toBeGreaterThan(-1);
    // Read to the end of the declaration, not just its first line, so a
    // reformatted multi-line version cannot smuggle the unref past this.
    const declaration = src.slice(start, src.indexOf('\n\n', start));
    expect(declaration).not.toMatch(/unref/);
  });

  it('does not retry an error that is not destination contention', async () => {
    renameCode = 'ENOSPC';
    renameFailures = Number.MAX_SAFE_INTEGER;

    await expect(atomicWriteFile(target, 'no room')).rejects.toThrow(/ENOSPC/);
    // A full disk is not a race: retrying it would only delay the same failure.
    expect(renameCalls).toBe(1);
  });
});
