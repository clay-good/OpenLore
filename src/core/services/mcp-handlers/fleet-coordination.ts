/**
 * fleet_status + the drift-aware verification memory (change: add-fleet-coordination-arc).
 *
 * Completes the coordination arc — plan_parallel_work (dispatch) → map_in_flight_conflicts (in
 * flight) → certify_merge (landing) — with the piece the arc was missing: continuity across a
 * moving base. When parallel agents each work off a base that advances under them, every verified
 * fact they hold ("this blast radius is clean", "this merge was certified compatible") silently
 * becomes suspect. This records each coordination verdict as a typed, anchored record carrying the
 * base commit it was proven against, and re-classifies it when the base moves — reusing the SAME
 * freshness lease `recheckCertificate` uses, so a verdict is never served fresh once its base moved
 * without the check.
 *
 * Deterministic, local, read-only against the graph. `fleet_status` composes the recorded verdicts
 * with the arc's conclusions, attributing each line to the tool that produced it; it references
 * those tools, it does not re-derive them. Live PR/branch harvesting, the expire-on-land lifecycle,
 * and the CLI are follow-ups.
 */

import { memoryFreshness } from '../../decisions/anchor.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';
import type { StructuralAnchor } from '../../../types/index.js';
import { validateDirectory, safeJoin } from './utils.js';
import { OPENLORE_DIR } from '../../../constants.js';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readFileConfined } from '../../../utils/path-confinement.js';
import { atomicWriteFile } from '../../decisions/atomic-store.js';

/** The coordination verdicts whose currency the fleet tracks. */
export type CoordinationVerdict = 'blast-radius-clean' | 'surface-stable' | 'merge-compatible';

/** A verified coordination fact, anchored to the symbols it was proven over. */
export interface VerificationRecord {
  id: string;
  verdict: CoordinationVerdict;
  /** The branch/task this verdict belongs to (for lifecycle + attribution). */
  branch: string;
  /** The base commit the verdict was proven against. */
  baseCommit: string;
  /** The tool that produced the verdict. */
  producedBy: string;
  anchors: StructuralAnchor[];
}

export type RecordState = 'still-valid' | 'carried' | 'invalidated' | 'needs-reverification';

export interface ClassifiedRecord {
  id: string;
  branch: string;
  verdict: CoordinationVerdict;
  producedBy: string;
  baseCommit: string;
  state: RecordState;
  reason: string;
}

/** The pre-board, per-worktree location: read once and folded into the shared file on the next write. */
const LEGACY_RECORDS_REL = `${OPENLORE_DIR}/coordination/verification-records.json`;
const RECORDS_FILE = 'verification-records.json';
const MAX_RECORDS_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 1000;

/**
 * Map a memory-freshness aggregate to a record state. Pure. The anchor system carries a
 * moved-but-unchanged symbol at analyze, so a carried anchor already reads `fresh` here; a genuine
 * content drift is `drifted` → invalidated; a lost anchor is `orphaned` → needs-reverification.
 * Anything else is conservatively needs-reverification — a verdict is never served fresh by default.
 */
export function stateForFreshness(freshness: string, anchored: boolean): RecordState {
  if (!anchored) return 'needs-reverification';
  switch (freshness) {
    case 'fresh': return 'still-valid';
    case 'drifted': return 'invalidated';
    case 'orphaned': return 'needs-reverification';
    default: return 'needs-reverification';
  }
}

const REASON: Record<RecordState, string> = {
  'still-valid': 'every proven symbol is unchanged since the verdict was recorded',
  'carried': 'the proven symbols moved but are unchanged (anchors re-pointed)',
  'invalidated': 'a proven symbol changed since the verdict was recorded; re-verify',
  'needs-reverification': 'a proven symbol could not be located, or the graph is unavailable; re-verify',
};

/** Classify each record's currency against a freshness view. Pure over (records, view). */
export function classifyRecords(
  records: readonly VerificationRecord[],
  view: Parameters<typeof memoryFreshness>[1] | null,
): ClassifiedRecord[] {
  return records.map((r) => {
    let state: RecordState = 'needs-reverification';
    if (view) {
      const { freshness, anchored } = memoryFreshness(r.anchors, view);
      state = stateForFreshness(freshness, anchored);
    }
    return {
      id: r.id, branch: r.branch, verdict: r.verdict, producedBy: r.producedBy,
      baseCommit: r.baseCommit, state, reason: REASON[state],
    };
  });
}

const VERDICTS = new Set<string>(['blast-radius-clean', 'surface-stable', 'merge-compatible']);
/** Records are written by any worktree of the clone: only well-formed ones are read. */
const isRecord = (v: unknown): v is VerificationRecord => {
  const r = v as Partial<VerificationRecord> | null;
  return !!r && typeof r === 'object' && typeof r.id === 'string' && r.id.length <= 256 && VERDICTS.has(r.verdict as string)
    && typeof r.branch === 'string' && typeof r.baseCommit === 'string' && typeof r.producedBy === 'string'
    && Array.isArray(r.anchors) && r.anchors.every(a => !!a && typeof a === 'object');
};

/**
 * The clone's shared records file, next to the peer board in the git common directory, so a verdict
 * one worktree proved is visible to its siblings (change: add-board-fleet-records-and-planning).
 * Null outside a git work tree: records then stay in the worktree's own `.openlore/`.
 */
async function sharedRecordsDir(absDir: string): Promise<string | null> {
  const { boardDir } = await import('../footprint-board.js');
  const board = await boardDir(absDir);
  return board ? dirname(board) : null;
}

async function readRecordsAt(dir: string, name: string): Promise<VerificationRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFileConfined(dir, name, MAX_RECORDS_BYTES));
    return Array.isArray(parsed) ? parsed.filter(isRecord).slice(0, MAX_RECORDS) : [];
  } catch { return []; }
}

/** The shared records, plus any legacy per-worktree record the shared file does not hold yet. */
async function loadRecords(absDir: string): Promise<VerificationRecord[]> {
  const shared = await sharedRecordsDir(absDir);
  const records = shared ? await readRecordsAt(shared, RECORDS_FILE) : [];
  const ids = new Set(records.map(r => r.id));
  for (const r of await readRecordsAt(absDir, LEGACY_RECORDS_REL)) if (!ids.has(r.id)) records.push(r);
  return records;
}

/** Record a verification verdict (coordination-scoped), shared by the clone's worktrees. Advisory, best-effort. */
export async function recordVerification(absDir: string, record: VerificationRecord): Promise<void> {
  const records = await loadRecords(absDir);
  const next = records.filter(r => r.id !== record.id);
  next.push(record);
  const shared = await sharedRecordsDir(absDir);
  const path = shared ? join(shared, RECORDS_FILE) : safeJoin(absDir, LEGACY_RECORDS_REL);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(next.slice(-MAX_RECORDS), null, 2));
  // Folded into the shared file: the legacy copy is this tool's own artifact and is retired.
  if (shared) await rm(safeJoin(absDir, LEGACY_RECORDS_REL), { force: true }).catch(() => {});
}

export interface FleetStatusInput {
  directory: string;
  /** In-flight branches to compose the arc for (attribution + the tools to run per branch). */
  branches?: string[];
}

/**
 * Compose the coordination arc into one readiness view: the recorded verdicts classified against
 * the current graph, plus the arc's tool references per in-flight branch. Each line is attributed
 * to its producing tool; the arc tools are referenced, not re-derived.
 */
export async function handleFleetStatus(input: FleetStatusInput): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(input.directory);
  const records = await loadRecords(absDir);

  let view: Parameters<typeof memoryFreshness>[1] | null = null;
  try {
    const ctx = AnchorContext.open(absDir);
    if (ctx) view = ctx.freshnessView();
  } catch { /* no graph available — view stays null, so every record is needs-reverification */ }

  // Any worktree of the clone may have written a record: its text is screened before it is served.
  const { emittedText } = await import('../generated-file-guard.js');
  const classified = classifyRecords(records, view).map(c => ({ ...c, id: emittedText(c.id), branch: emittedText(c.branch), producedBy: emittedText(c.producedBy), baseCommit: emittedText(c.baseCommit) }));
  const counts = classified.reduce<Record<RecordState, number>>((acc, c) => {
    acc[c.state] = (acc[c.state] ?? 0) + 1; return acc;
  }, { 'still-valid': 0, 'carried': 0, 'invalidated': 0, 'needs-reverification': 0 });

  return {
    tool: 'fleet_status',
    posture: 'advisory',
    verificationMemory: {
      records: classified,
      summary: counts,
      note: view
        ? 'Verdicts re-checked against the current graph via the freshness lease; a verdict is never served fresh once its base moved without this check.'
        : 'No graph available to re-check against — every recorded verdict is conservatively needs-reverification, not silently fresh. Run analyze_codebase.',
    },
    // The arc the fleet consults per in-flight branch — referenced, not re-run here.
    arc: {
      dispatch: 'plan_parallel_work — which tasks are safe to run concurrently (before dispatch)',
      inFlight: 'map_in_flight_conflicts — which in-flight changes collide right now',
      landing: 'certify_merge — whether two branches that merge cleanly break in combination',
      branches: input.branches ?? [],
    },
    // Live agent footprints on the clone's board (change: add-peer-footprint-board).
    board: await boardSummary(absDir),
    boundaries: [
      'Verification records are shared by every worktree of this clone (next to the peer board in the git common directory); outside a git work tree they stay in this directory.',
      'Advisory and read-only. Live PR/branch harvesting, expire-on-land record lifecycle, and the CLI are follow-ups; today the arc tools are referenced per branch, not executed here.',
    ],
  };
}

/** The live peer-board entries, screened, as served local-unreviewed data. */
async function boardSummary(absDir: string): Promise<Record<string, unknown>> {
  const { readBoard } = await import('../footprint-board.js');
  const { emittedText } = await import('../generated-file-guard.js');
  const board = await readBoard(absDir);
  return {
    live: board.live.map(({ entry: e, moved }) => ({
      actorId: emittedText(e.actorId), branch: emittedText(e.branch), worktree: emittedText(e.worktree),
      ...(e.title ? { title: emittedText(e.title) } : {}),
      writes: e.writes.length, reads: e.reads.length, creates: e.creates.length, lastSeenAt: e.lastSeenAt,
      ...(moved.length ? { movedSinceDeclared: moved.map(emittedText) } : {}),
      provenance: 'local-unreviewed',
    })),
    ...(board.ended.length ? { ended: board.ended.length } : {}),
    note: 'declare_footprint publishes and releases entries; map_in_flight_conflicts classifies them against branches and PRs.',
  };
}
