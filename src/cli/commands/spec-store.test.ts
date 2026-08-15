/**
 * `openlore spec-store status` CLI — read-only, advisory, machine-readable
 * findings (change: add-spec-store-binding). Exercises runSpecStoreStatusCli
 * directly (the command action calls process.exit, which a unit test must avoid).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSpecStoreStatusCli } from './spec-store.js';
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
  scratch = mkdtempSync(join(tmpdir(), 'specstore-cli-'));
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

describe('spec-store status CLI', () => {
  it('emits machine-readable findings and always exits 0 (--json, unresolved target)', async () => {
    const api = makeRepo('api', 'h');
    addRepo(home, api, { name: 'api' });
    mkdirSync(join(scratch, 'plans'), { recursive: true });
    writeBinding({ name: 'plans', path: join(scratch, 'plans'), targets: ['api', 'web'] });

    const out = captureStdout();
    const code = await runSpecStoreStatusCli({ cwd: home, json: true });
    out.restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(out.calls.join(''));
    expect(parsed.bound).toBe(true);
    expect(parsed.findings.some((f: { code: string }) => f.code === 'target-unresolved')).toBe(true);
  });

  it('reports no binding configured and exits 0', async () => {
    // config with no specStore block
    mkdirSync(join(home, OPENLORE_DIR), { recursive: true });
    writeFileSync(
      join(home, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME),
      JSON.stringify({ version: '1.0.0', projectType: 'unknown', openspecPath: 'openspec', analysis: { maxFiles: 1, includePatterns: [], excludePatterns: [] }, generation: { model: 'x', domains: 'auto' }, createdAt: new Date().toISOString(), lastRun: null }),
    );

    const out = captureStdout();
    const code = await runSpecStoreStatusCli({ cwd: home, json: true });
    out.restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(out.calls.join(''));
    expect(parsed.bound).toBe(false);
    expect(parsed.findings[0].code).toBe('no-binding');
  });
});
