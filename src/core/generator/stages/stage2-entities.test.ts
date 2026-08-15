import { describe, expect, it } from 'vitest';
import { runStage2 } from './stage2-entities.js';
import { createMockLLMService } from '../../services/llm-service.js';
import type { PipelineContext, ProjectSurveyResult } from '../../../types/pipeline.js';

const survey: ProjectSurveyResult = {
  projectCategory: 'api-service', primaryLanguage: 'TypeScript', frameworks: [],
  architecturePattern: 'layered', domainSummary: '', suggestedDomains: ['billing'], confidence: 1,
  schemaFiles: [], serviceFiles: [], apiFiles: [],
};

// openlore: {"domain":"generator","requirement":"Domain-Aggregated Deterministic Generation Evidence","scenario":"A domain spans multiple service files","specFile":"openspec/specs/generator/spec.md"}
describe('runStage2', () => {
  it('aggregates schema files in one domain call and restores authoritative locations', async () => {
    const { service, provider } = createMockLLMService();
    provider.setDefaultResponse(JSON.stringify([
      { name: 'Invoice', description: 'invoice', properties: [{ name: 'id', type: 'string' }], relationships: [], validations: [], scenarios: [], location: 'invented.ts' },
      { name: 'Payment', description: 'payment', properties: [{ name: 'id', type: 'string' }], relationships: [], validations: [], scenarios: [], location: 'invented.ts' },
      { name: 'Invented', description: 'invented', properties: [{ name: 'oops', type: 'number' }], relationships: [], validations: [], scenarios: [], location: 'invented.ts' },
    ]));
    const schemas = new Map([
      ['src/invoice.ts', '- Invoice [prisma]: id (string, required), total (decimal)'],
      ['src/payment.ts', '- Payment [prisma]: id (string, required)'],
    ]);
    const pipeline: PipelineContext = {
      llm: service,
      options: { saveIntermediate: false, chunkMaxChars: 8_000 },
      saveResult: async () => undefined,
      chunkContent: () => [],
      graphPromptFor: () => null,
      signaturesFor: () => null,
      schemasFor: path => schemas.get(path) ?? null,
      routesFor: () => null,
      generateSubSpecs: async () => [],
    };

    const result = await runStage2(pipeline, survey, [
      { path: 'src/invoice.ts', content: 'model Invoice { id String }' },
      { path: 'src/payment.ts', content: 'model Payment { id String }' },
    ], undefined, () => 'billing');

    expect(result.success).toBe(true);
    expect(provider.callHistory).toHaveLength(1);
    expect(provider.callHistory[0].userPrompt).toContain('=== src/invoice.ts ===');
    expect(provider.callHistory[0].userPrompt).toContain('=== src/payment.ts ===');
    expect(result.data?.map(entity => [entity.name, entity.location, entity.properties])).toEqual([
      ['Invoice', 'src/invoice.ts', [{ name: 'id', type: 'string', required: true }, { name: 'total', type: 'decimal', required: false }]],
      ['Payment', 'src/payment.ts', [{ name: 'id', type: 'string', required: true }]],
    ]);
  });
});
