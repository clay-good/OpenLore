/**
 * Mapping Generator
 *
 * Builds a requirement→function mapping artifact from pipeline results and
 * the dependency graph. Written to .openlore/analysis/mapping.json.
 *
 * Enables refactoring workflows: dead code detection, naming normalization.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  SIMILARITY_CONTAINMENT_SCORE,
  SIMILARITY_TOKEN_OVERLAP_WEIGHT,
  HEURISTIC_MATCH_MIN_SCORE,
  MAX_HEURISTIC_MATCHES_PER_OP,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENSPEC_DIR,
  ARTIFACT_MAPPING,
} from '../../constants.js';
import type { PipelineResult } from './spec-pipeline.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import type { SearchResult } from '../analyzer/vector-index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface FunctionRef {
  name: string;
  file: string;    // relative path
  line: number;
  kind: string;
  confidence: 'llm' | 'semantic' | 'heuristic';
}

export interface RequirementMapping {
  requirement: string;   // operation.name
  service: string;       // service.name
  domain: string;        // service.domain
  specFile: string;      // openspec/specs/{domain}/spec.md
  functions: FunctionRef[];
}

export interface MappingArtifact {
  version?: 2;
  generatedAt: string;
  /** Fingerprint of the exported-symbol inventory the mappings were built from. */
  sourceAnalysisFingerprint?: string;
  mappings: RequirementMapping[];
  orphanFunctions: FunctionRef[];
  stats: {
    totalRequirements: number;
    mappedRequirements: number;
    totalExportedFunctions: number;
    orphanCount: number;
  };
}

/** Stable provenance key shared by mapping generation and coverage readers. */
export function mappingSourceFingerprint(depGraph: DependencyGraphResult): string {
  const exports = depGraph.nodes.flatMap(node => node.exports
    .filter(exp => !exp.isType)
    .map(exp => `${node.file.path}\u0000${exp.name}\u0000${exp.kind}\u0000${exp.line}`))
    .sort();
  return createHash('sha256').update(exports.join('\n')).digest('hex');
}

// ============================================================================
// HELPERS
// ============================================================================

/** Normalize a name for fuzzy matching: lowercase, alphanumeric only */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Split camelCase/PascalCase into tokens for better matching */
function tokenize(name: string): string[] {
  return name
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
}

/** Score similarity between an operation name and a function name */
function similarityScore(operationName: string, functionName: string): number {
  const opNorm = normalize(operationName);
  const fnNorm = normalize(functionName);

  // Exact normalized match
  if (opNorm === fnNorm) return 1.0;

  // Containment
  if (fnNorm.includes(opNorm) || opNorm.includes(fnNorm)) return SIMILARITY_CONTAINMENT_SCORE;

  // Token overlap
  const opTokens = new Set(tokenize(operationName));
  const fnTokens = new Set(tokenize(functionName));
  const intersection = [...opTokens].filter(t => fnTokens.has(t)).length;
  const union = new Set([...opTokens, ...fnTokens]).size;
  if (union === 0) return 0;
  return (intersection / union) * SIMILARITY_TOKEN_OVERLAP_WEIGHT;
}

// ============================================================================
// MAPPING GENERATOR
// ============================================================================

/**
 * A semantic search function closed over VectorIndex + EmbeddingService + outputDir.
 * Returns ranked results (closest first, score = cosine distance) for a text query.
 */
export type SemanticSearchFn = (query: string, limit: number) => Promise<SearchResult[]>;

/**
 * Maximum cosine distance to accept a semantic match.
 * Equivalent to cosine similarity >= 0.65 (distance = 1 - similarity).
 */
const SEMANTIC_MAX_DISTANCE = 0.35;

export class MappingGenerator {
  private rootPath: string;
  private openspecPath: string;
  private semanticSearch?: SemanticSearchFn;

  constructor(
    rootPath: string,
    openspecPath = OPENSPEC_DIR,
    semanticSearch?: SemanticSearchFn
  ) {
    this.rootPath = rootPath;
    this.openspecPath = openspecPath;
    this.semanticSearch = semanticSearch;
  }

  /** Semantic lookup: returns FunctionRefs matched by vector similarity */
  private async semanticMatch(
    query: string,
    exportIndex: Map<string, FunctionRef[]>
  ): Promise<FunctionRef[]> {
    if (!this.semanticSearch) return [];

    let results: SearchResult[];
    try {
      results = await this.semanticSearch(query, 5);
    } catch {
      return [];
    }

    const matched: FunctionRef[] = [];
    for (const r of results.filter(r => r.score <= SEMANTIC_MAX_DISTANCE)) {
      const refs = exportIndex.get(r.record.name);
      if (refs && refs.length > 0) {
        for (const ref of refs) {
          matched.push({ ...ref, confidence: 'semantic' });
        }
      }
    }
    return matched.slice(0, MAX_HEURISTIC_MATCHES_PER_OP);
  }

  async generate(
    pipeline: PipelineResult,
    depGraph: DependencyGraphResult
  ): Promise<MappingArtifact> {
    // Build export index: name → list of FunctionRef (multiple files can export same name)
    const exportIndex = new Map<string, FunctionRef[]>();

    for (const node of depGraph.nodes) {
      const relPath = node.file.path;
      for (const exp of node.exports) {
        if (exp.isType) continue; // skip type-only exports

        const ref: FunctionRef = {
          name: exp.name,
          file: relPath,
          line: exp.line,
          kind: exp.kind,
          confidence: 'llm', // placeholder, overwritten below
        };

        const existing = exportIndex.get(exp.name) ?? [];
        existing.push(ref);
        exportIndex.set(exp.name, existing);
      }
    }

    const mappings: RequirementMapping[] = [];
    const mappedFunctionNames = new Set<string>(); // track name+file combos

    for (const service of pipeline.services) {
      const domain = service.domain || 'core';
      const specFile = `${this.openspecPath}/specs/${domain.toLowerCase()}/spec.md`;

      for (const op of service.operations) {
        const functions: FunctionRef[] = [];

        // 1. LLM-provided functionName — direct lookup
        if (op.functionName && op.functionName.trim()) {
          const refs = exportIndex.get(op.functionName.trim());
          if (refs && refs.length > 0) {
            for (const ref of refs) {
              functions.push({ ...ref, confidence: 'llm' });
              mappedFunctionNames.add(`${ref.name}::${ref.file}`);
            }
          }
        }

        // 2. Semantic fallback — vector similarity on operation name + description
        if (functions.length === 0) {
          const query = op.description ? `${op.name} ${op.description}` : op.name;
          const semanticRefs = await this.semanticMatch(query, exportIndex);
          for (const ref of semanticRefs) {
            functions.push(ref);
            mappedFunctionNames.add(`${ref.name}::${ref.file}`);
          }
        }

        // 3. Heuristic fallback — find best matching export(s)
        if (functions.length === 0) {
          const scored: Array<{ ref: FunctionRef; score: number }> = [];
          for (const [name, refs] of exportIndex) {
            const score = similarityScore(op.name, name);
            if (score >= HEURISTIC_MATCH_MIN_SCORE) {
              for (const ref of refs) {
                scored.push({ ref, score });
              }
            }
          }
          scored.sort((a, b) => b.score - a.score);
          const top = scored.slice(0, MAX_HEURISTIC_MATCHES_PER_OP);
          for (const { ref } of top) {
            functions.push({ ...ref, confidence: 'heuristic' });
            mappedFunctionNames.add(`${ref.name}::${ref.file}`);
          }
        }

        mappings.push({
          requirement: op.name,
          service: service.name,
          domain,
          specFile,
          functions,
        });
      }

      // Sub-spec operations: map each sub-component's operations to its callee function
      for (const sub of service.subSpecs ?? []) {
        // The callee is a direct LLM-identified function name — prefer exact match
        const calleeRefs = exportIndex.get(sub.callee) ?? [];

        for (const op of sub.operations ?? []) {
          const functions: FunctionRef[] = [];

          // 1. LLM-provided callee — direct lookup
          if (calleeRefs.length > 0) {
            for (const ref of calleeRefs) {
              functions.push({ ...ref, confidence: 'llm' });
              mappedFunctionNames.add(`${ref.name}::${ref.file}`);
            }
          }

          // 2. Semantic fallback
          if (functions.length === 0) {
            const query = op.description ? `${op.name} ${op.description}` : op.name;
            const semanticRefs = await this.semanticMatch(query, exportIndex);
            for (const ref of semanticRefs) {
              functions.push(ref);
              mappedFunctionNames.add(`${ref.name}::${ref.file}`);
            }
          }

          // 3. Heuristic fallback on operation name
          if (functions.length === 0) {
            const scored: Array<{ ref: FunctionRef; score: number }> = [];
            for (const [name, refs] of exportIndex) {
              const score = similarityScore(op.name, name);
              if (score >= HEURISTIC_MATCH_MIN_SCORE) {
                for (const ref of refs) scored.push({ ref, score });
              }
            }
            scored.sort((a, b) => b.score - a.score);
            for (const { ref } of scored.slice(0, MAX_HEURISTIC_MATCHES_PER_OP)) {
              functions.push({ ...ref, confidence: 'heuristic' });
              mappedFunctionNames.add(`${ref.name}::${ref.file}`);
            }
          }

          mappings.push({
            requirement: op.name,
            service: `${service.name}/${sub.name}`,
            domain,
            specFile,
            functions,
          });
        }
      }
    }

    // Orphan functions: exported, non-type, not referenced in any mapping
    const orphanFunctions: FunctionRef[] = [];
    for (const [name, refs] of exportIndex) {
      for (const ref of refs) {
        if (!mappedFunctionNames.has(`${name}::${ref.file}`)) {
          orphanFunctions.push({ ...ref, confidence: 'heuristic' });
        }
      }
    }

    const artifact: MappingArtifact = {
      version: 2,
      generatedAt: new Date().toISOString(),
      sourceAnalysisFingerprint: mappingSourceFingerprint(depGraph),
      mappings,
      orphanFunctions,
      stats: {
        totalRequirements: mappings.length,
        mappedRequirements: mappings.filter(m => m.functions.length > 0).length,
        totalExportedFunctions: [...exportIndex.values()].reduce((s, refs) => s + refs.length, 0),
        orphanCount: orphanFunctions.length,
      },
    };

    await this.write(artifact);
    return artifact;
  }

  private async write(artifact: MappingArtifact): Promise<void> {
    const outPath = join(this.rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_MAPPING);
    await writeFile(outPath, JSON.stringify(artifact, null, 2), 'utf-8');
  }

  /** Load an existing mapping artifact */
  static async load(rootPath: string): Promise<MappingArtifact | null> {
    try {
      const content = await readFile(
        join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_MAPPING),
        'utf-8'
      );
      return JSON.parse(content) as MappingArtifact;
    } catch {
      return null;
    }
  }
}
