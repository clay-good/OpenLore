/**
 * Durability + concurrency guarantees for the JSON stores.
 * (change: harden-memory-integrity-invariant)
 *
 * Guards architecture-spec requirements DurableAtomicStorePersistence and
 * CorruptStoreQuarantineNotSilentEmpty, and the mcp-handlers requirement
 * ConcurrentMemoryWriteSafety. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteFile,
  casUpdate,
  quarantineCorrupt,
  renameRetryDelaysMs,
  type SequencedStore,
} from './atomic-store.js';
import {
  loadMemoryStore,
  saveMemoryStore,
  updateMemoryStore,
  memoryDir,
} from './memory-store.js';
import {
  loadDecisionStore,
  saveDecisionStore,
  updateDecisionStore,
  upsertDecisions,
  patchDecision,
  decisionsDir,
} from './store.js';
import { MEMORY_NOTES_FILE, DECISIONS_PENDING_FILE } from '../../constants.js';
import type { AnchoredMemory, MemoryStore, PendingDecision } from '../../types/index.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), section: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn() },
}));

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'openlore-atomic-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function note(id: string): AnchoredMemory {
  return { id, kind: 'note', content: `note ${id}`, anchors: [], recordedAt: '2026-01-01T00:00:00Z' };
}

// ════════════════════════════════════════════════════════════════════════════
// atomicWriteFile — temp + fsync + rename
// ════════════════════════════════════════════════════════════════════════════
describe('atomicWriteFile', () => {
  it('writes content and leaves no temp file behind', async () => {
    const path = join(root, 'sub', 'data.json');
    await atomicWriteFile(path, '{"ok":true}');
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ ok: true });
    const entries = await readdir(join(root, 'sub'));
    expect(entries.filter((e) => e.includes('.tmp'))).toHaveLength(0);
  });

  it('replaces existing content atomically (prior content fully overwritten)', async () => {
    const path = join(root, 'data.json');
    await atomicWriteFile(path, 'first');
    await atomicWriteFile(path, 'second');
    expect(await readFile(path, 'utf-8')).toBe('second');
  });

  // skipIf(win32): POSIX permission bits do not exist there. Node maps a mode to the single
  // read-only attribute, so 0o644 comes back 0o666 and the assertion compares a mode the
  // filesystem never stored. What it guards - a replace must not widen permissions - is a
  // POSIX property, exercised on Linux.
  it.skipIf(process.platform === 'win32')('preserves an existing file mode across atomic replacement', async () => {
    const path = join(root, 'shared.json');
    await writeFile(path, 'first', { mode: 0o644 });
    await atomicWriteFile(path, 'second');
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it('a crash BETWEEN temp-write and rename preserves the prior committed file', async () => {
    // atomicWriteFile writes a sibling temp file, then renames it into place. A
    // crash before the rename leaves the temp file orphaned and the committed
    // file untouched — never a torn in-place write. Reproduce that state: commit
    // v1, then leave a torn temp file exactly where a crashed writer would.
    const path = join(root, 'store.json');
    await atomicWriteFile(path, JSON.stringify({ committed: true }));
    const tornTemp = join(root, `.store.json.tmp-${process.pid}`);
    await writeFile(tornTemp, '{ partial torn write that never renamed', 'utf-8');

    // The committed file is intact (the crash never touched it in place).
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ committed: true });

    // A subsequent successful write still produces clean committed content and
    // overwrites/ignores the orphaned temp.
    await atomicWriteFile(path, JSON.stringify({ committed: false }));
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ committed: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// casUpdate — compare-and-swap, re-apply on conflict
// ════════════════════════════════════════════════════════════════════════════
describe('casUpdate', () => {
  interface Store extends SequencedStore { items: string[] }
  const path = () => join(root, 'cas.json');
  const load = async (): Promise<Store> => {
    try { return JSON.parse(await readFile(path(), 'utf-8')) as Store; }
    catch { return { items: [], sequence: 0 }; }
  };
  const serialize = (s: Store) => JSON.stringify(s);

  it('bumps sequence by exactly one per committed write', async () => {
    const a = await casUpdate<Store>({ storePath: path(), load, serialize, mutate: (s) => ({ ...s, items: [...s.items, 'a'] }) });
    expect(a.sequence).toBe(1);
    const b = await casUpdate<Store>({ storePath: path(), load, serialize, mutate: (s) => ({ ...s, items: [...s.items, 'b'] }) });
    expect(b.sequence).toBe(2);
    expect(b.items).toEqual(['a', 'b']);
  });

  it('applies the mutate to the freshest on-disk store, never clobbering a prior write', async () => {
    // A competing writer has already committed {items:['other'], sequence:1} to disk.
    await writeFile(path(), serialize({ items: ['other'], sequence: 1 }));
    const result = await casUpdate<Store>({
      storePath: path(),
      load,
      serialize,
      mutate: (s) => ({ ...s, items: [...s.items, 'mine'] }),
    });
    // The mutate runs against the latest store read inside the lock: 'other' is
    // preserved and 'mine' is merged on top; the sequence advances from 1 to 2.
    expect(result.items).toEqual(['other', 'mine']);
    expect(result.sequence).toBe(2);
  });

  it('N concurrent casUpdate calls lose zero writes', async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        casUpdate<Store>({ storePath: path(), load, serialize, mutate: (s) => ({ ...s, items: [...s.items, `w${i}`] }) }),
      ),
    );
    const final = await load();
    expect(final.items.sort()).toEqual(Array.from({ length: N }, (_, i) => `w${i}`).sort());
    expect(final.sequence).toBe(N);
  });

  it('steals a stale lock left by a crashed holder and still commits', async () => {
    // Simulate a crashed writer: a lock file with an mtime well past the stale
    // threshold (10s). casUpdate must steal it rather than block, and commit.
    const lockPath = `${path()}.lock`;
    await writeFile(lockPath, '99999-0', 'utf-8'); // some other process's token
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const result = await casUpdate<Store>({
      storePath: path(),
      load,
      serialize,
      mutate: (s) => ({ ...s, items: [...s.items, 'after-steal'] }),
    });
    expect(result.items).toEqual(['after-steal']);
    // The lock we acquired (and owned) is released on completion.
    await expect(readFile(lockPath, 'utf-8')).rejects.toThrow();
  });

  it('does not steal a stale-looking lock while its owner PID is alive', async () => {
    const lockPath = `${path()}.lock`;
    await writeFile(lockPath, `${process.pid}-external`, 'utf-8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let mutated = false;
    const pending = casUpdate<Store>({
      storePath: path(),
      load,
      serialize,
      mutate: (s) => {
        mutated = true;
        return { ...s, items: [...s.items, 'mine'] };
      },
    });

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(mutated).toBe(false);
    await rm(lockPath);

    await expect(pending).resolves.toMatchObject({ items: ['mine'], sequence: 1 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// quarantineCorrupt
// ════════════════════════════════════════════════════════════════════════════
describe('quarantineCorrupt', () => {
  it('moves the file aside to a deterministic .corrupt-<n> path (no timestamp)', async () => {
    const path = join(root, 'notes.json');
    await writeFile(path, 'garbage', 'utf-8');
    const dest = await quarantineCorrupt(path, 'test');
    expect(dest).toBe(`${path}.corrupt-0`);
    expect(await readFile(dest!, 'utf-8')).toBe('garbage');
  });

  it('uses the next free index when a prior quarantine exists', async () => {
    const path = join(root, 'notes.json');
    await writeFile(`${path}.corrupt-0`, 'old', 'utf-8');
    await writeFile(path, 'garbage', 'utf-8');
    const dest = await quarantineCorrupt(path, 'test');
    expect(dest).toBe(`${path}.corrupt-1`);
  });

  it('never overwrites an existing quarantine file (atomic claim preserves prior bytes)', async () => {
    const path = join(root, 'notes.json');
    await writeFile(`${path}.corrupt-0`, 'PRIOR', 'utf-8');
    await writeFile(path, 'NEW garbage', 'utf-8');
    const dest = await quarantineCorrupt(path, 'test');
    expect(dest).toBe(`${path}.corrupt-1`);
    // The earlier quarantine's bytes are intact — not clobbered.
    expect(await readFile(`${path}.corrupt-0`, 'utf-8')).toBe('PRIOR');
    expect(await readFile(`${path}.corrupt-1`, 'utf-8')).toBe('NEW garbage');
  });

  it('two concurrent quarantines of the same file preserve the bytes exactly once', async () => {
    const path = join(root, 'notes.json');
    await writeFile(path, 'ONLY COPY', 'utf-8');
    const [a, b] = await Promise.all([
      quarantineCorrupt(path, 'racer-a'),
      quarantineCorrupt(path, 'racer-b'),
    ]);
    // Exactly one claim succeeds; the other sees the file already moved (null).
    const winners = [a, b].filter((d): d is string => d !== null);
    expect(winners).toHaveLength(1);
    expect(await readFile(winners[0], 'utf-8')).toBe('ONLY COPY');
    // Original path is gone (moved), not left as a duplicate.
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// memory store end-to-end durability
// ════════════════════════════════════════════════════════════════════════════
describe('memory store — durability + concurrency end-to-end', () => {
  it('legacy store without a sequence field loads as sequence 0 and saves at 1', async () => {
    const dir = memoryDir(root);
    await mkdir(dir, { recursive: true });
    // Legacy shape: no `sequence` field.
    await writeFile(join(dir, MEMORY_NOTES_FILE), JSON.stringify({ version: '1', updatedAt: '', memories: [note('a')] }), 'utf-8');
    const loaded = await loadMemoryStore(root);
    expect(loaded.sequence).toBe(0);
    expect(loaded.memories).toHaveLength(1);
    await saveMemoryStore(root, loaded);
    expect((await loadMemoryStore(root)).sequence).toBe(1);
  });

  it('N concurrent remember-style updates persist all N memories', async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateMemoryStore(root, (s: MemoryStore) => ({
          ...s,
          memories: [...s.memories.filter((m) => m.id !== `m${i}`), note(`m${i}`)],
        })),
      ),
    );
    const final = await loadMemoryStore(root);
    expect(final.memories.map((m) => m.id).sort()).toEqual(Array.from({ length: N }, (_, i) => `m${i}`).sort());
  });

  it('a corrupted notes store is quarantined, not silently emptied', async () => {
    const dir = memoryDir(root);
    await mkdir(dir, { recursive: true });
    const path = join(dir, MEMORY_NOTES_FILE);
    await writeFile(path, '{ this is : not valid json', 'utf-8');
    const loaded = await loadMemoryStore(root);
    expect(loaded.memories).toHaveLength(0); // degrades to empty (no crash)
    // ...but the corrupt bytes are preserved on disk, not dropped.
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith(`${MEMORY_NOTES_FILE}.corrupt-`))).toBe(true);
  });

  it('writes notes.json atomically (no lingering temp files)', async () => {
    await updateMemoryStore(root, (s) => ({ ...s, memories: [note('x')] }));
    const entries = await readdir(memoryDir(root));
    expect(entries.filter((e) => e.includes('.tmp'))).toHaveLength(0);
    expect(entries).toContain(MEMORY_NOTES_FILE);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// decision store quarantine + sequence
// ════════════════════════════════════════════════════════════════════════════
describe('decision store — quarantine + sequence', () => {
  // skipIf(win32): creating a symlink there needs elevated privileges or Developer Mode,
  // so this cannot build the premise it asserts about and would test a plain file instead.
  // What it guards is platform-independent and is exercised on Linux.
  it.skipIf(process.platform === 'win32')('rejects an outbound .openlore directory symlink before writing either store', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'openlore-atomic-outside-'));
    await symlink(outside, join(root, '.openlore'), 'dir');
    try {
      await expect(updateDecisionStore(root, (store) => store)).rejects.toThrow(/canonicalizes outside/);
      await expect(updateMemoryStore(root, (store) => store)).rejects.toThrow(/canonicalizes outside/);
      await expect(readFile(join(outside, 'decisions', DECISIONS_PENDING_FILE), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(outside, 'memory', MEMORY_NOTES_FILE), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('a corrupted pending.json is quarantined, not silently emptied', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const path = join(dir, DECISIONS_PENDING_FILE);
    await writeFile(path, 'totally not json', 'utf-8');
    const loaded = await loadDecisionStore(root);
    expect(loaded.decisions).toHaveLength(0);
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith(`${DECISIONS_PENDING_FILE}.corrupt-`))).toBe(true);
  });

  it('an invalid-shape store (object without decisions array) is quarantined', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const path = join(dir, DECISIONS_PENDING_FILE);
    await writeFile(path, JSON.stringify({ version: '1', sessionId: 's', updatedAt: '' }), 'utf-8');
    await loadDecisionStore(root);
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith(`${DECISIONS_PENDING_FILE}.corrupt-`))).toBe(true);
  });

  it('save bumps the monotonic sequence', async () => {
    const s0 = await loadDecisionStore(root);
    expect(s0.sequence).toBe(0);
    await saveDecisionStore(root, s0);
    const s1 = await loadDecisionStore(root);
    expect(s1.sequence).toBe(1);
    await saveDecisionStore(root, s1);
    expect((await loadDecisionStore(root)).sequence).toBe(2);
  });

  it('quarantined file retains the original bytes (recoverable)', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const path = join(dir, DECISIONS_PENDING_FILE);
    const original = '{ torn store ';
    await writeFile(path, original, 'utf-8');
    await loadDecisionStore(root);
    const corrupt = (await readdir(dir)).find((e) => e.startsWith(`${DECISIONS_PENDING_FILE}.corrupt-`))!;
    expect(await readFile(join(dir, corrupt), 'utf-8')).toBe(original);
    await stat(join(dir, corrupt)); // exists
  });
});

// ════════════════════════════════════════════════════════════════════════════
// decision store — concurrent mixed-mutation writers lose no write (C1 regression)
// ════════════════════════════════════════════════════════════════════════════
describe('decision store — concurrent CAS writers across mutation kinds', () => {
  function decision(id: string, status: PendingDecision['status'] = 'draft'): PendingDecision {
    return {
      id, status, title: `decision ${id}`, rationale: '', consequences: '',
      proposedRequirement: null, affectedDomains: [], affectedFiles: [],
      sessionId: 's', recordedAt: '2026-01-01T00:00:00Z', contentOrigin: 'agent-recorded', confidence: 'medium', syncedToSpecs: [],
    };
  }

  it('N concurrent upserts (record-style) persist every decision', async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateDecisionStore(root, (s) => upsertDecisions(s, [decision(`d${i}`)])),
      ),
    );
    const final = await loadDecisionStore(root);
    expect(final.decisions.map((d) => d.id).sort()).toEqual(
      Array.from({ length: N }, (_, i) => `d${i}`).sort(),
    );
  }, 60_000);

  it('a consolidation-style replace racing concurrent record upserts loses neither', async () => {
    // Seed two drafts the "consolidation" will reject+replace.
    await updateDecisionStore(root, (s) => upsertDecisions(s, [decision('draftA'), decision('draftB')]));

    // Race: a consolidation that rejects draftA/draftB and writes a consolidated
    // decision, concurrently with two fresh record_decision-style upserts. With CAS
    // on a single lock, the consolidation snapshot cannot clobber the new records.
    await Promise.all([
      updateDecisionStore(root, (s) => {
        let next = patchDecision(s, 'draftA', { status: 'rejected' });
        next = patchDecision(next, 'draftB', { status: 'rejected' });
        return upsertDecisions(next, [decision('consolidated', 'verified')]);
      }),
      updateDecisionStore(root, (s) => upsertDecisions(s, [decision('lateX')])),
      updateDecisionStore(root, (s) => upsertDecisions(s, [decision('lateY')])),
    ]);

    const final = await loadDecisionStore(root);
    const byId = new Map(final.decisions.map((d) => [d.id, d]));
    // Every write survived — no lost update across mutation kinds.
    expect(byId.has('consolidated')).toBe(true);
    expect(byId.has('lateX')).toBe(true);
    expect(byId.has('lateY')).toBe(true);
    // The consolidation's rejects also applied.
    expect(byId.get('draftA')?.status).toBe('rejected');
    expect(byId.get('draftB')?.status).toBe('rejected');
  });
});

describe('rename contention ladder (issue #457)', () => {
  const total = (delays: readonly number[]): number => delays.reduce((sum, d) => sum + d, 0);

  it('gives Windows a longer window than the platform where the failure cannot happen', () => {
    // The holder is external (a scanner opening a just-published artifact), measured as a
    // clean negative: on a CI runner the contention path never fires, while the reporting
    // machine fails ~1 run in 5 on identical code.
    const windows = renameRetryDelaysMs('win32');
    const posix = renameRetryDelaysMs('linux');
    expect(total(windows)).toBeGreaterThan(total(posix));
    expect(windows.length).toBeGreaterThan(posix.length);
    expect(windows.slice(0, posix.length)).toEqual([...posix]);
  });

  it('stays under the commit lock\'s 10s stale-candidate threshold', () => {
    // The binding ceiling is the lock's, not the scanner's: a writer that spends its whole
    // budget must not become a stale-lock candidate or trip a waiter's 30s timeout.
    expect(total(renameRetryDelaysMs('win32'))).toBeLessThan(10_000);
  });

  it('leaves POSIX unchanged, where an EPERM on rename is a real permission error', () => {
    expect(renameRetryDelaysMs('darwin')).toEqual(renameRetryDelaysMs('linux'));
    expect(total(renameRetryDelaysMs('linux'))).toBeLessThan(4_000);
  });
});
