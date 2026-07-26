/**
 * Tests for ast-chunker — blankLineChunk and astChunkContent
 */

import { describe, it, expect, afterEach } from 'vitest';
import { blankLineChunk, astChunkContent } from './ast-chunker.js';
import { PARSE_BUDGET_ENV } from '../../constants.js';

// ── blankLineChunk ────────────────────────────────────────────────────────────

describe('blankLineChunk', () => {
  it('returns single chunk when content fits within maxChars', () => {
    const content = 'hello\nworld\n';
    const chunks = blankLineChunk(content, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('hello');
  });

  it('splits at blank lines when content exceeds maxChars', () => {
    const block = 'line1\nline2\nline3\n';
    const content = block + '\n' + block + '\n' + block;
    const chunks = blankLineChunk(content, block.length + 5);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('preserves content across chunks with overlap', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `const x${i} = ${i};`);
    const content = lines.join('\n') + '\n\n' + lines.join('\n');
    const chunks = blankLineChunk(content, 300, 5);
    const joined = chunks.join('\n');
    // All key lines should appear somewhere
    expect(joined).toContain('const x0 = 0;');
    expect(joined).toContain('const x49 = 49;');
  });

  it('returns original content as single chunk when no blank lines', () => {
    const content = 'a\nb\nc\nd';
    const chunks = blankLineChunk(content, 5);
    // No blank lines to split on — everything ends up in the last chunk
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const joined = chunks.join('');
    expect(joined).toContain('a');
    expect(joined).toContain('d');
  });
});

// ── astChunkContent ───────────────────────────────────────────────────────────

const TS_CONTENT_SMALL = `
import { foo } from './foo.js';

export function greet(name: string): string {
  return \`Hello \${name}\`;
}
`.trim();

const TS_CONTENT_LARGE = `
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function alpha(x: number): number {
  return x + 1;
}

export function beta(x: number): number {
  return x + 2;
}

export function gamma(x: number): number {
  return x + 3;
}

export function delta(x: number): number {
  return x + 4;
}

export function epsilon(x: number): number {
  return x + 5;
}

export function zeta(x: number): number {
  return x + 6;
}

export function eta(x: number): number {
  return x + 7;
}

export function theta(x: number): number {
  return x + 8;
}
`.trim();

describe('astChunkContent', () => {
  it('returns single chunk when content fits within maxChars', async () => {
    const chunks = await astChunkContent(TS_CONTENT_SMALL, 'test.ts', 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('greet');
  });

  it('returns multiple chunks for TypeScript when content exceeds maxChars', async () => {
    const chunks = await astChunkContent(TS_CONTENT_LARGE, 'src/utils.ts', 200);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should contain some code
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('prefixes non-first chunks with import block for TypeScript', async () => {
    const chunks = await astChunkContent(TS_CONTENT_LARGE, 'src/utils.ts', 200);
    if (chunks.length > 1) {
      // Non-first chunks should contain some import from the header
      expect(chunks[1]).toMatch(/^import /m);
    }
  });

  // Regression for change: fix-language-detection-single-source. The `.mts`/`.cts`/`.jsx`
  // extension variants were absent from the (now-deleted) code-shaper detection map that fed
  // this chunker, so they resolved to 'unknown' → generic blank-line fallback. With the single
  // canonical detector they resolve to TypeScript/JavaScript and take the AST path — the tell
  // is the import-block header prepended to non-first chunks (generic chunking never does that).
  it.each([
    ['src/utils.mts', /^import /m],
    ['src/utils.cts', /^import /m],
  ])('formerly-missed %s now takes the AST path (header on non-first chunks)', async (path, headerRe) => {
    const chunks = await astChunkContent(TS_CONTENT_LARGE, path, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]).toMatch(headerRe);
  });

  it('falls back to blank-line chunking for unsupported file types', async () => {
    const content = 'section one\n\n'.repeat(10) + 'section two\n\n'.repeat(10);
    const chunks = await astChunkContent(content, 'file.unknown', 100);
    expect(chunks.length).toBeGreaterThan(0);
    // Should still chunk
    const joined = chunks.join(' ');
    expect(joined).toContain('section one');
    expect(joined).toContain('section two');
  });

  it('handles Python files with AST chunking', async () => {
    const pyContent = `
import os
import sys

def func_one(x):
    return x + 1

def func_two(x):
    return x + 2

def func_three(x):
    return x + 3

def func_four(x):
    return x + 4

def func_five(x):
    return x + 5
`.trim();
    const chunks = await astChunkContent(pyContent, 'module.py', 100);
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.join('\n');
    expect(joined).toContain('func_one');
    expect(joined).toContain('func_five');
  });

  it('handles JavaScript files (.js extension)', async () => {
    const jsContent = `
const a = require('./a');

function doStuff(x) { return x; }
function doMore(x) { return x + 1; }
function doEven(x) { return x + 2; }
function doLots(x) { return x + 3; }
function doAll(x) { return x + 4; }
`.trim();
    const chunks = await astChunkContent(jsContent, 'lib.js', 80);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('returns content as-is when content is empty or whitespace-only', async () => {
    // An empty file is ≤ maxChars so it just returns [content]
    const chunks = await astChunkContent('', 'empty.ts', 1000);
    expect(chunks).toHaveLength(1);
  });

  it('handles content with no top-level nodes gracefully', async () => {
    // File that is pure comments — tree-sitter may produce no real content nodes
    const content = '// just a comment\n// another comment\n// more comments\n'.repeat(50);
    const chunks = await astChunkContent(content, 'comments.ts', 100);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('handles Go files with AST chunking', async () => {
    const goContent = `package main

import "fmt"

func one(x int) int { return x + 1 }

func two(x int) int { return x + 2 }

func three(x int) int { return x + 3 }

func four(x int) int { return x + 4 }

func five(x int) int { fmt.Println(x); return x + 5 }
`.repeat(3);
    const chunks = await astChunkContent(goContent, 'main.go', 200);
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.join('\n');
    expect(joined).toContain('func one');
  });

  it('handles Rust files with AST chunking', async () => {
    const rustContent = `
fn one(x: i32) -> i32 { x + 1 }

fn two(x: i32) -> i32 { x + 2 }

fn three(x: i32) -> i32 { x + 3 }

fn four(x: i32) -> i32 { x + 4 }

fn five(x: i32) -> i32 { x + 5 }
`.repeat(3);
    const chunks = await astChunkContent(rustContent, 'lib.rs', 200);
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.join('\n');
    expect(joined).toContain('fn one');
  });

  it('handles Ruby files with AST chunking', async () => {
    const rubyContent = `
def one(x)
  x + 1
end

def two(x)
  x + 2
end

def three(x)
  x + 3
end

def four(x)
  x + 4
end
`.repeat(3);
    const chunks = await astChunkContent(rubyContent, 'app.rb', 200);
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.join('\n');
    expect(joined).toContain('def one');
  });
});

// ── per-file parse budget (change: fix-analyze-native-abort-and-file-cost-budget) ─────────────

describe('astChunkContent under the per-file parse budget', () => {
  /** The payload that reproduced the abort: a 300 KB unterminated block comment. */
  const HOSTILE_TS = '/*x'.repeat(100_000);

  afterEach(() => { delete process.env[PARSE_BUDGET_ENV]; });

  it('falls back to blank-line chunking when the parse hits the budget, instead of throwing', async () => {
    // This chunker only parses content ALREADY over the chunk size, so it is exactly where a
    // pathological file shows up — and it runs at TOOL time, where an unbounded parse would wedge
    // the daemon rather than one build. On the budget it must degrade to the grammar-free chunker,
    // which is a worse chunking, never a failed call.
    process.env[PARSE_BUDGET_ENV] = '300';
    const started = Date.now();
    const chunks = await astChunkContent(HOSTILE_TS, 'src/hostile.ts', 50_000);
    const elapsed = Date.now() - started;

    // Exactly the grammar-free fallback. NOTE: this alone does not prove the budget ran — measured
    // against a deliberately unbounded build, the fallback is reached either way (the pathological
    // tree yields no usable top-level nodes). It pins the OUTPUT shape.
    expect(chunks).toEqual(blankLineChunk(HOSTILE_TS, 50_000, 10));
    // THIS is the assertion that pins the bound: unbounded, the same call measured 85.7 s.
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);

  it('CONTROL: ordinary content is still chunked by the grammar, unaffected by the budget', async () => {
    // A bound that quietly demoted every file to blank-line chunking would be a silent quality
    // regression with no symptom.
    const content = Array.from(
      { length: 400 },
      (_, i) => `export function fn${i}(): number {\n  return ${i};\n}\n`,
    ).join('\n');
    const withBudget = await astChunkContent(content, 'src/ok.ts', 2_000);
    process.env[PARSE_BUDGET_ENV] = '0';
    const withoutBudget = await astChunkContent(content, 'src/ok.ts', 2_000);
    expect(withBudget).toEqual(withoutBudget);
    expect(withBudget.length).toBeGreaterThan(1);
  }, 60_000);
});
