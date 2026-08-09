/**
 * Tests for command-helpers utilities:
 *   - fileExists
 *   - formatDuration
 *   - formatAge
 *   - parseList
 *   - readJsonFile
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatDuration, formatAge, parseList, resolveLLMProvider } from './command-helpers.js';

// ============================================================================
// formatDuration
// ============================================================================

describe('formatDuration', () => {
  it('formats milliseconds when < 1000ms', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats seconds when 1000ms ≤ ms < 60s', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59999)).toBe('60.0s');
  });

  it('formats minutes and seconds when ≥ 60s', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_600_000)).toBe('60m 0s');
  });
});

// ============================================================================
// formatAge
// ============================================================================

describe('formatAge', () => {
  it('returns "just now" when < 1 minute', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(30_000)).toBe('just now');
    expect(formatAge(59_999)).toBe('just now');
  });

  it('returns minutes when 1 min ≤ age < 1 hour', () => {
    expect(formatAge(60_000)).toBe('1 minutes ago');
    expect(formatAge(300_000)).toBe('5 minutes ago');
    expect(formatAge(3_599_999)).toBe('59 minutes ago');
  });

  it('returns hours when 1 hour ≤ age < 1 day', () => {
    expect(formatAge(3_600_000)).toBe('1 hours ago');
    expect(formatAge(7_200_000)).toBe('2 hours ago');
    expect(formatAge(86_399_999)).toBe('23 hours ago');
  });

  it('returns days when ≥ 1 day', () => {
    expect(formatAge(86_400_000)).toBe('1 days ago');
    expect(formatAge(172_800_000)).toBe('2 days ago');
  });
});

// ============================================================================
// parseList
// ============================================================================

describe('parseList', () => {
  it('splits by comma and trims whitespace', () => {
    expect(parseList('auth, billing, api')).toEqual(['auth', 'billing', 'api']);
  });

  it('handles no spaces', () => {
    expect(parseList('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('filters out empty strings from double commas', () => {
    expect(parseList('a,,b')).toEqual(['a', 'b']);
  });

  it('returns single-element array for no commas', () => {
    expect(parseList('auth')).toEqual(['auth']);
  });

  it('returns empty array for empty string', () => {
    expect(parseList('')).toEqual([]);
  });

  it('trims leading/trailing whitespace from each item', () => {
    expect(parseList('  foo  ,  bar  ')).toEqual(['foo', 'bar']);
  });
});

describe('resolveLLMProvider', () => {
  it.each(['codex-cli', 'antigravity-cli'] as const)('accepts no-key provider %s', (provider) => {
    expect(resolveLLMProvider({ generation: { provider } })).toEqual({ provider });
  });
});

// ============================================================================
// fileExists + readJsonFile — use a real temp dir
// ============================================================================

describe('fileExists', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cmd-helpers-test-'));
  });

  it('returns true for existing file', async () => {
    const p = join(tmpDir, 'x.txt');
    await writeFile(p, 'hi', 'utf-8');
    const { fileExists } = await import('./command-helpers.js');
    expect(await fileExists(p)).toBe(true);
  });

  it('returns false for non-existent path', async () => {
    const { fileExists } = await import('./command-helpers.js');
    expect(await fileExists(join(tmpDir, 'nope.txt'))).toBe(false);
  });

  it('returns true for existing directory', async () => {
    const { fileExists } = await import('./command-helpers.js');
    expect(await fileExists(tmpDir)).toBe(true);
  });
});

describe('readJsonFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cmd-helpers-json-test-'));
  });

  it('returns null when file does not exist', async () => {
    const { readJsonFile } = await import('./command-helpers.js');
    const result = await readJsonFile(join(tmpDir, 'missing.json'), 'missing.json');
    expect(result).toBeNull();
  });

  it('returns parsed object when file is valid JSON', async () => {
    const data = { foo: 'bar', count: 42 };
    const p = join(tmpDir, 'data.json');
    await writeFile(p, JSON.stringify(data), 'utf-8');
    const { readJsonFile } = await import('./command-helpers.js');
    const result = await readJsonFile<typeof data>(p, 'data.json');
    expect(result).toEqual(data);
  });

  it('throws descriptive error when JSON is malformed', async () => {
    const p = join(tmpDir, 'bad.json');
    await writeFile(p, 'not-json{{', 'utf-8');
    const { readJsonFile } = await import('./command-helpers.js');
    await expect(readJsonFile(p, 'bad.json')).rejects.toThrow('bad.json');
  });

  it('throws descriptive error mentioning corruption', async () => {
    const p = join(tmpDir, 'corrupt.json');
    await writeFile(p, '{broken', 'utf-8');
    const { readJsonFile } = await import('./command-helpers.js');
    await expect(readJsonFile(p, 'corrupt.json')).rejects.toThrow('corrupted');
  });

  it('rethrows non-ENOENT file errors', async () => {
    const { readJsonFile } = await import('./command-helpers.js');
    // Pass a path that is a directory — readFile on a directory throws EISDIR, not ENOENT
    await expect(readJsonFile(tmpDir, 'dir')).rejects.toThrow();
  });

  it('returns typed data (generic T preserved)', async () => {
    interface Typed { name: string; value: number }
    const data: Typed = { name: 'test', value: 99 };
    const p = join(tmpDir, 'typed.json');
    await writeFile(p, JSON.stringify(data), 'utf-8');
    const { readJsonFile } = await import('./command-helpers.js');
    const result = await readJsonFile<Typed>(p, 'typed.json');
    expect(result?.name).toBe('test');
    expect(result?.value).toBe(99);
  });
});
