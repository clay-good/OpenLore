/**
 * Test Generator Orchestrator
 *
 * Groups ParsedScenarios by (domain, requirement) → calls matchThenClauses
 * → renders test file content via framework renderers.
 *
 * Two modes:
 *   - Default: THEN pattern engine only (no LLM, instant)
 *   - --use-llm: Pattern engine first; LLM fills in unmatched THEN clauses
 *     by reading mapped function source code.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import type { ParsedScenario, GeneratedTestFile, TestFramework, FunctionRef } from '../../types/test-generator.js';
import type { LLMService } from '../services/llm-service.js';
import { matchThenClauses } from './then-matchers.js';
import type { ThenMatch } from './then-matchers.js';
import { renderTests } from './renderers/index.js';
import { toKebabCase } from './scenario-parser.js';
import { toSnakeCase, toPascalCase } from './renderers/shared.js';
import { FRAMEWORK_EXTENSIONS } from '../../types/test-generator.js';
import { protectPrompt } from '../../utils/prompt-boundary.js';

// ============================================================================
// TYPES
// ============================================================================

export interface GenerateTestsOptions {
  scenarios: ParsedScenario[];
  framework: TestFramework;
  outputDir: string;        // relative to rootPath, e.g. "spec-tests"
  rootPath: string;
  useLlm?: boolean;
  llm?: LLMService;
}

// ============================================================================
// LLM ASSERTION ENRICHMENT
// ============================================================================

/** Read up to maxFunctions mapped function source snippets */
async function readFunctionSnippets(
  rootPath: string,
  functions: FunctionRef[],
  maxFunctions = 3
): Promise<string> {
  const eligible = functions
    .filter((f) => f.confidence === 'llm' || f.confidence === 'semantic')
    .slice(0, maxFunctions);

  const snippets: string[] = [];
  for (const fn of eligible) {
    const absPath = resolve(rootPath, fn.file);
    if (!(await fileExists(absPath))) continue;
    try {
      const source = await readFile(absPath, 'utf-8');
      const lines = source.split('\n');
      const start = Math.max(0, (fn.line ?? 1) - 1);
      const end = Math.min(lines.length, start + 40);
      const snippet = lines.slice(start, end).join('\n');
      snippets.push(`// ${fn.file}: ${fn.name}()\n${snippet}`);
    } catch {
      // ignore unreadable files
    }
  }
  return snippets.join('\n\n---\n\n');
}

/**
 * Use LLM to fill in assertions for THEN clauses that the pattern engine
 * could not match (fromPattern === false).
 */
async function enrichWithLlm(
  scenario: ParsedScenario,
  currentMatches: ThenMatch[],
  framework: TestFramework,
  llm: LLMService,
  rootPath: string
): Promise<ThenMatch[]> {
  const unmatched = currentMatches.filter((m) => !m.fromPattern);
  if (unmatched.length === 0) return currentMatches;

  const snippets = await readFunctionSnippets(rootPath, scenario.mappedFunctions);
  const unmatchedClauses = unmatched.map((m) => scenario.then[m.thenIndex]);

  const frameworkHint: Record<TestFramework, string> = {
    vitest: 'Vitest (TypeScript) — use expect(...).toBe/toEqual/toHaveProperty etc.',
    playwright: 'Playwright (TypeScript) — use expect(response.status()).toBe() etc.',
    pytest: 'pytest (Python) — use assert statements',
    gtest: 'Google Test (C++) — use EXPECT_EQ, EXPECT_TRUE, EXPECT_EQ etc.',
    catch2: 'Catch2 (C++) — use REQUIRE, CHECK macros',
    junit: 'JUnit 5 (Java) — use assertEquals, assertTrue, assertNotNull, assertThrows (static imports)',
    gotest: 'Go testing (standard library) — use t.Errorf / t.Fatal with if-condition checks, no assert library',
  };

  const systemPrompt =
    `You are a test engineer. Generate assertion lines for spec scenarios. ` +
    `Framework: ${frameworkHint[framework]}. ` +
    `Return ONLY valid assertion lines, one per line, no prose, no backticks.`;

  const untrustedContent =
    `Scenario: ${scenario.domain} / ${scenario.requirement} / ${scenario.scenarioName}\n\n` +
    `GIVEN:\n${scenario.given.map((g) => `  - ${g}`).join('\n')}\n\n` +
    `WHEN:\n${scenario.when.map((w) => `  - ${w}`).join('\n')}\n\n` +
    `Generate assertions for these THEN clauses:\n` +
    unmatchedClauses.map((t, i) => `  ${i + 1}. ${t}`).join('\n') +
    (snippets
      ? `\n\nRelated implementation:\n\`\`\`\n${snippets}\n\`\`\``
      : '');
  const prompts = protectPrompt(systemPrompt, untrustedContent);

  try {
    const response = await llm.complete({
      ...prompts,
      maxTokens: 512,
    });

    const generatedLines = response.content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('```'));

    if (generatedLines.length === 0) return currentMatches;

    // Replace placeholder matches with LLM-generated ones
    const result = [...currentMatches];
    let lineOffset = 0;
    for (const match of unmatched) {
      const idx = result.findIndex((m) => m.thenIndex === match.thenIndex);
      if (idx === -1) continue;
      // Take a slice of generatedLines for this match (rough heuristic: divide evenly)
      const linesPerClause = Math.ceil(generatedLines.length / unmatched.length);
      const assignedLines = generatedLines.slice(
        lineOffset,
        lineOffset + linesPerClause
      );
      lineOffset += linesPerClause;
      result[idx] = {
        lines: assignedLines.length > 0 ? assignedLines : match.lines,
        thenIndex: match.thenIndex,
        fromPattern: false,
      };
    }
    return result;
  } catch {
    // LLM failure → keep pattern engine placeholders
    return currentMatches;
  }
}

// ============================================================================
// FILE NAMING
// ============================================================================

function outputFilename(
  domain: string,
  requirement: string,
  framework: TestFramework
): string {
  const ext = FRAMEWORK_EXTENSIONS[framework];
  if (framework === 'pytest') {
    return `${toSnakeCase(domain)}/${toSnakeCase(requirement)}_test.py`;
  }
  if (framework === 'gtest' || framework === 'catch2') {
    return `${toSnakeCase(domain)}/${toSnakeCase(requirement)}_test.cpp`;
  }
  if (framework === 'gotest') {
    return `${toSnakeCase(domain)}/${toSnakeCase(requirement)}_test.go`;
  }
  if (framework === 'junit') {
    // Java requires the public class name to match the file basename; the
    // junit renderer emits `class <Requirement>Test`, so the file must be
    // `<Requirement>Test.java` (PascalCase, no kebab/snake separators).
    return `${toPascalCase(domain)}/${toPascalCase(requirement)}Test.java`;
  }
  return `${toKebabCase(domain)}/${toKebabCase(requirement)}${ext}`;
}

// ============================================================================
// MAIN
// ============================================================================

/**
 * Generate test files from parsed scenarios.
 * Groups by (domain, requirement) → one file per requirement.
 */
const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

/**
 * Generate test files from parsed scenarios.
 * Groups by (domain, requirement) → one file per requirement.
 * Scenarios are sorted by priority (high → normal → low) before grouping
 * so that high-priority groups appear first and consume LLM budget first
 * when --limit is in effect upstream.
 */
export async function generateTests(
  opts: GenerateTestsOptions
): Promise<GeneratedTestFile[]> {
  const { scenarios, framework, outputDir, rootPath, useLlm, llm } = opts;

  // Sort by priority so high-priority scenarios / requirements come first
  const sorted = [...scenarios].sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
  );

  // Group scenarios by domain + requirement (preserving sorted order)
  const groups = new Map<string, ParsedScenario[]>();
  for (const s of sorted) {
    const key = `${s.domain}::${s.requirement}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const files: GeneratedTestFile[] = [];

  for (const [, groupScenarios] of groups) {
    const { domain, requirement } = groupScenarios[0];

    // Match THEN clauses for each scenario
    let matchesByScenario: ThenMatch[][] = groupScenarios.map((s) =>
      matchThenClauses(s.then, framework)
    );

    // Optionally enrich unmatched clauses with LLM
    if (useLlm && llm) {
      matchesByScenario = await Promise.all(
        groupScenarios.map((s, i) =>
          enrichWithLlm(s, matchesByScenario[i], framework, llm, rootPath)
        )
      );
    }

    const content = renderTests(
      framework,
      domain,
      requirement,
      groupScenarios,
      matchesByScenario
    );

    const relPath = outputFilename(domain, requirement, framework);
    const outputPath = join(outputDir, relPath);

    files.push({
      outputPath,
      domain,
      framework,
      scenarios: groupScenarios,
      content,
      isNew: true, // test-writer will update this based on disk state
    });
  }

  return files;
}
