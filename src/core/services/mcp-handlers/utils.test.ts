/**
 * Tests for MCP handler shared utilities:
 *   - validateDirectory
 *   - sanitizeMcpError
 *   - readCachedContext
 *   - isCacheFresh
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import {
  validateDirectory,
  sanitizeMcpError,
  safeJoin,
  readCachedContext,
  isCacheFresh,
  computeProjectFingerprint,
  loadMappingIndex,
  clearMappingCache,
  specsForFile,
  functionsForDomain,
  notReadyResult,
} from './utils.js';
import { EdgeStore } from '../edge-store.js';
import { logger } from '../../../utils/logger.js';
import { publishGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../../runtime/analysis-generation.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_FINGERPRINT,
  ANALYSIS_STALE_THRESHOLD_MS,
} from '../../../constants.js';

// ============================================================================
// validateDirectory
// ============================================================================

describe('validateDirectory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-utils-test-'));
  });

  it('resolves and returns the absolute path for an existing directory', async () => {
    const result = await validateDirectory(tmpDir);
    expect(result).toBe(tmpDir);
  });

  it('throws when the path does not exist', async () => {
    await expect(validateDirectory(join(tmpDir, 'nonexistent'))).rejects.toThrow('Directory not found');
  });

  it('throws when the path is a file, not a directory', async () => {
    const filePath = join(tmpDir, 'file.txt');
    await writeFile(filePath, 'hello', 'utf-8');
    await expect(validateDirectory(filePath)).rejects.toThrow('Not a directory');
  });

  it('throws when directory parameter is empty string', async () => {
    await expect(validateDirectory('')).rejects.toThrow('directory parameter is required');
  });

  it('resolves a relative path to absolute', async () => {
    // Use process.cwd() which is definitely a valid directory
    const result = await validateDirectory('.');
    expect(result).toBe(process.cwd());
  });
});

// ============================================================================
// validateDirectory Logging
// ============================================================================

describe('validateDirectory logging', () => {
  let tmpDir: string;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let successSpy: ReturnType<typeof vi.spyOn>;
  let warningSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-utils-logging-test-'));
    debugSpy = vi.spyOn(logger, 'debug');
    successSpy = vi.spyOn(logger, 'success');
    warningSpy = vi.spyOn(logger, 'warning');
    errorSpy = vi.spyOn(logger, 'error');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs debug message on function entry', async () => {
    await validateDirectory(tmpDir);
    expect(debugSpy).toHaveBeenCalledWith(`Validating directory: ${tmpDir}`);
  });

  it('logs debug message for resolved path', async () => {
    await validateDirectory(tmpDir);
    expect(debugSpy).toHaveBeenCalledWith(`Resolved directory path: ${tmpDir}`);
  });

  it('logs success message on successful validation', async () => {
    await validateDirectory(tmpDir);
    expect(successSpy).toHaveBeenCalledWith(`Successfully validated directory: ${tmpDir}`);
  });

  it('logs warning message on invalid input', async () => {
    await expect(validateDirectory('')).rejects.toThrow('directory parameter is required');
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('directory parameter is required'));
  });

  it('logs error message when directory not found', async () => {
    await expect(validateDirectory(join(tmpDir, 'nonexistent'))).rejects.toThrow('Directory not found');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Directory not found'));
  });

  it('logs error message when path is not a directory', async () => {
    const filePath = join(tmpDir, 'file.txt');
    await writeFile(filePath, 'hello', 'utf-8');
    await expect(validateDirectory(filePath)).rejects.toThrow('Not a directory');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Not a directory'));
  });
});

// ============================================================================
// sanitizeMcpError
// ============================================================================

describe('sanitizeMcpError', () => {
  it('redacts Anthropic API keys (sk-ant-...)', () => {
    const msg = 'Failed: sk-ant-api03-AbCdEfGhIjKlMnOpQrSt-extra12345';
    expect(sanitizeMcpError(new Error(msg))).toContain('[REDACTED]');
    expect(sanitizeMcpError(new Error(msg))).not.toContain('sk-ant-api03-AbCdEfGhIjKlMnOpQrSt');
  });

  it('redacts OpenAI API keys (sk-...)', () => {
    const msg = 'Request failed: sk-ABCDE12345FGHIJ67890klmno';
    expect(sanitizeMcpError(new Error(msg))).toContain('[REDACTED]');
    expect(sanitizeMcpError(new Error(msg))).not.toContain('sk-ABCDE12345FGHIJ67890klmno');
  });

  it('redacts Bearer tokens', () => {
    const msg = 'Unauthorized: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc';
    expect(sanitizeMcpError(new Error(msg))).toContain('Bearer [REDACTED]');
  });

  it('redacts api_key values', () => {
    const msg = 'Error: api_key=supersecretkey123';
    expect(sanitizeMcpError(new Error(msg))).toContain('[REDACTED]');
  });

  it('does NOT redact short strings that look like keys but are too short', () => {
    // sk-ant- keys need 10+ chars after the prefix
    const msg = 'sk-ant-abc';
    const result = sanitizeMcpError(new Error(msg));
    // Short key should not trigger redaction (length < 10 after prefix)
    expect(result).not.toContain('[REDACTED]');
  });

  it('accepts plain string errors', () => {
    const result = sanitizeMcpError('plain error message');
    expect(result).toBe('plain error message');
  });

  it('accepts non-Error objects', () => {
    const result = sanitizeMcpError({ toString: () => 'object error' });
    expect(result).toContain('object error');
  });

  it('leaves messages without secrets unchanged', () => {
    const msg = 'Something went wrong with the pipeline';
    expect(sanitizeMcpError(new Error(msg))).toBe(msg);
  });
});

// ============================================================================
// safeJoin
// ============================================================================

describe('safeJoin', () => {
  // A REAL directory, because safeJoin's contract is a validated (existing) root and
  // it now fails closed when the root cannot be canonically resolved — "we could not
  // verify" is not "inside the root". The traversal cases below still use a fictional
  // root: those reject lexically, before any filesystem call.
  let realRoot: string;
  beforeAll(async () => {
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    realRoot = await mkdtemp(join(tmpdir(), 'openlore-safejoin-'));
    await mkdir(join(realRoot, 'src', 'core', 'services', 'mcp-handlers'), { recursive: true });
  });

  it('resolves a relative path within the project root', () => {
    expect(safeJoin(realRoot, 'src/auth.ts')).toBe(`${realRoot}/src/auth.ts`);
  });

  it('throws on path traversal via ../', () => {
    expect(() => safeJoin('/projects/myapp', '../../etc/passwd')).toThrow('Path traversal blocked');
  });

  it('throws on absolute path outside project root', () => {
    expect(() => safeJoin('/projects/myapp', '/etc/passwd')).toThrow('Path traversal blocked');
  });

  it('allows nested paths within project root', () => {
    expect(safeJoin(realRoot, 'src/core/services/mcp-handlers/utils.ts'))
      .toBe(`${realRoot}/src/core/services/mcp-handlers/utils.ts`);
  });

  it('blocks traversal that starts within root but escapes', () => {
    expect(() => safeJoin('/projects/myapp', 'src/../../other/file.ts')).toThrow('Path traversal blocked');
  });
});

// ============================================================================
// readCachedContext
// ============================================================================

describe('readCachedContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-cache-test-'));
  });

  it('returns null when llm-context.json does not exist', async () => {
    const result = await readCachedContext(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when llm-context.json is malformed', async () => {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), 'not-json', 'utf-8');
    const result = await readCachedContext(tmpDir);
    expect(result).toBeNull();
  });

  it('returns parsed LLMContext when file is valid', async () => {
    const ctx = {
      phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
      phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
      phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
    };
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify(ctx), 'utf-8');
    const result = await readCachedContext(tmpDir);
    expect(result).toMatchObject({ phase1_survey: { purpose: 'survey' } });
  });

  it('never serves artifact bytes written before their generation is committed', async () => {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    for (const name of REQUIRED_ANALYSIS_ARTIFACTS) {
      await writeFile(join(dir, name), name === ARTIFACT_LLM_CONTEXT
        ? JSON.stringify({ marker: 'committed' })
        : '{}');
    }
    await publishGeneration(dir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
    expect(await readCachedContext(tmpDir)).toMatchObject({ marker: 'committed' });
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ marker: 'uncommitted' }));
    expect(await readCachedContext(tmpDir)).toBeNull();
  });

  it('attaches EdgeStore when call-graph.db is present', async () => {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const ctx = { phase1_survey: { purpose: '', files: [], totalTokens: 0 }, phase2_deep: { purpose: '', files: [], totalTokens: 0 }, phase3_validation: { purpose: '', files: [], totalTokens: 0 } };
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify(ctx), 'utf-8');
    // Create an EdgeStore (schema init happens in constructor)
    EdgeStore.open(EdgeStore.dbPath(dir)).close();

    const result = await readCachedContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.edgeStore).toBeDefined();
    // Clean up
    result!.edgeStore?.close();
  });

  it('edgeStore is absent when call-graph.db does not exist', async () => {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const ctx = { phase1_survey: { purpose: '', files: [], totalTokens: 0 }, phase2_deep: { purpose: '', files: [], totalTokens: 0 }, phase3_validation: { purpose: '', files: [], totalTokens: 0 } };
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify(ctx), 'utf-8');
    // No call-graph.db created

    const result = await readCachedContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.edgeStore).toBeUndefined();
  });

  it('refuses to attach an EMPTY edge store when the JSON has production nodes (schema-bump guard)', async () => {
    // Reproduces the upgrade footgun: the JSON analysis still has graph nodes, but the
    // edge store DB was wiped by a SCHEMA_VERSION bump. Serving the empty store would
    // give silent empty results from analyze_impact/get_subgraph/get_change_coupling;
    // instead it must be withheld so those tools say "re-run analyze_codebase".
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const ctx = {
      phase1_survey: { purpose: '', files: [], totalTokens: 0 },
      phase2_deep: { purpose: '', files: [], totalTokens: 0 },
      phase3_validation: { purpose: '', files: [], totalTokens: 0 },
      callGraph: {
        nodes: [{ id: 'src/a.ts::foo', name: 'foo', filePath: 'src/a.ts', isExternal: false, isTest: false }],
        edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
        stats: { totalNodes: 1, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
      },
    };
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify(ctx), 'utf-8');
    EdgeStore.open(EdgeStore.dbPath(dir)).close(); // empty (current-version) store

    const result = await readCachedContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.edgeStore).toBeUndefined(); // withheld: empty store + JSON has prod nodes
  });

  it('normalizes missing callGraph nodes/edges to [] so graph handlers degrade, not throw', async () => {
    // A truncated/hand-edited artifact with `callGraph: {}` passes the handlers'
    // `!ctx.callGraph` guard and then throws on `cg.nodes.map(...)`. Normalize the
    // missing arrays to [] (preserving any other fields) so handlers return empty
    // rather than crashing.
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const ctx = {
      phase1_survey: { purpose: '', files: [], totalTokens: 0 },
      phase2_deep: { purpose: '', files: [], totalTokens: 0 },
      phase3_validation: { purpose: '', files: [], totalTokens: 0 },
      signatures: [{ path: 'a.ts', language: 'TypeScript', signatures: [] }],
      // Minimal callGraph carrying only entryPoints (a shape architecture-overview
      // reads) and NO nodes/edges arrays.
      callGraph: { entryPoints: [{ name: 'main' }] },
    };
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify(ctx), 'utf-8');

    const result = await readCachedContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.callGraph).toBeDefined();             // graph preserved (not dropped)
    expect(Array.isArray(result!.callGraph!.nodes)).toBe(true);  // missing nodes → []
    expect(result!.callGraph!.nodes).toHaveLength(0);
    expect(Array.isArray(result!.callGraph!.edges)).toBe(true);  // missing edges → []
    expect((result!.callGraph as { entryPoints?: unknown[] }).entryPoints).toHaveLength(1); // other fields kept
    expect(result!.signatures).toHaveLength(1);
  });

  it('drops a callGraph that is not even an object (scalar/array)', async () => {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const ctx = {
      phase1_survey: { purpose: '', files: [], totalTokens: 0 },
      phase2_deep: { purpose: '', files: [], totalTokens: 0 },
      phase3_validation: { purpose: '', files: [], totalTokens: 0 },
      callGraph: 'corrupt-scalar',
    };
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify(ctx), 'utf-8');

    const result = await readCachedContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.callGraph).toBeUndefined();
  });
});

// ============================================================================
// isCacheFresh
// ============================================================================

describe('isCacheFresh', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-freshness-test-'));
  });

  it('returns false when llm-context.json does not exist', async () => {
    const result = await isCacheFresh(tmpDir);
    expect(result).toBe(false);
  });

  it('returns true when llm-context.json was just written', async () => {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), '{}', 'utf-8');
    const result = await isCacheFresh(tmpDir);
    expect(result).toBe(true);
  });

  it('returns false when cache is older than ANALYSIS_STALE_THRESHOLD_MS', async () => {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, ARTIFACT_LLM_CONTEXT);
    await writeFile(filePath, '{}', 'utf-8');

    // Backdate the file's mtime well beyond the threshold
    const { utimes } = await import('node:fs/promises');
    const pastTime = new Date(Date.now() - ANALYSIS_STALE_THRESHOLD_MS - 10_000);
    await utimes(filePath, pastTime, pastTime);

    const result = await isCacheFresh(tmpDir);
    expect(result).toBe(false);
  });

  it('stays fresh when only OpenLore-managed dirs (.openlore-live-cache) churn', async () => {
    // Regression: the fingerprint must exclude OpenLore's own scratch/fixture
    // caches. Refreshing a cloned fixture must not flap the content hash, or
    // isCacheFresh forces a needless re-analysis every time the live-data tools run.
    const userSrc = join(tmpDir, 'src');
    await mkdir(userSrc, { recursive: true });
    await writeFile(join(userSrc, 'app.ts'), 'export const x = 1;\n', 'utf-8');
    const analysisDir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(analysisDir, { recursive: true });
    await writeFile(join(analysisDir, ARTIFACT_LLM_CONTEXT), '{}', 'utf-8');

    // Pin the fingerprint as analyze would, then refresh a live-cache fixture.
    const before = await computeProjectFingerprint(tmpDir);
    await writeFile(join(analysisDir, ARTIFACT_FINGERPRINT), JSON.stringify({ hash: before }), 'utf-8');
    const liveCache = join(tmpDir, '.openlore-live-cache', 'go-pkg-errors@abc');
    await mkdir(liveCache, { recursive: true });
    await writeFile(join(liveCache, 'errors.go'), 'package errors\nfunc New() {}\n', 'utf-8');

    expect(await computeProjectFingerprint(tmpDir)).toBe(before);
    expect(await isCacheFresh(tmpDir)).toBe(true);

    // Sanity: a real user-source change DOES flap the hash AND invalidate the cache —
    // the exclusion suppresses only OpenLore's own churn, never the user's edits.
    await writeFile(join(userSrc, 'app.ts'), 'export const x = 2;\nexport const y = 3;\n', 'utf-8');
    expect(await computeProjectFingerprint(tmpDir)).not.toBe(before);
    expect(await isCacheFresh(tmpDir)).toBe(false);
  });
});

// ============================================================================
// loadMappingIndex
// ============================================================================

describe('loadMappingIndex', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-mapping-test-'));
  });

  it('returns null when mapping.json does not exist', async () => {
    const result = await loadMappingIndex(tmpDir);
    expect(result).toBeNull();
  });

  it('returns indexed MappingIndex when mapping.json is valid', async () => {
    const dir = join(tmpDir, '.openlore', 'analysis');
    await mkdir(dir, { recursive: true });
    const mappingData = {
      mappings: [
        {
          requirement: 'User auth',
          domain: 'auth',
          specFile: 'openspec/specs/auth/spec.md',
          functions: [
            { name: 'login', file: 'src/auth.ts', line: 10, kind: 'function', confidence: 'high' },
            { name: '*', file: 'src/auth.ts', line: 0, kind: 'wildcard', confidence: 'low' },
          ],
        },
      ],
    };
    await writeFile(join(dir, 'mapping.json'), JSON.stringify(mappingData), 'utf-8');

    const result = await loadMappingIndex(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.byDomain.has('auth')).toBe(true);
    expect(result!.byFile.has('src/auth.ts')).toBe(true);
  });

  it('returns null when mapping.json is malformed JSON', async () => {
    const dir = join(tmpDir, '.openlore', 'analysis');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'mapping.json'), 'not valid json', 'utf-8');
    const result = await loadMappingIndex(tmpDir);
    expect(result).toBeNull();
  });

  it('caches results and returns cached value on subsequent calls', async () => {
    const dir = join(tmpDir, '.openlore', 'analysis');
    await mkdir(dir, { recursive: true });
    const mappingData = {
      mappings: [
        {
          requirement: 'User auth',
          domain: 'auth',
          specFile: 'openspec/specs/auth/spec.md',
          functions: [
            { name: 'login', file: 'src/auth.ts', line: 10, kind: 'function', confidence: 'high' },
          ],
        },
      ],
    };
    await writeFile(join(dir, 'mapping.json'), JSON.stringify(mappingData), 'utf-8');

    // First call - should read from disk
    const result1 = await loadMappingIndex(tmpDir);
    expect(result1).not.toBeNull();
    
    // Second call - should return cached result
    const result2 = await loadMappingIndex(tmpDir);
    expect(result2).not.toBeNull();
    
    // Both results should be the same object (cached)
    expect(result2).toBe(result1);
  });

  it('caches different directories separately', async () => {
    const dir1 = join(tmpDir, '.openlore', 'analysis');
    await mkdir(dir1, { recursive: true });
    const mappingData1 = {
      mappings: [
        {
          requirement: 'User auth',
          domain: 'auth',
          specFile: 'openspec/specs/auth/spec.md',
          functions: [
            { name: 'login', file: 'src/auth.ts', line: 10, kind: 'function', confidence: 'high' },
          ],
        },
      ],
    };
    await writeFile(join(dir1, 'mapping.json'), JSON.stringify(mappingData1), 'utf-8');

    const dir2 = join(tmpDir, 'other', '.openlore', 'analysis');
    await mkdir(dir2, { recursive: true });
    const mappingData2 = {
      mappings: [
        {
          requirement: 'Payment processing',
          domain: 'payments',
          specFile: 'openspec/specs/payments/spec.md',
          functions: [
            { name: 'processPayment', file: 'src/payments.ts', line: 20, kind: 'function', confidence: 'high' },
          ],
        },
      ],
    };
    await writeFile(join(dir2, 'mapping.json'), JSON.stringify(mappingData2), 'utf-8');

    // Load both indices
    const result1 = await loadMappingIndex(tmpDir);
    const result2 = await loadMappingIndex(join(tmpDir, 'other'));
    
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    
    // Results should be different objects (different directories)
    expect(result2).not.toBe(result1);
    
    // But each should be cached for their respective directory
    const result1Cached = await loadMappingIndex(tmpDir);
    const result2Cached = await loadMappingIndex(join(tmpDir, 'other'));
    
    expect(result1Cached).toBe(result1);
    expect(result2Cached).toBe(result2);
  });
});

// ============================================================================
// clearMappingCache
// ============================================================================

describe('clearMappingCache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-cache-clear-test-'));
  });

  it('clears the mapping cache', async () => {
    const dir = join(tmpDir, '.openlore', 'analysis');
    await mkdir(dir, { recursive: true });
    const mappingData = {
      mappings: [
        {
          requirement: 'User auth',
          domain: 'auth',
          specFile: 'openspec/specs/auth/spec.md',
          functions: [
            { name: 'login', file: 'src/auth.ts', line: 10, kind: 'function', confidence: 'high' },
          ],
        },
      ],
    };
    await writeFile(join(dir, 'mapping.json'), JSON.stringify(mappingData), 'utf-8');

    // Load and cache the index
    const result1 = await loadMappingIndex(tmpDir);
    expect(result1).not.toBeNull();
    
    // Verify it's cached
    const result2 = await loadMappingIndex(tmpDir);
    expect(result2).toBe(result1);
    
    // Clear the cache
    clearMappingCache();
    
    // Next call should not return the cached result
    const result3 = await loadMappingIndex(tmpDir);
    expect(result3).not.toBe(result1);
    expect(result3).not.toBeNull(); // Should still load from disk
  });
});

// ============================================================================
// specsForFile / functionsForDomain
// ============================================================================

describe('specsForFile', () => {
  it('returns empty array when file has no mapping entries', () => {
    const index = { byFile: new Map(), byDomain: new Map(), entries: [] };
    expect(specsForFile(index, 'src/foo.ts')).toEqual([]);
  });

  it('returns spec entries for a file', () => {
    const entry = {
      requirement: 'Login',
      service: '',
      domain: 'auth',
      specFile: 'openspec/specs/auth/spec.md',
      functions: [],
    };
    const byFile = new Map([['src/auth.ts', [entry]]]);
    const index = { byFile, byDomain: new Map(), entries: [entry] };
    const specs = specsForFile(index, 'src/auth.ts');
    expect(specs).toHaveLength(1);
    expect(specs[0].domain).toBe('auth');
    expect(specs[0].requirement).toBe('Login');
  });

  it('deduplicates entries with same domain+requirement', () => {
    const entry = { requirement: 'Login', service: '', domain: 'auth', specFile: 'auth.md', functions: [] };
    const byFile = new Map([['src/auth.ts', [entry, entry]]]);
    const index = { byFile, byDomain: new Map(), entries: [entry] };
    const specs = specsForFile(index, 'src/auth.ts');
    expect(specs).toHaveLength(1);
  });
});

describe('functionsForDomain', () => {
  it('returns empty array when domain has no entries', () => {
    const index = { byFile: new Map(), byDomain: new Map(), entries: [] };
    expect(functionsForDomain(index, 'unknown')).toEqual([]);
  });

  it('returns functions for a domain, skipping wildcard entries', () => {
    const entry = {
      requirement: 'Auth flow',
      service: '',
      domain: 'auth',
      specFile: 'auth.md',
      functions: [
        { name: 'login', file: 'src/auth.ts', line: 10, kind: 'function', confidence: 'high' },
        { name: '*', file: 'src/auth.ts', line: 0, kind: 'wildcard', confidence: 'low' },
      ],
    };
    const byDomain = new Map([['auth', [entry]]]);
    const index = { byFile: new Map(), byDomain, entries: [entry] };
    const fns = functionsForDomain(index, 'auth');
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('login');
    expect(fns[0].requirement).toBe('Auth flow');
  });
});

describe('notReadyResult (ReadyOrHonestFirstUse)', () => {
  it('builds a structured, ready-or-honest result preserving the human message', () => {
    const r = notReadyResult('No analysis found. Run "openlore analyze" first.', 'index-absent');
    expect(r.error).toContain('No analysis found');
    expect(r.notReady).toBe(true);
    expect(r.reason).toBe('index-absent');
    expect(r.remedy).toBe('openlore analyze');
  });

  it('carries the graph-unavailable reason distinctly from index-absent', () => {
    const r = notReadyResult('Call graph not available. Re-run analyze_codebase.', 'graph-unavailable');
    expect(r.notReady).toBe(true);
    expect(r.reason).toBe('graph-unavailable');
    expect(r.remedy).toBe('openlore analyze');
  });
});
