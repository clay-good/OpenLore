/**
 * Tests for Unified Search with Cross-Scoring
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnifiedSearch, unifiedSearchAvailable } from '../unified-search.js';
import type { EmbeddingService } from '../embedding-service.js';
import type { SearchResult as CodeSearchResult } from '../vector-index.js';
import type { SpecSearchResult } from '../spec-vector-index.js';

const TEST_MATCH_EVIDENCE = { field: 'vector' as const, terms: [], tier: 3 as const };

// Simple mock data for testing
const mockMapping = {
  mappings: [
    {
      domain: 'auth',
      requirement: 'ValidateToken',
      functions: [
        { file: 'src/auth/jwt.ts', name: 'validateToken' },
        { file: 'src/auth/middleware.ts', name: 'authMiddleware' },
      ],
    },
    {
      domain: 'users',
      requirement: 'CreateUser',
      functions: [{ file: 'src/users/service.ts', name: 'createUser' }],
    },
  ],
};

const mockFs = {
  readFile: vi.fn().mockResolvedValue(JSON.stringify(mockMapping)),
};

vi.mock('node:fs/promises', () => ({
  readFile: (...args: any[]) => mockFs.readFile(...args),
}));

describe('UnifiedSearch', () => {
  const mockOutputDir = '/tmp/test-output';
  const mockEmbedSvc = {
    embed: vi.fn().mockResolvedValue([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]),
  } as unknown as EmbeddingService;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('unifiedSearchAvailable', () => {
    it('should return true when both indexes exist', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);

      const result = await unifiedSearchAvailable(mockOutputDir);
      expect(result).toBe(true);
    });

    it('should return false when code index does not exist', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(false);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);

      const result = await unifiedSearchAvailable(mockOutputDir);
      expect(result).toBe(false);
    });

    it('should return false when spec index does not exist', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(false);

      const result = await unifiedSearchAvailable(mockOutputDir);
      expect(result).toBe(false);
    });
  });

  describe('unifiedSearch', () => {
    it('should execute parallel searches on both indexes', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = [
        {
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
            text: '[TypeScript] src/auth/jwt.ts validateToken\nvalidateToken(token: string): boolean\nValidates JWT token',
          },
          score: 0.8,
        },
      ];

      const mockSpecResults: SpecSearchResult[] = [
        {
          record: {
            id: 'auth.validateToken',
            domain: 'auth',
            section: 'requirements',
            title: 'Requirement: ValidateToken',
            text: '[spec:auth] Requirement: ValidateToken\nThe system SHALL validate JWT tokens...',
            linkedFiles: ['src/auth/jwt.ts', 'src/auth/middleware.ts'],
          },
          score: 0.7,
        },
      ];

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(
        mockOutputDir,
        'validate token',
        mockEmbedSvc,
        { limit: 10 }
      );

      expect(VectorIndex.search).toHaveBeenCalledWith(
        mockOutputDir,
        'validate token',
        mockEmbedSvc,
        { limit: 30, language: undefined }
      );

      expect(SpecVectorIndex.search).toHaveBeenCalledWith(
        mockOutputDir,
        'validate token',
        mockEmbedSvc,
        { limit: 30, domain: undefined, section: undefined }
      );

      expect(results).toHaveLength(2);
    });

    it('should apply cross-scoring boosts for bidirectional mappings', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = [
        {
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
            text: '[TypeScript] src/auth/jwt.ts validateToken\nvalidateToken(token: string): boolean\nValidates JWT token',
          },
          score: 0.8,
        },
      ];

      const mockSpecResults: SpecSearchResult[] = [
        {
          record: {
            id: 'auth.validateToken',
            domain: 'auth',
            section: 'requirements',
            title: 'Requirement: ValidateToken',
            text: '[spec:auth] Requirement: ValidateToken\nThe system SHALL validate JWT tokens...',
            linkedFiles: ['src/auth/jwt.ts', 'src/auth/middleware.ts'],
          },
          score: 0.7,
        },
      ];

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(
        mockOutputDir,
        'validate token',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Code result should get +0.3 boost (direct mapping)
      const codeResult = results.find((r) => r.type === 'both' && r.source.filePath);
      expect(codeResult).toBeDefined();
      expect(codeResult!.score).toBe(1.1); // 0.8 + 0.3
      expect(codeResult!.mappingBoost).toBe(0.3);
      expect(codeResult!.linkedArtifacts).toHaveLength(1);
      expect(codeResult!.linkedArtifacts[0].type).toBe('spec');
      expect(codeResult!.linkedArtifacts[0].id).toBe('auth.validateToken'); // dot.camelCase matches spec IDs

      // Spec result should get +0.3 base boost + 0.1 additional (2 linked functions)
      const specResult = results.find((r) => r.type === 'both' && r.source.domain);
      expect(specResult).toBeDefined();
      expect(specResult!.score).toBe(1.1); // 0.7 + 0.3 + 0.1 (2 functions in mapping)
      expect(specResult!.mappingBoost).toBe(0.4);
      expect(specResult!.linkedArtifacts).toHaveLength(2);
      expect(specResult!.linkedArtifacts[0].type).toBe('code');
      expect(specResult!.linkedArtifacts[0].id).toBe('src/auth/jwt.ts::validateToken');
    });

    it('should handle results without mappings gracefully', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = [
        {
          record: {
            id: 'src/utils/logger.ts::log',
            name: 'log',
            filePath: 'src/utils/logger.ts',
            className: '',
            language: 'TypeScript',
            signature: 'log(message: string): void',
            docstring: 'Logs a message',
            fanIn: 2,
            fanOut: 0,
            isHub: false,
            isEntryPoint: false,
            text: '[TypeScript] src/utils/logger.ts log\nlog(message: string): void\nLogs a message',
          },
          score: 0.6,
        },
      ];

      const mockSpecResults: SpecSearchResult[] = [
        {
          record: {
            id: 'utils.logging',
            domain: 'utils',
            section: 'requirements',
            title: 'Requirement: Logging',
            text: '[spec:utils] Requirement: Logging\nThe system SHALL log messages...',
            linkedFiles: [],
          },
          score: 0.5,
        },
      ];

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(mockOutputDir, 'logging', mockEmbedSvc, {
        limit: 10,
      });

      // Results without mappings should not get boosts
      const codeResult = results.find((r) => r.type === 'code');
      expect(codeResult).toBeDefined();
      expect(codeResult!.score).toBe(0.6); // No boost
      expect(codeResult!.mappingBoost).toBe(0);
      expect(codeResult!.linkedArtifacts).toHaveLength(0);

      const specResult = results.find((r) => r.type === 'spec');
      expect(specResult).toBeDefined();
      expect(specResult!.score).toBe(0.5); // No boost
      expect(specResult!.mappingBoost).toBe(0);
      expect(specResult!.linkedArtifacts).toHaveLength(0);
    });

    it('should sort results by final score', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = [
        {
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
            text: '[TypeScript] src/auth/jwt.ts validateToken\nvalidateToken(token: string): boolean\nValidates JWT token',
          },
          score: 0.8,
        },
        {
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
            text: '[TypeScript] src/auth/middleware.ts authMiddleware\nauthMiddleware(req, res, next): void\nAuthentication middleware',
          },
          score: 0.7,
        },
      ];

      const mockSpecResults: SpecSearchResult[] = [
        {
          record: {
            id: 'auth.validateToken',
            domain: 'auth',
            section: 'requirements',
            title: 'Requirement: ValidateToken',
            text: '[spec:auth] Requirement: ValidateToken\nThe system SHALL validate JWT tokens...',
            linkedFiles: ['src/auth/jwt.ts', 'src/auth/middleware.ts'],
          },
          score: 0.9,
        },
      ];

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(
        mockOutputDir,
        'authentication',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Results should be sorted by final score (descending)
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
    });

    it('should respect the limit parameter', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = Array(5)
        .fill(0)
        .map((_, i) => ({
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
            text: `[TypeScript] src/file${i}.ts function${i}\nfunction${i}(): void\nFunction ${i}`,
          },
          score: 0.5 + i * 0.1,
        }));

      const mockSpecResults: SpecSearchResult[] = Array(5)
        .fill(0)
        .map((_, i) => ({
          record: {
            id: `domain${i}.requirement${i}`,
            domain: `domain${i}`,
            section: 'requirements',
            title: `Requirement: Requirement${i}`,
            text: `[spec:domain${i}] Requirement: Requirement${i}\nRequirement ${i} text...`,
            linkedFiles: [],
          },
          score: 0.4 + i * 0.1,
        }));

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(mockOutputDir, 'test', mockEmbedSvc, {
        limit: 3,
      });

      expect(results).toHaveLength(3);
    });

    it('should handle errors gracefully', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockRejectedValue(new Error('Index error'));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue([]);

      const results = await UnifiedSearch.unifiedSearch(mockOutputDir, 'test', mockEmbedSvc, {
        limit: 10,
      });

      // Should return empty array on error
      expect(results).toHaveLength(0);
    });

    it('should work without mapping.json', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = [
        {
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
            text: '[TypeScript] src/auth/jwt.ts validateToken\nvalidateToken(token: string): boolean\nValidates JWT token',
          },
          score: 0.8,
        },
      ];

      const mockSpecResults: SpecSearchResult[] = [
        {
          record: {
            id: 'auth.validateToken',
            domain: 'auth',
            section: 'requirements',
            title: 'Requirement: ValidateToken',
            text: '[spec:auth] Requirement: ValidateToken\nThe system SHALL validate JWT tokens...',
            linkedFiles: [],
          },
          score: 0.7,
        },
      ];

      // Override readFile to throw error (no mapping.json)
      mockFs.readFile.mockRejectedValueOnce(new Error('File not found'));

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(
        mockOutputDir,
        'validate token',
        mockEmbedSvc,
        { limit: 10 }
      );

      // Should still return results without cross-scoring
      expect(results).toHaveLength(2);
      expect(results[0].mappingBoost).toBe(0);
      expect(results[1].mappingBoost).toBe(0);
    });
  });

  describe('Provenance Tagging', () => {
    it('should tag code results with linked specs as "both"', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = [
        {
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
            text: '[TypeScript] src/auth/jwt.ts validateToken\nvalidateToken(token: string): boolean\nValidates JWT token',
          },
          score: 0.8,
        },
      ];

      const mockSpecResults: SpecSearchResult[] = [
        {
          record: {
            id: 'auth.validateToken',
            domain: 'auth',
            section: 'requirements',
            title: 'Requirement: ValidateToken',
            text: '[spec:auth] Requirement: ValidateToken\nThe system SHALL validate JWT tokens...',
            linkedFiles: ['src/auth/jwt.ts'],
          },
          score: 0.7,
        },
      ];

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(
        mockOutputDir,
        'validate token',
        mockEmbedSvc,
        { limit: 10 }
      );

      const codeResult = results.find((r) => r.source.filePath);
      expect(codeResult).toBeDefined();
      expect(codeResult!.type).toBe('both');
    });

    it('should tag spec results with linked code as "both"', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = [
        {
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
            text: '[TypeScript] src/auth/jwt.ts validateToken\nvalidateToken(token: string): boolean\nValidates JWT token',
          },
          score: 0.8,
        },
      ];

      const mockSpecResults: SpecSearchResult[] = [
        {
          record: {
            id: 'auth.validateToken',
            domain: 'auth',
            section: 'requirements',
            title: 'Requirement: ValidateToken',
            text: '[spec:auth] Requirement: ValidateToken\nThe system SHALL validate JWT tokens...',
            linkedFiles: ['src/auth/jwt.ts'],
          },
          score: 0.7,
        },
      ];

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(
        mockOutputDir,
        'validate token',
        mockEmbedSvc,
        { limit: 10 }
      );

      const specResult = results.find((r) => r.source.domain);
      expect(specResult).toBeDefined();
      expect(specResult!.type).toBe('both');
    });

    it('should tag results without links as "code" or "spec"', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = [
        {
          record: {
            id: 'src/utils/logger.ts::log',
            name: 'log',
            filePath: 'src/utils/logger.ts',
            className: '',
            language: 'TypeScript',
            signature: 'log(message: string): void',
            docstring: 'Logs a message',
            fanIn: 2,
            fanOut: 0,
            isHub: false,
            isEntryPoint: false,
            text: '[TypeScript] src/utils/logger.ts log\nlog(message: string): void\nLogs a message',
          },
          score: 0.6,
        },
      ];

      const mockSpecResults: SpecSearchResult[] = [
        {
          record: {
            id: 'utils.logging',
            domain: 'utils',
            section: 'requirements',
            title: 'Requirement: Logging',
            text: '[spec:utils] Requirement: Logging\nThe system SHALL log messages...',
            linkedFiles: [],
          },
          score: 0.5,
        },
      ];

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(mockOutputDir, 'logging', mockEmbedSvc, {
        limit: 10,
      });

      const codeResult = results.find((r) => r.source.filePath);
      expect(codeResult).toBeDefined();
      expect(codeResult!.type).toBe('code');

      const specResult = results.find((r) => r.source.domain);
      expect(specResult).toBeDefined();
      expect(specResult!.type).toBe('spec');
    });
  });

  describe('Source Metadata Extraction', () => {
    it('should extract source metadata for code results', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockCodeResults: CodeSearchResult[] = [
        {
          record: {
            id: 'src/auth/jwt.ts::validateToken',
            name: 'validateToken',
            filePath: 'src/auth/jwt.ts',
            className: 'AuthService',
            language: 'TypeScript',
            signature: 'validateToken(token: string): boolean',
            docstring: 'Validates JWT token',
            fanIn: 5,
            fanOut: 2,
            isHub: false,
            isEntryPoint: false,
            text: '[TypeScript] src/auth/jwt.ts AuthService.validateToken\nvalidateToken(token: string): boolean\nValidates JWT token',
          },
          score: 0.8,
        },
      ];

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue(mockCodeResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue([]);

      const results = await UnifiedSearch.unifiedSearch(
        mockOutputDir,
        'validate token',
        mockEmbedSvc,
        { limit: 10 }
      );

      const codeResult = results[0];
      expect(codeResult.source.filePath).toBe('src/auth/jwt.ts');
      expect(codeResult.source.functionName).toBe('validateToken');
      expect(codeResult.source.className).toBe('AuthService');
      expect(codeResult.source.language).toBe('TypeScript');
      expect(codeResult.source.domain).toBeUndefined();
      expect(codeResult.source.section).toBeUndefined();
      expect(codeResult.source.title).toBeUndefined();
    });

    it('should extract source metadata for spec results', async () => {
      const { VectorIndex } = await import('../vector-index.js');
      const { SpecVectorIndex } = await import('../spec-vector-index.js');

      const mockSpecResults: SpecSearchResult[] = [
        {
          record: {
            id: 'auth.validateToken',
            domain: 'auth',
            section: 'requirements',
            title: 'Requirement: ValidateToken',
            text: '[spec:auth] Requirement: ValidateToken\nThe system SHALL validate JWT tokens...',
            linkedFiles: [],
          },
          score: 0.7,
        },
      ];

      vi.spyOn(VectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(SpecVectorIndex, 'exists').mockReturnValue(true);
      vi.spyOn(VectorIndex, 'search').mockResolvedValue([]);
      vi.spyOn(SpecVectorIndex, 'search').mockResolvedValue(mockSpecResults.map((result) => ({ ...result, matchEvidence: TEST_MATCH_EVIDENCE })));

      const results = await UnifiedSearch.unifiedSearch(
        mockOutputDir,
        'validate token',
        mockEmbedSvc,
        { limit: 10 }
      );

      const specResult = results[0];
      expect(specResult.source.domain).toBe('auth');
      expect(specResult.source.section).toBe('requirements');
      expect(specResult.source.title).toBe('Requirement: ValidateToken');
      expect(specResult.source.filePath).toBeUndefined();
      expect(specResult.source.functionName).toBeUndefined();
      expect(specResult.source.className).toBeUndefined();
      expect(specResult.source.language).toBeUndefined();
    });
  });
});
