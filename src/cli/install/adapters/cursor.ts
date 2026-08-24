/**
 * cursor adapter — writes an OpenLore-managed block to `.cursorrules`, a
 * companion `.cursor/rules/openlore.mdc` file describing the orient() workflow,
 * and registers the OpenLore MCP server in `.cursor/mcp.json`.
 */

import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMarkdownBlock, uninstallMarkdownBlock, hasManagedBlock } from './markdown-block.js';
import { fingerprint } from '../block.js';
import { mergeEntries, readMeta, removeManaged, isHandEdited } from '../json-managed.js';
import { previewCreate, previewDiff } from '../diff.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';
import { LEAN_DEFAULT_PRESET } from '../../../constants.js';
import { resolvePlatformCommand } from '../../../utils/platform-command.js';
import { confinedAtomicWriteFile, safeJoin } from '../../../utils/path-confinement.js';

const RULES_FILE = '.cursorrules';
const MDC_FILE = '.cursor/rules/openlore.mdc';
const MCP_FILE = '.cursor/mcp.json';

/**
 * MCP server registration. Wires `openlore mcp --preset <name>`: the caller's
 * preset when given, else the lean default surface (the benchmark-winning
 * navigation core). The preset is always emitted explicitly so the wired surface
 * is visible in the config and never relies on the bare-command default
 * (change: default-to-lean-tool-surface).
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

async function loadMdcTemplate(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // adapters/ → ../templates/cursor-openlore.mdc (dist + tsx run share this layout)
    join(here, '..', 'templates', 'cursor-openlore.mdc'),
    // tsx fallback if for any reason we're not co-located with templates
    join(here, '..', '..', '..', '..', 'src', 'cli', 'install', 'templates', 'cursor-openlore.mdc'),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error('cursor adapter: could not locate cursor-openlore.mdc template');
}

async function renderMdc(instructions: string): Promise<string> {
  const tmpl = await loadMdcTemplate();
  return tmpl
    .replace('{{fingerprint}}', fingerprint(instructions.trimEnd()))
    .replace('{{instructions}}', instructions.trimEnd());
}

export const cursorAdapter: Adapter = {
  name: 'cursor',
  isConnected: (root) => hasManagedBlock(root, RULES_FILE),
  async apply(ctx: ApplyContext): Promise<ApplyResult> {
    const mdcPath = safeJoin(ctx.root, MDC_FILE);
    const mcpPath = safeJoin(ctx.root, MCP_FILE);
    const rulesResult = await applyMarkdownBlock(ctx, {
      fileName: RULES_FILE,
      createIfMissing: true,
      blockBody: ctx.instructionTemplate,
    });

    const desired = await renderMdc(ctx.instructionTemplate);
    let existing: string | null;
    try {
      existing = await readFile(mdcPath, 'utf8');
    } catch {
      existing = null;
    }

    // The .mdc body is independent of --preset, so it is often unchanged on a
    // re-install that only switches the tool preset. Earlier this short-circuited
    // with `return`, which SKIPPED the .cursor/mcp.json registration below and
    // froze the wired preset (a re-install with a new --preset was silently
    // ignored). Record the .mdc outcome but always fall through to MCP wiring so a
    // preset switch takes effect (change: default-to-lean-tool-surface).
    const mdcUnchanged = existing === desired;
    const isOurs =
      existing === null ||
      /^openlore-fingerprint:/m.test(existing);

    if (!mdcUnchanged && existing !== null && !isOurs && !ctx.force) {
      rulesResult.changes.push({
        path: mdcPath,
        kind: 'noop',
        summary: `${MDC_FILE}: refused to overwrite non-OpenLore file (use --force)`,
      });
      rulesResult.warnings.push(`${MDC_FILE} exists but was not written by OpenLore`);
      rulesResult.conflict = true;
      return rulesResult;
    }

    if (mdcUnchanged) {
      rulesResult.changes.push({
        path: mdcPath,
        kind: 'noop',
        summary: `${MDC_FILE}: already up to date`,
      });
    } else {
      const change: PlannedChange = {
        path: mdcPath,
        kind: existing === null ? 'create' : 'update',
        summary: existing === null ? `create ${MDC_FILE}` : `update ${MDC_FILE}`,
        preview:
          existing === null
            ? previewCreate(mdcPath, desired)
            : previewDiff(mdcPath, existing, desired),
      };
      if (!ctx.dryRun) {
        await mkdir(dirname(mdcPath), { recursive: true });
        await confinedAtomicWriteFile(ctx.root, mdcPath, desired, { preserveMode: true });
      }
      rulesResult.changes.push(change);
    }

    // MCP server registration via .cursor/mcp.json (standard Cursor path).
    let mcpExisting: Record<string, unknown> = {};
    let mcpHad = true;
    try {
      const parsed = JSON.parse(await readFile(mcpPath, 'utf8'));
      mcpExisting =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      mcpHad = false;
    }
    const mcpMeta = readMeta(mcpExisting);
    if (mcpMeta && isHandEdited(mcpExisting, mcpMeta) && !ctx.force) {
      rulesResult.changes.push({
        path: mcpPath,
        kind: 'noop',
        summary: `${MCP_FILE}: refused to overwrite hand-edited OpenLore entries (use --force)`,
      });
      rulesResult.warnings.push(
        `${MCP_FILE} has hand-edits in OpenLore-managed paths — pass --force to overwrite`
      );
      rulesResult.conflict = true;
      return rulesResult;
    }
    const { next: nextMcp, action: mcpAction } = mergeEntries(mcpExisting, [
      { path: 'mcpServers.openlore', value: mcpEntry(ctx.preset, ctx.platform, ctx.platformCommandRuntime) },
    ]);
    const beforeMcp = mcpHad ? JSON.stringify(mcpExisting, null, 2) + '\n' : '';
    const afterMcp = JSON.stringify(nextMcp, null, 2) + '\n';
    rulesResult.changes.push({
      path: mcpPath,
      kind: !mcpHad ? 'create' : mcpAction === 'noop' ? 'noop' : 'update',
      summary: !mcpHad
        ? `create ${MCP_FILE} with mcpServers.openlore`
        : mcpAction === 'noop'
          ? `${MCP_FILE}: already up to date`
          : `update mcpServers.openlore in ${MCP_FILE}`,
      preview: !mcpHad
        ? previewCreate(mcpPath, afterMcp)
        : mcpAction === 'noop'
          ? undefined
          : previewDiff(mcpPath, beforeMcp, afterMcp),
    });
    if (!ctx.dryRun && (mcpAction !== 'noop' || !mcpHad)) {
      await mkdir(dirname(mcpPath), { recursive: true });
      await confinedAtomicWriteFile(ctx.root, mcpPath, JSON.stringify(nextMcp, null, 2) + '\n', { preserveMode: true });
    }
    return rulesResult;
  },

  async uninstall(ctx: ApplyContext): Promise<ApplyResult> {
    const mdcPath = safeJoin(ctx.root, MDC_FILE);
    const mcpPath = safeJoin(ctx.root, MCP_FILE);
    const rules = await uninstallMarkdownBlock(ctx, RULES_FILE, true);
    try {
      const raw = await readFile(mdcPath, 'utf8');
      if (/^openlore-fingerprint:/m.test(raw)) {
        if (!ctx.dryRun) await unlink(mdcPath);
        rules.changes.push({
          path: mdcPath,
          kind: 'delete',
          summary: `remove ${MDC_FILE}`,
        });
      }
    } catch {
      /* not present, nothing to do */
    }

    // Strip our MCP entry from .cursor/mcp.json.
    try {
      const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as Record<string, unknown>;
      const { next, removed } = removeManaged(parsed);
      if (removed) {
        const isEmpty = Object.keys(next).length === 0;
        if (isEmpty) {
          if (!ctx.dryRun) await unlink(mcpPath);
          rules.changes.push({
            path: mcpPath,
            kind: 'delete',
            summary: `remove ${MCP_FILE} (was OpenLore-only)`,
          });
        } else {
          if (!ctx.dryRun) await confinedAtomicWriteFile(ctx.root, mcpPath, JSON.stringify(next, null, 2) + '\n', { preserveMode: true });
          rules.changes.push({
            path: mcpPath,
            kind: 'update',
            summary: `strip OpenLore entries from ${MCP_FILE}`,
          });
        }
      }
    } catch {
      /* not present, nothing to do */
    }
    return rules;
  },
};
