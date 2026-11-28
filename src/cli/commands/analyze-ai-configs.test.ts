/**
 * `openlore analyze --ai-configs` drops the full-digest `@`-import from a generated CLAUDE.md
 * only when the slim digest reaches the agent (change: trim-standing-agent-instructions). This runs
 * the real command on a real index, through both call sites: the up-to-date (cached) path and the
 * full path (`--force`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from '../install/index.js';
import { analyzeCommand } from './analyze.js';

let dir = '';
let home = '';
const savedHome = process.env.OPENLORE_HOME;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

async function wirePromptHook(): Promise<void> {
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ _openlore: true, hooks: [{ type: 'command', command: 'npx --yes openlore orient --inject' }] }] },
  }));
}

/** What the last analyze run printed through console.log. */
let printed = '';

async function analyzeAiConfigs(extra: string[] = []): Promise<string> {
  await rm(join(dir, 'CLAUDE.md'), { force: true });
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    await analyzeCommand.parseAsync(['--ai-configs', '--directory', dir, ...extra], { from: 'user' });
  } finally {
    console.log = log;
  }
  printed = lines.join('\n');
  return readFile(join(dir, 'CLAUDE.md'), 'utf8');
}

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'openlore-analyze-ai-configs-')));
  home = realpathSync(await mkdtemp(join(tmpdir(), 'openlore-analyze-ai-configs-home-')));
  process.env.OPENLORE_HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0' }));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export function parse(t: string): string { return t.trim(); }\nexport function load(p: string): string { return parse(p); }\n');
  await writeFile(join(dir, 'src', 'b.ts'), "import { load } from './a';\nexport function main(): string { return load('x'); }\n");
  // Builds the index (config, slim digest) without wiring hooks into this repository.
  expect(await runInstall({ cwd: dir, agent: 'agents-md', home, repoOnly: true })).toBe(0);
  await rm(join(dir, '.claude'), { recursive: true, force: true });
}, 60_000);

afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENLORE_HOME; else process.env.OPENLORE_HOME = savedHome;
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('analyze --ai-configs and the full-digest import', () => {
  it('names the digest instead of importing it when the prompt hook delivers the slim digest', async () => {
    await wirePromptHook();
    for (const extra of [[], ['--force']]) {
      const md = await analyzeAiConfigs(extra);
      expect(md.split('\n'), `analyze ${extra.join(' ')}`).not.toContain('@.openlore/analysis/CODEBASE.md');
      expect(md, `analyze ${extra.join(' ')}`).toContain('Full repository digest, for a task that needs it: `.openlore/analysis/CODEBASE.md`.');
    }
  }, 120_000);

  it('keeps the import when no prompt hook is wired', async () => {
    for (const extra of [[], ['--force']]) {
      const md = await analyzeAiConfigs(extra);
      expect(md.split('\n'), `analyze ${extra.join(' ')}`).toContain('@.openlore/analysis/CODEBASE.md');
    }
  }, 120_000);

  it('prints one agent-setup line and no tool table (full run)', async () => {
    await analyzeAiConfigs(['--force']);
    const tips = printed.split('\n').filter(line => line.includes('Agent setup'));
    expect(tips).toEqual(['  Agent setup: run `openlore install`. A task that needs the full repository digest can read .openlore/analysis/CODEBASE.md.']);
    expect(printed).not.toContain('| Situation');
    for (const tool of ['search_code', 'get_subgraph', 'suggest_insertion_points', 'check_spec_drift', 'search_specs']) {
      expect(printed).not.toContain(tool);
    }
  }, 120_000);

  it('a fresh install over this index writes the short block and no import anywhere in CLAUDE.md', async () => {
    await rm(join(dir, 'CLAUDE.md'), { force: true });
    expect(await runInstall({ cwd: dir, agent: 'claude-code', home, repoOnly: true, analyze: false })).toBe(0);
    const md = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(md).not.toMatch(/^@\.openlore\/analysis\/CODEBASE\.md\s*$/m);
    expect(md).toContain('BEGIN OPENLORE');
    expect(md).toContain('the `orient` tool');
  }, 60_000);
});
