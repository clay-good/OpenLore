/**
 * Decision transition ledger — append-only audit trail for every decision
 * status transition, in every mode. (change: add-decision-autopilot)
 *
 * One JSONL line per transition in `.openlore/decisions/ledger.jsonl`:
 *   { id, title, from, to, actor, at, commit? }
 *
 * `from: null` marks creation (a new decision entering the store). Actors:
 *   - 'human'     — explicit approve / reject / review (CLI, TUI, MCP on behalf of a human)
 *   - 'autopilot' — the decision autopilot auto-accepting a verified decision
 *   - 'agent'     — an agent recording a draft (record_decision)
 *   - 'sync'      — system transitions (consolidation, verification, spec sync)
 *
 * Writes are a single O_APPEND `appendFile` call per batch — atomic for the
 * small line sizes involved — and are deliberately fail-soft: a ledger write
 * failure warns on stderr and never fails the underlying store transition
 * (losing a trail line is bad; losing the decision write is worse). Existing
 * entries are never rewritten or deleted.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { DECISIONS_LEDGER_FILE, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR } from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';
import type { DecisionStatus, DecisionStore } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

// Path is built locally (not via store.ts) to keep this module dependency-free
// of the store, which imports the ledger — no import cycle.
function ledgerDir(rootPath: string): string {
  return join(rootPath, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
}

export type LedgerActor = 'human' | 'autopilot' | 'agent' | 'sync';

export interface LedgerEntry {
  /** 8-char decision id. */
  id: string;
  title: string;
  /** Prior status; null when the decision first entered the store. */
  from: DecisionStatus | null;
  to: DecisionStatus;
  actor: LedgerActor;
  /** ISO timestamp of the transition. */
  at: string;
  /** HEAD commit at transition time (best-effort; absent outside a git repo). */
  commit?: string;
}

export function ledgerPath(rootPath: string): string {
  return join(ledgerDir(rootPath), DECISIONS_LEDGER_FILE);
}

/**
 * HEAD commit (short) at transition time, best-effort. During a pre-commit hook
 * this is the parent of the commit being created — the closest honest anchor
 * available before the new commit exists. Undefined outside a git repo.
 */
export async function currentHeadCommit(rootPath: string): Promise<string | undefined> {
  try {
    // Imported lazily so this module stays loadable under tests that partially
    // mock node:child_process (several decision suites mock only `spawn`).
    const { execFile } = await import('node:child_process');
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootPath });
    const sha = String(stdout).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Diff two store snapshots into ledger entries: one per status change, plus a
 * creation entry (from: null) per decision present after but not before. Pure.
 */
export function diffStoreTransitions(
  before: DecisionStore,
  after: DecisionStore,
  actor: LedgerActor,
  at: string,
  commit?: string,
): LedgerEntry[] {
  const prior = new Map(before.decisions.map((d) => [d.id, d]));
  const entries: LedgerEntry[] = [];
  for (const d of after.decisions) {
    const was = prior.get(d.id);
    if (!was) {
      entries.push({ id: d.id, title: d.title, from: null, to: d.status, actor, at, ...(commit ? { commit } : {}) });
    } else if (was.status !== d.status) {
      entries.push({ id: d.id, title: d.title, from: was.status, to: d.status, actor, at, ...(commit ? { commit } : {}) });
    }
  }
  return entries;
}

/**
 * Append entries to the ledger. Fail-soft: warns on stderr, never throws —
 * the store transition this trails must not be broken by a trail write fault.
 */
export async function appendLedgerEntries(rootPath: string, entries: LedgerEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const path = ledgerPath(rootPath);
    await mkdir(ledgerDir(rootPath), { recursive: true });
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await appendFile(path, lines, 'utf-8');
  } catch (err) {
    logger.error(`Decision ledger append failed (trail line lost): ${(err as Error).message}`);
  }
}

/**
 * Read the full ledger, oldest-first. Malformed lines are skipped (a torn tail
 * line from a crashed writer must not poison the readable history).
 */
export async function readLedger(rootPath: string): Promise<LedgerEntry[]> {
  const path = ledgerPath(rootPath);
  if (!(await fileExists(path))) return [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LedgerEntry;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.to === 'string') entries.push(parsed);
    } catch {
      /* skip malformed line */
    }
  }
  return entries;
}
