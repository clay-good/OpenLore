/**
 * Sanity tests for the `skills/openlore-orient/scripts/orient-via-mcp.mjs`
 * helper. We don't shell out (slow + flaky in CI without a built dist) — we
 * import the module and assert it does basic input validation and that the
 * file is structurally a JSON-RPC driver. End-to-end coverage of the actual
 * MCP roundtrip is exercised by hand against the local dist build and is
 * documented in the spec-02 PR description.
 */

import { describe, it, expect } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const HELPER = resolve(REPO_ROOT, 'skills/openlore-orient/scripts/orient-via-mcp.mjs');
const SH = resolve(REPO_ROOT, 'skills/openlore-orient/scripts/orient.sh');
const PS1 = resolve(REPO_ROOT, 'skills/openlore-orient/scripts/orient.ps1');
const SKILL_MD = resolve(REPO_ROOT, 'skills/openlore-orient/SKILL.md');

/** The five skills the Claude Code plugin ships (change: adopt-agent-context-interop). */
const PLUGIN_SKILLS = [
  'openlore-debug',
  'openlore-implement-story',
  'openlore-orient',
  'openlore-review-changes',
  'openlore-write-tests',
];
const MAX_SKILL_LINES = 80;

/** Every OpenLore tool a text names (as a whole word) that is not in `allowed`, sorted. */
export function uncallableTools(text: string, known: readonly string[], allowed: ReadonlySet<string>): string[] {
  // A bare name, or one qualified by an MCP client (`mcp__openlore__<tool>`).
  return known.filter((t) => !allowed.has(t)
    && new RegExp(`(?:(?<![A-Za-z0-9_])|mcp__[A-Za-z0-9_-]+__)${t}(?![A-Za-z0-9_])`).test(text)).sort();
}

describe('openlore-orient skill bundle', () => {
  it('orient-via-mcp.mjs exists and references the MCP server', async () => {
    const src = await readFile(HELPER, 'utf8');
    expect(src).toContain("'openlore'");
    expect(src).toContain("'mcp'");
    expect(src).toContain("'node_modules', 'npm', 'bin', 'npx-cli.js'");
    expect(src).toContain('tools/call');
    expect(src).toContain('initialize');
  });

  it('orient.sh prefers the CLI subcommand, falls back to MCP helper', async () => {
    const src = await readFile(SH, 'utf8');
    expect(src).toContain('npx --yes openlore orient --json --task');
    expect(src).toContain('orient-via-mcp.mjs');
  });

  it('orient.ps1 mirrors the same strategy', async () => {
    const src = await readFile(PS1, 'utf8');
    expect(src).toContain('npx --yes openlore orient --json --task');
    expect(src).toContain('orient-via-mcp.mjs');
  });

  it('SKILL.md has portable Agent Skills frontmatter', async () => {
    // Line endings normalised at the read: the frontmatter fences and the `^…$`
    // field patterns below are spelled with `\n`, and a CRLF checkout (the Windows
    // default) makes every one of them miss. The property is which keys the
    // frontmatter declares, not how the repository stores its newlines.
    const src = (await readFile(SKILL_MD, 'utf8')).split('\r\n').join('\n');
    const frontmatter = src.match(/^---\n([\s\S]*?)\n---/)?.[1];
    expect(frontmatter).toBeDefined();
    expect(src).toMatch(/^name:\s*openlore-orient$/m);
    expect(src).toMatch(/^description:\s*.+Use when.+$/m);
    expect(frontmatter?.split('\n').map((line) => line.split(':', 1)[0])).toEqual([
      'name',
      'description',
    ]);
    expect(src.toLowerCase()).toContain('deterministic, graph-native model');
  });

  it('orient.sh and orient.ps1 are executable', async () => {
    // Windows has no POSIX execute bit — `stat().mode` there reports a synthesised
    // value with no `0o111` information at all, so the working-copy check cannot
    // exist. The property that actually ships is the mode RECORDED IN GIT (`100755`),
    // which is what a POSIX checkout and the npm tarball both take their bit from,
    // and git records it identically on every platform. Assert that instead of
    // skipping, so the guard still runs on Windows.
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'git',
        ['ls-files', '--stage', '--', 'skills/openlore-orient/scripts/orient.sh',
          'skills/openlore-orient/scripts/orient.ps1'],
        { cwd: REPO_ROOT },
      );
      const modes = stdout.trim().split(/\r?\n/).map((line) => line.split(' ')[0]);
      expect(modes).toHaveLength(2);
      for (const mode of modes) expect(mode).toBe('100755');
      return;
    }
    const sh = await stat(SH);
    expect(sh.mode & 0o111).not.toBe(0);
    const ps1 = await stat(PS1);
    expect(ps1.mode & 0o111).not.toBe(0);
  });
});

describe('plugin skills (change: adopt-agent-context-interop)', () => {
  const read = async (rel: string) => (await readFile(resolve(REPO_ROOT, rel), 'utf8')).split('\r\n').join('\n');

  /** Tools a plugin skill may name: those the `plugin` preset exposes AND the preset `plugin/.mcp.json` wires. */
  async function callableInPlugin(): Promise<{ known: string[]; allowed: Set<string> }> {
    const { TOOL_DEFINITIONS, TOOL_PRESETS } = await import('../commands/mcp.js');
    const mcp = JSON.parse(await read('plugin/.mcp.json')) as { mcpServers: { openlore: { args: string[] } } };
    const args = mcp.mcpServers.openlore.args;
    const wired = args[args.indexOf('--preset') + 1];
    expect(TOOL_PRESETS[wired], `plugin/.mcp.json wires unknown preset "${wired}"`).toBeDefined();
    const allowed = new Set([...TOOL_PRESETS.plugin].filter((t) => TOOL_PRESETS[wired].has(t)));
    return { known: TOOL_DEFINITIONS.map((d: { name: string }) => d.name), allowed };
  }

  it('the plugin ships exactly the five skills', async () => {
    const dirs = (await readdir(resolve(REPO_ROOT, 'plugin/skills'), { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(dirs).toEqual(PLUGIN_SKILLS);
  });

  it.each(PLUGIN_SKILLS)('%s is short, has portable frontmatter, and ends with the three actions', async (name) => {
    const text = await read(`skills/${name}/SKILL.md`);
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(MAX_SKILL_LINES);
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
    expect(frontmatter?.split('\n').map((line) => line.split(':', 1)[0])).toEqual(['name', 'description']);
    expect(text).toMatch(new RegExp(`^name:\\s*${name}$`, 'm'));
    expect(text).toMatch(/^description:\s*.+Use when.+$/m);
    const lastSection = text.slice(text.lastIndexOf('\n## '));
    expect(lastSection).toMatch(/^\n## Close with one action per finding/);
    for (const action of ['**Fix it**', '**Record a decision**', '**Raise it to the human**']) {
      expect(lastSection).toContain(action);
    }
  });

  it.each(PLUGIN_SKILLS)('%s names only tools the plugin can call', async (name) => {
    const { known, allowed } = await callableInPlugin();
    expect(uncallableTools(await read(`skills/${name}/SKILL.md`), known, allowed)).toEqual([]);
  });

  it('the tool check catches a tool the plugin does not expose', async () => {
    const { known, allowed } = await callableInPlugin();
    expect(uncallableTools('Then call `get_change_coupling` and check_spec_drift.', known, allowed))
      .toEqual(['check_spec_drift', 'get_change_coupling']);
    // A word that only contains a tool name is not a mention of it.
    expect(uncallableTools('my_get_change_coupling_helper', known, allowed)).toEqual([]);
    // An MCP-qualified name is.
    expect(uncallableTools('call `mcp__openlore__get_change_coupling`', known, allowed)).toEqual(['get_change_coupling']);
  });

  it.each(PLUGIN_SKILLS)('plugin/skills/%s/SKILL.md is byte-identical to skills/', async (name) => {
    const canonical = await readFile(resolve(REPO_ROOT, `skills/${name}/SKILL.md`));
    const copy = await readFile(resolve(REPO_ROOT, `plugin/skills/${name}/SKILL.md`));
    expect(copy.equals(canonical)).toBe(true);
  });
});
