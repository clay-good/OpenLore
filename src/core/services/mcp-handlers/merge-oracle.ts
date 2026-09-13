/**
 * Textual merge oracle for `map_in_flight_conflicts` (change: add-merge-tree-conflict-oracle).
 *
 * Answers one question per pair of in-flight commits: will git auto-merge the text, or report a
 * conflict? It runs `git merge-tree --write-tree` between the two tips over their merge base.
 *
 * Read-only and safe on an untrusted repository, by construction:
 * - **No writes to the analyzed repository.** `merge-tree --write-tree` writes the merged blobs and
 *   trees into the object store. The merge runs in a new, empty bare repository in the OS temp
 *   directory that reads the real objects through `objects/info/alternates`, so every new object
 *   lands in the scratch repository, which is removed afterwards.
 * - **No repository-chosen commands.** A `merge=<driver>` attribute makes git RUN the command in
 *   `merge.<driver>.driver`, and the driver name comes from `.gitattributes` or
 *   `$GIT_DIR/info/attributes`, so it cannot be turned off with `-c` or `--attr-source`. The scratch
 *   repository has no config, no info directory, and an unborn HEAD, so no attribute or driver of
 *   the analyzed repository is ever read. The trade-off is disclosed: a repository that relies on a
 *   custom merge driver or `merge=union` may merge differently than this simulation.
 * - **No silent divergence from a real merge.** Settings the scratch repository cannot see are
 *   checked in the real repository with value-only reads (`git config`, `git check-attr`, which
 *   run no driver): rename settings are forwarded as `-c` values, while a non-default `merge`
 *   attribute on a changed path, `merge.default`, `merge.renormalize`, branch merge options,
 *   replace refs or grafts, or a submodule conflict makes the pair `not-assessed`.
 * - **No guessed base.** The scratch repository has no shallow-clone boundary, so it could compute a
 *   wrong merge base. The base is resolved in the real repository and passed with `--merge-base`; a
 *   missing base (shallow clone, unrelated histories) or several bases (criss-cross history) is
 *   `not-assessed`, never `clean-automerge`.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileGit } from '../../../utils/git-exec.js';
import { gitPathArgs } from '../../../utils/git-args.js';

export type TextualMergeVerdict = 'textual-conflict' | 'clean-automerge' | 'not-assessed';

export interface TextualMerge {
  verdict: TextualMergeVerdict;
  /** Files git reports as conflicted (sorted, capped); set for `textual-conflict`. */
  conflictedFiles?: string[];
  /** Total conflicted files before the cap; set for `textual-conflict`. */
  conflictedFileCount?: number;
  /** Why the merge could not be simulated; set for `not-assessed`. */
  detail?: string;
}

export interface SimulateMergeOptions {
  /** Epoch milliseconds after which no git process is started and running ones are killed. */
  deadline?: number;
  /** Parent directory for the scratch repository (default: the OS temp directory). */
  scratchParent?: string;
}

/** Conflicted file names surfaced per pair, and the characters kept of each. */
const CONFLICTED_FILES_CAP = 8;
const PATH_CHARS_CAP = 240;
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
/** Longest single git process run for one simulation. */
const SPAWN_TIMEOUT_MS = 30_000;
/** Changed paths that are checked for merge attributes. */
const SHARED_PATHS_CAP = 500;
/** Repository settings that change merge results and are plain values, safe to forward with `-c`. */
const FORWARDED_CONFIG = new Set(['merge.renames', 'diff.renames', 'merge.renamelimit', 'diff.renamelimit', 'merge.directoryrenames']);
/** `merge` attribute values that mean the default text merge the simulation runs. */
const DEFAULT_MERGE_ATTRIBUTE = new Set(['unspecified', 'set', 'text']);
const GITLINK_MODE = '160000';
/**
 * Environment variables that would point git at the analyzed repository's store, index, or
 * attributes instead of the scratch repository (set, for example, inside a git hook).
 */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ATTR_SOURCE', 'GIT_NAMESPACE'];

/**
 * Environment for git reads in an analyzed repository. In a partial clone git lazily fetches a
 * missing object from the promisor remote, and for a local-path remote that runs the command in
 * the repository's own `remote.<name>.uploadpack`. `GIT_NO_LAZY_FETCH` (git 2.45+) turns the fetch
 * off, so a missing object is a read failure (and the verdict `not-assessed`) instead.
 */
export function noLazyFetchEnv(): NodeJS.ProcessEnv {
  // Replace refs are also ignored, so the real repository and the scratch repository (which has
  // no refs) see the same objects; a repository that has replace refs is reported not-assessed.
  return { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
}

function scratchEnv(): NodeJS.ProcessEnv {
  const env = noLazyFetchEnv();
  for (const key of REPO_ENV) delete env[key];
  return env;
}

function firstLine(text: string): string {
  return text.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 200) ?? '';
}

interface GitFailure { code?: unknown; killed?: boolean; signal?: unknown; stderr?: string | Buffer; stdout?: string; message?: string }

/** A short, command-free reason for a failed git process. */
function failureDetail(error: unknown): string {
  const e = error as GitFailure;
  if (e?.killed || e?.signal) return 'git timed out or was stopped';
  const stderr = firstLine(String(e?.stderr ?? ''));
  if (/unknown option|usage: git merge-tree/i.test(stderr)) return `this git is too old (needs 2.40 or later): ${stderr}`;
  return stderr || firstLine(String(e?.message ?? error)).replace(/^Command failed: .*/, 'git failed');
}

/** Thrown when the per-call deadline has passed before a git process could start. */
class DeadlineReached extends Error {}

function spawnTimeout(deadline: number | undefined): number {
  if (deadline === undefined) return SPAWN_TIMEOUT_MS;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DeadlineReached('the merge simulation time budget was spent');
  return Math.min(SPAWN_TIMEOUT_MS, remaining);
}

async function readGit(repoPath: string, args: string[], deadline: number | undefined): Promise<string> {
  const { stdout } = await execFileGit('git', args, { cwd: repoPath, env: noLazyFetchEnv(), maxBuffer: 16 * 1024 * 1024, timeout: spawnTimeout(deadline) });
  return stdout;
}

/** Exit code 1 means "no match" for `merge-base` and `config --get-regexp`; anything else is a failure. */
function isExitOne(error: unknown): boolean {
  const e = error as GitFailure;
  return e?.code === 1 && !e.killed && !e.signal;
}

/** True when `git --version` output names version `major.minor` or later. */
export function gitVersionAtLeast(versionOutput: string, major: number, minor: number): boolean {
  const match = /(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) return false;
  const [have, haveMinor] = [Number(match[1]), Number(match[2])];
  return have > major || (have === major && haveMinor >= minor);
}

/**
 * Repository merge settings the scratch repository would not see: `-c` arguments to forward, or a
 * reason the merge cannot be simulated faithfully. Only reads config values, which fetches nothing.
 */
async function repositoryMergeConfig(repoPath: string, deadline: number | undefined): Promise<{ args: string[] } | { detail: string }> {
  let listing: string;
  try {
    listing = await readGit(repoPath, ['config', '--get-regexp', '^((merge|diff)\\.(renames|renamelimit|directoryrenames|renormalize|default)|branch\\..+\\.mergeoptions|extensions\\.partialclone|remote\\..+\\.promisor)$'], deadline);
  } catch (error) {
    if (isExitOne(error)) return { args: [] };
    throw error;
  }
  const args: string[] = [];
  let partialClone = false;
  for (const line of listing.split('\n').filter(Boolean)) {
    const space = line.indexOf(' ');
    const key = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const value = space < 0 ? 'true' : line.slice(space + 1).trim();
    if (key === 'extensions.partialclone' || (key.startsWith('remote.') && key.endsWith('.promisor') && /^(true|yes|on|1)$/i.test(value))) {
      partialClone = true;
      continue;
    }
    if (key === 'merge.default') {
      if (value.toLowerCase() !== 'text') return { detail: `merge.default is "${value.slice(0, 40)}", which the simulation does not apply` };
      continue;
    }
    if (key.startsWith('branch.') && key.endsWith('.mergeoptions')) {
      return { detail: `${key.slice(0, 80)} is set, and those merge options are not simulated` };
    }
    if (key === 'merge.renormalize') {
      if (/^(true|yes|on|1)$/i.test(value)) return { detail: 'merge.renormalize is set, and renormalization depends on attributes the simulation ignores' };
      continue;
    }
    if (!FORWARDED_CONFIG.has(key)) continue;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) return { detail: `${key} has a value the simulation cannot forward` };
    args.push('-c', `${key}=${value}`);
  }
  if (partialClone) {
    // GIT_NO_LAZY_FETCH needs git 2.45; an older git would still run the promisor fetch.
    const version = await readGit(repoPath, ['--version'], deadline);
    if (!gitVersionAtLeast(version, 2, 45)) {
      return { detail: 'this is a partial clone, and git older than 2.45 cannot turn off lazy fetch' };
    }
  }
  return { args };
}

/**
 * A changed path whose `merge` attribute is not the default text merge, read from the base, both
 * tips, and the repository's own attributes files. Paths changed by EITHER side are checked: a
 * rename on one side moves an edit from the other side onto a new name with its own attributes.
 * Returns a detail, or undefined.
 */
async function mergeAttributeBlocker(repoPath: string, base: string, tipA: string, tipB: string, deadline: number | undefined): Promise<string | undefined> {
  const changed = async (tip: string) => new Set(
    (await readGit(repoPath, gitPathArgs('diff', '--name-only', '-z', '--no-renames', base, tip), deadline)).split('\0').filter(Boolean),
  );
  const shared = [...new Set([...(await changed(tipA)), ...(await changed(tipB))])].sort();
  if (shared.length === 0) return undefined;
  if (shared.length > SHARED_PATHS_CAP) return `${shared.length} changed paths exceed the ${SHARED_PATHS_CAP}-path merge-attribute check`;
  for (const source of [undefined, base, tipA, tipB]) {
    const args = ['check-attr', '-z', ...(source ? [`--source=${source}`] : []), 'merge', '--', ...shared];
    const fields = (await readGit(repoPath, args, deadline)).split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (!DEFAULT_MERGE_ATTRIBUTE.has(fields[i + 2])) {
        return `${fields[i]} has merge attribute "${fields[i + 2]}", which the simulation does not apply`;
      }
    }
  }
  return undefined;
}


/**
 * Simulate merging commit `tipA` with commit `tipB` in `repoPath`. Both tips must be object ids.
 * Never throws: every failure is a `not-assessed` verdict with a detail.
 */
export async function simulateMerge(repoPath: string, tipA: string, tipB: string, options: SimulateMergeOptions = {}): Promise<TextualMerge> {
  if (!OBJECT_ID.test(tipA) || !OBJECT_ID.test(tipB)) {
    return { verdict: 'not-assessed', detail: 'a change tip is not a resolved commit id' };
  }
  const { deadline } = options;
  try {
    return await simulate(repoPath, tipA, tipB, deadline, options.scratchParent ?? tmpdir());
  } catch (error) {
    const detail = error instanceof DeadlineReached ? error.message : `merge simulation failed: ${failureDetail(error)}`;
    return { verdict: 'not-assessed', detail };
  }
}

async function simulate(repoPath: string, tipA: string, tipB: string, deadline: number | undefined, scratchParent: string): Promise<TextualMerge> {
  const config = await repositoryMergeConfig(repoPath, deadline);
  if ('detail' in config) return { verdict: 'not-assessed', detail: config.detail };
  let bases: string[];
  try {
    bases = (await readGit(repoPath, ['merge-base', '--all', tipA, tipB], deadline)).split('\n').map(s => s.trim()).filter(Boolean);
  } catch (error) {
    if (!isExitOne(error)) throw error;
    bases = [];
  }
  if (bases.length === 0) {
    return { verdict: 'not-assessed', detail: 'no merge base found (shallow clone or unrelated histories)' };
  }
  if (bases.length > 1) {
    return { verdict: 'not-assessed', detail: `history has ${bases.length} merge bases (criss-cross); a single-base simulation could mislead` };
  }
  const attributeDetail = await mergeAttributeBlocker(repoPath, bases[0], tipA, tipB, deadline);
  if (attributeDetail) return { verdict: 'not-assessed', detail: attributeDetail };
  const [objectsDir, graftsFile, objectFormat] = (await readGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects', '--git-path', 'info/grafts', '--show-object-format'], deadline))
    .split('\n').map(s => s.trim()).filter(Boolean);
  if (!objectsDir || !graftsFile || !objectFormat) throw new Error('could not locate the object store');
  const replaceRefs = (await readGit(repoPath, ['for-each-ref', '--count=1', '--format=replace', 'refs/replace/'], deadline)).trim();
  if (replaceRefs || existsSync(graftsFile)) {
    return { verdict: 'not-assessed', detail: 'the repository has replace refs or grafts, which change history the simulation cannot see' };
  }

  const scratch = await mkdtemp(join(scratchParent, 'openlore-merge-'));
  try {
    const env = scratchEnv();
    await execFileGit('git', ['init', '--quiet', '--bare', '--template=', `--object-format=${objectFormat}`, scratch], { env, timeout: spawnTimeout(deadline) });
    await writeFile(join(scratch, 'objects', 'info', 'alternates'), `${objectsDir}\n`);
    let stdout: string;
    let conflicted = false;
    try {
      ({ stdout } = await execFileGit(
        'git',
        gitPathArgs(...config.args, `--git-dir=${scratch}`, 'merge-tree', '--write-tree', '-z', '--no-messages', `--merge-base=${bases[0]}`, tipA, tipB),
        { env, maxBuffer: 16 * 1024 * 1024, timeout: spawnTimeout(deadline) },
      ));
    } catch (error) {
      // Exit code 1 with a tree id on stdout is git's "merged with conflicts". Any other failure
      // (old git without --write-tree/--merge-base, a missing object, a timeout) prints no tree id.
      const e = error as GitFailure;
      if (!isExitOne(error) || typeof e.stdout !== 'string') throw error;
      stdout = e.stdout;
      conflicted = true;
    }
    const [tree, ...entries] = stdout.split('\0');
    if (!OBJECT_ID.test(tree.trim())) throw new Error(`unexpected merge-tree output: ${firstLine(stdout) || '(empty)'}`);
    if (!conflicted) return { verdict: 'clean-automerge' };
    // Conflicted file info: `<mode> <object> <stage>\t<path>`, one entry per conflicted stage.
    const paths = new Set<string>();
    for (const entry of entries.filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      if (entry.startsWith(`${GITLINK_MODE} `)) {
        return { verdict: 'not-assessed', detail: `${entry.slice(tab + 1)} is a submodule conflict, and the simulation cannot see submodule commits` };
      }
      paths.add(entry.slice(tab + 1));
    }
    const files = [...paths].sort();
    return {
      verdict: 'textual-conflict',
      conflictedFiles: files.slice(0, CONFLICTED_FILES_CAP).map(f => (f.length > PATH_CHARS_CAP ? `${f.slice(0, PATH_CHARS_CAP)}…` : f)),
      conflictedFileCount: files.length,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => { /* leftover temp dir only */ });
  }
}
