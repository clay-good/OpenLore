/**
 * Anchored-memory (notes) store — CRUD for .openlore/memory/notes.json.
 * (change: add-code-anchored-memory-staleness)
 *
 * Deliberately separate from the decision store and commit gate: a `remember`
 * note is a durable, code-anchored fact, not an architectural decision, and must
 * never touch the consolidation/sync pipeline. Shared by the remember/recall
 * handlers and the memory-staleness drift detector.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileExists } from '../../utils/command-helpers.js';
import {
  OPENLORE_DIR,
  OPENLORE_MEMORY_SUBDIR,
  MEMORY_NOTES_FILE,
} from '../../constants.js';
import { atomicWriteFile, casUpdate, quarantineCorrupt } from './atomic-store.js';
import type { MemoryStore, StructuralAnchor } from '../../types/index.js';
import { safeJoin } from '../../utils/path-confinement.js';

export function memoryDir(rootPath: string): string {
  return safeJoin(resolve(rootPath), join(OPENLORE_DIR, OPENLORE_MEMORY_SUBDIR));
}

function memoryPath(rootPath: string): string {
  return safeJoin(resolve(rootPath), join(OPENLORE_DIR, OPENLORE_MEMORY_SUBDIR, MEMORY_NOTES_FILE));
}

function emptyStore(): MemoryStore {
  return { version: '1', updatedAt: '', sequence: 0, memories: [] };
}

export async function loadMemoryStore(rootPath: string): Promise<MemoryStore> {
  const path = memoryPath(rootPath);
  if (!(await fileExists(path))) return emptyStore();
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    // A read error that is not "missing file" is an I/O fault, not corruption —
    // do not quarantine (the bytes may be fine); degrade to empty loudly.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    await quarantineCorrupt(path, `read failed: ${(err as Error).message}`);
    return emptyStore();
  }
  let parsed: Partial<MemoryStore> | null;
  try {
    parsed = JSON.parse(raw) as Partial<MemoryStore>;
  } catch (err) {
    // Torn / hand-corrupted JSON: quarantine, never silently empty (a torn store
    // presented as empty is absence-as-current-fact). (harden-memory-integrity-invariant)
    await quarantineCorrupt(path, `invalid JSON: ${(err as Error).message}`);
    return emptyStore();
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.memories)) {
    await quarantineCorrupt(path, 'invalid shape (missing memories array)');
    return emptyStore();
  }
  return {
    version: '1',
    updatedAt: parsed.updatedAt ?? '',
    sequence: typeof parsed.sequence === 'number' ? parsed.sequence : 0,
    memories: parsed.memories,
  };
}

export async function saveMemoryStore(rootPath: string, store: MemoryStore): Promise<void> {
  const updated: MemoryStore = {
    ...store,
    updatedAt: new Date().toISOString(),
    sequence: (store.sequence ?? 0) + 1,
  };
  await atomicWriteFile(memoryPath(rootPath), JSON.stringify(updated, null, 2) + '\n', 0o600);
}

/**
 * Concurrency-safe read-modify-write of the memory store. Loads, applies
 * `mutate` (a pure id-keyed merge), and commits under compare-and-swap so that
 * two concurrent `remember` calls never lose a write — on a conflict the mutate
 * is re-applied to the newer store. (harden-memory-integrity-invariant)
 */
export async function updateMemoryStore(
  rootPath: string,
  mutate: (store: MemoryStore) => MemoryStore,
): Promise<MemoryStore> {
  return casUpdate<MemoryStore>({
    storePath: memoryPath(rootPath),
    load: () => loadMemoryStore(rootPath),
    mutate: (current) => ({ ...mutate(current), updatedAt: new Date().toISOString() }),
    serialize: (next) => JSON.stringify(next, null, 2) + '\n',
  });
}

/**
 * Canonical, order-independent key for a memory's resolved anchors. A symbol anchor
 * keys on its stable/content-addressed id (falling back to nodeId); a file anchor on
 * its path. Sorted so anchor input order never changes the identity.
 */
function anchorIdentity(anchors: readonly StructuralAnchor[]): string {
  return [...anchors]
    .map((a) => (a.nodeId ? `sym:${a.stableId ?? a.nodeId}` : `file:${a.filePath}`))
    .sort()
    .join('|');
}

/**
 * Stable 8-char id derived from content + resolved anchors
 * (add-bitemporal-typed-memory-operations). Re-recording the same fact about the same
 * code yields the same id (updates in place); the same content on a different anchor is
 * a distinct record. Keying on anchors, not the record timestamp, is what makes dedup
 * exact and deterministic.
 */
export function makeMemoryId(content: string, anchors: readonly StructuralAnchor[]): string {
  return createHash('sha256')
    .update(`${content}\x00${anchorIdentity(anchors)}`)
    .digest('hex')
    .slice(0, 8);
}
