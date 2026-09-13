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
 * - **No guessed base.** The scratch repository has no shallow-clone boundary, so it could compute a
 *   wrong merge base. The base is resolved in the real repository and passed with `--merge-base`; a
 *   missing base (shallow clone, unrelated histories) or several bases (criss-cross history) is
 *   `not-assessed`, never `clean-automerge`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileGit } from '../../../utils/git-exec.js';

export type TextualMergeVerdict = 'textual-conflict' | 'clean-automerge' | 'not-assessed';

export interface TextualMerge {
  verdict: TextualMergeVerdict;
  /** Files git reports as conflicted (sorted, capped); set for `textual-conflict`. */
  conflictedFiles?: string[];
  /** Why the merge could not be simulated; set for `not-assessed`. */
  detail?: string;
}

/** Conflicted file names surfaced per pair. */
const CONFLICTED_FILES_CAP = 8;
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
/**
 * Environment variables that would point git at the analyzed repository's store, index, or
 * attributes instead of the scratch repository (set, for example, inside a git hook).
 */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ATTR_SOURCE', 'GIT_NAMESPACE'];

function scratchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of REPO_ENV) delete env[key];
  return env;
}

function firstLine(text: string): string {
  return text.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 200) ?? '';
}

function failureDetail(error: unknown): string {
  const e = error as { stderr?: string | Buffer; message?: string };
  return firstLine(String(e?.stderr ?? '')) || firstLine(String(e?.message ?? error));
}

async function readGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileGit('git', args, { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * Simulate merging commit `tipA` with commit `tipB` in `repoPath`. Both tips must be object ids.
 * Never throws: every failure is a `not-assessed` verdict with a detail.
 */
export async function simulateMerge(repoPath: string, tipA: string, tipB: string): Promise<TextualMerge> {
  if (!OBJECT_ID.test(tipA) || !OBJECT_ID.test(tipB)) {
    return { verdict: 'not-assessed', detail: 'a change tip is not a resolved commit id' };
  }
  let bases: string[];
  let objectsDir: string;
  let objectFormat: string;
  try {
    bases = (await readGit(repoPath, ['merge-base', '--all', tipA, tipB])).split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    bases = [];
  }
  if (bases.length === 0) {
    return { verdict: 'not-assessed', detail: 'no merge base found (shallow clone or unrelated histories)' };
  }
  if (bases.length > 1) {
    return { verdict: 'not-assessed', detail: `history has ${bases.length} merge bases (criss-cross); a single-base simulation could mislead` };
  }
  try {
    objectsDir = (await readGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim();
    objectFormat = (await readGit(repoPath, ['rev-parse', '--show-object-format'])).trim() || 'sha1';
  } catch (error) {
    return { verdict: 'not-assessed', detail: `could not locate the object store: ${failureDetail(error)}` };
  }

  let scratch: string;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'openlore-merge-'));
  } catch (error) {
    return { verdict: 'not-assessed', detail: `could not create a scratch repository: ${failureDetail(error)}` };
  }
  try {
    const env = scratchEnv();
    await execFileGit('git', ['init', '--quiet', '--bare', '--template=', `--object-format=${objectFormat}`, scratch], { env });
    await writeFile(join(scratch, 'objects', 'info', 'alternates'), `${objectsDir}\n`);
    let stdout: string;
    let conflicted = false;
    try {
      ({ stdout } = await execFileGit(
        'git',
        [`--git-dir=${scratch}`, 'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${bases[0]}`, tipA, tipB],
        { env, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      ));
    } catch (error) {
      // Exit code 1 with a tree id on stdout is git's "merged with conflicts". Any other failure
      // (old git without --write-tree/--merge-base, a missing object) prints no tree id.
      const e = error as { code?: unknown; stdout?: string };
      if (e.code !== 1 || typeof e.stdout !== 'string') throw error;
      stdout = e.stdout;
      conflicted = true;
    }
    const [tree, ...rest] = stdout.split('\0');
    if (!OBJECT_ID.test(tree.trim())) throw new Error(`unexpected merge-tree output: ${firstLine(stdout) || '(empty)'}`);
    if (!conflicted) return { verdict: 'clean-automerge' };
    const files = [...new Set(rest.filter(Boolean))].sort();
    return { verdict: 'textual-conflict', conflictedFiles: files.slice(0, CONFLICTED_FILES_CAP) };
  } catch (error) {
    return { verdict: 'not-assessed', detail: `merge simulation failed (requires git 2.40 or later): ${failureDetail(error)}` };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => { /* leftover temp dir only */ });
  }
}
