import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_SCHEMA_KEYWORDS,
  SUPPORTED_SCHEMA_KEYWORDS,
  validateAgainstSchema,
} from './schema-validator.js';
import { TOOL_DEFINITIONS } from '../commands/mcp.js';

describe('size and shape keywords', () => {
  it('enforces string length bounds', () => {
    const schema = { type: 'object', properties: { s: { type: 'string', minLength: 2, maxLength: 4 } } };
    expect(validateAgainstSchema({ s: 'abc' }, schema)).toEqual([]);
    expect(validateAgainstSchema({ s: 'a' }, schema)[0].message).toMatch(/minLength/);
    expect(validateAgainstSchema({ s: 'abcde' }, schema)[0].message).toMatch(/maxLength/);
  });

  it('enforces inclusive numeric bounds', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 3 } } };
    expect(validateAgainstSchema({ n: 1 }, schema)).toEqual([]);
    expect(validateAgainstSchema({ n: 3 }, schema)).toEqual([]);
    expect(validateAgainstSchema({ n: 0 }, schema)[0].message).toMatch(/minimum/);
    expect(validateAgainstSchema({ n: 4 }, schema)[0].message).toMatch(/maximum/);
  });

  it('enforces array item counts without walking an oversized array', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } } },
    };
    expect(validateAgainstSchema({ a: ['x'] }, schema)).toEqual([]);
    expect(validateAgainstSchema({ a: [] }, schema)[0].message).toMatch(/minItems/);
    const tooMany = validateAgainstSchema({ a: ['x', 'y', 'z'] }, schema);
    expect(tooMany).toHaveLength(1);
    expect(tooMany[0].message).toMatch(/maxItems/);
  });

  it('enforces maxProperties and an additionalProperties subschema on an open map', () => {
    const schema = {
      type: 'object',
      properties: { m: { type: 'object', maxProperties: 2, additionalProperties: { type: 'string' } } },
    };
    expect(validateAgainstSchema({ m: { a: 'x', b: 'y' } }, schema)).toEqual([]);
    expect(validateAgainstSchema({ m: { a: 'x', b: 'y', c: 'z' } }, schema)[0].message)
      .toMatch(/maxProperties/);
    expect(validateAgainstSchema({ m: { a: 1 } }, schema)[0].path).toBe('/m/a');
  });

  it('requires exactly one oneOf branch to match', () => {
    const schema = {
      oneOf: [
        { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['eligible'] }, boundary: { type: 'string', minLength: 1 } }, required: ['status', 'boundary'] },
        { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['ineligible'] }, reason: { type: 'string', minLength: 1 } }, required: ['status', 'reason'] },
      ],
    };
    expect(validateAgainstSchema({ status: 'eligible', boundary: 'x' }, schema)).toEqual([]);
    // Wrong shape for its own branch, and no other branch accepts it.
    expect(validateAgainstSchema({ status: 'eligible' }, schema)[0].message).toMatch(/exactly one/);
    expect(validateAgainstSchema({ status: 'nonsense' }, schema)[0].message).toMatch(/exactly one/);
    // A failing branch must not leak its own diagnostics into the result.
    expect(validateAgainstSchema({ status: 'eligible' }, schema)).toHaveLength(1);
  });
});

/**
 * The systemic guard (same style as doc-claim-sync.test.ts): this validator is the
 * ONLY inbound check on MCP tool arguments, so a tool schema that declares a
 * keyword it does not implement advertises a bound nothing enforces. Catch that at
 * CI time rather than in an incident.
 */
describe('every MCP tool schema stays inside the validated subset', () => {
  function keywordsIn(schema: unknown, out: Set<string>): void {
    if (!schema || typeof schema !== 'object') return;
    if (Array.isArray(schema)) {
      for (const item of schema) keywordsIn(item, out);
      return;
    }
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      out.add(key);
      // Recurse only into positions that hold SUBSCHEMAS. `properties` holds a map of
      // them (its own keys are property names, not keywords), and the rest hold one
      // schema or an array of them.
      if (key === 'properties') {
        for (const sub of Object.values(value as Record<string, unknown>)) keywordsIn(sub, out);
      } else if (key === 'items' || key === 'oneOf' || key === 'additionalProperties') {
        keywordsIn(value, out);
      }
    }
  }

  it('declares no keyword the validator silently ignores', () => {
    const known = new Set([...SUPPORTED_SCHEMA_KEYWORDS, ...ANNOTATION_SCHEMA_KEYWORDS]);
    const offenders: string[] = [];
    for (const tool of TOOL_DEFINITIONS) {
      const used = new Set<string>();
      keywordsIn((tool as { inputSchema?: unknown }).inputSchema, used);
      for (const keyword of used) {
        if (!known.has(keyword)) offenders.push(`${tool.name}: ${keyword}`);
      }
    }
    expect(offenders, 'implement the keyword in schema-validator.ts, or drop it from the schema').toEqual([]);
  });

  it('is non-vacuous: the surface really does declare enforced bounds', () => {
    const used = new Set<string>();
    for (const tool of TOOL_DEFINITIONS) keywordsIn((tool as { inputSchema?: unknown }).inputSchema, used);
    for (const keyword of ['maxLength', 'minLength', 'maxItems', 'minimum', 'maximum', 'oneOf']) {
      expect(used.has(keyword), keyword).toBe(true);
    }
  });
});
