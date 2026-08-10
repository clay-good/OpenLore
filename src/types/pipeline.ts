/**
 * Shared types for the spec generation pipeline.
 */

import type { ProgressIndicator } from '../utils/progress.js';
import type { LLMService } from '../core/services/llm-service.js';
import type { SearchResult } from '../core/analyzer/vector-index.js';

/** Semantic search function injected into the pipeline to replace name-based heuristics. */
export type SemanticSearchFn = (query: string, limit: number) => Promise<SearchResult[]>;

// ============================================================================
// DOMAIN TYPES
// ============================================================================

export type ProjectCategory =
  | 'web-frontend'
  | 'web-backend'
  | 'api-service'
  | 'cli-tool'
  | 'library'
  | 'mobile-app'
  | 'desktop-app'
  | 'data-pipeline'
  | 'ml-service'
  | 'monorepo'
  | 'other';

export type ArchitecturePattern =
  | 'layered'
  | 'hexagonal'
  | 'microservices'
  | 'monolith'
  | 'serverless'
  | 'event-driven'
  | 'mvc'
  | 'other';

export interface ProjectSurveyResult {
  projectCategory: ProjectCategory;
  primaryLanguage: string;
  frameworks: string[];
  architecturePattern: ArchitecturePattern;
  domainSummary: string;
  suggestedDomains: string[];
  confidence: number;
  schemaFiles: string[];
  serviceFiles: string[];
  apiFiles: string[];
}

export interface EntityProperty {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
}

export interface EntityRelationship {
  targetEntity: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-many' | 'belongs-to';
  description?: string;
}

export interface Scenario {
  name: string;
  given: string;
  when: string;
  then: string;
  and?: string[];
}

export interface ExtractedEntity {
  name: string;
  description: string;
  properties: EntityProperty[];
  relationships: EntityRelationship[];
  validations: string[];
  scenarios: Scenario[];
  location: string;
}

export interface ServiceOperation {
  name: string;
  description: string;
  inputs?: string[];
  outputs?: string[];
  scenarios: Scenario[];
  functionName?: string;
}

export interface ServiceSubSpec {
  name: string;
  callee: string;
  purpose: string;
  operations: ServiceOperation[];
}

export interface ExtractedService {
  name: string;
  purpose: string;
  operations: ServiceOperation[];
  dependencies: string[];
  sideEffects: string[];
  domain: string;
  locationFile?: string;
  subSpecs?: ServiceSubSpec[];
}

export interface ExtractedEndpoint {
  method: string;
  path: string;
  purpose: string;
  authentication?: string;
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  scenarios: Scenario[];
  relatedEntity?: string;
}

export interface ArchitectureLayer {
  name: string;
  purpose: string;
  components: string[];
}

export interface ArchitectureSynthesis {
  systemPurpose: string;
  architectureStyle: string;
  layerMap: ArchitectureLayer[];
  dataFlow: string;
  integrations: string[];
  securityModel: string;
  keyDecisions: string[];
}

export interface EnrichedADR {
  id: string;
  title: string;
  status: 'accepted' | 'proposed' | 'deprecated' | 'superseded';
  context: string;
  decision: string;
  consequences: string[];
  alternatives: string[];
  relatedLayers: string[];
  relatedDomains: string[];
}

export interface PipelineResult {
  survey: ProjectSurveyResult;
  entities: ExtractedEntity[];
  services: ExtractedService[];
  endpoints: ExtractedEndpoint[];
  architecture: ArchitectureSynthesis;
  adrs?: EnrichedADR[];
  metadata: {
    totalTokens: number;
    estimatedCost: number;
    duration: number;
    completedStages: string[];
    skippedStages: string[];
  };
}

export interface StageResult<T> {
  stage: string;
  success: boolean;
  data?: T;
  error?: string;
  tokens: number;
  duration: number;
}

export interface PipelineOptions {
  outputDir: string;
  rootPath?: string;
  /** Optional domain scope. Stages 2–6 process only these domain evidence bundles. */
  domains?: string[];
  skipStages?: string[];
  resumeFrom?: string;
  /** Force regeneration from scratch, ignoring any cached stage results on disk */
  force?: boolean;
  maxRetries?: number;
  saveIntermediate?: boolean;
  generateADRs?: boolean;
  progress?: ProgressIndicator;
  /** Optional semantic search function. When provided, replaces name-based heuristics for
   *  schema/service/API file selection in stages 2–4. Falls back to heuristics if absent
   *  or if the search returns no results for a given domain. */
  semanticSearch?: SemanticSearchFn;
  /** Max characters per file chunk sent to the LLM. Default: 8000. Increase for large-context models. */
  chunkMaxChars?: number;
}

// ============================================================================
// PIPELINE CONTEXT (used by stage functions)
// ============================================================================

export interface PipelineContext {
  llm: LLMService;
  options: { saveIntermediate: boolean; chunkMaxChars: number };
  saveResult(name: string, data: unknown): Promise<void>;
  chunkContent(content: string, maxChars: number): string[];
  graphPromptFor(filePath: string, content?: string): string | null;
  /** Returns a text summary of function signatures in filePath, or null if unavailable. */
  signaturesFor(filePath: string): string | null;
  /** Returns a text summary of ORM schema tables defined in filePath, or null if none found. */
  schemasFor(filePath: string): string | null;
  /** Returns a text summary of HTTP routes defined in filePath, or null if none found. */
  routesFor(filePath: string): string | null;
  generateSubSpecs(filePath: string, parentName: string, parentPurpose: string): Promise<ServiceSubSpec[]>;
}
