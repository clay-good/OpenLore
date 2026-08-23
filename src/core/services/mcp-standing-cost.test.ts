import { describe, expect, it, vi } from 'vitest';
import {
  STANDING_CONTEXT_TOKENIZER,
  assertStandingContextBudget,
  buildToolListPayload,
  measureStandingContextTokens,
  serializeToolListPayload,
} from './mcp-standing-cost.js';

const TOOL = {
  name: 'inspect',
  description: 'Inspect one symbol.',
  inputSchema: {
    type: 'object',
    properties: { symbol: { type: 'string' } },
  },
};

describe('MCP standing context cost', () => {
  it('uses the declared, version-pinned offline approximation', () => {
    expect(STANDING_CONTEXT_TOKENIZER).toBe('utf8-bytes-div-4-v1');
    const payload = buildToolListPayload([TOOL], () => ({ readOnlyHint: true }));
    expect(measureStandingContextTokens(payload)).toBe(
      Math.ceil(Buffer.byteLength(serializeToolListPayload(payload), 'utf8') / 4),
    );
  });

  it('serializes the exact served tool fields, including annotations and output schemas', () => {
    const toolWithTransportFields = {
      ...TOOL,
      outputSchema: { type: 'object' },
    };
    const payload = buildToolListPayload([toolWithTransportFields], () => ({ readOnlyHint: true }));
    expect(JSON.parse(serializeToolListPayload(payload))).toEqual({
      tools: [{
        ...toolWithTransportFields,
        annotations: { readOnlyHint: true },
      }],
    });
  });

  it('is byte-stable for repeated measurements, including non-ASCII text', () => {
    const tools = [{ ...TOOL, description: 'Inspect café 🔎.' }];
    const payload = buildToolListPayload(tools, () => ({ readOnlyHint: true }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const measurements = Array.from({ length: 10 }, () => measureStandingContextTokens(payload));
    expect(new Set(measurements)).toEqual(new Set([measurements[0]]));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('reports the preset, measured cost, budget, and review expectation on overflow', () => {
    expect(() => assertStandingContextBudget('navigation', 101, {
      baselineTokens: 100,
      maxTokens: 100,
      rationale: 'Initial measured baseline plus bounded headroom.',
    })).toThrow(
      /navigation.*101.*100.*justification/i,
    );
  });
});
