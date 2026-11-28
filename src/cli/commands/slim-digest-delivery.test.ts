/**
 * Whether the slim digest reaches the agent (change: trim-standing-agent-instructions). Only then
 * may a generated CLAUDE.md drop the full-digest import, or status call an old import dead weight.
 * Real filesystem: real settings files, a real slim digest in the format analyze writes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slimDigestReachesAgent } from './slim-digest-delivery.js';
import { readSlimDigest } from './orient-inject.js';
import { renderSlimDigest } from '../../core/analyzer/codebase-digest.js';
import { estimateTokens } from '../../core/services/llm-service.js';

let root = '';
let home = '';
const analysis = () => join(root, '.openlore', 'analysis');
/** A scratch managed-settings path, so the machine's real policy file never decides a test. */
const managed = () => join(home, 'managed-settings.json');

function wirePromptHook(dir: string, command = 'npx --yes openlore orient --inject', extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
    ...extra,
    hooks: { UserPromptSubmit: [{ _openlore: true, hooks: [{ type: 'command', command }] }] },
  }));
}
/** The guarded absolute-path form install writes, pointing at a CLI entry that does not exist. */
const goneEntry = '/nonexistent/openlore/dist/cli/index.js';
const brokenCommand = (scope = '') => `[ -f ${goneEntry} ] && [ -f ${process.execPath} ] || exit 0; ${process.execPath} ${goneEntry} orient --inject${scope}`;
function writeConfig(extra: Record<string, unknown>): void {
  writeFileSync(join(root, '.openlore', 'config.json'), JSON.stringify({
    version: '1.0.0', projectType: 'nodejs', openspecPath: 'openspec',
    analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
    generation: { domains: 'auto' }, createdAt: '2026-01-01T00:00:00Z', lastRun: null, ...extra,
  }));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'olslimreach-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'olslimreach-home-')));
  mkdirSync(analysis(), { recursive: true });
  writeFileSync(join(analysis(), 'llm-context.json'), '{}');
  writeFileSync(join(analysis(), 'CODEBASE.slim.md'), renderSlimDigest({
    counts: { functions: 12, pairs: 30 },
    hubs: [{ name: 'parseConfig', file: 'src/config.ts', callers: 9 }],
    callGraphLanguages: ['TypeScript'],
    fullDigestPath: '.openlore/analysis/CODEBASE.md',
  }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('slimDigestReachesAgent', () => {
  it('is true when the project wires the prompt hook and the hook would print the digest', async () => {
    wirePromptHook(root);
    expect(await readSlimDigest(root)).toBeDefined();
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(true);
  });

  it('is true when only the user scope wires the prompt hook', async () => {
    wirePromptHook(home);
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(true);
  });

  it('is false when no prompt hook is wired, though the digest file exists', async () => {
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when a hook other than the prompt hook is wired', async () => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ _openlore: true, hooks: [{ type: 'command', command: 'npx --yes openlore orient --json' }] }] },
    }));
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when context injection is off', async () => {
    wirePromptHook(root);
    writeConfig({ contextInjection: { mode: 'off' } });
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when the prompt-submitted moment is turned off', async () => {
    wirePromptHook(root);
    writeConfig({ hooks: { 'prompt-submitted': false } });
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when the digest is not the file analyze writes, or is missing', async () => {
    wirePromptHook(root);
    writeFileSync(join(analysis(), 'CODEBASE.slim.md'), '# hand-written digest\n');
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
    rmSync(join(analysis(), 'CODEBASE.slim.md'));
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when the wired hook names a program that no longer exists', async () => {
    wirePromptHook(root, brokenCommand());
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when a broken repository hook makes a healthy user-scope hook stand down', async () => {
    wirePromptHook(home, 'npx --yes openlore orient --inject --scope user');
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(true);
    wirePromptHook(root, brokenCommand());
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when Claude Code hooks are disabled', async () => {
    wirePromptHook(root, undefined, { disableAllHooks: true });
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when the digest alone does not fit the injection token budget', async () => {
    wirePromptHook(root);
    writeConfig({ contextInjection: { tokenBudget: 68 } });
    const slim = await readSlimDigest(root);
    expect(slim?.tokenBudget).toBe(68);
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when managed policy allows only managed hooks or disables hooks', async () => {
    wirePromptHook(root);
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(true);
    writeFileSync(managed(), JSON.stringify({ allowManagedHooksOnly: true }));
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
    writeFileSync(managed(), JSON.stringify({ disableAllHooks: true }));
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });

  it('is false when the digest fits the budget alone but not beside the silence line', async () => {
    wirePromptHook(root);
    const digest = (await readSlimDigest(root))!.text;
    const budget = estimateTokens(digest) + 1;
    writeConfig({ contextInjection: { tokenBudget: budget } });
    expect((await readSlimDigest(root))?.tokenBudget).toBe(budget);
    expect(await slimDigestReachesAgent(root, home, managed())).toBe(false);
  });
});
