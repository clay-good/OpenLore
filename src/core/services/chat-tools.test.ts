/**
 * Tests for chat-tools.ts pure utilities and registry structure.
 *
 * The execute() methods delegate to MCP handlers and are tested via
 * mcp-handler tests. These tests cover the tool registry shape and
 * the toChatToolDefinitions() conversion helper.
 */

import { describe, it, expect, vi } from 'vitest';

const { dispatchToolMock } = vi.hoisted(() => ({
  dispatchToolMock: vi.fn(),
}));

vi.mock('./tool-dispatch.js', () => ({
  dispatchTool: dispatchToolMock,
}));
import { CHAT_TOOLS, toChatToolDefinitions } from './chat-tools.js';

// ============================================================================
// TOOL REGISTRY SHAPE
// ============================================================================

describe('CHAT_TOOLS registry', () => {
  it('should export a non-empty array of tools', () => {
    expect(Array.isArray(CHAT_TOOLS)).toBe(true);
    expect(CHAT_TOOLS.length).toBeGreaterThan(0);
  });

  it('should have unique tool names', () => {
    const names = CHAT_TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool should have required fields', () => {
    for (const tool of CHAT_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.inputSchema).toBe('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('every tool inputSchema should require "directory"', () => {
    for (const tool of CHAT_TOOLS) {
      const schema = tool.inputSchema as { required?: string[] };
      expect(schema.required).toContain('directory');
    }
  });

  it('should contain expected tool names', () => {
    const names = new Set(CHAT_TOOLS.map(t => t.name));
    expect(names.has('get_architecture_overview')).toBe(true);
    expect(names.has('get_call_graph')).toBe(true);
    expect(names.has('get_subgraph')).toBe(true);
    expect(names.has('analyze_impact')).toBe(true);
    expect(names.has('get_critical_hubs')).toBe(true);
    expect(names.has('get_god_functions')).toBe(true);
    expect(names.has('search_code')).toBe(true);
    expect(names.has('search_specs')).toBe(true); // list_spec_domains is subsumed: omit query to list domains
    expect(names.has('get_refactor_report')).toBe(true);
    expect(names.has('suggest_insertion_points')).toBe(true);
  });

  it('routes diagram-chat code search through shared dispatch', async () => {
    const secret = `sk-${'c'.repeat(24)}`;
    dispatchToolMock.mockResolvedValue({
      results: [{ filePath: 'src/auth.ts', source: '[REDACTED:api-key]' }],
      redactions: { count: 1, kinds: ['api-key'] },
    });
    const search = CHAT_TOOLS.find(tool => tool.name === 'search_code');
    const output = await search!.execute('/repo', { directory: '/repo', query: secret, limit: 3 });

    expect(dispatchToolMock).toHaveBeenCalledWith('search_code', {
      directory: '/repo', query: secret, limit: 3,
    }, '/repo');
    expect(JSON.stringify(output.result)).not.toContain(secret);
    expect(output.result).toHaveProperty('redactions');
  });
});

// ============================================================================
// toChatToolDefinitions
// ============================================================================

describe('toChatToolDefinitions', () => {
  it('should return an array with the same length as CHAT_TOOLS', () => {
    const defs = toChatToolDefinitions();
    expect(defs.length).toBe(CHAT_TOOLS.length);
  });

  it('should produce OpenAI function-calling format', () => {
    const defs = toChatToolDefinitions();
    for (const def of defs) {
      expect(def.type).toBe('function');
      expect(typeof def.function.name).toBe('string');
      expect(typeof def.function.description).toBe('string');
      expect(typeof def.function.parameters).toBe('object');
    }
  });

  it('should preserve tool names in order', () => {
    const defs = toChatToolDefinitions();
    for (let i = 0; i < CHAT_TOOLS.length; i++) {
      expect(defs[i].function.name).toBe(CHAT_TOOLS[i].name);
    }
  });

  it('should preserve inputSchema as parameters', () => {
    const defs = toChatToolDefinitions();
    for (let i = 0; i < CHAT_TOOLS.length; i++) {
      expect(defs[i].function.parameters).toBe(CHAT_TOOLS[i].inputSchema);
    }
  });
});
