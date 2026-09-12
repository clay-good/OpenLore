import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dispatchTool, redactSourceToolResult, SOURCE_CARRYING_TOOLS } from './tool-dispatch.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Source-carrying tools that do NOT stamp REPO_CONTENT_PROVENANCE — the ones whose
 * membership can only be asserted by hand, because there is no marker in the source
 * to derive it from. Everything that DOES stamp is derived below, so the blind spot
 * that let `get_function_skeleton` ship unredacted cannot come back for a stamping
 * tool.
 */
const UNSTAMPED_SOURCE_CARRYING_TOOLS = [
  'find_clones',
  'analyze_env_impact',
  'search_code',
  'explain_retrieval_miss',
];

/**
 * Derive, from the handler sources, the set of tools whose result stamps
 * REPO_CONTENT_PROVENANCE — i.e. the handler itself declares "this payload is
 * repository content". Every one of those MUST route through the redaction boundary.
 *
 * Two static steps, no imports of the handlers themselves:
 *   1. find the exported handler functions whose body contains the stamp;
 *   2. read tool-dispatch.ts's own branch table for the tool names whose branch
 *      calls one of them.
 * Both steps read the files that would have to change for a new source-carrying tool
 * to appear, so the derivation cannot drift silently.
 */
async function toolsStampingRepoContent(): Promise<string[]> {
  const stampingFunctions = new Set<string>();
  for (const file of await sourceFiles(HERE)) {
    const text = await readFile(file, 'utf-8');
    if (!text.includes('REPO_CONTENT_PROVENANCE')) continue;
    let current: string | null = null;
    for (const line of text.split('\n')) {
      const declared = /^export (?:async )?function (\w+)/.exec(line);
      if (declared) current = declared[1];
      // The stamp is written as `provenance:`/`contentSafety:` — either way it attributes
      // the payload to repository content. Attribute it to the enclosing exported handler
      // (private helpers are reached only through one).
      if (current && /:\s*REPO_CONTENT_PROVENANCE\b/.test(line)) stampingFunctions.add(current);
    }
  }

  const dispatch = await readFile(join(HERE, 'tool-dispatch.ts'), 'utf-8');
  const branches = dispatch.split(/\bname === '/).slice(1);
  const tools = new Set<string>();
  for (const branch of branches) {
    const name = branch.slice(0, branch.indexOf("'"));
    for (const fn of stampingFunctions) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(branch)) tools.add(name);
    }
  }
  return [...tools].sort();
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-redaction-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  delete process.env.OPENLORE_UNREDACT_TOOL_OUTPUT;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('source-carrying tool output redaction', () => {
  it('routes every source-carrying tool through the disclosure boundary', async () => {
    const root = await fixtureRoot();
    const secret = `sk-${'r'.repeat(24)}`;

    const stamping = await toolsStampingRepoContent();
    // Non-vacuity: a derivation that finds nothing would pass every assertion below.
    expect(stamping.length).toBeGreaterThan(2);
    // Every tool that declares its payload to be repository content must be redacted.
    for (const tool of stamping) {
      expect([...SOURCE_CARRYING_TOOLS], `${tool} stamps repository content but is not redacted`)
        .toContain(tool);
    }
    // And nothing else may be in the set without being named as a deliberate addition,
    // so the set stays exactly "stamped ∪ hand-listed".
    expect([...SOURCE_CARRYING_TOOLS].sort())
      .toEqual([...new Set([...stamping, ...UNSTAMPED_SOURCE_CARRYING_TOOLS])].sort());

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

  it('does not let repository config disable tool-output redaction', async () => {
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

    expect(result.body).not.toContain(secret);
    expect(result).toHaveProperty('redactions');
  });

  it('honors the explicit operator environment opt-out', async () => {
    const root = await fixtureRoot();
    const secret = `sk-${'o'.repeat(24)}`;
    process.env.OPENLORE_UNREDACT_TOOL_OUTPUT = '1';

    const result = await redactSourceToolResult(
      'get_function_body',
      { body: secret },
      root,
    ) as Record<string, unknown>;

    expect(result.body).toContain(secret);
    expect(result).not.toHaveProperty('redactions');
  });
});
