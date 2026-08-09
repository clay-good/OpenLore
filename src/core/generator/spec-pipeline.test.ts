/**
 * Spec Generation Pipeline Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SpecGenerationPipeline,
  runSpecGenerationPipeline,
} from './spec-pipeline.js';
import { createMockLLMService } from '../services/llm-service.js';
import type { RepoStructure, LLMContext } from '../analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `spec-pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createMockRepoStructure(): RepoStructure {
  return {
    projectName: 'test-project',
    projectType: 'node-typescript',
    frameworks: ['Express', 'TypeORM'],
    architecture: {
      pattern: 'layered',
      layers: [
        { name: 'API', purpose: 'Request handling', files: ['routes/user.ts'], representativeFile: 'routes/user.ts' },
        { name: 'Service', purpose: 'Business logic', files: ['services/user-service.ts'], representativeFile: 'services/user-service.ts' },
        { name: 'Data', purpose: 'Data access', files: ['models/user.ts'], representativeFile: 'models/user.ts' },
      ],
    },
    domains: [
      { name: 'user', suggestedSpecPath: 'openspec/specs/user/spec.md', files: ['user.ts'], entities: ['User'], keyFile: 'user.ts' },
      { name: 'auth', suggestedSpecPath: 'openspec/specs/auth/spec.md', files: ['auth.ts'], entities: ['Session'], keyFile: 'auth.ts' },
    ],
    entryPoints: [{ file: 'index.ts', type: 'application-entry', initializes: ['express'] }],
    dataFlow: { sources: ['routes/'], sinks: ['repositories/'], transformers: ['services/'] },
    keyFiles: {
      schemas: ['models/user.ts'],
      config: ['config.ts'],
      auth: ['auth.ts'],
      database: ['db.ts'],
      routes: ['routes/user.ts'],
      services: ['services/user-service.ts'],
    },
    uiComponents: [],
    schemas: [],
    routeInventory: { total: 0, byMethod: {}, byFramework: {}, routes: [] },
    middleware: [],
        envVars: [],
    statistics: {
      totalFiles: 50,
      analyzedFiles: 40,
      skippedFiles: 10,
      avgFileScore: 55,
      nodeCount: 40,
      edgeCount: 60,
      cycleCount: 0,
      clusterCount: 3,
    },
  };
}

function createMockLLMContext(): LLMContext {
  return {
    phase1_survey: {
      purpose: 'Survey',
      files: [{ path: 'repo-structure.json', tokens: 500 }],
      estimatedTokens: 500,
    },
    phase2_deep: {
      purpose: 'Deep analysis',
      files: [
        { path: 'models/user.ts', content: 'export interface User { id: string; name: string; email: string; }', tokens: 50 },
        { path: 'models/post.ts', content: 'export interface Post { id: string; title: string; authorId: string; }', tokens: 50 },
        { path: 'services/user-service.ts', content: 'export class UserService { getUser(id: string) {} createUser(data: User) {} }', tokens: 60 },
        { path: 'routes/user.ts', content: 'router.get("/users/:id", getUser); router.post("/users", createUser);', tokens: 40 },
        { path: 'routes/api.ts', content: 'router.get("/api/health", healthCheck);', tokens: 30 },
      ],
      totalTokens: 230,
    },
    phase3_validation: {
      purpose: 'Validation',
      files: [{ path: 'test.ts', content: 'describe("test", () => {});', tokens: 20 }],
      totalTokens: 20,
    },
  };
}

function createMockDepGraph(): DependencyGraphResult {
  return {
    nodes: [],
    edges: [],
    clusters: [],
    structuralClusters: [],
    rankings: {
      byImportance: [],
      byConnectivity: [],
      clusterCenters: [],
      leafNodes: [],
      bridgeNodes: [],
      orphanNodes: [],
    },
    cycles: [],
    statistics: {
      nodeCount: 40,
      edgeCount: 60,
      importEdgeCount: 60,
      httpEdgeCount: 0,
      avgDegree: 3,
      density: 0.1,
      clusterCount: 3,
      structuralClusterCount: 0,
      cycleCount: 0,
    },
  };
}

// Mock LLM responses
const MOCK_RESPONSES = {
  survey: JSON.stringify({
    projectCategory: 'web-backend',
    primaryLanguage: 'TypeScript',
    frameworks: ['Express', 'TypeORM'],
    architecturePattern: 'layered',
    domainSummary: 'A user management API service',
    suggestedDomains: ['user', 'auth', 'api'],
    confidence: 0.85,
    schemaFiles: [],
    serviceFiles: [],
    apiFiles: [],
  }),
  entities: JSON.stringify([
    {
      name: 'User',
      description: 'Represents a user in the system',
      properties: [
        { name: 'id', type: 'string', required: true },
        { name: 'name', type: 'string', required: true },
        { name: 'email', type: 'string', required: true },
      ],
      relationships: [],
      validations: ['Email must be unique', 'Name is required'],
      scenarios: [
        { name: 'Create User', given: 'valid user data', when: 'createUser is called', then: 'user is created' },
      ],
      location: 'models/user.ts',
    },
  ]),
  services: JSON.stringify([
    {
      name: 'UserService',
      purpose: 'Handles user-related business logic',
      operations: [
        {
          name: 'getUser',
          description: 'Retrieves a user by ID',
          inputs: ['id: string'],
          outputs: ['User | null'],
          scenarios: [
            { name: 'Get existing user', given: 'user exists', when: 'getUser is called', then: 'user is returned' },
          ],
        },
      ],
      dependencies: ['UserRepository'],
      sideEffects: [],
      domain: 'user',
    },
  ]),
  api: JSON.stringify([
    {
      method: 'GET',
      path: '/users/:id',
      purpose: 'Get user by ID',
      authentication: 'Bearer token',
      requestSchema: {},
      responseSchema: { id: 'string', name: 'string' },
      scenarios: [
        { name: 'Get user success', given: 'valid token', when: 'GET /users/123', then: 'return user' },
      ],
      relatedEntity: 'User',
    },
  ]),
  architecture: JSON.stringify({
    systemPurpose: 'A user management API that handles user CRUD operations and authentication.',
    architectureStyle: 'Layered architecture with clear separation of concerns.',
    layerMap: [
      { name: 'API', purpose: 'HTTP request handling', components: ['routes/'] },
      { name: 'Service', purpose: 'Business logic', components: ['services/'] },
      { name: 'Data', purpose: 'Database access', components: ['models/'] },
    ],
    dataFlow: 'Request -> Routes -> Services -> Repositories -> Database',
    integrations: [],
    securityModel: 'JWT-based authentication',
    keyDecisions: ['Use TypeORM for database access', 'Express for HTTP routing'],
  }),
  adrs: JSON.stringify([
    {
      id: 'ADR-001',
      title: 'Use TypeORM for database access',
      status: 'accepted',
      context: 'The project needs a typed ORM for database interactions.',
      decision: 'Use TypeORM as the primary ORM.',
      consequences: ['Type-safe queries', 'Migration complexity'],
      alternatives: ['Prisma', 'Raw SQL'],
      relatedLayers: ['Data', 'Service'],
      relatedDomains: ['user'],
    },
    {
      id: 'ADR-002',
      title: 'Express for HTTP routing',
      status: 'accepted',
      context: 'Need a lightweight HTTP framework.',
      decision: 'Use Express for all HTTP routing.',
      consequences: ['Large ecosystem', 'Middleware support'],
      alternatives: ['Fastify', 'Koa'],
      relatedLayers: ['API'],
      relatedDomains: ['api'],
    },
  ]),
};

// ============================================================================
// TESTS
// ============================================================================

describe('SpecGenerationPipeline', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Full Pipeline', () => {
    it('should run all stages successfully', async () => {
      const { service, provider } = createMockLLMService();

      // Set up mock responses
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('core data models', MOCK_RESPONSES.entities);
      provider.setResponse('logic and processing layer', MOCK_RESPONSES.services);
      provider.setResponse('public API surface', MOCK_RESPONSES.api);
      provider.setResponse('Synthesize', MOCK_RESPONSES.architecture);
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        saveIntermediate: true,
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext(),
        createMockDepGraph()
      );

      expect(result.survey).toBeDefined();
      expect(result.survey.projectCategory).toBe('web-backend');
      expect(result.metadata.completedStages.length).toBeGreaterThan(0);
    });

    it('should save intermediate results', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        saveIntermediate: true,
      });

      await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      const files = await readdir(tempDir);
      expect(files.some(f => f.includes('stage1'))).toBe(true);
      expect(files.some(f => f.includes('pipeline-result'))).toBe(true);
    });

    it('should track token usage', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.metadata.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('Stage 1: Project Survey', () => {
    it('should extract project category', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api', 'architecture'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.survey.projectCategory).toBe('web-backend');
      expect(result.survey.primaryLanguage).toBe('TypeScript');
      expect(result.survey.frameworks).toContain('Express');
      expect(result.survey.confidence).toBeGreaterThan(0);
    });

    it('should include suggested domains', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api', 'architecture'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.survey.suggestedDomains).toContain('user');
      expect(result.survey.suggestedDomains).toContain('auth');
    });
  });

  describe('Stage 2: Entity Extraction', () => {
    it('should extract entities from schema files', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('core data models', MOCK_RESPONSES.entities);
      provider.setDefaultResponse(MOCK_RESPONSES.architecture);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['services', 'api', 'architecture'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities[0].name).toBe('User');
      expect(result.entities[0].properties.length).toBeGreaterThan(0);
    });

    it('should include entity scenarios', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('core data models', MOCK_RESPONSES.entities);
      provider.setDefaultResponse(MOCK_RESPONSES.architecture);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['services', 'api', 'architecture'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.entities[0].scenarios.length).toBeGreaterThan(0);
      expect(result.entities[0].scenarios[0].given).toBeDefined();
      expect(result.entities[0].scenarios[0].when).toBeDefined();
      expect(result.entities[0].scenarios[0].then).toBeDefined();
    });
  });

  describe('Stage 3: Service Analysis', () => {
    it('should extract services', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('core data models', MOCK_RESPONSES.entities);
      provider.setResponse('logic and processing layer', MOCK_RESPONSES.services);
      provider.setDefaultResponse(MOCK_RESPONSES.architecture);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['api', 'architecture'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.services.length).toBeGreaterThan(0);
      expect(result.services[0].name).toBe('UserService');
      expect(result.services[0].operations.length).toBeGreaterThan(0);
    });

    it('should include service dependencies', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('core data models', MOCK_RESPONSES.entities);
      provider.setResponse('logic and processing layer', MOCK_RESPONSES.services);
      provider.setDefaultResponse(MOCK_RESPONSES.architecture);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['api', 'architecture'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.services[0].dependencies).toContain('UserRepository');
    });
  });

  describe('Stage 4: API Extraction', () => {
    it('should extract API endpoints', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('core data models', MOCK_RESPONSES.entities);
      provider.setResponse('logic and processing layer', MOCK_RESPONSES.services);
      provider.setResponse('public API surface', MOCK_RESPONSES.api);
      provider.setDefaultResponse(MOCK_RESPONSES.architecture);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['architecture'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.endpoints.length).toBeGreaterThan(0);
      expect(result.endpoints[0].method).toBe('GET');
      expect(result.endpoints[0].path).toBe('/users/:id');
    });

    it('should include endpoint scenarios', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('public API surface', MOCK_RESPONSES.api);
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'architecture'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.endpoints[0].scenarios.length).toBeGreaterThan(0);
    });
  });

  describe('Stage 5: Architecture Synthesis', () => {
    it('should synthesize architecture', async () => {
      const { service, provider } = createMockLLMService();
      // Survey runs first, architecture runs second
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('Synthesize', MOCK_RESPONSES.architecture);
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext(),
        createMockDepGraph()
      );

      expect(result.architecture.systemPurpose).toBeDefined();
      expect(result.architecture.architectureStyle).toBeDefined();
      expect(result.architecture.layerMap.length).toBeGreaterThan(0);
    });

    it('should include data flow', async () => {
      const { service, provider } = createMockLLMService();
      // Survey runs first, architecture runs second
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('Synthesize', MOCK_RESPONSES.architecture);
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.architecture.dataFlow).toContain('->');
    });
  });

  describe('Stage 6: ADR Enrichment', () => {
    it('should enrich ADRs when generateADRs is true', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('Synthesize', MOCK_RESPONSES.architecture);
      provider.setResponse('Decision Records', MOCK_RESPONSES.adrs);
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api'],
        generateADRs: true,
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext(),
        createMockDepGraph()
      );

      expect(result.adrs).toBeDefined();
      expect(result.adrs!.length).toBe(2);
      expect(result.adrs![0].id).toBe('ADR-001');
      expect(result.adrs![0].title).toBe('Use TypeORM for database access');
      expect(result.adrs![1].id).toBe('ADR-002');
      expect(result.metadata.completedStages).toContain('adr');
    });

    it('should skip ADRs when generateADRs is false', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('Synthesize', MOCK_RESPONSES.architecture);
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api'],
        generateADRs: false,
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext(),
        createMockDepGraph()
      );

      expect(result.adrs).toBeUndefined();
      expect(result.metadata.completedStages).not.toContain('adr');
    });

    it('should skip ADRs when no keyDecisions exist', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      // Architecture with empty keyDecisions
      const archNoDecisions = JSON.stringify({
        systemPurpose: 'A simple API',
        architectureStyle: 'Layered',
        layerMap: [{ name: 'API', purpose: 'HTTP', components: ['routes/'] }],
        dataFlow: 'Request -> Response',
        integrations: [],
        securityModel: 'None',
        keyDecisions: [],
      });
      provider.setResponse('Synthesize', archNoDecisions);
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api'],
        generateADRs: true,
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext(),
        createMockDepGraph()
      );

      expect(result.adrs).toBeUndefined();
      expect(result.metadata.skippedStages).toContain('adr');
    });

    it('should include ADR enrichment results with proper structure', async () => {
      const { service, provider } = createMockLLMService();
      provider.setResponse('categorize', MOCK_RESPONSES.survey);
      provider.setResponse('Synthesize', MOCK_RESPONSES.architecture);
      provider.setResponse('Decision Records', MOCK_RESPONSES.adrs);
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api'],
        generateADRs: true,
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext(),
        createMockDepGraph()
      );

      const adr = result.adrs![0];
      expect(adr.status).toBe('accepted');
      expect(adr.context).toBeDefined();
      expect(adr.decision).toBeDefined();
      expect(adr.consequences.length).toBeGreaterThan(0);
      expect(adr.alternatives.length).toBeGreaterThan(0);
      expect(adr.relatedLayers.length).toBeGreaterThan(0);
      expect(adr.relatedDomains.length).toBeGreaterThan(0);
    });
  });

  describe('Stage Skipping', () => {
    it('should skip specified stages', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.metadata.skippedStages).toContain('entities');
      expect(result.metadata.skippedStages).toContain('services');
      expect(result.metadata.skippedStages).toContain('api');
      expect(result.entities).toHaveLength(0);
      expect(result.services).toHaveLength(0);
      expect(result.endpoints).toHaveLength(0);
    });

    it('should use default values when stages are skipped', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const repoStructure = createMockRepoStructure();
      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['survey', 'entities', 'services', 'api', 'architecture'],
      });

      const result = await pipeline.run(repoStructure, createMockLLMContext());

      // Should use default survey from repo structure
      expect(result.survey.frameworks).toEqual(repoStructure.frameworks);
      expect(result.metadata.skippedStages).toContain('survey');
    });
  });

  describe('Resume from Stage', () => {
    it('should resume from specified stage', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.architecture);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        resumeFrom: 'architecture',
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      // Earlier stages should be skipped
      expect(result.metadata.skippedStages).toContain('survey');
      expect(result.metadata.skippedStages).toContain('entities');
      expect(result.metadata.completedStages).toContain('architecture');
    });
  });

  describe('Error Handling', () => {
    it('should handle LLM failures gracefully', async () => {
      const { service, provider } = createMockLLMService();

      // Make provider return invalid JSON to simulate failure
      provider.setDefaultResponse('not valid json');

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api', 'architecture'],
      });

      // Should not throw, but survey will fail and use defaults
      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      // Pipeline should still complete with some results
      expect(result).toBeDefined();
    });

    it('should skip stages when no relevant files found', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      // Create context with no schema files
      const emptyContext: LLMContext = {
        phase1_survey: { purpose: 'Survey', files: [], estimatedTokens: 0 },
        phase2_deep: { purpose: 'Deep', files: [], totalTokens: 0 },
        phase3_validation: { purpose: 'Validation', files: [], totalTokens: 0 },
      };

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        emptyContext
      );

      expect(result.metadata.skippedStages).toContain('entities');
      expect(result.metadata.skippedStages).toContain('services');
      expect(result.metadata.skippedStages).toContain('api');
    });
  });

  describe('Convenience Function', () => {
    it('should run pipeline via convenience function', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const result = await runSpecGenerationPipeline(
        service,
        createMockRepoStructure(),
        createMockLLMContext(),
        { outputDir: tempDir, skipStages: ['entities', 'services', 'api', 'architecture'] }
      );

      expect(result.survey).toBeDefined();
      expect(result.metadata).toBeDefined();
    });
  });

  describe('graphPromptFor', () => {
    it('returns null for small files with no call graph', () => {
      const { service: llm } = createMockLLMService();
      const pipeline = new SpecGenerationPipeline(llm, { outputDir: tempDir });
      const smallContent = 'const x = 1;\n'.repeat(10); // well under STAGE_CHUNK_MAX_CHARS
      expect(pipeline.graphPromptFor('src/small.ts', smallContent)).toBeNull();
    });

    it('returns null when no content provided and no call graph', () => {
      const { service: llm } = createMockLLMService();
      const pipeline = new SpecGenerationPipeline(llm, { outputDir: tempDir });
      expect(pipeline.graphPromptFor('src/file.ts')).toBeNull();
    });

    it('returns skeleton string for large heavily-commented files with no call graph', () => {
      const { service: llm } = createMockLLMService();
      const pipeline = new SpecGenerationPipeline(llm, { outputDir: tempDir });
      // Build > 8000 chars with >20% comment content (so skeleton achieves ≥20% reduction)
      // Each funcBlock: short body + long comment block
      const commentLine = '// A long descriptive comment line that will be stripped by skeleton\n';
      const commentBlock = commentLine.repeat(15); // ~1050 chars of comments per function
      // Repeat to exceed STAGE_CHUNK_MAX_CHARS (8000 chars)
      const largeContent = Array.from({ length: 10 }, (_, i) =>
        `function fn${i}(x: number): number {\n${commentBlock}  return x + ${i};\n}\n`
      ).join('\n'); // ~11,500 chars total
      const result = pipeline.graphPromptFor('src/large.ts', largeContent);
      // Should use skeleton path (skeleton << original due to stripped comments)
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
      if (result) {
        expect(result).toContain('skeleton');
      }
    });

    it('returns null for large files where skeleton does not compress enough', () => {
      const { service: llm } = createMockLLMService();
      const pipeline = new SpecGenerationPipeline(llm, { outputDir: tempDir });
      // Build > 8000 chars with NO comments (skeleton identical to source, no 20% reduction)
      const funcBlock = 'function doThing(a: number, b: string): void { const x = a + b.length; if (x > 0) { return; } }\n';
      const largeContent = funcBlock.repeat(100); // ~9400 chars, no comments
      const result = pipeline.graphPromptFor('src/dense.ts', largeContent);
      // skeleton ≈ original (no strippable content) → isSkeletonWorthIncluding returns false → null
      expect(result).toBeNull();
    });
  });

  describe('loadStageResult', () => {
    it('returns null when stage result file does not exist', async () => {
      const { service: llm } = createMockLLMService();
      const pipeline = new SpecGenerationPipeline(llm, { outputDir: tempDir });
      const result = await pipeline.loadStageResult('nonexistent-stage');
      expect(result).toBeNull();
    });

    it('loads a stage result using the correct filename mapping', async () => {
      const { service: llm } = createMockLLMService();
      const pipeline = new SpecGenerationPipeline(llm, { outputDir: tempDir });

      // Write a fake saved result using the name that saveResult would produce
      const stageData = { success: true, data: { foo: 'bar' }, tokens: 42, error: undefined };
      await pipeline.saveResult('stage1-survey', stageData);

      const result = await pipeline.loadStageResult('survey');
      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
      expect((result?.data as Record<string, string>).foo).toBe('bar');
    });
  });

  describe('Auto-resume', () => {
    it('skips a stage and loads data from disk when cached result exists', async () => {
      const { service, provider } = createMockLLMService();
      // LLM should never be called for survey since it is cached
      provider.setDefaultResponse(MOCK_RESPONSES.architecture);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        saveIntermediate: true,
        skipStages: ['entities', 'services', 'api'],
      });

      // Pre-populate cache for the survey stage
      const cachedSurvey = {
        success: true,
        tokens: 0,
        data: JSON.parse(MOCK_RESPONSES.survey),
      };
      await pipeline.saveResult('stage1-survey', cachedSurvey);

      const result = await pipeline.run(createMockRepoStructure(), createMockLLMContext());

      // Survey should appear in skippedStages (loaded from disk)
      expect(result.metadata.skippedStages).toContain('survey');
      // Architecture should have run
      expect(result.metadata.completedStages).toContain('architecture');
      // Survey data loaded from disk — domainSummary matches cached value
      expect(result.survey.domainSummary).toBe('A user management API service');
    });

    it('ignores cached stage results and re-runs all stages when force=true', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        saveIntermediate: true,
        skipStages: ['entities', 'services', 'api', 'architecture'],
        force: true,
      });

      // Pre-populate cache
      const cachedSurvey = {
        success: true,
        tokens: 0,
        data: { ...JSON.parse(MOCK_RESPONSES.survey), domainSummary: 'CACHED VALUE' },
      };
      await pipeline.saveResult('stage1-survey', cachedSurvey);

      const result = await pipeline.run(createMockRepoStructure(), createMockLLMContext());

      // With force=true, cache is ignored — survey should be in completedStages
      expect(result.metadata.completedStages).toContain('survey');
      // Result should NOT contain the cached value
      expect(result.survey.domainSummary).not.toBe('CACHED VALUE');
    });
  });

  describe('Metadata', () => {
    it('should track pipeline duration', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['entities', 'services', 'api', 'architecture'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      // Duration is a non-negative number (may be 0 in fast test runs)
      expect(result.metadata.duration).toBeGreaterThanOrEqual(0);
      expect(typeof result.metadata.duration).toBe('number');
    });

    it('should list completed and skipped stages', async () => {
      const { service, provider } = createMockLLMService();
      provider.setDefaultResponse(MOCK_RESPONSES.survey);

      const pipeline = new SpecGenerationPipeline(service, {
        outputDir: tempDir,
        skipStages: ['api'],
      });

      const result = await pipeline.run(
        createMockRepoStructure(),
        createMockLLMContext()
      );

      expect(result.metadata.completedStages).toContain('survey');
      expect(result.metadata.skippedStages).toContain('api');
    });
  });
});
