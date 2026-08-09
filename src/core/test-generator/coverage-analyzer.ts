/**
 * Coverage Analyzer
 *
 * Determines which OpenSpec scenarios are covered by existing test files.
 *
 * Mode A — Tag-based (default, fast):
 *   Scans test files for // openlore: {JSON} or # openlore: {JSON} tags.
 *   O(files) — no LLM required.
 *
 * Mode B — Retroactive discovery (--discover, slower):
 *   Extracts describe()/it()/test()/TEST_CASE() titles from test files and
 *   uses LLM semantic comparison to link existing tests to uncovered scenarios.
 *   Useful for teams that already have tests but haven't run openlore test yet.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import { isTestFile } from '../analyzer/test-file.js';
import { parseScenarios } from './scenario-parser.js';
import type {
  ParsedScenario,
  TestCoverageReport,
  CoveredScenario,
  UncoveredScenario,
  DomainCoverage,
} from '../../types/test-generator.js';
import type { LLMService } from '../services/llm-service.js';
import type { DriftResult } from '../../types/index.js';
import { protectPrompt } from '../../utils/prompt-boundary.js';

// ============================================================================
// FILE WALKING
// ============================================================================

async function walkTestFiles(dir: string, rootPath: string): Promise<string[]> {
  const results: string[] = [];
  if (!(await fileExists(dir))) return results;

  async function walk(current: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip common non-test directories
      if (['node_modules', '.git', 'dist', 'build', '.openlore'].includes(entry)) continue;

      const fullPath = join(current, entry);
      // Check if it looks like a test file (canonical cross-language predicate)
      const rel = relative(rootPath, fullPath);
      if (isTestFile(rel)) {
        results.push(rel);
        continue;
      }
      // Recurse into directories (heuristic: no extension = directory)
      if (!entry.includes('.') || entry.endsWith('/')) {
        await walk(fullPath);
      } else {
        // Also recurse into directories with extensions? No — trust readdir
        try {
          const sub = await readdir(fullPath);
          if (sub.length > 0) await walk(fullPath);
        } catch {
          // not a directory, skip
        }
      }
    }
  }

  await walk(dir);
  return results;
}

// ============================================================================
// TAG-BASED COVERAGE (Mode A)
// ============================================================================

const TAG_REGEX = /(?:\/\/|#)\s*openlore:\s*(\{[^\n]+\})/g;

async function scanTagsInFile(
  absPath: string,
  relPath: string
): Promise<CoveredScenario[]> {
  let content: string;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch {
    return [];
  }

  const covered: CoveredScenario[] = [];
  let m: RegExpExecArray | null;
  TAG_REGEX.lastIndex = 0;

  while ((m = TAG_REGEX.exec(content)) !== null) {
    try {
      const tag = JSON.parse(m[1]);
      if (tag.domain && tag.requirement && tag.scenario) {
        covered.push({
          domain: tag.domain,
          requirement: tag.requirement,
          scenarioName: tag.scenario,
          testFile: relPath,
          discoveredBy: 'tag',
        });
      }
    } catch {
      // malformed tag
    }
  }
  return covered;
}

// ============================================================================
// TITLE EXTRACTION (for Mode B)
// ============================================================================

const TITLE_PATTERNS = [
  /describe\s*\(\s*["'`](.+?)["'`]/g,
  /it\s*\(\s*["'`](.+?)["'`]/g,
  /test\s*\(\s*["'`](.+?)["'`]/g,
  /TEST_CASE\s*\(\s*["'`](.+?)["'`]/g,
  /TEST\s*\(\s*\w+\s*,\s*(\w+)/g,
  /def\s+test_(\w+)/g,
  /class\s+Test(\w+)/g,
];

function extractTestTitles(content: string): string[] {
  const titles: string[] = [];
  for (const pattern of TITLE_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      if (m[1]) titles.push(m[1].trim());
    }
  }
  return [...new Set(titles)];
}

// ============================================================================
// SEMANTIC DISCOVERY (Mode B)
// ============================================================================

interface TestTitle {
  text: string;
  file: string;
}

async function discoverWithLlm(
  uncovered: ParsedScenario[],
  testTitles: TestTitle[],
  llm: LLMService
): Promise<Map<string, CoveredScenario>> {
  // Map: scenarioKey → CoveredScenario
  const discovered = new Map<string, CoveredScenario>();
  if (uncovered.length === 0 || testTitles.length === 0) return discovered;

  // Batch: ask LLM to match each uncovered scenario to a test title
  const scenarioDescriptions = uncovered.map(
    (s, i) =>
      `${i + 1}. ${s.domain}/${s.requirement}/${s.scenarioName}: ` +
      `GIVEN ${s.given[0] ?? '?'}, WHEN ${s.when[0] ?? '?'}, THEN ${s.then[0] ?? '?'}`
  );

  const titleList = testTitles
    .slice(0, 200) // avoid context overflow
    .map((t, i) => `${i + 1}. "${t.text}" (${t.file})`)
    .join('\n');

  const systemPrompt =
    'You are a test coverage analyst. Given a list of spec scenarios and test titles, ' +
    'identify which test title best matches each scenario. ' +
    'Reply ONLY with a JSON array of objects: ' +
    '[{"scenarioIndex": 1, "titleIndex": 3, "similarity": 0.85}, ...]. ' +
    'Only include matches with similarity >= 0.75. ' +
    'Do not include any prose or explanation.';

  const untrustedContent =
    `Scenarios:\n${scenarioDescriptions.join('\n')}\n\n` +
    `Test titles:\n${titleList}`;
  const prompts = protectPrompt(systemPrompt, untrustedContent);

  try {
    const response = await llm.complete({ ...prompts, maxTokens: 2048 });
    // Extract JSON array from response
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return discovered;

    const matches: Array<{ scenarioIndex: number; titleIndex: number; similarity: number }> =
      JSON.parse(jsonMatch[0]);

    for (const match of matches) {
      const scenario = uncovered[match.scenarioIndex - 1];
      const title = testTitles[match.titleIndex - 1];
      if (!scenario || !title) continue;
      if (match.similarity < 0.75) continue;

      const key = `${scenario.domain}::${scenario.requirement}::${scenario.scenarioName}`;
      discovered.set(key, {
        domain: scenario.domain,
        requirement: scenario.requirement,
        scenarioName: scenario.scenarioName,
        testFile: title.file,
        discoveredBy: 'semantic',
        similarity: match.similarity,
      });
    }
  } catch {
    // LLM failure → return empty map (no discovered coverage)
  }

  return discovered;
}

// ============================================================================
// MAIN
// ============================================================================

export async function analyzeTestCoverage(opts: {
  rootPath: string;
  testDirs?: string[];
  domains?: string[];
  driftResult?: DriftResult;
  discover?: boolean;
  llm?: LLMService;
  minCoverage?: number;
}): Promise<TestCoverageReport> {
  const {
    rootPath,
    testDirs = ['spec-tests', 'src'],
    domains,
    driftResult,
    discover = false,
    llm,
    minCoverage,
  } = opts;

  // ── 1. Parse all spec scenarios ──────────────────────────────────────────
  // Dedupe by scenario key up front. parseScenarios does not dedupe, so a spec with
  // two identically-keyed scenarios (same domain::requirement::scenarioName — e.g. a
  // copy-pasted `#### Scenario:` block) would make totalScenarios (a raw count) disagree
  // with the key-deduped covered/uncovered sets and byDomain tallies, breaking the
  // `coveredScenarios + uncovered.length = totalScenarios` invariant. Count each key once.
  const parsedScenarios = await parseScenarios({ rootPath, domains });
  const seenScenarioKeys = new Set<string>();
  const allScenarios = parsedScenarios.filter((s) => {
    const k = `${s.domain}::${s.requirement}::${s.scenarioName}`;
    if (seenScenarioKeys.has(k)) return false;
    seenScenarioKeys.add(k);
    return true;
  });

  // ── 2. Walk test files in testDirs ───────────────────────────────────────
  const testFiles: string[] = [];
  for (const dir of testDirs) {
    const absDir = join(rootPath, dir);
    const found = await walkTestFiles(absDir, rootPath);
    testFiles.push(...found);
  }

  // ── 3. Tag-based scan ────────────────────────────────────────────────────
  const tagCovered: CoveredScenario[] = [];
  const testTitlesForDiscovery: TestTitle[] = [];

  for (const relPath of testFiles) {
    const absPath = join(rootPath, relPath);
    const tagged = await scanTagsInFile(absPath, relPath);
    tagCovered.push(...tagged);

    if (discover && llm) {
      let content = '';
      try { content = await readFile(absPath, 'utf-8'); } catch { /* ignore */ }
      const titles = extractTestTitles(content);
      for (const t of titles) testTitlesForDiscovery.push({ text: t, file: relPath });
    }
  }

  // Build covered key set from tags
  const tagCoveredKeys = new Set(
    tagCovered.map((c) => `${c.domain}::${c.requirement}::${c.scenarioName}`)
  );

  // ── 4. Retroactive discovery (Mode B) ────────────────────────────────────
  let semanticCovered = new Map<string, CoveredScenario>();
  if (discover && llm) {
    const uncoveredScenarios = allScenarios.filter(
      (s) => !tagCoveredKeys.has(`${s.domain}::${s.requirement}::${s.scenarioName}`)
    );
    semanticCovered = await discoverWithLlm(uncoveredScenarios, testTitlesForDiscovery, llm);
  }

  // ── 5. Build final covered / uncovered sets ──────────────────────────────
  // Coverage is counted ONLY against scenarios that actually exist in the parsed
  // specs. Two guards:
  //   - drop tags whose scenario isn't a real parsed scenario (e.g. example/
  //     fixture tags living inside the test suite itself, like the auth specs in
  //     this analyzer's own tests) — otherwise they inflate the count and make
  //     `covered + uncovered ≠ total`.
  //   - dedupe by scenario key so several files tagging the same scenario, or a
  //     repeated tag, count once.
  const scenarioKeys = new Set(
    allScenarios.map((s) => `${s.domain}::${s.requirement}::${s.scenarioName}`)
  );
  const keyOf = (c: CoveredScenario): string =>
    `${c.domain}::${c.requirement}::${c.scenarioName}`;

  // tag entries first, then semantic — first write wins on dedupe, so a tagged
  // scenario keeps its tag attribution.
  const rawCovered: CoveredScenario[] = [...tagCovered, ...semanticCovered.values()];
  const allCovered: CoveredScenario[] = [];
  const allCoveredKeys = new Set<string>();
  for (const c of rawCovered) {
    const k = keyOf(c);
    if (!scenarioKeys.has(k)) continue; // not a real scenario — ignore
    if (allCoveredKeys.has(k)) continue; // already counted
    allCoveredKeys.add(k);
    allCovered.push(c);
  }

  const uncovered: UncoveredScenario[] = allScenarios
    .filter((s) => !allCoveredKeys.has(`${s.domain}::${s.requirement}::${s.scenarioName}`))
    .map((s) => ({
      domain: s.domain,
      requirement: s.requirement,
      scenarioName: s.scenarioName,
      specFile: s.specFile,
    }));

  // ── 6. Compute stale domains ─────────────────────────────────────────────
  const staleDomains: string[] = [];
  if (driftResult) {
    const driftedDomains = new Set(
      driftResult.issues.map((i) => i.domain).filter(Boolean) as string[]
    );
    for (const domain of driftedDomains) staleDomains.push(domain);
  }

  // ── 7. Per-domain breakdown ──────────────────────────────────────────────
  const byDomain: Record<string, DomainCoverage> = {};
  for (const s of allScenarios) {
    if (!byDomain[s.domain]) {
      byDomain[s.domain] = {
        total: 0,
        covered: 0,
        percent: 0,
        hasDrift: staleDomains.includes(s.domain),
      };
    }
    byDomain[s.domain].total++;
    if (allCoveredKeys.has(`${s.domain}::${s.requirement}::${s.scenarioName}`)) {
      byDomain[s.domain].covered++;
    }
  }
  for (const domain of Object.keys(byDomain)) {
    const d = byDomain[domain];
    d.percent = d.total === 0 ? 0 : Math.round((d.covered / d.total) * 1000) / 10;
  }

  // ── 8. Totals ────────────────────────────────────────────────────────────
  // All derived from the deduped, real-scenario-only `allCovered`, so the
  // invariants hold: coveredScenarios = taggedScenarios + discoveredScenarios,
  // and coveredScenarios + uncovered.length = totalScenarios.
  const totalScenarios = allScenarios.length;
  const coveredScenarios = allCovered.length;
  const taggedScenarios = allCovered.filter((c) => c.discoveredBy === 'tag').length;
  const discoveredScenarios = allCovered.filter((c) => c.discoveredBy === 'semantic').length;
  const coveragePercent =
    totalScenarios === 0
      ? 0
      : Math.round((coveredScenarios / totalScenarios) * 1000) / 10;
  const belowThreshold =
    minCoverage !== undefined && coveragePercent < minCoverage;

  return {
    timestamp: new Date().toISOString(),
    totalScenarios,
    taggedScenarios,
    discoveredScenarios,
    coveredScenarios,
    coveragePercent,
    byDomain,
    covered: allCovered,
    uncovered,
    staleDomains,
    belowThreshold,
    minCoverage,
  };
}
