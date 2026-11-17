import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { issueLeaseToken, checkLease, servedForLease } from './lease-tokens.js';
import { verifyGraphClaim } from './mcp-handlers/claim-kinds-graph.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../constants.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const write = (root: string, rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };

const CONFIG = 'export function parseConfig(s: string) {\n  return JSON.parse(s);\n}\n\nexport function loadDefaults() {\n  return { a: "x  y" };\n}\n';

/** Index nodes with the spans the analyzer records (character offsets into the file). */
function index(root: string, file: string, text: string, names: string[]): void {
  const nodes = names.map(name => {
    const start = text.indexOf(`function ${name}`) >= 0 ? text.indexOf(`export function ${name}`) : text.indexOf(name);
    const end = text.indexOf('\n}\n', start) + 2;
    return { id: `${file}::${name}`, name, filePath: file, startIndex: start, endIndex: end, startLine: text.slice(0, start).split('\n').length, endLine: 0, language: 'TypeScript' };
  });
  write(root, join(OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges: [] } }));
}

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ollease-')));
  dirs.push(root);
  write(root, 'src/config.ts', CONFIG);
  write(root, 'openspec/specs/config/spec.md', '# Config\n\nParsing rules.\n');
  index(root, 'src/config.ts', CONFIG, ['parseConfig', 'loadDefaults']);
  return root;
}
const served = [{ file: 'src/config.ts', name: 'parseConfig', startLine: 1 }, { file: 'openspec/specs/config/spec.md' }];
type R = { verdict: string; reason: string; receipt?: { changed: Array<{ name?: string; file: string; why: string }>; notCovered?: string[] } };
const lease = async (root: string, token: string) => (await verifyGraphClaim(root, 'lease-current', token)) as R;
const tokenFile = (root: string, token: string) => join(root, '.openlore', 'session-ledger', 'tokens', `${token}.json`);

describe('lease tokens', () => {
  it('a token is current until a served function changes; then it names it', async () => {
    const root = repo();
    const token = (await issueLeaseToken(root, served))!;
    expect(token).toMatch(/^lt_[0-9a-f]{20}$/);
    expect((await lease(root, token)).verdict).toBe('confirmed');
    write(root, 'src/config.ts', CONFIG.replace('JSON.parse(s)', 'JSON.parse(s.trim())'));
    const r = await lease(root, token);
    expect(r.verdict).toBe('refuted');
    expect(r.receipt?.changed).toEqual([{ file: 'src/config.ts', name: 'parseConfig', why: 'changed' }]);
  });

  it('an edit to an unserved function, or above the served one, keeps the lease current', async () => {
    const root = repo();
    const token = (await issueLeaseToken(root, served))!;
    write(root, 'src/config.ts', `import x from "y";\n\n${CONFIG.replace('a: "x  y"', 'a: 2')}`);
    expect((await lease(root, token)).verdict).toBe('confirmed');
  });

  it('whitespace inside a served function is a change (indentation and string contents carry meaning)', async () => {
    const root = repo();
    const token = (await issueLeaseToken(root, [{ file: 'src/config.ts', name: 'loadDefaults' }]))!;
    write(root, 'src/config.ts', CONFIG.replace('"x  y"', '"x y"'));
    expect((await lease(root, token)).verdict).toBe('refuted');
  });

  it('a whole Markdown file: reformat is no change, a content edit is; a deleted file is removed', async () => {
    const root = repo();
    const token = (await issueLeaseToken(root, served))!;
    write(root, 'openspec/specs/config/spec.md', '# Config\n\n  Parsing   rules.\n\n');
    expect((await lease(root, token)).verdict).toBe('confirmed');
    write(root, 'openspec/specs/config/spec.md', '# Config\n\nNew rules.\n');
    rmSync(join(root, 'src/config.ts'));
    expect((await lease(root, token)).receipt?.changed).toEqual(expect.arrayContaining([
      { file: 'openspec/specs/config/spec.md', why: 'changed' },
      { file: 'src/config.ts', name: 'parseConfig', why: 'removed' },
    ]));
  });

  it('a served name the index cannot locate is not covered, and never refutes at file level', async () => {
    const root = repo();
    const token = (await issueLeaseToken(root, [...served, { file: 'src/config.ts', name: 'ConfigService' }]))!;
    write(root, 'src/config.ts', CONFIG.replace('a: "x  y"', 'a: 3'));
    const r = await lease(root, token);
    expect(r.verdict).toBe('confirmed');
    expect(r.receipt?.notCovered).toEqual(['ConfigService (src/config.ts)']);
    expect(r.reason).toContain('could not locate');
  });

  it('same-named functions are told apart by their start line', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ollease-twin-')));
    dirs.push(root);
    const text = 'export function load() {\n  return 1;\n}\nexport function load() {\n  return 2;\n}\n';
    write(root, 'src/t.ts', text);
    const nodes = [
      { id: 'a', name: 'load', filePath: 'src/t.ts', startIndex: 0, endIndex: 37, startLine: 1 },
      { id: 'b', name: 'load', filePath: 'src/t.ts', startIndex: 38, endIndex: 75, startLine: 4 },
    ];
    write(root, join(OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges: [] } }));
    const token = (await issueLeaseToken(root, [{ file: 'src/t.ts', name: 'load', startLine: 1 }]))!;
    write(root, 'src/t.ts', text.replace('return 2', 'return 3'));
    expect((await lease(root, token)).verdict).toBe('confirmed');
  });

  it('an unreadable file is unverifiable, not "removed"', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = repo();
    const token = (await issueLeaseToken(root, served))!;
    chmodSync(join(root, 'src/config.ts'), 0o000);
    try {
      expect((await lease(root, token)).verdict).toBe('unverifiable');
    } finally {
      chmodSync(join(root, 'src/config.ts'), 0o644);
    }
  });

  it('unknown, malformed, crafted, future, and expired tokens are unverifiable', async () => {
    const root = repo();
    expect((await lease(root, 'lt_00000000000000000000')).verdict).toBe('unverifiable');
    expect((await lease(root, '../../etc/passwd')).verdict).toBe('unverifiable');
    const token = (await issueLeaseToken(root, served))!;
    const rec = JSON.parse(readFileSync(tokenFile(root, token), 'utf-8'));
    writeFileSync(tokenFile(root, token), JSON.stringify({ ...rec, entries: [...rec.entries, { file: 'src/config.ts', name: 'ghost' }] }));
    expect((await checkLease(root, token)).status).toBe('unknown');
    writeFileSync(tokenFile(root, token), JSON.stringify({ ...rec, createdAt: '2099-01-01T00:00:00.000Z' }));
    expect((await checkLease(root, token)).status).toBe('unknown');
    writeFileSync(tokenFile(root, token), JSON.stringify({ ...rec, createdAt: new Date(Date.now() - 13 * 3600 * 1000).toISOString() }));
    expect((await checkLease(root, token)).status).toBe('expired');
  });

  it('issuing reads no parser: a large served file costs one read', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ollease-big-')));
    dirs.push(root);
    const big = `export function target() {\n  return 0;\n}\n${'export const x = 1;\n'.repeat(45_000)}`;
    write(root, 'src/big.ts', big);
    write(root, join(OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes: [{ id: 't', name: 'target', filePath: 'src/big.ts', startIndex: 0, endIndex: 39, startLine: 1 }], edges: [] } }));
    const t = performance.now();
    expect(await issueLeaseToken(root, [{ file: 'src/big.ts', name: 'target' }])).toBeDefined();
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it('a token resolves through an aliased (non-canonical) root path', async () => {
    const raw = mkdtempSync(join(tmpdir(), 'ollease-alias-')); // macOS: /var → /private/var
    dirs.push(raw);
    write(raw, 'src/config.ts', CONFIG);
    index(raw, 'src/config.ts', CONFIG, ['parseConfig']);
    const token = (await issueLeaseToken(raw, [{ file: 'src/config.ts', name: 'parseConfig' }]))!;
    expect((await lease(raw, token)).verdict).toBe('confirmed');
  });

  it('nothing served → no token; the token store is not committed', async () => {
    const root = repo();
    expect(await issueLeaseToken(root, [])).toBeUndefined();
    await issueLeaseToken(root, served);
    expect(readFileSync(join(root, '.openlore', 'session-ledger', '.gitignore'), 'utf-8')).toBe('*\n');
    expect(readdirSync(join(root, '.openlore', 'session-ledger', 'tokens'))).toHaveLength(1);
  });

  it('servedForLease reads orient functions (with start lines) and spec files, and recall authoritative anchors', () => {
    expect(servedForLease('orient', { relevantFunctions: [{ name: 'f', filePath: 'a.ts', startLine: 3 }], specDomains: [{ specFile: 's.md' }] }))
      .toEqual([{ file: 'a.ts', name: 'f', startLine: 3 }, { file: 's.md' }]);
    expect(servedForLease('recall', { authoritative: [{ anchors: [{ file: 'b.ts', symbol: 'g' }, { file: 'c.ts' }] }], needsReanchoring: [{ anchors: [{ file: 'x.ts' }] }] }))
      .toEqual([{ file: 'b.ts', name: 'g' }, { file: 'c.ts' }]);
    expect(servedForLease('search_code', { results: [] })).toEqual([]);
  });
});
