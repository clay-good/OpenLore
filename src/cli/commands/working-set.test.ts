/**
 * `openlore working-set context` CLI — read-only, advisory, machine-readable
 * briefing (change: add-working-set-context-briefing). Exercises
 * runWorkingSetContextCli directly (the command action calls process.exit, which
 * a unit test must avoid).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkingSetContextCli } from './working-set.js';
import { addRepo } from '../../core/federation/registry.js';
import {
  OPENLORE_DIR,
  OPENLORE_CONFIG_FILENAME,
  OPENLORE_ANALYSIS_REL_PATH,
  ARTIFACT_FINGERPRINT,
} from '../../constants.js';

let scratch: string;
let home: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'workingset-cli-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureStdout(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    calls.push(String(chunk));
    return true;
  });
  return { calls, restore: () => spy.mockRestore() };
}

function writeBinding(binding: unknown): void {
  mkdirSync(join(home, OPENLORE_DIR), { recursive: true });
  writeFileSync(
    join(home, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME),
    JSON.stringify({
      version: '1.0.0', projectType: 'unknown', openspecPath: 'openspec',
      analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
      generation: { model: 'x', domains: 'auto' },
      createdAt: new Date().toISOString(), lastRun: null,
      specStore: binding,
    }),
  );
}

function makeRepo(name: string, fingerprint: string): string {
  const repoPath = join(scratch, name);
  mkdirSync(join(repoPath, OPENLORE_ANALYSIS_REL_PATH), { recursive: true });
  writeFileSync(join(repoPath, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT), JSON.stringify({ hash: fingerprint }));
  return repoPath;
}

function writeChange(storePath: string, id: string, proposal: string): void {
  const changeDir = join(storePath, 'openspec', 'changes', id);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, 'proposal.md'), proposal);
}

describe('working-set context CLI', () => {
  it('emits a machine-readable briefing and always exits 0 (--json)', async () => {
    const api = makeRepo('api', 'h');
    addRepo(home, api, { name: 'api' });
    const store = join(scratch, 'plans');
    mkdirSync(store, { recursive: true });
    writeBinding({ name: 'plans', path: store, targets: ['api'] });
    writeChange(store, 'feat-x', '# Feat X\n\n## Why\n\nReason for X.');

    const out = captureStdout();
    const code = await runWorkingSetContextCli({ cwd: home, change: 'feat-x', json: true });
    out.restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(out.calls.join(''));
    expect(parsed.bound).toBe(true);
    expect(parsed.change.id).toBe('feat-x');
  });

  it('reports no binding configured and exits 0', async () => {
    mkdirSync(join(home, OPENLORE_DIR), { recursive: true });
    writeFileSync(
      join(home, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME),
      JSON.stringify({ version: '1.0.0', projectType: 'unknown', openspecPath: 'openspec', analysis: { maxFiles: 1, includePatterns: [], excludePatterns: [] }, generation: { model: 'x', domains: 'auto' }, createdAt: new Date().toISOString(), lastRun: null }),
    );

    const out = captureStdout();
    const code = await runWorkingSetContextCli({ cwd: home, change: 'feat-x', json: true });
    out.restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(out.calls.join(''));
    expect(parsed.bound).toBe(false);
    expect(parsed.findings[0].code).toBe('no-binding');
  });
});
