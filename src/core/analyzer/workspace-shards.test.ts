import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectWorkspaceShards, resolveWorkspaceShardSelection } from './workspace-shards.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-shards-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('detectWorkspaceShards', () => {
  it('preserves the single-root fallback exactly', async () => {
    const root = await fixture({ 'src/a.ts': 'export const a = 1' });
    await expect(detectWorkspaceShards(root, ['src/a.ts'])).resolves.toEqual({
      source: 'single-root', ignoredMembers: [],
      shards: [{ name: 'root', root: '', manifest: null, files: ['src/a.ts'] }],
    });
  });

  it('detects npm members, assigns overlap to the most-specific root, and keeps root files', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ workspaces: ['packages/*', 'packages/app/plugins/*'] }),
      'packages/app/package.json': JSON.stringify({ name: '@acme/app' }),
      'packages/app/src/a.ts': '',
      'packages/app/plugins/payments/package.json': JSON.stringify({ name: '@acme/payments' }),
      'packages/app/plugins/payments/src/p.ts': '',
      'scripts/release.ts': '',
    });
    const files = ['package.json', 'packages/app/package.json', 'packages/app/src/a.ts', 'packages/app/plugins/payments/package.json', 'packages/app/plugins/payments/src/p.ts', 'scripts/release.ts'];
    const report = await detectWorkspaceShards(root, files);
    expect(report.shards.find(s => s.name === '@acme/payments')?.files).toContain('packages/app/plugins/payments/src/p.ts');
    expect(report.shards.find(s => s.name === '@acme/app')?.files).not.toContain('packages/app/plugins/payments/src/p.ts');
    expect(report.shards.find(s => s.name === 'root')?.files).toContain('scripts/release.ts');
  });

  it('reports and ignores members outside the repository', async () => {
    const root = await fixture({ 'package.json': JSON.stringify({ workspaces: ['../peer'] }) });
    const report = await detectWorkspaceShards(root, ['package.json']);
    expect(report.ignoredMembers).toEqual([{ manifest: 'package.json', member: '../peer', reason: 'outside-root' }]);
    expect(report.shards).toEqual([{ name: 'root', root: '', manifest: null, files: ['package.json'] }]);
  });

  it('uses configured shards instead of detected manifests', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/a/a.ts': '',
      'custom/x.ts': '',
    });
    const report = await detectWorkspaceShards(root, ['package.json', 'packages/a/a.ts', 'custom/x.ts'], [{ name: 'custom', root: 'custom' }]);
    expect(report.source).toBe('configured');
    expect(report.shards.find(s => s.name === 'custom')?.files).toEqual(['custom/x.ts']);
    expect(report.shards.find(s => s.name === 'root')?.files).toEqual(['package.json', 'packages/a/a.ts']);
  });

  it.each([
    ['pnpm-workspace.yaml', 'packages:\n  - packages/*\n'],
    ['Cargo.toml', '[workspace]\nmembers = ["packages/*"]\n'],
    ['go.work', 'go 1.22\nuse (\n  ./packages/a\n)\n'],
    ['settings.gradle', "include ':packages:a'\n"],
    ['pom.xml', '<modules><module>packages/a</module></modules>'],
  ])('detects members declared by %s', async (manifest, content) => {
    const root = await fixture({ [manifest]: content, 'packages/a/a.ts': '' });
    const report = await detectWorkspaceShards(root, [manifest, 'packages/a/a.ts']);
    expect(report.shards.some(shard => shard.root === 'packages/a')).toBe(true);
  });

  it.each([
    ['pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - "!packages/private"\n'],
    ['Cargo.toml', '[workspace]\nmembers = ["packages/*"]\nexclude = ["packages/private"]\n'],
  ])('honors exclusions declared by %s', async (manifest, content) => {
    const root = await fixture({
      [manifest]: content,
      'packages/public/a.ts': '',
      'packages/private/b.ts': '',
    });
    const report = await detectWorkspaceShards(root, [manifest, 'packages/public/a.ts', 'packages/private/b.ts']);
    expect(report.shards.some(shard => shard.root === 'packages/public')).toBe(true);
    expect(report.shards.some(shard => shard.root === 'packages/private')).toBe(false);
    expect(report.shards.find(shard => shard.name === 'root')?.files).toContain('packages/private/b.ts');
  });

  it('bounds repository-controlled workspace pattern counts before globbing', async () => {
    const members = Array.from({ length: 2_001 }, (_, index) => `packages/p${index}`);
    const root = await fixture({ 'package.json': JSON.stringify({ workspaces: members }) });
    await expect(detectWorkspaceShards(root, ['package.json'])).rejects.toThrow(/more than 2000/);
  });

  it('bounds detected package names before selection-distance work', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: 'x'.repeat(10_000) }),
      'packages/a/a.ts': '',
    });
    const report = await detectWorkspaceShards(root, ['package.json', 'packages/a/package.json', 'packages/a/a.ts']);
    const detected = report.shards.find(shard => shard.root === 'packages/a');
    expect(detected?.name).toBe('a');
    expect(report.shards.every(shard => shard.name.length <= 256)).toBe(true);
    expect(() => resolveWorkspaceShardSelection(report, ['typo'])).toThrow(/Unknown workspace shard/);
  });

  it('does not traverse repository directories outside the analyzed corpus', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ workspaces: ['**/never-a-package'] }),
    });
    await Promise.all(Array.from({ length: 500 }, (_, index) =>
      mkdir(join(root, 'unlisted', `directory-${index}`), { recursive: true })));

    const report = await detectWorkspaceShards(root, ['package.json']);
    expect(report.shards).toEqual([{ name: 'root', root: '', manifest: null, files: ['package.json'] }]);
  });

  it('shares one bounded pattern-check budget across workspace manifests', async () => {
    const patterns = Array.from({ length: 1_000 }, (_, index) => `**/never-${index}`);
    const root = await fixture({
      'package.json': JSON.stringify({ workspaces: patterns }),
      'nested/package.json': JSON.stringify({ workspaces: patterns }),
    });
    const files = [
      'package.json',
      'nested/package.json',
      ...Array.from({ length: 800 }, (_, index) => `packages/p${index}/file.ts`),
      ...Array.from({ length: 800 }, (_, index) => `nested/packages/p${index}/file.ts`),
    ];

    await expect(detectWorkspaceShards(root, files)).rejects.toThrow(/pattern checks/);
  }, 15_000);

  it('resolves many exact member patterns by bounded corpus lookup rather than directory scans', async () => {
    const patterns = Array.from({ length: 1_000 }, (_, index) => `missing/member-${index}`);
    const root = await fixture({
      'package.json': JSON.stringify({ workspaces: patterns }),
      'nested/package.json': JSON.stringify({ workspaces: patterns }),
    });
    const files = [
      'package.json',
      'nested/package.json',
      ...Array.from({ length: 50_000 }, (_, index) => `corpus/d${index}/file.ts`),
    ];
    const report = await detectWorkspaceShards(root, files);
    expect(report.shards).toEqual([{ name: 'root', root: '', manifest: null, files: [...files].sort() }]);
  }, 5_000);

  it('detects a nested workspace manifest that declares its own directory', async () => {
    const root = await fixture({
      'nested/package.json': JSON.stringify({ workspaces: ['.'] }),
      'nested/src/a.ts': '',
    });
    const report = await detectWorkspaceShards(root, ['nested/package.json', 'nested/src/a.ts']);
    expect(report.shards.find(shard => shard.root === 'nested')?.files).toEqual([
      'nested/package.json',
      'nested/src/a.ts',
    ]);
  });

  it('falls back to a bounded root name when a detected package name contains controls', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: 'bad\nname' }),
      'packages/a/a.ts': '',
    });
    const report = await detectWorkspaceShards(root, ['package.json', 'packages/a/package.json', 'packages/a/a.ts']);
    expect(report.shards.find(shard => shard.root === 'packages/a')?.name).toBe('a');
  });

  it('falls back when a detected package name contains a C1 terminal control', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: 'bad\u009b31m' }),
      'packages/a/a.ts': '',
    });
    const report = await detectWorkspaceShards(root, ['package.json', 'packages/a/package.json', 'packages/a/a.ts']);
    expect(report.shards.find(shard => shard.root === 'packages/a')?.name).toBe('a');
  });

  it('rejects controls in configured shard names', async () => {
    const root = await fixture({ 'packages/a/a.ts': '' });
    await expect(detectWorkspaceShards(root, ['packages/a/a.ts'], [{ name: 'bad\nname', root: 'packages/a' }]))
      .rejects.toThrow(/control characters/);
  });

  it('rejects C1 terminal controls in configured shard names', async () => {
    const root = await fixture({ 'packages/a/a.ts': '' });
    await expect(detectWorkspaceShards(root, ['packages/a/a.ts'], [{ name: 'bad\u009b31m', root: 'packages/a' }]))
      .rejects.toThrow(/control characters/);
  });

  it('rejects brace-expanding member patterns without compiling them', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ workspaces: ['{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}'] }),
    });
    const report = await detectWorkspaceShards(root, ['package.json']);
    expect(report.ignoredMembers).toEqual([expect.objectContaining({ reason: 'invalid' })]);
  });

  it('rejects absolute configured roots even when they point inside the repository', async () => {
    const root = await fixture({ 'packages/a/a.ts': '' });
    await expect(detectWorkspaceShards(root, ['packages/a/a.ts'], [{ name: 'a', root: join(root, 'packages/a') }]))
      .rejects.toThrow(/repository-relative/);
  });

  it.each(['go.mod', 'pyproject.toml'])('detects nested %s projects', async manifest => {
    const root = await fixture({ [`services/api/${manifest}`]: '', 'services/api/main.py': '' });
    const report = await detectWorkspaceShards(root, [`services/api/${manifest}`, 'services/api/main.py']);
    expect(report.shards.find(shard => shard.root === 'services/api')?.files).toContain('services/api/main.py');
  });

  it('refuses unknown names with available and nearest candidates', async () => {
    const root = await fixture({ 'src/a.ts': '' });
    const report = await detectWorkspaceShards(root, ['src/a.ts'], [{ name: 'payments', root: 'src' }, { name: 'api', root: 'api' }]);
    expect(() => resolveWorkspaceShardSelection(report, ['payment-api'])).toThrow(/nearest: payments.*Available shards: api, payments, root/);
  });

  it('bounds nearest-name work when many long unknown names are supplied', () => {
    const report = {
      source: 'configured' as const,
      ignoredMembers: [],
      shards: Array.from({ length: 5_001 }, (_, index) => ({
        name: `${'a'.repeat(56)}-${index}`,
        root: `p/${index}`,
        manifest: 'workspace.shards',
        files: [],
      })),
    };
    const unknown = Array.from({ length: 1_000 }, (_, index) => `${'z'.repeat(56)}-${index}`);
    expect(() => resolveWorkspaceShardSelection(report, unknown)).toThrow(/and 997 more/);
  }, 5_000);
});
