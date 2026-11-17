/**
 * Spec-10 — MCP tool response hardening guards.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOL_DEFINITIONS } from '../../../cli/commands/mcp.js';
import {
  validateToolArgs, exampleToolArguments, invalidArgumentsMessage, checkToolArguments, withToolTimeout, ToolTimeoutError, toolTimeoutMs,
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
  it('rejects a wrong type with the expected type and an example of it', () => {
    expect(validateToolArgs({ directory: 5 }, schema)).toBe('/directory: expected type string, got integer; example: "example"');
    expect(validateToolArgs({ directory: '/p', depth: 'deep' }, schema)).toBe('/depth: expected type number, got string; example: 1');
  });
  it('gives an out-of-enum value an allowed example', () => {
    const enumSchema = { type: 'object', properties: { kind: { type: 'string', enum: ['calls', 'dead'] } } };
    expect(validateToolArgs({ kind: 'nope' }, enumSchema)).toMatch(/\/kind: value "nope" not in enum .*; example: "calls"$/);
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

// change: adopt-mcp-protocol-conformance — validation failures are self-correctable tool errors.
describe('invalidArgumentsMessage', () => {
  const tool = {
    type: 'object',
    properties: {
      directory: { type: 'string' }, functionName: { type: 'string' }, maxDepth: { type: 'number', minimum: 1 },
      kind: { type: 'string', enum: ['calls', 'dead'] },
    },
    required: ['directory', 'functionName', 'maxDepth', 'kind'],
  };
  it('builds a corrected example from every required parameter', () => {
    expect(exampleToolArguments(tool)).toEqual({
      directory: '/absolute/path/to/project', functionName: 'example', maxDepth: 1, kind: 'calls',
    });
    expect(exampleToolArguments(undefined)).toEqual({});
  });
  it('fills nested required properties and minimum array items', () => {
    const nested = {
      type: 'object',
      properties: {
        target: { type: 'object', properties: { kind: { type: 'string', enum: ['file'] }, value: { type: 'string' } }, required: ['kind', 'value'] },
        tasks: { type: 'array', minItems: 1, items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      },
      required: ['target', 'tasks'],
    };
    expect(exampleToolArguments(nested)).toEqual({ target: { kind: 'file', value: 'example' }, tasks: [{ id: 'example' }] });
  });
  it('gives every advertised tool a corrected example that passes its own schema', () => {
    const failing = TOOL_DEFINITIONS
      .filter(t => validateToolArgs(exampleToolArguments(t.inputSchema), t.inputSchema) !== null)
      .map(t => `${t.name}: ${validateToolArgs(exampleToolArguments(t.inputSchema), t.inputSchema)}`);
    expect(failing).toEqual([]);
  });
  it('names the tool, the parameter and its shape, and a call to retry with', () => {
    const detail = validateToolArgs({ directory: '/p', functionName: 'f', maxDepth: 2 }, tool)!;
    expect(invalidArgumentsMessage('get_subgraph', detail, tool)).toBe(
      'Tool error [INVALID_ARGS]: Invalid arguments for "get_subgraph": /kind: missing required property; expected type string; example: "calls". ' +
      'Fix the arguments and call "get_subgraph" again, for example with: ' +
      '{"directory":"/absolute/path/to/project","functionName":"example","maxDepth":1,"kind":"calls"}',
    );
  });
  it('bounds, redacts, and strips terminal controls from echoed caller values', () => {
    const huge = invalidArgumentsMessage('orient', `/rankBy: value "${'x'.repeat(2_000_000)}" not in enum`, {});
    expect(huge.length).toBeLessThan(1_300);
    const secret = invalidArgumentsMessage('orient', '/rankBy: value "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" not in enum', {});
    expect(secret).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(invalidArgumentsMessage('orient', 'unknown property "a\u001b[31mb"', {})).not.toContain('\u001b');
  });
});

describe('checkToolArguments', () => {
  const schema = { type: 'object', properties: { directory: { type: 'string' }, symbol: { type: 'string' } }, required: ['symbol'] };
  const accept = async (d: string) => d || '/launch';
  const fail = async () => { throw new Error('Directory not found: /gone.'); };

  it('passes valid arguments through with the validated directory', async () => {
    await expect(checkToolArguments('t', { symbol: 's', directory: '/p' }, schema, { hadExplicitDirectory: true, validateDirectory: accept }))
      .resolves.toEqual({ ok: true, directory: '/p' });
  });
  it('returns a schema rejection as an isError result, never a thrown protocol error', async () => {
    const checked = await checkToolArguments('t', { directory: '/p' }, schema, { hadExplicitDirectory: true, validateDirectory: accept });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.result.isError).toBe(true);
    expect(checked.result.content[0].text).toMatch(/^Tool error \[INVALID_ARGS\]: Invalid arguments for "t": \/symbol: missing required property/);
  });
  it('gives a bad directory an example that includes a directory, with no doubled period', async () => {
    const checked = await checkToolArguments('t', { symbol: 's' }, schema, { hadExplicitDirectory: false, validateDirectory: fail });
    if (checked.ok) throw new Error('expected a rejection');
    const text = checked.result.content[0].text;
    expect(text).toContain('launch root could not be used');
    expect(text).toContain('for example with: {"symbol":"example","directory":"/absolute/path/to/project"}');
    expect(text).not.toContain('..');
  });
  it('is the only argument gate in the MCP CallTool handler, which throws no protocol error for it', () => {
    const source = readFileSync(new URL('../../../cli/commands/mcp.ts', import.meta.url), 'utf-8');
    expect(source).toContain('await checkToolArguments(name, args, toolDef.inputSchema,');
    expect(source).toContain('if (!checked.ok) return checked.result;');
    expect(source).not.toMatch(/new McpError\(/);
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

describe('capStructuredResult — the MCP response is screened', () => {
  const ESC = String.fromCharCode(27);

  it('removes bidi overrides and zero-width characters a repository put in a path', () => {
    // These leaked raw into orient / search_code / get_subgraph / find_path / find_dead_code /
    // get_map responses. Only the STRING branch of this function screened anything, and ESC
    // looked handled because JSON.stringify escapes it by itself — so nobody noticed that the
    // rest of the class passes through verbatim.
    const result = { relevantFunctions: [{ name: 'evil\u200bFn', filePath: 'src/\u202eesc.ts' }] };
    const text = capStructuredResult(result, 64 * 1024).text;

    expect(text).not.toContain('\u202e');
    expect(text).not.toContain('\u200b');
    const parsed = JSON.parse(text) as { relevantFunctions: { name: string; filePath: string }[] };
    expect(parsed.relevantFunctions[0]).toEqual({ name: 'evilFn', filePath: 'src/esc.ts' });
  });

  it('screens the values, so a consumer that parses the response does not get ESC back', () => {
    // JSON.stringify turns a real ESC into the six characters \\u001b: a text-only pass has
    // nothing left to remove, and the control character reappears the moment the document is
    // parsed. Screening runs at the values for exactly this reason.
    const text = capStructuredResult({ filePath: `src/zz${ESC}[2K${ESC}[1GFAKE.ts` }, 64 * 1024).text;
    expect(text).not.toContain('u001b');
    const parsed = JSON.parse(text) as { filePath: string };
    expect(parsed.filePath).toBe('src/zzFAKE.ts');
    expect(parsed.filePath).not.toContain(ESC);
  });

  it('keeps legitimate non-ASCII in a path', () => {
    const file = 'src/spåce dir ünicode/日本語/🙈.ts';
    const parsed = JSON.parse(capStructuredResult({ file }, 64 * 1024).text) as { file: string };
    expect(parsed.file).toBe(file);
  });

  it('still screens a plain string result', () => {
    expect(capStructuredResult(`a${ESC}[31mb`, 1024).text).toBe('ab');
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

  it('shortens a long list instead of discarding the answer, with an exact dropped count', () => {
    // A whole-repository answer is a summary plus ranked arrays. Keeping the top of the list and
    // saying how many were dropped is usable; a JSON string cut mid-structure is not
    // (change: fix-whole-repo-answers-under-budget).
    const result = { summary: { total: 50_000 }, items: Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `n${i}` })) };
    const r = capStructuredResult(result, 64 * 1024);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(r.text) as {
      summary: { total: number }; items: Array<{ id: number }>;
      responseBudget?: { trimmed: boolean; omitted: Record<string, number> }; partial?: string;
    };
    expect(parsed.partial).toBeUndefined();
    expect(parsed.summary).toEqual({ total: 50_000 });
    expect(parsed.items.length).toBeGreaterThan(0);
    // The ranked prefix is what is kept, in order.
    expect(parsed.items[0].id).toBe(0);
    expect(parsed.items.map(i => i.id)).toEqual(parsed.items.map((_, i) => i));
    // And the count is exact.
    expect(parsed.responseBudget?.omitted.items).toBe(50_000 - parsed.items.length);
  });

  it('bounds every list, each with its own dropped count', () => {
    const result = {
      big: Array.from({ length: 20_000 }, (_, i) => ({ id: i, pad: 'x'.repeat(40) })),
      small: Array.from({ length: 2_000 }, (_, i) => ({ id: i })),
    };
    const r = capStructuredResult(result, 32 * 1024);
    const parsed = JSON.parse(r.text) as {
      big: unknown[]; small: unknown[];
      responseBudget: { omitted: Record<string, number> };
    };
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    for (const key of Object.keys(parsed.responseBudget.omitted)) {
      const kept = (parsed[key as 'big' | 'small'] as unknown[]).length;
      const total = key === 'big' ? 20_000 : 2_000;
      expect(parsed.responseBudget.omitted[key]).toBe(total - kept);
    }
    // Both lists are served. The growth loop used to run largest-first with every other list
    // still at zero, so the big list took the whole budget and `small` came back EMPTY.
    expect(parsed.small.length).toBeGreaterThan(0);
    expect(parsed.big.length).toBeGreaterThan(0);
  });

  // A fair share per list, not first-come. On a `get_mapping` answer, 1,549 `linked` rows used
  // the whole 256 KB and the `ambiguous` / `stale` / `unmapped` lanes the tool exists to
  // surface were all served empty (change: fix-budget-trim-allocation).
  it('serves the short lists whole and bounds the dominant list', () => {
    const row = (i: number) => ({ requirement: `Req${i}`, domain: 'd', specFile: 'openspec/specs/d/spec.md', anchors: [{ raw: `sym${i}::src/f.ts` }] });
    const result = {
      stats: { totalRequirements: 40_000 },
      linked: Array.from({ length: 40_000 }, (_, i) => row(i)),
      unmapped: Array.from({ length: 12 }, (_, i) => row(i)),
      ambiguous: Array.from({ length: 7 }, (_, i) => row(i)),
      stale: Array.from({ length: 5 }, (_, i) => row(i)),
    };
    const parsed = JSON.parse(capStructuredResult(result, 256 * 1024).text) as {
      linked: unknown[]; unmapped: unknown[]; ambiguous: unknown[]; stale: unknown[];
      responseBudget: { omitted: Record<string, number> };
    };
    expect(parsed.unmapped.length).toBe(12);
    expect(parsed.ambiguous.length).toBe(7);
    expect(parsed.stale.length).toBe(5);
    expect(parsed.linked.length).toBeGreaterThan(0);
    // Only the dominant list paid.
    expect(Object.keys(parsed.responseBudget.omitted)).toEqual(['linked']);
  });

  it('gives eight equal lists a share each rather than all of it to the first', () => {
    const lists = Object.fromEntries(
      Array.from({ length: 8 }, (_, k) => [`list${k}`, Array.from({ length: 20_000 }, (_, i) => ({ id: i, pad: 'y'.repeat(30) }))]),
    );
    const parsed = JSON.parse(capStructuredResult(lists, 256 * 1024).text) as Record<string, unknown[]>;
    for (let k = 0; k < 8; k++) expect(parsed[`list${k}`].length).toBeGreaterThan(0);
  });

  // The receipt used to be written as top-level `truncated` / `omitted` / `truncationNote`,
  // which overwrote payloads that already define them.
  it("never overwrites the tool's own omitted disclosure", () => {
    const result = {
      summary: { files: 1_478 },
      clusters: Array.from({ length: 2_000 }, (_, i) => ({ id: i, files: Array.from({ length: 20 }, (_, j) => `src/f${i}_${j}.ts`) })),
      omitted: ['hubs', 'entryPoints', 'godFunctions', 'layers', 'cycles'],
      omittedBecause: 'they are derived from the call graph, which this first build has not produced yet',
    };
    const parsed = JSON.parse(capStructuredResult(result, 60_000).text) as {
      omitted: string[]; omittedBecause: string; responseBudget: { omitted: Record<string, number> };
    };
    expect(parsed.omitted).toEqual(['hubs', 'entryPoints', 'godFunctions', 'layers', 'cycles']);
    expect(parsed.omittedBecause).toContain('first build has not produced');
    expect(parsed.responseBudget.omitted.clusters).toBeGreaterThan(0);
  });

  // The string-cut branch is tried BEFORE list trimming, and it kept writing a top-level
  // `truncated: true` — the very collision the list branch was fixed for, 70 lines up in the
  // same file (change: fix-budget-receipt-collision).
  it("never overwrites the tool's own truncated object when cutting a dominant string", () => {
    const result = {
      truncated: { limit: 5_000, atPath: 'src/huge' },
      report: 'x'.repeat(5_000),
      summary: 'ok',
    };
    const parsed = JSON.parse(capStructuredResult(result, 1_200).text) as {
      truncated: { limit: number; atPath: string };
      summary: string;
      responseBudget: { trimmed: boolean };
    };
    expect(parsed.truncated).toEqual({ limit: 5_000, atPath: 'src/huge' });
    expect(parsed.summary).toBe('ok');
    expect(parsed.responseBudget.trimmed).toBe(true);
  });

  it("never overwrites the tool's own truncated object", () => {
    const result = {
      changes: Array.from({ length: 5_000 }, (_, i) => ({ symbol: `s${i}`, verdict: 'breaking', detail: 'x'.repeat(60) })),
      truncated: { omitted: 1_200 },
    };
    const parsed = JSON.parse(capStructuredResult(result, 60_000).text) as {
      truncated: { omitted: number }; responseBudget: { omitted: Record<string, number> };
    };
    expect(parsed.truncated).toEqual({ omitted: 1_200 });
    expect(parsed.responseBudget.omitted.changes).toBeGreaterThan(0);
  });

  it('still falls back to the partial envelope when the non-list part alone is over budget', () => {
    // Nothing to shrink: the summary itself does not fit, so a cut partial is the honest answer.
    const result = { summary: { blob: Array.from({ length: 4_000 }, (_, i) => `field-${i}`) }, items: [{ id: 1 }] };
    const r = capStructuredResult(result, 2 * 1024);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(2 * 1024);
    const parsed = JSON.parse(r.text) as { truncated: boolean; partial?: string };
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.partial).toBe('string');
  });

  it('is deterministic: the same oversized result trims identically every time', () => {
    const result = {
      a: Array.from({ length: 5_000 }, (_, i) => ({ id: i, pad: 'y'.repeat(20) })),
      b: Array.from({ length: 5_000 }, (_, i) => ({ id: i, pad: 'z'.repeat(20) })),
    };
    const one = capStructuredResult(result, 48 * 1024);
    const two = capStructuredResult(result, 48 * 1024);
    expect(one.text).toBe(two.text);
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

  // The truncation search used to re-serialize the ENTIRE result on every binary-search
  // probe. It now computes the fitting cut from JSON-escaped byte prefix sums, so these
  // pin that the arithmetic is exact for every character class JSON escapes differently.
  // (change: optimize-serving-hot-path-caches)
  describe('the truncation cut is byte-exact for every JSON escape class', () => {
    const classes: Array<[string, string]> = [
      ['ascii',            'a'],
      ['quote',            '"'],
      ['backslash',        '\\'],
      ['short control',    '\n'],
      // A \uXXXX-escaped control character (the 'long control' class) is no longer reachable
      // here: values are screened before they are capped, so a C0 control never survives to be
      // measured. The class above covers the escape arithmetic that is still live.
      ['two-byte utf-8',   'é'],
      ['three-byte utf-8', '☃'],
      ['astral pair',      '😀'],
      ['lone surrogate',   '\ud800'],
    ];

    for (const [label, ch] of classes) {
      it(`stays within budget and stays parseable: ${label}`, () => {
        const field = ch.repeat(20_000);
        for (const maxBytes of [512, 1_024, 4_096]) {
          const capped = capStructuredResult({ kind: 'x', body: field }, maxBytes);
          expect(capped.truncated).toBe(true);
          expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(maxBytes);
          expect(() => JSON.parse(capped.text)).not.toThrow();
        }
      });

      it(`keeps as much as fits: ${label}`, () => {
        // The cut is maximal, not merely safe: one more code point overflows the budget.
        const marker = '\n\n…[truncated — this field exceeded the response byte budget; narrow the query]';
        const field = ch.repeat(20_000);
        const maxBytes = 2_048;
        const capped = capStructuredResult({ kind: 'x', body: field }, maxBytes);
        const kept = (JSON.parse(capped.text) as { body: string }).body;
        const keptField = kept.slice(0, kept.length - marker.length);
        const oneMore = keptField + ch;
        const overflowing = JSON.stringify({ kind: 'x', body: oneMore + marker, truncated: true }, null, 2);
        expect(Buffer.byteLength(overflowing, 'utf8')).toBeGreaterThan(maxBytes);
      });
    }

    it('never splits an astral character in half', () => {
      const capped = capStructuredResult({ kind: 'x', body: '😀'.repeat(2_000) }, 700);
      const body = (JSON.parse(capped.text) as { body: string }).body;
      const emoji = body.slice(0, body.indexOf('\n\n…'));
      expect([...emoji].every((c) => c === '😀')).toBe(true);
      expect(emoji.length % 2).toBe(0);
    });

    it('falls back to the envelope when the shell leaves no room for the field', () => {
      // 320 bytes is below the truncated-field shape's own floor (the marker alone is
      // ~90 bytes) but above the envelope's, so the envelope path takes over.
      const capped = capStructuredResult({ kind: 'x', body: 'z'.repeat(5_000) }, 320);
      expect(capped.truncated).toBe(true);
      expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(320);
      expect(() => JSON.parse(capped.text)).not.toThrow();
    });

    it('a budget below even the envelope’s own floor still yields valid JSON', () => {
      // Pre-existing, unchanged behaviour: the envelope's explanatory note cannot be
      // shrunk, so a pathological budget is exceeded rather than producing torn output.
      const capped = capStructuredResult({ kind: 'x', body: 'z'.repeat(5_000) }, 64);
      expect(capped.truncated).toBe(true);
      expect(() => JSON.parse(capped.text)).not.toThrow();
    });
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
