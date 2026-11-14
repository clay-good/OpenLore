import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectConfiguration } from './inspect.js';
import {
  applyConfiguration,
  previewConfiguration,
  revertConfiguration,
  verifyConfiguration,
} from './workflow.js';
import { FilePolicyResolver } from './policy.js';
import { getDefaultConfig } from '../services/config-manager.js';
import type { ConfigurationOptions, ConfigurationPlan } from './types.js';

let root: string;
let runtime: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-config-'));
  runtime = await mkdtemp(join(tmpdir(), 'openlore-config-runtime-'));
  await import('node:fs/promises').then((fs) => fs.chmod(runtime, 0o700));
  vi.stubEnv('OPENLORE_SETTINGS_RUNTIME_DIR', runtime);
  vi.stubEnv('OPENLORE_GLOBAL_CONFIG', join(root, 'missing-global.json'));
  await mkdir(join(root, '.openlore'));
  await writeFile(
    join(root, '.openlore/config.json'),
    JSON.stringify({
      ...getDefaultConfig('nodejs', 'openspec'),
      unknown: { keep: true },
      embedding: null,
    })
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'test', scripts: { build: 'tsc --outDir generated' } })
  );
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/main.ts'), 'export const answer = 42;');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
});
const candidate = {
  rules: [
    {
      id: 'generated',
      pattern: 'generated/',
      lanes: { watch: 'exclude' as const, embed: 'exclude' as const },
      reason: 'Declared compiler output',
    },
  ],
};
function authorized(plan: ConfigurationPlan): ConfigurationOptions {
  return {
    rootPath: root,
    authority: { root: plan.root, planId: plan.id, permissions: ['write-config', 'replace-choices'] },
  };
}
describe('provider-free configuration workflow', () => {
  it('binds continuation evidence and stops a cancelled survey without mutation', async () => {
    const partial = await inspectConfiguration({ rootPath: root, budget: { entries: 1 } });
    expect(partial.continuation).toBeDefined();
    await inspectConfiguration({ rootPath: root, continuation: partial.continuation });
    await writeFile(join(root, 'package.json'), '{}');
    await expect(
      inspectConfiguration({ rootPath: root, continuation: partial.continuation })
    ).rejects.toThrow('stale');
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      inspectConfiguration({ rootPath: root, signal: cancellation.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('inspects declarations without executing scripts or requiring an index', async () => {
    const report = await inspectConfiguration({ rootPath: root });
    expect(report.runtime.index).toBe('absent');
    expect(report.recommendations[0].rule.pattern).toBe('generated/');
    expect(report.samples).toContain('src/main.ts');
    expect(await readFile(join(root, 'package.json'), 'utf8')).toContain('tsc');
  });
  it('requires host authority, preserves unknown keys and inherited opt-outs, and supports JSON plans', async () => {
    const plan = JSON.parse(
      JSON.stringify(await previewConfiguration(candidate, { rootPath: root }))
    ) as ConfigurationPlan;
    expect((await applyConfiguration(plan, { rootPath: root })).outcome).toBe('blocked');
    const applied = await applyConfiguration(plan, authorized(plan));
    expect(applied.outcome).toBe('applied-pending-verification');
    const config = JSON.parse(await readFile(join(root, '.openlore/config.json'), 'utf8'));
    expect(config.unknown).toEqual({ keep: true });
    expect(config.embedding).toBeNull();
    expect(await applyConfiguration(plan, authorized(plan))).toMatchObject({
      outcome: applied.outcome,
      configPublished: true,
      retained: true,
    });
    expect((await revertConfiguration(plan, authorized(plan))).outcome).toBe('reverted');
    expect(
      JSON.parse(await readFile(join(root, '.openlore/config.json'), 'utf8')).filePolicies
    ).toBeUndefined();
  });
  it('rejects stale evidence and simultaneous plans without clobbering the winning write', async () => {
    const plan = await previewConfiguration(candidate, { rootPath: root });
    await writeFile(join(root, 'package.json'), '{}');
    expect((await applyConfiguration(plan, authorized(plan))).outcome).toBe('stale-plan');
    const a = await previewConfiguration(candidate, { rootPath: root });
    const b = await previewConfiguration({ rules: [] }, { rootPath: root });
    const results = await Promise.all([
      applyConfiguration(a, authorized(a)),
      applyConfiguration(b, authorized(b)),
    ]);
    expect(results.filter((r) => r.configPublished)).toHaveLength(1);
    expect(results.some((r) => r.outcome === 'stale-plan' || r.outcome === 'blocked')).toBe(true);
  });
  it('preserves disjoint later rule edits and rejects overlapping edits on rollback', async () => {
    const plan = await previewConfiguration(candidate, { rootPath: root });
    await applyConfiguration(plan, authorized(plan));
    const path = join(root, '.openlore/config.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    config.filePolicies.rules.push({
      id: 'other',
      pattern: 'other/',
      lanes: { embed: 'exclude' },
      reason: 'Operator choice',
    });
    await writeFile(path, JSON.stringify(config));
    expect((await revertConfiguration(plan, authorized(plan))).outcome).toBe('reverted');
    expect(
      JSON.parse(await readFile(path, 'utf8')).filePolicies.rules.map((r: { id: string }) => r.id)
    ).toEqual(['other']);
  });
  it('never infers live verification from successful publication or a ready daemon', async () => {
    const plan = await previewConfiguration(candidate, { rootPath: root });
    await applyConfiguration(plan, authorized(plan));
    const resolver = new FilePolicyResolver({ rules: candidate.rules });
    expect(
      (
        await verifyConfiguration(plan, {
          rootPath: root,
          observe: async () => ({ toolsCompatible: true }),
        })
      ).outcome
    ).toBe('applied-pending-verification');
    expect(
      (
        await verifyConfiguration(plan, {
          rootPath: root,
          observe: async () => ({
            toolsCompatible: true,
            indexGenerationCurrent: true,
            indexPolicyRevision: resolver.revisionFor('index'),
            watchPolicyRevision: resolver.revisionFor('watch'),
            embeddingPolicyRevision: resolver.revisionFor('embed'),
          }),
        })
      ).outcome
    ).toBe('verified');
  });
  it('creates valid initial configuration and restores absence on checked rollback', async () => {
    const path = join(root, '.openlore/config.json');
    await rm(path);
    const plan = await previewConfiguration(
      { ...candidate, analysis: { excludePatterns: ['cache/'] } },
      { rootPath: root }
    );
    expect((await applyConfiguration(plan, authorized(plan))).configPublished).toBe(true);
    expect((await revertConfiguration(plan, authorized(plan))).outcome).toBe('reverted');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not expose unrelated nested values and preserves disjoint nested edits on revert', async () => {
    const path = join(root, '.openlore/config.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    config.analysis.privateToken = 'secret-do-not-copy';
    await writeFile(path, JSON.stringify(config));
    const plan = await previewConfiguration(
      { ...candidate, analysis: { excludePatterns: ['cache/'] } },
      { rootPath: root }
    );
    expect(JSON.stringify(plan)).not.toContain('secret-do-not-copy');
    expect((await applyConfiguration(plan, authorized(plan))).configPublished).toBe(true);
    const later = JSON.parse(await readFile(path, 'utf8'));
    later.analysis.maxFiles = 777;
    await writeFile(path, JSON.stringify(later));
    expect((await revertConfiguration(plan, authorized(plan))).outcome).toBe('reverted');
    const restored = JSON.parse(await readFile(path, 'utf8'));
    expect(restored.analysis.maxFiles).toBe(777);
    expect(restored.analysis.privateToken).toBe('secret-do-not-copy');
  });
  it('keeps malformed configuration intact and reports bounded coverage', async () => {
    await writeFile(join(root, '.openlore/config.json'), '{broken');
    const report = await inspectConfiguration({ rootPath: root, budget: { entries: 1 } });
    expect(report.complete).toBe(false);
    expect(report.disclosures.some((d) => d.code === 'config-unreadable')).toBe(true);
    const plan = await previewConfiguration(candidate, { rootPath: root });
    expect((await applyConfiguration(plan, authorized(plan))).outcome).toBe('blocked');
    expect(await readFile(join(root, '.openlore/config.json'), 'utf8')).toBe('{broken');
  });
});
