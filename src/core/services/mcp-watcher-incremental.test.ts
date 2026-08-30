/**
 * Spec 13.1 — watch-mode performance regression tests.
 *
 * These cover the freshness/coalescing guarantees without needing a real
 * chokidar watcher, an EdgeStore (call-graph.db), or a LanceDB vector index:
 *   • G1 — primeContextCache makes the next read a HIT (no cold re-parse of
 *          llm-context.json).
 *   • G2 — a burst of N events coalesces to exactly ONE flush / persistence.
 *   • G3 — a batch ≥ BULK_THRESHOLD is reported as a single coalesced refresh.
 *   • G5 — the watcher emits ≤ 1 summary line per batch by default.
 *   • G6 — signatures reflect a just-saved symbol after the flush, on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { McpWatcher } from './mcp-watcher.js';
import {
  REQUIRED_ANALYSIS_ARTIFACTS,
  publishGeneration,
  readCurrentGeneration,
} from '../runtime/analysis-generation.js';
import {
  readCachedContext,
  primeContextCache,
  _resetContextCacheForTesting,
} from './mcp-handlers/utils.js';

let root: string;
let analysisDir: string;
let contextPath: string;

async function writeContext(signatures: unknown[] = []): Promise<void> {
  await writeFile(contextPath, JSON.stringify({ signatures, callGraph: null }, null, 2), 'utf-8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-watch-'));
  analysisDir = join(root, '.openlore', 'analysis');
  await mkdir(analysisDir, { recursive: true });
  contextPath = join(analysisDir, 'llm-context.json');
  _resetContextCacheForTesting();
});

afterEach(async () => {
  _resetContextCacheForTesting();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/**
 * Wait until `done()` reports the debounced flush has landed, or give up after `budget` ms.
 *
 * These tests used to sleep a fixed 150-200ms and assert immediately. That encodes a guess
 * about how fast the machine is: on a loaded CI runner the flush had not run yet and the
 * assertion failed for a reason that has nothing to do with the behavior under test. Polling
 * for the observable outcome keeps the same assertions while removing the guess — a fast
 * machine still finishes in one tick, and a slow one is simply given room.
 */
async function until(done: () => boolean | Promise<boolean>, budget = 5_000): Promise<void> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('McpWatcher — Spec 13.1 freshness', () => {
  it('G6: a save patches the just-changed signature into llm-context.json on disk', async () => {
    await writeContext([]);
    await readCachedContext(root); // pre-warm

    const fooAbs = join(root, 'foo.ts');
    await writeFile(fooAbs, 'export function alpha() { return 1; }\n', 'utf-8');

    const watcher = new McpWatcher({ rootPath: root, embed: false });
    await watcher.handleChange(fooAbs);

    const onDisk = JSON.parse(await readFile(contextPath, 'utf-8')) as { signatures: Array<{ path: string; entries: Array<{ name: string }> }> };
    const fooEntry = onDisk.signatures.find((s) => s.path === 'foo.ts');
    expect(fooEntry).toBeDefined();
    expect(fooEntry!.entries.some((e) => e.name === 'alpha')).toBe(true);
  });

  it('G6: a save preserves existing signatures (reads ground truth from disk, not a stale cache)', async () => {
    // Seed an existing entry, then pre-poison the shared read cache with an
    // EMPTY context for this directory. A writer that patched the cached object
    // would drop src/existing.ts; reading disk ground truth preserves it.
    await writeContext([{ path: 'src/existing.ts', entries: [{ name: 'existingFn', signature: '', docstring: '', line: 1, kind: 'function' }] }]);
    await primeContextCache(root, { signatures: [] } as never);

    const fooAbs = join(root, 'src', 'newmod.ts');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(fooAbs, 'export function newFn() { return 42; }\n', 'utf-8');

    const watcher = new McpWatcher({ rootPath: root, embed: false });
    await watcher.handleChange(fooAbs);

    const onDisk = JSON.parse(await readFile(contextPath, 'utf-8')) as { signatures: Array<{ path: string }> };
    const paths = onDisk.signatures.map((s) => s.path);
    expect(paths).toContain('src/existing.ts');
    expect(paths).toContain('src/newmod.ts');
  });

  it('republishes the generation manifest after an incremental rewrite', async () => {
    // The watcher rewrites the SAME artifacts a full analyze publishes. Leaving the
    // manifest untouched would keep the old generation id on new content, so a
    // multi-artifact reader would validate an identity that never moved and label a
    // mixed read `ok`.
    await writeContext([]);
    for (const name of ['repo-structure.json', 'dependency-graph.json', 'fingerprint.json']) {
      await writeFile(join(analysisDir, name), JSON.stringify({ seeded: true }), 'utf-8');
    }
    const before = await publishGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
    expect(before).not.toBeNull();

    const fooAbs = join(root, 'foo.ts');
    await writeFile(fooAbs, 'export function alpha() { return 1; }\n', 'utf-8');
    await new McpWatcher({ rootPath: root, embed: false }).handleChange(fooAbs);

    const after = await readCurrentGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
    expect(after?.compatibility).toBe('manifest');
    expect(after?.generationId).not.toBe(before!.generationId);
    // The republished manifest describes the content that is actually on disk now.
    const contextRecord = after?.artifacts.find(a => a.path === 'llm-context.json');
    const digest = createHash('sha256').update(await readFile(contextPath)).digest('hex');
    expect(contextRecord?.sha256).toBe(digest);
  });

  it('G1: primeContextCache makes the next read a HIT — it returns the in-memory object, not what is on disk', async () => {
    await writeContext([{ path: 'orig.ts', entries: [] }]);
    const cold = await readCachedContext(root);
    expect(cold).not.toBeNull();

    // Prime the cache with a DIFFERENT object WITHOUT touching the file → the
    // on-disk mtime is unchanged, so the entry stays valid. A subsequent read
    // that hit the cache returns the primed object; a read that went to disk
    // would return the original on-disk signatures instead.
    await primeContextCache(root, { signatures: [{ path: 'patched.ts', entries: [{ name: 'beta', signature: '', docstring: '', line: 1, kind: 'function' }] }] } as never);

    const after = await readCachedContext(root);
    const sigs = (after as { signatures: Array<{ path: string }> }).signatures;
    expect(sigs.some((s) => s.path === 'patched.ts')).toBe(true);
    expect(sigs.some((s) => s.path === 'orig.ts')).toBe(false);

    const onDisk = JSON.parse(await readFile(contextPath, 'utf-8')) as { signatures: Array<{ path: string }> };
    expect(onDisk.signatures.some((s) => s.path === 'orig.ts')).toBe(true);
  });

  it('G2/G5: a burst of N change events coalesces to exactly ONE flush + ONE summary line', async () => {
    await writeContext([]);
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    for (const f of files) {
      await writeFile(join(root, f), `export function fn_${f.replace('.ts', '')}() {}\n`, 'utf-8');
    }

    const summaries: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      const s = chunk.toString();
      if (/\[mcp-watcher\] (updated|coalesced)/.test(s)) summaries.push(s);
      return true;
    });

    const watcher = new McpWatcher({ rootPath: root, embed: false, debounceMs: 30, maxBatchMs: 1000 });
    for (const f of files) (watcher as unknown as { enqueue(p: string): void }).enqueue(join(root, f));

    await until(() => summaries.length > 0);
    await watcher.stop();

    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain('updated 4 files');

    const ctx = await readCachedContext(root);
    const paths = new Set((ctx as { signatures: Array<{ path: string }> }).signatures.map((s) => s.path));
    for (const f of files) expect(paths.has(f)).toBe(true);
  });

  it("G1: the watcher's flush primes the cache so the next read is a HIT (same object), not a cold re-parse", async () => {
    // Root-cause #2 (Spec 13.1): the watcher's write used to bump llm-context.json's
    // mtime and force the NEXT tool call to re-parse the whole file cold. The other
    // G1 test proves primeContextCache→hit when called directly; this proves the
    // WATCHER's own flush path (enqueue → flush → handleBatch → persistContext)
    // hands the patched context to the read cache, and that the next readCachedContext
    // returns that exact object — reference identity ⇒ no disk re-parse.
    await writeContext([]);
    await readCachedContext(root); // cold-prime the cache at the original mtime

    const fooAbs = join(root, 'svc.ts');
    await writeFile(fooAbs, 'export function after() {}\n', 'utf-8');

    const utils = await import('./mcp-handlers/utils.js');
    const primeSpy = vi.spyOn(utils, 'primeContextCache');

    const watcher = new McpWatcher({ rootPath: root, embed: false, debounceMs: 20, maxBatchMs: 1000 });
    (watcher as unknown as { enqueue(p: string): void }).enqueue(fooAbs);
    await until(() => primeSpy.mock.calls.length > 0);
    await watcher.stop();

    // The flush handed the patched context to the read cache exactly once.
    expect(primeSpy).toHaveBeenCalledTimes(1);
    const primed = primeSpy.mock.calls[0][1] as { signatures: Array<{ path: string; entries: Array<{ name: string }> }> };
    expect(primed.signatures.find((s) => s.path === 'svc.ts')?.entries.some((e) => e.name === 'after')).toBe(true);

    // The next tool-call read is served from that primed object — a cold re-parse
    // would return a different object reference.
    const afterRead = await readCachedContext(root);
    expect(afterRead).toBe(primed);
  });

  it('G3: a batch above BULK_THRESHOLD switches to one disclosed full rebuild', async () => {
    await writeContext([]);
    const files = ['x.ts', 'y.ts', 'z.ts'];
    for (const f of files) await writeFile(join(root, f), `export const ${f.replace('.ts', '')} = 1;\n`, 'utf-8');

    const summaries: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      const s = chunk.toString();
      if (/\[mcp-watcher\] bulk fallback/.test(s)) summaries.push(s);
      return true;
    });

    const watcher = new McpWatcher({
      rootPath: root,
      embed: false,
      debounceMs: 30,
      bulkThreshold: 2,
      onGraphStale: () => {},
    });
    for (const f of files) (watcher as unknown as { enqueue(p: string): void }).enqueue(join(root, f));
    await until(() => summaries.length > 0);
    await watcher.stop();

    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain('marked 3 file(s) stale and scheduled one full rebuild');
  });

  it('clears the hard batch timer when a VCS settle window starts', async () => {
    await writeContext([]);
    const watcher = new McpWatcher({ rootPath: root, embed: false });
    const internals = watcher as unknown as {
      enqueue(path: string): void;
      onVcsEvent(): void;
      maxBatchTimer?: ReturnType<typeof setTimeout>;
    };
    internals.enqueue(join(root, 'branch.ts'));
    expect(internals.maxBatchTimer).toBeDefined();
    internals.onVcsEvent();
    expect(internals.maxBatchTimer).toBeUndefined();
    internals.enqueue(join(root, 'later-checkout-event.ts'));
    expect(internals.maxBatchTimer).toBeUndefined();
    await watcher.stop();
  });

  it('releases the retained context when the embed lane drains', async () => {
    const watcher = new McpWatcher({ rootPath: root, outputPath: analysisDir, embed: true });
    const internals = watcher as unknown as {
      scheduleEmbed(context: unknown, files: Array<{ rel: string; content: string }>, nodes: unknown[]): void;
      runEmbedLane(): Promise<void>;
      lastEmbedContext?: unknown;
      embedFiles: Map<string, string>;
    };
    internals.scheduleEmbed({ callGraph: null }, [{ rel: 'a.ts', content: 'export const a = 1;' }], []);
    expect(internals.lastEmbedContext).toBeDefined();
    await internals.runEmbedLane();
    expect(internals.embedFiles.size).toBe(0);
    expect(internals.lastEmbedContext).toBeUndefined();
    await watcher.stop();
  });

  it('releases source strings after downstream lanes consume the batch', async () => {
    await writeFile(contextPath, JSON.stringify({ signatures: [], callGraph: { nodes: [], edges: [] } }), 'utf-8');
    const sourcePath = join(root, 'large-batch-member.ts');
    await writeFile(sourcePath, `export const payload = '${'x'.repeat(32_000)}';\n`, 'utf-8');
    const watcher = new McpWatcher({ rootPath: root, outputPath: analysisDir, embed: true });
    const internals = watcher as unknown as {
      handleBatch(paths: string[]): Promise<void>;
      scheduleEmbed(context: unknown, files: Array<{ rel: string; content: string }>, nodes: unknown[]): void;
    };
    let captured: Array<{ rel: string; content: string }> = [];
    vi.spyOn(internals, 'scheduleEmbed').mockImplementation((_context, files) => { captured = files; });

    await internals.handleBatch([sourcePath]);

    expect(captured).toHaveLength(1);
    expect(captured[0].content).toBe('');
    await watcher.stop();
  });

  it('the watcher-path flush persists the patched context to disk (freshness survives a process restart)', async () => {
    await writeContext([]);
    const fooAbs = join(root, 'foo.ts');
    await writeFile(fooAbs, 'export function delta() {}\n', 'utf-8');

    const watcher = new McpWatcher({ rootPath: root, embed: false, debounceMs: 20, maxBatchMs: 1000 });
    (watcher as unknown as { enqueue(p: string): void }).enqueue(fooAbs);
    await until(async () => {
      try { return (await readFile(contextPath, 'utf-8')).includes('delta'); } catch { return false; }
    });

    const onDisk = JSON.parse(await readFile(contextPath, 'utf-8')) as { signatures: Array<{ path: string; entries: Array<{ name: string }> }> };
    const foo = onDisk.signatures.find((s) => s.path === 'foo.ts');
    expect(foo).toBeDefined();
    expect(foo!.entries.some((e) => e.name === 'delta')).toBe(true);

    await watcher.stop();
  });

  it('stop waits for an in-flight flush and rejects later file events', async () => {
    await writeContext([]);
    const fooAbs = join(root, 'shutdown.ts');
    await writeFile(fooAbs, 'export function beforeStop() {}\n', 'utf-8');

    const watcher = new McpWatcher({ rootPath: root, embed: false, debounceMs: 1 });
    const internals = watcher as unknown as {
      enqueue(path: string): void;
      handleBatch(paths: string[], opts?: { syncFlush?: boolean }): Promise<void>;
      pending: Set<string>;
    };
    const originalHandleBatch = internals.handleBatch.bind(watcher);
    let enterFlush!: () => void;
    let releaseFlush!: () => void;
    const flushEntered = new Promise<void>((resolve) => { enterFlush = resolve; });
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    vi.spyOn(internals, 'handleBatch').mockImplementation(async (...args) => {
      enterFlush();
      await flushGate;
      await originalHandleBatch(...args);
    });

    internals.enqueue(fooAbs);
    await flushEntered;

    let stopped = false;
    const stopPromise = watcher.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseFlush();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(await readFile(contextPath, 'utf-8')).toContain('beforeStop');

    internals.enqueue(join(root, 'after-stop.ts'));
    expect(internals.pending.size).toBe(0);
  });

  it('drains an over-threshold shutdown batch instead of discarding it', async () => {
    await writeFile(contextPath, JSON.stringify({ signatures: [], callGraph: { nodes: [], edges: [] } }), 'utf-8');
    const paths = ['shutdown-a.ts', 'shutdown-b.ts', 'shutdown-c.ts'].map(name => join(root, name));
    await Promise.all(paths.map((path, index) =>
      writeFile(path, `export function shutdown${index}() {}\n`, 'utf-8')));
    const watcher = new McpWatcher({ rootPath: root, embed: true, bulkThreshold: 2 });
    const internals = watcher as unknown as {
      pending: Set<string>;
      updateVectors(context: unknown, files: Array<{ rel: string; content: string }>, nodes: unknown[]): Promise<void>;
    };
    const vectorUpdate = vi.spyOn(internals, 'updateVectors').mockResolvedValue(undefined);
    for (const path of paths) internals.pending.add(path);

    await watcher.stop();

    const context = JSON.parse(await readFile(contextPath, 'utf-8')) as {
      signatures: Array<{ path: string }>;
    };
    expect(context.signatures.map(signature => signature.path).sort()).toEqual([
      'shutdown-a.ts',
      'shutdown-b.ts',
      'shutdown-c.ts',
    ]);
    expect(vectorUpdate).toHaveBeenCalledTimes(1);
    expect(vectorUpdate.mock.calls[0][1]).toHaveLength(3);
  });
});
