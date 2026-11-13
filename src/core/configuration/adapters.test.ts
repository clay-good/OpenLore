import { Compile } from 'typebox/compile';
import type { TSchema } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureOpenLore } from './adapter.js';
import { configureOpenLoreMcp } from './mcp.js';
import { createPiExtension } from '../../pi/extension.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ConfigurationPlan } from './types.js';
let root: string, runtime: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-config-adapter-'));
  runtime = await mkdtemp(join(tmpdir(), 'ol-config-private-'));
  vi.stubEnv('OPENLORE_SETTINGS_RUNTIME_DIR', runtime);
  vi.stubEnv('OPENLORE_GLOBAL_CONFIG', join(root, 'missing.json'));
  vi.stubEnv('OPENLORE_CONFIGURATION_WRITE_ROOTS', '');
  await writeFile(join(root, 'package.json'), '{}');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
});
const candidate = {
  rules: [
    {
      id: 'output',
      pattern: 'generated/',
      lanes: { watch: 'exclude' as const },
      reason: 'Reviewed output',
    },
  ],
};
describe('configuration host adapters', () => {
  it('keeps MCP reads independent and forged approval powerless', async () => {
    const report = (await configureOpenLoreMcp({ action: 'inspect' }, root)) as {
      runtime: { index: string };
      confidenceBoundary: { complete: boolean };
    };
    expect(report.runtime.index).toBe('absent');
    expect(JSON.stringify(report)).not.toContain(root);
    const plan = (await configureOpenLore(
      { action: 'preview', candidate },
      { rootPath: root }
    )) as ConfigurationPlan;
    const refused = (await configureOpenLoreMcp(
      {
        action: 'apply',
        plan,
        approved: true,
        authority: { root, planId: plan.id, permissions: ['write-config'] },
      },
      root
    )) as { outcome: string; confidenceBoundary: { complete: boolean } };
    expect(refused.outcome).toBe('blocked');
    expect(refused.confidenceBoundary.complete).toBe(false);
    await expect(readFile(join(root, '.openlore/config.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    vi.stubEnv('OPENLORE_CONFIGURATION_WRITE_ROOTS', JSON.stringify([root]));
    const wirePlan = (await configureOpenLoreMcp(
      { action: 'preview', candidate },
      root
    )) as ConfigurationPlan & { rootIdentity: string };
    expect(wirePlan.root).toBe('.');
    expect(wirePlan.configPath).toBe('.openlore/config.json');
    expect(JSON.stringify(wirePlan)).not.toContain(root);
    const accepted = (await configureOpenLoreMcp({ action: 'apply', plan: wirePlan }, root)) as {
      configPublished: boolean;
    };
    expect(accepted.configPublished).toBe(true);
    await expect(readFile(join(root, '.openlore/analysis/llm-context.json'))).rejects.toMatchObject(
      { code: 'ENOENT' }
    );
  });
  it('supports Pi structured reads without UI or a global executable and refuses unconfirmed writes', async () => {
    const tools = new Map<
      string,
      { name: string; parameters: TSchema; execute: (...args: unknown[]) => Promise<unknown> }
    >();
    const resolveDaemon = vi.fn();
    const restartDaemon = vi.fn();
    const pi = {
      registerTool: (tool: { name: string; parameters: TSchema; execute: (...args: unknown[]) => Promise<unknown> }) =>
        tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;
    createPiExtension({ resolveDaemon, restartDaemon })(pi);
    const ctx = {
      cwd: root,
      hasUI: false,
      ui: { confirm: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const tool = tools.get('openlore_configure')!;
    const validateArguments = Compile(tool.parameters);
    expect(validateArguments.Check({ action: 'preview', candidate })).toBe(true);
    // The live participant guessed both inspection and whole-config wrappers.
    for (const wrong of [
      { ...candidate, excludePatterns: ['vendor/**'] },
      { selection: candidate },
      { filePolicies: candidate },
    ]) expect(validateArguments.Check({ action: 'preview', candidate: wrong })).toBe(false);

    const inspected = await tool.execute(
      'inspect',
      { action: 'inspect' },
      undefined,
      undefined,
      ctx
    );
    expect(JSON.stringify(inspected)).toContain('configRevision');
    expect(resolveDaemon).not.toHaveBeenCalled();
    const plan = (await configureOpenLore(
      { action: 'preview', candidate },
      { rootPath: root }
    )) as ConfigurationPlan;
    const refused = await tool.execute(
      'apply',
      { action: 'apply', plan },
      undefined,
      undefined,
      ctx
    );
    expect(JSON.stringify(refused)).toContain('authorization required');
    expect(restartDaemon).not.toHaveBeenCalled();
  });
  it('separates failed lifecycle recovery and optional canary authorization from publication', async () => {
    const plan = (await configureOpenLore(
      { action: 'preview', candidate },
      { rootPath: root }
    )) as ConfigurationPlan;
    const activate = vi.fn(async () => {
      throw new Error('supervised lifecycle unavailable');
    });
    const probe = vi.fn(async () => ({ delivered: true, cleaned: true }));
    const authority = {
      root,
      planId: plan.id,
      permissions: ['write-config', 'runtime'] as Array<'write-config' | 'runtime'>,
    };
    const applied = (await configureOpenLore(
      { action: 'apply', plan },
      { rootPath: root, authority, activate, canary: probe }
    )) as { configPublished: boolean; outcome: string; disclosures: Array<{ code: string }> };
    expect(applied.configPublished).toBe(true);
    expect(applied.outcome).toBe('applied-pending-verification');
    expect(applied.disclosures.some((d) => d.code === 'runtime-activation-failed')).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    await configureOpenLore({ action: 'apply', plan }, { rootPath: root, authority, activate });
    expect(activate).toHaveBeenCalledTimes(1);
    await configureOpenLore(
      { action: 'verify', plan },
      {
        rootPath: root,
        authority: { root, planId: plan.id, permissions: ['probe'] },
        canary: probe,
      }
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it('bounds a stuck authorized probe and reports unverified cleanup', async () => {
    const plan = (await configureOpenLore(
      { action: 'preview', candidate },
      { rootPath: root }
    )) as ConfigurationPlan;
    await configureOpenLore(
      { action: 'apply', plan },
      { rootPath: root, authority: { root, planId: plan.id, permissions: ['write-config'] } }
    );
    const result = (await configureOpenLore(
      { action: 'verify', plan },
      {
        rootPath: root,
        authority: { root, planId: plan.id, permissions: ['probe'] },
        observe: async () => ({}),
        canary: async () => new Promise(() => {}),
        canaryTimeoutMs: 10,
      }
    )) as {
      outcome: string;
      verification: { canary: string };
      disclosures: Array<{ code: string }>;
    };
    expect(result.outcome).toBe('partially-verified');
    expect(result.verification.canary).toBe('failed');
    expect(result.disclosures.some((d) => d.code === 'canary-failed')).toBe(true);
  });
});
