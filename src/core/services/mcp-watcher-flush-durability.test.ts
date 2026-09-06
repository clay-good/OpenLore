/**
 * Issue #451 — a debounced flush must never skip SILENTLY.
 *
 * The reported symptom was an incremental flush that intermittently never landed
 * on Windows: `llm-context.json` still held the seeded empty context and nothing
 * anywhere said why. Three separate holes in this lane produce exactly that
 * observable, and each is a real product defect in a long-lived MCP server, not a
 * test artifact — a watcher that drops a file event without a signal leaves the
 * index stale and the agent unaware:
 *
 *   1. `handleBatch` treated EVERY read failure as "the file was deleted" and,
 *      when that emptied the batch, returned writing nothing and saying nothing.
 *   2. `flush` drains `pending` before its first await, and only two error
 *      classes put the paths back — every other failure lost them permanently,
 *      contradicting `flushBatchWithBusyRetry`'s own docstring.
 *   3. `stop`'s shutdown drain lost its batch the same way, and then reported a
 *      clean stop because its "still deferred" check read the emptied queue.
 *
 * Plus a fourth, found while auditing the state machine: a `.git` write with no
 * indexable file change latched the VCS settle window forever, after which the
 * hard batch ceiling could never be re-armed.
 *
 * These tests inject the failures deterministically. The Windows trigger itself
 * (a sharing violation making `readFileConfined`'s descriptor-identity check fail
 * closed) is not reproducible here — the DURABILITY contract is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Fail `readFileConfined` for the paths in `failing`, so many times each.
 * A non-ENOENT failure is what a Windows sharing violation looks like from here:
 * the file is present and readable a moment later.
 */
const readFailures = new Map<string, number>();
vi.mock('../../utils/path-confinement.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/path-confinement.js')>();
  return {
    ...actual,
    readFileConfined: async (root: string, rel: string, ...rest: unknown[]) => {
      const left = readFailures.get(rel) ?? 0;
      if (left > 0) {
        readFailures.set(rel, left - 1);
        throw new Error(`Confined read target changed during access: "${rel}"`);
      }
      return (actual.readFileConfined as (...a: unknown[]) => Promise<string>)(root, rel, ...rest);
    },
  };
});

const { McpWatcher, WATCH_MAX_EVENT_RETRIES, WATCH_MAX_CONTENTION_RETRIES } = await import('./mcp-watcher.js');
type Watcher = InstanceType<typeof McpWatcher>;

interface Internals {
  enqueue(path: string): void;
  flush(): void;
  onVcsEvent(): void;
  enqueueDeletion(path: string): void;
  armFlushStallDisclosure(batchSize: number): void;
  handleBatch(paths: string[], opts?: Record<string, unknown>): Promise<void>;
  handleDeletions(paths: string[], recordSpecChanges?: boolean): Promise<void>;
  persistContext(context: unknown): Promise<void>;
  flushBatchWithBusyRetry(batch: string[], deletions: string[], opts?: Record<string, unknown>): Promise<void>;
  pending: Set<string>;
  pendingDeletions: Set<string>;
  eventRetries: Map<string, number>;
  flushPromise?: Promise<void>;
  flushStallTimer?: ReturnType<typeof setTimeout>;
  maxBatchTimer?: ReturnType<typeof setTimeout>;
  vcsSettling: boolean;
  running: boolean;
}
const inside = (watcher: Watcher): Internals => watcher as unknown as Internals;

let root: string;
let contextPath: string;
let stderr: string[];
const watchers: Watcher[] = [];

/** Every watcher this file creates is stopped before its fixture root is removed. */
function makeWatcher(options: Record<string, unknown> = {}): Watcher {
  const watcher = new McpWatcher({ rootPath: root, embed: false, debounceMs: 5, maxBatchMs: 500, ...options });
  watchers.push(watcher);
  return watcher;
}

/**
 * Budget for `until`. A Windows runner is materially slower at the real work these
 * tests do — a tree-sitter parse plus several fsync'd temp+rename cycles, up to
 * four times over for a retry-bound test — and an antivirus scanner adds latency
 * to every one of them. A budget tuned to Linux would turn that into a flake on a
 * required job, which is the failure mode #451 was reported as in the first place.
 */
const UNTIL_BUDGET_MS = process.platform === 'win32' ? 20_000 : 10_000;

/** Poll for an observable outcome; on timeout, say so AND show the watcher's own diagnostics. */
async function until(
  done: () => boolean | Promise<boolean>,
  what: string,
  budget = UNTIL_BUDGET_MS,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + budget;
  for (;;) {
    if (await done()) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${budget}ms waiting for ${what}.\nWatcher said:\n${stderr.join('') || '(nothing)'}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Poll llm-context.json for `needle` — WITHOUT standing on the writer's foot.
 *
 * On Windows an open handle on a file blocks `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` onto
 * it, whatever share mode the reader asked for. That is measured, not assumed: granting a
 * reader FILE_SHARE_DELETE explicitly does not let the replace through (issue #457).
 *
 * The watcher publishes this exact file by temp+fsync+rename, so polling it with `readFile`
 * every 10ms keeps a descriptor open across most of the publish window — and the test then
 * manufactures the contention it trips over. Measured here: the rename ladder in
 * atomicWriteFile exhausted roughly 1 run in 4, the watcher abandoned the change, and the
 * assertion failed for a reason that has nothing to do with flush durability.
 *
 * Polling every 100ms and reading only when the mtime has moved cuts that duty cycle by more
 * than an order of magnitude. The assertion is unchanged — the content still has to land.
 *
 * NOTE the product behaviour is real and stays open in #457: a concurrent reader CAN still
 * cost a publish. This only stops the harness from being that reader.
 */
async function untilContext(needle: string, what: string): Promise<void> {
  let lastMtimeMs = -1;
  let cached = '';
  await until(async () => {
    let mtimeMs: number;
    try { mtimeMs = (await stat(contextPath)).mtimeMs; } catch { return false; }
    if (mtimeMs !== lastMtimeMs) {
      lastMtimeMs = mtimeMs;
      try { cached = await readFile(contextPath, 'utf-8'); } catch { return false; }
    }
    return cached.includes(needle);
  }, what, UNTIL_BUDGET_MS, 100);
}

const said = (pattern: RegExp): boolean => stderr.some((line) => pattern.test(line));

beforeEach(async () => {
  readFailures.clear();
  root = await mkdtemp(join(tmpdir(), 'ol-flush-durability-'));
  const analysisDir = join(root, '.openlore', 'analysis');
  await mkdir(analysisDir, { recursive: true });
  contextPath = join(analysisDir, 'llm-context.json');
  await writeFile(contextPath, JSON.stringify({ signatures: [], callGraph: null }, null, 2), 'utf-8');
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    stderr.push(chunk.toString());
    return true;
  });
});

afterEach(async () => {
  // Stop before removing the root: a live watcher outliving its own filesystem
  // writes complaints into a sink no test reads, and can leak into the next one.
  await Promise.all(watchers.splice(0).map((watcher) => watcher.stop().catch(() => {})));
  vi.restoreAllMocks();
  // maxRetries: Windows returns EBUSY/EPERM for a moment after the last handle on
  // a file closes (an indexer or AV scanner still has it open). Node's own retry
  // loop is the fix; swallowing the error instead would hide a genuinely leaked
  // handle, which is exactly the kind of thing this file exists to catch.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('McpWatcher flush durability (issue #451)', () => {
  it('retries a transiently unreadable file instead of dropping it silently', async () => {
    const foo = join(root, 'foo.ts');
    await writeFile(foo, 'export function delta() {}\n', 'utf-8');
    readFailures.set('foo.ts', 1); // fails once, then reads fine

    inside(makeWatcher()).enqueue(foo);

    await untilContext('delta', 'the retried flush to reach disk');
    // Before the fix this batch produced no output at all — the drop was invisible.
    expect(said(/could not read 1 changed file/)).toBe(true);
    expect(said(/deferred 1 unreadable change/)).toBe(true);
    expect(said(/gave up/)).toBe(false);
  });

  it('gives up loudly on a permanently unreadable file rather than retrying forever', async () => {
    const foo = join(root, 'foo.ts');
    await writeFile(foo, 'export function delta() {}\n', 'utf-8');
    readFailures.set('foo.ts', Number.MAX_SAFE_INTEGER);

    const watcher = makeWatcher();
    inside(watcher).enqueue(foo);

    await until(() => said(/gave up on 1 change/), 'the watcher to disclose the abandoned change');
    expect(said(/run analyze to reconcile/)).toBe(true);
    // Bounded: the queue is empty, so nothing is left spinning.
    await until(() => inside(watcher).pending.size === 0 && !inside(watcher).running, 'the queue to settle');
    const attempts = stderr.filter((line) => /could not read/.test(line)).length;
    // One initial attempt plus the budget. The unreadable lane is not the contention class,
    // so it keeps the smaller of the two.
    expect(attempts).toBe(1 + WATCH_MAX_EVENT_RETRIES);
  });

  it('re-queues a batch whose flush failed for an unrecognized reason', async () => {
    const foo = join(root, 'foo.ts');
    await writeFile(foo, 'export function gamma() {}\n', 'utf-8');

    const watcher = makeWatcher();
    const internals = inside(watcher);
    const real = internals.handleBatch.bind(watcher);
    let failuresLeft = 1;
    vi.spyOn(internals, 'handleBatch').mockImplementation(async (paths, opts) => {
      if (failuresLeft-- > 0) throw new Error('ENOSPC: no space left on device, write');
      await real(paths, opts);
    });

    internals.enqueue(foo);

    // The change survives the failure and lands on the retry. Before the fix the
    // drained batch existed only in a local array and was garbage-collected.
    await untilContext('gamma', 'the re-queued batch to land');
    expect(said(/error: ENOSPC/)).toBe(true);
    expect(said(/deferred 1 change\(s\) for retry/)).toBe(true);
  });

  it('abandons a permanently failing batch after a bounded number of attempts', async () => {
    const foo = join(root, 'foo.ts');
    await writeFile(foo, 'export function gamma() {}\n', 'utf-8');

    const watcher = makeWatcher();
    const internals = inside(watcher);
    vi.spyOn(internals, 'handleBatch').mockRejectedValue(new Error('EIO: i/o error, write'));

    internals.enqueue(foo);

    await until(() => said(/gave up on 1 change/), 'the watcher to disclose the abandoned batch');
    await until(() => internals.pending.size === 0 && !internals.running, 'the queue to settle');
    expect(stderr.filter((line) => /error: EIO/.test(line)).length).toBe(4); // 1 + 3 retries
    // The single-flight guard is released, so the watcher is not wedged.
    expect(internals.running).toBe(false);
  });

  it('discloses a shutdown batch it could not flush instead of reporting a clean stop', async () => {
    const foo = join(root, 'shutdown.ts');
    await writeFile(foo, 'export function omega() {}\n', 'utf-8');

    const watcher = makeWatcher();
    const internals = inside(watcher);
    vi.spyOn(internals, 'handleBatch').mockRejectedValue(new Error('EACCES: permission denied, open'));
    internals.pending.add(foo);

    await watcher.stop();
    watchers.length = 0; // already stopped

    expect(said(/shutdown flush error: EACCES/)).toBe(true);
    // The line that used to stay silent because the lost batch had emptied the queue.
    expect(said(/stopped with 1 change\(s\).*still deferred/)).toBe(true);
  });

  it('closes the VCS settle window when the settle flush finds nothing to do', async () => {
    // A `git commit` or `git fetch` rewrites refs without changing an indexable
    // file. The settle debounce then fires on an empty queue, which used to skip
    // the only line that clears `vcsSettling` — leaving the hard batch ceiling
    // permanently unarmable, so a steady write stream could postpone the flush
    // without bound while a timer was always armed.
    const watcher = makeWatcher();
    const internals = inside(watcher);

    internals.onVcsEvent();
    expect(internals.vcsSettling).toBe(true);
    internals.flush(); // the settle debounce, with nothing queued
    expect(internals.vcsSettling).toBe(false);

    internals.enqueue(join(root, 'later.ts'));
    expect(internals.maxBatchTimer).toBeDefined();
  });
  it('bounds a failure that happens AFTER the file was read', async () => {
    // The retry budget lives per PATH, and the read is what used to clear it. A
    // failure past the read — the artifact rename, the generation republish, a
    // full disk — therefore reset the budget on every attempt and retried
    // forever. This is the exact shape of the failure #451 reported, so it is the
    // one the bound has to cover; note that it drives the REAL handleBatch rather
    // than mocking it, which is what let the loop hide.
    const foo = join(root, 'foo.ts');
    await writeFile(foo, 'export function delta() {}\n', 'utf-8');

    const watcher = makeWatcher();
    const internals = inside(watcher);
    vi.spyOn(internals, 'persistContext').mockRejectedValue(new Error('EPERM: operation not permitted, rename'));

    internals.enqueue(foo);

    await until(() => said(/gave up on 1 change/), 'the watcher to abandon the change');
    await until(() => internals.pending.size === 0 && !internals.running, 'the queue to settle');
    // One initial attempt plus the budget — DERIVED, because an `EPERM … rename` is the
    // transient-contention class and spends the larger budget (#457). A literal here would
    // assert the number this test was written against rather than the property it names.
    expect(stderr.filter((line) => /error: EPERM/.test(line)).length)
      .toBe(1 + WATCH_MAX_CONTENTION_RETRIES);
    expect(internals.eventRetries.size).toBe(0);
  });

  it('outwaits a reader far longer than it retries a failure that may be deterministic', async () => {
    // The whole of #457: the blocking descriptor on Windows is usually OUR OWN reader, and no
    // share mode lets it step aside, so waiting is the only way through. Spending the
    // deterministic-failure budget on that wait is what dropped a change while a reader
    // happened to be busy. Both budgets stay BOUNDED — a destination held forever still ends
    // in one loud, stale-recorded drop.
    expect(WATCH_MAX_CONTENTION_RETRIES).toBeGreaterThan(WATCH_MAX_EVENT_RETRIES);

    const foo = join(root, 'contended.ts');
    await writeFile(foo, 'export function delta() {}\n', 'utf-8');
    const watcher = makeWatcher();
    const internals = inside(watcher);
    vi.spyOn(internals, 'persistContext').mockRejectedValue(new Error('EIO: i/o error, write'));

    internals.enqueue(foo);
    await until(() => said(/gave up on 1 change/), 'the watcher to abandon the change');
    await until(() => internals.pending.size === 0 && !internals.running, 'the queue to settle');
    // An EIO is NOT the contention class, so it keeps the smaller budget.
    expect(stderr.filter((line) => /error: EIO/.test(line)).length)
      .toBe(1 + WATCH_MAX_EVENT_RETRIES);
  });

  it('lands the readable half of a mixed batch and still retries the unreadable half', async () => {
    const good = join(root, 'good.ts');
    const bad = join(root, 'bad.ts');
    await writeFile(good, 'export function alpha() {}\n', 'utf-8');
    await writeFile(bad, 'export function beta() {}\n', 'utf-8');
    readFailures.set('bad.ts', 1);

    const internals = inside(makeWatcher());
    internals.enqueue(good);
    internals.enqueue(bad);

    // The readable file is not held hostage by its neighbour...
    await untilContext('alpha', 'the readable half to land');
    // ...and the unreadable one comes back on the retry rather than leaving with it.
    await untilContext('beta', 'the retried half to land');
    expect(said(/could not read 1 changed file/)).toBe(true);
    expect(said(/gave up/)).toBe(false);
  });

  it('re-queues a failed DELETION as a deletion, never demoting it to a change', async () => {
    const gone = join(root, 'gone.ts');
    const watcher = makeWatcher();
    const internals = inside(watcher);
    const real = internals.handleDeletions.bind(watcher);
    let failuresLeft = 1;
    const spy = vi.spyOn(internals, 'handleDeletions').mockImplementation(async (paths, record) => {
      if (failuresLeft-- > 0) throw new Error('EBUSY: resource busy or locked, unlink');
      await real(paths, record);
    });

    internals.enqueueDeletion(gone);

    await until(() => spy.mock.calls.length >= 2, 'the deletion to be retried');
    expect(spy.mock.calls[1][0]).toEqual([gone]);
    expect(internals.pending.has(gone)).toBe(false);
    expect(said(/gave up/)).toBe(false);
  });

  it('gives a file a fresh retry budget after a successful pass, and leaves no ledger behind', async () => {
    const foo = join(root, 'foo.ts');
    await writeFile(foo, 'export function alpha() {}\n', 'utf-8');
    const internals = inside(makeWatcher());

    // One failure is enough to put the file in the ledger; round 2 is what proves
    // the entry did not survive. Keeping round 1 cheap matters — this test drives
    // the REAL flush lane, and every extra pass is a tree-sitter parse plus an
    // fsync'd temp+rename on a runner where those are slow.
    readFailures.set('foo.ts', 1);
    internals.enqueue(foo);
    await untilContext('alpha', 'the first round to land');
    await until(() => internals.eventRetries.size === 0, 'the retry ledger to clear');

    // Three more failures. With round 1's entry still in the ledger this is the
    // FOURTH attempt, over the bound, and the file is abandoned instead of landing.
    await writeFile(foo, 'export function omega() {}\n', 'utf-8');
    readFailures.set('foo.ts', 3);
    internals.enqueue(foo);
    await untilContext('omega', 'the second round to land');
    expect(said(/gave up/)).toBe(false);
    await until(() => internals.eventRetries.size === 0, 'the retry ledger to clear again');
  });

  it('records an abandoned change as stale in the graph store, not just on stderr', async () => {
    const { EdgeStore } = await import('./edge-store.js');
    const outputPath = join(root, '.openlore', 'analysis');
    EdgeStore.openForAnalyze(EdgeStore.dbPath(outputPath)).close();

    await mkdir(join(root, 'src'), { recursive: true });
    const foo = join(root, 'src', 'foo.ts');
    const notes = join(root, 'openspec', 'specs', 'x', 'spec.md');
    await mkdir(join(root, 'openspec', 'specs', 'x'), { recursive: true });
    await writeFile(foo, 'export function delta() {}\n', 'utf-8');
    await writeFile(notes, '# spec\n', 'utf-8');
    readFailures.set('src/foo.ts', Number.MAX_SAFE_INTEGER);

    const internals = inside(makeWatcher());
    internals.enqueue(foo);
    internals.enqueue(notes);

    await until(() => said(/gave up on/), 'the watcher to abandon the change');
    await until(() => internals.pending.size === 0 && !internals.running, 'the queue to settle');

    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const stale = store.getStaleFiles();
    store.close();
    // The signal outlives the log line: a later freshness read sees the gap.
    expect(stale).toContain('src/foo.ts');
    // ...but only for source the graph indexes. A stale row for a markdown file
    // the graph has no nodes for could never be cleared by a re-parse.
    expect(stale).not.toContain('openspec/specs/x/spec.md');
    expect(said(/could not record .* as stale/)).toBe(false);
  });

  it('handleChange discloses an unreadable file without queueing work its caller did not ask for', async () => {
    const foo = join(root, 'foo.ts');
    await writeFile(foo, 'export function delta() {}\n', 'utf-8');
    readFailures.set('foo.ts', 1);

    const watcher = makeWatcher();
    await watcher.handleChange(foo);
    const internals = inside(watcher);

    expect(said(/could not read 1 changed file/)).toBe(true);
    // No debounce lane behind this caller: no re-queue, no retry, no ledger entry.
    expect(internals.pending.size).toBe(0);
    expect(internals.eventRetries.size).toBe(0);
    expect(said(/deferred/)).toBe(false);
    expect(said(/gave up/)).toBe(false);
  });

  it('says nothing when a file simply vanished between the event and the read', async () => {
    const ghost = join(root, 'ghost.ts');
    const internals = inside(makeWatcher());
    internals.enqueue(ghost); // never created

    await until(() => !internals.running && internals.pending.size === 0, 'the batch to drain');
    // handleDeletions owns a removed file; it must not look unreadable.
    expect(said(/could not read/)).toBe(false);
    expect(said(/gave up/)).toBe(false);
  });

  it('discloses a flush that neither finishes nor fails, and clears that disclosure', async () => {
    const watcher = makeWatcher();
    const internals = inside(watcher);
    let release!: () => void;
    vi.spyOn(internals, 'flushBatchWithBusyRetry')
      .mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));

    vi.useFakeTimers();
    try {
      internals.pending.add(join(root, 'wedged.ts'));
      internals.flush();
      expect(internals.flushStallTimer).toBeDefined();
      expect(said(/is still running after/)).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(said(/a flush of 1 change\(s\) is still running after 30s/)).toBe(true);

      release();
      await internals.flushPromise;
      await vi.advanceTimersByTimeAsync(0);
      expect(internals.flushStallTimer).toBeUndefined();
      expect(internals.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stopped watcher never emits a stall disclosure it armed before shutdown', async () => {
    const watcher = makeWatcher();
    const internals = inside(watcher);
    vi.useFakeTimers();
    try {
      internals.armFlushStallDisclosure(7);
      expect(internals.flushStallTimer).toBeDefined();
      await watcher.stop();
      watchers.length = 0;
      expect(internals.flushStallTimer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(said(/is still running after/)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
