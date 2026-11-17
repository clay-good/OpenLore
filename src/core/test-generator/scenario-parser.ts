/**
 * Scenario Parser
 *
 * Reads OpenSpec spec files and extracts ParsedScenario objects.
 * Extends openloreGetSpecRequirements to also parse the full G/W/T structure
 * from each "#### Scenario:" block within requirement sections.
 *
 * Mapping enrichment:
 *   If .openlore/analysis/mapping.json exists, each scenario is enriched with
 *   FunctionRef[] for the matching requirement (confidence ≥ heuristic).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_MAPPING,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';
import type { ParsedScenario, FunctionRef } from '../../types/test-generator.js';

// ============================================================================
// ANNOTATION PARSER  (<!-- openlore-test: key=value key=value ... -->)
// ============================================================================

interface ScenarioAnnotation {
  skip: boolean;
  skipReason?: string;
  tags: string[];
  priority: 'high' | 'normal' | 'low';
}

const DEFAULT_ANNOTATION: ScenarioAnnotation = {
  skip: false,
  tags: [],
  priority: 'normal',
};

/**
 * Parse a `<!-- openlore-test: ... -->` comment immediately following a
 * `#### Scenario:` heading. Returns default values if no annotation present.
 *
 * Supported keys:
 *   skip              flag (presence = true)
 *   skip=true|false
 *   reason="…"        skip reason (only meaningful when skip is set)
 *   tags=smoke,regression
 *   priority=high|normal|low
 */
function parseAnnotation(lines: string[]): ScenarioAnnotation {
  // Look at the first few non-empty body lines for an HTML comment annotation
  for (const line of lines.slice(0, 3)) {
    const trimmed = line.trim();
    const m = trimmed.match(/^<!--\s*openlore-test:\s*(.*?)\s*-->$/i);
    if (!m) continue;

    const raw = m[1];
    const result: ScenarioAnnotation = { skip: false, tags: [], priority: 'normal' };

    // key=value pairs (value may be quoted)
    const pairs = raw.matchAll(/(\w+)(?:=(?:"([^"]*?)"|([^\s"]+)))?/g);
    for (const pair of pairs) {
      const key = pair[1].toLowerCase();
      const value = (pair[2] ?? pair[3] ?? '').trim();
      switch (key) {
        case 'skip':
          result.skip = value === '' || value.toLowerCase() !== 'false';
          break;
        case 'reason':
          result.skipReason = value;
          break;
        case 'tags':
          result.tags = value.split(',').map((t) => t.trim()).filter(Boolean);
          break;
        case 'priority':
          if (value === 'high' || value === 'low') result.priority = value;
          break;
      }
    }
    return result;
  }
  return { ...DEFAULT_ANNOTATION };
}

// ============================================================================
// TYPES
// ============================================================================

interface MappingEntry {
  requirement: string;
  domain: string;
  specFile: string;
  functions?: Array<{
    name: string;
    file: string;
    line?: number;
    confidence: string;
  }>;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Slugify a string to kebab-case for file names */
export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase();
}

/** Extract bullet text from lines like "- **GIVEN** ..." or "- **given** ..." */
function extractBullets(lines: string[], keyword: string): string[] {
  const upper = keyword.toUpperCase();
  const results: string[] = [];
  for (const line of lines) {
    // Match: - **GIVEN** text  OR  - **given** text  OR  - GIVEN: text
    const m = line.match(
      new RegExp(`^\\s*[-*]\\s*\\*{0,2}${upper}\\*{0,2}:?\\s*(.+)`, 'i')
    );
    if (m) {
      results.push(m[1].trim());
    }
  }
  return results;
}

/** Check if a scenario block has a complete G/W/T */
function isComplete(given: string[], when: string[], then: string[]): boolean {
  return given.length > 0 && when.length > 0 && then.length > 0;
}

// ============================================================================
// MAPPING LOADER
// ============================================================================

async function loadMapping(
  rootPath: string
): Promise<Map<string, FunctionRef[]>> {
  const map = new Map<string, FunctionRef[]>();
  const mappingPath = join(
    rootPath,
    OPENLORE_DIR,
    OPENLORE_ANALYSIS_SUBDIR,
    ARTIFACT_MAPPING
  );

  if (!(await fileExists(mappingPath))) return map;

  try {
    const raw = JSON.parse(await readFile(mappingPath, 'utf-8'));
    const entries: MappingEntry[] = raw?.mappings ?? [];
    for (const entry of entries) {
      if (!entry.requirement || !Array.isArray(entry.functions)) continue;
      const refs: FunctionRef[] = entry.functions.map((f) => ({
        name: f.name,
        file: f.file,
        line: f.line,
        confidence: (f.confidence as FunctionRef['confidence']) ?? 'heuristic',
      }));
      map.set(entry.requirement.toLowerCase(), refs);
    }
  } catch {
    // Silently ignore malformed mapping
  }
  return map;
}

// ============================================================================
// SPEC FILE WALKER
// ============================================================================

/** Whether the repository has any spec to read scenarios from (no spec source is not 0% coverage). */
export async function hasSpecFiles(rootPath: string): Promise<boolean> {
  return (await findSpecFiles(join(rootPath, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR))).length > 0;
}

async function findSpecFiles(
  specsDir: string,
  domains?: string[]
): Promise<Array<{ domain: string; path: string }>> {
  const results: Array<{ domain: string; path: string }> = [];

  if (!(await fileExists(specsDir))) return results;

  let entries: string[];
  try {
    entries = await readdir(specsDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Each entry is a domain directory (or overview, architecture, etc.)
    if (domains && domains.length > 0) {
      const domainLower = entry.toLowerCase();
      const filtered = domains.map((d) => d.toLowerCase());
      if (!filtered.includes(domainLower)) continue;
    }

    const specFile = join(specsDir, entry, 'spec.md');
    if (await fileExists(specFile)) {
      results.push({ domain: entry, path: specFile });
    }
  }

  return results;
}

// ============================================================================
// CORE PARSER
// ============================================================================

/**
 * Parse all scenarios from OpenSpec spec files.
 *
 * @param opts.rootPath        Project root (default: process.cwd())
 * @param opts.domains         If set, only parse these domains
 * @param opts.excludeDomains  Skip these domains even if included above
 * @param opts.tags            If set, only include scenarios that carry ALL these tags
 * @param opts.limit           Maximum number of scenarios to return (applied after filters)
 * @param opts.includeSkipped  If true, include scenarios marked skip=true (default: false)
 */
export async function parseScenarios(opts: {
  rootPath?: string;
  domains?: string[];
  excludeDomains?: string[];
  tags?: string[];
  limit?: number;
  includeSkipped?: boolean;
}): Promise<ParsedScenario[]> {
  const rootPath = opts.rootPath ?? process.cwd();
  const specsDir = join(rootPath, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR);
  const excludeSet = new Set(
    (opts.excludeDomains ?? []).map((d) => d.toLowerCase())
  );
  const requiredTags = opts.tags ?? [];

  const [specFiles, mappingMap] = await Promise.all([
    findSpecFiles(specsDir, opts.domains),
    loadMapping(rootPath),
  ]);

  const scenarios: ParsedScenario[] = [];

  for (const { domain, path: specPath } of specFiles) {
    // Domain-level exclusion
    if (excludeSet.has(domain.toLowerCase())) continue;
    let content: string;
    try {
      content = await readFile(specPath, 'utf-8');
    } catch {
      continue;
    }

    const specFileRel = specPath.replace(resolve(rootPath) + '/', '');

    // Split into requirement sections (### Requirement: <name>)
    const reqSections = content.split(/^###\s+Requirement:\s*/m);

    for (let ri = 1; ri < reqSections.length; ri++) {
      const reqBlock = reqSections[ri];
      const reqLines = reqBlock.split('\n');
      const requirement = reqLines[0].trim();
      if (!requirement) continue;

      const functions = mappingMap.get(requirement.toLowerCase()) ?? [];

      // Split into scenario sections (#### Scenario: <name>)
      const scenarioSections = reqBlock.split(/^####\s+Scenario:\s*/m);

      for (let si = 1; si < scenarioSections.length; si++) {
        const scenBlock = scenarioSections[si];
        const scenLines = scenBlock.split('\n');
        const scenarioName = scenLines[0].trim();
        if (!scenarioName) continue;

        const bodyLines = scenLines.slice(1);

        const given = extractBullets(bodyLines, 'given');
        const when = extractBullets(bodyLines, 'when');
        const then = extractBullets(bodyLines, 'then');

        if (!isComplete(given, when, then)) {
          // Incomplete G/W/T — skip silently (caller may log)
          continue;
        }

        // Parse inline annotation (<!-- openlore-test: ... -->)
        const annotation = parseAnnotation(bodyLines);

        // Filter: skipped scenarios (unless caller explicitly wants them)
        if (annotation.skip && !opts.includeSkipped) continue;

        // Filter: tag-based inclusion
        if (requiredTags.length > 0) {
          const hasAll = requiredTags.every((t) => annotation.tags.includes(t));
          if (!hasAll) continue;
        }

        scenarios.push({
          domain,
          specFile: specFileRel,
          requirement,
          scenarioName,
          given,
          when,
          then,
          mappedFunctions: functions,
          skip: annotation.skip,
          skipReason: annotation.skipReason,
          tags: annotation.tags,
          priority: annotation.priority,
        });

        if (opts.limit && scenarios.length >= opts.limit) {
          return scenarios;
        }
      }
    }
  }

  return scenarios;
}
