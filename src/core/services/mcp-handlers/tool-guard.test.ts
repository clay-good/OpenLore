/**
 * Spec-10 — MCP tool response hardening guards.
 */

import { describe, it, expect } from 'vitest';
import {
  validateToolArgs, withToolTimeout, ToolTimeoutError, toolTimeoutMs,
  capOutput, capStructuredResult, classifyToolError,
} from './tool-guard.js';

const schema = {
  type: 'object',
  properties: {
    directory: { type: 'string' },
    depth: { type: 'number' },
  },
  required: ['directory'],
};

describe('validateToolArgs', () => {
  it('enforces dependentRequired pairs before dispatch', () => {
    const schema = {
      type: 'object', properties: { focus: { type: 'string' }, focusKind: { type: 'string' } },
      dependentRequired: { focus: ['focusKind'], focusKind: ['focus'] },
    };
    expect(validateToolArgs({ focus: 'value', focusKind: 'variable' }, schema)).toBeNull();
    expect(validateToolArgs({ focus: 'value' }, schema)).toMatch(/focusKind.*required by focus/);
    expect(validateToolArgs({ focusKind: 'variable' }, schema)).toMatch(/focus.*required by focusKind/);
  });
  it('passes valid args', () => {
    expect(validateToolArgs({ directory: '/p', depth: 2 }, schema)).toBeNull();
    expect(validateToolArgs({ directory: '/p' }, schema)).toBeNull(); // optional omitted
  });
  it('rejects a missing required field', () => {
    expect(validateToolArgs({ depth: 2 }, schema)).toMatch(/directory.*type string.*example: "example"/);
  });
  it('rejects a wrong type', () => {
    expect(validateToolArgs({ directory: 5 }, schema)).toMatch(/directory/);
  });
  it('passes when no schema is declared', () => {
    expect(validateToolArgs({ anything: true }, undefined)).toBeNull();
  });
  it('rejects an unknown top-level property with a deterministic suggestion', () => {
    expect(validateToolArgs({ directory: '/p', depths: 2 }, schema))
      .toBe('unknown property "depths"; did you mean "depth"?');
  });
  it.each(['constructor', 'toString', 'valueOf', '__proto__'])('rejects prototype-named property %s', (key) => {
    const args = JSON.parse(`{"directory":"/p","${key}":true}`) as Record<string, unknown>;
    expect(validateToolArgs(args, schema)).toBe(`unknown property "${key}"`);
  });
  it('bounds hostile unknown keys in the returned error', () => {
    const key = 'x'.repeat(10_000);
    const error = validateToolArgs({ directory: '/p', [key]: true }, schema)!;
    expect(error).toMatch(/^unknown property "/);
    expect(error.length).toBeLessThan(120);
  });
  it('enriches nested missing properties with type and example', () => {
    const nested = {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
      required: ['tasks'],
    };
    expect(validateToolArgs({ tasks: [{}] }, nested)).toMatch(/\/tasks\/0\/id.*type string.*example: "example"/);
  });
});

describe('withToolTimeout', () => {
  it('returns the result when work finishes in time', async () => {
    await expect(withToolTimeout(Promise.resolve('ok'), 'orient', 1000)).resolves.toBe('ok');
  });
  it('rejects with ToolTimeoutError when work hangs', async () => {
    const hang = new Promise<string>(() => {}); // never resolves
    await expect(withToolTimeout(hang, 'find_dead_code', 20)).rejects.toBeInstanceOf(ToolTimeoutError);
  });
  it('toolTimeoutMs uses the per-tool override for slow tools', () => {
    expect(toolTimeoutMs('analyze_codebase')).toBeGreaterThan(toolTimeoutMs('orient'));
  });
});

describe('capOutput', () => {
  it('leaves small output untouched', () => {
    const r = capOutput('hello', 1024);
    expect(r).toEqual({ text: 'hello', truncated: false });
  });
  it('truncates oversized output deterministically with a how-to-narrow note', () => {
    const big = 'x'.repeat(5000);
    const r = capOutput(big, 500);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(500);
    expect(r.text).toMatch(/output truncated/i);
    expect(r.text).toMatch(/narrow the query/i);
    // deterministic
    expect(capOutput(big, 500)).toEqual(r);
  });
});

describe('capStructuredResult', () => {
  it('leaves a within-budget object as pretty JSON, untruncated', () => {
    const r = capStructuredResult({ a: 1, b: 'hi' }, 1024);
    expect(r.truncated).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ a: 1, b: 'hi' });
  });

  it('keeps the result PARSEABLE when truncating a large string field (the get_spec bug)', () => {
    // A naive byte-truncation of the serialized JSON would cut mid-string and break parsing.
    const result = { domain: 'analyzer', specFile: 'openspec/specs/analyzer/spec.md', content: 'x\n'.repeat(200_000) };
    const r = capStructuredResult(result, 256 * 1024);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    const parsed = JSON.parse(r.text) as { domain: string; content: string; truncated: boolean };
    expect(parsed.domain).toBe('analyzer');          // shape preserved
    expect(parsed.truncated).toBe(true);
    expect(parsed.content).toMatch(/truncated/i);     // marker present, still a string
    expect(parsed.content.length).toBeLessThan(result.content.length);
  });

  it('raw-string results still go through capOutput (plain-text tools)', () => {
    const r = capStructuredResult('y'.repeat(5000), 500);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/output truncated/i);
  });

  it('falls back to a valid JSON envelope when there is no dominant string field', () => {
    // A huge array with no big top-level string field — still must stay parseable.
    const result = { items: Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `n${i}` })) };
    const r = capStructuredResult(result, 64 * 1024);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(r.text) as { truncated: boolean; note: string; partial: string };
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.partial).toBe('string');
  });

  it('preserves a redaction receipt when capping a nested source result', () => {
    const redactions = { count: 3, kinds: ['api-key', 'cloud-credential'] };
    const result = {
      results: Array.from({ length: 50_000 }, (_, i) => ({ id: i, source: `[REDACTED:api-key] ${i}` })),
      redactions,
    };
    const r = capStructuredResult(result, 64 * 1024);
    const parsed = JSON.parse(r.text) as { redactions: typeof redactions };

    expect(r.truncated).toBe(true);
    expect(parsed.redactions).toEqual(redactions);
  });

  it('preserves index staleness when a structured result falls back to an envelope', () => {
    const indexStaleness = {
      staleFiles: ['src/payments.ts'],
      note: 'The index is behind the working tree for: src/payments.ts.',
    };
    const result = {
      items: Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `n${i}` })),
      indexStaleness,
    };
    const r = capStructuredResult(result, 64 * 1024);
    const parsed = JSON.parse(r.text) as { indexStaleness: typeof indexStaleness };

    expect(r.truncated).toBe(true);
    expect(parsed.indexStaleness).toEqual(indexStaleness);
  });

  it('preserves test-selection boundary receipts when a result falls back to an envelope', () => {
    const soundness = { posture: 'over-approximate', caveats: ['Backward reachability was truncated at depth 2; deeper tests may exist.'] };
    const result = {
      seeds: Array.from({ length: 50_000 }, (_, i) => ({ name: `symbol${i}`, file: `src/${i}.ts` })),
      truncatedAtDepth: 2,
      soundness,
    };
    const r = capStructuredResult(result, 64 * 1024);
    const parsed = JSON.parse(r.text) as { truncatedAtDepth: number; soundness: typeof soundness };

    expect(r.truncated).toBe(true);
    expect(parsed.truncatedAtDepth).toBe(2);
    expect(parsed.soundness).toEqual(soundness);
  });

  it('bounds preserved staleness metadata when its file list alone exceeds the response cap', () => {
    const staleFiles = Array.from({ length: 200 }, (_, i) => `src/${i}-${'nested/'.repeat(200)}file.ts`);
    const result = {
      items: Array.from({ length: 50_000 }, (_, i) => ({ id: i })),
      indexStaleness: {
        staleFiles,
        note: `The index is behind the working tree for: ${staleFiles.join(', ')}`,
        repairScheduled: true,
      },
    };
    const maxBytes = 4 * 1024;
    const capped = capStructuredResult(result, maxBytes);
    const parsed = JSON.parse(capped.text) as {
      indexStaleness: { staleFiles: string[]; staleFileCount: number; staleFilesOmitted: number; repairScheduled: true };
    };

    expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
    expect(parsed.indexStaleness.staleFileCount).toBe(200);
    expect(parsed.indexStaleness.staleFiles).toHaveLength(1);
    expect(parsed.indexStaleness.staleFilesOmitted).toBe(199);
    expect(parsed.indexStaleness.repairScheduled).toBe(true);
  });
});

describe('classifyToolError', () => {
  it('maps a timeout', () => {
    expect(classifyToolError(new ToolTimeoutError('x', 10))).toBe('TIMEOUT');
  });
  it('maps "not analyzed" actionably', () => {
    expect(classifyToolError(new Error('No analysis found. Run analyze_codebase first.'))).toBe('NOT_ANALYZED');
    expect(classifyToolError(new Error('Call graph DB not available. Re-run analyze_codebase.'))).toBe('NOT_ANALYZED');
  });
  it('maps everything else to INTERNAL', () => {
    expect(classifyToolError(new Error('boom'))).toBe('INTERNAL');
  });
});
