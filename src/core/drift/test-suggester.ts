/**
 * Maps drift results to the test files that cover the affected domains.
 * Scans test files for // openlore: {JSON} metadata tags (written by openlore test).
 * No LLM required.
 */

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import { isTestFile } from '../analyzer/test-file.js';
import { mapFilesBounded, readSourceCapped } from '../analyzer/bounded-file-scan.js';
import type { DriftResult } from '../../types/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DomainTestSuggestion {
  domain: string;
  testFiles: string[];
  testFileCount: number;
}

export interface TestSuggestion {
  domains: DomainTestSuggestion[];
  /** Flat list of all unique test files for easy copy-paste into a test runner */
  allFiles: string[];
  /** Test-looking files that were unreadable or exceeded the repository scan size cap. */
  omittedFiles: number;
}

// ============================================================================
// INTERNALS
// ============================================================================

const TAG_REGEX = /(?:\/\/|#)\s*openlore:\s*(\{[^\n]+\})/g;

async function walkTestFiles(dir: string, rootPath: string): Promise<string[]> {
  const results: string[] = [];
  if (!(await fileExists(dir))) return results;

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', 'build', '.openlore'].includes(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && isTestFile(relative(rootPath, full))) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

async function scanDomainTags(absPath: string): Promise<string[] | null> {
  const content = await readSourceCapped(absPath);
  if (content === null) return null;

  const domains = new Set<string>();
  TAG_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_REGEX.exec(content)) !== null) {
    try {
      const tag = JSON.parse(m[1]);
      if (typeof tag.domain === 'string') domains.add(tag.domain.toLowerCase());
    } catch { /* malformed tag */ }
  }
  return [...domains];
}

// ============================================================================
// MAIN
// ============================================================================

export async function suggestTestsForDrift(
  driftResult: DriftResult,
  rootPath: string,
  testDirs = ['spec-tests', 'src'],
): Promise<TestSuggestion> {
  const absRoot = resolve(rootPath);

  // Extract the set of drifted domains from the drift result
  const driftedDomains = new Set(
    driftResult.issues
      .map((i) => i.domain)
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
      .map((d) => d.toLowerCase())
  );

  if (driftedDomains.size === 0) {
    return { domains: [], allFiles: [], omittedFiles: 0 };
  }

  // Walk test directories and collect all test files
  const allTestFiles: string[] = [];
  for (const dir of testDirs) {
    const absDir = join(absRoot, dir);
    allTestFiles.push(...(await walkTestFiles(absDir, absRoot)));
  }

  // Overlapping configured roots can discover the same file more than once. Deduplicate before
  // reading, then scan through the repository-wide bounded worker pool so a large test corpus
  // cannot issue one read per file simultaneously.
  const uniqueTestFiles = [...new Set(allTestFiles)].sort();
  const scans = await mapFilesBounded(uniqueTestFiles, async (absPath) => ({
    coveredDomains: await scanDomainTags(absPath),
    relPath: relative(absRoot, absPath),
  }));

  // For each test file, check which domains it covers
  const filesByDomain = new Map<string, Set<string>>();
  for (const { coveredDomains, relPath } of scans) {
    if (coveredDomains === null) continue;
    for (const domain of coveredDomains) {
      if (!driftedDomains.has(domain)) continue;
      if (!filesByDomain.has(domain)) filesByDomain.set(domain, new Set());
      filesByDomain.get(domain)!.add(relPath);
    }
  }

  // Build result, ordered by domain name
  const domains: DomainTestSuggestion[] = [...filesByDomain.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([domain, files]) => ({
      domain,
      testFiles: [...files].sort(),
      testFileCount: files.size,
    }));

  const allFiles = [...new Set(domains.flatMap((d) => d.testFiles))];

  return { domains, allFiles, omittedFiles: scans.filter(scan => scan.coveredDomains === null).length };
}
