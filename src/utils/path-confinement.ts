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

import { realpathSync, lstatSync, readlinkSync } from 'node:fs';
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
          const target = resolve(dirname(cur), readlinkSync(cur));
          if (target !== cur) {
            cur = target;
            continue;
          }
        }
      } catch {
        // lstat failed too — `cur` really is absent; fall through to the ancestor.
      }

      const parent = dirname(cur);
      if (parent === cur) return cur; // reached filesystem root
      cur = parent;
    }
  }
  return cur;
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
  // Canonical (symlink-aware) confinement. realpath the root (it exists — it was
  // validated) and the target's real location; reject if the real target escapes.
  try {
    const realRoot = realpathSync(absDir);
    const realTarget = realPathOrNearestExisting(resolved);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new Error(`Path escape blocked: "${filePath}" canonicalizes outside the project directory`);
    }
  } catch (err) {
    // A "Path escape blocked" error must propagate; only swallow realpath I/O errors
    // on the root itself (which would be unexpected for a validated root).
    if (err instanceof Error && err.message.startsWith('Path escape blocked')) throw err;
  }
  return resolved;
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
