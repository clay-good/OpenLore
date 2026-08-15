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

  it('admits a real route whose method case or path-parameter syntax differs from the inventory', async () => {
    // The join keeps FABRICATED endpoints out. Rejecting `get` for `GET`, or
    // `/users/{id}` for `/users/:id`, drops every real endpoint for the domain and
    // leaves a silently empty API spec.
    const { service, provider } = createMockLLMService();
    provider.setDefaultResponse(JSON.stringify([
      { method: 'get', path: '/users/{id}', purpose: 'fetch one', scenarios: [] },
      { method: 'POST', path: '/users/', purpose: 'create', scenarios: [] },
    ]));
    const pipeline: PipelineContext = {
      llm: service, options: { saveIntermediate: false, chunkMaxChars: 8_000 }, saveResult: async () => undefined,
      chunkContent: () => [], graphPromptFor: () => null, signaturesFor: () => null, schemasFor: () => null,
      routesFor: () => '- GET /users/:id → getUser\n- post /users → createUser',
      generateSubSpecs: async () => [],
    };
    const result = await runStage4(pipeline, [{ path: 'src/user.ts', content: 'router.get("/users/:id")' }], undefined, () => 'users');
    expect(result.data?.map(endpoint => `${endpoint.method} ${endpoint.path}`))
      .toEqual(['GET /users/:id', 'POST /users']);
  });

  it('discloses dropped endpoints instead of returning a silently empty API spec', async () => {
    const { service, provider } = createMockLLMService();
    provider.setDefaultResponse(JSON.stringify([{ method: 'DELETE', path: '/invented', purpose: 'x', scenarios: [] }]));
    const warnings: string[] = [];
    const { default: logger } = await import('../../../utils/logger.js');
    const original = logger.warning;
    logger.warning = (message: string) => { warnings.push(message); };
    try {
      const pipeline: PipelineContext = {
        llm: service, options: { saveIntermediate: false, chunkMaxChars: 8_000 }, saveResult: async () => undefined,
        chunkContent: () => [], graphPromptFor: () => null, signaturesFor: () => null, schemasFor: () => null,
        routesFor: () => '- GET /real → real',
        generateSubSpecs: async () => [],
      };
      const result = await runStage4(pipeline, [{ path: 'src/a.ts', content: '' }], undefined, () => 'billing');
      expect(result.data).toEqual([]);
    } finally {
      logger.warning = original;
    }
    expect(warnings.join('\n')).toContain('DELETE /invented');
  });
});
