import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { OPENLORE_DIR } from '../../constants.js';
import { acquireLockAt, isLockHeld } from './advisory-lock.js';

const GENERATION_LOCK_FILE = '.generation.lock';
const GENERATION_RUNTIME_SUBDIR = 'runtime';

export interface GenerationLockOptions {
  maxWaitMs?: number;
  signal?: AbortSignal;
}

export class GenerationLockHeldError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly ageMs: number,
  ) {
    super(`Generation is locked at ${lockPath}; verify that no generator is running, then remove the lock if its owner cannot recover.`);
    this.name = 'GenerationLockHeldError';
  }
}

/** Acquire the repository-scoped lock covering every mutating generation phase. */
export async function acquireGenerationLock(
  rootPath: string,
  options: GenerationLockOptions = {},
): Promise<() => Promise<void>> {
  const normalizedRoot = resolve(rootPath);
  const canonicalRoot = await realpath(normalizedRoot).catch(() => normalizedRoot);
  const runtimeDir = join(canonicalRoot, OPENLORE_DIR, GENERATION_RUNTIME_SUBDIR);
  const result = await acquireLockAt(runtimeDir, GENERATION_LOCK_FILE, {
    bestEffortAfterMaxWait: false,
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    signal: options.signal,
  });
  if (isLockHeld(result)) throw new GenerationLockHeldError(result.lockPath, result.ageMs);
  return result.release;
}

/** Serialize one complete mutating generation while always releasing ownership. */
export async function withGenerationLock<T>(
  rootPath: string,
  callback: () => Promise<T>,
  options: GenerationLockOptions = {},
): Promise<T> {
  const release = await acquireGenerationLock(rootPath, options);
  try {
    return await callback();
  } finally {
    await release();
  }
}

export { GENERATION_LOCK_FILE };
