/**
 * Guard: the user-facing "N tools" full-surface count in the docs must match the
 * real `TOOL_DEFINITIONS.length`. The count drifted silently before (docs said 50
 * while the surface grew to 58) because nothing tied the prose to the code. This
 * ties them: add or remove a tool and the doc count must move with it, or CI fails.
 *
 * Scope is the current-tense surfaces a user (or agent) reads to learn the live tool
 * count: README.md, docs/mcp-tools.md, docs/cli-reference.md, docs/governance-dogfooding.md,
 * and the live consolidated spec openspec/specs/cli/spec.md. In each, every `<N> tools`
 * mention the regex catches is a present-tense claim about the full surface, so the check
 * is exact. This list was widened after a v2.1.1 e2e dogfood found the same decision —
 * "MCP exposes a curated navigation preset, not all <N> tools" — drifted to "45" in the
 * spec heading and "50" in governance-dogfooding.md while README (guarded) correctly said
 * "60". Nothing tied those two surfaces to the code, so they lagged.
 *
 * Dated point-in-time spec records under docs/specs/** stay excluded: "Spec 28 measured
 * 50 tools / 47,037 bytes" is a historical measurement, not a claim about today, and
 * rewriting it would falsify the record. The same distinction holds INSIDE cli/spec.md:
 * the decision *heading* ("not all <N> tools") is a present-tense fact and is guarded,
 * while its body's dated benchmark line ("loading all ~45 MCP tool definitions") says
 * "tool definitions" (singular) — the `tools\b` regex skips it, preserving the record.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOL_DEFINITIONS, toolAnnotations, TOOL_PRESETS } from './mcp.js';
import { LEAN_DEFAULT_PRESET } from '../../constants.js';

// src/cli/commands/<this> → repo root is three levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// change: default-to-lean-tool-surface — the documented DEFAULT surface count must
// track the lean default preset (the navigation surface), exactly as the full-surface
// count tracks TOOL_DEFINITIONS.length. Sourced from the preset so it can't drift.
const LEAN_DEFAULT_COUNT = TOOL_PRESETS[LEAN_DEFAULT_PRESET].size;

// Files whose every "<N> tools" mention the regex catches is the live full surface.
// cli-reference.md: its sole match ("all <count> tools on a fixed port") is the full
// `serve --preset all` surface. governance-dogfooding.md and cli/spec.md each have exactly
// one match — the present-tense "not all <N> tools" decision claim — so the exact check
// holds there too (verified: their only other count phrasing, "~45 MCP tool definitions",
// is singular "tool" and is not matched).
// Most guarded docs mention ONLY the full surface, so every "<N> tools" match must equal
// the live count. docs/agent-setup.md also documents the curated `openlore-core` always-
// visible preset ("6 tools"), so that known preset size is allowlisted there — the file is
// still guarded for its full-surface claims (it drifted to "61" while the surface was 62
// precisely because nothing tied it to the code).
// The lean default count (navigation size) is allowlisted in the docs that now state
// it alongside the full surface (change: default-to-lean-tool-surface); a dedicated
// guard below asserts those docs cite exactly LEAN_DEFAULT_COUNT so it can't drift either.
const GUARDED_DOCS: Array<{ rel: string; allowPresetCounts?: number[] }> = [
  { rel: 'README.md', allowPresetCounts: [LEAN_DEFAULT_COUNT] },
  { rel: 'docs/mcp-tools.md', allowPresetCounts: [LEAN_DEFAULT_COUNT] },
  // cli-reference.md documents the per-command surfaces: the lean `navigation` default
  // (LEAN_DEFAULT_COUNT) for install/mcp and the `minimal` governance core (6); both are
  // allowlisted preset sizes, while the file is still guarded for its full-surface claims.
  { rel: 'docs/cli-reference.md', allowPresetCounts: [LEAN_DEFAULT_COUNT, 6] },
  { rel: 'docs/governance-dogfooding.md' },
  { rel: 'docs/agent-setup.md', allowPresetCounts: [LEAN_DEFAULT_COUNT, 6] },
  { rel: 'openspec/specs/cli/spec.md', allowPresetCounts: [LEAN_DEFAULT_COUNT] },
  // CLAUDE.md and install.md drifted to a stale "65" (in `not all 65 tools` / `full 65-tool
  // surface` phrasings) while every guarded doc was green, because they were NOT guarded and
  // the regex missed the hyphenated `N-tool` form. Both are now guarded and the regex below
  // catches `N-tool` too, so this class of drift fails CI here.
  { rel: 'CLAUDE.md', allowPresetCounts: [LEAN_DEFAULT_COUNT] },
  { rel: 'docs/install.md', allowPresetCounts: [LEAN_DEFAULT_COUNT] },
];

// Docs that document the lean DEFAULT surface must cite exactly its preset size, so the
// default figure is guarded against drift the same way the full count is.
const LEAN_DEFAULT_DOCS = ['README.md', 'docs/mcp-tools.md'];

describe('documented MCP tool count', () => {
  const expected = TOOL_DEFINITIONS.length;

  it.each(GUARDED_DOCS)('the "N tools" full-surface count in $rel matches TOOL_DEFINITIONS.length', ({ rel, allowPresetCounts = [] }) => {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    // Two phrasings, by design:
    //   (a) spaced PLURAL "58 tools" / "58 MCP tools" / "58 graph-native tools" (one optional
    //       adjective word) — the original.
    //   (b) hyphenated "58-tool surface" (singular or plural) — added after `full 65-tool
    //       surface` / `not all 65 tools` drifted unnoticed because the old regex skipped it.
    // The spaced SINGULAR form is deliberately NOT matched, so the dated historical record
    // "loading all ~45 MCP tool definitions" stays preserved (not rewritten). Preset sizes
    // (e.g. "10-tool navigation") are permitted via allowPresetCounts; "tool-calls" (no
    // leading count) is not matched.
    const counts = [...text.matchAll(/(\d+)(?:-tools?\b|\s+(?:[A-Za-z][\w-]*\s+)?tools\b)/g)].map(m => Number(m[1]));
    expect(counts.length, `expected at least one "N tools" mention in ${rel}`).toBeGreaterThan(0);
    for (const n of counts) {
      if (allowPresetCounts.includes(n)) continue; // documented preset size, not the full surface
      expect(n, `${rel} cites "${n} tools" but the live surface is ${expected}; update the doc (and the byte/token figures) when the tool count changes`).toBe(expected);
    }
    // The full surface must actually be stated — guard against a file that only ever
    // mentions preset sizes (which would let the full-surface count vanish unnoticed).
    expect(counts.includes(expected), `${rel} never states the full surface of ${expected} tools`).toBe(true);
  });
});

// change: default-to-lean-tool-surface — the documented lean DEFAULT count must equal
// the navigation preset size, so neither the default nor the full figure can drift.
describe('documented lean default tool count', () => {
  it.each(LEAN_DEFAULT_DOCS)('%s cites the lean default surface as the navigation preset size', (rel) => {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    const counts = [...text.matchAll(/(\d+)(?:-tools?\b|\s+(?:[A-Za-z][\w-]*\s+)?tools\b)/g)].map(m => Number(m[1]));
    expect(
      counts.includes(LEAN_DEFAULT_COUNT),
      `${rel} should state the lean default surface of ${LEAN_DEFAULT_COUNT} tools (the ${LEAN_DEFAULT_PRESET} preset size); update it if the preset membership changed`,
    ).toBe(true);
  });
});

// The byte/token figures next to the tool count drifted too: docs cited "~48 KB /
// ~12k tokens" long after the real `tools/list` payload grew to ~55 KB / ~14k, because
// the count guard above only checks the integer, not the size figures. This ties the
// documented `~N KB` / `~Nk tokens` of the full `tools/list` line to the payload the
// ListTools handler actually emits (schemas + annotations), within a rounding band.
describe('documented tools/list size figures track the real payload', () => {
  // Mirror what the ListTools handler emits: each tool's schema plus its annotations.
  const tools = TOOL_DEFINITIONS.map(t => ({ ...t, annotations: toolAnnotations(t.name) }));
  const bytes = Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
  const kb = bytes / 1024;
  const ktokens = bytes / 4 / 1000; // the ~bytes/4 token heuristic the docs use

  it('the "~N KB / ~Nk tokens of tools/list" figure in docs/mcp-tools.md is current', () => {
    const text = readFileSync(join(repoRoot, 'docs/mcp-tools.md'), 'utf8');
    const line = text.split('\n').find(l => /tools\/list/.test(l) && /~\d+\s*KB/.test(l));
    expect(line, 'expected a "~N KB … tools/list" figure line in docs/mcp-tools.md').toBeDefined();
    const docKb = Number(/~(\d+)\s*KB/.exec(line!)?.[1]);
    const docKtokens = Number(/~(\d+)k\s+tokens/.exec(line!)?.[1]);
    // ±3 KB / ±2k tokens absorbs rounding but catches a real drift (the stale figure
    // was 7 KB / 2k tokens light — well outside the band).
    expect(Math.abs(docKb - kb), `docs/mcp-tools.md cites ~${docKb} KB but the real tools/list payload is ~${kb.toFixed(1)} KB`).toBeLessThanOrEqual(3);
    expect(Math.abs(docKtokens - ktokens), `docs/mcp-tools.md cites ~${docKtokens}k tokens but the real payload is ~${ktokens.toFixed(1)}k tokens`).toBeLessThanOrEqual(2);
  });
});
