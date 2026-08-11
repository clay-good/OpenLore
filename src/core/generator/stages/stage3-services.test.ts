import { describe, expect, it } from 'vitest';
import { runStage3 } from './stage3-services.js';
import { createMockLLMService } from '../../services/llm-service.js';
import type { PipelineContext, ProjectSurveyResult } from '../../../types/pipeline.js';

const survey: ProjectSurveyResult = { projectCategory: 'api-service', primaryLanguage: 'TypeScript', frameworks: [], architecturePattern: 'layered', domainSummary: '', suggestedDomains: ['billing'], confidence: 1, schemaFiles: [], serviceFiles: [], apiFiles: [] };

// openlore: {"domain":"generator","requirement":"Domain-Aggregated Deterministic Generation Evidence","scenario":"A domain spans multiple service files","specFile":"openspec/specs/generator/spec.md"}
describe('runStage3', () => {
  it('synthesizes services from all files of one domain in one call', async () => {
    const { service, provider } = createMockLLMService();
    provider.setDefaultResponse(JSON.stringify([{ name: 'BillingService', purpose: 'billing', operations: [{ name: 'collect', description: '', scenarios: [], functionName: 'invented' }], dependencies: [], sideEffects: [], domain: 'wrong' }]));
    const pipeline: PipelineContext = {
      llm: service, options: { saveIntermediate: false, chunkMaxChars: 8_000 }, saveResult: async () => undefined,
      chunkContent: () => [], graphPromptFor: () => null, schemasFor: () => null, routesFor: () => null,
      signaturesFor: path => path === 'src/invoice.ts' ? '- createInvoice()' : '- collectPayment()', generateSubSpecs: async () => [],
    };
    const result = await runStage3(pipeline, survey, [], [
      { path: 'src/invoice.ts', content: 'export function createInvoice() {}' },
      { path: 'src/payment.ts', content: 'export function collectPayment() {}' },
    ], undefined, () => 'billing');

    expect(provider.callHistory).toHaveLength(1);
    expect(provider.callHistory[0].userPrompt).toContain('createInvoice');
    expect(provider.callHistory[0].userPrompt).toContain('collectPayment');
    expect(result.data?.[0]).toMatchObject({ name: 'BillingService', domain: 'billing', locationFile: 'src/invoice.ts' });
    expect(result.data?.[0].operations[0].functionName).toBeUndefined();
  });

  it('keeps a qualified method anchor instead of dropping it over the dotted form', async () => {
    // `Class.method` and `method` name the same function; which form appears depends
    // on the language and on how the model echoed it back. Dropping the mismatched
    // form loses the anchor, so the requirement is written with no implementation.
    const { service, provider } = createMockLLMService();
    provider.setDefaultResponse(JSON.stringify([{
      name: 'BillingService', purpose: 'billing', dependencies: [], sideEffects: [], domain: 'wrong',
      operations: [
        { name: 'charge', description: '', scenarios: [], functionName: 'Invoice.charge' },
        { name: 'settle', description: '', scenarios: [], functionName: 'settle' },
        { name: 'ghost', description: '', scenarios: [], functionName: 'neverDefined' },
      ],
    }]));
    const pipeline: PipelineContext = {
      llm: service, options: { saveIntermediate: false, chunkMaxChars: 8_000 }, saveResult: async () => undefined,
      chunkContent: () => [], graphPromptFor: () => null, schemasFor: () => null, routesFor: () => null,
      signaturesFor: () => '- charge()\n- Payment.settle()', generateSubSpecs: async () => [],
    };
    const result = await runStage3(pipeline, survey, [], [
      { path: 'src/invoice.ts', content: 'export class Invoice { charge() {} }' },
    ], undefined, () => 'billing');

    const names = result.data?.[0].operations.map(operation => operation.functionName);
    // Qualified → bare, bare → qualified, and an unknown name still resolves to nothing.
    expect(names).toEqual(['charge', 'Payment.settle', undefined]);
  });

  it('reconciles duplicate service output across stable domain partitions', async () => {
    const { service, provider } = createMockLLMService();
    provider.setResponse('src/invoice.ts', JSON.stringify([{ name: 'BillingService', purpose: 'billing', operations: [{ name: 'create', description: '', scenarios: [], functionName: 'createInvoice' }], dependencies: [], sideEffects: [], domain: 'wrong' }]));
    provider.setResponse('src/payment.ts', JSON.stringify([{ name: 'BillingService', purpose: 'billing', operations: [{ name: 'collect', description: '', scenarios: [], functionName: 'collectPayment' }], dependencies: [], sideEffects: [], domain: 'wrong' }]));
    const pipeline: PipelineContext = {
      llm: service, options: { saveIntermediate: false, chunkMaxChars: 90 }, saveResult: async () => undefined,
      chunkContent: () => [], graphPromptFor: () => null, schemasFor: () => null, routesFor: () => null,
      signaturesFor: path => path === 'src/invoice.ts' ? '- createInvoice()' : '- collectPayment()', generateSubSpecs: async () => [],
    };

    const result = await runStage3(pipeline, survey, [], [
      { path: 'src/invoice.ts', content: 'export function createInvoice() {}'.repeat(4) },
      { path: 'src/payment.ts', content: 'export function collectPayment() {}'.repeat(4) },
    ], undefined, () => 'billing');

    expect(provider.callHistory).toHaveLength(2);
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0].operations.map(operation => operation.functionName)).toEqual(['createInvoice', 'collectPayment']);
  });
});
