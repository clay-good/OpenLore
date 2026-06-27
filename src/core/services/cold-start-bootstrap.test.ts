import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapAnalysisInBackground } from './cold-start-bootstrap.js';
import { OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';

const dirs: string[] = [];
function freshDir(withAnalysis = false): string {
  const d = mkdtempSync(join(tmpdir(), 'openlore-cold-'));
  dirs.push(d);
  if (withAnalysis) {
    mkdirSync(join(d, OPENLORE_ANALYSIS_REL_PATH), { recursive: true });
    writeFileSync(join(d, OPENLORE_ANALYSIS_REL_PATH, 'llm-context.json'), '{}');
  }
  return d;
}

afterEach(() => {
  delete process.env.OPENLORE_NO_AUTO_ANALYZE;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bootstrapAnalysisInBackground', () => {
  it('runs the analyzer once when no index exists', async () => {
    const dir = freshDir(false);
    let calls = 0;
    const seen = new Set<string>();
    const p = bootstrapAnalysisInBackground(dir, { seen, analyze: async () => { calls++; }, log: () => {} });
    expect(p).not.toBeNull();
    await p;
    expect(calls).toBe(1);
  });

  it('does nothing when an index already exists', () => {
    const dir = freshDir(true);
    const seen = new Set<string>();
    const p = bootstrapAnalysisInBackground(dir, { seen, analyze: async () => { throw new Error('should not run'); }, log: () => {} });
    expect(p).toBeNull();
  });

  it('builds at most once per directory', async () => {
    const dir = freshDir(false);
    let calls = 0;
    const seen = new Set<string>();
    const opts = { seen, analyze: async () => { calls++; }, log: () => {} };
    await bootstrapAnalysisInBackground(dir, opts);
    const second = bootstrapAnalysisInBackground(dir, opts);
    expect(second).toBeNull();
    expect(calls).toBe(1);
  });

  it('is disabled by the opt-out env var', () => {
    process.env.OPENLORE_NO_AUTO_ANALYZE = '1';
    const dir = freshDir(false);
    expect(bootstrapAnalysisInBackground(dir, { seen: new Set(), analyze: async () => {}, log: () => {} })).toBeNull();
  });

  it('is fail-soft and clears its guard so a later call can retry', async () => {
    const dir = freshDir(false);
    const seen = new Set<string>();
    const logs: string[] = [];
    await bootstrapAnalysisInBackground(dir, {
      seen,
      analyze: async () => { throw new Error('boom'); },
      log: (m) => logs.push(m),
    });
    expect(seen.has(dir)).toBe(false); // guard cleared on failure
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
  });

  it('ignores an empty directory', () => {
    expect(bootstrapAnalysisInBackground('', { seen: new Set(), analyze: async () => {} })).toBeNull();
  });

  it('runs exactly the injected builder and nothing else (no hidden default)', async () => {
    const dir = freshDir(false);
    const ran: string[] = [];
    await bootstrapAnalysisInBackground(dir, {
      seen: new Set(),
      analyze: async (d) => { ran.push(d); },
      log: () => {},
    });
    // The directory is built once, by the caller's builder — there is no
    // module-internal fallback that could run a different (e.g. BM25-less) build.
    expect(ran).toEqual([dir]);
  });

  // Architectural invariant: this module must stay dependency-light and never
  // pick an index builder itself. A wrong-by-default builder hidden here (e.g.
  // one that skips the BM25 search corpus) silently half-warms orient. The
  // builder is REQUIRED and injected by the caller; guard that it never sneaks
  // an analyzer/install import back in.
  it('never imports the analyzer or install layer (builder is injected, not chosen)', () => {
    const src = readFileSync(fileURLToPath(new URL('./cold-start-bootstrap.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/api\/(analyze|init|run)/);
    expect(src).not.toMatch(/install\/index/);
  });
});
