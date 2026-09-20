import { AsyncLocalStorage } from 'node:async_hooks';

/** Test-only counts of named work boundaries, not a process-wide profiler. */
export interface PerfWorkCounters {
  /** Calls into a tree-sitter parser through the shared parse-budget boundary. */
  sourceParses: number;
  fullNodeTableLoads: number;
  adjacencyBuilds: number;
  edgeStoreStatementPrepares: number;
  /** UTF-8 payload bytes sent through the two atomic artifact writers; excludes SQLite. */
  atomicArtifactPayloadBytes: number;
}

const scopes = new AsyncLocalStorage<PerfWorkCounters>();
let activeScopes = 0;

/** Inert outside a measurement; the production path takes one branch. */
export function recordPerfWork(metric: keyof PerfWorkCounters, amount = 1): void {
  if (activeScopes === 0) return;
  const counters = scopes.getStore();
  if (counters) counters[metric] += amount;
}

/** Avoid encoding the payload merely to measure it when no test is observing. */
export function recordAtomicArtifactPayload(data: string): void {
  if (activeScopes === 0) return;
  const counters = scopes.getStore();
  if (counters) counters.atomicArtifactPayloadBytes += Buffer.byteLength(data, 'utf-8');
}

/** Run one test operation with isolated counters, including its awaited async work. */
export async function measurePerfWorkForTests<T>(
  run: () => T | Promise<T>,
): Promise<{ result: T; counters: Readonly<PerfWorkCounters> }> {
  const counters: PerfWorkCounters = {
    sourceParses: 0,
    fullNodeTableLoads: 0,
    adjacencyBuilds: 0,
    edgeStoreStatementPrepares: 0,
    atomicArtifactPayloadBytes: 0,
  };
  activeScopes++;
  try {
    const result = await scopes.run(counters, run);
    return { result, counters: { ...counters } };
  } finally {
    activeScopes--;
  }
}
