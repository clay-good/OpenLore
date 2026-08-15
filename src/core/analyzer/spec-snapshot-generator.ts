/**
 * Spec Snapshot Generator
 *
 * Derives a compact coverage summary from existing analysis artifacts —
 * no LLM required. Reads llm-context.json, mapping.json, and spec files
 * to produce spec-snapshot.json.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_MAPPING,
  ARTIFACT_SPEC_SNAPSHOT,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
} from '../../constants.js';
import type { SpecSnapshot, SpecSnapshotDomain, SpecSnapshotHub } from '../../types/index.js';
import type { LLMContext } from './artifact-generator.js';
import type { MappingArtifact } from '../generator/mapping-generator.js';
import type { SerializedCallGraph, FunctionNode } from './call-graph.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// GIT HELPERS
// ============================================================================

async function getGitState(rootPath: string): Promise<{ commit: string; branch: string; dirty: boolean }> {
  try {
    const [commitResult, branchResult, statusResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootPath }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootPath }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['status', '--porcelain'], { cwd: rootPath }).catch(() => ({ stdout: '' })),
    ]);
    return {
      commit: commitResult.stdout.trim() || 'unknown',
      branch: branchResult.stdout.trim() || 'unknown',
      dirty: statusResult.stdout.trim().length > 0,
    };
  } catch {
    return { commit: 'unknown', branch: 'unknown', dirty: false };
  }
}

// ============================================================================
// SPEC FILE HELPERS
// ============================================================================

/** Count H2/H3 headings in a spec.md as a proxy for requirement count. */
function countRequirements(content: string): number {
  const matches = content.match(/^#{2,3} /gm);
  return matches ? matches.length : 0;
}

/** Get max mtime across a list of file paths (returns epoch ISO string if none exist). */
async function maxMtime(filePaths: string[], rootPath: string): Promise<string> {
  let max = 0;
  for (const rel of filePaths) {
    try {
      const s = await stat(join(rootPath, rel));
      if (s.mtimeMs > max) max = s.mtimeMs;
    } catch { /* file may not exist */ }
  }
  return max > 0 ? new Date(max).toISOString() : new Date(0).toISOString();
}

// ============================================================================
// DOMAIN DISCOVERY
// ============================================================================

interface SpecDomainInfo {
  name: string;
  specFile: string;
  specModifiedAt: string;
  requirementCount: number;
}

async function discoverSpecDomains(openspecPath: string, rootPath: string): Promise<SpecDomainInfo[]> {
  const specsDir = join(openspecPath, OPENSPEC_SPECS_SUBDIR);
  let entries: string[];
  try {
    entries = await readdir(specsDir);
  } catch {
    return [];
  }

  const domains: SpecDomainInfo[] = [];
  for (const entry of entries) {
    const specFilePath = join(specsDir, entry, 'spec.md');
    try {
      const [content, s] = await Promise.all([
        readFile(specFilePath, 'utf-8'),
        stat(specFilePath),
      ]);
      domains.push({
        name: entry,
        specFile: relative(rootPath, specFilePath),
        specModifiedAt: s.mtime.toISOString(),
        requirementCount: countRequirements(content),
      });
    } catch { /* skip missing spec.md */ }
  }
  return domains;
}

// ============================================================================
// COVERAGE COMPUTATION
// ============================================================================

function buildCoveredFunctionSet(mapping: MappingArtifact): Set<string> {
  const covered = new Set<string>();
  for (const m of mapping.mappings) {
    for (const fn of m.functions) {
      if (fn.name && fn.name !== '*') {
        covered.add(`${fn.file}::${fn.name}`);
        covered.add(fn.name); // also by name alone for looser matching
      }
    }
  }
  return covered;
}

function isFunctionCovered(node: FunctionNode, covered: Set<string>): boolean {
  const byFileAndName = `${node.filePath}::${node.name}`;
  return covered.has(byFileAndName) || covered.has(node.name);
}

// ============================================================================
// PUBLIC API
// ============================================================================

export class SpecSnapshotGenerator {
  constructor(
    private readonly rootPath: string,
    private readonly openspecRelPath: string = OPENSPEC_DIR,
  ) {}

  async generate(options: { persist?: boolean } = {}): Promise<SpecSnapshot> {
    const analysisDir = join(this.rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    const openspecPath = join(this.rootPath, this.openspecRelPath);

    // Load artifacts in parallel
    const [llmContextRaw, mappingRaw, git, specDomains] = await Promise.all([
      readFile(join(analysisDir, ARTIFACT_LLM_CONTEXT), 'utf-8').catch(() => null),
      readFile(join(analysisDir, ARTIFACT_MAPPING), 'utf-8').catch(() => null),
      getGitState(this.rootPath),
      discoverSpecDomains(openspecPath, this.rootPath),
    ]);

    const llmContext = llmContextRaw ? JSON.parse(llmContextRaw) as LLMContext : null;
    const mapping = mappingRaw ? JSON.parse(mappingRaw) as MappingArtifact : null;

    const callGraph = llmContext?.callGraph as SerializedCallGraph | undefined;
    const allNodes = callGraph?.nodes ?? [];
    const hubNodes = callGraph?.hubFunctions ?? [];

    // Build coverage index from mapping
    const covered = mapping ? buildCoveredFunctionSet(mapping) : new Set<string>();
    const coveredCount = mapping ? allNodes.filter(n => isFunctionCovered(n, covered)).length : 0;
    const orphanCount = mapping?.orphanFunctions?.length ?? 0;
    const totalFunctions = allNodes.length;

    // Build per-domain info
    // For each spec domain, find which mapping entries belong to it
    const domainMappings = new Map<string, { mappedFunctions: Set<string>; sourceFiles: Set<string> }>();
    if (mapping) {
      for (const m of mapping.mappings) {
        const entry = domainMappings.get(m.domain) ?? { mappedFunctions: new Set(), sourceFiles: new Set() };
        for (const fn of m.functions) {
          if (fn.name && fn.name !== '*') entry.mappedFunctions.add(fn.name);
          if (fn.file && fn.file !== '*') entry.sourceFiles.add(fn.file);
        }
        domainMappings.set(m.domain, entry);
      }
    }

    const domains: SpecSnapshotDomain[] = await Promise.all(
      specDomains.map(async (d) => {
        const dm = domainMappings.get(d.name);
        const sourceFiles = dm ? Array.from(dm.sourceFiles) : [];
        const mappedFunctionCount = dm ? dm.mappedFunctions.size : 0;
        const sourcesModifiedAt = await maxMtime(sourceFiles, this.rootPath);
        const coveragePct = d.requirementCount > 0
          ? Math.round((mappedFunctionCount / Math.max(d.requirementCount, mappedFunctionCount)) * 100)
          : 0;
        return {
          name: d.name,
          specFile: d.specFile,
          sourceFiles,
          requirementCount: d.requirementCount,
          mappedFunctionCount,
          coveragePct,
          specModifiedAt: d.specModifiedAt,
          sourcesModifiedAt,
        };
      })
    );

    // Hub coverage
    const hubs: SpecSnapshotHub[] = hubNodes.map(n => ({
      name: n.name,
      file: n.filePath,
      fanIn: n.fanIn,
      covered: isFunctionCovered(n, covered),
    }));

    const snapshot: SpecSnapshot = {
      version: '1',
      generatedAt: new Date().toISOString(),
      git,
      coverage: {
        totalFunctions,
        coveredFunctions: coveredCount,
        orphanFunctions: orphanCount,
        coveragePct: totalFunctions > 0 ? Math.round((coveredCount / totalFunctions) * 100) : 0,
      },
      domains,
      hubs,
    };

    if (options.persist ?? true) {
      await writeFile(
        join(analysisDir, ARTIFACT_SPEC_SNAPSHOT),
        JSON.stringify(snapshot, null, 2),
      );
    }

    return snapshot;
  }

  /** Load a previously generated snapshot, or return null if not found. */
  static async load(rootPath: string): Promise<SpecSnapshot | null> {
    try {
      const raw = await readFile(
        join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_SPEC_SNAPSHOT),
        'utf-8',
      );
      return JSON.parse(raw) as SpecSnapshot;
    } catch {
      return null;
    }
  }
}
