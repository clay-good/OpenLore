/**
 * The before-stop certificates (change: reframe-governance-as-agent-evidence, group 3): each source
 * starts only when the session diff can give it something to find, adds at most 3 items, and adds
 * nothing when it errors or passes its limit.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const h = vi.hoisted(() => ({
  verify: {} as Record<string, unknown>,
  surface: vi.fn(),
  contract: vi.fn(),
  impact: vi.fn(),
}));
vi.mock('../../core/services/mcp-handlers/verify-change.js', () => ({ handleVerifyChange: vi.fn(async () => h.verify) }));
vi.mock('../../core/services/mcp-handlers/public-surface.js', () => ({ handleCertifyPublicSurface: h.surface }));
vi.mock('../../core/services/mcp-handlers/service-contract.js', () => ({ handleCertifyServiceContract: h.contract }));
vi.mock('../../core/services/mcp-handlers/impact-certificate.js', () => ({ handleChangeImpactCertificate: h.impact }));

import { runHook, certificateSlice } from './hook.js';

const dirs: string[] = [];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'olhookcert-')));
  dirs.push(root);
  mkdirSync(join(root, '.openlore'));
  writeFileSync(join(root, '.openlore', 'config.json'), '{}');
  for (const [rel, c] of Object.entries({ 'README.md': '# x\n', ...files })) write(root, rel, c);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root, env: GIT_ENV });
  return root;
}
const stop = async (root: string): Promise<string> => {
  const out = (await runHook('before-stop', JSON.stringify({ session_id: 's1', cwd: root }))).stdout;
  return out ? (JSON.parse(out) as { systemMessage?: string }).systemMessage ?? '' : '';
};
/** The fields every `.openlore/config.json` needs to validate (what `openlore init` writes). */
const BASE_CONFIG = {
  version: '1.2.0', projectType: 'nodejs', openspecPath: './openspec',
  analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
  generation: { model: 'x', domains: 'auto' }, createdAt: '2026-11-15T00:00:00.000Z', lastRun: null,
};
const REMOVED = {
  breaking: [{ class: 'breaking', name: 'helper', file: 'src/a.ts', changeKind: 'removed', ruleCodes: ['export-removed'], consumers: [{ file: 'src/b.ts' }] }],
};

beforeEach(() => {
  h.verify = { items: [], findings: [] };
  for (const f of [h.surface, h.contract, h.impact]) f.mockReset();
  h.surface.mockResolvedValue({ breaking: [] });
  h.contract.mockResolvedValue({ findings: [] });
  h.impact.mockResolvedValue({ findings: [], newlyOpenedPaths: [] });
});
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('certificateSlice', () => {
  it('adds nothing for a source that never resolves, rejects, or throws, and caps at 3 items', async () => {
    const started = Date.now();
    expect(await certificateSlice(() => new Promise(() => undefined), 50)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await certificateSlice(async () => { throw new Error('boom'); }, 50)).toEqual([]);
    expect(await certificateSlice((() => { throw new Error('sync'); }) as never, 50)).toEqual([]);
    const many = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, severity: 'error', text: `t${i}` }));
    expect(await certificateSlice(async () => many, 50)).toHaveLength(3);
  });
});

describe('before-stop certificates', () => {
  it('public surface: a removed export with one consumer is one line; a Markdown-only diff never calls it', async () => {
    const root = repo({ 'src/a.ts': 'export function helper() {}\n', 'src/b.ts': "import { helper } from './a';\nhelper();\n" });
    write(root, 'README.md', '# changed\n');
    expect(await stop(root)).toBe('');
    expect(h.surface).not.toHaveBeenCalled();

    write(root, 'src/a.ts', 'function helper() {}\n');
    h.surface.mockResolvedValue(REMOVED);
    const text = await stop(root);
    expect(h.surface).toHaveBeenCalledWith(expect.objectContaining({ directory: root }));
    expect(text).toContain('exported helper (src/a.ts) removed: breaks export-removed; used by src/b.ts');
    expect(text.match(/exported helper/g)).toHaveLength(1);
  });

  it('public surface: a symbol verify_change already names as removed is not said twice', async () => {
    const root = repo({ 'src/a.ts': 'export function helper() {}\n' });
    write(root, 'src/a.ts', '\n');
    h.verify = { items: [{ subject: 'removed helper (src/a.ts)', check: 'structural_diff', severity: 'error', nextAction: 'A function was removed; confirm no caller still references it.' }], findings: [] };
    h.surface.mockResolvedValue(REMOVED);
    const text = await stop(root);
    expect(text).toContain('removed helper (src/a.ts)');
    expect(text).not.toContain('exported helper');
  });

  it('service contract: called for a changed spec file only, and emits only contract-breaking findings', async () => {
    const root = repo({ 'openapi.yaml': 'openapi: 3.0.0\n', 'src/a.ts': 'export const a = 1;\n' });
    write(root, 'src/a.ts', 'export const a = 2;\n');
    await stop(root);
    expect(h.contract).not.toHaveBeenCalled();

    write(root, 'openapi.yaml', 'openapi: 3.0.1\n');
    h.contract.mockResolvedValue({ findings: [
      { code: 'contract-breaking', severity: 'error', subject: 'GET /users', discriminator: 'operation-removed', message: 'operation removed (operation-removed, breaking); called from src/api.ts:3.', location: { path: 'openapi.yaml' } },
      { code: 'contract-declared-unimplemented', severity: 'warning', subject: 'GET /x', message: 'declared, not implemented' },
    ] });
    const text = await stop(root);
    expect(h.contract).toHaveBeenCalled();
    expect(text).toContain('GET /users: operation removed (operation-removed, breaking); called from src/api.ts:3.');
    expect(text).not.toContain('declared, not implemented');
  });

  it('impact certificate: called only with declared surfaces, never persisting, and names the opened path', async () => {
    const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
    write(root, 'src/a.ts', 'export const a = 2;\n');
    await stop(root);
    expect(h.impact).not.toHaveBeenCalled();

    write(root, '.openlore/config.json', JSON.stringify({ ...BASE_CONFIG, impactCertificate: { surfaces: [{ name: 'auth', severity: 'critical', members: [{ file: 'src/auth/login.ts' }] }] } }));
    write(root, 'src/a.ts', 'export const a = 3;\n');
    h.impact.mockResolvedValue({
      findings: [
        { code: 'surface-critical', severity: 'error', subject: 'auth', message: 'Change opens 1 new path(s) into surface "auth" (e.g. a → login).', remediation: 'Confirm the new reach into "auth" is intended.' },
        { code: 'spec-drift', severity: 'warn', subject: '1 spec(s)', message: 'drifts a spec', remediation: 'x' },
      ],
      newlyOpenedPaths: [{ surface: 'auth', openingEdge: { from: 'a', to: 'login' } }],
    });
    const text = await stop(root);
    expect(h.impact).toHaveBeenCalledWith(expect.objectContaining({ directory: root, persist: false }));
    expect(text).toContain('Change opens 1 new path(s) into surface "auth" (e.g. a → login).');
    expect(text).not.toContain('drifts a spec');
  });

  it('a failing certificate adds no line and costs nothing else in the receipt', async () => {
    const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
    write(root, 'src/a.ts', 'export const a = 2;\n');
    h.verify = { items: [{ subject: '1 changed symbol(s), up to 3 affected caller(s)', check: 'blast_radius', severity: 'warning', nextAction: 'Review callers.' }], findings: [] };
    h.surface.mockRejectedValue(new Error('index unavailable'));
    const text = await stop(root);
    expect(text).toContain('1 changed symbol(s), up to 3 affected caller(s)');
    expect(text).not.toMatch(/public|surface|index unavailable|passed/i);
  });
});
