import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { issueLeaseToken, checkLease, servedForLease } from './lease-tokens.js';
import { verifyGraphClaim } from './mcp-handlers/claim-kinds-graph.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const write = (root: string, rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };

const CONFIG = 'export function parseConfig(s: string) {\n  return JSON.parse(s);\n}\n\nexport function loadDefaults() {\n  return { a: 1 };\n}\n';

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ollease-')));
  dirs.push(root);
  mkdirSync(join(root, '.openlore'));
  write(root, 'src/config.ts', CONFIG);
  write(root, 'openspec/specs/config/spec.md', '# Config\n\nParsing rules.\n');
  return root;
}
const served = [{ file: 'src/config.ts', name: 'parseConfig' }, { file: 'openspec/specs/config/spec.md' }];
type R = { verdict: string; reason: string; receipt?: { changed: Array<{ name?: string; file: string; why: string }> } };
const lease = async (root: string, token: string) => (await verifyGraphClaim(root, 'lease-current', token)) as R;

describe('lease tokens', () => {
  it('a token is current until a served symbol changes; then it names it', async () => {
    const root = repo();
    const token = (await issueLeaseToken(root, served, 5000))!;
    expect(token).toMatch(/^lt_[0-9a-f]{20}$/);
    expect((await lease(root, token)).verdict).toBe('confirmed');
    write(root, 'src/config.ts', CONFIG.replace('JSON.parse(s)', 'JSON.parse(s.trim())'));
    const r = await lease(root, token);
    expect(r.verdict).toBe('refuted');
    expect(r.receipt?.changed).toEqual([{ file: 'src/config.ts', name: 'parseConfig', why: 'changed' }]);
  });

  it('an edit to an unserved symbol in the same file keeps the lease current', async () => {
    const root = repo();
    const token = (await issueLeaseToken(root, served, 5000))!;
    write(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 2'));
    expect((await lease(root, token)).verdict).toBe('confirmed');
  });

  it('a whole-file entry changes at file level; a deleted file is removed', async () => {
    const root = repo();
    const token = (await issueLeaseToken(root, served, 5000))!;
    write(root, 'openspec/specs/config/spec.md', '# Config\n\nNew rules.\n');
    rmSync(join(root, 'src/config.ts'));
    const changed = (await lease(root, token)).receipt?.changed;
    expect(changed).toEqual(expect.arrayContaining([
      { file: 'openspec/specs/config/spec.md', why: 'file-changed' },
      { file: 'src/config.ts', name: 'parseConfig', why: 'removed' },
    ]));
  });

  it('a reformat of a whole-file entry is not a change', async () => {
    const root = repo();
    const token = (await issueLeaseToken(root, served, 5000))!;
    write(root, 'openspec/specs/config/spec.md', '# Config\n\n  Parsing   rules.\n\n');
    expect((await lease(root, token)).verdict).toBe('confirmed');
  });

  it('unknown, malformed, and expired tokens are unverifiable', async () => {
    const root = repo();
    expect((await lease(root, 'lt_00000000000000000000')).verdict).toBe('unverifiable');
    expect((await lease(root, '../../etc/passwd')).verdict).toBe('unverifiable');
    const token = (await issueLeaseToken(root, served, 5000))!;
    const file = join(root, '.openlore', 'session-ledger', 'tokens', `${token}.json`);
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...rec, createdAt: new Date(Date.now() - 13 * 3600 * 1000).toISOString() }));
    const r = await checkLease(root, token);
    expect(r.status).toBe('expired');
  });

  it('nothing served → no token; the token store is not committed', async () => {
    const root = repo();
    expect(await issueLeaseToken(root, [])).toBeUndefined();
    await issueLeaseToken(root, served, 5000);
    expect(readFileSync(join(root, '.openlore', 'session-ledger', '.gitignore'), 'utf-8')).toBe('*\n');
    expect(readdirSync(join(root, '.openlore', 'session-ledger', 'tokens'))).toHaveLength(1);
  });

  it('servedForLease reads orient functions and spec files, and recall authoritative anchors', () => {
    expect(servedForLease('orient', { relevantFunctions: [{ name: 'f', filePath: 'a.ts' }], specDomains: [{ specFile: 's.md' }] }))
      .toEqual([{ file: 'a.ts', name: 'f' }, { file: 's.md' }]);
    expect(servedForLease('recall', { authoritative: [{ anchors: [{ file: 'b.ts', symbol: 'g' }, { file: 'c.ts' }] }], needsReanchoring: [{ anchors: [{ file: 'x.ts' }] }] }))
      .toEqual([{ file: 'b.ts', name: 'g' }, { file: 'c.ts' }]);
    expect(servedForLease('search_code', { results: [] })).toEqual([]);
  });
});
