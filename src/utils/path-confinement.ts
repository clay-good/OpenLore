/**
 * Path confinement for values that came from an analyzed repository.
 *
 * OpenLore reads repositories it does not trust (SECURITY.md scopes exactly that),
 * and two of the values it acts on are attacker-authored: `openspecPath` in the
 * committed `.openlore/config.json`, and the layout of `openspec/` itself — a repo
 * can commit a SYMLINK there, and git will check it out. Neither may be allowed to
 * redirect a read or a write outside the project root.
 *
 * These primitives live in a leaf module (no OpenLore imports) because the sites
 * that need them span the MCP handlers, the CLI, the decision syncer and the
 * analyzer; a shared guard that only one face can import is how the drift that
 * motivated this file happened in the first place.
 */

import { constants, realpathSync, lstatSync, readlinkSync, type Stats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** Upper bound on a symlink chain, so a cycle cannot spin the resolver. */
const MAX_SYMLINK_HOPS = 64;
import { OPENSPEC_DIR } from '../constants.js';

/**
 * The canonical (symlink-resolved) path of `p`, or — when `p` does not exist (a
 * write target) — the canonical path of its nearest existing ancestor. Used to
 * confine on the REAL filesystem location rather than the lexical path.
 */
function realPathOrNearestExisting(p: string): string {
  let cur = p;
  // Bounds a symlink chain (including a cycle) so this can never spin.
  for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops++) {
    try {
      return realpathSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;

      // ENOENT means one of two very different things, and conflating them is a
      // confinement hole: either `cur` genuinely does not exist (walk up to the
      // nearest existing ancestor, which is what a write target needs), or `cur`
      // IS a symlink whose TARGET does not exist. In the second case `realpath`
      // fails but `writeFile` still follows the link and creates the file at the
      // target — so a repo committing `openspec/specs/d/spec.md -> ~/.zshenv`
      // would be confined against its in-root PARENT and pass. Resolve the link
      // ourselves and keep confining on where the write would actually land.
      try {
        if (lstatSync(cur).isSymbolicLink()) {
          // Resolve the target against the link's REAL directory, not its lexical
          // one. `readlink` is relative to where the link actually lives, so with
          // `root/self -> .` the path `root/self/M` has lexical dirname `root/self`
          // — and a target of `../evil` then resolves to the in-root `root/evil`
          // while the kernel resolves it from the real dir to `<outside>/evil`.
          // That difference is an escape, and it is in the ALLOW direction.
          const target = resolve(realpathSync(dirname(cur)), readlinkSync(cur));
          if (target !== cur) {
            cur = target;
            continue;
          }
        }
      } catch {
        // lstat (or the parent realpath) failed — `cur` is genuinely absent, or its
        // parent is unresolvable; fall through to the ancestor walk.
      }

      const parent = dirname(cur);
      if (parent === cur) return cur; // reached filesystem root
      cur = parent;
    }
  }
  // Hop budget exhausted. Returning `cur` here would hand back a path that was never
  // canonicalized, and the caller's `startsWith(realRoot)` check would then pass it —
  // fail-open, on input an attacker chooses the depth of. Refuse instead.
  throw new Error(`Path escape blocked: exceeded ${MAX_SYMLINK_HOPS} link/ancestor hops resolving "${p}"`);
}

/**
 * Resolve a user-supplied relative file path against a validated project root and
 * ensure the result stays within that root — by BOTH a lexical check (cheap, blocks
 * `../` traversal) AND a canonical, symlink-resolved check (mcp-security:
 * Symlink-Aware Path Confinement). The canonical check defeats an in-root symlink
 * that points outside the root: confinement is enforced on the real path of the
 * target where it exists, and on the real path of its nearest existing ancestor
 * where it does not (so a not-yet-created write target is confined too).
 */
export function safeJoin(absDir: string, filePath: string): string {
  const resolved = resolve(absDir, filePath);
  if (!resolved.startsWith(absDir + sep) && resolved !== absDir) {
    throw new Error(`Path traversal blocked: "${filePath}" resolves outside project directory`);
  }
  // Canonical (symlink-aware) confinement: compare the target's real location against
  // the root's.
  let realRoot: string;
  try {
    realRoot = realpathSync(absDir);
  } catch (err) {
    // A root that does not exist is a caller error, not an attack — nothing can be
    // inside it, and an embedding host may legitimately pass one (a path it is about
    // to create, or a mocked filesystem). The lexical check above is then the whole
    // answer. Any OTHER failure to resolve the root (EACCES, ELOOP, ENAMETOOLONG) is
    // a condition an attacker can arrange, so it fails closed below.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw new Error(
      `Path escape blocked: project root "${absDir}" could not be canonically resolved (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }

  let realTarget: string;
  try {
    realTarget = realPathOrNearestExisting(resolved);
  } catch (err) {
    // FAIL CLOSED. This used to swallow everything that was not a "Path escape
    // blocked" error and return the lexically-checked path, so a symlink cycle
    // (ELOOP) or an unreadable parent (EACCES) skipped the canonical check entirely
    // and the path was ALLOWED. "We could not verify" is not "it is inside the root".
    if (err instanceof Error && err.message.startsWith('Path escape blocked')) throw err;
    throw new Error(
      `Path escape blocked: "${filePath}" could not be canonically resolved (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new Error(`Path escape blocked: "${filePath}" canonicalizes outside the project directory`);
  }
  return resolved;
}

function sameFile(
  left: Pick<Stats, 'dev' | 'ino'>,
  right: Pick<Stats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Read a repository file through one descriptor and disclose its contents only while
 * that descriptor still names the canonically confined file. The repeated identity
 * check closes the `safeJoin` -> `readFile` swap window for artifact-derived paths:
 * replacing the file or one of its parent directories makes the read fail closed.
 */
export async function readFileConfined(absDir: string, filePath: string, maxBytes?: number): Promise<string> {
  return (await readFileConfinedWithStat(absDir, filePath, maxBytes)).content;
}

export interface ConfinedFileRead {
  content: string;
  /** Metadata captured from the same open descriptor after the read completed. */
  stat: Stats;
}

/**
 * The freshness-aware form of {@link readFileConfined}. Content and metadata come
 * from one descriptor, and neither is returned if that file or its name changes
 * during the read.
 */
export async function readFileConfinedWithStat(
  absDir: string,
  filePath: string,
  maxBytes?: number,
): Promise<ConfinedFileRead> {
  const lexicalPath = safeJoin(absDir, filePath);
  const canonicalRoot = await realpath(absDir);
  const canonicalPath = await realpath(lexicalPath);
  safeJoin(canonicalRoot, canonicalPath);

  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`Confined read requires a regular file: "${filePath}"`);
    if (maxBytes !== undefined && opened.size > maxBytes) {
      throw new Error(`Confined read exceeds byte limit (${maxBytes}): "${filePath}"`);
    }

    const verifyIdentity = async (descriptorStat: Stats): Promise<void> => {
      const currentCanonicalPath = await realpath(canonicalPath);
      safeJoin(canonicalRoot, currentCanonicalPath);
      const current = await stat(currentCanonicalPath);
      if (
        !current.isFile()
        || !sameFile(descriptorStat, current)
        || current.size !== descriptorStat.size
        || current.mtimeMs !== descriptorStat.mtimeMs
        || current.ctimeMs !== descriptorStat.ctimeMs
      ) {
        throw new Error(`Confined read target changed during access: "${filePath}"`);
      }
    };

    await verifyIdentity(opened);
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      !sameFile(opened, afterRead)
      || afterRead.size !== opened.size
      || afterRead.mtimeMs !== opened.mtimeMs
      || afterRead.ctimeMs !== opened.ctimeMs
      || bytes.length !== opened.size
    ) {
      throw new Error(`Confined read target changed during access: "${filePath}"`);
    }
    await verifyIdentity(afterRead);
    return { content: bytes.toString('utf-8'), stat: afterRead };
  } finally {
    await handle.close();
  }
}

/**
 * True when `absPath` stays inside `absRoot` both lexically and canonically.
 *
 * The predicate form of {@link safeJoin}, for the walkers that enumerate paths
 * themselves (a `readdir` of `openspec/specs`) rather than joining a caller's
 * string: they need to DROP an escaping entry and carry on, not abort the walk.
 */
export function isConfinedPath(absRoot: string, absPath: string): boolean {
  try {
    safeJoin(resolve(absRoot), absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the project's openspec directory, confined to the validated root.
 *
 * `config.openspecPath` is read from `.openlore/config.json` — an untrusted on-disk
 * artifact (mcp-security threat model). A poisoned value (`../../etc`, an absolute
 * escape) must not redirect the reads/writes that derive from it (spec/manifest
 * reads, decision ADR reads, decision sync writes) outside the project root. We
 * confine via safeJoin; a value that escapes the root falls back to the default
 * `openspec/` dir — a legitimate in-root path (default or custom) passes through
 * unchanged, so only an escaping value is neutralized.
 */
export function safeOpenspecDir(
  absRoot: string,
  configuredPath: string | undefined,
  onFallback?: (message: string) => void,
): string {
  try {
    return safeJoin(absRoot, configuredPath && configuredPath.length > 0 ? configuredPath : OPENSPEC_DIR);
  } catch {
    // Say so. A monorepo pointing `openspecPath` at `../shared-specs` is a real
    // configuration, and falling back in silence made the decisions gate operate
    // against a nonexistent `./openspec` and write nothing, with no clue why.
    // (Reported through a callback so this module stays a dependency-free leaf.)
    onFallback?.(
      `openspecPath "${configuredPath}" resolves outside the project root — using the default "${OPENSPEC_DIR}" instead.`,
    );
    return safeJoin(absRoot, OPENSPEC_DIR);
  }
}
