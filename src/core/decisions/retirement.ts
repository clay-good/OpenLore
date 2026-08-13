/**
 * Terminal disposition for anchored records whose code is gone for good
 * (change: scope-advisory-noise-to-touched-code).
 *
 * An anchor to a file that was deleted long ago produces the same orphaned
 * finding on every run, forever. It is not actionable — there is nothing left to
 * re-anchor to — so repeating it trains the reader to skip the whole memory
 * section, including the findings that ARE actionable. Retirement gives such a
 * record one terminal state: reported once, then recorded as retired with a
 * stable reason and never re-reported.
 *
 * Two properties are load-bearing:
 *   - Retirement NEVER rewrites the recorded text. It appends a disposition; the
 *     fact stays queryable under `recall --asOf` exactly as it was written.
 *   - A file merely missing from the working tree is NOT retired. It may be an
 *     uncommitted deletion under review, and the finding is precisely what the
 *     reviewer needs. Only a file absent from BOTH the working tree and `HEAD`
 *     is treated as gone.
 *
 * Deterministic and local: `git cat-file -e HEAD:<path>` plus a filesystem check,
 * no LLM, no heuristics.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { loadDecisionStore, saveDecisionStore } from './store.js';
import { updateMemoryStore } from './memory-store.js';
import type {
  AnchoredMemory,
  PendingDecision,
  RetirementReason,
  StructuralAnchor,
} from '../../types/index.js';

const execFileAsync = promisify(execFile);

/** The one reason a record is retired today. */
export const ANCHOR_FILE_DELETED: RetirementReason = 'anchor-file-deleted';

/** True once a record carries a terminal disposition. */
export function isRetired(record: { retiredAt?: string }): boolean {
  return typeof record.retiredAt === 'string' && record.retiredAt.length > 0;
}

/**
 * True when `filePath` exists in neither the working tree nor `HEAD` — i.e. the
 * deletion is committed history, not a pending edit.
 *
 * Fails CLOSED: any git error (not a repo, no commits, a path git refuses)
 * returns false, so an unverifiable file is never retired on a guess.
 */
export async function isFileGoneFromHistory(rootPath: string, filePath: string): Promise<boolean> {
  if (!filePath) return false;
  // A path escaping the repo cannot be judged here — leave the record alone.
  if (isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')) return false;
  if (existsSync(join(rootPath, filePath))) return false;
  try {
    // `-e` exits 0 when the blob exists at HEAD, 1 when it does not.
    await execFileAsync('git', ['cat-file', '-e', `HEAD:${filePath}`], { cwd: rootPath });
    return false;                       // still tracked at HEAD ⇒ uncommitted deletion
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1 || code === 128) {
      // 128 covers "path does not exist in HEAD" as well as "not a git repo" /
      // "no HEAD yet". Distinguish the two: without a resolvable HEAD there is no
      // history to be absent from, so nothing is retired.
      return await hasHead(rootPath);
    }
    logger.debug(`isFileGoneFromHistory(${filePath}): ${(err as Error).message}`);
    return false;
  }
}

async function hasHead(rootPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: rootPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when EVERY anchor of a record points at a file gone from history. A record
 * with one surviving anchor is still about live code and keeps its finding.
 */
async function allAnchorsGone(rootPath: string, files: readonly string[]): Promise<boolean> {
  const paths = files.filter(f => !!f);
  if (paths.length === 0) return false;   // nothing to judge ⇒ never retire
  for (const path of new Set(paths)) {
    if (!(await isFileGoneFromHistory(rootPath, path))) return false;
  }
  return true;
}

function anchorFiles(anchors: readonly StructuralAnchor[] | undefined): string[] {
  return (anchors ?? []).map(a => a.filePath).filter((p): p is string => !!p);
}

export interface RetirementOutcome {
  /** Ids of records retired by THIS run (empty when nothing changed). */
  retiredIds: Set<string>;
}

/**
 * Retire every non-retired decision and note whose anchors all point at files
 * absent from the working tree and `HEAD`. Returns the ids retired by this run;
 * a second run over the same repository state returns none, which is exactly the
 * "reported once" property.
 *
 * Best-effort and non-fatal: a store that fails to persist leaves the records
 * un-retired (they will be re-reported), never half-written.
 */
export async function retireRecordsWithDeletedAnchors(
  rootPath: string,
  candidates: {
    decisions?: readonly PendingDecision[];
    memories?: readonly AnchoredMemory[];
  },
): Promise<RetirementOutcome> {
  const retiredIds = new Set<string>();
  const retiredAt = new Date().toISOString();

  const decisionIds: string[] = [];
  for (const d of candidates.decisions ?? []) {
    if (isRetired(d)) continue;
    // Legacy decisions carry no anchors; fall back to affectedFiles, the same
    // file-level basis their freshness verdict uses.
    const files = anchorFiles(d.anchors).length > 0 ? anchorFiles(d.anchors) : d.affectedFiles;
    if (await allAnchorsGone(rootPath, files)) decisionIds.push(d.id);
  }

  const memoryIds: string[] = [];
  for (const m of candidates.memories ?? []) {
    if (isRetired(m) || m.invalidatedAt) continue;
    if (await allAnchorsGone(rootPath, anchorFiles(m.anchors))) memoryIds.push(m.id);
  }

  if (decisionIds.length > 0) {
    try {
      const store = await loadDecisionStore(rootPath);
      const ids = new Set(decisionIds);
      await saveDecisionStore(rootPath, {
        ...store,
        decisions: store.decisions.map(d =>
          ids.has(d.id) && !isRetired(d)
            ? { ...d, retiredAt, retiredReason: ANCHOR_FILE_DELETED }
            : d),
      });
      for (const id of ids) retiredIds.add(id);
    } catch (err) {
      logger.debug(`retireRecordsWithDeletedAnchors(decisions): ${(err as Error).message}`);
    }
  }

  if (memoryIds.length > 0) {
    try {
      const ids = new Set(memoryIds);
      await updateMemoryStore(rootPath, store => ({
        ...store,
        memories: store.memories.map(m =>
          ids.has(m.id) && !isRetired(m)
            ? { ...m, retiredAt, retiredReason: ANCHOR_FILE_DELETED }
            : m),
      }));
      for (const id of ids) retiredIds.add(id);
    } catch (err) {
      logger.debug(`retireRecordsWithDeletedAnchors(memories): ${(err as Error).message}`);
    }
  }

  return { retiredIds };
}

/**
 * The ids already carrying a terminal disposition — the set drift must not
 * re-report and `recall` must not serve as authoritative current memory.
 */
export function retiredIdsIn(
  records: { decisions?: readonly PendingDecision[]; memories?: readonly AnchoredMemory[] },
): Set<string> {
  const ids = new Set<string>();
  for (const d of records.decisions ?? []) if (isRetired(d)) ids.add(d.id);
  for (const m of records.memories ?? []) if (isRetired(m)) ids.add(m.id);
  return ids;
}
