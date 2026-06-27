/**
 * Tests for `openlore install`'s one-command setup: after wiring agent surfaces
 * it should build the index (init + analyze) so orient() works on the first
 * session, unless --no-analyze (analyze: false) is passed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from './index.js';
import { logger } from '../../utils/logger.js';

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe('openlore install — auto index build', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-install-analyze-'));
    // A minimal but real TS project so analyze has something to index.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0' }));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'index.ts'),
      'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n'
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('default install builds the index (.openlore + vector-index) so orient works immediately', async () => {
    const code = await runInstall({ cwd: dir, agent: 'claude-code' });
    expect(code).toBe(0);
    // Surfaces wired…
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true);
    // …AND the index was built (init created config; analyze wrote the index).
    expect(await exists(join(dir, '.openlore/config.json'))).toBe(true);
    expect(await exists(join(dir, '.openlore/analysis/vector-index'))).toBe(true);
  }, 30_000);

  it('--no-analyze (analyze:false) configures surfaces but does NOT build the index', async () => {
    const code = await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(code).toBe(0);
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true);
    // No analysis artifacts produced.
    expect(await exists(join(dir, '.openlore/analysis/vector-index'))).toBe(false);
  });

  it('--no-analyze advises a next step that actually works (init is skipped too)', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });

    // --no-analyze skips init as well, so no config is written…
    expect(await exists(join(dir, '.openlore/config.json'))).toBe(false);

    // …which is exactly why the next-step must not be a bare "openlore analyze"
    // (that fails with "Run openlore init first"). It must include init.
    const nextStep = infoSpy.mock.calls.find(([key]) => key === 'Next step')?.[1];
    expect(nextStep, 'install --no-analyze should print a Next step').toBeDefined();
    expect(String(nextStep)).toContain('openlore init');
    expect(String(nextStep)).toContain('openlore analyze');
    infoSpy.mockRestore();
  });

  it('dry-run never builds the index', async () => {
    const code = await runInstall({ cwd: dir, agent: 'claude-code', dryRun: true });
    expect(code).toBe(0);
    expect(await exists(join(dir, '.openlore'))).toBe(false);
  });

  // Regression (v2.1.4 QA): install runs analyze with `--embedded`, so analyze must NOT
  // print its agent-onboarding epilogue. Before the fix, a user running `openlore install`
  // saw "Agent config files: not generated / Re-run with --ai-configs" and "Run 'openlore
  // generate'" — directly contradicting install's own "[did create] AGENTS.md" / "Index
  // built" output. Capture every stream install/analyze write to (buildIndex routes
  // analyze's console.log through process.stderr.write) and assert those lines are gone.
  it('does NOT print analyze\'s contradictory agent-onboarding epilogue (it wires agents itself)', async () => {
    const chunks: string[] = [];
    const push = (...a: unknown[]): boolean => { chunks.push(a.map(String).join(' ')); return true; };
    const so = vi.spyOn(process.stdout, 'write').mockImplementation(push as unknown as typeof process.stdout.write);
    const se = vi.spyOn(process.stderr, 'write').mockImplementation(push as unknown as typeof process.stderr.write);
    const cl = vi.spyOn(console, 'log').mockImplementation(push);
    const ce = vi.spyOn(console, 'error').mockImplementation(push);
    try {
      const code = await runInstall({ cwd: dir, agent: 'claude-code' });
      expect(code).toBe(0);
    } finally {
      so.mockRestore(); se.mockRestore(); cl.mockRestore(); ce.mockRestore();
    }
    const out = chunks.join('\n');
    expect(out).not.toContain('Agent config files: not generated');
    expect(out).not.toContain('Agent setup (one-time)');
    expect(out).not.toContain("Run 'openlore generate'");
  }, 30_000);
});
