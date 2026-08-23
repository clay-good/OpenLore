import { describe, expect, it, vi } from 'vitest';

vi.mock('./mcp-handlers/retrieval-miss.js', () => ({
  handleExplainRetrievalMiss: vi.fn(async (_directory: string, input: unknown) => ({
    cause: 'outranked',
    input,
  })),
}));

import { TOOL_DEFINITIONS, TOOL_PRESETS, selectActiveTools, toolAnnotations } from '../../cli/commands/mcp.js';
import { handleExplainRetrievalMiss } from './mcp-handlers/retrieval-miss.js';
import { dispatchTool } from './tool-dispatch.js';

describe('explain_retrieval_miss MCP registration', () => {
  it('publishes the strict target schema and read-only navigate annotations', () => {
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === 'explain_retrieval_miss');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['query', 'surface', 'target'],
      properties: {
        surface: { enum: ['code', 'spec'] },
        target: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'value'],
          properties: { kind: { enum: ['symbol', 'file', 'requirement'] } },
        },
      },
    });
    expect(toolAnnotations(tool!.name)).toMatchObject({
      family: 'navigate',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('is full-surface only and does not leak into a curated preset', () => {
    expect(selectActiveTools(TOOL_DEFINITIONS, { preset: 'full' }).map((tool) => tool.name))
      .toContain('explain_retrieval_miss');
    for (const preset of Object.keys(TOOL_PRESETS)) {
      expect(
        selectActiveTools(TOOL_DEFINITIONS, { preset }).map((tool) => tool.name),
        `tool leaked into ${preset}`,
      ).not.toContain('explain_retrieval_miss');
    }
    expect(selectActiveTools(TOOL_DEFINITIONS, {}).map((tool) => tool.name))
      .not.toContain('explain_retrieval_miss');
  });

  it('dispatches the contract fields to the retrieval-miss handler', async () => {
    const target = { kind: 'symbol' as const, value: 'authenticate', filePath: 'src/auth.ts' };
    await dispatchTool('explain_retrieval_miss', {
      directory: '/repo',
      query: 'JWT auth',
      surface: 'code',
      target,
      limit: 7,
      language: 'TypeScript',
      minFanIn: 3,
      ignored: 'not forwarded',
    }, '/repo');

    expect(handleExplainRetrievalMiss).toHaveBeenCalledWith('/repo', {
      query: 'JWT auth',
      surface: 'code',
      target,
      limit: 7,
      language: 'TypeScript',
      minFanIn: 3,
    });
  });
});
