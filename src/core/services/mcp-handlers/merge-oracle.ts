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
/** Changed paths that are checked for merge attributes, by count and by total characters (Windows argv limit). */
const SHARED_PATHS_CAP = 500;
const SHARED_PATH_CHARS_CAP = 24_000;
/** Repository settings that change merge results and are plain values, safe to forward with `-c`. */
const FORWARDED_CONFIG = new Set(['merge.renames', 'diff.renames', 'merge.renamelimit', 'diff.renamelimit', 'merge.directoryrenames', 'diff.indentheuristic', 'merge.conflictstyle']);
/**
 * Keys `git merge` parses strictly (a bad value makes it die) that do not otherwise change the
 * result: each value must parse, or the pair is not-assessed. Maps the key to its value check.
 */
const STRICT_VALUE_KEYS: Record<string, (value: string, hasValue: boolean) => boolean> = {
  'merge.stat': isGitBoolText,
  'merge.diffstat': isGitBoolText,
  'merge.log': (value, hasValue) => isGitBoolWord(value, hasValue) || parsesAsGitInt(value, 0n, INT_MAX),
  'merge.autostash': isGitBoolText,
  'merge.branchdesc': isGitBoolText,
  'merge.defaulttoupstream': isGitBoolText,
  // merge-ort asserts 0 <= verbosity <= 5.
  'merge.verbosity': (value, hasValue) => hasValue && parsesAsGitInt(value, 0n, 5n),
  // git ignores an unrecognized merge.ff value.
  'merge.ff': () => true,
  'commit.gpgsign': isGitBoolText,
  'commit.cleanup': (value, hasValue) => hasValue && /^(strip|whitespace|verbatim|scissors|default)$/.test(value),
  // An unsigned long in git: 32 bits on Windows, so larger values are refused everywhere.
  'core.bigfilethreshold': (value, hasValue) => hasValue && parsesAsGitInt(value, 0n, 4294967295n),
};
/**
 * Attributes known not to change a merge result without `merge.renormalize` (which is refused).
 * Any other attribute on a changed path makes the pair not-assessed: an allowlist, so an unanticipated
 * attribute (`diff`, which changes rename detection, a filter, an encoding) cannot produce a false clean.
 */
const HARMLESS_ATTRIBUTES = new Set(['text', 'eol', 'crlf', 'whitespace', 'export-ignore', 'export-subst']);

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

function capPath(path: string): string {
  return path.length > PATH_CHARS_CAP ? `${path.slice(0, PATH_CHARS_CAP)}…` : path;
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

/**
 * Git's boolean parsing. A key with no `=` at all (`hasValue` false) is true; an explicitly empty
 * value is false; otherwise `true`/`yes`/`on` or any non-zero integer.
 */
const INT_MIN = -2147483648n;
const INT_MAX = 2147483647n;

/**
 * Git's integer config parsing: optional leading whitespace and sign, digits, and an optional
 * k/m/g unit (powers of 1024), with the scaled result inside [min, max]. No trailing characters.
 */
function parsesAsGitInt(value: string, min: bigint, max: bigint): boolean {
  const match = /^\s*([+-]?\d{1,40})([kmg]?)$/i.exec(value);
  if (!match) return false;
  const unit = { '': 1n, k: 1024n, m: 1048576n, g: 1073741824n }[match[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
  const scaled = BigInt(match[1]) * unit;
  return scaled >= min && scaled <= max;
}

/** A value git's strict boolean parser accepts, untrimmed: a bool word, empty, no value, or a 32-bit int. */
function isGitBoolText(value: string, hasValue: boolean): boolean {
  return isGitBoolWord(value, hasValue) || parsesAsGitInt(value, INT_MIN, INT_MAX);
}

function isGitBoolWord(value: string, hasValue: boolean): boolean {
  return !hasValue || value === '' || /^(true|false|yes|no|on|off)$/i.test(value);
}

function isGitTrue(value: string, hasValue = true): boolean {
  if (!hasValue) return true;
  return /^(true|yes|on)$/i.test(value) || (/^-?\d+$/.test(value) && Number(value) !== 0);
}

/**
 * Merge driver names that `git check-attr` prints exactly like the default text merge states, so a
 * user driver with one of these names would be invisible to the attribute check.
 */
const AMBIGUOUS_DRIVER_NAMES = new Set(['text', 'set', 'unspecified']);

/** True when `git --version` output names version `major.minor` or later. */
export function gitVersionAtLeast(versionOutput: string, major: number, minor: number): boolean {
  const match = /(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) return false;
  const [have, haveMinor] = [Number(match[1]), Number(match[2])];
  return have > major || (have === major && haveMinor >= minor);
}

/**
 * Repository-local `merge.*` keys known not to change the merge result (output, tooling, and
 * fast-forward choices). Any other `merge.*` key makes the pair not-assessed: an allowlist, so an
 * unanticipated setting can never produce a silent `clean-automerge`. (`merge.conflictStyle` is not
 * harmless: diff3 skips conflict refinement, so it is forwarded instead.)
 */
const HARMLESS_MERGE_KEYS = new Set([
  'merge.verbosity', 'merge.ff', 'merge.log', 'merge.stat', 'merge.diffstat', 'merge.tool',
  'merge.guitool', 'merge.autostash', 'merge.suppressdest', 'merge.branchdesc', 'merge.defaulttoupstream',
]);

interface MergeConfig {
  /** Global `-c` options, placed before the subcommand. */
  args: string[];
}

/**
 * Repository merge settings the scratch repository would not see: `-c` arguments to forward, or a
 * reason the merge cannot be simulated faithfully. Only reads config values, which fetches nothing.
 * Every scope is checked: global config can reach only the real repository through
 * `includeIf "gitdir:..."`, so the scratch repository cannot be assumed to see it.
 */
async function repositoryMergeConfig(repoPath: string, deadline: number | undefined): Promise<MergeConfig | { detail: string }> {
  let listing: string;
  try {
    // -z: `key LF value NUL`, so a value containing a newline cannot forge another entry.
    listing = await readGit(repoPath, ['config', '-z', '--get-regexp', '^(merge\\..+|diff\\.(renames|renamelimit|algorithm|indentheuristic)|pull\\.twohead|commit\\.(cleanup|gpgsign)|core\\.bigfilethreshold|branch\\..+\\.mergeoptions|extensions\\.partialclone|remote\\..+\\.promisor)$'], deadline);
  } catch (error) {
    if (isExitOne(error)) return { args: [] };
    throw error;
  }
  const args: string[] = [];
  let partialClone = false;
  for (const entry of listing.split('\0').filter(Boolean)) {
    const newline = entry.indexOf('\n');
    const hasValue = newline >= 0;
    const key = (hasValue ? entry.slice(0, newline) : entry).toLowerCase();
    const rawValue = hasValue ? entry.slice(newline + 1) : '';
    const value = rawValue.trim();
    if (key === 'extensions.partialclone' || (key.startsWith('remote.') && key.endsWith('.promisor') && isGitTrue(value, hasValue))) {
      partialClone = true;
      continue;
    }
    if (key === 'pull.twohead') {
      // Strategy names are case-sensitive and space-split by git: compare the raw value exactly.
      if (!hasValue || !/^(ort|recursive)$/.test(rawValue)) return { detail: `pull.twohead selects the "${value.slice(0, 40)}" merge strategy, which is not simulated` };
      continue;
    }
    if (key === 'diff.algorithm') {
      // merge-tree ignores `-c diff.algorithm` (it is read only for porcelain merges); `-X` applies it.
      if (!hasValue || !/^(myers|minimal|patience|histogram)$/i.test(rawValue)) return { detail: `diff.algorithm "${value.slice(0, 40)}" is not simulated` };
      // Only the default is assessed: a fresh clone or a hosted merge does not carry a local setting,
      // and another algorithm can hide a conflict they would report.
      if (rawValue.toLowerCase() !== 'histogram') return { detail: `diff.algorithm "${rawValue}" in git config can hide a conflict that a fresh clone or hosted merge reports` };
      continue;
    }
    if (STRICT_VALUE_KEYS[key]) {
      // Checked on the raw value: git does not trim a quoted value (" true" is a fatal bad boolean).
      if (!STRICT_VALUE_KEYS[key](rawValue, hasValue)) return { detail: `${key} has a value git merge cannot parse` };
      if (!key.startsWith('merge.')) continue;
    }
    if (key.startsWith('branch.') && key.endsWith('.mergeoptions')) {
      return { detail: `${key.slice(0, 80)} is set, and those merge options are not simulated` };
    }
    const parts = key.split('.');
    if (parts[0] === 'merge' && parts.length >= 3) {
      // Any `merge.<name>.<key>` defines a user merge driver, with or without a `.driver` line.
      const name = parts.slice(1, -1).join('.');
      if (AMBIGUOUS_DRIVER_NAMES.has(name)) return { detail: `a merge driver named "${name}" is configured, which the attribute check cannot tell from the default merge` };
      continue;
    }
    if (key === 'merge.default') {
      if (value.toLowerCase() !== 'text') return { detail: `merge.default is "${value.slice(0, 40)}", which the simulation does not apply` };
      continue;
    }
    if (key === 'merge.renormalize') {
      if (!isGitBoolText(rawValue, hasValue)) return { detail: 'merge.renormalize has a value git merge cannot parse' };
      if (isGitTrue(value, hasValue)) return { detail: 'merge.renormalize is set, and renormalization depends on attributes the simulation ignores' };
      continue;
    }
    if (FORWARDED_CONFIG.has(key)) {
      // A forwarded key with no value makes a real merge die ("missing value"), so it is not assessed.
      if (!hasValue || !/^[A-Za-z0-9_-]{1,32}$/.test(rawValue)) return { detail: `${key} has a value the simulation cannot forward` };
      if (key === 'merge.conflictstyle' && !/^(merge|diff3|zdiff3)$/i.test(value)) return { detail: `merge.conflictStyle "${value}" is not simulated` };
      // Settings that can weaken rename or conflict detection relative to git's defaults are not assessed:
      // a fresh clone or a hosted merge does not carry them and would report the conflict they hide.
      const weakens = ((key === 'merge.renames' || key === 'diff.renames') && !/^(copies|copy)$/i.test(value) && !isGitTrue(value))
        || key === 'merge.renamelimit' || key === 'diff.renamelimit'
        || (key === 'merge.directoryrenames' && value.toLowerCase() !== 'conflict');
      if (weakens) return { detail: `${key}=${value.slice(0, 40)} in git config can hide a conflict that a fresh clone or hosted merge reports` };
      args.push('-c', `${key}=${value}`);
      continue;
    }
    if (parts[0] === 'merge' && !HARMLESS_MERGE_KEYS.has(key)) {
      return { detail: `${key.slice(0, 80)} is set in git config and is not simulated` };
    }
  }
  if (partialClone) {
    // GIT_NO_LAZY_FETCH needs git 2.45; an older git would still run the promisor fetch.
    const version = await readGit(repoPath, ['--version'], deadline);
    if (!gitVersionAtLeast(version, 2, 45)) {
      return { detail: 'this is a partial clone, and git older than 2.45 cannot turn off lazy fetch' };
    }
  }
  // Last value wins, as in git; histogram is merge-ort's own default.
  return { args };
}

/**
 * A changed path whose `merge` attribute is not the default text merge, read from the base, both
 * tips, and the repository's own attributes files. Paths changed by EITHER side are checked: a
 * rename on one side moves an edit from the other side onto a new name with its own attributes.
 * Returns a detail, or undefined.
 */
/**
 * The first attribute in `check-attr -z -a` output that the simulation does not apply: a non-default
 * `merge`, or any attribute outside the allowlist. Returns a detail, or undefined.
 */
function attributeBlocker(fields: string[]): string | undefined {
  let otherAttribute: string | undefined;
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, attribute, value] = [fields[i], fields[i + 1], fields[i + 2]];
    if (attribute === 'merge') {
      if (!DEFAULT_MERGE_ATTRIBUTE.has(value)) {
        return `${capPath(path)} has merge attribute "${value.slice(0, 40)}", which the simulation does not apply`;
      }
    } else if (!otherAttribute && !HARMLESS_ATTRIBUTES.has(attribute) && !attribute.startsWith('linguist-')) {
      otherAttribute = `${capPath(path)} has attribute "${attribute.slice(0, 40)}", which the simulation does not apply`;
    }
  }
  return otherAttribute;
}

async function mergeAttributeBlocker(
  repoPath: string, base: string, tipA: string, tipB: string, deadline: number | undefined,
  changedPathsOut: string[],
): Promise<string | undefined> {
  // `--raw` entries: `:<old mode> <new mode> <old id> <new id> <status>` NUL `<path>` NUL.
  let gitlinkTypeChange: string | undefined;
  const symlinksByTip = new Map<string, string[]>();
  const changed = async (tip: string) => {
    const symlinks: string[] = [];
    symlinksByTip.set(tip, symlinks);
    const fields = (await readGit(repoPath, gitPathArgs('diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', '--no-renames', base, tip), deadline)).split('\0');
    const paths = new Set<string>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [oldMode, newMode] = fields[i].replace(/^:/, '').split(' ');
      const path = fields[i + 1];
      if (!path) continue;
      paths.add(path);
      if (newMode === '120000') symlinks.push(path);
      // A submodule replaced by (or removed for) ordinary files collides with the checked-out
      // submodule's files in a real merge; the simulation cannot see that working-tree state.
      if (!gitlinkTypeChange && (oldMode === GITLINK_MODE) !== (newMode === GITLINK_MODE)) gitlinkTypeChange = path;
    }
    return paths;
  };
  const shared = [...new Set([...(await changed(tipA)), ...(await changed(tipB))])].sort();
  if (gitlinkTypeChange) return `${capPath(gitlinkTypeChange)} changes between a submodule and a regular entry, which the simulation cannot see into`;
  changedPathsOut.push(...shared);
  if (shared.length === 0) return undefined;
  // A real merge refuses to check out a path with a `.git` component (verify_path); merge-tree does not.
  const gitComponent = shared.find(path => path.split('/').some(part => part.toLowerCase() === '.git'));
  if (gitComponent) return `${capPath(gitComponent)} has a .git path component, which a real merge refuses to check out`;
  // A path valid in git can exceed a checkout filesystem's limits (a 255-byte name; about 1,024 bytes on
  // macOS), which fails a real merge's checkout; a branch made on Linux can carry one.
  const tooLong = shared.find(path => Buffer.byteLength(path) > 1000 || path.split('/').some(part => Buffer.byteLength(part) > 255));
  if (tooLong) return `${capPath(tooLong)} is longer than a checkout filesystem allows`;
  // A symlink target is a blob of any length in git, but creating the link fails past the filesystem's
  // path limit (1,024 bytes on macOS). `ls-tree -l` reports each changed link's target size.
  for (const [tip, links] of symlinksByTip) {
    if (links.length === 0) continue;
    const listing = await readGit(repoPath, gitPathArgs('--literal-pathspecs', 'ls-tree', '-l', '-z', '--full-tree', tip, '--', ...links), deadline);
    for (const entry of listing.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3]);
      if (!(size < 1000)) return `${capPath(entry.slice(tab + 1))} is a symlink whose target is longer than a checkout filesystem allows`;
    }
  }
  const chars = shared.reduce((n, path) => n + path.length + 1, 0);
  if (shared.length > SHARED_PATHS_CAP || chars > SHARED_PATH_CHARS_CAP) {
    return `${shared.length} changed paths (${chars} characters) exceed the merge-attribute check limit of ${SHARED_PATHS_CAP} paths or ${SHARED_PATH_CHARS_CAP} characters`;
  }
  for (const source of [undefined, base, tipA, tipB]) {
    // precomposeunicode=false: keep path bytes as the tree stores them, so a decomposed (NFD) path
    // still matches its decomposed `.gitattributes` pattern on macOS.
    const args = ['-c', 'core.precomposeunicode=false', 'check-attr', '-z', ...(source ? [`--source=${source}`] : []), '-a', '--', ...shared];
    const blocked = attributeBlocker((await readGit(repoPath, args, deadline)).split('\0'));
    if (blocked) return blocked;
  }
  {
    // On a case-insensitive filesystem a real merge also reads `.GITATTRIBUTES`, or `Sub/.gitattributes`
    // for `sub/f.txt`; `--source` reads trees by exact name and would miss both. `core.ignorecase` is
    // not a reliable signal of the filesystem, so this runs everywhere: list the root and every
    // ancestor directory of a changed path (not the whole tree) and refuse any case variant.
    const dirs = new Set<string>();
    for (const path of shared) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    // Filesystems fold more than ASCII case (APFS: `ſ`→`s`, `ς`→`σ`, `ß`→`ss`, NFC/NFD), and JavaScript
    // has no full Unicode case fold, so a non-ASCII name where folding matters is not assessed.
    const nonAscii = (name: string) => /[\u0080-\uFFFF]/.test(name);
    const dirChars = [...dirs].reduce((n, dir) => n + dir.length + 2, 0);
    if (dirChars > SHARED_PATH_CHARS_CAP) return `changed directories (${dirChars} characters) exceed the ${SHARED_PATH_CHARS_CAP}-character case check limit`;
    const nonAsciiDir = [...dirs].find(nonAscii);
    if (nonAsciiDir) return `${capPath(nonAsciiDir)} is a non-ASCII directory name, and filesystem case folding cannot be checked for it`;
    const dirsLower = new Map([...dirs].map(dir => [dir.toLowerCase(), dir] as const));
    const checkedAttributeBlobs = new Set<string>();
    const attributeFilesByTree = new Map<string, string[]>();
    // Two changed files that differ only by case (`README`, `readme`) overwrite each other on a
    // case-insensitive checkout, which fails a real merge.
    const sharedSet = new Set(shared);
    const sharedLower = new Map<string, string>();
    for (const path of shared) {
      const other = sharedLower.get(path.toLowerCase());
      if (other !== undefined && other !== path) return `${capPath(path)} differs from changed path ${capPath(other)} only by letter case`;
      sharedLower.set(path.toLowerCase(), path);
    }
    if (dirsLower.size < dirs.size) {
      const spellings = [...dirs].filter(dir => dirsLower.get(dir.toLowerCase()) !== dir);
      return `${capPath(spellings[0])} differs from another changed directory only by letter case`;
    }
    for (const tree of [base, tipA, tipB]) {
      const attributeFiles: string[] = [];
      attributeFilesByTree.set(tree, attributeFiles);
      // Records are `<mode> <type> <id>` TAB `<path>`; the mode shows a symlinked `.gitattributes`.
      const listing = gitPathArgs('-c', 'core.precomposeunicode=false', '--literal-pathspecs', 'ls-tree', '-z', '--full-tree', tree);
      const records = (await readGit(repoPath, listing, deadline)).split('\0');
      if (dirs.size > 0) records.push(...(await readGit(repoPath, [...listing, '--', ...[...dirs].map(dir => `${dir}/`)], deadline)).split('\0'));
      for (const record of records.filter(Boolean)) {
        const tab = record.indexOf('\t');
        const [mode, , objectId] = record.slice(0, tab).split(' ');
        const entry = record.slice(tab + 1);
        const name = entry.slice(entry.lastIndexOf('/') + 1);
        if (name.toLowerCase() === '.gitattributes') {
          // A real merge reads only a regular `.gitattributes` from disk, but `check-attr --source` reads
          // a symlink's target or a gitlink's object as attribute lines, which can hide a rule the merge
          // applies. A blob it does read can still disagree: git strips a UTF-8 BOM only from a file on
          // disk, and the blob parser stops at a NUL byte. Each of these is not assessed.
          if (mode !== '100644' && mode !== '100755') {
            return `${capPath(entry)} ${mode === '120000' ? 'is a symlink' : `has mode ${mode}`}, which a real merge ignores but the attribute check would read`;
          }
          attributeFiles.push(entry);
          if (OBJECT_ID.test(objectId ?? '') && !checkedAttributeBlobs.has(objectId)) {
            checkedAttributeBlobs.add(objectId);
            const content = await readGit(repoPath, ['cat-file', 'blob', objectId], deadline);
            if (content.startsWith('\uFEFF') || content.includes('\0')) {
              return `${capPath(entry)} has a byte-order mark or a NUL byte, which the attribute check reads differently than a real merge`;
            }
            // git ignores an attributes line of 2,048 bytes or more; checkout expansion of the file on
            // disk (for example `ident`) can push a line past that limit that the blob parser still reads.
            if (content.split('\n').some(line => Buffer.byteLength(line) >= 2000)) {
              return `${capPath(entry)} has a line near git's attribute line-length limit, which the attribute check can read differently than a real merge`;
            }
          }
        }
        // NTFS drops trailing dots and spaces and has 8.3 short names (`GITATT~1`), so those alias too.
        if (nonAscii(name) || /[. ]$/.test(name) || /~\d/.test(name)) {
          return `${capPath(entry)} is a name beside a changed path that a filesystem may alias (non-ASCII, trailing dot or space, or a short name)`;
        }
        const variantAttributes = name !== '.gitattributes' && name.toLowerCase() === '.gitattributes';
        const variantDir = !dirs.has(entry) && dirsLower.has(entry.toLowerCase());
        const variantFile = !sharedSet.has(entry) && sharedLower.has(entry.toLowerCase());
        if (variantAttributes || variantDir || variantFile) {
          return `${capPath(entry)} differs from a changed path only by letter case`;
        }
      }
    }
    // Checkout attributes on a `.gitattributes` itself (`ident`, `working-tree-encoding`, a filter) change
    // the file a real merge reads from disk; apply the same allowlist to the attributes files.
    for (const [tree, files] of attributeFilesByTree) {
      if (files.length === 0) continue;
      const fields = (await readGit(repoPath, ['-c', 'core.precomposeunicode=false', 'check-attr', '-z', `--source=${tree}`, '-a', '--', ...files], deadline)).split('\0');
      const blocked = attributeBlocker(fields);
      if (blocked) return blocked;
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
    const budgetSpent = error instanceof DeadlineReached || (deadline !== undefined && Date.now() >= deadline);
    const detail = budgetSpent ? 'the merge simulation time budget was spent' : `merge simulation failed: ${failureDetail(error)}`;
    return { verdict: 'not-assessed', detail };
  }
}

async function simulate(startPath: string, tipA: string, tipB: string, deadline: number | undefined, scratchParent: string): Promise<TextualMerge> {
  // Run every read from the top level: `diff --name-only` prints top-relative paths, while
  // `check-attr` resolves paths against the current directory.
  const [repoPath, gitDir] = (await readGit(startPath, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], deadline)).split('\n').map(s => s.trim());
  if (!repoPath || !gitDir) throw new Error('could not locate the repository top level');
  // `core.worktree` can name a work tree that belongs to another repository; reads from there
  // would describe the wrong repository.
  const topGitDir = (await readGit(repoPath, ['rev-parse', '--absolute-git-dir'], deadline)).trim();
  if (topGitDir !== gitDir) {
    return { verdict: 'not-assessed', detail: 'the work tree resolves to a different git directory (core.worktree), so its attributes cannot be trusted' };
  }
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
  const [objectsDir, graftsFile, objectFormat] = (await readGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects', '--git-path', 'info/grafts', '--show-object-format'], deadline))
    .split('\n').map(s => s.trim()).filter(Boolean);
  if (!objectsDir || !graftsFile || !objectFormat) throw new Error('could not locate the object store');
  const changedPaths: string[] = [];
  const attributeDetail = await mergeAttributeBlocker(repoPath, bases[0], tipA, tipB, deadline, changedPaths);
  if (attributeDetail) return { verdict: 'not-assessed', detail: attributeDetail };
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
    // A real merge checks out paths, and refuses ones git's path protection rejects (`.git.`, `GIT~1`,
    // `.git::$DATA`, a `.gitmodules` symlink). Let git decide, with both protections on, for both tips
    // and the merged tree.
    for (const [label, candidate] of [['a change tip', tipA], ['a change tip', tipB], ['the merged tree', tree.trim()]] as const) {
      try {
        await execFileGit('git', [`--git-dir=${scratch}`, '-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true', 'read-tree', candidate], {
          env: { ...env, GIT_INDEX_FILE: join(scratch, 'verify-index') },
          timeout: spawnTimeout(deadline),
        });
      } catch (error) {
        if (deadline !== undefined && Date.now() >= deadline) throw error;
        return { verdict: 'not-assessed', detail: `${label} contains a path a real checkout refuses: ${failureDetail(error)}` };
      }
    }
    // The merged `.gitattributes` can hold an attribute none of the inputs has (each side removes a
    // different line that cleared it), and a real merge writes files with it. Check it the same way,
    // in the scratch repository, which has no config and so runs no filter or driver.
    // The checks below exist only to prevent a false clean; a conflicted merge never claims clean.
    if (!conflicted) {
      // A merge can place a path neither side changed (a directory rename writes `e/y` for an added
      // `d/y`); no check above saw it, so the pair is not assessed.
      const checked = new Set(changedPaths);
      for (const tip of [tipA, tipB]) {
        const moved = await execFileGit('git', gitPathArgs(`--git-dir=${scratch}`, 'diff-tree', '--no-ext-diff', '--no-textconv', '-r', '-z', '--name-only', '--no-renames', tip, tree.trim()), {
          env, maxBuffer: 16 * 1024 * 1024, timeout: spawnTimeout(deadline),
        });
        const unseen = moved.stdout.split('\0').find(path => path && !checked.has(path));
        if (unseen) return { verdict: 'not-assessed', detail: `the merge places ${capPath(unseen)}, which neither change touched, so the attribute and path checks did not cover it` };
      }
      if (changedPaths.length > 0) {
        const merged = await execFileGit('git', [`--git-dir=${scratch}`, '-c', 'core.precomposeunicode=false', 'check-attr', '-z', `--source=${tree.trim()}`, '-a', '--', ...changedPaths], {
          env, maxBuffer: 16 * 1024 * 1024, timeout: spawnTimeout(deadline),
        });
        const blocked = attributeBlocker(merged.stdout.split('\0'));
        if (blocked) return { verdict: 'not-assessed', detail: `in the merged tree, ${blocked}` };
      }
    }
    if (!conflicted) return { verdict: 'clean-automerge' };
    // Conflicted file info: `<mode> <object> <stage>\t<path>`, one entry per conflicted stage.
    const paths = new Set<string>();
    for (const entry of entries.filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      if (entry.startsWith(`${GITLINK_MODE} `)) {
        return { verdict: 'not-assessed', detail: `${capPath(entry.slice(tab + 1))} is a submodule conflict, and the simulation cannot see submodule commits` };
      }
      paths.add(entry.slice(tab + 1));
    }
    const files = [...paths].sort();
    return {
      verdict: 'textual-conflict',
      conflictedFiles: files.slice(0, CONFLICTED_FILES_CAP).map(capPath),
      conflictedFileCount: files.length,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => { /* leftover temp dir only */ });
  }
}
