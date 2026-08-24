/**
 * Shared helper for adapters that append/update a managed markdown block in
 * a single file at the project root (CLAUDE.md, AGENTS.md, .cursorrules,
 * .clinerules). Centralises the read/upsert/write logic so each adapter is
 * just a one-liner.
 */

import { readFile, unlink } from 'node:fs/promises';
import { confinedAtomicWriteFile, safeJoin } from '../../../utils/path-confinement.js';
import {
  upsertBlock,
  extractBlock,
  isHandEdited,
  removeBlock,
  renderBlock,
} from '../block.js';

/**
 * True when `fileName` (relative to `root`) exists and contains an OpenLore-managed
 * markdown block. Preset-insensitive presence check used by `connect list`.
 */
export async function hasManagedBlock(root: string, fileName: string): Promise<boolean> {
  try {
    const content = await readFile(safeJoin(root, fileName), 'utf8');
    return extractBlock(content) !== null;
  } catch {
    return false;
  }
}
import { previewCreate, previewDiff } from '../diff.js';
import type { ApplyContext, ApplyResult, PlannedChange } from './types.js';

export interface MarkdownBlockOptions {
  /** File name, relative to ctx.root. */
  fileName: string;
  /** Whether the file should be created if it doesn't yet exist. */
  createIfMissing: boolean;
  /** Optional adapter-specific prefix added above the template (e.g. heading). */
  blockBody: string;
}

export async function applyMarkdownBlock(
  ctx: ApplyContext,
  opts: MarkdownBlockOptions
): Promise<ApplyResult> {
  const filePath = safeJoin(ctx.root, opts.fileName);
  const warnings: string[] = [];
  let existing: string | null;
  try {
    existing = await readFile(filePath, 'utf8');
  } catch {
    existing = null;
  }

  if (existing === null && !opts.createIfMissing) {
    return { changes: [], warnings, conflict: false };
  }

  const base = existing ?? '';
  const block = existing ? extractBlock(existing) : null;
  const handEdited = block ? isHandEdited(block) : false;
  if (handEdited && !ctx.force) {
    return {
      changes: [
        {
          path: filePath,
          kind: 'noop',
          summary: `${opts.fileName}: refused to overwrite hand-edited OpenLore block (use --force)`,
        },
      ],
      warnings: [`${opts.fileName} has hand-edits inside the OpenLore block — pass --force to overwrite`],
      conflict: true,
    };
  }

  let next: string;
  let action: 'created' | 'updated' | 'noop';
  if (handEdited && ctx.force && block) {
    // Force-overwrite a tampered block regardless of fingerprint match.
    const rendered = renderBlock(opts.blockBody);
    next = base.slice(0, block.beginIndex) + rendered + base.slice(block.endIndex);
    action = 'updated';
  } else {
    ({ next, action } = upsertBlock(base, opts.blockBody));
  }

  const change: PlannedChange = {
    path: filePath,
    kind:
      existing === null
        ? 'create'
        : action === 'noop'
          ? 'noop'
          : 'update',
    summary:
      existing === null
        ? `create ${opts.fileName} with OpenLore block`
        : action === 'noop'
          ? `${opts.fileName}: already up to date`
          : `update OpenLore block in ${opts.fileName}`,
    preview:
      existing === null
        ? previewCreate(filePath, next)
        : action === 'noop'
          ? undefined
          : previewDiff(filePath, base, next),
  };

  if (!ctx.dryRun && action !== 'noop') {
    await confinedAtomicWriteFile(ctx.root, filePath, next, { preserveMode: true });
  }

  return { changes: [change], warnings, conflict: false };
}

export async function uninstallMarkdownBlock(
  ctx: ApplyContext,
  fileName: string,
  /** If true, delete the file when removing the block empties it. */
  deleteIfBlockOnly: boolean
): Promise<ApplyResult> {
  const filePath = safeJoin(ctx.root, fileName);
  let existing: string;
  try {
    existing = await readFile(filePath, 'utf8');
  } catch {
    return { changes: [], warnings: [], conflict: false };
  }
  const removed = removeBlock(existing);
  if (removed === null) return { changes: [], warnings: [], conflict: false };

  // Trim whitespace-only artifacts to decide if the file is now "empty".
  const stripped = removed.trim();
  if (stripped.length === 0 && deleteIfBlockOnly) {
    if (!ctx.dryRun) await unlink(filePath);
    return {
      changes: [{ path: filePath, kind: 'delete', summary: `remove ${fileName} (was OpenLore-only)` }],
      warnings: [],
      conflict: false,
    };
  }
  if (!ctx.dryRun) await confinedAtomicWriteFile(ctx.root, filePath, removed, { preserveMode: true });
  return {
    changes: [
      {
        path: filePath,
        kind: 'update',
        summary: `strip OpenLore block from ${fileName}`,
        preview: previewDiff(filePath, existing, removed),
      },
    ],
    warnings: [],
    conflict: false,
  };
}
