/**
 * Generated guidance must never prescribe a tool the wired surface cannot call
 * (change: align-generated-guidance-with-installed-preset).
 *
 * This is the contract, not a copy check. The regression it prevents is concrete:
 * guidance told an agent to call `record_decision` "before writing the code"
 * while the default surface did not expose it, and a task stayed blocked for a
 * whole session. Adding a tool-naming workflow to the generator without gating it
 * on preset membership fails here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAiConfigs } from './ai-config-generator.js';
import { TOOL_PRESETS } from '../../cli/commands/mcp.js';
import { LEAN_DEFAULT_PRESET, FULL_PRESET } from '../../constants.js';

let dir: string;

/** Tool names the guidance instructs the agent to call, in `code` spans. */
function prescribedTools(markdown: string): string[] {
  const known = new Set<string>();
  for (const tools of Object.values(TOOL_PRESETS)) for (const t of tools) known.add(t);
  // Tools outside every preset still exist on the full surface; include the ones
  // the generator is allowed to name so the scan cannot miss an over-claim.
  for (const t of [
    'record_decision', 'check_spec_drift', 'get_spec', 'search_specs', 'get_function_body',
    'get_schema_inventory', 'get_route_inventory', 'get_env_vars', 'get_ui_component_inventory',
    'get_middleware_inventory', 'trace_execution_path', 'get_subgraph', 'remember',
  ]) known.add(t);

  const found = new Set<string>();
  for (const match of markdown.matchAll(/`([a-z_]+)`/g)) {
    const name = match[1]!;
    if (known.has(name)) found.add(name);
  }
  return [...found];
}

/**
 * A tool may appear in a "this is NOT available, here is how to enable it"
 * paragraph — that is the honest form, not a prescription. Strip those sections
 * before scanning so the check measures instructions, not disclosures.
 */
function withoutUnavailabilityNotes(markdown: string): string {
  return markdown
    .split('\n')
    .filter(line => !/is \*\*not\*\* part of the wired|To enable it:|do not plan around/.test(line))
    .join('\n');
}

function writeMcpConfig(root: string, args: string[]): void {
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { openlore: { command: 'npx', args } } }, null, 2),
  );
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'openlore-guidance-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function generate(root: string): Promise<string> {
  await generateAiConfigs({ rootDir: root, analysisDir: '.openlore/analysis', projectName: 'demo', tools: ['claude'] });
  return readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
}

describe('generated guidance ↔ wired preset coherence', () => {
  it('names no tool the wired default surface lacks', async () => {
    writeMcpConfig(dir, ['--yes', 'openlore', 'mcp', '--preset', LEAN_DEFAULT_PRESET]);
    const guidance = await generate(dir);

    const wired = TOOL_PRESETS[LEAN_DEFAULT_PRESET]!;
    const prescribed = prescribedTools(withoutUnavailabilityNotes(guidance));

    expect(prescribed.length).toBeGreaterThan(0);          // it still says something useful
    expect(prescribed.filter(t => !wired.has(t))).toEqual([]);
  });

  it('names no tool the wired navigation surface lacks', async () => {
    writeMcpConfig(dir, ['--yes', 'openlore', 'mcp', '--preset', 'navigation']);
    const guidance = await generate(dir);

    const wired = TOOL_PRESETS['navigation']!;
    expect(prescribedTools(withoutUnavailabilityNotes(guidance)).filter(t => !wired.has(t))).toEqual([]);
  });

  it('prescribes the decision workflow on the full surface', async () => {
    writeMcpConfig(dir, ['--yes', 'openlore', 'mcp', '--preset', FULL_PRESET]);
    const guidance = await generate(dir);

    expect(guidance).toContain('record_decision({');
    expect(guidance).not.toContain('is **not** part of the wired');
  });

  it('states the prerequisite instead of prescribing an absent tool', async () => {
    writeMcpConfig(dir, ['--yes', 'openlore', 'mcp', '--preset', LEAN_DEFAULT_PRESET]);
    const guidance = await generate(dir);

    expect(guidance).toContain('`record_decision` is **not** part of the wired');
    expect(guidance).toContain('openlore install --preset');
    expect(guidance).not.toContain('record_decision({');   // no callable example
  });

  it('never advises a preset that would drop tools already wired', async () => {
    // `minimal` is the narrowest preset holding record_decision, but moving a
    // `substrate` repo there loses the navigation core. The advice must be a
    // superset of what is wired — here, the full surface.
    writeMcpConfig(dir, ['--yes', 'openlore', 'mcp', '--preset', LEAN_DEFAULT_PRESET]);
    const guidance = await generate(dir);

    const advised = /openlore install --preset (\w+)/.exec(guidance)?.[1];
    expect(advised).toBeDefined();
    const wired = TOOL_PRESETS[LEAN_DEFAULT_PRESET]!;
    const target = advised === FULL_PRESET ? null : TOOL_PRESETS[advised!];
    for (const tool of wired) {
      if (target) expect(target.has(tool), `advised preset drops ${tool}`).toBe(true);
    }
  });

  it('names the surface it was written for', async () => {
    writeMcpConfig(dir, ['--yes', 'openlore', 'mcp', '--preset', 'navigation']);
    expect(await generate(dir)).toContain('Written for the wired `navigation` surface');
  });

  it('falls back to the documented default when the repo is unwired', async () => {
    const guidance = await generate(dir);   // no .mcp.json at all
    expect(guidance).toContain(`Written for the wired \`${LEAN_DEFAULT_PRESET}\` surface`);
  });

  it('reads the preset from a Cursor registration', async () => {
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    writeFileSync(
      join(dir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { openlore: { command: 'npx', args: ['openlore', 'mcp', '--preset', 'minimal'] } } }),
    );
    expect(await generate(dir)).toContain('Written for the wired `minimal` surface');
  });

  it('treats --all-tools as the full surface', async () => {
    writeMcpConfig(dir, ['--yes', 'openlore', 'mcp', '--all-tools']);
    expect(await generate(dir)).toContain('record_decision({');
  });
});

describe('orient guidance is conditional', () => {
  it('does not instruct orienting before every source read', async () => {
    const guidance = await generate(dir);
    expect(guidance).not.toMatch(/ALWAYS call/i);
    expect(guidance).not.toMatch(/before reading source files/i);
  });

  it('states the condition and the exemption', async () => {
    const guidance = await generate(dir);
    expect(guidance).toContain('before touching a module you have not yet read');
    expect(guidance).toContain('do not need re-orientation');
  });
});
