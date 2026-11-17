/**
 * Which scopes OpenLore is wired in (change: upgrade-repo-only-wiring).
 *
 * User-scope wiring is what makes "install once, every repository just works" true. A
 * user who installed before it shipped has only repo wiring, and nothing told them: an
 * untracked `.mcp.json` does not reach the repository's other worktrees, and a new
 * repository gets nothing at all. `doctor`, `update` and `status` read this one answer.
 *
 * Read-only by construction: it reads two repository files and `~/.claude.json`, and
 * writes nothing. Only an explicit, human-run command writes the user scope.
 */

import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, win32 } from 'node:path';
import { openloreCliEntry } from '../../utils/platform-command.js';

/**
 * `user + repo` also covers a repository with no wiring of its own: the user-scope entry
 * reaches it, which is the point of that scope.
 */
export type WiringScope = 'user + repo' | 'repo only' | 'none';

export interface WiringAssessment {
  scope: WiringScope;
  /** Repository files that carry OpenLore's managed `_openlore` marker. */
  repoFiles: string[];
  /** `~/.claude.json` registers an `openlore` MCP server. */
  userEntry: boolean;
  /** Why the user-scope entry is an older shape, or null when it is current (or absent). */
  userOutdated: 'npx' | 'missing-launcher' | null;
  /** Absolute launcher paths the user-scope entry names that are gone. */
  missingLaunchers: string[];
}

/** Repository files OpenLore writes with its `_openlore` marker. */
const REPO_WIRING_FILES = ['.mcp.json', '.claude/settings.json'] as const;

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The managed-paths meta (`.mcp.json`), or a hook group marked `_openlore: true` (settings). */
function hasManagedMarker(doc: Record<string, unknown>): boolean {
  if (doc._openlore !== undefined) return true;
  const hooks = doc.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  return Object.values(hooks as Record<string, unknown>).some(groups =>
    Array.isArray(groups)
    && groups.some(group => !!group && typeof group === 'object' && (group as Record<string, unknown>)._openlore === true));
}

/**
 * Absolute paths in the wired MCP entry that are no longer on disk.
 *
 * Only ABSOLUTE paths are checked: a bare command (`npx`, `node`) is resolved through
 * PATH by the host, so its absence here would say nothing. Empty means nothing to report,
 * which is also the answer for a malformed entry — doctor reports what it observed, and
 * this check cannot see anything wrong with a shape it does not recognise.
 */
export async function missingLauncherPaths(servers: Record<string, unknown> | undefined): Promise<string[]> {
  const entry = servers?.openlore as { command?: unknown; args?: unknown } | undefined;
  if (!entry) return [];
  const candidates = [entry.command, Array.isArray(entry.args) ? entry.args[0] : undefined]
    .filter((v): v is string => typeof v === 'string' && (isAbsolute(v) || win32.isAbsolute(v)));
  const missing: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.F_OK);
    } catch {
      missing.push(candidate);
    }
  }
  return missing;
}

/** Does the entry launch through `npx` (directly, or as an argument of a Windows shim)? */
function launchesThroughNpx(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  const tokens = [command, ...(Array.isArray(args) ? args : [])].filter((v): v is string => typeof v === 'string');
  return tokens.some(token => /^npx(\.cmd|\.exe)?$/i.test(win32.basename(token)));
}

/**
 * Assess both scopes.
 *
 * `currentEntry` is the CLI entry this install would wire. When it is null this install
 * itself writes the `npx` form (run from source, or out of an npx cache), so an `npx`
 * entry is current, not outdated — otherwise `doctor --fix` would rewrite it to the same
 * shape and warn again forever.
 */
export async function assessWiring(
  rootPath: string,
  home: string,
  currentEntry: string | null = openloreCliEntry(),
): Promise<WiringAssessment> {
  const repoFiles: string[] = [];
  for (const rel of REPO_WIRING_FILES) {
    const doc = await readJsonObject(join(rootPath, rel));
    if (doc && hasManagedMarker(doc)) repoFiles.push(rel);
  }

  const servers = (await readJsonObject(join(home, '.claude.json')))?.mcpServers as Record<string, unknown> | undefined;
  const userEntry = !!servers?.openlore;
  const missingLaunchers = await missingLauncherPaths(servers);
  const userOutdated = missingLaunchers.length > 0
    ? 'missing-launcher'
    : userEntry && currentEntry !== null && launchesThroughNpx(servers?.openlore)
      ? 'npx'
      : null;

  const scope: WiringScope = userEntry ? 'user + repo' : repoFiles.length > 0 ? 'repo only' : 'none';
  return { scope, repoFiles, userEntry, userOutdated, missingLaunchers };
}
