/**
 * `openlore status` — the index's self-state (change: make-index-self-state-honest).
 *
 * Read-only is a property, not a promise: the test asserts that nothing on disk moves,
 * because a status command that touches the index is one nobody can run while a build
 * is in flight.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectHookMoments, collectIndexStatus, collectWiringScope, findDigestNotes, findLegacyDigestImport, formatHookHealth, formatLegacyDigestImport, formatUnservedDigestPointer, statusCommand } from './status.js';
import { renderBlock } from '../install/block.js';
import { renderSlimDigest } from '../../core/analyzer/codebase-digest.js';
import { _resetVectorIndexCachesForTesting } from '../../core/analyzer/vector-index.js';

const ANALYSIS = join('.openlore', 'analysis');

describe('openlore status — what the index is', () => {
  let root: string;
  const savedBaseUrl = process.env.EMBED_BASE_URL;
  const savedModel = process.env.EMBED_MODEL;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-status-'));
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_MODEL;
    _resetVectorIndexCachesForTesting();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (savedBaseUrl === undefined) delete process.env.EMBED_BASE_URL; else process.env.EMBED_BASE_URL = savedBaseUrl;
    if (savedModel === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = savedModel;
  });

  async function withIndex(hasEmbeddings: boolean, builtAt = new Date().toISOString()): Promise<string> {
    const analysisDir = join(root, ANALYSIS);
    await mkdir(join(analysisDir, 'vector-index'), { recursive: true });
    await writeFile(join(analysisDir, 'vector-index-meta.json'), JSON.stringify({
      hasEmbeddings,
      dim: hasEmbeddings ? 384 : 0,
      model: hasEmbeddings ? 'all-MiniLM-L6-v2' : null,
      builtAt,
      schemaVersion: 1,
      tokenizerVersion: 2,
    }), 'utf-8');
    return analysisDir;
  }

  const writeConfig = async (embedding: Record<string, unknown> | null): Promise<void> => {
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0',
      projectType: 'nodejs',
      openspecPath: './openspec',
      analysis: { maxFiles: 500, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'anthropic', model: 'claude-sonnet-5' },
      createdAt: '2026-09-20T00:00:00.000Z',
      lastRun: null,
      ...(embedding ? { embedding } : {}),
    }), 'utf-8');
  };

  it('names the cause when a configured provider is unrealized', async () => {
    await withIndex(false);
    await writeConfig({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' });

    const status = await collectIndexStatus(root);

    expect(status.retrievalMode).toMatch(/^keyword/);
    expect(status.keywordCause).toBe('configured-provider-unrealized');
    expect(status.configuredProvider).toBe('all-MiniLM-L6-v2');
  });

  it('distinguishes the unconfigured keyword default from that finding', async () => {
    await withIndex(false);
    await writeConfig(null);

    const status = await collectIndexStatus(root);

    expect(status.keywordCause).toBe('no-provider-configured');
    expect(status.configuredProvider).toBeNull();
  });

  it('names keyword chosen by configuration apart from the unconfigured default', async () => {
    await withIndex(false);
    await writeConfig({ provider: 'none' });

    const status = await collectIndexStatus(root);

    expect(status.keywordCause).toBe('keyword-by-configuration');
  });

  it('reports the semantic mode and no keyword cause when vectors are present', async () => {
    await withIndex(true);
    await writeConfig({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' });
    process.env.EMBED_BASE_URL = 'http://127.0.0.1:8765/v1';
    process.env.EMBED_MODEL = 'all-MiniLM-L6-v2';

    const status = await collectIndexStatus(root);

    expect(status.retrievalMode).toBe('remote-semantic');
    expect(status.keywordCause).toBeNull();
  });

  it('reports a missing index instead of crashing', async () => {
    await writeConfig(null);

    const status = await collectIndexStatus(root);

    expect(status.indexPresent).toBe(false);
    expect(status.retrievalMode).toBeNull();
    expect(status.builtAt).toBeNull();
  });

  it('carries a recorded embed failure and the last build degradations', async () => {
    const analysisDir = await withIndex(false);
    await writeConfig(null);
    await writeFile(join(analysisDir, 'analysis-indexes.json'), JSON.stringify({
      result: { functionIndex: 'degraded', textIndex: 'built', specIndex: 'built', degraded: [{ index: 'function', reason: 'endpoint unavailable' }] },
      embedFailure: { at: '2026-09-20T15:40:00.000Z', reason: 'fetch failed', endpoint: 'http://127.0.0.1:8765/v1' },
    }), 'utf-8');

    const status = await collectIndexStatus(root);

    expect(status.embedFailure).toMatchObject({ reason: 'fetch failed' });
    expect(status.degraded).toEqual([{ index: 'function', reason: 'endpoint unavailable' }]);
  });

  it('is read-only: no file in the analysis directory changes', async () => {
    const analysisDir = await withIndex(true);
    await writeConfig(null);
    const before = new Map<string, number>();
    for (const entry of await readdir(analysisDir)) {
      before.set(entry, (await stat(join(analysisDir, entry))).mtimeMs);
    }

    await collectIndexStatus(root);

    const after = await readdir(analysisDir);
    expect(after.sort()).toEqual([...before.keys()].sort());
    for (const entry of after) {
      expect((await stat(join(analysisDir, entry))).mtimeMs).toBe(before.get(entry));
    }
  });

  it('offers the optional semantic upgrade to a human, never in --json', async () => {
    await withIndex(false);
    await writeConfig(null);
    const cwd = process.cwd();
    const run = async (args: string[]): Promise<string> => {
      const lines: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
      try {
        process.chdir(root);
        await statusCommand.parseAsync(['node', 'openlore', ...args]);
      } finally {
        console.log = log;
        process.chdir(cwd);
      }
      return lines.join('\n');
    };

    expect(await run([])).toContain('openlore embed --local');
    expect(await run(['--json'])).not.toContain('openlore embed');
  });

  // A raw UTC ISO stamp read as TOMORROW's date for anyone west of UTC in the evening, in a
  // panel where every other line is prose (change: fix-status-built-at-rendering).
  it('renders the build time relatively, not as a raw UTC ISO stamp', async () => {
    await withIndex(false);
    await writeConfig(null);
    const cwd = process.cwd();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      process.chdir(root);
      await statusCommand.parseAsync(['node', 'openlore']);
    } finally {
      console.log = log;
      process.chdir(cwd);
    }
    const built = lines.find(l => l.includes('Index built'));
    expect(built, 'the panel must report a build time').toBeDefined();
    expect(built).toMatch(/just now|ago/);
    expect(built, 'no raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('emits the same fields through --json', async () => {
    await withIndex(false);
    await writeConfig({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' });
    const cwd = process.cwd();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      process.chdir(root);
      await statusCommand.parseAsync(['node', 'openlore', '--json']);
    } finally {
      console.log = log;
      process.chdir(cwd);
    }

    const parsed = JSON.parse(lines.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      indexPresent: true,
      keywordCause: 'configured-provider-unrealized',
      configuredProvider: 'all-MiniLM-L6-v2',
    });
    expect(typeof parsed.retrievalMode).toBe('string');
    expect(Array.isArray(parsed.staleFiles)).toBe(true);
  });

  // change: default-decision-autopilot-with-visible-trace
  it('reports the governance block: mode, counts, newest ledger entries, and the review command', async () => {
    await writeConfig(null);
    const configPath = join(root, '.openlore', 'config.json');
    await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, 'utf8')), governance: { autopilot: true } }));
    await mkdir(join(root, '.openlore', 'decisions'), { recursive: true });
    await writeFile(join(root, '.openlore', 'decisions', 'pending.json'), JSON.stringify({
      decisions: [{ id: 'aaaa1111', status: 'auto-approved' }],
    }));
    await writeFile(join(root, '.openlore', 'decisions', 'ledger.jsonl'), JSON.stringify({
      id: 'aaaa1111', title: 'Use UUIDs', from: null, to: 'auto-approved', actor: 'agent', at: '2026-10-31T00:00:00.000Z',
    }) + '\n');
    const cwd = process.cwd();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      process.chdir(root);
      await statusCommand.parseAsync(['node', 'openlore']);
    } finally {
      console.log = log;
      process.chdir(cwd);
    }
    const text = lines.join('\n');
    expect(text).toContain('Decision autopilot');
    expect(text).toContain('governance.autopilot is true — set it to false to require review');
    expect(text).toContain('1 auto-accepted, 1 unreviewed');
    expect(text).toContain('[aaaa1111] ∅ → auto-approved by agent');
    expect(text).toContain('openlore decisions review');
    // The status line's shared collector stays cheap: no governance block there.
    expect((await collectIndexStatus(root)).governance).toBeUndefined();
  });

  it('reports the wiring scope, in text and through --json', async () => {
    const home = join(root, 'home');
    await mkdir(home);
    expect(await collectWiringScope(root, home)).toBe('none');
    await writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp'] } },
      _openlore: { managed: true, version: 1, paths: ['mcpServers.openlore'] },
    }));
    expect(await collectWiringScope(root, home)).toBe('repo only');

    const savedHome = process.env.OPENLORE_HOME;
    process.env.OPENLORE_HOME = home;
    const cwd = process.cwd();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      process.chdir(root);
      await statusCommand.parseAsync(['node', 'openlore', '--json']);
      expect((JSON.parse(lines.join('\n')) as Record<string, unknown>).wiringScope).toBe('repo only');
      await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { openlore: { command: 'npx', args: [] } } }));
      lines.length = 0;
      await statusCommand.parseAsync(['node', 'openlore']);
      expect(lines.join('\n')).toMatch(/Wiring scope\s+user \+ repo/);
    } finally {
      console.log = log;
      process.chdir(cwd);
      if (savedHome === undefined) delete process.env.OPENLORE_HOME; else process.env.OPENLORE_HOME = savedHome;
    }
  });

  it('reports unknown freshness when git is unavailable rather than claiming current', async () => {
    // `root` is a bare temp directory: `git status` there fails, which must degrade to
    // "nothing known" instead of taking down a read-only command.
    await withIndex(true, '2020-01-01T00:00:00.000Z');
    await writeConfig(null);

    const status = await collectIndexStatus(root);

    expect(status.staleFiles).toEqual([]);
    expect(status.staleFilesTruncated).toBe(false);
    expect(status.staleFilesUnknown).toBe(true);
  });

  it('keeps unusual git filenames intact and reports deleted indexed files', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await writeFile(join(root, 'removed.ts'), 'export function removed() {}\n');
    await writeFile(join(root, 'before-rename.ts'), 'export function renamed() {}\n');
    execFileSync('git', ['add', 'removed.ts', 'before-rename.ts'], { cwd: root });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline'], { cwd: root });
    await withIndex(false, '2020-01-01T00:00:00.000Z');
    await writeConfig(null);
    // Windows filenames cannot contain quotes; still exercise spaces there.
    const unusual = process.platform === 'win32' ? 'quoted name.ts' : 'quoted "name"\n.ts';
    await writeFile(join(root, unusual), 'export function unusual() {}\n');
    await mkdir(join(root, 'new-directory'));
    await writeFile(join(root, 'new-directory', 'added.ts'), 'export function added() {}\n');
    await rm(join(root, 'removed.ts'));
    execFileSync('git', ['mv', 'before-rename.ts', 'after-rename.ts'], { cwd: root });

    const status = await collectIndexStatus(root);

    expect(status.staleFiles).toContain(unusual);
    expect(status.staleFiles).toContain('new-directory/added.ts');
    expect(status.staleFiles).toContain('removed.ts');
    expect(status.staleFiles).toContain('before-rename.ts');
    expect(status.staleFiles).toContain('after-rename.ts');
  });
});

describe('openlore status — loop hook moments (change: hook-reliability)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'openlore-status-hooks-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /** The groups `openlore install` writes: the prompt group has no `_openloreHook`. */
  const installed = async (): Promise<void> => {
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'my-own-hook' }] },
        { _openlore: true, hooks: [{ type: 'command', command: 'openlore orient --inject', timeout: 15 }] },
      ],
      PreToolUse: [{ _openlore: true, _openloreHook: 'before-edit', matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'openlore hook before-edit' }] }],
      Stop: [{ _openlore: true, _openloreHook: 'before-stop', hooks: [{ type: 'command', command: 'openlore hook before-stop' }] }],
    } }));
  };
  const config = async (cfg: Record<string, unknown>): Promise<void> => {
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify(cfg));
  };
  const wired = () => collectHookMoments(root).filter(m => m.wired).map(m => `${m.moment}${m.enabled ? '' : ' (off)'}`);

  it('lists prompt-submitted first among the wired moments', async () => {
    await installed();
    expect(wired()).toEqual(['prompt-submitted', 'before-edit', 'before-stop']);
  });

  it('a user hook on UserPromptSubmit is not the moment', async () => {
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x' }] }, { _openlore: 'yes', hooks: [] }] } }));
    expect(wired()).toEqual([]);
  });

  it('marks it off by its own switch or by contextInjection.mode "off"', async () => {
    await installed();
    await config({ hooks: { 'prompt-submitted': false } });
    expect(wired()).toEqual(['prompt-submitted (off)', 'before-edit', 'before-stop']);
    await config({ contextInjection: { mode: 'off' } });
    expect(wired()).toEqual(['prompt-submitted (off)', 'before-edit', 'before-stop']);
    await config({ hooks: { 'before-stop': false } });
    expect(wired()).toEqual(['prompt-submitted', 'before-edit', 'before-stop (off)']);
  });

  it('reads an unreadable config as every moment on', async () => {
    await installed();
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'config.json'), '{"hooks": {');
    expect(wired()).toEqual(['prompt-submitted', 'before-edit', 'before-stop']);
  });
});

describe('openlore status — hook health (change: hook-reliability, task 6.2)', () => {
  it('formats one line: last run and p95 per moment, then errors, overruns, findings shown', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    const line = formatHookHealth([
      { moment: 'prompt-submitted', runs: 3, lastRun: new Date(now - 120_000).toISOString(), p95Ms: 940, errors: 1, overruns: 0, shown: 0 },
      { moment: 'after-tools', runs: 5, lastRun: new Date(now - 30_000).toISOString(), p95Ms: 430, errors: 0, overruns: 2, shown: 4 },
    ], now);
    expect(line).toBe('prompt-submitted 2 minutes ago, p95 0.9 s; after-tools just now, p95 0.4 s — 1 error(s), 2 overrun(s), 4 finding(s) shown (last 7 days)');
  });

  it('with outcomes, counts each distinct finding and says what happened to it', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    const line = formatHookHealth([
      { moment: 'after-tools', runs: 2, lastRun: new Date(now - 30_000).toISOString(), p95Ms: 430, errors: 0, overruns: 0, shown: 3 },
    ], now, { total: 3, fixed: 1, decided: 1, open: 0, notAssessed: 1 });
    expect(line).toBe('after-tools just now, p95 0.4 s — 0 error(s), 0 overrun(s), 3 finding(s) shown: 1 fixed, 1 decided, 0 open, 1 not assessed (last 7 days)');
  });

  it('--json carries hookHealth when runs were recorded, and omits it otherwise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-status-health-'));
    const cwd = process.cwd();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      process.chdir(root);
      await statusCommand.parseAsync(['node', 'openlore', '--json']);
      expect((JSON.parse(lines.join('\n')) as Record<string, unknown>).hookHealth).toBeUndefined();
      await mkdir(join(root, '.openlore', 'session-ledger'), { recursive: true });
      await writeFile(join(root, '.openlore', 'session-ledger', 'hook-runs.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), moment: 'before-edit', ms: 300, outcome: 'overrun', shown: 0 })}\n`);
      lines.length = 0;
      await statusCommand.parseAsync(['node', 'openlore', '--json']);
      expect((JSON.parse(lines.join('\n')) as { hookHealth: unknown[] }).hookHealth).toEqual([
        expect.objectContaining({ moment: 'before-edit', runs: 1, overruns: 1 }),
      ]);
      lines.length = 0;
      await statusCommand.parseAsync(['node', 'openlore']);
      expect(lines.join('\n')).toMatch(/Hook health\s+before-edit just now, p95 0\.3 s — 0 error\(s\), 1 overrun\(s\), 0 finding\(s\) shown/);
      // A failed run's reason is shown, so an error count can be acted on.
      await writeFile(join(root, '.openlore', 'session-ledger', 'hook-runs.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), moment: 'before-stop', ms: 300, outcome: 'error', shown: 0, reason: 'TypeError: x is not a function' })}\n`, { flag: 'a' });
      lines.length = 0;
      await statusCommand.parseAsync(['node', 'openlore']);
      expect(lines.join('\n')).toMatch(/1 error\(s\), 1 overrun\(s\).*last error: before-stop just now: TypeError: x is not a function/);
    } finally {
      console.log = log;
      process.chdir(cwd);
      await rm(root, { recursive: true, force: true });
    }
  });
});

// change: trim-standing-agent-instructions — an older generated CLAUDE.md holds the full-digest
// `@`-import outside any marker; install leaves it alone, and status names it once, only while
// the slim digest really reaches the agent (`slimDigestReachesAgent`, tested on its own).
describe('openlore status — a legacy full-digest import', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'openlore-status-legacy-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const reaches = async () => true;
  const doesNotReach = async () => false;
  async function withDigest(): Promise<void> {
    await mkdir(join(root, ANALYSIS), { recursive: true });
    await writeFile(join(root, ANALYSIS, 'CODEBASE.md'), 'x'.repeat(11_126), 'utf-8');
  }

  it('names a legacy import line and the digest size, without a shell command', async () => {
    await withDigest();
    await writeFile(join(root, 'CLAUDE.md'), '# demo — AI context (generated by openlore)\n\n@.openlore/analysis/CODEBASE.md\n\n## notes\n', 'utf-8');

    const found = await findLegacyDigestImport(root, reaches);
    expect(found).toEqual({ file: 'CLAUDE.md', lines: [3], digestBytes: 11_126 });
    const line = formatLegacyDigestImport(found!);
    expect(line).toContain('CLAUDE.md:3 imports .openlore/analysis/CODEBASE.md (11,126 bytes)');
    expect(line).toContain('Delete line 3 of CLAUDE.md.');
    expect(line).not.toContain('sed');
    // Read-only: status never edits the file.
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf-8')).toContain('@.openlore/analysis/CODEBASE.md');
  });

  it('says nothing when the slim digest does not reach the agent: the import is its only repository shape', async () => {
    await withDigest();
    await writeFile(join(root, 'CLAUDE.md'), '@.openlore/analysis/CODEBASE.md\n', 'utf-8');
    expect(await findLegacyDigestImport(root, doesNotReach)).toBeNull();
  });

  /** The real delivery check end to end: a digest analyze would write, and the prompt hook wired or not. */
  async function statusThroughRealCheck(wired: boolean, args: string[] = [], line = '@.openlore/analysis/CODEBASE.md'): Promise<string> {
    await withDigest();
    await writeFile(join(root, ANALYSIS, 'llm-context.json'), '{}', 'utf-8');
    await writeFile(join(root, ANALYSIS, 'CODEBASE.slim.md'), renderSlimDigest({
      counts: { functions: 12, pairs: 30 },
      hubs: [{ name: 'parseConfig', file: 'src/config.ts', callers: 9 }],
      callGraphLanguages: ['TypeScript'],
      fullDigestPath: '.openlore/analysis/CODEBASE.md',
    }), 'utf-8');
    if (wired) {
      await mkdir(join(root, '.claude'), { recursive: true });
      await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({
        hooks: { UserPromptSubmit: [{ _openlore: true, hooks: [{ type: 'command', command: 'npx --yes openlore orient --inject' }] }] },
      }), 'utf-8');
    }
    await writeFile(join(root, 'CLAUDE.md'), `# demo\n\n${line}\n`, 'utf-8');
    const cwd = process.cwd();
    const lines: string[] = [];
    const log = console.log;
    const home = process.env.OPENLORE_HOME;
    process.env.OPENLORE_HOME = join(root, 'no-home');
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      process.chdir(root);
      await statusCommand.parseAsync(['node', 'openlore', ...args]);
    } finally {
      console.log = log;
      process.chdir(cwd);
      if (home === undefined) delete process.env.OPENLORE_HOME; else process.env.OPENLORE_HOME = home;
    }
    return lines.join('\n');
  }

  it('prints the note once, and the JSON field, when the prompt hook delivers the slim digest', async () => {
    const out = await statusThroughRealCheck(true);
    expect(out.split('\n').filter(line => line.includes('Legacy import'))).toHaveLength(1);
    expect(out).toContain('CLAUDE.md:3 imports .openlore/analysis/CODEBASE.md (11,126 bytes)');
  });

  it('puts the finding in status --json for agents', async () => {
    const json = JSON.parse(await statusThroughRealCheck(true, ['--json']));
    expect(json.legacyDigestImport).toEqual({ file: 'CLAUDE.md', lines: [3], digestBytes: 11_126 });
  });

  it('prints nothing, and no JSON field, when no prompt hook is wired', async () => {
    expect(await statusThroughRealCheck(false)).not.toContain('Legacy import');
    await rm(join(root, 'CLAUDE.md'));
    await writeFile(join(root, 'CLAUDE.md'), '# demo\n\n@.openlore/analysis/CODEBASE.md\n', 'utf-8');
    expect(JSON.parse(await statusThroughRealCheck(false, ['--json'])).legacyDigestImport).toBeUndefined();
  });

  it('says nothing for a file the new generator wrote', async () => {
    await withDigest();
    await writeFile(join(root, 'CLAUDE.md'), '# demo\n\nFull repository digest, for a task that needs it: `.openlore/analysis/CODEBASE.md`.\n', 'utf-8');
    expect(await findLegacyDigestImport(root, reaches)).toBeNull();
  });

  it('ignores an import inside the managed block, a code fence, or an indented code block', async () => {
    await withDigest();
    const block = renderBlock('managed\n@.openlore/analysis/CODEBASE.md');
    const file = [
      '@.openlore/analysis/CODEBASE.md',          // 1: counted
      block,
      '```md',
      '```md',                                    // an info string does not close a fence
      '@.openlore/analysis/CODEBASE.md',          // in a fence
      '```',
      '    @.openlore/analysis/CODEBASE.md',      // indented code block
      '@.openlore/analysis/CODEBASE.md  ',        // counted
    ].join('\r\n');
    await writeFile(join(root, 'CLAUDE.md'), file, 'utf-8');
    const blockLines = block.split('\n').length;
    const found = await findLegacyDigestImport(root, reaches);
    expect(found?.lines).toEqual([1, blockLines + 7]);
    expect(formatLegacyDigestImport(found!)).toContain(`CLAUDE.md lines 1, ${blockLines + 7} import .openlore/analysis/CODEBASE.md`);
    expect(formatLegacyDigestImport(found!)).toContain(`Delete lines 1, ${blockLines + 7} of CLAUDE.md.`);
  });

  it('a fence closes only on the same character, at least as long', async () => {
    await withDigest();
    const file = [
      '````md', '```', '@.openlore/analysis/CODEBASE.md', '````',   // three backticks do not close four
      '~~~', '```', '@.openlore/analysis/CODEBASE.md', '~~~',       // backticks do not close tildes
      '@.openlore/analysis/CODEBASE.md',                            // line 9: counted
    ].join('\n');
    await writeFile(join(root, 'CLAUDE.md'), file, 'utf-8');
    expect((await findLegacyDigestImport(root, reaches))?.lines).toEqual([9]);
  });

  it('skips an import inside a multi-line HTML comment', async () => {
    await withDigest();
    await writeFile(join(root, 'CLAUDE.md'), ['<!--', '@.openlore/analysis/CODEBASE.md', '-->', '@.openlore/analysis/CODEBASE.md'].join('\n'), 'utf-8');
    expect((await findLegacyDigestImport(root, reaches))?.lines).toEqual([4]);
  });

  it('names a generated pointer line when the slim digest does not reach the agent', async () => {
    await withDigest();
    await writeFile(join(root, 'CLAUDE.md'), '# demo\n\nFull repository digest, for a task that needs it: `.openlore/analysis/CODEBASE.md`.\n', 'utf-8');
    const notes = await findDigestNotes(root, doesNotReach);
    expect(notes).toEqual({ unservedDigestPointer: { file: 'CLAUDE.md', lines: [3] } });
    const line = formatUnservedDigestPointer(notes.unservedDigestPointer!);
    expect(line).toContain('CLAUDE.md:3 names .openlore/analysis/CODEBASE.md instead of importing it');
    expect(line).toContain('Replace the line with @.openlore/analysis/CODEBASE.md');
    // While the digest reaches the agent, the pointer is right and nothing is said.
    expect(await findDigestNotes(root, reaches)).toEqual({});
  });

  it('prints the pointer note through the real delivery check when no hook is wired', async () => {
    const out = await statusThroughRealCheck(false, [], 'Full repository digest, for a task that needs it: `.openlore/analysis/CODEBASE.md`.');
    expect(out.split('\n').filter(line => line.includes('Digest pointer'))).toHaveLength(1);
    expect(await statusThroughRealCheck(true, [], 'Full repository digest, for a task that needs it: `.openlore/analysis/CODEBASE.md`.')).not.toContain('Digest pointer');
  });

  it('says nothing when CODEBASE.md is a symlink, and caps a long line list', async () => {
    await withDigest();
    await writeFile(join(root, 'CLAUDE.md'), Array.from({ length: 12 }, () => '@.openlore/analysis/CODEBASE.md').join('\n'), 'utf-8');
    const found = await findLegacyDigestImport(root, reaches);
    expect(found?.lines).toHaveLength(12);
    expect(formatLegacyDigestImport(found!)).toContain('CLAUDE.md lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and 2 more import');
    if (process.platform !== 'win32') {
      await rm(join(root, ANALYSIS, 'CODEBASE.md'));
      await writeFile(join(root, 'outside.md'), 'x'.repeat(777), 'utf-8');
      await symlink(join(root, 'outside.md'), join(root, ANALYSIS, 'CODEBASE.md'));
      expect(await findLegacyDigestImport(root, reaches)).toBeNull();
    }
  });

  it('says nothing without a CLAUDE.md or without the full digest', async () => {
    expect(await findLegacyDigestImport(root, reaches)).toBeNull();
    await writeFile(join(root, 'CLAUDE.md'), '@.openlore/analysis/CODEBASE.md\n', 'utf-8');
    expect(await findLegacyDigestImport(root, reaches)).toBeNull();
  });
});
