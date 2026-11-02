/**
 * Guidance may only name tools the running surface serves
 * (change: fix-orient-guidance-preset).
 *
 * `install` prints "the generated guidance prescribes only tools this preset exposes" and the
 * default preset is `substrate` (15 tools). `orient` nonetheless prescribed `record_decision`,
 * `check_spec_drift` and `get_spec`, none of which it exposes, so an agent following the
 * nextSteps got a preset-membership error. This is a guard, not a one-off fix: it reads the
 * rendered guidance and fails on any tool name the active surface does not contain.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setActiveToolSurface, clearActiveToolSurface, toolIsWired } from './active-surface.js';
import { TOOL_PRESETS } from '../../../cli/commands/mcp.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

afterEach(() => clearActiveToolSurface());

describe('the active tool surface', () => {
  it('counts every tool as reachable when no server registered one', () => {
    expect(toolIsWired('record_decision')).toBe(true);
    expect(toolIsWired('anything_at_all')).toBe(true);
  });

  it('counts only the registered tools once a server has started', () => {
    setActiveToolSurface(['orient', 'get_subgraph']);
    expect(toolIsWired('orient')).toBe(true);
    expect(toolIsWired('record_decision')).toBe(false);
  });
});

// Both servers must register the surface. `openlore mcp` delegates to a running `openlore
// serve` daemon with no flag, so a daemon that never registered made the stdio default regress
// the moment it was warm (change: fix-orient-guidance-preset).
describe('every server registers the surface it serves', () => {
  it('both the stdio server and the serve daemon call setActiveToolSurface', async () => {
    for (const file of ['mcp.ts', 'serve.ts']) {
      const source = await readFile(join(import.meta.dirname, '..', '..', '..', 'cli', 'commands', file), 'utf8');
      expect(
        source.includes('setActiveToolSurface('),
        `${file} computes an active tool set but never registers it, so guidance it serves can name unwired tools`,
      ).toBe(true);
    }
  });
});

describe('orient guidance under the default preset', () => {
  /**
   * A SOURCE guard, not a behavioural one: the branch that prescribes `record_decision` and
   * `check_spec_drift` only renders for a repository with an index, so a temp-directory call
   * takes the empty-result path and would pass vacuously. Reading the source catches the
   * regression where it is actually written.
   */
  it('guards every tool name it prescribes that the substrate preset does not expose', async () => {
    const substrate = TOOL_PRESETS.substrate;
    expect(substrate, 'the substrate preset must exist').toBeDefined();
    const allTools = new Set<string>(Object.values(TOOL_PRESETS).flatMap(p => [...p]));

    const source = await readFile(join(import.meta.dirname, 'orient.ts'), 'utf8');
    // The guidance-rendering section, from its own banner to the next one.
    const from = source.indexOf('── Next steps ');
    expect(from, 'the next-steps section must be found').toBeGreaterThan(0);
    const section = source.slice(from, source.indexOf('\n  // ──', from + 10));
    expect(section).toContain('nextSteps.push');

    const named = [...section.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)]
      .map(m => m[1])
      .filter(t => allTools.has(t) && !substrate.has(t));
    for (const tool of new Set(named)) {
      expect(
        section.includes(`toolIsWired('${tool}')`),
        `orient prescribes ${tool}, which the substrate preset does not expose, without a toolIsWired('${tool}') guard`,
      ).toBe(true);
    }
  });
});
