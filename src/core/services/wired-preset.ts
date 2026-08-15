/**
 * Which MCP tool surface is actually wired in this repository
 * (change: align-generated-guidance-with-installed-preset).
 *
 * Generated agent guidance used to prescribe workflows unconditionally — "call
 * `record_decision` before writing the code" — while the wired default surface
 * did not expose that tool. The agent then spent a session unable to perform a
 * task its own instructions demanded. Guidance must therefore be written against
 * the surface the repository actually has.
 *
 * The preset is read from the MCP registration `openlore install` wrote, so the
 * guidance and the server agree by construction rather than by convention. When
 * no registration is found the answer is the documented default, never a guess.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FULL_PRESET, FULL_PRESET_ALIAS, LEAN_DEFAULT_PRESET } from '../../constants.js';

/**
 * MCP registration files the install adapters write, in resolution order. The
 * first one that registers an OpenLore server decides — a repository wired for
 * several agents is wired with one preset.
 */
export const WIRED_PRESET_SOURCES = [
  '.mcp.json',            // Claude Code (project scope)
  '.cursor/mcp.json',     // Cursor
  '.vscode/mcp.json',     // VS Code / Continue
] as const;

export interface WiredPreset {
  /** Canonical preset name (`substrate`, `full`, …). */
  preset: string;
  /** Where it was read from: a repo-relative file path, or `default` when unwired. */
  source: string;
}

/** Read `--preset X` / `--all-tools` / `--minimal` out of a wired server's argv. */
function presetFromArgs(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  const argv = args.filter((a): a is string => typeof a === 'string');
  if (argv.includes('--all-tools')) return FULL_PRESET;
  const flagIndex = argv.indexOf('--preset');
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1];
    if (typeof value === 'string' && value.length > 0) {
      return value === FULL_PRESET_ALIAS ? FULL_PRESET : value;
    }
  }
  if (argv.includes('--minimal')) return 'minimal';
  // An `openlore mcp` registration with no selector runs the documented default.
  if (argv.includes('mcp')) return LEAN_DEFAULT_PRESET;
  return null;
}

/** Find the OpenLore server entry in either MCP config shape. */
function openloreEntry(parsed: unknown): { args?: unknown } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  for (const key of ['mcpServers', 'servers']) {
    const servers = root[key];
    if (servers && typeof servers === 'object') {
      const entry = (servers as Record<string, unknown>)['openlore'];
      if (entry && typeof entry === 'object') return entry as { args?: unknown };
    }
  }
  return null;
}

/**
 * The tool surface wired in `rootDir`. Falls back to the documented default
 * (`LEAN_DEFAULT_PRESET`) with source `default` — the same surface a bare
 * `openlore mcp` serves, so unwired repositories get guidance that still matches
 * what an agent would actually see.
 */
export async function resolveWiredPreset(rootDir: string): Promise<WiredPreset> {
  for (const rel of WIRED_PRESET_SOURCES) {
    let raw: string;
    try {
      raw = await readFile(join(rootDir, rel), 'utf-8');
    } catch {
      continue;  // not wired for this surface
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;  // a malformed config is not evidence of a preset
    }
    const entry = openloreEntry(parsed);
    if (!entry) continue;
    const preset = presetFromArgs(entry.args);
    if (preset) return { preset, source: rel };
  }
  return { preset: LEAN_DEFAULT_PRESET, source: 'default' };
}

/**
 * The tool names a preset exposes, or `null` for the full surface (the registry
 * itself — every tool is available, so membership needs no set).
 *
 * Derived from the live `TOOL_PRESETS` registry via dynamic import: one source of
 * truth for what a preset contains, and the heavy MCP module stays off the
 * analyzer's common path. An unknown preset name yields an empty set rather than
 * a silent "everything" — guidance must not over-claim a surface we cannot verify.
 */
export async function presetToolNames(preset: string): Promise<ReadonlySet<string> | null> {
  if (preset === FULL_PRESET) return null;
  const { TOOL_PRESETS } = await import('../../cli/commands/mcp.js');
  return TOOL_PRESETS[preset] ?? new Set<string>();
}

/**
 * The exact command that makes `tool` callable without LOSING anything already
 * wired. Guidance cites this instead of prescribing an uncallable tool.
 *
 * The narrowest preset containing the tool is not automatically the right advice:
 * `record_decision` lives in `minimal`, so a repo on `substrate` told to install
 * `minimal` would gain decisions and lose ten navigation tools. So the candidate
 * must be a SUPERSET of what is wired today; when none is, the answer is the full
 * surface. Deterministic, and derived from the live registry.
 */
export async function enablingCommandFor(tool: string, currentPreset?: string): Promise<string> {
  const { TOOL_PRESETS } = await import('../../cli/commands/mcp.js');
  const current = currentPreset ? (TOOL_PRESETS[currentPreset] ?? new Set<string>()) : new Set<string>();

  const candidates = Object.entries(TOOL_PRESETS)
    .filter(([, tools]) => tools.has(tool))
    .filter(([, tools]) => [...current].every(t => tools.has(t)))  // never a downgrade
    .map(([name, tools]) => ({ name, size: tools.size }))
    // Smallest surface that still covers everything currently wired.
    .sort((a, b) => a.size - b.size);

  return `openlore install --preset ${candidates[0]?.name ?? FULL_PRESET}`;
}
