/**
 * pi adapter — wires `.pi/extensions/openlore.js` for Pi (https://pi.dev).
 *
 * Pi does not consume MCP: it loads JavaScript extension files, and the OpenLore
 * extension injects the architecture digest itself on `session_start` while
 * talking to a warm `openlore serve` daemon. So this adapter writes one file and
 * nothing else — no markdown block, no MCP registration, no hook.
 *
 * What that file is, and why it is a re-export shim rather than a copy, is
 * documented in `../pi-extension.ts`. `--global` (~/.pi, every project) stays a
 * flag on `openlore setup --tools pi`.
 */

import { readFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { confinedAtomicWriteFile, safeJoin } from '../../../utils/path-confinement.js';
import {
  PI_EXTENSION_REL,
  PI_EXTENSION_LEGACY_REL,
  PI_EXTENSION_SOURCE,
  classifyPiFile,
  looksLikeOpenLoreExtension,
  readPiSource,
  renderPiShim,
} from '../pi-extension.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Pi loads every .ts and .js file in the extensions dir. Older versions shipped
 * `openlore.ts`; leaving it beside the .js registers the same tools twice. Only
 * remove it when it is recognisably ours — an unrelated `openlore.ts` is the
 * user's own extension, and deleting it would destroy their code. Planned on
 * every path (including a no-op re-install) so a dry run previews the deletion
 * it would really perform.
 */
async function planLegacyRemoval(
  ctx: ApplyContext,
  changes: PlannedChange[],
  warnings: string[]
): Promise<void> {
  const legacy = safeJoin(ctx.root, PI_EXTENSION_LEGACY_REL);
  const content = await readIfExists(legacy);
  if (content === null) return;
  if (!looksLikeOpenLoreExtension(content) && !ctx.force) {
    warnings.push(
      `pi: ${PI_EXTENSION_LEGACY_REL} was not written by OpenLore — left in place. Pi loads ` +
        'every file in the extensions dir, so remove or rename it yourself if it registers ' +
        'the same tools.'
    );
    return;
  }
  changes.push({
    path: legacy,
    kind: 'delete',
    summary: `${PI_EXTENSION_LEGACY_REL} removed (superseded by the .js extension)`,
  });
  if (!ctx.dryRun) await unlink(legacy);
}

export const piAdapter: Adapter = {
  name: 'pi',

  /**
   * Marker-based, per the Adapter contract: a shim we wrote counts as connected
   * even when it points at another openlore location (`stale`). A foreign file,
   * or the broken bundle copy an older version installed, does NOT — otherwise
   * the picker would leave Pi unchecked and never offer to repair it.
   */
  async isConnected(root) {
    const existing = await readIfExists(safeJoin(root, PI_EXTENSION_REL));
    if (existing === null) return false;
    const state = classifyPiFile(existing, renderPiShim());
    return state.kind === 'current' || state.kind === 'stale';
  },

  async apply(ctx: ApplyContext): Promise<ApplyResult> {
    const changes: PlannedChange[] = [];
    const warnings: string[] = [];
    const dest = safeJoin(ctx.root, PI_EXTENSION_REL);

    // The shim re-exports the compiled extension by absolute path, so refuse to
    // point Pi at a path that does not exist rather than writing a shim that
    // throws on load. Every other surface is already wired, so warn, don't fail.
    const shipped = await readPiSource();
    if (shipped === null) {
      warnings.push(
        `pi: the compiled extension is missing (${PI_EXTENSION_SOURCE}). Build the package ` +
          '("npm run build") or re-install openlore, then re-run "openlore connect pi".'
      );
      changes.push({
        path: dest,
        kind: 'noop',
        summary: `${PI_EXTENSION_REL} — compiled extension not found, skipped`,
      });
      return { changes, warnings, conflict: false };
    }

    const expected = renderPiShim();
    const existing = await readIfExists(dest);
    const state = classifyPiFile(existing, expected);

    if (state.kind === 'current') {
      changes.push({ path: dest, kind: 'noop', summary: `${PI_EXTENSION_REL} already up to date` });
      await planLegacyRemoval(ctx, changes, warnings);
      return { changes, warnings, conflict: false };
    }

    if (state.kind === 'foreign' && !ctx.force) {
      warnings.push(
        `pi: ${PI_EXTENSION_REL} was hand-edited or not written by OpenLore — refusing to overwrite. ` +
          'Re-run with --force to replace it, or move your own extension to a different filename.'
      );
      changes.push({
        path: dest,
        kind: 'noop',
        summary: `${PI_EXTENSION_REL} left untouched (hand-edited)`,
      });
      return { changes, warnings, conflict: true };
    }

    const kind = state.kind === 'absent' ? 'create' : 'update';
    const why =
      state.kind === 'legacy-copy'
        ? ' (replacing a copied bundle whose relative imports could not resolve)'
        : state.kind === 'stale'
          ? ' (re-pointed at the current openlore package)'
          : '';
    changes.push({
      path: dest,
      kind,
      summary: `${PI_EXTENSION_REL} — Pi extension${why}`,
      preview: `--- (${kind === 'create' ? 'new file' : 'replaced'}) ${PI_EXTENSION_REL}\n` +
        expected
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => `+ ${l}`)
          .join('\n'),
    });

    if (!ctx.dryRun) {
      await mkdir(dirname(dest), { recursive: true });
      await confinedAtomicWriteFile(ctx.root, safeJoin(ctx.root, relative(ctx.root, dest)), expected, {
        preserveMode: true,
      });
    }
    await planLegacyRemoval(ctx, changes, warnings);

    return { changes, warnings, conflict: false };
  },

  async uninstall(ctx: ApplyContext): Promise<ApplyResult> {
    const changes: PlannedChange[] = [];
    const warnings: string[] = [];
    const dest = safeJoin(ctx.root, PI_EXTENSION_REL);
    const legacy = safeJoin(ctx.root, PI_EXTENSION_LEGACY_REL);

    const existing = await readIfExists(dest);
    if (existing !== null) {
      const state = classifyPiFile(existing, renderPiShim());
      if (state.kind === 'foreign' && !ctx.force) {
        warnings.push(
          `pi: ${PI_EXTENSION_REL} is not an OpenLore-managed file — left in place. ` +
            'Re-run with --force to delete it.'
        );
        changes.push({ path: dest, kind: 'noop', summary: `${PI_EXTENSION_REL} left in place` });
      } else {
        changes.push({ path: dest, kind: 'delete', summary: `${PI_EXTENSION_REL} removed` });
        if (!ctx.dryRun) await unlink(dest);
      }
    }

    const legacyContent = await readIfExists(legacy);
    if (legacyContent !== null) {
      if (looksLikeOpenLoreExtension(legacyContent) || ctx.force) {
        changes.push({ path: legacy, kind: 'delete', summary: `${PI_EXTENSION_LEGACY_REL} removed` });
        if (!ctx.dryRun) await unlink(legacy);
      } else {
        warnings.push(
          `pi: ${PI_EXTENSION_LEGACY_REL} is not an OpenLore-managed file — left in place. ` +
            'Re-run with --force to delete it.'
        );
        changes.push({ path: legacy, kind: 'noop', summary: `${PI_EXTENSION_LEGACY_REL} left in place` });
      }
    }

    if (changes.length === 0) {
      changes.push({ path: dest, kind: 'noop', summary: `${PI_EXTENSION_REL} not present` });
    }
    return { changes, warnings, conflict: false };
  },
};
