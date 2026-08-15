/**
 * OpenSpec Format Generator Tests
 */

import { describe, it, expect } from 'vitest';
import {
  OpenSpecFormatGenerator,
  validateSpec,
  generateOpenSpecs,
} from './openspec-format-generator.js';
import type {
  PipelineResult,
  ProjectSurveyResult,
  ExtractedEntity,
  ExtractedService,
  ExtractedEndpoint,
  ArchitectureSynthesis,
} from './spec-pipeline.js';
import { requirementAnchorKey, type SpecSymbolRef } from './spec-link-index.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createMockSurvey(): ProjectSurveyResult {
  return {
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
  };
}

function createMockEntities(): ExtractedEntity[] {
  return [
    {
      name: 'User',
      description: 'Represents a user in the system',
      properties: [
        { name: 'id', type: 'string', required: true },
        { name: 'name', type: 'string', required: true },
        { name: 'email', type: 'string', required: true, description: 'Unique email address' },
      ],
      relationships: [
        { targetEntity: 'Post', type: 'one-to-many', description: 'authored posts' },
      ],
      validations: ['Email must be unique', 'Name is required'],
      scenarios: [
        {
          name: 'Create Valid User',
          given: 'valid user data',
          when: 'createUser is called',
          then: 'user is created successfully',
        },
      ],
      location: 'models/user.ts',
    },
    {
      name: 'Post',
      description: 'Represents a blog post',
      properties: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
        { name: 'authorId', type: 'string', required: true },
      ],
      relationships: [
        { targetEntity: 'User', type: 'belongs-to' },
      ],
      validations: ['Title must not be empty'],
      scenarios: [],
      location: 'models/post.ts',
    },
  ];
}

function createMockServices(): ExtractedService[] {
  return [
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
            {
              name: 'Get existing user',
              given: 'a user with ID "123" exists',
              when: 'getUser("123") is called',
              then: 'the user is returned',
            },
            {
              name: 'Get non-existent user',
              given: 'no user with ID "999" exists',
              when: 'getUser("999") is called',
              then: 'null is returned',
            },
          ],
        },
      ],
      dependencies: ['UserRepository'],
      sideEffects: [],
      domain: 'user',
    },
  ];
}

function createMockEndpoints(): ExtractedEndpoint[] {
  return [
    {
      method: 'GET',
      path: '/users/:id',
      purpose: 'Get user by ID',
      authentication: 'Bearer token',
      requestSchema: {},
      responseSchema: { id: 'string', name: 'string', email: 'string' },
      scenarios: [
        {
          name: 'Get user success',
          given: 'a valid bearer token',
          when: 'GET /users/123 is called',
          then: 'user data is returned with status 200',
        },
      ],
      relatedEntity: 'User',
    },
    {
      method: 'POST',
      path: '/users',
      purpose: 'Create a new user',
      authentication: 'Bearer token',
      requestSchema: { name: 'string', email: 'string' },
      responseSchema: { id: 'string', name: 'string', email: 'string' },
      scenarios: [],
      relatedEntity: 'User',
    },
  ];
}

function createMockArchitecture(): ArchitectureSynthesis {
  return {
    systemPurpose: 'A user management API that handles user CRUD operations and authentication. The system provides a RESTful interface for managing users.',
    architectureStyle: 'Layered architecture with clear separation of concerns between presentation, business logic, and data access.',
    layerMap: [
      { name: 'API', purpose: 'HTTP request handling', components: ['routes/'] },
      { name: 'Service', purpose: 'Business logic', components: ['services/'] },
      { name: 'Data', purpose: 'Database access', components: ['models/', 'repositories/'] },
    ],
    dataFlow: 'Request -> Routes -> Services -> Repositories -> Database',
    integrations: ['PostgreSQL', 'Redis'],
    securityModel: 'JWT-based authentication',
    keyDecisions: ['Use TypeORM for database access', 'Express for HTTP routing', 'JWT for stateless auth'],
  };
}

function createMockPipelineResult(): PipelineResult {
  return {
    survey: createMockSurvey(),
    entities: createMockEntities(),
    services: createMockServices(),
    endpoints: createMockEndpoints(),
    architecture: createMockArchitecture(),
    metadata: {
      totalTokens: 5000,
      estimatedCost: 0.05,
      duration: 10000,
      completedStages: ['survey', 'entities', 'services', 'api', 'architecture'],
      skippedStages: [],
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('OpenSpecFormatGenerator', () => {
  describe('generateSpecs', () => {
    it('should generate all spec types', () => {
      const generator = new OpenSpecFormatGenerator({ version: '1.0.0' });
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);

      // Should have overview, architecture, api, and at least one domain
      expect(specs.length).toBeGreaterThanOrEqual(3);

      const types = specs.map(s => s.type);
      expect(types).toContain('overview');
      expect(types).toContain('architecture');
      expect(types).toContain('api');
      expect(types).toContain('domain');
    });

    it('should generate correct file paths', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);

      const paths = specs.map(s => s.path);
      expect(paths).toContain('openspec/specs/overview/spec.md');
      expect(paths).toContain('openspec/specs/architecture/spec.md');
      expect(paths).toContain('openspec/specs/api/spec.md');
      expect(paths.some(p => p.includes('/user/'))).toBe(true);
    });

    // Path-traversal confinement (GHSA-5j8x-q7q6-58j5). The Stage-3 `domain` field is
    // returned verbatim by the LLM over untrusted repository content; a traversal
    // value must not survive into the spec's output path.
    it('normalizes a malicious service domain into a safe in-root path', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();
      // Only this service drives a domain, so the domain spec below is unambiguous.
      result.entities = [];
      result.endpoints = [];
      result.services = [
        { ...createMockServices()[0], domain: '../../../../../../tmp/openlore_traversal_proof' },
      ];

      const specs = generator.generateSpecs(result);
      const domainSpecs = specs.filter(s => s.type === 'domain');

      expect(domainSpecs.length).toBeGreaterThan(0);
      for (const s of domainSpecs) {
        // No traversal segment survives, and the path stays under openspec/specs/.
        expect(s.path).not.toContain('..');
        expect(s.path.startsWith('openspec/specs/')).toBe(true);
        expect(s.path.endsWith('/spec.md')).toBe(true);
        expect(s.domain).not.toContain('/');
        expect(s.domain).not.toContain('..');
      }
    });

    it('should not generate API spec when no endpoints', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();
      result.endpoints = [];

      const specs = generator.generateSpecs(result);

      const types = specs.map(s => s.type);
      expect(types).not.toContain('api');
    });
  });

  describe('Overview Spec', () => {
    it('should include header with version and date', () => {
      const generator = new OpenSpecFormatGenerator({ version: '2.0.0' });
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const overview = specs.find(s => s.type === 'overview')!;

      expect(overview.content).toContain('# System Overview');
      expect(overview.content).toContain('Generated by openlore v2.0.0');
      expect(overview.content).toMatch(/\d{4}-\d{2}-\d{2}/); // Date format
    });

    it('should include confidence when enabled', () => {
      const generator = new OpenSpecFormatGenerator({ includeConfidence: true });
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const overview = specs.find(s => s.type === 'overview')!;

      expect(overview.content).toContain('Confidence: 85%');
    });

    it('should include domains table', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const overview = specs.find(s => s.type === 'overview')!;

      expect(overview.content).toContain('## Domains');
      expect(overview.content).toContain('| Domain | Description | Spec |');
      expect(overview.content).toContain('User');
    });

    it('should include technical stack', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const overview = specs.find(s => s.type === 'overview')!;

      expect(overview.content).toContain('## Technical Stack');
      expect(overview.content).toContain('TypeScript');
      expect(overview.content).toContain('Express');
      expect(overview.content).toContain('Layered Architecture');
    });

    it('should include key capabilities', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const overview = specs.find(s => s.type === 'overview')!;

      expect(overview.content).toContain('## Requirements');
      expect(overview.content).toContain('TypeORM for database access');
    });
  });

  describe('Domain Spec', () => {
    it('should generate domain spec with entities', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const userSpec = specs.find(s => s.domain === 'user' && s.type === 'domain')!;

      expect(userSpec).toBeDefined();
      expect(userSpec.content).toContain('# User Specification');
      expect(userSpec.content).toContain('## Entities');
      expect(userSpec.content).toContain('### User');
    });

    it('should include properties table', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const userSpec = specs.find(s => s.domain === 'user' && s.type === 'domain')!;

      expect(userSpec.content).toContain('**Properties:**');
      expect(userSpec.content).toContain('| Name | Type | Description |');
      expect(userSpec.content).toContain('| id | string |');
      expect(userSpec.content).toContain('| email | string | Unique email address |');
    });

    it('should include relationships', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const userSpec = specs.find(s => s.domain === 'user' && s.type === 'domain')!;

      expect(userSpec.content).toContain('**Relationships:**');
      expect(userSpec.content).toContain('has many Post');
    });

    it('should include validation requirements', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const userSpec = specs.find(s => s.domain === 'user' && s.type === 'domain')!;

      expect(userSpec.content).toContain('### Requirement: UserValidation');
      expect(userSpec.content).toContain('SHALL validate User');
      expect(userSpec.content).toContain('Email must be unique');
    });

    it('should include entity scenarios', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const userSpec = specs.find(s => s.domain === 'user' && s.type === 'domain')!;

      expect(userSpec.content).toContain('#### Scenario: CreateValidUser');
      expect(userSpec.content).toContain('**GIVEN** valid user data');
      expect(userSpec.content).toContain('**WHEN** createUser is called');
      expect(userSpec.content).toContain('**THEN** user is created successfully');
    });

    it('should include service operation requirements', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const userSpec = specs.find(s => s.domain === 'user' && s.type === 'domain')!;

      expect(userSpec.content).toContain('### Requirement: GetUser');
      expect(userSpec.content).toContain('SHALL retrieves a user by id');
    });

    it('should include source files', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const userSpec = specs.find(s => s.domain === 'user' && s.type === 'domain')!;

      expect(userSpec.content).toContain('Source files: models/user.ts');
    });
  });

  describe('Architecture Spec', () => {
    it('should include architecture style', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const archSpec = specs.find(s => s.type === 'architecture')!;

      expect(archSpec.content).toContain('# Architecture Specification');
      expect(archSpec.content).toContain('## Architecture Style');
      expect(archSpec.content).toContain('Layered architecture');
    });

    it('should include layer separation requirement', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const archSpec = specs.find(s => s.type === 'architecture')!;

      expect(archSpec.content).toContain('### Requirement: LayeredArchitecture');
      expect(archSpec.content).toContain('SHALL maintain separation');
      expect(archSpec.content).toContain('#### Scenario: LayerSeparation');
    });

    it('should include security model requirement', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const archSpec = specs.find(s => s.type === 'architecture')!;

      expect(archSpec.content).toContain('### Requirement: SecurityModel');
      expect(archSpec.content).toContain('JWT-based authentication');
    });

    it('should include mermaid diagram', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const archSpec = specs.find(s => s.type === 'architecture')!;

      expect(archSpec.content).toContain('```mermaid');
      expect(archSpec.content).toContain('graph TB');
      expect(archSpec.content).toContain('API[API]');
      expect(archSpec.content).toContain('API --> Service');
    });

    it('should include layer structure', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const archSpec = specs.find(s => s.type === 'architecture')!;

      expect(archSpec.content).toContain('## Layer Structure');
      expect(archSpec.content).toContain('### API');
      expect(archSpec.content).toContain('**Purpose**: HTTP request handling');
    });

    it('should include data flow', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const archSpec = specs.find(s => s.type === 'architecture')!;

      expect(archSpec.content).toContain('## Data Flow');
      expect(archSpec.content).toContain('Request -> Routes');
    });

    it('should include external integrations', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const archSpec = specs.find(s => s.type === 'architecture')!;

      expect(archSpec.content).toContain('## External Integrations');
      expect(archSpec.content).toContain('PostgreSQL');
      expect(archSpec.content).toContain('Redis');
    });
  });

  describe('API Spec', () => {
    it('should include authentication requirement', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const apiSpec = specs.find(s => s.type === 'api')!;

      expect(apiSpec.content).toContain('# API Specification');
      expect(apiSpec.content).toContain('## Requirements');
      expect(apiSpec.content).toContain('### Requirement: APIAuthentication');
      expect(apiSpec.content).toContain('Bearer token');
    });

    it('should include endpoint requirements', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const apiSpec = specs.find(s => s.type === 'api')!;

      expect(apiSpec.content).toContain('## Requirements');
      expect(apiSpec.content).toContain('### Requirement: GETUser');
      expect(apiSpec.content).toContain('`GET /users/:id`');
    });

    it('should include request/response schemas', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const apiSpec = specs.find(s => s.type === 'api')!;

      expect(apiSpec.content).toContain('**Request:**');
      expect(apiSpec.content).toContain('**Response:**');
      expect(apiSpec.content).toContain('"name": "string"');
    });

    it('should include endpoint scenarios', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const apiSpec = specs.find(s => s.type === 'api')!;

      expect(apiSpec.content).toContain('#### Scenario: GetUserSuccess');
      expect(apiSpec.content).toContain('**GIVEN** a valid bearer token');
    });

    it('should generate default scenario when none provided', () => {
      const generator = new OpenSpecFormatGenerator();
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const apiSpec = specs.find(s => s.type === 'api')!;

      // POST /users has no scenarios, should get default
      expect(apiSpec.content).toContain('#### Scenario: POSTUserSuccess');
      expect(apiSpec.content).toContain('**GIVEN** an authenticated user');
    });
  });

  describe('Options', () => {
    it('should respect minimal style', () => {
      const generator = new OpenSpecFormatGenerator({
        style: 'minimal',
        includeTechnicalNotes: false,
        includeConfidence: false,
      });
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const overview = specs.find(s => s.type === 'overview')!;

      expect(overview.content).not.toContain('Confidence:');
    });

    it('should exclude technical notes when disabled', () => {
      const generator = new OpenSpecFormatGenerator({
        includeTechnicalNotes: false,
      });
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const overview = specs.find(s => s.type === 'overview')!;

      expect(overview.content).not.toContain('## Technical Notes');
    });

    it('should use custom version', () => {
      const generator = new OpenSpecFormatGenerator({ version: '3.0.0-beta' });
      const result = createMockPipelineResult();

      const specs = generator.generateSpecs(result);
      const overview = specs.find(s => s.type === 'overview')!;

      expect(overview.content).toContain('openlore v3.0.0-beta');
    });
  });
});

// ============================================================================
// SCENARIO ANNOTATION INFERENCE
// ============================================================================

describe('inferTestAnnotation (via generateSpecs)', () => {
  function makeResult(scenarioName: string, thenClause: string): PipelineResult {
    return {
      survey: createMockSurvey(),
      entities: [],
      services: [
        {
          name: 'TestService',
          domain: 'test',
          purpose: 'Test service',
          operations: [
            {
              name: 'TestOp',
              description: 'Test operation',
              scenarios: [{ name: scenarioName, given: 'context', when: 'action', then: thenClause }],
            },
          ],
        },
      ] as unknown as PipelineResult['services'],
      endpoints: [],
      architecture: {
        systemPurpose: 'Test',
        architectureStyle: 'layered',
        layerMap: [],
        dataFlow: '',
        keyDecisions: [],
        securityModel: '',
        integrations: [],
      },
      adrs: [],
      metadata: {
        totalTokens: 0,
        estimatedCost: 0,
        duration: 0,
        completedStages: [],
        skippedStages: [],
      },
    };
  }

  function getScenarioBlock(content: string, scenarioName: string): string {
    const idx = content.indexOf(`#### Scenario: ${scenarioName}`);
    if (idx === -1) return '';
    const end = content.indexOf('\n#### ', idx + 1);
    return end > -1 ? content.slice(idx, end) : content.slice(idx);
  }

  it('emits tags=smoke for a successful scenario', () => {
    const specs = generateOpenSpecs(makeResult('SuccessfulLogin', 'user is logged in'));
    const domain = specs.find(s => s.type === 'domain')!;
    const block = getScenarioBlock(domain.content, 'SuccessfulLogin');
    expect(block).toContain('tags=smoke');
  });

  it('emits tags=regression for an invalid-credentials scenario', () => {
    const specs = generateOpenSpecs(makeResult('InvalidCredentials', 'returns error 401'));
    const domain = specs.find(s => s.type === 'domain')!;
    const block = getScenarioBlock(domain.content, 'InvalidCredentials');
    expect(block).toContain('tags=regression');
  });

  it('emits priority=high for an auth scenario', () => {
    const specs = generateOpenSpecs(makeResult('LoginWithJwt', 'token is returned'));
    const domain = specs.find(s => s.type === 'domain')!;
    const block = getScenarioBlock(domain.content, 'LoginWithJwt');
    expect(block).toContain('priority=high');
  });

  it('emits priority=low for a deprecated scenario', () => {
    const specs = generateOpenSpecs(makeResult('LegacyEndpointBackcompat', 'old format accepted'));
    const domain = specs.find(s => s.type === 'domain')!;
    const block = getScenarioBlock(domain.content, 'LegacyEndpointBackcompat');
    expect(block).toContain('priority=low');
  });

  it('emits no annotation for a generic scenario', () => {
    const specs = generateOpenSpecs(makeResult('ProcessData', 'data is processed'));
    const domain = specs.find(s => s.type === 'domain')!;
    const block = getScenarioBlock(domain.content, 'ProcessData');
    expect(block).not.toContain('openlore-test');
  });

  it('annotation appears between heading and GIVEN bullet', () => {
    const specs = generateOpenSpecs(makeResult('SuccessfulCreation', 'resource is created'));
    const domain = specs.find(s => s.type === 'domain')!;
    const block = getScenarioBlock(domain.content, 'SuccessfulCreation');
    const lines = block.split('\n');
    const annotationIdx = lines.findIndex(l => l.includes('openlore-test'));
    const givenIdx = lines.findIndex(l => l.includes('**GIVEN**'));
    expect(annotationIdx).toBeGreaterThan(0);
    expect(annotationIdx).toBeLessThan(givenIdx);
  });
});

describe('validateSpec', () => {
  it('should validate valid spec', () => {
    const validSpec = `# User Specification

> Generated by openlore

## Purpose

Manages user data.

## Requirements

### Requirement: UserValidation

The system SHALL validate user data.

#### Scenario: ValidUser
- **GIVEN** valid user data
- **WHEN** validation is performed
- **THEN** validation succeeds
`;

    const result = validateSpec(validSpec);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect missing title', () => {
    const spec = `## Purpose

Some content`;

    const result = validateSpec(spec);

    expect(result.errors).toContain('Missing title (# heading)');
  });

  it('should warn on missing Purpose section', () => {
    const spec = `# Spec

## Requirements

Content here`;

    const result = validateSpec(spec);

    expect(result.warnings).toContain('Missing Purpose section');
  });

  it('should warn on missing RFC 2119 keywords', () => {
    const spec = `# Spec

## Purpose

Purpose here

## Requirements

### Requirement: SomeReq

The system does something.

#### Scenario: Test
- **GIVEN** something
- **WHEN** action
- **THEN** result
`;

    const result = validateSpec(spec);

    expect(result.warnings.some(w => w.includes('RFC 2119'))).toBe(true);
  });

  it('should detect missing scenario parts', () => {
    const spec = `# Spec

## Purpose

Purpose

## Requirements

### Requirement: Test

The system SHALL work.

#### Scenario: BadScenario
- **GIVEN** something
- **WHEN** action
`;

    const result = validateSpec(spec);

    expect(result.errors.some(e => e.includes('missing THEN'))).toBe(true);
  });

  it('should detect delta markers', () => {
    const spec = `# Spec

## Purpose

[ADDED] New purpose

## Requirements

### Requirement: Test

The system SHALL work.

#### Scenario: Test
- **GIVEN** something
- **WHEN** action
- **THEN** result
`;

    const result = validateSpec(spec);

    expect(result.errors).toContain('Generated specs should not contain delta markers');
  });
});

describe('generateOpenSpecs convenience function', () => {
  it('should generate specs with default options', () => {
    const result = createMockPipelineResult();

    const specs = generateOpenSpecs(result);

    expect(specs.length).toBeGreaterThan(0);
    expect(specs[0].content).toContain('Generated by openlore');
  });

  it('should accept custom options', () => {
    const result = createMockPipelineResult();

    const specs = generateOpenSpecs(result, { version: '5.0.0' });

    expect(specs[0].content).toContain('openlore v5.0.0');
  });
});

describe('Edge Cases', () => {
  it('should handle empty entities array', () => {
    const generator = new OpenSpecFormatGenerator();
    const result = createMockPipelineResult();
    result.entities = [];

    const specs = generator.generateSpecs(result);

    // Should still generate overview and architecture
    expect(specs.some(s => s.type === 'overview')).toBe(true);
    expect(specs.some(s => s.type === 'architecture')).toBe(true);
  });

  it('should handle empty services array', () => {
    const generator = new OpenSpecFormatGenerator();
    const result = createMockPipelineResult();
    result.services = [];

    const specs = generator.generateSpecs(result);

    expect(specs.length).toBeGreaterThan(0);
  });

  it('should handle entity without scenarios', () => {
    const generator = new OpenSpecFormatGenerator();
    const result = createMockPipelineResult();
    result.entities[0].scenarios = [];

    const specs = generator.generateSpecs(result);
    const userSpec = specs.find(s => s.domain === 'user' && s.type === 'domain')!;

    expect(userSpec.content).toContain('### Requirement: UserValidation');
  });

  it('should handle empty suggested domains', () => {
    const generator = new OpenSpecFormatGenerator();
    const result = createMockPipelineResult();
    result.survey.suggestedDomains = [];

    const specs = generator.generateSpecs(result);

    // Should still generate specs, inferring domains from entities
    expect(specs.length).toBeGreaterThan(0);
  });

  it('should handle very long text with wrapping', () => {
    const generator = new OpenSpecFormatGenerator({ maxLineWidth: 50 });
    const result = createMockPipelineResult();
    result.architecture.systemPurpose = 'This is a very long description that should be wrapped across multiple lines for better readability in the generated markdown file.';

    const specs = generator.generateSpecs(result);
    const overview = specs.find(s => s.type === 'overview')!;

    const purposeLines = overview.content.split('\n').filter(l => l.startsWith('This') || l.startsWith('across'));
    expect(purposeLines.length).toBeGreaterThan(1);
  });

  it('should handle special characters in names', () => {
    const generator = new OpenSpecFormatGenerator();
    const result = createMockPipelineResult();
    result.entities[0].name = 'User_Profile';

    const specs = generator.generateSpecs(result);

    expect(specs.some(s => s.content.includes('User_Profile'))).toBe(true);
  });
});

// ============================================================================
// ## Dependencies section (Piste 4)
// ============================================================================

function makeMinimalDepGraph(overrides: Partial<DependencyGraphResult> = {}): DependencyGraphResult {
  return {
    nodes: [], edges: [], clusters: [], structuralClusters: [], cycles: [],
    rankings: { byImportance: [], byConnectivity: [], clusterCenters: [], leafNodes: [], bridgeNodes: [], orphanNodes: [] },
    statistics: {
      nodeCount: 0, edgeCount: 0, httpEdgeCount: 0, importEdgeCount: 0,
      avgDegree: 0, density: 0, clusterCount: 0, structuralClusterCount: 0, cycleCount: 0,
    },
    ...overrides,
  };
}

describe('OpenSpecFormatGenerator — ## Dependencies section', () => {
  it('emits ## Dependencies with calledBy and Calls into when cross-cluster edges exist', () => {
    const depGraph = makeMinimalDepGraph({
      clusters: [
        {
          id: 'c-gen', name: 'generator', files: ['src/gen.ts'],
          internalEdges: 1, cohesion: 0.5, isStructural: true,
          suggestedDomain: 'generator', color: '#0f0',
          externalEdges: 1, coupling: 0.5,
        },
        {
          id: 'c-ana', name: 'analyzer', files: ['src/ana.ts'],
          internalEdges: 1, cohesion: 0.5, isStructural: true,
          suggestedDomain: 'analyzer', color: '#f00',
          externalEdges: 1, coupling: 0.5,
        },
      ],
      edges: [
        { source: 'src/ana.ts', target: 'src/gen.ts', importedNames: ['GenHelper'], isTypeOnly: false, weight: 1 },
      ],
    });

    const result = createMockPipelineResult();
    // Ensure a service lives in the 'user' domain with file matching cluster
    result.survey.suggestedDomains = ['generator', 'analyzer'];
    result.services = [
      {
        name: 'GeneratorService', domain: 'generator', purpose: 'gen',
        operations: [{ name: 'doGen', description: 'generate', scenarios: [] }],
        dependencies: [], sideEffects: [],
      } as unknown as ExtractedService,
      {
        name: 'AnalyzerService', domain: 'analyzer', purpose: 'ana',
        operations: [{ name: 'doAna', description: 'analyze', scenarios: [] }],
        dependencies: [], sideEffects: [],
      } as unknown as ExtractedService,
    ];
    result.entities = [];
    result.endpoints = [];

    const gen = new OpenSpecFormatGenerator({ depGraph });
    const specs = gen.generateSpecs(result);

    const generatorSpec = specs.find(s => s.domain === 'generator')!;
    const analyzerSpec = specs.find(s => s.domain === 'analyzer')!;

    expect(generatorSpec.content).toContain('## Dependencies');
    expect(generatorSpec.content).toContain('### Called by this domain');
    expect(generatorSpec.content).toContain('`analyzer`');

    expect(analyzerSpec.content).toContain('## Dependencies');
    expect(analyzerSpec.content).toContain('### Calls into');
    expect(analyzerSpec.content).toContain('`generator`');
  });

  it('does not emit ## Dependencies when no cross-cluster edges', () => {
    const depGraph = makeMinimalDepGraph({
      clusters: [
        {
          id: 'c1', name: 'user', files: ['src/user.ts'],
          internalEdges: 1, cohesion: 1, isStructural: true,
          suggestedDomain: 'user', color: '#000',
          externalEdges: 0, coupling: 0,
        },
      ],
      edges: [],
    });

    const result = createMockPipelineResult();
    const gen = new OpenSpecFormatGenerator({ depGraph });
    const specs = gen.generateSpecs(result);
    const userSpec = specs.find(s => s.domain === 'user')!;

    expect(userSpec?.content ?? '').not.toContain('## Dependencies');
  });

  it('does not emit ## Dependencies when no depGraph provided', () => {
    const gen = new OpenSpecFormatGenerator();
    const specs = gen.generateSpecs(createMockPipelineResult());
    for (const spec of specs.filter(s => s.type === 'domain')) {
      expect(spec.content).not.toContain('## Dependencies');
    }
  });
});

// ============================================================================
// Requirement-scoped implementation anchors
// ============================================================================

function anchorMap(
  domain: string,
  requirement: string,
  name: string,
  file: string,
  line = 1,
): Map<string, SpecSymbolRef> {
  return new Map([
    [requirementAnchorKey(domain, requirement), { name, file, line, kind: 'function' }],
  ]);
}

describe('OpenSpecFormatGenerator — requirement implementation anchors', () => {
  it('emits the canonical name::path anchor after a matching Requirement header', () => {
    const gen = new OpenSpecFormatGenerator();
    const specs = gen.generateSpecs(
      createMockPipelineResult(),
      anchorMap('user', 'Getuser', 'doSomething', 'src/services/user.ts', 42),
    );
    const userSpec = specs.find(s => s.domain === 'user')!;

    expect(userSpec.content).toContain('- **Implementation**: `doSomething::src/services/user.ts`');
  });

  it('emits no anchor when no verified anchor exists for the requirement', () => {
    const gen = new OpenSpecFormatGenerator();
    const specs = gen.generateSpecs(
      createMockPipelineResult(),
      anchorMap('auth', 'Login', 'login', 'src/auth.ts', 10),
    );
    const userSpec = specs.find(s => s.domain === 'user')!;

    // The domain-level Technical Notes still lists implementation FILES; what must
    // be absent is a requirement-scoped `name::path` symbol anchor.
    expect(userSpec.content).not.toContain('doSomething::');
  });

  it('emits no anchor when no anchor map is passed at all', () => {
    const gen = new OpenSpecFormatGenerator();
    const specs = gen.generateSpecs(createMockPipelineResult());
    for (const spec of specs.filter(s => s.type === 'domain')) {
      expect(spec.content).not.toMatch(/- \*\*Implementation\*\*: `[^`]+::/);
    }
  });

  it('never emits a confidence tier — a written anchor is exact or absent', () => {
    const gen = new OpenSpecFormatGenerator();
    const specs = gen.generateSpecs(
      createMockPipelineResult(),
      anchorMap('user', 'Getuser', 'doSomething', 'src/services/user.ts'),
    );
    const userSpec = specs.find(s => s.domain === 'user')!;

    expect(userSpec.content).not.toContain('confidence:');
  });
});
