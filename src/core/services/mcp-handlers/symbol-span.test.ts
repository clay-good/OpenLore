/**
 * Tests for the `locate_symbol_span` handler (change: add-symbol-span-locator).
 *
 * Drives the handler over a hand-written analysis cache (llm-context.json) so the
 * test is deterministic and offline — no real `analyze` run required. Without an
 * EdgeStore (no call-graph.db), the handler exercises the mtime freshness fallback;
 * source-file mtimes are set explicitly with `utimesSync` so `fresh`/`stale` are
 * deterministic. The pure `resolveFreshness` helper unit-tests the content-hash
 * branches directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, statSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { handleLocateSymbolSpan } from './symbol-span.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../../constants.js';

const FOO = `export function foo(a) {
  return a + 1;
}
`;

const BAR = `export function bar(items) {
  let n = 0;
  for (const it of items) n += it;
  return n;
}
`;

interface CacheNode {
  id: string;
  name: string;
  filePath: string;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  language: string;
  isExternal?: boolean;
}

function node(id: string, name: string, filePath: string, body: string, startIndex = 0): CacheNode {
  return {
    id,
    name,
    filePath,
    startIndex,
    endIndex: startIndex + body.length,
    startLine: 1,
    endLine: body.split('\n').length,
    language: 'TypeScript',
  };
}

let dir: string;
let analysisDir: string;

/** Set a source file's mtime relative to the analysis artifact's mtime. */
function setSourceMtime(rel: string, deltaSeconds: number): void {
  const artifactMtime = statSync(join(analysisDir, ARTIFACT_LLM_CONTEXT)).mtimeMs / 1000;
  const t = artifactMtime + deltaSeconds;
  utimesSync(join(dir, rel), t, t);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symbol-span-'));
  writeFileSync(join(dir, 'foo.ts'), FOO, 'utf-8');
  writeFileSync(join(dir, 'bar.ts'), BAR, 'utf-8');
  // Two functions named `dup` in different files → ambiguous by bare name.
  writeFileSync(join(dir, 'a.ts'), FOO, 'utf-8');
  writeFileSync(join(dir, 'b.ts'), FOO, 'utf-8');

  const nodes: CacheNode[] = [
    node('foo', 'foo', 'foo.ts', FOO),
    node('bar', 'bar', 'bar.ts', BAR),
    node('da', 'dup', 'a.ts', FOO),
    node('db', 'dup', 'b.ts', FOO),
    // A bodyless internal symbol (startIndex >= endIndex) — resolves but has no span to locate.
    { id: 'x', name: 'bodyless', filePath: 'ext.ts', startIndex: 0, endIndex: 0, startLine: 0, endLine: 0, language: 'TypeScript' },
    // An HTML inline-script symbol — offsets against transformed content, not locatable.
    { id: 'h', name: 'onClick', filePath: 'page.html', startIndex: 0, endIndex: 40, startLine: 1, endLine: 3, language: 'JavaScript' },
  ];
  analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(join(analysisDir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges: [] } }), 'utf-8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleLocateSymbolSpan', () => {
  it('returns the byte-exact span + fresh for an unambiguous, unchanged symbol', async () => {
    setSourceMtime('foo.ts', -10); // analyzed after the file was written → unchanged
    const res = (await handleLocateSymbolSpan({ directory: dir, symbol: 'foo::foo.ts' })) as {
      verdict: string; symbol: string; file: string;
      startLine: number; endLine: number; startByte: number; endByte: number;
      spanEncoding: string; contentHash: string;
    };
    expect(res.verdict).toBe('fresh');
    expect(res.symbol).toBe('foo::foo.ts');
    expect(res.file).toBe('foo.ts');
    expect(res.startByte).toBe(0);
    expect(res.endByte).toBe(FOO.length);
    expect(res.startLine).toBe(1);
    expect(res.endLine).toBe(3); // 3 lines of code (trailing newline not counted)
    expect(res.spanEncoding).toBe('utf16');
    expect(res.contentHash).toMatch(/^[0-9a-f]{16}$/);
    // The returned offsets slice back to the exact source span.
    const content = readFileSync(join(dir, 'foo.ts'), 'utf-8');
    expect(content.slice(res.startByte, res.endByte)).toBe(FOO);
  });

  it('discloses a stale span (no offset) when the file changed after analysis', async () => {
    setSourceMtime('bar.ts', +10); // written after the index → offsets not trustworthy
    const res = (await handleLocateSymbolSpan({ directory: dir, symbol: 'bar::bar.ts' })) as {
      verdict: string; symbol: string; hint: string; startByte?: number;
    };
    expect(res.verdict).toBe('stale');
    expect(res.symbol).toBe('bar::bar.ts');
    expect(res.hint).toMatch(/re-run analyze/i);
    expect(res.startByte).toBeUndefined(); // no usable offset presented
  });

  it('returns ambiguous + name::path candidates for a bare name matching several symbols', async () => {
    const res = (await handleLocateSymbolSpan({ directory: dir, symbol: 'dup' })) as {
      verdict: string; candidates: string[]; startByte?: number;
    };
    expect(res.verdict).toBe('ambiguous');
    expect(res.candidates.sort()).toEqual(['dup::a.ts', 'dup::b.ts']);
    expect(res.startByte).toBeUndefined();
  });

  it('returns not-found + candidates for an unknown symbol', async () => {
    const res = (await handleLocateSymbolSpan({ directory: dir, symbol: 'fo' })) as {
      verdict: string; candidates: string[];
    };
    expect(res.verdict).toBe('not-found');
    expect(res.candidates).toContain('foo'); // substring near-miss
  });

  it('does not resolve or hash a traversal node outside the project root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'symbol-span-outside-'));
    try {
      const secret = 'outside-traversal-secret';
      const secretPath = join(outside, 'secret.ts');
      writeFileSync(secretPath, secret, 'utf-8');
      const poisoned = node('poison-traversal', 'leakTraversal', relative(dir, secretPath), secret);
      writeFileSync(
        join(analysisDir, ARTIFACT_LLM_CONTEXT),
        JSON.stringify({ callGraph: { nodes: [poisoned], edges: [] } }),
        'utf-8',
      );

      const res = await handleLocateSymbolSpan({ directory: dir, symbol: 'leakTraversal' });
      expect(res).toMatchObject({ verdict: 'not-found' });
      expect(JSON.stringify(res)).not.toContain(secret);
      expect(JSON.stringify(res)).not.toMatch(/[0-9a-f]{16}/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not resolve or hash an in-root symlink that escapes the project root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'symbol-span-link-outside-'));
    try {
      const secret = 'outside-symlink-secret';
      const secretPath = join(outside, 'secret.ts');
      writeFileSync(secretPath, secret, 'utf-8');
      symlinkSync(secretPath, join(dir, 'linked.ts'));
      const poisoned = node('poison-link', 'leakSymlink', 'linked.ts', secret);
      writeFileSync(
        join(analysisDir, ARTIFACT_LLM_CONTEXT),
        JSON.stringify({ callGraph: { nodes: [poisoned], edges: [] } }),
        'utf-8',
      );

      const res = await handleLocateSymbolSpan({ directory: dir, symbol: 'leakSymlink' });
      expect(res).toMatchObject({ verdict: 'not-found' });
      expect(JSON.stringify(res)).not.toContain(secret);
      expect(JSON.stringify(res)).not.toMatch(/[0-9a-f]{16}/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('discloses an unlocatable bodyless symbol instead of a fake span', async () => {
    const res = (await handleLocateSymbolSpan({ directory: dir, symbol: 'bodyless::ext.ts' })) as { error: string };
    expect(res.error).toMatch(/no source span/i);
  });

  it('discloses an HTML inline-script symbol as not locatable', async () => {
    const res = (await handleLocateSymbolSpan({ directory: dir, symbol: 'onClick::page.html' })) as { error: string };
    expect(res.error).toMatch(/HTML inline-script/i);
  });

  it('never modifies any source file (read-only)', async () => {
    const before = readFileSync(join(dir, 'foo.ts'), 'utf-8');
    setSourceMtime('foo.ts', -10);
    await handleLocateSymbolSpan({ directory: dir, symbol: 'foo::foo.ts' });
    await handleLocateSymbolSpan({ directory: dir, symbol: 'dup' });
    expect(readFileSync(join(dir, 'foo.ts'), 'utf-8')).toBe(before);
  });

  it('requires a symbol argument', async () => {
    const res = (await handleLocateSymbolSpan({ directory: dir })) as { error: string };
    expect(res.error).toMatch(/provide `symbol`/i);
  });
});
