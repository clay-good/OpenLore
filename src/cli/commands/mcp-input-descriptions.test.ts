/**
 * mcp-quality "Complete Input Schemas": every property an agent can pass has a description. A
 * property without one makes the agent guess the argument from its name.
 */
import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from './mcp.js';

interface Schema { type?: string; description?: string; properties?: Record<string, Schema>; items?: Schema }

/** Every property path under `schema` with no description: nested objects and array items included. */
function undescribed(schema: Schema | undefined, path: string): string[] {
  const out: string[] = [];
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    if (!prop.description) out.push(`${path}${name}`);
    out.push(...undescribed(prop, `${path}${name}.`));
    if (prop.items) out.push(...undescribed(prop.items, `${path}${name}[].`));
  }
  return out;
}

describe('MCP tool input descriptions', () => {
  it('every input property of every tool has a description', () => {
    const missing = TOOL_DEFINITIONS.flatMap(tool => undescribed(tool.inputSchema as unknown as Schema, `${tool.name}.`));
    expect(missing).toEqual([]);
  });

  it('the check sees nested and array-item properties', () => {
    const schema: Schema = { properties: { a: { description: 'a', properties: { b: {} } }, c: { description: 'c', items: { properties: { d: {} } } } } };
    expect(undescribed(schema, 't.')).toEqual(['t.a.b', 't.c[].d']);
  });
});
