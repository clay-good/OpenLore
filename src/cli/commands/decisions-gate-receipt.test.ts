/**
 * The decisions gate must let a commit through once consolidation has run on exactly
 * what is staged — even when consolidation honestly found nothing, and even when the
 * working tree holds untracked or unstaged source files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Command, Option } from 'commander';

vi.mock('../../core/decisions/extractor.js', () => ({ extractFromDiff: vi.fn(async () => []) }));
vi.mock('../../core/services/llm-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/llm-service.js')>()),
  createLLMService: vi.fn(() => ({})),
}));

const { decisionsCommand } = await import('./decisions.js');

function resetCommanderState(root: Command): void {
  for (const c of [root, ...root.commands]) {
    for (const o of (c as unknown as { options: Option[] }).options) c.setOptionValue(o.attributeName(), o.defaultValue);
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore', windowsHide: true });

describe('decisions gate consolidation receipt', () => {
  let dir: string;
  let prevCwd: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-gate-receipt-')));
    git(dir, 'init', '-q');
    mkdirSync(join(dir, '.openlore'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0', projectType: 'nodejs', openspecPath: 'openspec',
      analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'anthropic', model: 'claude-sonnet-4-6', domains: 'auto' },
      createdAt: '2026-10-17T00:00:00Z', lastRun: null,
    }));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
    git(dir, 'add', 'src/b.ts');
    // An untracked scratch file: normal in real work, and not part of the commit.
    writeFileSync(join(dir, 'src', 'scratch.ts'), 'export const s = 3;\n');
    prevCwd = process.cwd();
    process.chdir(dir);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
    resetCommanderState(decisionsCommand);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    stdoutSpy.mockRestore();
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the gate after a consolidation that found no decision', async () => {
    await decisionsCommand.parseAsync(['--consolidate', '--gate', '--json'], { from: 'user' });
    expect(process.exitCode ?? 0).toBe(0);
    resetCommanderState(decisionsCommand);
    stdoutSpy.mockClear();
    await decisionsCommand.parseAsync(['--gate', '--json'], { from: 'user' });
    const out = stdoutSpy.mock.calls.map(([c]: unknown[]) => String(c)).join('');
    expect(out).not.toContain('no_decisions_recorded');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('keeps progress lines off stdout in --gate mode', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log');
    try {
      await decisionsCommand.parseAsync(['--consolidate', '--gate'], { from: 'user' });
      const out = [...stdoutSpy.mock.calls, ...log.mock.calls].map(([c]: unknown[]) => String(c)).join('');
      expect(out).not.toContain('extracting decisions from diff');
      expect(stderr.mock.calls.map(([c]: unknown[]) => String(c)).join('')).toContain('extracting decisions from diff');
    } finally {
      stderr.mockRestore();
      log.mockRestore();
    }
  });
});
