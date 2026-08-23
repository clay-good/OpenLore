import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchTool, redactSourceToolResult, SOURCE_CARRYING_TOOLS } from './tool-dispatch.js';

const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-redaction-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('source-carrying tool output redaction', () => {
  it('routes every source-carrying tool through the disclosure boundary', async () => {
    const root = await fixtureRoot();
    const secret = `sk-${'r'.repeat(24)}`;

    expect([...SOURCE_CARRYING_TOOLS]).toEqual([
      'get_function_body',
      'find_clones',
      'analyze_env_impact',
      'search_code',
      'explain_retrieval_miss',
      'prepare_spec_generation',
      'prepare_spec_repair',
    ]);
    for (const tool of SOURCE_CARRYING_TOOLS) {
      const result = await redactSourceToolResult(tool, { source: secret }, root) as Record<string, unknown>;
      expect(JSON.stringify(result), tool).not.toContain(secret);
      expect(result.redactions, tool).toEqual({ count: 1, kinds: ['api-key'] });
    }
  });

  it('redacts a function body once and discloses the kind', async () => {
    const root = await fixtureRoot();
    const secret = `sk-${'a'.repeat(24)}`;
    await writeFile(join(root, 'auth.ts'), `export function auth() {\n  const api_key = "${secret}";\n}\n`);

    const result = await dispatchTool('get_function_body', {
      directory: root,
      filePath: 'auth.ts',
      functionName: 'auth',
    }, root) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.body).toContain('[REDACTED:secret-field]');
    expect(result.redactions).toEqual({ count: 1, kinds: ['secret-field'] });
  });

  it('redacts source text nested inside a focused slice', async () => {
    const root = await fixtureRoot();
    const secret = `sk-${'s'.repeat(24)}`;
    const result = await redactSourceToolResult('get_function_body', {
      focus: 'token',
      slice: [{ line: 9, text: `const token = "${secret}";`, precision: 'exact' }],
    }, root) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.redactions).toEqual({ count: 1, kinds: ['secret-field'] });
  });

  it('honors the trusted-solo config opt-out without a false disclosure', async () => {
    const root = await fixtureRoot();
    const secret = `sk-${'b'.repeat(24)}`;
    await writeFile(join(root, 'auth.ts'), `export function auth() {\n  return "${secret}";\n}\n`);
    await mkdir(join(root, '.openlore'));
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0',
      projectType: 'nodejs',
      openspecPath: './openspec',
      analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
      generation: { domains: 'auto' },
      secretRedaction: { toolOutput: false },
      createdAt: '2026-08-09T00:00:00.000Z',
      lastRun: null,
    }));

    const result = await dispatchTool('get_function_body', {
      directory: root,
      filePath: 'auth.ts',
      functionName: 'auth',
    }, root) as Record<string, unknown>;

    expect(result.body).toContain(secret);
    expect(result).not.toHaveProperty('redactions');
  });
});
