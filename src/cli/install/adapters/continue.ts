/**
 * continue adapter — adds an "/orient" slash command entry to
 * `.continue/config.json`. The Continue config schema accepts a top-level
 * `slashCommands` array; we add (or replace) an entry whose `name === 'orient'`.
 *
 * Continue's MCP integration path differs across recent versions; rather than
 * guess and silently write to the wrong key, we leave a TODO and warn the user
 * (per spec-01 "do not guess" rule). MCP server registration for Continue is
 * gated behind a follow-up TODO.
 */

import { readFile, unlink } from 'node:fs/promises';
import { mergeEntries, readMeta, removeManaged, isHandEdited } from '../json-managed.js';
import { previewCreate, previewDiff } from '../diff.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';
import { formatPlatformCommand, resolveOpenloreCommand } from '../../../utils/platform-command.js';
import { confinedAtomicWriteFile, safeJoin } from '../../../utils/path-confinement.js';

const CONFIG_PATH = '.continue/config.json';

function slashCommand(
  platform: NodeJS.Platform,
  runtime: ApplyContext['platformCommandRuntime'],
): Record<string, string> {
  return {
    name: 'orient',
    description: 'Call openlore orient() for the current task context',
    run: formatPlatformCommand(resolveOpenloreCommand(['orient', '--json'], platform, runtime), platform),
  };
}

export const continueAdapter: Adapter = {
  name: 'continue',
  async isConnected(root: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(safeJoin(root, CONFIG_PATH), 'utf8')) as Record<string, unknown>;
      return readMeta(parsed) !== null;
    } catch {
      return false;
    }
  },
  async apply(ctx: ApplyContext): Promise<ApplyResult> {
    const configPath = safeJoin(ctx.root, CONFIG_PATH);
    let had = true;
    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
      had = false;
    }

    const prevMeta = readMeta(existing);
    if (prevMeta && isHandEdited(existing, prevMeta) && !ctx.force) {
      return {
        changes: [
          {
            path: configPath,
            kind: 'noop',
            summary: `${CONFIG_PATH}: refused to overwrite hand-edited OpenLore entries (use --force)`,
          },
        ],
        warnings: [`${CONFIG_PATH} has hand-edits in OpenLore-managed paths — pass --force to overwrite`],
        conflict: true,
      };
    }

    // Preserve any non-OpenLore slashCommands already present.
    const existingSlash = Array.isArray(existing.slashCommands) ? existing.slashCommands : [];
    const otherSlash = (existingSlash as Array<Record<string, unknown>>).filter(
      (c) => c?.name !== 'orient'
    );
    const nextSlash = [...otherSlash, slashCommand(ctx.platform, ctx.platformCommandRuntime)];

    const { next, action } = mergeEntries(existing, [
      { path: 'slashCommands', value: nextSlash },
    ]);

    const before = had ? JSON.stringify(existing, null, 2) + '\n' : '';
    const after = JSON.stringify(next, null, 2) + '\n';
    const change: PlannedChange = {
      path: configPath,
      kind: !had ? 'create' : action === 'noop' ? 'noop' : 'update',
      summary: !had
        ? `create ${CONFIG_PATH} with /orient slash command`
        : action === 'noop'
          ? `${CONFIG_PATH}: already up to date`
          : `add /orient slash command to ${CONFIG_PATH}`,
      preview: !had
        ? previewCreate(configPath, after)
        : action === 'noop'
          ? undefined
          : previewDiff(configPath, before, after),
    };

    const warnings = [
      // TODO(openlore-spec-01): verify Continue MCP server registration path; not written here.
      'continue: MCP server registration is not yet wired (path varies by Continue version) — slash command only',
    ];

    if (!ctx.dryRun && (action !== 'noop' || !had)) {
      await confinedAtomicWriteFile(ctx.root, configPath, JSON.stringify(next, null, 2) + '\n', { preserveMode: true });
    }

    return { changes: [change], warnings, conflict: false };
  },

  async uninstall(ctx: ApplyContext): Promise<ApplyResult> {
    const configPath = safeJoin(ctx.root, CONFIG_PATH);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      return { changes: [], warnings: [], conflict: false };
    }
    const beforeSlash = Array.isArray(parsed.slashCommands) ? parsed.slashCommands : [];
    const filteredSlash = (beforeSlash as Array<Record<string, unknown>>).filter(
      (c) => c?.name !== 'orient'
    );
    if (filteredSlash.length === beforeSlash.length && !readMeta(parsed)) {
      return { changes: [], warnings: [], conflict: false };
    }
    parsed.slashCommands = filteredSlash;
    const { next } = removeManaged(parsed);
    if (Array.isArray(next.slashCommands) && (next.slashCommands as unknown[]).length === 0) {
      delete next.slashCommands;
    }
    const isEmpty = Object.keys(next).length === 0;
    if (isEmpty) {
      if (!ctx.dryRun) await unlink(configPath);
      return {
        changes: [{ path: configPath, kind: 'delete', summary: `remove ${CONFIG_PATH} (was OpenLore-only)` }],
        warnings: [],
        conflict: false,
      };
    }
    if (!ctx.dryRun) await confinedAtomicWriteFile(ctx.root, configPath, JSON.stringify(next, null, 2) + '\n', { preserveMode: true });
    return {
      changes: [{ path: configPath, kind: 'update', summary: `strip OpenLore entries from ${CONFIG_PATH}` }],
      warnings: [],
      conflict: false,
    };
  },
};
