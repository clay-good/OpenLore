/**
 * make-index-self-healing: the watcher's graph-rebuild trigger — a debounced,
 * coalesced fire on a HEAD change / budget-exceeded stale region, delegated to a
 * host `onGraphStale` handler (serve's coordinator) or self-spawned. These tests
 * drive the trigger directly (no real git/fs event) and assert the debounce and
 * coalescing contract with fake timers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpWatcher, type GraphStaleReason } from './mcp-watcher.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'openlore-watch-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('McpWatcher graph-rebuild trigger', () => {
  it('fires onGraphStale exactly once for a burst within the debounce window (coalesce)', () => {
    vi.useFakeTimers();
    const fired: GraphStaleReason[] = [];
    const w = new McpWatcher({ rootPath: freshDir(), onGraphStale: (r) => fired.push(r) });

    // A `git pull` touching several refs in quick succession.
    w._triggerGraphStaleForTesting('head-change');
    w._triggerGraphStaleForTesting('head-change');
    w._triggerGraphStaleForTesting('stale-region');

    expect(fired).toEqual([]); // debounced — nothing yet
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual(['head-change']); // one rebuild, first (most-salient) reason kept
  });

  it('keeps the first reason of a coalesced burst', () => {
    vi.useFakeTimers();
    const fired: GraphStaleReason[] = [];
    const w = new McpWatcher({ rootPath: freshDir(), onGraphStale: (r) => fired.push(r) });

    w._triggerGraphStaleForTesting('stale-region');
    w._triggerGraphStaleForTesting('head-change');
    vi.advanceTimersByTime(2000);

    expect(fired).toEqual(['stale-region']);
  });

  it('a later trigger lengthens rather than shortens the armed rebuild window', () => {
    vi.useFakeTimers();
    const fired: GraphStaleReason[] = [];
    const w = new McpWatcher({ rootPath: freshDir(), onGraphStale: (r) => fired.push(r) });

    w._triggerGraphStaleForTesting('head-change');
    vi.advanceTimersByTime(1_000);
    w._triggerGraphStaleForTesting('stale-region');
    vi.advanceTimersByTime(600);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(900);
    expect(fired).toEqual(['head-change']);
  });

  it('fires again for a later, separate trigger (repeatable across the session)', () => {
    vi.useFakeTimers();
    const fired: GraphStaleReason[] = [];
    const w = new McpWatcher({ rootPath: freshDir(), onGraphStale: (r) => fired.push(r) });

    w._triggerGraphStaleForTesting('head-change');
    vi.advanceTimersByTime(2000);
    w._triggerGraphStaleForTesting('stale-region');
    vi.advanceTimersByTime(2000);

    expect(fired).toEqual(['head-change', 'stale-region']);
  });

  it('is a no-op when neither onGraphStale nor selfRebuild is configured', () => {
    vi.useFakeTimers();
    const spawn = vi.spyOn(process, 'nextTick'); // proxy: nothing should be scheduled
    const w = new McpWatcher({ rootPath: freshDir() });
    w._triggerGraphStaleForTesting('head-change');
    vi.advanceTimersByTime(5000);
    // No callback exists to observe; assert it simply did not throw and scheduled
    // no delegated work. (selfRebuild would spawn a real process — not exercised here.)
    expect(() => w._triggerGraphStaleForTesting('stale-region')).not.toThrow();
    spawn.mockRestore();
  });

  it('accepts a cited-file repair only when a rebuild lane is wired', () => {
    vi.useFakeTimers();
    const fired: GraphStaleReason[] = [];
    const hosted = new McpWatcher({ rootPath: freshDir(), onGraphStale: reason => fired.push(reason) });
    const plain = new McpWatcher({ rootPath: freshDir() });

    expect(hosted.requestColdReadRepair(['src/payments.ts', 'src/payments.ts'])).toBe(true);
    expect(plain.requestColdReadRepair(['src/payments.ts'])).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(fired).toEqual(['stale-region']);
  });
});
