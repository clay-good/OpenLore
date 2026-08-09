import { describe, expect, it } from 'vitest';
import { runStage4 } from './stage4-api.js';
import { createMockLLMService } from '../../services/llm-service.js';
import type { PipelineContext } from '../../../types/pipeline.js';

// openlore: {"domain":"generator","requirement":"Structural Inventory Authority","scenario":"The LLM returns a route not present in the route inventory","specFile":"openspec/specs/generator/spec.md"}
describe('runStage4', () => {
  it('aggregates a domain and emits only inventory-backed endpoint identities', async () => {
    const { service, provider } = createMockLLMService();
    provider.setDefaultResponse(JSON.stringify([
      { method: 'GET', path: '/invoices', purpose: 'list', scenarios: [] },
      { method: 'GET', path: '/invoice', purpose: 'prefix collision', scenarios: [] },
      { method: 'DELETE', path: '/invented', purpose: 'invented', scenarios: [] },
    ]));
    const pipeline: PipelineContext = {
      llm: service, options: { saveIntermediate: false, chunkMaxChars: 8_000 }, saveResult: async () => undefined,
      chunkContent: () => [], graphPromptFor: () => null, signaturesFor: () => null, schemasFor: () => null,
      routesFor: path => path === 'src/invoice.ts' ? '- GET /invoices → listInvoices' : '- POST /payments → createPayment',
      generateSubSpecs: async () => [],
    };
    const result = await runStage4(pipeline, [
      { path: 'src/invoice.ts', content: 'router.get("/invoices")' },
      { path: 'src/payment.ts', content: 'router.post("/payments")' },
    ], undefined, () => 'billing');

    expect(provider.callHistory).toHaveLength(1);
    expect(provider.callHistory[0].userPrompt).toContain('=== src/invoice.ts ===');
    expect(provider.callHistory[0].userPrompt).toContain('=== src/payment.ts ===');
    expect(result.data).toEqual([{ method: 'GET', path: '/invoices', purpose: 'list', scenarios: [] }]);
  });
});
