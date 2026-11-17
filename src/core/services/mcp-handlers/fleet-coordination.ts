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
 * those tools, it does not re-derive them. Live PR/branch harvesting and the CLI are follow-ups.
 *
 * Records end on the SAME evidence as peer-board entries, through the board's own batched decider
 * (`judgeLifecycle`): idle expiry, worktree removed, branch deleted, branch merged. A record does
 * not carry everything those predicates need, and a missing field never means "ended" — a record
 * with no `recordedAt` (every record written before this lifecycle existed) is NOT expired, an
 * unrecorded directory is not a removed worktree, and a `baseCommit` that is not a commit id leaves
 * the merged predicate unknown instead of handing peer text to git. `fleet_status` mirrors
 * `readBoard`: read-only, with ended records reported as a count and reasons, never as a live
 * verdict; the next `recordVerification` prunes them, as `pruneEnded` does for the board.
 */

import { memoryFreshness } from '../../decisions/anchor.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';
import type { StructuralAnchor } from '../../../types/index.js';
import type { EndReason, LifecycleSubject, LifecycleUnknown } from '../footprint-board.js';
import { validateDirectory, safeJoin } from './utils.js';
import { OPENLORE_DIR } from '../../../constants.js';
import { mkdir, rm, realpath, lstat } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { readFileConfined } from '../../../utils/path-confinement.js';
import { atomicWriteFile, withCommitLock } from '../../decisions/atomic-store.js';

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
  /** The analysis directory (canonical) that recorded it; set when records are shared by the clone. */
  worktree?: string;
  /**
   * When the verdict was recorded (ISO). Optional: records written before the lifecycle existed
   * carry none, and are never expired by the idle rule — only reported as unknown for it.
   */
  recordedAt?: string;
  /**
   * Whether `branch` really was a local branch of the clone when the verdict was recorded. Stamped
   * at write time; without it, a `branch` absent from the clone today proves nothing (the field is
   * also used for a task id), so the branch predicates report unknown rather than "deleted".
   */
  branchWasLocalRef?: boolean;
}

export type RecordState = 'still-valid' | 'carried' | 'invalidated' | 'needs-reverification' | 'other-worktree';

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
  'other-worktree': 'recorded in another worktree of this clone; its code is not this one, so it is not checked here — run fleet_status there',
};

/** Classify each record's currency against a freshness view. Pure over (records, view). */
export function classifyRecords(
  records: readonly VerificationRecord[],
  view: Parameters<typeof memoryFreshness>[1] | null,
  here?: string,
): ClassifiedRecord[] {
  return records.map((r) => {
    let state: RecordState = 'needs-reverification';
    if (here !== undefined && r.worktree !== undefined && r.worktree !== here) state = 'other-worktree';
    // An anchor with no captured hash proves only that a file exists: never a fresh verdict.
    else if (view && r.anchors.every(a => typeof a.contentHash === 'string')) {
      try {
        const { freshness, anchored } = memoryFreshness(r.anchors, view);
        state = stateForFreshness(freshness, anchored);
      } catch { /* an anchor the view cannot read: re-verify */ }
    }
    return {
      id: r.id, branch: r.branch, verdict: r.verdict, producedBy: r.producedBy,
      baseCommit: r.baseCommit, state, reason: REASON[state],
    };
  });
}

const VERDICTS = new Set<string>(['blast-radius-clean', 'surface-stable', 'merge-compatible']);
const optStr = (v: unknown) => v === undefined || typeof v === 'string';
/** An anchor the freshness check can read without throwing: a string path, string identity fields. */
const isAnchor = (v: unknown): v is StructuralAnchor => {
  const a = v as Partial<StructuralAnchor> | null;
  return !!a && typeof a === 'object' && typeof a.filePath === 'string'
    && optStr(a.nodeId) && optStr(a.stableId) && optStr(a.symbolName) && optStr(a.contentHash) && optStr((a as { spanText?: unknown }).spanText);
};
/** Records are written by any worktree of the clone: only well-formed ones are read. */
const isRecord = (v: unknown): v is VerificationRecord => {
  const r = v as Partial<VerificationRecord> | null;
  return !!r && typeof r === 'object' && typeof r.id === 'string' && r.id.length <= 256 && VERDICTS.has(r.verdict as string)
    && typeof r.branch === 'string' && typeof r.baseCommit === 'string' && typeof r.producedBy === 'string'
    && optStr(r.worktree) && optStr(r.recordedAt) && (r.branchWasLocalRef === undefined || typeof r.branchWasLocalRef === 'boolean')
    && Array.isArray(r.anchors) && r.anchors.every(isAnchor);
};

/** A commit id, never an option or a revision expression: `baseCommit` is peer-written. */
const COMMIT_ID_RE = /^[0-9a-f]{40,64}$/;

/**
 * What the board's lifecycle predicates can read off a record. Pure, and deliberately partial: a
 * field the record does not carry is left out so its predicate reports `unknown`, never "ended".
 *
 * `worktree` on a record is the ANALYSIS directory, which may be a package inside the worktree, so
 * it is offered as the subject's `root` (must still exist) and not matched against the clone's
 * worktree list — that would read a monorepo package as a removed worktree.
 */
export function lifecycleSubjectFor(r: VerificationRecord): LifecycleSubject {
  // A timestamp that cannot be parsed is absent evidence, not proof of staleness: nothing ever
  // re-proves a record, so a malformed one must leave the idle rule unknown, not expire it.
  const usableTime = r.recordedAt !== undefined && Number.isFinite(Date.parse(r.recordedAt));
  return {
    ...(usableTime ? { lastSeenAt: r.recordedAt } : {}),
    ...(r.worktree !== undefined ? { root: r.worktree } : {}),
    branch: r.branch,
    ...(r.branchWasLocalRef === true ? { branchKnownRef: true } : {}),
    ...(COMMIT_ID_RE.test(r.baseCommit) ? { baseAtDeclare: r.baseCommit } : {}),
  };
}

/** Records still live, and those that ended with the board's reason, plus unknown predicates. */
export interface RecordLifecycle {
  live: Array<{ record: VerificationRecord; unknown: LifecycleUnknown[] }>;
  ended: Array<{ id: string; branch: string; reason: EndReason; unknown: LifecycleUnknown[] }>;
  /** How many live records left each predicate unevaluated, and why. */
  unknown: Partial<Record<LifecycleUnknown, number>>;
}

/** Judge every record against the board's end predicates (one batch: one `main` + worktree lookup). */
async function judgeRecords(absDir: string, records: readonly VerificationRecord[], now?: number): Promise<RecordLifecycle> {
  const { judgeLifecycle } = await import('../footprint-board.js');
  const out: RecordLifecycle = { live: [], ended: [], unknown: {} };
  let judged: Array<{ item: VerificationRecord; reason: EndReason | null; unknown: LifecycleUnknown[] }>;
  try {
    judged = await judgeLifecycle(absDir, records, lifecycleSubjectFor, now !== undefined ? { now } : {});
  } catch {
    // A belt-and-braces guard: the decider already resolves an unanswerable git call to `unknown`,
    // so nothing should throw here — and if anything does, nothing is dropped on a failed check.
    return { live: records.map(record => ({ record, unknown: [] })), ended: [], unknown: {} };
  }
  for (const { item, reason, unknown } of judged) {
    if (reason) { out.ended.push({ id: item.id, branch: item.branch, reason, unknown }); continue; }
    out.live.push({ record: item, unknown });
    for (const u of unknown) out.unknown[u] = (out.unknown[u] ?? 0) + 1;
  }
  return out;
}

const UNKNOWN_REASON: Record<LifecycleUnknown, string> = {
  'expiry-unknown-no-timestamp': 'no usable recordedAt (absent, or not a date that can be parsed): the 30-minute idle rule was not applied, so the record was kept',
  'worktree-unknown-not-recorded': 'no directory recorded: the removed-worktree rule was not applied',
  'branch-unknown-detached-or-unrecorded': 'the record\'s branch field is empty: the branch rules were not applied',
  'branch-unknown-unusable-name': 'the recorded branch name is not one git can be asked about: the branch rules were not applied',
  'branch-unknown-git-could-not-be-asked': 'git could not list this clone\'s branches (for example not a git work tree, no git on PATH, or git refused the directory): the branch rules were not applied, and nothing was read as a deleted branch',
  'branch-unknown-never-a-known-branch': 'the recorded branch is not a branch of this clone and there is no evidence it ever was one: the branch rules were not applied',
  'branch-merged-unknown-no-default-branch': 'no main or master branch: the merged rule was not applied',
  'branch-merged-unknown-no-base-commit': 'baseCommit is absent or not a 40-64 character hex commit id: the merged rule was not applied (it was never passed to git)',
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

/** A records file: its well-formed records, and whether it was read whole (`missing` when absent). */
interface RecordsRead { records: VerificationRecord[]; state: 'read' | 'missing' | 'unreadable'; complete: boolean }

async function readRecordsAt(dir: string, name: string): Promise<RecordsRead> {
  let text: string;
  try { text = await readFileConfined(dir, name, MAX_RECORDS_BYTES); } catch (e) {
    return { records: [], state: (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable', complete: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return { records: [], state: 'unreadable', complete: false };
    const records = parsed.filter(isRecord);
    return { records: records.slice(0, MAX_RECORDS), state: 'read', complete: records.length === parsed.length && records.length <= MAX_RECORDS };
  } catch { return { records: [], state: 'unreadable', complete: false }; }
}

/** The shared records, plus any legacy per-worktree record the shared file does not hold yet. */
async function loadRecords(absDir: string): Promise<{ records: VerificationRecord[]; shared: RecordsRead | null; legacy: RecordsRead }> {
  const dir = await sharedRecordsDir(absDir);
  const shared = dir ? await readRecordsAt(dir, RECORDS_FILE) : null;
  const legacy = await readRecordsAt(absDir, LEGACY_RECORDS_REL);
  const records = [...(shared?.records ?? [])];
  const ids = new Set(records.map(r => r.id));
  for (const r of legacy.records) if (!ids.has(r.id)) records.push(r);
  return { records, shared, legacy };
}

/** Newest records that fit the read limit (compact JSON), so every write stays readable. */
function fitRecords(records: VerificationRecord[]): string {
  let kept = records.slice(-MAX_RECORDS);
  let text = JSON.stringify(kept);
  while (Buffer.byteLength(text) > MAX_RECORDS_BYTES && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 10));
    text = JSON.stringify(kept);
  }
  return text;
}

/**
 * Record a verification verdict (coordination-scoped), shared by the clone's worktrees. Advisory.
 * Serialized by a lock next to the file; refuses to write over a records file it could not read.
 */
export async function recordVerification(absDir: string, record: VerificationRecord, opts: { now?: number } = {}): Promise<void> {
  const dir = await sharedRecordsDir(absDir);
  const path = dir ? join(dir, RECORDS_FILE) : safeJoin(absDir, LEGACY_RECORDS_REL);
  await mkdir(dirname(path), { recursive: true });
  const worktree = dir ? await realpath(absDir).catch(() => absDir) : undefined;
  const { isLocalBranch } = await import('../footprint-board.js');
  const branchWasLocalRef = (await isLocalBranch(absDir, record.branch)) === true;
  await withCommitLock(`${path}.lock`, async () => {
    const { records, shared, legacy } = await loadRecords(absDir);
    const own = dir ? shared! : legacy;
    if (own.state === 'unreadable') throw new Error(`The verification records at ${path} could not be read; nothing was written over them.`);
    // The write is where ended records are pruned, mirroring the board's pruneEnded: the read path
    // stays read-only. Judged inside the lock, over what the file holds right now.
    const kept = (await judgeRecords(absDir, records, opts.now)).live.map(l => l.record);
    const next = kept.filter(r => r.id !== record.id);
    next.push({
      ...record,
      recordedAt: record.recordedAt ?? new Date(opts.now ?? Date.now()).toISOString(),
      // Positive evidence for the branch predicates, captured while it is still checkable. Absent
      // when the name is not a branch (a task id) or git could not be asked.
      ...(branchWasLocalRef ? { branchWasLocalRef } : {}),
      ...(worktree ? { worktree } : {}),
    });
    await atomicWriteFile(path, fitRecords(next));
    // Folded into the shared file: the legacy copy (this tool's own artifact) is retired only when
    // every record in it was read and carried over, and it is a regular file inside this directory.
    if (dir && legacy.state === 'read' && legacy.complete) {
      const legacyPath = safeJoin(absDir, LEGACY_RECORDS_REL);
      const realLegacy = await realpath(legacyPath).catch(() => null);
      const top = await realpath(absDir).catch(() => absDir);
      const rel = realLegacy ? relative(top, realLegacy) : '..';
      if (!rel.startsWith('..') && !isAbsolute(rel) && (await lstat(legacyPath)).isFile()) await rm(legacyPath, { force: true }).catch(() => {});
    }
  });
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
export async function handleFleetStatus(input: FleetStatusInput, opts: { now?: number } = {}): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(input.directory);
  const { records: all } = await loadRecords(absDir);
  // Ended records are not live verdicts: reported as a count with reasons, pruned on the next write.
  const lifecycle = await judgeRecords(absDir, all, opts.now);
  const records = lifecycle.live.map(l => l.record);
  // Which rule was skipped, per record: an aggregate alone cannot say WHICH verdict is undecayed.
  const unknownById = new Map(lifecycle.live.map(l => [l.record.id, l.unknown]));
  const here = await realpath(absDir).catch(() => absDir);

  let view: Parameters<typeof memoryFreshness>[1] | null = null;
  try {
    const ctx = AnchorContext.open(absDir);
    if (ctx) view = ctx.freshnessView();
  } catch { /* no graph available — view stays null, so every record is needs-reverification */ }

  // Any worktree of the clone may have written a record: its text is screened before it is served.
  const { emittedText } = await import('../generated-file-guard.js');
  const classified = classifyRecords(records, view, here).map(c => ({
    ...c, id: emittedText(c.id), branch: emittedText(c.branch), producedBy: emittedText(c.producedBy), baseCommit: emittedText(c.baseCommit),
    ...((unknownById.get(c.id) ?? []).length ? { unknownPredicates: unknownById.get(c.id) } : {}),
  }));
  const counts = classified.reduce<Record<RecordState, number>>((acc, c) => {
    acc[c.state] = (acc[c.state] ?? 0) + 1; return acc;
  }, { 'still-valid': 0, 'carried': 0, 'invalidated': 0, 'needs-reverification': 0, 'other-worktree': 0 });

  const endedCounts = lifecycle.ended.reduce<Partial<Record<EndReason, number>>>((acc, e) => {
    acc[e.reason] = (acc[e.reason] ?? 0) + 1; return acc;
  }, {});
  // Always emitted, empty included: an absent lane would make "everything was checked" silent.
  const unknownNotes = Object.entries(lifecycle.unknown).map(([k, n]) => `${n} record${n === 1 ? '' : 's'}: ${UNKNOWN_REASON[k as LifecycleUnknown]}`);

  return {
    tool: 'fleet_status',
    posture: 'advisory',
    verificationMemory: {
      records: classified,
      summary: counts,
      // Records that ended on the board's own evidence. Counted with the reason, never served as a
      // live verdict; the next recordVerification removes them from the file.
      ended: {
        count: lifecycle.ended.length,
        byReason: endedCounts,
        ...(lifecycle.ended.length
          ? { records: lifecycle.ended.map(e => ({ id: emittedText(e.id), branch: emittedText(e.branch), reason: e.reason, ...(e.unknown.length ? { unknownPredicates: e.unknown } : {}) })) }
          : {}),
        note: 'A record ends on the same evidence as a peer-board entry: 30 minutes without being re-proven, a removed recorded directory, a deleted branch, or a branch merged into the default branch. The reason names which.',
      },
      // What could NOT be checked. A record missing a field is kept, never expired by its absence.
      unknownPredicates: unknownNotes,
      note: view
        ? 'Verdicts re-checked against the current graph via the freshness lease; a verdict is never served fresh once its base moved without this check. No tool records a verdict yet, so this store is empty unless a caller used the API directly.'
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
      'Advisory and read-only. Live PR/branch harvesting and the CLI are follow-ups; today the arc tools are referenced per branch, not executed here.',
      'No tool records a verdict yet: recordVerification is API-only, so this store is empty unless a caller writes to it directly. An empty record list means nothing has been recorded, not that nothing holds.',
      'Nothing re-proves a record the way declare_footprint refreshes a board entry, so a verdict decays 30 minutes after it was recorded; re-run the producing tool to prove it again.',
      'A record whose recorded directory no longer exists ends as worktree-removed even when only that directory moved (a renamed package in a monorepo) and the worktree itself is intact.',
      'A squash-merged or rebase-merged branch, and a branch whose tip sits further back than main\'s last 5000 first-parent commits, are not detected as merged; such a record ends when its branch is deleted or after 30 minutes, if it carries the evidence those rules need.',
      'A rule named in unknownPredicates could not be evaluated: the records it applies to were kept, not proven live.',
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
