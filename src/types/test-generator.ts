/**
 * Types for spec-driven test generation.
 *
 * These types flow through the test-generator pipeline:
 *   parseScenarios → matchThenClauses → renderTests → writeTestFiles
 * and the coverage pipeline:
 *   analyzeTestCoverage → TestCoverageReport
 */

// ============================================================================
// FRAMEWORK
// ============================================================================

export type TestFramework =
  | 'vitest'
  | 'playwright'
  | 'pytest'
  | 'gtest'
  | 'catch2'
  | 'junit'
  | 'gotest';

/** Maps framework → generated file extension */
export const FRAMEWORK_EXTENSIONS: Record<TestFramework, string> = {
  vitest: '.spec.ts',
  playwright: '.spec.ts',
  pytest: '_test.py',
  gtest: '_test.cpp',
  catch2: '_test.cpp',
  junit: '.java',
  gotest: '_test.go',
};

// ============================================================================
// SCENARIO
// ============================================================================

/** A lightweight reference to an implementation function (from mapping.json) */
export interface FunctionRef {
  name: string;
  file: string;
  line?: number;
  confidence: 'llm' | 'semantic' | 'heuristic';
}

/** One extracted scenario from a spec file */
export interface ParsedScenario {
  domain: string;
  specFile: string;       // e.g. openspec/specs/auth/spec.md (relative to rootPath)
  requirement: string;    // e.g. UserLogin
  scenarioName: string;   // e.g. SuccessfulLogin
  given: string[];        // bullet text, prefix stripped
  when: string[];
  then: string[];
  mappedFunctions: FunctionRef[];

  // Business-logic controls (from <!-- openlore-test: ... --> annotations)
  skip: boolean;
  skipReason?: string;
  tags: string[];
  priority: 'high' | 'normal' | 'low';
}

// ============================================================================
// ASSERTION MATCHING
// ============================================================================

/** One matched assertion line, formatted for a specific framework */
export interface MatchedAssertion {
  /** Human-readable assertion source code for the given framework */
  line: string;
  /** Which THEN clause this came from (0-indexed) */
  thenIndex: number;
  /** true = matched by pattern engine; false = LLM-generated; undefined = placeholder */
  fromPattern?: boolean;
}

// ============================================================================
// GENERATED FILES
// ============================================================================

/** A fully rendered test file ready to be written to disk */
export interface GeneratedTestFile {
  /** Output path relative to rootPath, e.g. spec-tests/auth/user-login.spec.ts */
  outputPath: string;
  domain: string;
  framework: TestFramework;
  scenarios: ParsedScenario[];
  content: string;
  isNew: boolean;   // false if --merge appended to an existing file
}

// ============================================================================
// OPTIONS
// ============================================================================

export interface TestOptions {
  framework: TestFramework | 'auto';
  domains: string[];
  output: string;       // default: spec-tests/
  merge: boolean;
  dryRun: boolean;
  useLlm: boolean;
  limit?: number;
  coverage: boolean;
  discover: boolean;
  minCoverage?: number;
  testDirs: string[];   // for --coverage scan (default: ['spec-tests', 'src'])
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

// ============================================================================
// COVERAGE
// ============================================================================

export interface CoveredScenario {
  domain: string;
  requirement: string;
  scenarioName: string;
  testFile: string;       // path to the test file that covers it
  discoveredBy: 'tag' | 'semantic';  // tag = // openlore: JSON; semantic = --discover match
  similarity?: number;    // only set when discoveredBy === 'semantic'
}

export interface UncoveredScenario {
  domain: string;
  requirement: string;
  scenarioName: string;
  specFile: string;
}

export interface DomainCoverage {
  total: number;
  covered: number;
  percent: number;
  hasDrift: boolean;
}

export interface TestCoverageReport {
  timestamp: string;
  totalScenarios: number;
  taggedScenarios: number;      // covered via // openlore: tag
  discoveredScenarios: number;  // covered via semantic match
  coveredScenarios: number;     // taggedScenarios + discoveredScenarios
  /**
   * `null` when the repository has no spec source: there is nothing to cover, which is not 0%
   * (change: spec-framework-neutrality, task 2.3).
   */
  coveragePercent: number | null;
  /** With `coveragePercent: null`: `no-spec-source`, the sources checked, and a note for a reader. */
  reason?: 'no-spec-source';
  lookedFor?: string[];
  note?: string;
  byDomain: Record<string, DomainCoverage>;
  covered: CoveredScenario[];
  uncovered: UncoveredScenario[];
  staleDomains: string[];       // domains where drift was detected
  belowThreshold: boolean;      // true when minCoverage is set and coverage is under it
  minCoverage?: number;
}
