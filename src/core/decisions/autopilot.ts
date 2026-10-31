/**
 * Decision autopilot mode and its visible trail
 * (change: default-decision-autopilot-with-visible-trace).
 *
 * One resolver for "is autopilot on here, and why", read by every surface that
 * acts on or reports the mode. An absent `governance.autopilot` means ON, except
 * where a human wired a blocking decisions gate (the explicit `openlore install`
 * path) — there it keeps meaning blocking review, today's rule.
 *
 * Kept dependency-light (heavier modules load lazily): the Pi footer imports the
 * unreviewed count from here into the Pi host process.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DECISIONS_PENDING_FILE,
  OPENLORE_DECISIONS_SUBDIR,
  OPENLORE_DIR,
} from '../../constants.js';
import { safeJoin } from '../../utils/path-confinement.js';
import type { OpenLoreConfig } from '../../types/index.js';
import type { LedgerEntry } from './ledger.js';

/** The marker line the decisions pre-commit hook carries. */
export const DECISIONS_HOOK_MARKER = '# openlore-decisions-hook';

/** Where a human reviews what autopilot accepted. */
export const DECISIONS_REVIEW_COMMAND = 'openlore decisions review';

export interface AutopilotMode {
  autopilot: boolean;
  /** Why, in words a user can act on. */
  reason: string;
  source: 'config-on' | 'config-off' | 'no-config' | 'blocking-gate' | 'default';
}

/**
 * Does this repository carry an OpenLore decisions commit gate?
 * (change: unify-onboarding-entrypoint)
 */
export async function hasOpenLoreCommitGate(rootPath: string): Promise<boolean> {
  try {
    // Lazy: git-hooks reaches node:child_process, which several suites mock partially.
    const { resolveGitHookTarget } = await import('../../cli/git-hooks.js');
    const { hookPath } = await resolveGitHookTarget(rootPath, 'pre-commit');
    return (await readFile(hookPath, 'utf-8')).includes(DECISIONS_HOOK_MARKER);
  } catch {
    return false; // no hook, or unreadable — either way, no gate we must preserve
  }
}

/**
 * Resolve the autopilot mode. `gateRunning` is set by the gate itself: a gate run
 * (hook or CI `decisions --gate`) is evidence of an explicit gate, so an absent key
 * keeps meaning blocking review there, exactly as before.
 */
export async function resolveAutopilotMode(
  rootPath: string,
  config: Pick<OpenLoreConfig, 'governance'> | null | undefined,
  opts: { gateRunning?: boolean } = {},
): Promise<AutopilotMode> {
  const configured = config?.governance?.autopilot;
  if (configured === true) return { autopilot: true, reason: 'governance.autopilot is true', source: 'config-on' };
  if (configured === false) {
    return { autopilot: false, reason: 'governance.autopilot is false — decisions wait for review', source: 'config-off' };
  }
  if (!config) {
    return { autopilot: false, reason: 'no .openlore/config.json — run "openlore init" first', source: 'no-config' };
  }
  if (opts.gateRunning || (await hasOpenLoreCommitGate(rootPath))) {
    return {
      autopilot: false,
      reason: 'a blocking decisions gate is installed; set governance.autopilot: true to auto-accept',
      source: 'blocking-gate',
    };
  }
  return {
    autopilot: true,
    reason: 'auto-initialized; set governance.autopilot: false to require review',
    source: 'default',
  };
}

/**
 * Unreviewed auto-accepted decisions, read straight from the store file. A cheap,
 * fail-soft read for the status line and the Pi footer: 0 when there is no store.
 */
export async function countUnreviewedDecisions(rootPath: string): Promise<number> {
  try {
    const path = safeJoin(resolve(rootPath), join(OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR, DECISIONS_PENDING_FILE));
    const store = JSON.parse(await readFile(path, 'utf-8')) as { decisions?: unknown };
    if (!Array.isArray(store.decisions)) return 0;
    return store.decisions.filter((d: { status?: unknown; humanReviewedAt?: unknown } | null) =>
      d?.status === 'auto-approved' && !d.humanReviewedAt).length;
  } catch {
    return 0;
  }
}

export interface GovernanceStatus {
  autopilot: boolean;
  reason: string;
  /** Decisions ever auto-accepted, from the ledger. */
  autoAccepted: number;
  /** Auto-accepted decisions no human has reviewed yet. */
  unreviewed: number;
  /** Newest ledger entries, newest first (at most 3). */
  recent: LedgerEntry[];
  review: string;
}

/** The governance block `openlore status` reports. Read-only. */
export async function collectGovernanceStatus(
  rootPath: string,
  config: Pick<OpenLoreConfig, 'governance'> | null | undefined,
): Promise<GovernanceStatus> {
  const { readLedger } = await import('./ledger.js');
  const [mode, ledger, unreviewed] = await Promise.all([
    resolveAutopilotMode(rootPath, config),
    readLedger(rootPath),
    countUnreviewedDecisions(rootPath),
  ]);
  return {
    autopilot: mode.autopilot,
    reason: mode.reason,
    autoAccepted: ledger.filter((e) => e.to === 'auto-approved').length,
    unreviewed,
    recent: ledger.slice(-3).reverse(),
    review: DECISIONS_REVIEW_COMMAND,
  };
}

const SESSION_CURSOR_FILE = 'decisions-session-cursor.json';

/**
 * Decisions auto-accepted since the previous session start, then advance the
 * cursor. Without a `.openlore/` directory nothing is written and nothing is new.
 */
export async function takeAutoAcceptsSinceLastSession(rootPath: string): Promise<LedgerEntry[]> {
  try {
    const runtimeDir = safeJoin(resolve(rootPath), join(OPENLORE_DIR, 'runtime'));
    const cursorPath = join(runtimeDir, SESSION_CURSOR_FILE);
    let since = 0;
    try {
      const parsed = Date.parse((JSON.parse(await readFile(cursorPath, 'utf-8')) as { at?: string }).at ?? '');
      if (!Number.isNaN(parsed)) since = parsed;
    } catch { /* first session: everything in the ledger is new */ }
    const { readLedger } = await import('./ledger.js');
    const fresh = (await readLedger(rootPath)).filter((e) => e.to === 'auto-approved' && Date.parse(e.at) > since);
    const { stat } = await import('node:fs/promises');
    if ((await stat(safeJoin(resolve(rootPath), OPENLORE_DIR))).isDirectory()) {
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(cursorPath, JSON.stringify({ at: new Date().toISOString() }) + '\n', 'utf-8');
    }
    return fresh;
  } catch {
    return [];
  }
}
