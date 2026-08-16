import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
const spawn = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn());
const child = vi.hoisted(() => ({
  once: vi.fn((event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, handler); return child; }),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, handler); return child; }),
  unref: vi.fn(),
  kill: vi.fn(),
  exitCode: null,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn,
}));
vi.mock('../analyzer/vector-index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../analyzer/vector-index.js')>(),
  invalidateVectorIndexCaches: invalidate,
}));

import { McpWatcher } from './mcp-watcher.js';

describe('McpWatcher vector-cache handoff after self rebuild', () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'openlore-watch-vector-cache-'));
    handlers.clear();
    spawn.mockReset().mockReturnValue(child);
    invalidate.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('invalidates caches after a successful child completion', () => {
    const watcher = new McpWatcher({ rootPath: root, selfRebuild: true });
    watcher._triggerGraphStaleForTesting('head-change');
    vi.advanceTimersByTime(2_000);
    handlers.get('close')?.(0);
    expect(invalidate).toHaveBeenCalledWith(join(root, '.openlore', 'analysis'));
  });

  it('does not invalidate caches after a failed child completion', () => {
    const watcher = new McpWatcher({ rootPath: root, selfRebuild: true });
    watcher._triggerGraphStaleForTesting('head-change');
    vi.advanceTimersByTime(2_000);
    handlers.get('close')?.(1);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
