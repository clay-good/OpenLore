/**
 * End-to-End Tests for Unified Search
 *
 * These tests verify the complete unified search workflow with real data
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { UnifiedSearch } from '../unified-search.js';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// vi.mock calls are hoisted to the top of the module by vitest regardless of where they
// appear; keeping them at top level makes that behavior explicit and avoids the hoisting
// deprecation warning that a future vitest will promote to an error (change: fix-test-suite-hygiene).
// Mock the vector indexes
vi.mock('../vector-index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    VectorIndex: {
      ...actual.VectorIndex,
      exists: vi.fn().mockReturnValue(true),
      search: vi.fn().mockImplementation((_dir: string, query: string, _embed: any, opts: any) => {
        // Simulate finding functions related to the query
        const results = [];

        if (query.includes('auth') || query.includes('validate') || query.includes('token')) {
          results.push({
            record: {
              id: 'src/auth/jwt.ts::validateToken',
              name: 'validateToken',
              filePath: 'src/auth/jwt.ts',
              className: '',
              language: 'TypeScript',
              signature: 'validateToken(token: string): boolean',
              docstring: 'Validates JWT token',
              fanIn: 5,
              fanOut: 2,
              isHub: false,
              isEntryPoint: false,
              text: '[TypeScript] src/auth/jwt.ts validateToken\nvalidateToken(token: string): boolean\nValidates JWT token'
            },
            score: 0.85
          });

          results.push({
            record: {
              id: 'src/auth/middleware.ts::authMiddleware',
              name: 'authMiddleware',
              filePath: 'src/auth/middleware.ts',
              className: '',
              language: 'TypeScript',
              signature: 'authMiddleware(req, res, next): void',
              docstring: 'Authentication middleware',
              fanIn: 3,
              fanOut: 1,
              isHub: false,
              isEntryPoint: true,
              text: '[TypeScript] src/auth/middleware.ts authMiddleware\nauthMiddleware(req, res, next): void\nAuthentication middleware'
            },
            score: 0.75
          });
        }

        if (query.includes('user') || query.includes('create')) {
          results.push({
            record: {
              id: 'src/users/service.ts::createUser',
              name: 'createUser',
              filePath: 'src/users/service.ts',
              className: 'UserService',
              language: 'TypeScript',
              signature: 'createUser(userData: UserInput): Promise<User>',
              docstring: 'Creates a new user',
              fanIn: 2,
              fanOut: 3,
              isHub: false,
              isEntryPoint: false,
              text: '[TypeScript] src/users/service.ts UserService.createUser\ncreateUser(userData: UserInput): Promise<User>\nCreates a new user'
            },
            score: 0.80
          });
        }

        return Promise.resolve(results.slice(0, opts.limit).map((result) => ({
          ...result,
          matchEvidence: { field: 'vector', terms: [], tier: 3 },
        })));
      })
    }
  };
});

vi.mock('../spec-vector-index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    SpecVectorIndex: {
      ...actual.SpecVectorIndex,
      exists: vi.fn().mockReturnValue(true),
      search: vi.fn().mockImplementation((_dir: string, query: string, _embed: any, opts: any) => {
        // Simulate finding spec requirements related to the query
        const results = [];

        if (query.includes('auth') || query.includes('validate') || query.includes('token')) {
          results.push({
            record: {
              id: 'auth.validateToken',
              domain: 'auth',
              section: 'requirements',
              title: 'Requirement: ValidateToken',
              text: '[spec:auth] Requirement: ValidateToken\nThe system SHALL validate JWT tokens using HMAC-SHA256 signature verification.\n\n#### Scenario: ValidToken\n- **GIVEN** A valid JWT token with correct signature\n- **WHEN** validateToken() is called\n- **THEN** Returns true\n\n#### Scenario: InvalidToken\n- **GIVEN** A JWT token with incorrect signature\n- **WHEN** validateToken() is called\n- **THEN** Returns false',
              linkedFiles: ['src/auth/jwt.ts', 'src/auth/middleware.ts']
            },
            score: 0.90
          });

          results.push({
            record: {
              id: 'auth.handleAuthentication',
              domain: 'auth',
              section: 'requirements',
              title: 'Requirement: HandleAuthentication',
              text: '[spec:auth] Requirement: HandleAuthentication\nThe system SHALL handle authentication requests with proper error handling and logging.\n\n#### Scenario: SuccessfulAuth\n- **GIVEN** Valid credentials\n- **WHEN** Authentication request is made\n- **THEN** Returns authenticated user with JWT token',
              linkedFiles: ['src/auth/middleware.ts']
            },
            score: 0.85
          });
        }

        if (query.includes('user') || query.includes('create')) {
          results.push({
            record: {
              id: 'users.createUser',
              domain: 'users',
              section: 'requirements',
              title: 'Requirement: CreateUser',
              text: '[spec:users] Requirement: CreateUser\nThe system SHALL create users with email validation and password hashing.\n\n#### Scenario: ValidUserCreation\n- **GIVEN** Valid user data with unique email\n- **WHEN** createUser() is called\n- **THEN** User is created with hashed password\n\n#### Scenario: DuplicateEmail\n- **GIVEN** User data with existing email\n- **WHEN** createUser() is called\n- **THEN** Throws DuplicateEmailError',
              linkedFiles: ['src/users/service.ts']
            },
            score: 0.88
          });
        }

        return Promise.resolve(results.slice(0, opts.limit).map((result) => ({
          ...result,
          matchEvidence: { field: 'vector', terms: [], tier: 3 },
        })));
      })
    }
  };
});

// Mock mapping.json (spread actual module to keep mkdir, writeFile, rm, readdir)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue(
      JSON.stringify({
        mappings: [
          {
            domain: 'auth',
            requirement: 'ValidateToken',
            functions: [
              { file: 'src/auth/jwt.ts', name: 'validateToken' },
              { file: 'src/auth/middleware.ts', name: 'authMiddleware' }
            ]
          },
          {
            domain: 'auth',
            requirement: 'HandleAuthentication',
            functions: [
              { file: 'src/auth/middleware.ts', name: 'authMiddleware' }
            ]
          },
          {
            domain: 'users',
            requirement: 'CreateUser',
            functions: [
              { file: 'src/users/service.ts', name: 'createUser' }
            ]
          }
        ]
      })
    ),
  };
});

describe('UnifiedSearch E2E', () => {
  let testDir: string;
  let outputDir: string;
  let mockEmbedSvc: any;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), 'openlore-e2e-' + Math.random().toString(36).substr(2, 9));
    outputDir = join(testDir, '.openlore', 'analysis');

    // Create directory structure
    await mkdir(outputDir, { recursive: true });

    // Mock embedding service
    mockEmbedSvc = {
      embed: vi.fn().mockImplementation((texts: string[]) => {
        return Promise.resolve(
          texts.map((text, i) => [
            0.1 + i * 0.01,
            0.2 + i * 0.02,
            0.3 + i * 0.03
          ])
        );
      })
    };

  });

  afterAll(async () => {
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('End-to-End Workflow', () => {
    it('should perform complete unified search with cross-scoring', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'validate user authentication',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Should return results from both indexes
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(10);

      // Should have both code and spec results
      const codeResults = results.filter(r => r.source.filePath);
      const specResults = results.filter(r => r.source.domain);
      const bothResults = results.filter(r => r.type === 'both');

      expect(codeResults.length).toBeGreaterThan(0);
      expect(specResults.length).toBeGreaterThan(0);
      expect(bothResults.length).toBeGreaterThan(0);
    });

    it('should boost results with bidirectional mappings', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'authentication',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Find the validateToken function result
      const validateTokenResult = results.find(
        r => r.source.filePath === 'src/auth/jwt.ts' && r.source.functionName === 'validateToken'
      );

      expect(validateTokenResult).toBeDefined();
      expect(validateTokenResult!.type).toBe('both');
      expect(validateTokenResult!.mappingBoost).toBe(0.3);
      expect(validateTokenResult!.score).toBeGreaterThan(validateTokenResult!.baseScore);
      expect(validateTokenResult!.linkedArtifacts.length).toBeGreaterThan(0);
      expect(validateTokenResult!.linkedArtifacts[0].type).toBe('spec');
      expect(validateTokenResult!.linkedArtifacts[0].id).toBe('auth.validateToken');
    });

    it('should sort results by final score (base + boost)', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'authentication',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Results should be sorted by score in descending order
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
      }

      // Results with mappings should appear before results without mappings
      const withMappings = results.filter(r => r.mappingBoost > 0);
      const withoutMappings = results.filter(r => r.mappingBoost === 0);

      if (withMappings.length > 0 && withoutMappings.length > 0) {
        const lastWithMapping = withMappings[withMappings.length - 1];
        const firstWithoutMapping = withoutMappings[0];
        expect(lastWithMapping.score).toBeGreaterThanOrEqual(firstWithoutMapping.score);
      }
    });

    it('should handle queries with no results gracefully', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'nonexistent feature xyz123',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Should return empty array
      expect(results).toBeInstanceOf(Array);
      expect(results.length).toBe(0);
    });

    it('should respect limit parameter', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'authentication',
        mockEmbedSvc,
        { limit: 3 }
      );

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should filter by language', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'authentication',
        mockEmbedSvc,
        { limit: 10, language: 'TypeScript' }
      );

      // All code results should be TypeScript
      const codeResults = results.filter(r => r.source.filePath);
      codeResults.forEach(r => {
        expect(r.source.language).toBe('TypeScript');
      });
    });

    it('should filter by domain', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'authentication',
        mockEmbedSvc,
        { limit: 10, domain: 'auth' }
      );

      // All spec results should be from auth domain
      const specResults = results.filter(r => r.source.domain);
      specResults.forEach(r => {
        expect(r.source.domain).toBe('auth');
      });
    });

    it('should filter by section', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'authentication',
        mockEmbedSvc,
        { limit: 10, section: 'requirements' }
      );

      // All spec results should be from requirements section
      const specResults = results.filter(r => r.source.section);
      specResults.forEach(r => {
        expect(r.source.section).toBe('requirements');
      });
    });
  });

  describe('Real-World Scenarios', () => {
    it('should find authentication-related code and specs', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'user authentication workflow',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Should find authentication-related functions
      const hasAuthFunctions = results.some(
        r => r.source.filePath && r.source.filePath.includes('auth/')
      );
      expect(hasAuthFunctions).toBe(true);

      // Should find authentication-related requirements
      const hasAuthRequirements = results.some(
        r => r.source.domain === 'auth'
      );
      expect(hasAuthRequirements).toBe(true);

      // Should have results tagged as "both"
      const hasBothResults = results.some(r => r.type === 'both');
      expect(hasBothResults).toBe(true);
    });

    it('should find user creation code and specs', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'create user with validation',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Should find user-related functions
      const hasUserFunctions = results.some(
        r => r.source.filePath && r.source.filePath.includes('users/')
      );
      expect(hasUserFunctions).toBe(true);

      // Should find user-related requirements
      const hasUserRequirements = results.some(
        r => r.source.domain === 'users'
      );
      expect(hasUserRequirements).toBe(true);
    });

    it('should handle complex queries with multiple keywords', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'validate jwt token authentication middleware',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Should still return relevant results
      expect(results.length).toBeGreaterThan(0);

      // Results should be relevant to the query
      const hasRelevantResults = results.some(
        r => r.source.filePath?.includes('auth/') || r.source.domain === 'auth'
      );
      expect(hasRelevantResults).toBe(true);
    });

    it('should provide complete context for implementation decisions', async () => {
      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'token validation',
        mockEmbedSvc,
        { limit: 5 }
      );

      // Should return both implementation and specification
      const hasCode = results.some(r => r.source.filePath);
      const hasSpec = results.some(r => r.source.domain);

      expect(hasCode).toBe(true);
      expect(hasSpec).toBe(true);

      // Should provide linked artifacts for context
      const hasLinkedArtifacts = results.some(
        r => r.linkedArtifacts && r.linkedArtifacts.length > 0
      );
      expect(hasLinkedArtifacts).toBe(true);
    });
  });

  describe('Performance and Robustness', () => {
    it('should complete search within reasonable time', async () => {
      const startTime = Date.now();

      await UnifiedSearch.unifiedSearch(
        outputDir,
        'authentication',
        mockEmbedSvc,
        { limit: 10 }
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete in less than 1 second (mocked, so should be very fast)
      expect(duration).toBeLessThan(1000);
    });

    it('should handle large result sets efficiently', async () => {
      // Mock to return many results
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      vi.spyOn(VectorIndex, 'search').mockResolvedValue(
        Array(50).fill(0).map((_, i) => ({
          record: {
            id: `src/file${i}.ts::function${i}`,
            name: `function${i}`,
            filePath: `src/file${i}.ts`,
            className: '',
            language: 'TypeScript',
            signature: `function${i}(): void`,
            docstring: `Function ${i}`,
            fanIn: 1,
            fanOut: 0,
            isHub: false,
            isEntryPoint: false,
            text: `[TypeScript] src/file${i}.ts function${i}\nfunction${i}(): void\nFunction ${i}`
          },
          score: 0.5 + i * 0.01,
          matchEvidence: { field: 'vector' as const, terms: [], tier: 3 as const },
        }))
      );

      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(
        Array(50).fill(0).map((_, i) => ({
          record: {
            id: `domain${i}.requirement${i}`,
            domain: `domain${i}`,
            section: 'requirements',
            title: `Requirement: Requirement${i}`,
            text: `[spec:domain${i}] Requirement: Requirement${i}\nRequirement ${i} text...`,
            linkedFiles: []
          },
          score: 0.4 + i * 0.01,
          matchEvidence: { field: 'vector' as const, terms: [], tier: 3 as const },
        }))
      );

      const results = await UnifiedSearch.unifiedSearch(
        outputDir,
        'test',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Should respect limit even with many results
      expect(results.length).toBeLessThanOrEqual(10);
    });

    it('should maintain consistency across multiple searches', async () => {
      const query = 'authentication';
      const limit = 5;

      const results1 = await UnifiedSearch.unifiedSearch(
        outputDir,
        query,
        mockEmbedSvc,
        { limit }
      );

      const results2 = await UnifiedSearch.unifiedSearch(
        outputDir,
        query,
        mockEmbedSvc,
        { limit }
      );

      // Results should be consistent
      expect(results1.length).toBe(results2.length);

      // IDs should be in the same order
      const ids1 = results1.map(r => r.id);
      const ids2 = results2.map(r => r.id);
      expect(ids1).toEqual(ids2);
    });
  });

  describe('Integration with Existing System', () => {
    it('should work with existing VectorIndex', async () => {
      const { VectorIndex } = await import('../vector-index.js');

      // Verify VectorIndex is being used
      await UnifiedSearch.unifiedSearch(
        outputDir,
        'test',
        mockEmbedSvc,
        { limit: 5 }
      );

      expect(VectorIndex.search).toHaveBeenCalled();
    });

    it('should work with existing SpecVectorIndex', async () => {
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      // Verify SpecVectorIndex is being used
      await UnifiedSearch.unifiedSearch(
        outputDir,
        'test',
        mockEmbedSvc,
        { limit: 5 }
      );

      expect(SpecVectorIndex.search).toHaveBeenCalled();
    });

    it('should use existing mapping.json format', async () => {
      const { readFile } = await import('node:fs/promises');

      // Verify mapping.json is being read
      await UnifiedSearch.unifiedSearch(
        outputDir,
        'test',
        mockEmbedSvc,
        { limit: 5 }
      );

      expect(readFile).toHaveBeenCalledWith(
        expect.stringContaining('mapping.json'),
        'utf-8'
      );
    });

    it('should be compatible with existing embedding service', async () => {
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      // Verify embedding service is passed to the search functions
      await UnifiedSearch.unifiedSearch(
        outputDir,
        'test',
        mockEmbedSvc,
        { limit: 5 }
      );

      // SpecVectorIndex.search should be called with the embedding service
      expect(SpecVectorIndex.search).toHaveBeenCalledWith(
        expect.any(String),
        'test',
        mockEmbedSvc,
        expect.any(Object)
      );
    });
  });
});
