/**
 * claude-code adapter — appends the OpenLore instruction block to CLAUDE.md
 * (creating it if absent), registers the OpenLore MCP server in `.mcp.json`
 * (the project-scope file Claude Code actually reads for MCP), and adds a
 * SessionStart hook to `.claude/settings.json`.
 *
 * NB: Claude Code loads MCP servers only from `.mcp.json` (project),
 * `~/.claude.json`, or `claude mcp add` — never from `.claude/settings.json`.
 * Earlier versions wrote `mcpServers.openlore` to `settings.json`, so the
 * server never loaded; `apply` now migrates that stale entry away.
 */

import { mkdir, lstat, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyMarkdownBlock, uninstallMarkdownBlock, hasManagedBlock } from './markdown-block.js';
import { mergeEntries, readMeta, removeManaged, isHandEdited, editJsonPreservingFormat, type JsonPathEdit } from '../json-managed.js';
import { previewCreate, previewDiff } from '../diff.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';
import { LEAN_DEFAULT_PRESET } from '../../../constants.js';
import { formatPlatformCommand, resolvePlatformCommand } from '../../../utils/platform-command.js';
import { confinedAtomicWriteFile, safeJoin } from '../../../utils/path-confinement.js';
import { isGuardedWriteFailure, withGuardedConfigWrite } from '../guarded-config-write.js';

const MD_FILE = 'CLAUDE.md';
const SETTINGS_PATH = '.claude/settings.json';
const SETTINGS_LOCAL_PATH = '.claude/settings.local.json';
const MCP_PATH = '.mcp.json';

/** Where Claude Code reads each managed file, per scope. */
interface ClaudeLayout {
  /** Instruction block file, relative to the scope root. */
  md: string;
  /** File Claude Code actually reads MCP servers from, relative to the scope root. */
  mcp: string;
  /** Hook settings file, relative to the scope root. */
  settings: string;
  /** File carrying the `Bash(openlore:*)` permission, relative to the scope root. */
  permissions: string;
  /**
   * May a file that holds nothing but OpenLore entries be deleted on uninstall?
   * False for the user scope: `~/.claude.json` is Claude Code's own account state,
   * never ours to remove even if our removal happened to empty our view of it.
   */
  mayDeleteMcpFile: boolean;
  /**
   * Same question for the settings file. Also false for the user scope: Claude Code
   * writes `~/.claude/settings.json` itself (as `{}` on a fresh profile), so an
   * `install` → `uninstall` round trip must not delete a file we did not create.
   */
  mayDeleteSettingsFile: boolean;
}

/**
 * User scope mirrors the repo footprint into the files Claude Code reads for
 * EVERY project (change: unify-onboarding-entrypoint):
 *   `~/.claude.json`            — user-scope MCP servers
 *   `~/.claude/settings.json`   — user-scope hooks AND permissions
 *   `~/.claude/CLAUDE.md`       — user-scope instructions
 * Project scope wins over user scope inside Claude Code itself, so a repo that
 * was wired explicitly keeps its own entry.
 */
const LAYOUTS: Record<'repo' | 'user', ClaudeLayout> = {
  repo: {
    md: MD_FILE,
    mcp: MCP_PATH,
    settings: SETTINGS_PATH,
    permissions: SETTINGS_LOCAL_PATH,
    mayDeleteMcpFile: true,
    mayDeleteSettingsFile: true,
  },
  user: {
    md: '.claude/CLAUDE.md',
    mcp: '.claude.json',
    settings: SETTINGS_PATH,
    permissions: SETTINGS_PATH,
    mayDeleteMcpFile: false,
    mayDeleteSettingsFile: false,
  },
};

function layoutFor(ctx: ApplyContext): ClaudeLayout {
  return LAYOUTS[ctx.scope ?? 'repo'];
}

/**
 * Write options for a managed file in this scope.
 *
 * An existing file keeps its own mode (`preserveMode`). A file OpenLore CREATES in
 * the user scope is `0600`, not the umask default: `~/.claude.json` and
 * `~/.claude/settings.json` are where Claude Code keeps account state, it creates
 * them `0600` itself, and `open(O_CREAT)` never lowers the mode of a file that
 * already exists — so whoever creates the file first decides. On a shared host,
 * OpenLore getting there first must not be the reason that state is world-readable
 * (change: unify-onboarding-entrypoint).
 */
function writeOptionsFor(ctx: ApplyContext): { preserveMode: true; mode?: number } {
  return ctx.scope === 'user' ? { preserveMode: true, mode: 0o600 } : { preserveMode: true };
}

/**
 * Publish a managed file, refusing rather than clobbering a concurrent writer.
 *
 * The repo scope keeps the plain last-writer-wins rename: OpenLore is effectively
 * the only writer of `.mcp.json` / `.claude/settings.local.json` during an install.
 * The USER scope does not have that luxury — `~/.claude.json` is rewritten by any
 * running Claude Code, and bare `openlore install` is precisely the command a user
 * runs with their agent open. There, the write is a compare-and-swap against the
 * exact bytes we read: a concurrent write loses nothing, because ours refuses.
 *
 * Returns false when the target moved under us; the caller reports that instead of
 * claiming a write that did not happen (change: unify-onboarding-entrypoint).
 */
async function publishManagedFile(
  ctx: ApplyContext,
  path: string,
  data: string,
  observedRaw: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await mkdir(dirname(path), { recursive: true, ...(ctx.scope === 'user' ? { mode: 0o700 } : {}) });
  const options = writeOptionsFor(ctx);
  if (ctx.scope !== 'user') {
    await confinedAtomicWriteFile(ctx.root, path, data, options);
    return { ok: true };
  }

  // lstat, not stat: the confinement layer checks identity with lstat, and a
  // SYMLINKED target is a confinement problem, not a concurrency one. Diagnosing it
  // as "another process changed it" sent a user whose ~/.claude.json is symlinked
  // into a dotfiles repository into a retry loop that could never succeed.
  let identity: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    identity = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (identity !== null && !identity.isFile()) {
    return { ok: false, reason: 'it is a symbolic link or another non-regular file, which OpenLore will not write through' };
  }
  // A file we never observed cannot be compare-and-swapped against its bytes.
  if ((identity === null) !== (observedRaw === null)) {
    return { ok: false, reason: 'it appeared or vanished between being read and being written' };
  }

  // The compare-and-swap branch of confinedAtomicWriteFile moves the target aside
  // before republishing it, so it REQUIRES the caller to serialize and to leave a
  // recovery journal — otherwise a crash in that window leaves ~/.claude.json
  // missing and nothing ever puts it back. `openlore setup` already had this right;
  // the machinery is now shared (change: unify-onboarding-entrypoint).
  const result = await withGuardedConfigWrite(ctx.root, path, async recoveryJournalPath => {
    try {
      await confinedAtomicWriteFile(ctx.root, path, data, {
        ...options,
        expectedIdentity: identity,
        ...(observedRaw !== null ? { expectedContent: observedRaw } : {}),
        recoveryJournalPath,
      });
      return { ok: true as const };
    } catch (error) {
      if (/Confined write conflict/.test((error as Error).message)) {
        return { ok: false as const, reason: 'another process changed it during this install' };
      }
      throw error;
    }
  });
  if (isGuardedWriteFailure(result)) return { ok: false, reason: result.reason };
  return result;
}

const OPENLORE_PERMISSION = 'Bash(openlore:*)';

/**
 * MCP server registration. Wires `openlore mcp --preset <name>`: the caller's
 * preset when given, else the lean default surface (`LEAN_DEFAULT_PRESET`, the
 * benchmark-cleared substrate core — ADR-0023). The preset is always emitted
 * explicitly so the wired surface is visible in `.mcp.json` and never relies on
 * the bare-command default (change: default-to-lean-tool-surface).
 */
function mcpEntry(
  preset: string | undefined,
  platform: NodeJS.Platform,
  runtime: ApplyContext['platformCommandRuntime'],
): { command: string; args: string[] } {
  return resolvePlatformCommand(
    'npx',
    ['--yes', 'openlore', 'mcp', '--preset', preset ?? LEAN_DEFAULT_PRESET],
    platform,
    runtime,
  );
}

/**
 * Each OpenLore hook group is marked with `_openlore: true` so we can identify
 * (and replace, or remove on uninstall) just our group without touching any
 * other hooks the user may have configured. Claude Code ignores unknown fields
 * on matcher groups.
 *
 * Two groups are wired:
 *   - SessionStart   → whole-repo orientation primer (`orient --json`).
 *   - UserPromptSubmit → task-scoped injection (`orient --inject`), which runs
 *     orient against the submitted prompt and injects a bounded, ignorable
 *     block so the first turn begins already oriented
 *     (change: add-task-scoped-context-injection).
 */
/** The hook keys OpenLore manages, with commands resolved for the generating host. */
function managedHooks(
  platform: NodeJS.Platform,
  runtime: ApplyContext['platformCommandRuntime'],
): ReadonlyArray<{ key: string; command: string }> {
  return [
    {
      key: 'SessionStart',
      command: formatPlatformCommand(resolvePlatformCommand('npx', ['--yes', 'openlore', 'orient', '--json'], platform, runtime)),
    },
    {
      key: 'UserPromptSubmit',
      command: formatPlatformCommand(resolvePlatformCommand('npx', ['--yes', 'openlore', 'orient', '--inject'], platform, runtime)),
    },
  ];
}

function ourHookGroup(command: string): Record<string, unknown> {
  return {
    matcher: '',
    _openlore: true,
    hooks: [{ type: 'command', command }],
  };
}

function isOurHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  return (entry as Record<string, unknown>)._openlore === true;
}

/** Replace our marker-identified group in `existing`, leaving user-authored entries untouched. */
function mergeOurHook(existing: unknown, command: string): unknown[] {
  const arr = Array.isArray(existing) ? existing : [];
  const withoutOurs = arr.filter((e) => !isOurHookEntry(e));
  return [...withoutOurs, ourHookGroup(command)];
}

/** Remove our marker-identified group from `existing`, leaving user-authored entries untouched. */
function stripOurHook(existing: unknown): unknown[] {
  const arr = Array.isArray(existing) ? existing : [];
  return arr.filter((e) => !isOurHookEntry(e));
}

async function readJsonOrEmpty(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Read a file's raw text, or null if it doesn't exist / can't be read. */
async function readRawOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** True when `raw` is a parseable JSON object — i.e. safe for format-preserving path edits. */
function isJsonObjectText(raw: string | null): boolean {
  if (raw == null) return false;
  try {
    const p = JSON.parse(raw);
    return !!p && typeof p === 'object' && !Array.isArray(p);
  } catch {
    return false;
  }
}

/**
 * Refuse to write a file that exists but cannot be read as a JSON object.
 *
 * An unreadable file used to fall through to "treat it as `{}`, then write a fresh
 * pretty-printed document" — which REPLACES it with OpenLore's two keys and nothing
 * else. That is survivable for a repo `.mcp.json`; it is catastrophic for
 * `~/.claude.json`, which holds Claude Code's account state, and it fires on inputs
 * that are not corruption at all: a UTF-8 BOM, a JSONC settings file with comments,
 * an EACCES read, or a file caught mid-rewrite by a running Claude Code.
 *
 * A file we cannot parse is a file we do not understand, so we do not touch it
 * (change: unify-onboarding-entrypoint).
 */
function refusalForUnreadableJson(
  path: string,
  raw: string | null,
  displayName: string,
): PlannedChange | null {
  if (raw == null || isJsonObjectText(raw)) return null;
  return {
    path,
    kind: 'noop',
    summary: `${displayName}: refused to rewrite — it exists but is not readable as JSON (comments, a byte-order mark, or a concurrent write). Nothing was changed.`,
  };
}

/**
 * Serialize the managed update to `path`. When the file already exists with parseable JSON, edit
 * ONLY the managed paths on the original text (preserving the user's formatting); otherwise emit a
 * fresh pretty-printed document. Keeps install merge-not-clobber down to the byte (decision df27e8ef).
 */
function serializeManaged(
  rawOriginal: string | null,
  nextObject: Record<string, unknown>,
  edits: JsonPathEdit[],
): string {
  if (isJsonObjectText(rawOriginal)) {
    try {
      return editJsonPreservingFormat(rawOriginal as string, edits);
    } catch {
      // The format-preserving editor (jsonc-parser `modify`) throws when a managed
      // PARENT path resolves to a non-container — e.g. a hostile `.mcp.json` of
      // `{"mcpServers":"oops"}`: the top level is an object (so isJsonObjectText is
      // true) but `mcpServers` is a string, so `modify([...,'mcpServers','openlore'])`
      // can't index into it. `nextObject` is already the safely-merged result (the
      // in-memory merge coerces non-objects to {}), so fall back to a fresh write
      // rather than crashing mid-install with a partial state.
      return JSON.stringify(nextObject, null, 2) + '\n';
    }
  }
  return JSON.stringify(nextObject, null, 2) + '\n';
}

function valueAt(obj: Record<string, unknown>, segs: string[]): unknown {
  let cur: unknown = obj;
  for (const s of segs) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/**
 * Path edits that remove every OpenLore-managed entry (the meta's `paths` plus the top-level
 * `_openlore` marker) from a parsed JSON doc, pruning any parent object our entry was the sole
 * key of — mirroring `removeManaged`/`deletePath` but as format-preserving text edits.
 */
function managedRemovalEdits(parsed: Record<string, unknown>): JsonPathEdit[] {
  const edits: JsonPathEdit[] = [];
  const meta = readMeta(parsed);
  for (const dotted of meta?.paths ?? []) {
    const segs = dotted.split('.');
    edits.push({ path: [...segs], value: undefined });
    for (let i = segs.length - 1; i >= 1; i--) {
      const parent = valueAt(parsed, segs.slice(0, i));
      if (parent && typeof parent === 'object' && !Array.isArray(parent) && Object.keys(parent).length === 1) {
        edits.push({ path: segs.slice(0, i), value: undefined });
      } else break;
    }
  }
  if ('_openlore' in parsed) edits.push({ path: ['_openlore'], value: undefined });
  return edits;
}

/**
 * The `permissions` object `base` would have once `Bash(openlore:*)` is allowed, or
 * null when it is already there. Shared by the folded user-scope write and the
 * separate repo-scope `settings.local.json` write so both grant the identical thing.
 */
function withOpenLorePermission(
  base: Record<string, unknown>,
): { permissions: Record<string, unknown>; allow: unknown[] } | null {
  const perms = (base.permissions as Record<string, unknown>) ?? {};
  const allow = Array.isArray(perms.allow) ? (perms.allow as unknown[]) : [];
  if (allow.includes(OPENLORE_PERMISSION)) return null;
  const nextAllow = [...allow, OPENLORE_PERMISSION];
  return { permissions: { ...perms, allow: nextAllow }, allow: nextAllow };
}

/**
 * Does this `mcpServers.openlore` entry look like the one OpenLore writes?
 *
 * Deliberately shape-based and conservative: a command plus an argv that names the
 * `openlore` package and its `mcp` subcommand. Used ONLY as an uninstall fallback
 * when the managed-meta marker is gone, so the cost of a false negative is a
 * leftover entry and the cost of a false positive would be deleting a user's own
 * server — hence the narrow test.
 */
function isOurMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args)) return false;
  const flat = args.filter((a): a is string => typeof a === 'string');
  return flat.includes('openlore') && flat.includes('mcp');
}

/** Record a refused write, naming the cause the code actually observed. */
function refusedWrite(
  result: ApplyResult,
  path: string,
  displayName: string,
  reason: string,
): ApplyResult {
  result.changes.push({
    path,
    kind: 'noop',
    summary: `${displayName}: not written — ${reason}`,
  });
  result.warnings.push(
    `${displayName} was not written because ${reason}. OpenLore refused rather than overwrite it. `
    + 'Re-run install once the cause is resolved.',
  );
  result.conflict = true;
  return result;
}

/**
 * Test seam for the compare-and-swap contract.
 *
 * The race it guards — a running Claude Code rewriting `~/.claude.json` between our
 * read and our write — cannot be scheduled deterministically from outside, and a
 * test that races the real scheduler asserts nothing. This exposes the exact
 * question instead: given the bytes we observed, does a publication whose target
 * has since changed refuse, and leave the change intact?
 */
export function _publishManagedFileForTesting(
  ctx: ApplyContext,
  path: string,
  data: string,
  observedRaw: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return publishManagedFile(ctx, path, data, observedRaw);
}

/**
 * Append the managed instruction block, LAST, once every registration this scope
 * needs has actually been written.
 *
 * Order matters for honesty: the block tells an agent to call `orient` and the rest
 * of the tool surface. Written first, a refused MCP registration left a scope whose
 * instructions describe tools nothing wired — the half-wired state the pre-flight
 * exists to prevent, reached through the one refusal a pre-flight cannot predict
 * (change: unify-onboarding-entrypoint).
 */
async function withInstructionBlock(
  ctx: ApplyContext,
  layout: ClaudeLayout,
  result: ApplyResult,
): Promise<ApplyResult> {
  const md = await applyMarkdownBlock(ctx, {
    fileName: layout.md,
    createIfMissing: true,
    blockBody: ctx.instructionTemplate,
  });
  result.changes.push(...md.changes);
  result.warnings.push(...md.warnings);
  if (md.conflict) result.conflict = true;
  return result;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  // Claude Code reads MCP servers, hooks, permissions, and instructions from the
  // user's home as well as the project — so one install can reach every future
  // repository (change: unify-onboarding-entrypoint).
  supportsGlobal: true,
  isConnected: (root) => hasManagedBlock(root, MD_FILE),
  isConnectedUserScope: (userRoot) => hasManagedBlock(userRoot, LAYOUTS.user.md),
  async apply(ctx: ApplyContext): Promise<ApplyResult> {
    const layout = layoutFor(ctx);
    const mcpPath = safeJoin(ctx.root, layout.mcp);
    const settingsPath = safeJoin(ctx.root, layout.settings);
    const localPath = safeJoin(ctx.root, layout.permissions);

    // Pre-flight EVERY managed JSON file before writing anything. A refusal
    // discovered halfway through used to leave the scope half-wired — instructions
    // written, MCP server unregistered — which is worse than not starting
    // (change: unify-onboarding-entrypoint).
    const rawMcpOriginal = await readRawOrNull(mcpPath);
    const rawSettingsOriginal = await readRawOrNull(settingsPath);
    const rawLocalOriginal = localPath === settingsPath
      ? rawSettingsOriginal
      : await readRawOrNull(localPath);
    const preflight = [
      refusalForUnreadableJson(mcpPath, rawMcpOriginal, layout.mcp),
      refusalForUnreadableJson(settingsPath, rawSettingsOriginal, layout.settings),
      ...(localPath === settingsPath
        ? []
        : [refusalForUnreadableJson(localPath, rawLocalOriginal, layout.permissions)]),
    ].filter((refusal): refusal is PlannedChange => refusal !== null);
    if (preflight.length > 0) {
      return {
        changes: preflight,
        warnings: preflight.map(refusal =>
          `${refusal.path} could not be parsed as JSON, so OpenLore left it — and everything else `
          + 'in this scope — untouched. Fix or move the file, then re-run install.'),
        conflict: true,
      };
    }

    // The instruction block is written LAST (below). Written first, a refusal on any
    // JSON file left the scope carrying instructions that tell an agent to call
    // tools no MCP registration had been written for — the half-wired state the
    // pre-flight exists to prevent, reached by the one refusal the pre-flight
    // cannot predict (change: unify-onboarding-entrypoint).
    const mdResult: ApplyResult = { changes: [], warnings: [], conflict: false };

    // --- 1. MCP server registration → .mcp.json (the file Claude Code reads) ---
    const existingMcp = await readJsonOrEmpty(mcpPath);
    const hadMcp = await fileExists(mcpPath);
    const prevMcpMeta = readMeta(existingMcp);
    if (prevMcpMeta && isHandEdited(existingMcp, prevMcpMeta) && !ctx.force) {
      mdResult.changes.push({
        path: mcpPath,
        kind: 'noop',
        summary: `${layout.mcp}: refused to overwrite hand-edited OpenLore entries (use --force)`,
      });
      mdResult.warnings.push(
        `${layout.mcp} has hand-edits in OpenLore-managed paths — pass --force to overwrite`
      );
      mdResult.conflict = true;
      return mdResult;
    }
    const entry = mcpEntry(ctx.preset, ctx.platform, ctx.platformCommandRuntime);
    const { next: nextMcp, action: mcpAction } = mergeEntries(existingMcp, [
      { path: 'mcpServers.openlore', value: entry },
    ]);
    const rawMcp = hadMcp ? rawMcpOriginal : null;
    const mcpBefore = hadMcp ? (rawMcp ?? JSON.stringify(existingMcp, null, 2) + '\n') : '';
    const mcpAfter = serializeManaged(rawMcp, nextMcp, [
      { path: ['mcpServers', 'openlore'], value: entry },
      { path: ['_openlore'], value: (nextMcp as Record<string, unknown>)._openlore },
    ]);
    mdResult.changes.push({
      path: mcpPath,
      kind: !hadMcp ? 'create' : mcpAction === 'noop' ? 'noop' : 'update',
      summary: !hadMcp
        ? `create ${layout.mcp} with mcpServers.openlore`
        : mcpAction === 'noop'
          ? `${layout.mcp}: already up to date`
          : `update mcpServers.openlore in ${layout.mcp}`,
      preview: !hadMcp
        ? previewCreate(mcpPath, mcpAfter)
        : mcpAction === 'noop'
          ? undefined
          : previewDiff(mcpPath, mcpBefore, mcpAfter),
    });
    if (!ctx.dryRun && (mcpAction !== 'noop' || !hadMcp)) {
      const published = await publishManagedFile(ctx, mcpPath, mcpAfter, rawMcpOriginal);
      if (!published.ok) return refusedWrite(mdResult, mcpPath, layout.mcp, published.reason);
    }

    // --- 2. Hooks → .claude/settings.json (marker-identified) ------------------
    // SessionStart (whole-repo primer) + UserPromptSubmit (task-scoped injection).
    const rawSettings = rawSettingsOriginal;
    const had = rawSettings != null;
    const existing = await readJsonOrEmpty(settingsPath);

    // Migrate away the legacy mcpServers.openlore + meta a prior version wrote
    // here (settings.json is never read for MCP). removeManaged strips the
    // managed paths (mcpServers.openlore) and our top-level meta; our hook groups
    // are identified separately by their `_openlore: true` marker, so they survive.
    const migrated = removeManaged(existing);
    const base = migrated.removed ? migrated.next : existing;

    const next = structuredClone(base) as Record<string, unknown>;
    if (!next.hooks || typeof next.hooks !== 'object') next.hooks = {};
    const nextHooks = next.hooks as Record<string, unknown>;

    // Edit only what we manage: drop any legacy meta / mis-placed mcpServers.openlore (settings.json
    // is never read for MCP), and set each marker-identified hook group. Everything else in the
    // user's settings.json is preserved byte-for-byte.
    const settingsEdits: JsonPathEdit[] = [];
    if ('_openlore' in existing) settingsEdits.push({ path: ['_openlore'], value: undefined });
    const legacyMcp = existing.mcpServers as Record<string, unknown> | undefined;
    if (legacyMcp && 'openlore' in legacyMcp) {
      settingsEdits.push(
        Object.keys(legacyMcp).length === 1
          ? { path: ['mcpServers'], value: undefined }
          : { path: ['mcpServers', 'openlore'], value: undefined },
      );
    }
    for (const { key, command } of managedHooks(ctx.platform, ctx.platformCommandRuntime)) {
      const merged = mergeOurHook((base.hooks as Record<string, unknown>)?.[key], command);
      nextHooks[key] = merged;
      settingsEdits.push({ path: ['hooks', key], value: merged });
    }

    // In the user scope the hooks file and the permission file are ONE file. Two
    // sequential read-modify-write passes over the same path worked in a real run
    // (the second re-read what the first wrote) but produced two contradictory
    // `--dry-run` previews of the same file, the second silently dropping the
    // hooks — and dry-run's whole contract is that it describes the real outcome.
    // Fold the permission into this single write instead
    // (change: unify-onboarding-entrypoint).
    const permissionSharesSettingsFile = settingsPath === localPath;
    if (permissionSharesSettingsFile) {
      const merged = withOpenLorePermission(base);
      if (merged) {
        next.permissions = merged.permissions;
        settingsEdits.push({ path: ['permissions', 'allow'], value: merged.allow });
      }
    }

    const changed = JSON.stringify(existing) !== JSON.stringify(next);
    const before = had ? (rawSettings ?? '') : '';
    const after = serializeManaged(rawSettings, next, settingsEdits);
    const change: PlannedChange = {
      path: settingsPath,
      kind: !had ? 'create' : !changed ? 'noop' : 'update',
      summary: !had
        ? `create ${layout.settings} with SessionStart + UserPromptSubmit hooks${permissionSharesSettingsFile ? ` and ${OPENLORE_PERMISSION}` : ''}`
        : !changed
          ? `${layout.settings}: already up to date`
          : `update SessionStart + UserPromptSubmit hooks${permissionSharesSettingsFile ? ` and ${OPENLORE_PERMISSION}` : ''} in ${layout.settings}`,
      preview: !had
        ? previewCreate(settingsPath, after)
        : !changed
          ? undefined
          : previewDiff(settingsPath, before, after),
    };

    if (!ctx.dryRun && changed) {
      const published = await publishManagedFile(ctx, settingsPath, after, rawSettingsOriginal);
      if (!published.ok) return refusedWrite(mdResult, settingsPath, layout.settings, published.reason);
    }

    mdResult.changes.push(change);

    // --- 3. Tool permission → .claude/settings.local.json -----------------------
    // Allow the agent to run the `openlore` CLI without a per-call approval. We
    // append our single sentinel permission string to permissions.allow if absent
    // (idempotent), preserving any permissions the user already configured. Skipped
    // in the user scope, where it was folded into the single settings write above.
    if (permissionSharesSettingsFile) return withInstructionBlock(ctx, layout, mdResult);
    const rawLocal = rawLocalOriginal;
    const hadLocal = rawLocal != null;
    const existingLocal = await readJsonOrEmpty(localPath);
    const perms = (existingLocal.permissions as Record<string, unknown>) ?? {};
    const allow = Array.isArray(perms.allow) ? (perms.allow as unknown[]) : [];
    if (allow.includes(OPENLORE_PERMISSION)) {
      mdResult.changes.push({
        path: localPath,
        kind: 'noop',
        summary: `${layout.permissions}: ${OPENLORE_PERMISSION} already allowed`,
      });
    } else {
      const nextAllow = [...allow, OPENLORE_PERMISSION];
      const nextLocal = { ...existingLocal, permissions: { ...perms, allow: nextAllow } };
      const localAfter = serializeManaged(rawLocal, nextLocal, [
        { path: ['permissions', 'allow'], value: nextAllow },
      ]);
      mdResult.changes.push({
        path: localPath,
        kind: hadLocal ? 'update' : 'create',
        summary: hadLocal
          ? `add ${OPENLORE_PERMISSION} to ${layout.permissions}`
          : `create ${layout.permissions} with ${OPENLORE_PERMISSION}`,
        preview: hadLocal
          ? previewDiff(localPath, rawLocal ?? '', localAfter)
          : previewCreate(localPath, localAfter),
      });
      if (!ctx.dryRun) {
        const published = await publishManagedFile(ctx, localPath, localAfter, rawLocal);
        if (!published.ok) return refusedWrite(mdResult, localPath, layout.permissions, published.reason);
      }
    }

    return withInstructionBlock(ctx, layout, mdResult);
  },

  async uninstall(ctx: ApplyContext): Promise<ApplyResult> {
    const layout = layoutFor(ctx);
    const mcpPath = safeJoin(ctx.root, layout.mcp);
    const settingsPath = safeJoin(ctx.root, layout.settings);
    const localPath = safeJoin(ctx.root, layout.permissions);
    // deleteIfBlockOnly: remove CLAUDE.md when stripping our block empties it
    // (i.e. install created it). A CLAUDE.md with the user's own content is left
    // in place — only the OpenLore block is removed — so this never clobbers user
    // notes; it just avoids leaving a stray empty file behind.
    const md = await uninstallMarkdownBlock(ctx, layout.md, true);

    // Strip mcpServers.openlore from .mcp.json; delete the file if it was ours.
    try {
      const rawMcp = await readFile(mcpPath, 'utf8');
      const parsedMcp = JSON.parse(rawMcp) as Record<string, unknown>;
      let { next, removed } = removeManaged(parsedMcp);
      let removalEdits = managedRemovalEdits(parsedMcp);
      if (!removed && isOurMcpEntry((parsedMcp.mcpServers as Record<string, unknown>)?.openlore)) {
        // The `_openlore` meta is how removal normally identifies our entries — but
        // this file belongs to Claude Code, not to us, and any tool that rewrites it
        // may drop an unrecognized top-level key. Without this fallback the meta's
        // loss would strand `mcpServers.openlore` in EVERY repository, with uninstall
        // reporting nothing (change: unify-onboarding-entrypoint). The entry is only
        // removed when it still looks like the one we write.
        const servers = { ...(parsedMcp.mcpServers as Record<string, unknown>) };
        delete servers.openlore;
        const rest = { ...parsedMcp };
        if (Object.keys(servers).length === 0) delete rest.mcpServers;
        else rest.mcpServers = servers;
        next = rest;
        removed = true;
        removalEdits = [Object.keys(servers).length === 0
          ? { path: ['mcpServers'], value: undefined }
          : { path: ['mcpServers', 'openlore'], value: undefined }];
      }
      if (removed) {
        if (Object.keys(next).length === 0 && layout.mayDeleteMcpFile) {
          if (!ctx.dryRun) await unlink(mcpPath);
          md.changes.push({
            path: mcpPath,
            kind: 'delete',
            summary: `remove ${layout.mcp} (was OpenLore-only)`,
          });
        } else {
          if (!ctx.dryRun) {
            const published = await publishManagedFile(ctx, mcpPath, serializeManaged(rawMcp, next, removalEdits), rawMcp);
            if (!published.ok) return refusedWrite(md, mcpPath, layout.mcp, published.reason);
          }
          md.changes.push({
            path: mcpPath,
            kind: 'update',
            summary: `strip OpenLore entries from ${layout.mcp}`,
          });
        }
      }
    } catch {
      /* no .mcp.json — nothing to do */
    }

    const rawSettings = await readRawOrNull(settingsPath);
    if (rawSettings == null) {
      await stripPermission(ctx, layout, localPath, md);
      return md;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawSettings);
    } catch {
      await stripPermission(ctx, layout, localPath, md);
      return md;
    }
    // Strip our hook entries (SessionStart + UserPromptSubmit, each identified by
    // the `_openlore` marker, not by the managed-paths meta). Build the removal as
    // format-preserving path edits AND mutate a copy to decide noop / file-now-empty,
    // so the user's other settings stay byte-identical.
    let changed = false;
    const removalEdits: JsonPathEdit[] = [];
    const hooksObj = parsed.hooks as Record<string, unknown> | undefined;
    if (hooksObj) {
      for (const { key } of managedHooks(ctx.platform, ctx.platformCommandRuntime)) {
        if (!Array.isArray(hooksObj[key])) continue;
        const original = hooksObj[key] as unknown[];
        const filtered = stripOurHook(original);
        if (filtered.length !== original.length) changed = true;
        if (filtered.length === 0) {
          removalEdits.push({ path: ['hooks', key], value: undefined });
          delete hooksObj[key];
        } else {
          removalEdits.push({ path: ['hooks', key], value: filtered });
          hooksObj[key] = filtered;
        }
      }
      if (Object.keys(hooksObj).length === 0) {
        removalEdits.push({ path: ['hooks'], value: undefined });
        delete parsed.hooks;
      }
    }

    // Also strip any legacy managed entry (mcpServers.openlore + meta) a prior
    // version wrote here before MCP moved to .mcp.json.
    removalEdits.push(...managedRemovalEdits(parsed));
    const { next, removed } = removeManaged(parsed);
    if (removed) changed = true;
    if (!changed) {
      await stripPermission(ctx, layout, localPath, md);
      return md;
    }

    // If file is now empty (only had our entries), delete it.
    const isEmpty = Object.keys(next).length === 0 && layout.mayDeleteSettingsFile;
    if (isEmpty) {
      if (!ctx.dryRun) await unlink(settingsPath);
      md.changes.push({
        path: settingsPath,
        kind: 'delete',
        summary: `remove ${layout.settings} (was OpenLore-only)`,
      });
    } else {
      if (!ctx.dryRun) {
        const published = await publishManagedFile(ctx, settingsPath, serializeManaged(rawSettings, next, removalEdits), rawSettings);
        if (!published.ok) return refusedWrite(md, settingsPath, layout.settings, published.reason);
      }
      md.changes.push({
        path: settingsPath,
        kind: 'update',
        summary: `strip OpenLore entries from ${layout.settings}`,
      });
    }

    await stripPermission(ctx, layout, localPath, md);
    return md;
  },
};

/**
 * Strip `Bash(openlore:*)` from the permission file (mirror of apply step 3).
 *
 * Its own function so it runs on EVERY uninstall path. Inline, it sat behind the
 * hook-settings early returns, so an absent/unchanged settings file left the
 * permission behind — and in the user scope, where the permission and the hooks
 * share one file, that early return would have skipped the second half of the
 * same file's cleanup.
 */
async function stripPermission(
  ctx: ApplyContext,
  layout: ClaudeLayout,
  localPath: string,
  md: ApplyResult,
): Promise<void> {
  const rawLocal = await readRawOrNull(localPath);
  if (rawLocal == null) return;
  let parsedLocal: Record<string, unknown>;
  try {
    parsedLocal = JSON.parse(rawLocal);
  } catch {
    return;
  }
  const permsObj = parsedLocal.permissions as Record<string, unknown> | undefined;
  if (permsObj && Array.isArray(permsObj.allow) && permsObj.allow.includes(OPENLORE_PERMISSION)) {
    const filtered = (permsObj.allow as unknown[]).filter((p) => p !== OPENLORE_PERMISSION);
    const localEdits: JsonPathEdit[] = [];
    if (filtered.length === 0) {
      localEdits.push({ path: ['permissions', 'allow'], value: undefined });
      delete permsObj.allow;
      if (Object.keys(permsObj).length === 0) {
        localEdits.push({ path: ['permissions'], value: undefined });
        delete parsedLocal.permissions;
      }
    } else {
      localEdits.push({ path: ['permissions', 'allow'], value: filtered });
      permsObj.allow = filtered;
    }
    // In the user scope this IS the settings file, which Claude Code writes itself —
    // so the same "not ours to remove" rule applies here as in the hooks pass.
    const mayDeletePermissionFile = layout.permissions === layout.settings
      ? layout.mayDeleteSettingsFile
      : true;
    if (Object.keys(parsedLocal).length === 0 && mayDeletePermissionFile) {
      if (!ctx.dryRun) await unlink(localPath);
      md.changes.push({
        path: localPath,
        kind: 'delete',
        summary: `remove ${layout.permissions} (was OpenLore-only)`,
      });
    } else {
      if (!ctx.dryRun) {
        const published = await publishManagedFile(ctx, localPath, serializeManaged(rawLocal, parsedLocal, localEdits), rawLocal);
        if (!published.ok) {
          refusedWrite(md, localPath, layout.permissions, published.reason);
          return;
        }
      }
      md.changes.push({
        path: localPath,
        kind: 'update',
        summary: `strip ${OPENLORE_PERMISSION} from ${layout.permissions}`,
      });
    }
  }
}

