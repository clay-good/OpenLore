/**
 * Tests for the `analyze_env_impact` handler (change: add-env-config-impact-graph).
 *
 * Drives the handler over a hand-written analysis cache (llm-context.json) + env
 * inventory (env-inventory.json) with a small call graph, so the test is
 * deterministic and offline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the git-based staleness signal so the disclosure path is deterministic and
// offline (real computeStaleness reads a build commit + git diff). Default: clean
// (undefined) so the non-stale tests see no false staleness boundary.
vi.mock('./confidence-boundary.js', () => ({ computeStaleness: vi.fn(async () => undefined) }));

import { handleAnalyzeEnvImpact } from './env-impact.js';
import { computeStaleness } from './confidence-boundary.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_ENV_INVENTORY,
} from '../../../constants.js';

const DB = `function connect() {
  const url = process.env.DATABASE_URL;
  return url;
}
function startServer() {
  return connect();
}
`;

const CONFIG = `const level = process.env.LOG_LEVEL;
export function getLevel() {
  return level;
}
`;

interface Node {
  id: string;
  name: string;
  filePath: string;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  language: string;
  isExternal?: boolean;
  isTest?: boolean;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'envimpact-'));
  writeFileSync(join(dir, 'db.ts'), DB, 'utf-8');
  writeFileSync(join(dir, 'config.ts'), CONFIG, 'utf-8');

  const nodes: Node[] = [
    { id: 'connect', name: 'connect', filePath: 'db.ts', startIndex: 0, endIndex: 60, startLine: 1, endLine: 4, language: 'TypeScript' },
    { id: 'startServer', name: 'startServer', filePath: 'db.ts', startIndex: 61, endIndex: 110, startLine: 5, endLine: 7, language: 'TypeScript' },
    { id: 'connectsTest', name: 'connects', filePath: 'db.test.ts', startIndex: 0, endIndex: 30, startLine: 1, endLine: 3, language: 'TypeScript', isTest: true },
    { id: 'getLevel', name: 'getLevel', filePath: 'config.ts', startIndex: 0, endIndex: 50, startLine: 2, endLine: 4, language: 'TypeScript' },
  ];
  const edges = [
    { callerId: 'startServer', calleeId: 'connect', calleeName: 'connect', line: 6, confidence: 'import' },
    { callerId: 'connectsTest', calleeId: 'connect', calleeName: 'connect', line: 2, confidence: 'import' },
  ];

  const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(join(analysisDir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges } }), 'utf-8');
  writeFileSync(
    join(analysisDir, ARTIFACT_ENV_INVENTORY),
    JSON.stringify([
      { name: 'DATABASE_URL', files: ['db.ts'], hasDefault: false, required: true },
      { name: 'LOG_LEVEL', files: ['config.ts'], hasDefault: false, required: true },
    ]),
    'utf-8',
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleAnalyzeEnvImpact', () => {
  it('reports the read site, blast radius, and reaching tests for a read var', async () => {
    const r = (await handleAnalyzeEnvImpact({ directory: dir, name: 'DATABASE_URL' })) as Record<string, any>;
    expect(r.error).toBeUndefined();
    expect(r.variable.name).toBe('DATABASE_URL');

    // Read site located to connect at line 2, required (no fallback).
    expect(r.readSites).toEqual([
      { file: 'db.ts', line: 2, required: true, enclosingFunction: 'connect::db.ts' },
    ]);

    // Upstream caller startServer is in the blast radius; the test is a reaching test.
    expect(r.affectedFunctions.map((f: any) => f.symbol)).toContain('startServer::db.ts');
    expect(r.reachingTests.map((t: any) => t.test)).toContain('connects');
    expect(r.summary.requiredReadSites).toBe(1);
    expect(r.summary.moduleLevelReadSites).toBe(0);
  });

  it('returns not-found with candidates for an unknown var', async () => {
    const r = (await handleAnalyzeEnvImpact({ directory: dir, name: 'DATABSE_URL' })) as Record<string, any>;
    expect(r.error).toMatch(/No environment variable/);
    expect(r.candidates).toContain('DATABASE_URL');
  });

  it('discloses a module-level read as a boundary', async () => {
    const r = (await handleAnalyzeEnvImpact({ directory: dir, name: 'LOG_LEVEL' })) as Record<string, any>;
    expect(r.error).toBeUndefined();
    expect(r.readSites[0].enclosingFunction).toBeNull();
    expect(r.summary.moduleLevelReadSites).toBe(1);
    expect(r.boundaries.some((b: string) => /module-level/.test(b))).toBe(true);
  });

  it('errors when name is missing', async () => {
    const r = (await handleAnalyzeEnvImpact({ directory: dir })) as Record<string, any>;
    expect(r.error).toMatch(/Provide `name`/);
  });

  it('always discloses the config-key out-of-scope boundary', async () => {
    const r = (await handleAnalyzeEnvImpact({ directory: dir, name: 'DATABASE_URL' })) as Record<string, any>;
    expect(r.boundaries.some((b: string) => /Config-object key reads.*OUT OF SCOPE/.test(b))).toBe(true);
  });

  it('discloses a staleness boundary + marker when the index is stale (attribution may be off)', async () => {
    vi.mocked(computeStaleness).mockResolvedValueOnce({
      indexCommit: 'abc1234',
      filesChangedSince: 3,
      detail: 'Computed against the index built at commit abc1234; 3 source file(s) changed since.',
    });
    const r = (await handleAnalyzeEnvImpact({ directory: dir, name: 'DATABASE_URL' })) as Record<string, any>;
    expect(r.staleness).toMatchObject({ indexCommit: 'abc1234', filesChangedSince: 3 });
    expect(r.boundaries.some((b: string) => /Index may be stale.*attribution.*may be off/s.test(b))).toBe(true);
  });

  it('does NOT add a staleness boundary on a clean index', async () => {
    const r = (await handleAnalyzeEnvImpact({ directory: dir, name: 'DATABASE_URL' })) as Record<string, any>;
    expect(r.staleness).toBeUndefined();
    expect(r.boundaries.some((b: string) => /Index may be stale/.test(b))).toBe(false);
  });
});
