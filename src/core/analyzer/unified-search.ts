/**
 * Unified Search
 *
 * Combines code and spec indexes with cross-scoring to boost results
 * that are linked through bidirectional mappings.
 *
 * Usage:
 *   const results = await UnifiedSearch.unifiedSearch(
 *     outputDir,
 *     "validate user authentication",
 *     embedSvc,
 *     { limit: 10 }
 *   );
 */

import { join } from 'node:path';
import type { Embedder } from './embedding-service.js';
import type { SearchResult as CodeSearchResult } from './vector-index.js';
import type { SpecSearchResult } from './spec-vector-index.js';
import { requireMatchEvidence, type MatchEvidence } from './retrieval-evidence.js';

// ============================================================================
// TYPES
// ============================================================================

export interface UnifiedSearchResult {
  id: string;
  type: 'code' | 'spec' | 'both';
  score: number;
  baseScore: number;
  mappingBoost: number;
  matchEvidence: MatchEvidence;
  source: {
    filePath?: string;
    functionName?: string;
    className?: string;
    domain?: string;
    section?: string;
    title?: string;
    language?: string;
  };
  linkedArtifacts: Array<{
    type: 'code' | 'spec';
    id: string;
    score: number;
  }>;
}

export interface CrossScoringConfig {
  directMappingBoost: number;
  reverseMappingBoost: number;
  mutualMappingBoost: number;
  additionalLinkBoost: number;
  maxAdditionalBoost: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONFIG: CrossScoringConfig = {
  directMappingBoost: 0.3,
  reverseMappingBoost: 0.3,
  mutualMappingBoost: 0.5,
  additionalLinkBoost: 0.1,
  maxAdditionalBoost: 0.3,
};

// ============================================================================
// MAPPING INDEX
// ============================================================================

/**
 * Build a bidirectional mapping index from mapping.json
 */
interface MappingEntry {
  domain?: string;
  requirement?: string;
  functions?: Array<{ file?: string; name?: string }>;
}

export function buildBidirectionalMapping(mappings: MappingEntry[]): {
  functionToRequirements: Map<string, Array<{ domain: string; requirement: string }>>;
  requirementToFunctions: Map<string, Array<{ file: string; name: string }>>;
} {
  const functionToRequirements = new Map<string, Array<{ domain: string; requirement: string }>>();
  const requirementToFunctions = new Map<string, Array<{ file: string; name: string }>>();

  for (const m of mappings) {
    if (!m.requirement || !m.domain || !m.functions) continue;

    // Use dot+camelCase format to match spec vector index IDs (e.g. 'auth.validateToken')
    const reqCamel = m.requirement.charAt(0).toLowerCase() + m.requirement.slice(1);
    const requirementKey = `${m.domain}.${reqCamel}`;

    // Build function → requirements mapping
    for (const fn of m.functions) {
      if (!fn.file || !fn.name) continue;
      const functionKey = `${fn.file}::${fn.name}`;
      const existing = functionToRequirements.get(functionKey) ?? [];
      existing.push({ domain: m.domain, requirement: m.requirement });
      functionToRequirements.set(functionKey, existing);
    }

    // Build requirement → functions mapping
    const functions = m.functions
      .filter((f): f is { file: string; name: string } => Boolean(f.file && f.name))
      .map((f) => ({ file: f.file, name: f.name }));
    if (functions.length > 0) {
      requirementToFunctions.set(requirementKey, functions);
    }
  }

  return { functionToRequirements, requirementToFunctions };
}

// ============================================================================
// CROSS-SCORING ALGORITHM
// ============================================================================

/**
 * Calculate cross-scoring boost based on bidirectional mappings
 */
export function calculateCrossScore(
  result: CodeSearchResult | SpecSearchResult,
  mappingIndex: {
    functionToRequirements: Map<string, Array<{ domain: string; requirement: string }>>;
    requirementToFunctions: Map<string, Array<{ file: string; name: string }>>;
  },
  config: CrossScoringConfig
): {
  mappingBoost: number;
  linkedArtifacts: Array<{ type: 'code' | 'spec'; id: string; score: number }>;
} {
  const linkedArtifacts: Array<{ type: 'code' | 'spec'; id: string; score: number }> = [];
  let mappingBoost = 0;

  if ('filePath' in result.record) {
    // This is a code result - look for linked requirements
    const rec = (result as CodeSearchResult).record;
    const functionKey = `${rec.filePath}::${rec.name}`;
    const requirements = mappingIndex.functionToRequirements.get(functionKey);

    if (requirements && requirements.length > 0) {
      mappingBoost += config.directMappingBoost;

      // Add linked requirements as artifacts
      for (const req of requirements) {
        const reqCamel = req.requirement.charAt(0).toLowerCase() + req.requirement.slice(1);
        const artifactId = `${req.domain}.${reqCamel}`;
        linkedArtifacts.push({
          type: 'spec',
          id: artifactId,
          score: result.score,
        });
      }

      // Additional boost for multiple links (capped)
      const additionalBoost = Math.min(
        (requirements.length - 1) * config.additionalLinkBoost,
        config.maxAdditionalBoost
      );
      mappingBoost += additionalBoost;
    }
  } else {
    // This is a spec result - look for linked functions
    const specRec = (result as SpecSearchResult).record;
    const requirementKey = specRec.id;
    const functions = mappingIndex.requirementToFunctions.get(requirementKey);

    if (functions && functions.length > 0) {
      mappingBoost += config.reverseMappingBoost;

      // Add linked functions as artifacts
      for (const fn of functions) {
        const artifactId = `${fn.file}::${fn.name}`;
        linkedArtifacts.push({
          type: 'code',
          id: artifactId,
          score: result.score,
        });
      }

      // Additional boost for multiple links (capped)
      const additionalBoost = Math.min(
        (functions.length - 1) * config.additionalLinkBoost,
        config.maxAdditionalBoost
      );
      mappingBoost += additionalBoost;
    }
  }

  return { mappingBoost, linkedArtifacts };
}

/**
 * Determine result type based on source and linked artifacts
 */
export function determineResultType(
  result: CodeSearchResult | SpecSearchResult,
  linkedArtifacts: Array<{ type: 'code' | 'spec'; id: string; score: number }>
): 'code' | 'spec' | 'both' {
  const isCode = 'filePath' in result.record;
  if (isCode && linkedArtifacts.some(art => art.type === 'spec')) return 'both';
  if (!isCode && linkedArtifacts.some(art => art.type === 'code')) return 'both';
  return isCode ? 'code' : 'spec';
}

/**
 * Extract source metadata from result
 */
export function extractSourceMetadata(
  result: CodeSearchResult | SpecSearchResult
): UnifiedSearchResult['source'] {
  if ('filePath' in result.record) {
    const rec = (result as CodeSearchResult).record;
    return {
      filePath: rec.filePath,
      functionName: rec.name,
      className: rec.className || undefined,
      language: rec.language,
    };
  } else {
    const rec = (result as SpecSearchResult).record;
    return {
      domain: rec.domain,
      section: rec.section,
      title: rec.title,
    };
  }
}

// ============================================================================
// UNIFIED SEARCH
// ============================================================================

export class UnifiedSearch {
  /**
   * Unified search that combines code and spec indexes with cross-scoring
   */
  static async unifiedSearch(
    outputDir: string,
    query: string,
    embedSvc: Embedder | null | undefined,
    opts: {
      limit?: number;
      language?: string;
      domain?: string;
      section?: string;
      config?: Partial<CrossScoringConfig>;
    } = {}
  ): Promise<UnifiedSearchResult[]> {
    const { limit = 10, language, domain, section, config = {} } = opts;
    const scoringConfig = { ...DEFAULT_CONFIG, ...config };

    // Import index classes dynamically
    const { VectorIndex } = await import('./vector-index.js');
    const { SpecVectorIndex } = await import('./spec-vector-index.js');

    // Load mapping index
    const mappingJsonPath = join(outputDir, 'mapping.json');
    let mappingIndex = {
      functionToRequirements: new Map<string, Array<{ domain: string; requirement: string }>>(),
      requirementToFunctions: new Map<string, Array<{ file: string; name: string }>>(),
    };

    try {
      const { readFile } = await import('node:fs/promises');
      const raw = JSON.parse(await readFile(mappingJsonPath, 'utf-8'));
      mappingIndex = buildBidirectionalMapping(raw.mappings ?? []);
    } catch {
      // Non-fatal - proceed without cross-scoring
    }

    // Execute parallel searches
    const svc = embedSvc ?? null;
    const [codeResults, specResults] = await Promise.all([
      VectorIndex.search(outputDir, query, svc, { limit: limit * 3, language }).catch(() => []),
      svc
        ? SpecVectorIndex.search(outputDir, query, svc, { limit: limit * 3, domain, section }).catch(() => [])
        : Promise.resolve([]),
    ]);

    // Combine and score results
    const allResults: Array<{
      result: CodeSearchResult | SpecSearchResult;
      unified: UnifiedSearchResult;
    }> = [];

    // Process code results
    for (const result of codeResults) {
      const { mappingBoost, linkedArtifacts } = calculateCrossScore(result, mappingIndex, scoringConfig);
      const finalScore = result.score + mappingBoost;
      const resultType = determineResultType(result, linkedArtifacts);

      allResults.push({
        result,
        unified: {
          id: result.record.id,
          type: resultType,
          score: finalScore,
          baseScore: result.score,
          mappingBoost,
          matchEvidence: requireMatchEvidence(result.matchEvidence),
          source: extractSourceMetadata(result),
          linkedArtifacts,
        },
      });
    }

    // Process spec results
    for (const result of specResults) {
      const { mappingBoost, linkedArtifacts } = calculateCrossScore(result, mappingIndex, scoringConfig);
      const finalScore = result.score + mappingBoost;
      const resultType = determineResultType(result, linkedArtifacts);

      allResults.push({
        result,
        unified: {
          id: result.record.id,
          type: resultType,
          score: finalScore,
          baseScore: result.score,
          mappingBoost,
          matchEvidence: requireMatchEvidence(result.matchEvidence),
          source: extractSourceMetadata(result),
          linkedArtifacts,
        },
      });
    }

    // Sort by final score
    allResults.sort((a, b) => b.unified.score - a.unified.score);

    // Return top results
    return allResults.slice(0, limit).map(r => r.unified);
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Check if unified search is available
 */
export async function unifiedSearchAvailable(outputDir: string): Promise<boolean> {
  const { VectorIndex } = await import('./vector-index.js');
  const { SpecVectorIndex } = await import('./spec-vector-index.js');
  return VectorIndex.exists(outputDir) && SpecVectorIndex.exists(outputDir);
}
