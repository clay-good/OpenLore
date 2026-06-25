/**
 * `map_in_flight_conflicts` — the cross-actor interference map (change:
 * add-cross-actor-interference-map, PARALLEL-WORK-COORDINATION proposal 4, the
 * team wedge).
 *
 * Generalizes `plan_parallel_work` (proposal 2) from "N agent tasks I am about to
 * dispatch" to "every change in flight right now" — local branches, open pull
 * requests, and caller-supplied agent task descriptors alike, within and across a
 * federation of repos. Each in-flight change becomes an actor-attributed node whose
 * footprint (proposal 1) is derived from its ACTUAL diff, and the same pairwise
 * hazard classifier (proposal 1) runs across all nodes. The output is a conclusion:
 * per change, the other in-flight changes it conflicts with, the hazard class, the
 * witnessing symbols, and a suggested landing order.
 *
 * Design invariants (mirror the proposal's Decision + Scope contract):
 * - **Read-only, stateless, no new graph.** A pure function of current git state +
 *   the indexed graphs at call time. No watcher, no poll, no persisted conflict
 *   store, no new node/edge schema — footprints ride existing primitives.
 * - **Observed, not declared.** A change's write-set comes from mapping its diff
 *   hunks onto the enclosing symbols of the BASE snapshot, with a per-symbol
 *   `writeMode` read off the diff itself: a symbol touched only by pure-insertion
 *   hunks is an `append`, one touched by any deletion/modification is a `modify`.
 *   This makes registry-collision resolution automatic — two PRs that each append a
 *   disjoint entry to the same dispatcher resolve to `shared-append`, not a WAW, with
 *   no `writeMode` declaration needed (the diffs are observable).
 * - **Honest about what it cannot see.** A PR whose diff cannot be fetched, a target
 *   repo whose index is stale/missing, or a change whose symbols do not resolve is a
 *   clearly-labeled "not assessed" node — NEVER a false "no conflict".
 * - **Advisory by default.** WAW conflicts are emitted as policy-shaped
 *   `GovernanceFinding`s (`cross-actor-conflict`) so a caller/CI can classify them
 *   with `resolveEnforcementClass` and choose to block; this tool blocks nothing.
 * - **Degrades to single-repo.** Federation is opt-in; with none configured the map
 *   covers this repo's own branches, local PRs, and supplied descriptors.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { validateDirectory, readCachedContext } from './utils.js';
import {
  computeFootprint,
  classifyHazard,
  type Footprint,
  type WriteMember,
  type WriteMode,
  type HazardVerdict,
  type TaskDescriptor,
  type FootprintOptions,
} from './change-footprint.js';
import type { GovernanceFinding } from './enforcement-policy.js';
import { CallGraphBuilder, serializeCallGraph } from '../../analyzer/call-graph.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import { detectLanguage } from '../../analyzer/signature-extractor.js';

const execFileAsync = promisify(execFile);

// ── caps (mirrors plan_parallel_work: the schedule is O(N), evidence lists O(N²)) ──

/** Upper bound on in-flight changes assessed in one call (branches + PRs + tasks). */
export const MAX_CHANGES = 40;
/** Conflict / finding list caps with authoritative uncapped counts (no-silent-truncation). */
const CONFLICT_LIST_CAP = 200;
const FINDINGS_LIST_CAP = 100;
/** Witness ids surfaced per conflict (a whole-file WAW pair can share dozens). */
const WITNESS_CAP = 8;
/** Files re-parsed per change for its base snapshot (a huge diff is the slow path). */
const MAX_FILES_PER_CHANGE = 400;
/**
 * Soft byte budget. The dispatch-level hard cap is 256 KB (`MCP_TOOL_MAX_BYTES`) and
 * its array fallback mangles an over-budget structured result into an unparseable
 * string, so we keep a margin below it and collapse evidence lists if a map is still
 * too large after the per-list caps (the same guardrail plan_parallel_work needs).
 */
const SOFT_BUDGET_BYTES = 200 * 1024;

const DISCLOSURE =
  'Structural overlap predicts conflict PROBABILITY, not certainty: two changes sharing no symbol and ' +
  'no co-change history can still depend on one latent invariant, and dynamic dispatch can hide a real ' +
  'overlap. This map shifts conflict detection left; merge/integration remains the ground truth. ' +
  'Footprints are derived from observed diffs against a base — a change marked "not assessed" was not ' +
  'evaluated and is never reported as conflict-free.';

// ── public types ────────────────────────────────────────────────────────────

export type ActorKind = 'branch' | 'pull-request' | 'agent-task';

/** A stable reason a change could not be structurally assessed — never a false "no conflict". */
export type NotAssessedReason =
  | 'diff-unfetchable'      // the change's diff could not be read (e.g. gh failed)
  | 'no-resolvable-symbols' // the diff touched no symbol resolvable in the index
  | 'index-stale'           // the change's repo index is stale (federation target)
  | 'index-missing';        // the change's repo has no usable index

export interface InterferenceMapInput {
  directory: string;
  /** Git ref every change is diffed against (default: the repo's resolved default branch). */
  baseRef?: string;
  /** Include local branches ahead of the base (default true). */
  includeBranches?: boolean;
  /** Restrict branch enumeration to these branch names (default: all ahead of base). */
  branches?: string[];
  /** Include open pull requests via `gh` (default true; absent `gh` degrades with a caveat). */
  includePullRequests?: boolean;
  /** Caller-supplied agent task descriptors that join the graph as first-class nodes. */
  tasks?: TaskDescriptor[];
  /** Cap on assessed changes (branches + PRs + tasks). Default {@link MAX_CHANGES}. */
  maxChanges?: number;
  /** Forwarded to the footprint projection. */
  readMaxDistance?: number;
  affectedMaxDepth?: number;
  ambientFanInPercentile?: number;
  /** Opt-in: extend the map across federated repos (.openlore/federation.json). */
  federation?: boolean;
  /** Limit federation scope to these registry repo names (default: all resolvable). */
  federationRepos?: string[];
}

/** One in-flight change in the map (assessed or not), actor-attributed. */
export interface ChangeNode {
  actor: string;
  /** branch name, "PR #210", or the task id. */
  ref: string;
  repo: string;
  kind: ActorKind;
  assessed: boolean;
  /** When assessed: the count of changed code files that produced the footprint. */
  changedFiles?: number;
  /** When assessed: the size of the derived write-set. */
  writeSetCount?: number;
  /** When not assessed: the stable reason + detail (never a false "no conflict"). */
  reason?: NotAssessedReason;
  detail?: string;
}

/** One pairwise conflict between two in-flight changes (supporting evidence). */
export interface InterferenceConflict {
  a: { actor: string; ref: string; repo: string };
  b: { actor: string; ref: string; repo: string };
  hazard: HazardVerdict['kind'];
  direction?: HazardVerdict['direction'];
  crossRepo: boolean;
  /** Witnessing symbol ids (cross-repo: shared content-addressed stable ids), sorted. */
  witnesses: string[];
  /** Plain-language landing order suggestion. */
  suggestion: string;
}

export interface InterferenceMap {
  baseRef: string;
  resolvedBaseRef: string;
  /** Repos assessed (this repo, plus any resolvable federated targets). */
  repos: string[];
  changeCount: number;
  assessedCount: number;
  notAssessedCount: number;
  changes: ChangeNode[];
  /** Non-`none` pairwise verdicts, capped — see `conflictCount`. */
  conflicts: InterferenceConflict[];
  conflictCount: number;
  conflictsTruncated: boolean;
  /** WAW conflicts as policy-shaped findings a caller/CI can classify. Capped — see `findingCount`. */
  findings: GovernanceFinding[];
  findingCount: number;
  findingsTruncated: boolean;
  posture: 'advisory';
  caveats: string[];
  disclosure: string;
  headline: string;
  /** Set only when a large map was shrunk to fit the response budget. */
  truncationNote?: string;
}

// ── diff parsing (pure) ─────────────────────────────────────────────────────

/** One unified-diff hunk, reduced to what the footprint needs (old-side lines + nature). */
export interface DiffHunk {
  /** First old-file line the hunk touches (1-based). For a pure insertion, the line it follows. */
  oldStart: number;
  /** Count of old-file lines in the hunk (0 for a pure insertion). */
  oldCount: number;
  /** True iff the hunk deletes or modifies existing lines (any `-` line) — i.e. not a pure append. */
  hasDeletions: boolean;
}

/** A changed file's hunks plus its git status (the diff for one path). */
export interface FileHunks {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** For a rename, the path the file lived at in the base ref (where its old content is). */
  oldPath?: string;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff (from `git diff` or `gh pr diff`) into per-file hunks,
 * recording only the old-side line ranges and whether each hunk deletes/modifies a
 * line. Deterministic and U0/U3-agnostic: a hunk's nature is read from whether it
 * carries any `-` line, so a context-bearing (default) diff and a `--unified=0` diff
 * classify identically.
 */
export function parseUnifiedDiff(patch: string): FileHunks[] {
  const files: FileHunks[] = [];
  let cur: FileHunks | null = null;
  let curHunk: DiffHunk | null = null;
  const closeHunk = () => { if (cur && curHunk) cur.hunks.push(curHunk); curHunk = null; };
  const closeFile = () => { closeHunk(); if (cur) files.push(cur); cur = null; };

  for (const rawLine of patch.split('\n')) {
    // Strip a trailing CR so a CRLF-terminated structural line (`diff --git …\r`,
    // `+++ b/path\r`) parses cleanly — otherwise the path regex fails to match and the
    // fallback captures both sides plus the CR into a corrupt path. Body content is only
    // ever read for its first character, so dropping a trailing CR there is harmless.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('diff --git ')) {
      closeFile();
      // `diff --git a/<path> b/<path>` — take the b-side path (the new path).
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = m ? m[2] : line.slice('diff --git '.length);
      cur = { path, status: 'modified', hunks: [] };
      continue;
    }
    if (!cur) continue;
    // A hunk header always starts a new hunk. Checked BEFORE the body-line branch so a
    // `@@` is never mistaken for content.
    const hm = HUNK_HEADER.exec(line);
    if (hm) {
      closeHunk();
      curHunk = {
        oldStart: parseInt(hm[1], 10),
        oldCount: hm[2] === undefined ? 1 : parseInt(hm[2], 10),
        hasDeletions: false,
      };
      continue;
    }
    if (curHunk) {
      // Inside a hunk: classify the body line by its FIRST CHARACTER only. The `---`/`+++`
      // file headers can only appear before the first hunk, so a body line starting with
      // `-` is always a deletion — even when its CONTENT begins with dashes (a deleted SQL
      // `-- comment`, a Markdown `---` rule, a row of `------`). Guarding `!startsWith('---')`
      // here was a real bug: it silently downgraded a write-write conflict to a "safe"
      // shared-append for any diff that deletes a dash-leading line.
      if (line.startsWith('-')) curHunk.hasDeletions = true;
      continue;
    }
    // File-header region (before the first hunk): status + path metadata. These prefixes
    // are only meaningful here, so an added/deleted body line that happens to spell `--- `
    // or `+++ ` later cannot reach this block.
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
    if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = line.slice('rename from '.length).trim(); continue; }
    if (line.startsWith('rename to ')) { cur.path = line.slice('rename to '.length).trim(); continue; }
    if (line.startsWith('--- ')) {
      // `--- a/<oldpath>` carries the authoritative old path for a non-rename modify too.
      const p = line.slice(4).trim();
      if (p !== '/dev/null' && p.startsWith('a/')) { const op = p.slice(2); if (op !== cur.path) cur.oldPath = op; }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') cur.status = 'deleted';
      else if (p.startsWith('b/')) cur.path = p.slice(2);
    }
  }
  closeFile();
  return files;
}

// ── hunk → enclosing symbol → write-set (pure) ──────────────────────────────

/** Base-snapshot symbols of a changed file, carrying line range + stable id for cross-repo match. */
export interface BaseSymbol {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  stableId?: string;
}

/** A write-set member enriched with its content-addressed stable id (for cross-repo matching). */
export interface FederatedWriteMember extends WriteMember {
  stableId?: string;
}

/**
 * The symbol(s) a hunk's old-side span touches. When the whole hunk fits inside one or
 * more symbols, attribute it to the NARROWEST (innermost) one — so an edit to a nested
 * helper or closure is charged to the helper, not also to its enclosing function (which
 * would inflate the write-set and manufacture a false WAW against a change that only
 * touched the outer body). When the hunk spans beyond any single symbol (a large edit
 * crossing function boundaries, or module-level lines), fall back to every symbol it
 * intersects — that breadth is genuine.
 */
function symbolsForHunk(h: DiffHunk, symbols: readonly BaseSymbol[]): BaseSymbol[] {
  const lo = h.oldStart;
  const hi = h.oldStart + Math.max(h.oldCount, 1) - 1;
  const containing = symbols.filter(s => s.startLine <= lo && hi <= s.endLine);
  if (containing.length > 0) {
    let best = containing[0];
    for (const s of containing) if (s.endLine - s.startLine < best.endLine - best.startLine) best = s;
    return [best];
  }
  return symbols.filter(s => s.startLine <= hi && lo <= s.endLine);
}

/**
 * The observed write-set of a change: each base symbol its diff hunks touch, with a
 * per-symbol writeMode read off the diff (a symbol touched only by pure-insertion
 * hunks is `append`; any deletion/modification makes it `modify`). `modify`
 * dominates `append` when a symbol has both kinds of hunk. Pure — the testable core.
 *
 * `baseSymbolsByFile` keys every changed CODE file (a file with no function symbols
 * maps to `[]`); a non-code file (docs/config) is absent, so it contributes nothing.
 * A hunk that touches no function symbol is a MODULE-SCOPE edit (a top-level registry
 * array/object literal has no function node). For a pure-insertion such hunk — the
 * canonical "two PRs each append a disjoint entry to the same registry" case — we add a
 * FILE-SCOPE write member so the collision is observed and resolves to `shared-append`
 * (mergeable), never a false WAW. A module-scope MODIFY is deliberately NOT attributed
 * to a file-scope member: at file granularity it would over-couple disjoint top-level
 * edits into a spurious WAW, and the proposal prefers a missed module-scope-modify
 * (rare) over a false "must serialize" (noisy). Function-body edits keep symbol
 * granularity.
 */
export function writeSetFromHunks(
  files: readonly FileHunks[],
  baseSymbolsByFile: ReadonlyMap<string, BaseSymbol[]>,
): FederatedWriteMember[] {
  const modeById = new Map<string, WriteMode>();
  const symbolById = new Map<string, BaseSymbol>();
  const bump = (id: string, mode: WriteMode) => {
    const prev = modeById.get(id);
    modeById.set(id, prev === 'modify' || mode === 'modify' ? 'modify' : 'append');
  };
  for (const f of files) {
    const symbols = baseSymbolsByFile.get(f.path);
    if (symbols === undefined) continue; // not a parsed code file → contributes nothing
    for (const h of f.hunks) {
      const mode: WriteMode = h.hasDeletions ? 'modify' : 'append';
      const touched = symbols.length > 0 ? symbolsForHunk(h, symbols) : [];
      if (touched.length > 0) {
        for (const s of touched) { symbolById.set(s.id, s); bump(s.id, mode); }
      } else if (mode === 'append') {
        // Module-scope pure insertion (e.g. a registry-array entry) → file-scope member.
        const id = f.path;
        if (!symbolById.has(id)) symbolById.set(id, { id, name: f.path, filePath: f.path, startLine: 0, endLine: 0 });
        bump(id, 'append');
      }
    }
  }
  return [...symbolById.values()]
    .map(s => ({ id: s.id, name: s.name, filePath: s.filePath, writeMode: modeById.get(s.id)!, ...(s.stableId ? { stableId: s.stableId } : {}) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Assemble a {@link Footprint} for an in-flight change: the write-set is the
 * authoritative diff-observed set; the read/affected/coupling regions are computed
 * from the repo's indexed graph via the proposal-1 projection (seeded on the resolved
 * write-set ids). When none of the write members resolve in the index, the regions
 * are empty but the write-set is retained, so cross-repo/same-repo WAW is still found.
 */
function footprintForChange(
  cg: SerializedCallGraph,
  taskId: string,
  writeMembers: FederatedWriteMember[],
  opts: FootprintOptions,
): Footprint {
  const seedIds = writeMembers.map(w => w.id);
  const base = computeFootprint(cg, { id: taskId, seedSymbols: seedIds }, opts);
  // The diff-observed write-set is authoritative (per-symbol writeMode); override the
  // projection's seed-resolved write-set with it, keep the projection's reach regions.
  return { ...base, taskId, writeSet: writeMembers, unresolvedSeeds: [] };
}

// ── conflict graph (pure) ───────────────────────────────────────────────────

/**
 * Project a footprint's write-set onto content-addressed stable ids for cross-repo
 * matching. `filePath` is namespaced by repo so the WAR fallback in `classifyHazard`
 * (which intersects file paths) can NEVER fire across a repo boundary on a coincidental
 * same-relative-path (`src/index.ts` exists in both repos) — cross-repo file identity is
 * meaningless without content addressing. Cross-repo reachability is the federation
 * resolver's separate job, so reach regions are left empty (no cross-repo RAW).
 */
function projectToStableIds(fp: Footprint, repo: string, stableByNodeId: Map<string, string>): Footprint {
  const writeSet = fp.writeSet
    .map(w => {
      const sid = stableByNodeId.get(w.id);
      return sid ? { ...w, id: sid, filePath: `${repo} ${w.filePath}` } : null;
    })
    .filter((w): w is WriteMember => w !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...fp, writeSet, readSet: [], ambientReadDeps: [], affectedSet: [], couplingNeighbors: [] };
}

function capWitnesses(w: string[]): string[] {
  return w.slice(0, WITNESS_CAP);
}

function witnessSummary(labels: string[]): string {
  const shown = labels.slice(0, WITNESS_CAP).join(', ');
  return labels.length > WITNESS_CAP ? `${shown} (+${labels.length - WITNESS_CAP} more)` : shown;
}

/** A readable symbol label from a path-based id (`file::name`) or a stable id. */
function shortName(id: string): string {
  return id.includes('::') ? id.split('::').pop()! : id;
}

function suggestionFor(v: HazardVerdict, labels: string[], a: ChangeNode, b: ChangeNode): string {
  const wits = witnessSummary(labels);
  switch (v.kind) {
    case 'WAW':
      return `${a.ref} and ${b.ref} both modify ${wits} — land one, then rebase the other onto it; do not edit concurrently.`;
    case 'RAW':
      if (v.direction === 'B after A') return `Land ${a.ref} before ${b.ref} — ${b.ref} reads what ${a.ref} writes (${wits}).`;
      if (v.direction === 'A after B') return `Land ${b.ref} before ${a.ref} — ${a.ref} reads what ${b.ref} writes (${wits}).`;
      return `${a.ref} and ${b.ref} each read the other's writes (${wits}) — order is ambiguous; coordinate before landing either.`;
    case 'shared-append':
      return `${a.ref} and ${b.ref} both append to ${wits}; git 3-way-merges this trivially. Safe to land in either order.`;
    case 'WAR':
      return `${a.ref} and ${b.ref} touch the same file(s) at disjoint symbols (${wits}). Low risk.`;
    case 'soft-coupling':
      return `${a.ref} and ${b.ref} touch files that historically co-change (${wits}) but share no call edge. Advisory only.`;
    default:
      return '';
  }
}

// ── git / gh providers (injectable I/O) ─────────────────────────────────────

/** A raw in-flight change as gathered by a provider, before footprint derivation. */
export interface RawChange {
  actor: string;
  ref: string;
  repo: string;
  kind: ActorKind;
  /** Parsed diff hunks (empty when fetchError is set). */
  files: FileHunks[];
  /** Base-snapshot symbols by changed-file path (the provider does the re-parse I/O). */
  baseSymbolsByFile: Map<string, BaseSymbol[]>;
  /** Set when the change's diff could not be fetched → a "not assessed" node. */
  fetchError?: string;
  /** Changed code files whose BASE content could not be read (their symbols are absent
   *  from the write-set) — surfaced as a caveat so the partial assessment is honest. */
  unreadableFiles?: string[];
}

export interface InFlightProviders {
  /** Enumerate local branch changes ahead of base in a repo. */
  enumerateBranches(repoPath: string, repoName: string, baseRef: string, only?: string[]): Promise<RawChange[]>;
  /** Enumerate open pull requests in a repo (via gh). Resolves to [] when gh is absent. */
  enumeratePullRequests(repoPath: string, repoName: string, baseRef: string): Promise<RawChange[]>;
  /** Whether `gh` is available at all (drives the "PRs not enumerated" caveat). */
  ghAvailable(repoPath: string): Promise<boolean>;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Content of a file at a git ref. Distinguishes a genuinely EMPTY file (`''`) from a
 * read FAILURE (`null`) — conflating them lets a transient `git show` error silently
 * drop a changed file's symbols, which would be a false "no conflict" (the invariant
 * this tool must never break). A missing path at the ref also returns `null`.
 */
async function fileAtRef(repoPath: string, ref: string, path: string): Promise<string | null> {
  try {
    return await git(repoPath, ['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/** Base-snapshot symbols by changed-file path, plus files whose base content could not be read. */
interface BaseSnapshot {
  byFile: Map<string, BaseSymbol[]>;
  /** Code files whose base content errored — surfaced as a caveat, never silently dropped. */
  unreadable: string[];
}

/**
 * Build base-snapshot symbols (line ranges + stable ids) for the changed files. The
 * snapshot is parsed from each file's BASE-REF content under its BASE path
 * (`oldPath ?? path`), so a symbol in a renamed file keeps its base identity
 * (`old/path::name`) — the same id a peer change editing that file in place sees, and
 * the id the canonical index carries. Building under the NEW path instead made a
 * rename+edit silently not-conflict with an in-place edit of the same function (a real
 * merge conflict reported as "no conflict"). Every parsed CODE file is recorded (even
 * with zero function symbols) so a module-scope edit can still be attributed.
 */
async function buildBaseSymbols(
  repoPath: string,
  baseContentRef: string,
  files: FileHunks[],
): Promise<BaseSnapshot> {
  const byFile = new Map<string, BaseSymbol[]>();
  const unreadable: string[] = [];
  for (const f of files.slice(0, MAX_FILES_PER_CHANGE)) {
    if (f.status === 'added') continue; // no base content — all its symbols are new
    const basePath = f.oldPath ?? f.path; // a renamed file's base content lives at oldPath
    const lang = detectLanguage(basePath);
    if (!lang || lang === 'Unknown' || lang === 'unknown') continue; // non-code file → no symbols
    const content = await fileAtRef(repoPath, baseContentRef, basePath);
    if (content === null) { unreadable.push(f.path); continue; } // read FAILURE, not empty
    let snap: SerializedCallGraph | null = null;
    try {
      // Parse under the BASE path so symbol ids are base-identity ids (rename-safe).
      snap = serializeCallGraph(await new CallGraphBuilder().build([{ path: basePath, content, language: lang }]));
    } catch {
      unreadable.push(f.path);
      continue;
    }
    const symbols: BaseSymbol[] = snap.nodes
      .filter(n => !n.isExternal && n.startLine !== undefined && n.endLine !== undefined)
      .map(n => ({ id: n.id, name: n.name, filePath: n.filePath, startLine: n.startLine!, endLine: n.endLine!, ...(n.stableId ? { stableId: n.stableId } : {}) }));
    // Record every parsed code file (even with zero function symbols) so a module-scope
    // append (a top-level registry array has no function node) can fall back to a
    // file-scope write member in writeSetFromHunks.
    byFile.set(f.path, symbols);
  }
  return { byFile, unreadable };
}

/**
 * The base ref to diff against WITHIN a given repo. The caller resolves the base
 * against the home repo, but that ref/SHA may not exist in a federated target — so
 * re-resolve it per repo (main → master → HEAD~1) when it doesn't verify locally,
 * rather than letting every `merge-base` fail and silently skip the target's branches.
 */
async function resolveRepoBase(repoPath: string, baseRef: string): Promise<string> {
  try { await git(repoPath, ['rev-parse', '--verify', baseRef]); return baseRef; } catch { /* re-resolve below */ }
  try {
    const { resolveBaseRef } = await import('../../drift/git-diff.js');
    return await resolveBaseRef(repoPath, 'auto');
  } catch { return baseRef; }
}

/** Default provider: enumerate local branches ahead of base via git. */
async function defaultEnumerateBranches(
  repoPath: string,
  repoName: string,
  baseRefIn: string,
  only?: string[],
): Promise<RawChange[]> {
  let names: string[];
  try {
    names = (await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']))
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const baseRef = await resolveRepoBase(repoPath, baseRefIn);
  // The currently-checked-out branch is NOT excluded: it is a legitimate in-flight change
  // that can genuinely conflict with a teammate's branch (a true positive the user wants).
  const wanted = only && only.length > 0 ? new Set(only) : null;
  const out: RawChange[] = [];
  for (const branch of names.sort()) {
    if (branch === baseRef) continue;
    if (wanted && !wanted.has(branch)) continue;
    let mergeBase = '';
    try { mergeBase = (await git(repoPath, ['merge-base', baseRef, branch])).trim(); } catch { continue; }
    let tip = '';
    try { tip = (await git(repoPath, ['rev-parse', branch])).trim(); } catch { continue; }
    if (!mergeBase || mergeBase === tip) continue; // branch not ahead of base → nothing in flight
    let patch = '';
    try { patch = await git(repoPath, ['diff', '--unified=0', '--no-color', `${mergeBase}..${branch}`]); } catch { continue; }
    const files = parseUnifiedDiff(patch);
    if (files.length === 0) continue;
    let actor = branch;
    try { actor = (await git(repoPath, ['log', '-1', '--format=%an', branch])).trim() || branch; } catch { /* keep branch as actor */ }
    const { byFile, unreadable } = await buildBaseSymbols(repoPath, mergeBase, files);
    out.push({ actor, ref: branch, repo: repoName, kind: 'branch', files, baseSymbolsByFile: byFile, ...(unreadable.length ? { unreadableFiles: unreadable } : {}) });
  }
  return out;
}

interface GhPr { number: number; headRefName: string; author?: { login?: string }; title?: string }

/** Default provider: enumerate open PRs via gh, diffing each against the local base. */
async function defaultEnumeratePullRequests(
  repoPath: string,
  repoName: string,
  baseRefIn: string,
): Promise<RawChange[]> {
  let prs: GhPr[];
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,author,title', '--limit', '50'], { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 });
    prs = JSON.parse(stdout) as GhPr[];
  } catch {
    return []; // gh absent / not a GitHub remote → no PRs (the caller adds a caveat)
  }
  const baseRef = await resolveRepoBase(repoPath, baseRefIn);
  const out: RawChange[] = [];
  for (const pr of prs.sort((a, b) => a.number - b.number)) {
    const ref = `PR #${pr.number}`;
    const actor = pr.author?.login || 'unknown';
    let patch = '';
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'diff', String(pr.number), '--patch'], { cwd: repoPath, maxBuffer: 64 * 1024 * 1024 });
      patch = stdout;
    } catch {
      out.push({ actor, ref, repo: repoName, kind: 'pull-request', files: [], baseSymbolsByFile: new Map(), fetchError: `gh pr diff ${pr.number} failed` });
      continue;
    }
    const files = parseUnifiedDiff(patch);
    if (files.length === 0) continue;
    // Old content is read from the LOCAL base ref (an approximation when the PR's base
    // has advanced past local) — disclosed in the caveats.
    const { byFile, unreadable } = await buildBaseSymbols(repoPath, baseRef, files);
    out.push({ actor, ref, repo: repoName, kind: 'pull-request', files, baseSymbolsByFile: byFile, ...(unreadable.length ? { unreadableFiles: unreadable } : {}) });
  }
  return out;
}

async function defaultGhAvailable(repoPath: string): Promise<boolean> {
  try { await execFileAsync('gh', ['--version'], { cwd: repoPath }); return true; } catch { return false; }
}

const DEFAULT_PROVIDERS: InFlightProviders = {
  enumerateBranches: defaultEnumerateBranches,
  enumeratePullRequests: defaultEnumeratePullRequests,
  ghAvailable: defaultGhAvailable,
};

// ── repo resolution (federation) ────────────────────────────────────────────

interface AssessedRepo {
  name: string;
  path: string;
  cg: SerializedCallGraph;
  edgeStore?: { getChangeCouplingForFiles(files: string[]): unknown[] };
}

interface RepoResolution {
  repos: AssessedRepo[];
  /** Targets that resolved but whose index is unusable → their changes are "not assessed". */
  unusable: Array<{ name: string; reason: NotAssessedReason; detail: string }>;
  caveats: string[];
}

/**
 * Resolve the set of repos to assess: always the home repo, plus — when federation is
 * opted into — each resolvable spec-store target whose index is usable. Reuses the
 * spec-store health check to learn which targets are resolvable/fresh; a stale or
 * missing target index is surfaced (its changes become "not assessed"), never silently
 * dropped.
 */
async function resolveRepos(
  absDir: string,
  homeCg: SerializedCallGraph,
  homeEdgeStore: AssessedRepo['edgeStore'],
  input: InterferenceMapInput,
): Promise<RepoResolution> {
  const homeName = 'this-repo';
  const repos: AssessedRepo[] = [{ name: homeName, path: absDir, cg: homeCg, edgeStore: homeEdgeStore }];
  const unusable: RepoResolution['unusable'] = [];
  const caveats: string[] = [];
  if (!input.federation) return { repos, unusable, caveats };

  interface SpecStoreStatusLike { bound?: boolean; targets?: Array<{ name: string; resolved: boolean; state?: string; path?: string }> }
  let status: SpecStoreStatusLike | null = null;
  try {
    const { handleSpecStoreStatus } = await import('./spec-store.js');
    status = (await handleSpecStoreStatus(absDir)) as unknown as SpecStoreStatusLike;
  } catch {
    caveats.push('Federation requested but the spec-store binding could not be read; assessed this repo only.');
    return { repos, unusable, caveats };
  }
  if (!status?.bound || !Array.isArray(status.targets) || status.targets.length === 0) {
    caveats.push('Federation requested but no resolvable spec-store targets are configured; assessed this repo only.');
    return { repos, unusable, caveats };
  }
  const wanted = input.federationRepos && input.federationRepos.length > 0 ? new Set(input.federationRepos) : null;
  for (const t of status.targets) {
    if (wanted && !wanted.has(t.name)) continue;
    if (!t.resolved || !t.path) { unusable.push({ name: t.name, reason: 'index-missing', detail: `target "${t.name}" did not resolve` }); continue; }
    if (t.state === 'stale') { unusable.push({ name: t.name, reason: 'index-stale', detail: `target "${t.name}" index is stale` }); continue; }
    if (t.state !== 'indexed') { unusable.push({ name: t.name, reason: 'index-missing', detail: `target "${t.name}" is not indexed (${t.state ?? 'unknown'})` }); continue; }
    try {
      const ctx = await readCachedContext(resolve(t.path));
      if (!ctx?.callGraph) { unusable.push({ name: t.name, reason: 'index-missing', detail: `target "${t.name}" has no call graph` }); continue; }
      repos.push({ name: t.name, path: resolve(t.path), cg: ctx.callGraph as SerializedCallGraph, edgeStore: ctx.edgeStore as AssessedRepo['edgeStore'] });
    } catch {
      unusable.push({ name: t.name, reason: 'index-missing', detail: `target "${t.name}" context could not be loaded` });
    }
  }
  return { repos, unusable, caveats };
}

// ── orchestration ───────────────────────────────────────────────────────────

export async function computeInterferenceMap(
  input: InterferenceMapInput,
  providers: InFlightProviders = DEFAULT_PROVIDERS,
): Promise<InterferenceMap | { error: string }> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const homeCg = ctx.callGraph as SerializedCallGraph;

  const baseRefInput = input.baseRef && input.baseRef.length > 0 ? input.baseRef : 'auto';
  let resolvedBaseRef = baseRefInput;
  try {
    const { resolveBaseRef } = await import('../../drift/git-diff.js');
    resolvedBaseRef = await resolveBaseRef(absDir, baseRefInput);
  } catch { /* keep the input; enumeration may still work or yield no changes */ }

  const caveats: string[] = [];
  const homeEdgeStore = ctx.edgeStore as AssessedRepo['edgeStore'] | undefined;
  const { repos, unusable, caveats: repoCaveats } = await resolveRepos(absDir, homeCg, homeEdgeStore, input);
  caveats.push(...repoCaveats);

  const maxChanges = Math.max(1, Math.min(input.maxChanges ?? MAX_CHANGES, MAX_CHANGES));

  // ── 1. Gather raw in-flight changes from every assessed repo ────────────────
  const raw: RawChange[] = [];
  const includeBranches = input.includeBranches !== false;
  const includePrs = input.includePullRequests !== false;
  let anyGh = false;
  for (const repo of repos) {
    if (includeBranches) {
      try { raw.push(...await providers.enumerateBranches(repo.path, repo.name, resolvedBaseRef, input.branches)); }
      catch { caveats.push(`Branch enumeration failed for ${repo.name}.`); }
    }
    if (includePrs) {
      const has = await providers.ghAvailable(repo.path).catch(() => false);
      anyGh = anyGh || has;
      if (has) {
        try { raw.push(...await providers.enumeratePullRequests(repo.path, repo.name, resolvedBaseRef)); }
        catch { caveats.push(`PR enumeration failed for ${repo.name}.`); }
      }
    }
  }
  const anyPrEnumerated = raw.some(r => r.kind === 'pull-request');
  if (includePrs && !anyGh) {
    caveats.push('`gh` is not available, so open pull requests were not enumerated (branches and tasks only). Install GitHub CLI to include PRs.');
  } else if (includePrs && anyGh && !anyPrEnumerated) {
    // gh binary present but it returned no PRs — typically no open PRs, or this repo has
    // no GitHub remote. Say so honestly rather than implying PRs were assessed.
    caveats.push('`gh` is installed but no open pull requests were enumerated (none open, or this repo has no GitHub remote). PR coverage is empty.');
  }

  // ── 2. Derive footprints; build the node list (assessed + not-assessed) ─────
  const fpOptsFor = (repo: AssessedRepo): FootprintOptions => ({
    readMaxDistance: input.readMaxDistance,
    affectedMaxDepth: input.affectedMaxDepth,
    ambientFanInPercentile: input.ambientFanInPercentile,
    couplingLookup: repo.edgeStore
      ? (files: string[]) => { try { return repo.edgeStore!.getChangeCouplingForFiles(files) as never[]; } catch { return []; } }
      : undefined,
  });
  const cgByRepo = new Map(repos.map(r => [r.name, r]));

  interface AssessedNode { node: ChangeNode; footprint: Footprint; stableByNodeId: Map<string, string> }
  const assessed: AssessedNode[] = [];
  const notAssessed: ChangeNode[] = [];
  const partialReads: Array<{ ref: string; files: number }> = [];

  // Unusable federated targets surface as a single not-assessed marker each.
  for (const u of unusable) {
    notAssessed.push({ actor: '—', ref: '(all changes)', repo: u.name, kind: 'branch', assessed: false, reason: u.reason, detail: u.detail });
  }

  for (const rc of raw) {
    if (assessed.length + notAssessed.length >= maxChanges) {
      caveats.push(`Assessment capped at ${maxChanges} changes; further in-flight changes were not assessed (raise maxChanges to widen).`);
      break;
    }
    const repo = cgByRepo.get(rc.repo);
    if (rc.fetchError) {
      notAssessed.push({ actor: rc.actor, ref: rc.ref, repo: rc.repo, kind: rc.kind, assessed: false, reason: 'diff-unfetchable', detail: rc.fetchError });
      continue;
    }
    if (!repo) {
      notAssessed.push({ actor: rc.actor, ref: rc.ref, repo: rc.repo, kind: rc.kind, assessed: false, reason: 'index-missing', detail: `no usable index for ${rc.repo}` });
      continue;
    }
    const writeMembers = writeSetFromHunks(rc.files, rc.baseSymbolsByFile);
    if (writeMembers.length === 0) {
      notAssessed.push({ actor: rc.actor, ref: rc.ref, repo: rc.repo, kind: rc.kind, assessed: false, reason: 'no-resolvable-symbols', detail: 'the diff touched no symbol resolvable in the index' });
      continue;
    }
    if (rc.unreadableFiles && rc.unreadableFiles.length > 0) partialReads.push({ ref: rc.ref, files: rc.unreadableFiles.length });
    const footprint = footprintForChange(repo.cg, rc.ref, writeMembers, fpOptsFor(repo));
    const stableByNodeId = new Map<string, string>();
    for (const w of writeMembers) if (w.stableId) stableByNodeId.set(w.id, w.stableId);
    assessed.push({
      node: { actor: rc.actor, ref: rc.ref, repo: rc.repo, kind: rc.kind, assessed: true, changedFiles: rc.files.length, writeSetCount: writeMembers.length },
      footprint,
      stableByNodeId,
    });
  }

  // ── 3. Agent task descriptors join as first-class nodes (home repo) ─────────
  const home = repos[0];
  let cappedTasks = 0;
  let malformedTasks = 0;
  for (const t of input.tasks ?? []) {
    if (assessed.length + notAssessed.length >= maxChanges) { cappedTasks++; continue; }
    if (!t || typeof t.id !== 'string' || t.id.length === 0) { malformedTasks++; continue; }
    const hasSeed = (t.seedSymbols && t.seedSymbols.length > 0) || (t.seedFiles && t.seedFiles.length > 0);
    if (!hasSeed) {
      notAssessed.push({ actor: 'agent', ref: t.id, repo: home.name, kind: 'agent-task', assessed: false, reason: 'no-resolvable-symbols', detail: 'task descriptor has no seedSymbols or seedFiles' });
      continue;
    }
    const footprint = computeFootprint(home.cg, t, fpOptsFor(home));
    if (footprint.writeSet.length === 0) {
      notAssessed.push({ actor: 'agent', ref: t.id, repo: home.name, kind: 'agent-task', assessed: false, reason: 'no-resolvable-symbols', detail: `task seeds resolved to no symbol: ${footprint.unresolvedSeeds.join(', ')}` });
      continue;
    }
    const stableByNodeId = new Map<string, string>();
    const byId = new Map(home.cg.nodes.map(n => [n.id, n] as const));
    for (const w of footprint.writeSet) { const n = byId.get(w.id); if (n?.stableId) stableByNodeId.set(w.id, n.stableId); }
    assessed.push({
      node: { actor: 'agent', ref: t.id, repo: home.name, kind: 'agent-task', assessed: true, changedFiles: 0, writeSetCount: footprint.writeSet.length },
      footprint,
      stableByNodeId,
    });
  }
  if (cappedTasks > 0) caveats.push(`${cappedTasks} supplied task(s) were not assessed because the ${maxChanges}-change cap was reached (raise maxChanges to widen).`);
  if (malformedTasks > 0) caveats.push(`${malformedTasks} supplied task descriptor(s) were skipped for a missing/invalid id.`);

  // ── 4. Pairwise hazard classification across all assessed nodes ─────────────
  const conflicts: InterferenceConflict[] = [];
  const findings: GovernanceFinding[] = [];
  for (let i = 0; i < assessed.length; i++) {
    for (let j = i + 1; j < assessed.length; j++) {
      const A = assessed[i];
      const B = assessed[j];
      const crossRepo = A.node.repo !== B.node.repo;
      let v: HazardVerdict;
      // Witness ids are path-based (`file::name`) for same-repo and content-addressed
      // stable ids for cross-repo; map both to readable symbol names so the finding
      // NAMES the shared (federated) symbol rather than echoing an opaque id.
      const nameByWitnessId = new Map<string, string>();
      if (crossRepo) {
        // Match by content-addressed stable id across the repo boundary.
        const projA = projectToStableIds(A.footprint, A.node.repo, A.stableByNodeId);
        const projB = projectToStableIds(B.footprint, B.node.repo, B.stableByNodeId);
        for (const w of [...projA.writeSet, ...projB.writeSet]) nameByWitnessId.set(w.id, w.name);
        v = classifyHazard(projA, projB);
      } else {
        v = classifyHazard(A.footprint, B.footprint);
      }
      if (v.kind === 'none') continue;
      const labels = v.witnesses.map(id => nameByWitnessId.get(id) ?? shortName(id));
      conflicts.push({
        a: { actor: A.node.actor, ref: A.node.ref, repo: A.node.repo },
        b: { actor: B.node.actor, ref: B.node.ref, repo: B.node.repo },
        hazard: v.kind,
        direction: v.direction,
        crossRepo,
        witnesses: capWitnesses(labels),
        suggestion: suggestionFor(v, labels, A.node, B.node),
      });
      if (v.kind === 'WAW') {
        findings.push({
          code: 'cross-actor-conflict',
          severity: 'warning',
          source: 'interference-map',
          subject: `${A.node.ref} (${A.node.actor}) × ${B.node.ref} (${B.node.actor})`,
          message: `Write-write conflict on ${witnessSummary(labels)}${crossRepo ? ` across repos ${A.node.repo}/${B.node.repo}` : ''} — these in-flight changes must not land concurrently; rebase one onto the other.`,
        });
      }
    }
  }

  // Deterministic ordering of every list.
  conflicts.sort(conflictOrder);
  findings.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
  const changes = [...assessed.map(a => a.node), ...notAssessed].sort(changeOrder);

  if (conflicts.some(c => c.crossRepo)) {
    caveats.push('Cross-repo conflicts are matched by content-addressed stable id (qualified name + parameter shape, no file path or body), the same identity model federation uses. Two genuinely different symbols that share a name and arity across repos could collide — confirm a cross-repo witness names the same logical symbol before acting.');
  }
  if (anyPrEnumerated) {
    caveats.push('PR diffs are read against the LOCAL base ref; if a PR\'s base has advanced past local, its hunk line mapping is approximate. Re-fetch the base for an exact result.');
  }
  if (partialReads.length > 0) {
    const shown = partialReads.slice(0, 5).map(p => `${p.ref} (${p.files})`).join(', ');
    caveats.push(`Base content for some changed files could not be read; those files' symbols were omitted from the write-set (still assessed on the rest): ${shown}${partialReads.length > 5 ? `, +${partialReads.length - 5} more` : ''}.`);
  }

  const map: InterferenceMap = {
    baseRef: baseRefInput,
    resolvedBaseRef,
    repos: repos.map(r => r.name),
    changeCount: changes.length,
    assessedCount: assessed.length,
    notAssessedCount: notAssessed.length,
    changes,
    conflicts: conflicts.slice(0, CONFLICT_LIST_CAP),
    conflictCount: conflicts.length,
    conflictsTruncated: conflicts.length > CONFLICT_LIST_CAP,
    findings: findings.slice(0, FINDINGS_LIST_CAP),
    findingCount: findings.length,
    findingsTruncated: findings.length > FINDINGS_LIST_CAP,
    posture: 'advisory',
    caveats,
    disclosure: DISCLOSURE,
    headline: '',
  };
  map.headline = renderHeadline(map);
  return boundResponse(map);
}

function conflictOrder(a: InterferenceConflict, b: InterferenceConflict): number {
  return a.a.repo.localeCompare(b.a.repo) || a.a.ref.localeCompare(b.a.ref)
    || a.b.repo.localeCompare(b.b.repo) || a.b.ref.localeCompare(b.b.ref)
    || a.hazard.localeCompare(b.hazard);
}

function changeOrder(a: ChangeNode, b: ChangeNode): number {
  return a.repo.localeCompare(b.repo)
    || a.kind.localeCompare(b.kind)
    || a.ref.localeCompare(b.ref);
}

function renderHeadline(map: InterferenceMap): string {
  const repoNote = map.repos.length > 1 ? ` across ${map.repos.length} repos` : '';
  if (map.assessedCount === 0) {
    return `No in-flight changes assessed${repoNote} (vs ${map.resolvedBaseRef})` +
      (map.notAssessedCount > 0 ? `; ${map.notAssessedCount} not assessed.` : '.');
  }
  const waw = map.findingCount;
  const parts = [`${map.assessedCount} in-flight change(s)${repoNote}`];
  if (map.conflictCount === 0) parts.push('no structural conflicts');
  else {
    parts.push(`${map.conflictCount} conflict pair(s)`);
    if (waw > 0) parts.push(`${waw} write-write (must serialize)`);
  }
  if (map.notAssessedCount > 0) parts.push(`${map.notAssessedCount} not assessed`);
  return parts.join('; ') + '.';
}

/** Cheap deterministic byte estimate. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Deterministic response-size backstop (the same guardrail plan_parallel_work needs):
 * if a map exceeds the soft budget after per-list caps, trim the O(N²) evidence lists
 * and disclose it. The node list and all counts stay authoritative.
 */
function boundResponse(map: InterferenceMap): InterferenceMap {
  if (jsonBytes(map) <= SOFT_BUDGET_BYTES) return map;
  const trimWit = <T extends { witnesses: string[] }>(x: T): T => ({ ...x, witnesses: x.witnesses.slice(0, 3) });
  map.conflicts = map.conflicts.slice(0, 50).map(trimWit);
  map.conflictsTruncated = map.conflictCount > map.conflicts.length;
  map.findings = map.findings.slice(0, 25);
  map.findingsTruncated = map.findingCount > map.findings.length;
  map.truncationNote =
    'Large map: the conflict/finding evidence lists were trimmed to keep the response within budget. ' +
    'The node list and all counts are authoritative; re-invoke with fewer changes (lower maxChanges) for full detail.';
  return map;
}

/** MCP dispatch entry. */
export async function handleMapInFlightConflicts(input: InterferenceMapInput): Promise<unknown> {
  return computeInterferenceMap(input);
}
