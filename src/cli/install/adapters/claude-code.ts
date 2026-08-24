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

import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyMarkdownBlock, uninstallMarkdownBlock, hasManagedBlock } from './markdown-block.js';
import { mergeEntries, readMeta, removeManaged, isHandEdited, editJsonPreservingFormat, type JsonPathEdit } from '../json-managed.js';
import { previewCreate, previewDiff } from '../diff.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';
import { LEAN_DEFAULT_PRESET } from '../../../constants.js';
import { formatPlatformCommand, resolvePlatformCommand } from '../../../utils/platform-command.js';
import { confinedAtomicWriteFile, safeJoin } from '../../../utils/path-confinement.js';

const MD_FILE = 'CLAUDE.md';
const SETTINGS_PATH = '.claude/settings.json';
const SETTINGS_LOCAL_PATH = '.claude/settings.local.json';
const MCP_PATH = '.mcp.json';

/** Permission that lets the agent run the `openlore` CLI without a per-call prompt. */
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
  isConnected: (root) => hasManagedBlock(root, MD_FILE),
  async apply(ctx: ApplyContext): Promise<ApplyResult> {
    const mcpPath = safeJoin(ctx.root, MCP_PATH);
    const settingsPath = safeJoin(ctx.root, SETTINGS_PATH);
    const localPath = safeJoin(ctx.root, SETTINGS_LOCAL_PATH);
    const mdResult = await applyMarkdownBlock(ctx, {
      fileName: MD_FILE,
      createIfMissing: true,
      blockBody: ctx.instructionTemplate,
    });

    // --- 1. MCP server registration → .mcp.json (the file Claude Code reads) ---
    const existingMcp = await readJsonOrEmpty(mcpPath);
    const hadMcp = await fileExists(mcpPath);
    const prevMcpMeta = readMeta(existingMcp);
    if (prevMcpMeta && isHandEdited(existingMcp, prevMcpMeta) && !ctx.force) {
      mdResult.changes.push({
        path: mcpPath,
        kind: 'noop',
        summary: `${MCP_PATH}: refused to overwrite hand-edited OpenLore entries (use --force)`,
      });
      mdResult.warnings.push(
        `${MCP_PATH} has hand-edits in OpenLore-managed paths — pass --force to overwrite`
      );
      mdResult.conflict = true;
      return mdResult;
    }
    const entry = mcpEntry(ctx.preset, ctx.platform, ctx.platformCommandRuntime);
    const { next: nextMcp, action: mcpAction } = mergeEntries(existingMcp, [
      { path: 'mcpServers.openlore', value: entry },
    ]);
    const rawMcp = hadMcp ? await readRawOrNull(mcpPath) : null;
    const mcpBefore = hadMcp ? (rawMcp ?? JSON.stringify(existingMcp, null, 2) + '\n') : '';
    const mcpAfter = serializeManaged(rawMcp, nextMcp, [
      { path: ['mcpServers', 'openlore'], value: entry },
      { path: ['_openlore'], value: (nextMcp as Record<string, unknown>)._openlore },
    ]);
    mdResult.changes.push({
      path: mcpPath,
      kind: !hadMcp ? 'create' : mcpAction === 'noop' ? 'noop' : 'update',
      summary: !hadMcp
        ? `create ${MCP_PATH} with mcpServers.openlore`
        : mcpAction === 'noop'
          ? `${MCP_PATH}: already up to date`
          : `update mcpServers.openlore in ${MCP_PATH}`,
      preview: !hadMcp
        ? previewCreate(mcpPath, mcpAfter)
        : mcpAction === 'noop'
          ? undefined
          : previewDiff(mcpPath, mcpBefore, mcpAfter),
    });
    if (!ctx.dryRun && (mcpAction !== 'noop' || !hadMcp)) {
      await mkdir(dirname(mcpPath), { recursive: true });
      await confinedAtomicWriteFile(ctx.root, mcpPath, mcpAfter, { preserveMode: true });
    }

    // --- 2. Hooks → .claude/settings.json (marker-identified) ------------------
    // SessionStart (whole-repo primer) + UserPromptSubmit (task-scoped injection).
    const rawSettings = await readRawOrNull(settingsPath);
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

    const changed = JSON.stringify(existing) !== JSON.stringify(next);
    const before = had ? (rawSettings ?? '') : '';
    const after = serializeManaged(rawSettings, next, settingsEdits);
    const change: PlannedChange = {
      path: settingsPath,
      kind: !had ? 'create' : !changed ? 'noop' : 'update',
      summary: !had
        ? `create ${SETTINGS_PATH} with SessionStart + UserPromptSubmit hooks`
        : !changed
          ? `${SETTINGS_PATH}: already up to date`
          : `update SessionStart + UserPromptSubmit hooks in ${SETTINGS_PATH}`,
      preview: !had
        ? previewCreate(settingsPath, after)
        : !changed
          ? undefined
          : previewDiff(settingsPath, before, after),
    };

    if (!ctx.dryRun && changed) {
      await mkdir(dirname(settingsPath), { recursive: true });
      await confinedAtomicWriteFile(ctx.root, settingsPath, after, { preserveMode: true });
    }

    mdResult.changes.push(change);

    // --- 3. Tool permission → .claude/settings.local.json -----------------------
    // Allow the agent to run the `openlore` CLI without a per-call approval. We
    // append our single sentinel permission string to permissions.allow if absent
    // (idempotent), preserving any permissions the user already configured.
    const rawLocal = await readRawOrNull(localPath);
    const hadLocal = rawLocal != null;
    const existingLocal = await readJsonOrEmpty(localPath);
    const perms = (existingLocal.permissions as Record<string, unknown>) ?? {};
    const allow = Array.isArray(perms.allow) ? (perms.allow as unknown[]) : [];
    if (allow.includes(OPENLORE_PERMISSION)) {
      mdResult.changes.push({
        path: localPath,
        kind: 'noop',
        summary: `${SETTINGS_LOCAL_PATH}: ${OPENLORE_PERMISSION} already allowed`,
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
          ? `add ${OPENLORE_PERMISSION} to ${SETTINGS_LOCAL_PATH}`
          : `create ${SETTINGS_LOCAL_PATH} with ${OPENLORE_PERMISSION}`,
        preview: hadLocal
          ? previewDiff(localPath, rawLocal ?? '', localAfter)
          : previewCreate(localPath, localAfter),
      });
      if (!ctx.dryRun) {
        await mkdir(dirname(localPath), { recursive: true });
        await confinedAtomicWriteFile(ctx.root, localPath, localAfter, { preserveMode: true });
      }
    }

    return mdResult;
  },

  async uninstall(ctx: ApplyContext): Promise<ApplyResult> {
    const mcpPath = safeJoin(ctx.root, MCP_PATH);
    const settingsPath = safeJoin(ctx.root, SETTINGS_PATH);
    const localPath = safeJoin(ctx.root, SETTINGS_LOCAL_PATH);
    // deleteIfBlockOnly: remove CLAUDE.md when stripping our block empties it
    // (i.e. install created it). A CLAUDE.md with the user's own content is left
    // in place — only the OpenLore block is removed — so this never clobbers user
    // notes; it just avoids leaving a stray empty file behind.
    const md = await uninstallMarkdownBlock(ctx, MD_FILE, true);

    // Strip mcpServers.openlore from .mcp.json; delete the file if it was ours.
    try {
      const rawMcp = await readFile(mcpPath, 'utf8');
      const parsedMcp = JSON.parse(rawMcp) as Record<string, unknown>;
      const { next, removed } = removeManaged(parsedMcp);
      if (removed) {
        if (Object.keys(next).length === 0) {
          if (!ctx.dryRun) await unlink(mcpPath);
          md.changes.push({
            path: mcpPath,
            kind: 'delete',
            summary: `remove ${MCP_PATH} (was OpenLore-only)`,
          });
        } else {
          if (!ctx.dryRun) await confinedAtomicWriteFile(ctx.root, mcpPath, serializeManaged(rawMcp, next, managedRemovalEdits(parsedMcp)), { preserveMode: true });
          md.changes.push({
            path: mcpPath,
            kind: 'update',
            summary: `strip OpenLore entries from ${MCP_PATH}`,
          });
        }
      }
    } catch {
      /* no .mcp.json — nothing to do */
    }

    const rawSettings = await readRawOrNull(settingsPath);
    if (rawSettings == null) return md;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawSettings);
    } catch {
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
    if (!changed) return md;

    // If file is now empty (only had our entries), delete it.
    const isEmpty = Object.keys(next).length === 0;
    if (isEmpty) {
      if (!ctx.dryRun) await unlink(settingsPath);
      md.changes.push({
        path: settingsPath,
        kind: 'delete',
        summary: `remove ${SETTINGS_PATH} (was OpenLore-only)`,
      });
    } else {
      if (!ctx.dryRun) await confinedAtomicWriteFile(ctx.root, settingsPath, serializeManaged(rawSettings, next, removalEdits), { preserveMode: true });
      md.changes.push({
        path: settingsPath,
        kind: 'update',
        summary: `strip OpenLore entries from ${SETTINGS_PATH}`,
      });
    }

    // Strip our permission from .claude/settings.local.json (mirror of apply step 3).
    const rawLocal = await readRawOrNull(localPath);
    if (rawLocal != null) {
      let parsedLocal: Record<string, unknown>;
      try {
        parsedLocal = JSON.parse(rawLocal);
      } catch {
        return md;
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
        if (Object.keys(parsedLocal).length === 0) {
          if (!ctx.dryRun) await unlink(localPath);
          md.changes.push({
            path: localPath,
            kind: 'delete',
            summary: `remove ${SETTINGS_LOCAL_PATH} (was OpenLore-only)`,
          });
        } else {
          if (!ctx.dryRun) await confinedAtomicWriteFile(ctx.root, localPath, serializeManaged(rawLocal, parsedLocal, localEdits), { preserveMode: true });
          md.changes.push({
            path: localPath,
            kind: 'update',
            summary: `strip ${OPENLORE_PERMISSION} from ${SETTINGS_LOCAL_PATH}`,
          });
        }
      }
    }
    return md;
  },
};
