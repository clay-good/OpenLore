/**
 * The partial first-run index (change: refine-first-run-partial-serving).
 *
 * Until this existed, the first `analyze` on a repository was all-or-nothing: every tool
 * answered "no index found" for the whole build, even though the pipeline finishes mapping,
 * the dependency graph, and the inventory extractors long before the call-graph pass — the
 * phase that dominates the wall clock. OpenLore already had the right contract for a STALE
 * index (serve what exists, disclose that a refresh is running, never present it as fresh);
 * this module extends that contract to the ABSENT case, which is also the onboarding case.
 *
 * Three properties decide the whole design:
 *
 *   1. **A partial index is never an analysis artifact.** It is written to its own directory
 *      under `.openlore/runtime/`, never into `.openlore/analysis/`. So the published
 *      generation, the fingerprint, the SQLite store, the build attestation, and every
 *      exporter/importer/attester that reads the analysis directory cannot see it — not by
 *      remembering to check, but because it is not there. The explicit refusals elsewhere are
 *      a second lock on a door that is already shut.
 *
 *   2. **It carries its own integrity commit.** The partial directory publishes its own
 *      generation manifest through the same {@link publishGeneration} primitive the real
 *      analysis uses, so a reader binds to a content digest rather than to whatever bytes
 *      happen to be on disk mid-write.
 *
 *   3. **It is read as untrusted repository content, like every other `.openlore/` artifact.**
 *      A hostile repository can ship a `.openlore/runtime/partial-analysis/` directory and no
 *      `.openlore/analysis/`, which is precisely the state this module serves in. Every read
 *      here therefore goes through the same bounded, no-symlink, regular-files-only descriptor
 *      path the analysis-artifact caches use.
 *
 * A partial index is local serving state and nothing else. It is deleted when the build that
 * owns it completes, and a reader ignores one whose owner is gone.
 */

import { rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { writeJsonAtomicStreaming } from '../analyzer/json-stream.js';
import {
  publishGeneration,
  readCurrentGeneration,
  artifactMatchesGeneration,
} from './analysis-generation.js';
import { isProcessAlive, runtimeDirOf } from './analysis-ownership.js';
// The bounded, symlink-refusing, regular-files-only read every `.openlore/` reader in this repo
// is required to use. A leaf module, so nothing here reaches across a layer boundary for it.
import { ANALYSIS_ARTIFACT_MAX_BYTES, readArtifactBounded } from '../../utils/bounded-artifact-read.js';
import { isConfinedPath, realPathOrNearestExisting } from '../../utils/path-confinement.js';

/** Directory name, under the runtime directory, that holds the partial index. */
export const PARTIAL_INDEX_SUBDIR = 'partial-analysis';

/** The completeness receipt's file name inside {@link PARTIAL_INDEX_SUBDIR}. */
export const PARTIAL_STAMP_FILE = 'partial-index.json';

/**
 * The artifacts a partial index holds.
 *
 * Deliberately a SUBSET of `REQUIRED_ANALYSIS_ARTIFACTS`, and deliberately without
 * `fingerprint.json`: the fingerprint is the freshness key that says "this tree is analyzed".
 * A partial index must never be able to answer that question.
 *
 * Every entry here is READ by something — see {@link partialArtifactPathIfLive}'s callers.
 * An artifact nothing reads is cost with no benefit, paid by exactly the large first builds
 * this feature exists to improve.
 */
export const PARTIAL_REQUIRED_ARTIFACTS = [
  'repo-structure.json',
  'llm-context.json',
  'dependency-graph.json',
] as const;

export type PartialArtifactName = (typeof PARTIAL_REQUIRED_ARTIFACTS)[number];

/**
 * How long a partial index whose owning process is still alive may go unrefreshed before a
 * reader stops trusting it. The writer re-stamps on the artifact-phase heartbeat (15s), so
 * ten minutes of silence means the build is wedged, not slow.
 */
export const PARTIAL_STAMP_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * How far in the FUTURE a stamp may be dated before it is refused.
 *
 * Without a lower bound, `Date.now() - Date.parse(updatedAt)` is negative for a
 * future-dated stamp — finite, under the max age, and therefore accepted forever. A
 * repository can ship a `partial-index.json` dated 2099 with `pid: 1` (always alive) and be
 * permanently "mid-build". A minute of tolerance covers real clock skew between the analyzing
 * process and the serving one; anything beyond it is not skew.
 */
export const PARTIAL_STAMP_MAX_SKEW_MS = 60 * 1000;

/**
 * What a partial index does not hold, named by the READER rather than read from the file.
 *
 * These strings are rendered into an `[openlore index]` line, which reads to an agent as
 * OpenLore's own voice — the highest-trust channel the server has. The stamp is untrusted
 * repository content, so taking this text from it would let a repository put words in that
 * voice. The writer produces exactly this list anyway, so nothing is lost by owning it here.
 */
export const PARTIAL_INDEX_ABSENT_FACTS = [
  'the call graph (function-to-function edges, fan-in/fan-out, hubs)',
  'function signatures and the searchable symbol corpus',
  'cross-file call edges synthesized for languages without explicit imports — the dependency '
    + 'graph is import-derived only, so its edges are a lower bound',
] as const;

/**
 * The build phase a set of facts was flushed at.
 *
 * `phase` describes the FACTS in the index. It is deliberately separate from
 * {@link PartialIndexStamp.buildPhase}, which describes what the build is doing now: the
 * heartbeat advances the latter, and if it advanced the former the index would advertise a
 * completeness its bytes do not have.
 */
export type PartialPhase = 'extractors';

/** Coarse build-stage progress, in the same 0-100 frame the analysis progress sidecar uses. */
const STAGE_PERCENT: Record<string, number> = {
  extractors: 50,
  artifacts: 75,
};

/**
 * What a partial index knows about itself.
 *
 * `filesExtracted` counts files whose CALL-GRAPH facts are in this index — zero for every
 * flush this lane currently takes, because the call-graph pass is the phase still running. It
 * is reported rather than omitted precisely so the gap is legible: a reader that sees
 * `filesExtracted: 0` against a four-figure `filesTotal` cannot mistake this for an index that
 * merely missed a few files.
 */
export interface PartialIndexStamp {
  partial: true;
  /** The phase whose facts are in this index. Fixed at flush time. */
  phase: PartialPhase;
  /** What the build is doing now. Advanced by the heartbeat; never feeds a completeness claim. */
  buildPhase: string;
  /** Files whose call-graph facts are present in this index. */
  filesExtracted: number;
  /** Files the mapping phase saw, including the ones it permanently skipped. */
  filesTotal: number;
  /** Files in the analyzed corpus, and so in the flushed structure. */
  filesMapped: number;
  startedAt: string;
  updatedAt: string;
  /** The analyzing process. A partial index outliving its owner is abandoned. */
  pid: number;
  /**
   * The analysis directory this index was written for, resolved.
   *
   * Nothing else binds a partial index to the tree it describes — it has no fingerprint by
   * design. A `.openlore` copied between repositories (a template repo, `cp -r`, a shared home)
   * would otherwise serve one tree's structure as another's for the whole liveness window.
   */
  analysisDir: string;
}

export function partialIndexDirOf(analysisDir: string): string {
  return join(runtimeDirOf(analysisDir), PARTIAL_INDEX_SUBDIR);
}

/**
 * The partial-index directory, but only when it really is inside this repository's `.openlore`.
 *
 * Node resolves symlinked DIRECTORY components. `O_NOFOLLOW` protects the final component of a
 * read, and `rm` unlinks a symlink rather than following it — but neither says anything about
 * `.openlore/runtime` itself being a symlink. A repository can commit one, git will check it
 * out, and then {@link clearPartialIndex}'s recursive delete lands wherever it points. That
 * delete runs after EVERY successful analyze, including CI and `--embedded` builds that never
 * armed this lane, so it is the most dangerous primitive in this module by some distance.
 *
 * Confinement is on the REAL path (of the nearest existing ancestor, since the directory may not
 * exist yet), because a lexical check is exactly what a symlink defeats. Returns null when the
 * path escapes; every caller then treats the partial index as unavailable, which is the same
 * fail-soft outcome as a disk error.
 */
function confinedPartialIndexDir(analysisDir: string): string | null {
  const dir = partialIndexDirOf(analysisDir);
  try {
    const realRoot = realPathOrNearestExisting(dirname(resolve(analysisDir)));
    return isConfinedPath(realRoot, realPathOrNearestExisting(dir)) ? dir : null;
  } catch {
    // A resolution failure (including the symlink-hop budget) is a refusal, never a pass.
    return null;
  }
}

export function partialStampPathOf(analysisDir: string): string {
  return join(partialIndexDirOf(analysisDir), PARTIAL_STAMP_FILE);
}

/**
 * How far through the BUILD this index's owner has got, 0-100.
 *
 * Named for what it is. It is the pipeline's stage number, not a fraction of the index that
 * exists: the call-graph pass is one stage and most of the wall clock. Nothing renders this as
 * "N% complete" — see {@link describePartialIndex}, which says what the index holds instead.
 */
export function partialBuildStagePercent(stamp: PartialIndexStamp): number {
  return STAGE_PERCENT[stamp.buildPhase] ?? STAGE_PERCENT[stamp.phase] ?? 0;
}

/**
 * The one paragraph a partial answer is disclosed with.
 *
 * Says what the index HOLDS, what it does not hold, and that the difference is invisible to
 * this answer rather than absent from the repository. It deliberately does NOT report a
 * completeness percentage: the honest denominator would be the call-graph pass, which has not
 * started, and any percentage in that position reads as "how much of the index exists".
 */
export function describePartialIndex(stamp: PartialIndexStamp): string {
  const absent = ` It does NOT yet hold: ${PARTIAL_INDEX_ABSENT_FACTS.join('; ')}.`;
  const skipped = stamp.filesTotal - stamp.filesMapped;
  const corpus = skipped > 0
    ? `${stamp.filesMapped} analyzed files (${skipped} more were permanently skipped)`
    : `${stamp.filesMapped} analyzed files`;
  return (
    "Served from a partial first-run index: this repository's first analysis is still running "
    + `(build stage: ${stamp.buildPhase}). The index holds repository structure and the `
    + `dependency graph for ${corpus}.${absent} Facts this index has not reached are INVISIBLE `
    + 'to this answer, not absent from the repository, so a negative conclusion drawn from it '
    + 'is not authoritative. This call was not blocked — re-run once the build completes for '
    + 'results computed from the full graph.'
  );
}

/** The artifact set a flush writes, in the caller's own shapes. */
export interface PartialIndexFlush {
  repoStructure: unknown;
  llmContext: unknown;
  dependencyGraph: unknown;
  stamp: PartialIndexStamp;
}

/**
 * Write one partial index and commit it.
 *
 * Every write is atomic (temp + rename); the generation manifest is published before the
 * stamp, so "a stamp exists" implies "the artifacts it describes are committed" — every reader
 * keys on the stamp, which is what makes a half-written flush unobservable rather than merely
 * unlikely. Fail-soft by contract: a partial index is an optimization on the first-run
 * experience, and no failure to produce one may disturb the analysis that is actually running.
 */
export async function flushPartialIndex(
  analysisDir: string,
  flush: PartialIndexFlush,
): Promise<boolean> {
  const dir = confinedPartialIndexDir(analysisDir);
  if (dir === null) return false;
  try {
    await mkdir(dir, { recursive: true });
    await atomicWriteFile(join(dir, 'repo-structure.json'), JSON.stringify(flush.repoStructure, null, 2));
    await atomicWriteFile(join(dir, 'llm-context.json'), JSON.stringify(flush.llmContext, null, 2));
    // Streamed, not `JSON.stringify`d: the dependency graph of a large repository is exactly
    // the artifact that hits V8's 536,870,888-character string ceiling, and this flush happens
    // during the build's memory peak. The real publish path streams it for the same reason.
    await writeJsonAtomicStreaming(join(dir, 'dependency-graph.json'), flush.dependencyGraph);
    const published = await publishGeneration(dir, [...PARTIAL_REQUIRED_ARTIFACTS]);
    if (!published) return false;
    await atomicWriteFile(join(dir, PARTIAL_STAMP_FILE), JSON.stringify(flush.stamp, null, 2));
    return true;
  } catch {
    // A partial index that cannot be written simply does not exist; the caller keeps building
    // and the reader keeps returning today's guidance.
    return false;
  }
}

/**
 * Refresh only the stamp on an already-committed partial index.
 *
 * Used by the artifact-phase heartbeat: the facts have not changed, but the receipt must keep
 * saying what the build is doing and that its owner is alive. The stamp is not part of the
 * published generation, so re-stamping cannot invalidate the commit — and it advances
 * `buildPhase` only, never `phase`, so it cannot inflate what the index claims to hold.
 */
export async function refreshPartialIndexStamp(
  analysisDir: string,
  update: { buildPhase: string },
): Promise<void> {
  try {
    const existing = await readPartialStampFile(analysisDir);
    if (!existing) return;
    if (!await hasCommittedPartialGeneration(analysisDir)) return;
    const next: PartialIndexStamp = {
      ...existing,
      buildPhase: update.buildPhase,
      partial: true,
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteFile(partialStampPathOf(analysisDir), JSON.stringify(next, null, 2));
  } catch {
    // Same fail-soft contract as the flush itself.
  }
}

/**
 * Is there a committed partial generation in this directory?
 *
 * The stamp alone is not evidence. `atomicWriteFile` creates missing directories, so a
 * fire-and-forget stamp refresh landing after {@link clearPartialIndex} would otherwise
 * recreate the directory with nothing but a stamp in it — and a repository that had just
 * finished analyzing would go on reporting "a first build is running", refusing exports until
 * the stamp aged out. Requiring the commit makes a stamp with no artifacts behind it exactly
 * what it is: not a partial index.
 */
async function hasCommittedPartialGeneration(analysisDir: string): Promise<boolean> {
  const dir = confinedPartialIndexDir(analysisDir);
  if (dir === null) return false;
  const generation = await readCurrentGeneration(dir, [...PARTIAL_REQUIRED_ARTIFACTS], ANALYSIS_ARTIFACT_MAX_BYTES);
  // `legacy` is a manifest SYNTHESIZED from mtimes for an analysis predating manifests. A
  // partial index is never legacy — this code always publishes — so a legacy verdict means
  // the manifest is missing and the files on disk are unowned.
  return generation?.compatibility === 'manifest';
}

/** Parse the stamp file without judging whether the index behind it is still live. */
async function readPartialStampFile(analysisDir: string): Promise<PartialIndexStamp | null> {
  const read = await readArtifactBounded(partialStampPathOf(analysisDir));
  if (read === null) return null;
  try {
    const parsed = JSON.parse(read.text) as PartialIndexStamp;
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || parsed.partial !== true
      || typeof parsed.phase !== 'string'
      || parsed.phase !== 'extractors'
      // A known value, not any short string: `buildPhase` is interpolated into the
      // agent-visible receipt, and an enum cannot carry an escape sequence.
      || typeof parsed.buildPhase !== 'string'
      || !(parsed.buildPhase in STAGE_PERCENT)
      || !Number.isSafeInteger(parsed.filesExtracted)
      || !Number.isSafeInteger(parsed.filesTotal)
      || !Number.isSafeInteger(parsed.filesMapped)
      || !Number.isInteger(parsed.pid)
      || typeof parsed.updatedAt !== 'string'
      || typeof parsed.analysisDir !== 'string'
      // The index must be the one written FOR this directory.
      || resolve(parsed.analysisDir) !== resolve(analysisDir)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The live partial index for this analysis directory, or null.
 *
 * Null covers six distinct situations, all of which mean the same thing to a caller — there is
 * nothing trustworthy to serve: no partial index exists, its stamp is unparseable, no committed
 * generation stands behind it, its owning process is gone, its owner is alive but has not
 * re-stamped within {@link PARTIAL_STAMP_MAX_AGE_MS}, or the stamp is dated in the future
 * beyond ordinary clock skew. An abandoned partial index is never served, because "the build is
 * still running" is half of what the receipt promises.
 */
export async function readPartialIndexStamp(analysisDir: string): Promise<PartialIndexStamp | null> {
  const stamp = await readPartialStampFile(analysisDir);
  if (!stamp) return null;
  if (!await hasCommittedPartialGeneration(analysisDir)) return null;
  if (!isProcessAlive(stamp.pid)) return null;
  const age = Date.now() - Date.parse(stamp.updatedAt);
  if (!Number.isFinite(age)) return null;
  if (age > PARTIAL_STAMP_MAX_AGE_MS || age < -PARTIAL_STAMP_MAX_SKEW_MS) return null;
  return stamp;
}

/**
 * The path to read `artifact` from, when — and only when — a live partial index holds it.
 *
 * The one seam through which a reader that ordinarily reads `.openlore/analysis/<name>` can be
 * answered from the partial index instead. Returning a PATH rather than the bytes keeps every
 * caller on its own existing bounded reader and its own cache, so nothing about how these
 * artifacts are read changes — only where the bytes come from while a first build runs.
 */
export async function partialArtifactPathIfLive(
  analysisDir: string,
  artifact: PartialArtifactName,
): Promise<string | null> {
  const stamp = await readPartialIndexStamp(analysisDir);
  if (!stamp) return null;
  const dir = confinedPartialIndexDir(analysisDir);
  if (dir === null) return null;
  // The ANALYSIS ceiling, not the sibling-artifact one: these are the same repository graph the
  // published path reads, and on the large repositories this feature exists for they legitimately
  // exceed 64 MB. Verification costs a digest per call, which is what the published path pays for
  // its own artifacts too — a partial index is not cached, so this is the one place the cost is
  // visible. The ceiling is what keeps it bounded.
  const generation = await readCurrentGeneration(dir, [...PARTIAL_REQUIRED_ARTIFACTS], ANALYSIS_ARTIFACT_MAX_BYTES);
  if (!generation || generation.compatibility !== 'manifest') return null;
  if (!await artifactMatchesGeneration(dir, generation, artifact, ANALYSIS_ARTIFACT_MAX_BYTES)) return null;
  return join(dir, artifact);
}

/**
 * Read one committed artifact out of a live partial index.
 *
 * Bound to the partial directory's own generation manifest and to that manifest's content
 * digest, so a read that lands mid-flush is refused rather than parsed, and read through the
 * bounded no-symlink descriptor path so a hostile repository cannot redirect it, stall it with
 * a FIFO, or make it allocate without limit.
 */
export async function readPartialArtifact(
  analysisDir: string,
  artifact: PartialArtifactName,
): Promise<string | null> {
  const path = await partialArtifactPathIfLive(analysisDir, artifact);
  if (path === null) return null;
  const read = await readArtifactBounded(path, ANALYSIS_ARTIFACT_MAX_BYTES);
  return read?.text ?? null;
}

/**
 * Remove the partial index.
 *
 * Called once the real analysis has published its generation: from that moment the partial
 * index is not merely redundant but wrong, and leaving it would let a reader that consults it
 * serve a worse answer than the one on disk.
 *
 * `maxRetries` covers Windows, where a reader still holding a descriptor makes the unlink fail
 * with EBUSY/EPERM. A survivor there is not cosmetic: it would go on telling callers a build is
 * running until its stamp aged out.
 */
export async function clearPartialIndex(analysisDir: string): Promise<void> {
  const dir = confinedPartialIndexDir(analysisDir);
  if (dir === null) return;
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Best effort. A surviving directory is superseded by the published analysis on every read
    // path that checks for one, and its stamp ages out on its own.
  }
}
