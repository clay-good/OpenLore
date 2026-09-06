/**
 * The partial first-run index (change: refine-first-run-partial-serving).
 *
 * Until this existed, the first `analyze` on a repository was all-or-nothing: every
 * tool answered "no index found" for the whole build, even though the pipeline
 * finishes mapping, the dependency graph, and the inventory extractors long before
 * the call-graph pass — the phase that dominates the wall clock. OpenLore already
 * had the right contract for a STALE index (serve what exists, disclose that a
 * refresh is running, never present it as fresh); this module extends that contract
 * to the ABSENT case, which is also the onboarding case.
 *
 * Two properties decide the whole design:
 *
 *   1. **A partial index is never an analysis artifact.** It is written to its own
 *      directory under `.openlore/runtime/`, never into `.openlore/analysis/`. So the
 *      published generation, the fingerprint, the SQLite store, the build attestation,
 *      and every exporter/importer/attester that reads the analysis directory cannot
 *      see it — not by remembering to check, but because it is not there. The explicit
 *      refusals elsewhere are a second lock on a door that is already shut.
 *
 *   2. **It carries its own integrity commit.** The partial directory publishes its own
 *      generation manifest through the same {@link publishGeneration} primitive the real
 *      analysis uses, so a reader binds to a content digest rather than to whatever bytes
 *      happen to be on disk mid-write.
 *
 * A partial index is local serving state and nothing else. It is deleted when the build
 * that owns it completes, and a reader ignores one whose owner is gone.
 */

import { readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import {
  publishGeneration,
  readCurrentGeneration,
  artifactMatchesGeneration,
} from './analysis-generation.js';
import { isProcessAlive, runtimeDirOf } from './analysis-ownership.js';

/** Directory name, under the runtime directory, that holds the partial index. */
export const PARTIAL_INDEX_SUBDIR = 'partial-analysis';

/** The completeness receipt's file name inside {@link PARTIAL_INDEX_SUBDIR}. */
export const PARTIAL_STAMP_FILE = 'partial-index.json';

/**
 * The artifacts a partial index must contain to be served.
 *
 * Deliberately a SUBSET of `REQUIRED_ANALYSIS_ARTIFACTS`, and deliberately without
 * `fingerprint.json`: the fingerprint is the freshness key that says "this tree is
 * analyzed". A partial index must never be able to answer that question.
 */
export const PARTIAL_REQUIRED_ARTIFACTS = [
  'repo-structure.json',
  'llm-context.json',
  'dependency-graph.json',
] as const;

/**
 * How long a partial index whose owning process is still alive may go unrefreshed
 * before a reader stops trusting it. The writer re-stamps on every phase boundary and
 * on the artifact-phase heartbeat (15s), so ten minutes of silence means the build is
 * wedged, not slow.
 */
export const PARTIAL_STAMP_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The build phase a flush was taken at. A strict subset of `AnalysisStage`: nothing is
 * flushed before the dependency graph exists (there is no useful structure yet), and
 * nothing is flushed after `artifacts`, because that phase ends in the real publish.
 */
export type PartialPhase = 'dependency-graph' | 'extractors' | 'artifacts';

/** Coarse completeness, in the same 0–100 frame the analysis progress sidecar uses. */
const PHASE_PERCENT: Record<PartialPhase, number> = {
  'dependency-graph': 25,
  extractors: 50,
  artifacts: 75,
};

/**
 * What a partial index knows about itself.
 *
 * `filesExtracted` counts files whose CALL-GRAPH facts are in this index — zero for
 * every flush this lane currently takes, because the call-graph pass is the phase still
 * running. It is reported rather than omitted precisely so the gap is legible: a reader
 * that sees `filesExtracted: 0` against a four-figure `filesTotal` cannot mistake the
 * index for one that merely missed a few files.
 */
export interface PartialIndexStamp {
  partial: true;
  phase: PartialPhase;
  /** Files whose call-graph facts are present in this index. */
  filesExtracted: number;
  /** Files in the analyzed corpus, as the completed mapping phase counted them. */
  filesTotal: number;
  /** Files present in the flushed repository structure (mapped and scored). */
  filesMapped: number;
  startedAt: string;
  updatedAt: string;
  /** The analyzing process. A partial index outliving its owner is abandoned. */
  pid: number;
  /** Facts a completed index carries that this one does not. */
  absent: string[];
}

export function partialIndexDirOf(analysisDir: string): string {
  return join(runtimeDirOf(analysisDir), PARTIAL_INDEX_SUBDIR);
}

export function partialStampPathOf(analysisDir: string): string {
  return join(partialIndexDirOf(analysisDir), PARTIAL_STAMP_FILE);
}

/** Completeness as a percentage, derived from the phase — never from a tuned constant. */
export function partialCompletenessPercent(stamp: PartialIndexStamp): number {
  return PHASE_PERCENT[stamp.phase] ?? 0;
}

/**
 * The one sentence a partial answer is disclosed with.
 *
 * Says three things and nothing else: how complete the index is, that the ordering put
 * the highest-value files first, and that what is missing is INVISIBLE to this answer
 * rather than absent from the repository. The last clause is the whole point — a
 * partial index that reads as complete is worse than no index at all.
 */
export function describePartialIndex(stamp: PartialIndexStamp): string {
  const absent = stamp.absent.length > 0 ? ` Not yet built: ${stamp.absent.join(', ')}.` : '';
  return (
    `Served from a partial first-run index — ${partialCompletenessPercent(stamp)}% complete `
    + `(phase: ${stamp.phase}; ${stamp.filesMapped} of ${stamp.filesTotal} files mapped, `
    + `${stamp.filesExtracted} with call-graph facts). Input is significance-ordered, so the `
    + `highest-value files are covered first.${absent} Files this index has not reached are `
    + 'INVISIBLE to this answer, not absent from the repository; a negative conclusion drawn '
    + 'from it is not authoritative. The build was not blocked and is still running — re-run '
    + 'once it completes for results computed from the full graph.'
  );
}

/** The artifact set a flush writes, already serialized by the caller's own shapes. */
export interface PartialIndexFlush {
  repoStructure: unknown;
  llmContext: unknown;
  dependencyGraph: unknown;
  stamp: PartialIndexStamp;
}

/**
 * Write one partial index and commit it.
 *
 * Every write is atomic (temp + rename) and the generation manifest is published LAST,
 * so a concurrent reader sees either the previous partial commit or this one, never a
 * half-written set. Fail-soft by contract: a partial index is an optimization on the
 * first-run experience, and no failure to produce one may disturb the analysis that is
 * actually running. The caller does not need a try/catch.
 */
export async function flushPartialIndex(
  analysisDir: string,
  flush: PartialIndexFlush,
): Promise<boolean> {
  const dir = partialIndexDirOf(analysisDir);
  try {
    await mkdir(dir, { recursive: true });
    await atomicWriteFile(join(dir, 'repo-structure.json'), JSON.stringify(flush.repoStructure, null, 2));
    await atomicWriteFile(join(dir, 'llm-context.json'), JSON.stringify(flush.llmContext, null, 2));
    await atomicWriteFile(join(dir, 'dependency-graph.json'), JSON.stringify(flush.dependencyGraph, null, 2));
    await atomicWriteFile(join(dir, PARTIAL_STAMP_FILE), JSON.stringify(flush.stamp, null, 2));
    const published = await publishGeneration(dir, [...PARTIAL_REQUIRED_ARTIFACTS]);
    return published !== null;
  } catch {
    // A partial index that cannot be written simply does not exist; the caller keeps
    // building and the reader keeps returning today's guidance.
    return false;
  }
}

/**
 * Refresh only the stamp on an already-flushed partial index.
 *
 * Used by the artifact-phase heartbeat: the facts have not changed, but the receipt
 * must keep saying which phase is running and that the owner is alive. The stamp is not
 * part of the published generation, so re-stamping cannot invalidate the commit.
 */
export async function refreshPartialIndexStamp(
  analysisDir: string,
  update: Pick<PartialIndexStamp, 'phase'> & Partial<PartialIndexStamp>,
): Promise<void> {
  try {
    const existing = await readPartialStampFile(analysisDir);
    if (!existing) return;
    const next: PartialIndexStamp = {
      ...existing,
      ...update,
      partial: true,
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteFile(partialStampPathOf(analysisDir), JSON.stringify(next, null, 2));
  } catch {
    // Same fail-soft contract as the flush itself.
  }
}

/** Parse the stamp file without judging whether the index behind it is still live. */
async function readPartialStampFile(analysisDir: string): Promise<PartialIndexStamp | null> {
  let raw: string;
  try {
    raw = await readFile(partialStampPathOf(analysisDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PartialIndexStamp;
    if (
      parsed?.partial !== true
      || typeof parsed.phase !== 'string'
      || !(parsed.phase in PHASE_PERCENT)
      || !Number.isSafeInteger(parsed.filesExtracted)
      || !Number.isSafeInteger(parsed.filesTotal)
      || !Number.isSafeInteger(parsed.filesMapped)
      || !Number.isInteger(parsed.pid)
      || typeof parsed.updatedAt !== 'string'
      || !Array.isArray(parsed.absent)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The live partial index for this analysis directory, or null.
 *
 * Null covers four distinct situations, all of which mean the same thing to a caller —
 * there is nothing trustworthy to serve: no partial index exists, its stamp is
 * unparseable, its owning process is gone, or its owner is alive but has not re-stamped
 * within {@link PARTIAL_STAMP_MAX_AGE_MS}. An abandoned partial index is never served,
 * because "the build is still running" is half of what the receipt promises.
 */
export async function readPartialIndexStamp(analysisDir: string): Promise<PartialIndexStamp | null> {
  const stamp = await readPartialStampFile(analysisDir);
  if (!stamp) return null;
  if (!isProcessAlive(stamp.pid)) return null;
  const age = Date.now() - Date.parse(stamp.updatedAt);
  if (!Number.isFinite(age) || age > PARTIAL_STAMP_MAX_AGE_MS) return null;
  return stamp;
}

/**
 * Read one committed artifact out of a live partial index.
 *
 * Bound to the partial directory's own generation manifest and to that manifest's
 * content digest, so a read that lands mid-flush is refused rather than parsed. Returns
 * the raw text; the caller owns parsing and any size policy of its own.
 */
export async function readPartialArtifact(
  analysisDir: string,
  artifact: (typeof PARTIAL_REQUIRED_ARTIFACTS)[number],
): Promise<string | null> {
  const dir = partialIndexDirOf(analysisDir);
  const generation = await readCurrentGeneration(dir, [...PARTIAL_REQUIRED_ARTIFACTS]);
  // `compatibility: 'legacy'` is a manifest SYNTHESIZED from mtimes for an analysis
  // predating manifests. A partial index is never legacy — it is written by this code,
  // which always publishes — so a legacy verdict means the manifest is missing and the
  // files on disk are unowned. Refuse rather than serve unattested bytes.
  if (!generation || generation.compatibility !== 'manifest') return null;
  if (!await artifactMatchesGeneration(dir, generation, artifact)) return null;
  try {
    return await readFile(join(dir, artifact), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Remove the partial index.
 *
 * Called once the real analysis has published its generation: from that moment the
 * partial index is not merely redundant but wrong, and leaving it would let a reader
 * that consults it first serve a worse answer than the one on disk.
 */
export async function clearPartialIndex(analysisDir: string): Promise<void> {
  try {
    await rm(partialIndexDirOf(analysisDir), { recursive: true, force: true });
  } catch {
    // Best effort. A surviving directory is superseded by the published analysis on
    // every read path, and its stamp ages out on its own.
  }
}
