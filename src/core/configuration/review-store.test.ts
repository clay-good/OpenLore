import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileGit } from '../../utils/git-exec.js';
import { reviewConfigurationWithStore, claimConfigurationReview } from './review-store.js';
import { reviewConfigurationOnIdle } from './evolution.js';
import { getDefaultConfig } from '../services/config-manager.js';
import type { ConfigurationInspection } from './types.js';
let root: string, runtime: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-review-root-'));
  runtime = await mkdtemp(join(tmpdir(), 'ol-review-runtime-'));
  vi.stubEnv('OPENLORE_SETTINGS_RUNTIME_DIR', runtime);
  vi.stubEnv('OPENLORE_GLOBAL_CONFIG', join(root, 'missing.json'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
});
const signal = {
  kind: 'watched-output' as const,
  scope: 'generated/',
  action: 'Review output watches',
  observed: true,
  material: true,
  actionable: true,
  explicitChoice: false,
};
const options = { mode: 'notify' as const, idle: true, operationActive: false };
describe('private review coordination', () => {
  it('claims at most one survey and one passive delivery across concurrent sessions', async () => {
    const claims = await Promise.all([
      claimConfigurationReview(root, 'metadata'),
      claimConfigurationReview(root, 'metadata'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const inspection = {
      root,
      complete: true,
      evidenceRevision: 'a',
      evidence: [],
    } as unknown as ConfigurationInspection;
    const results = await Promise.all([
      reviewConfigurationWithStore(inspection, [signal], options),
      reviewConfigurationWithStore(inspection, [signal], options),
    ]);
    expect(results.filter((result) => result.notice)).toHaveLength(1);
    const id = results.find((result) => result.notice)!.notice!.conditions[0].id;
    await reviewConfigurationWithStore(inspection, [], { ...options, dismiss: id });
    const resumed = await reviewConfigurationWithStore(
      { ...inspection, evidenceRevision: 'other-branch' },
      [signal],
      options
    );
    expect(resumed.notice).toBeUndefined();
    expect(
      (
        await reviewConfigurationWithStore(
          { ...inspection, root: root + '-other-worktree' },
          [signal],
          options
        )
      ).notice
    ).toBeDefined();
  });
  it('requires host opt-in and proves a covered output discrepancy from observed subscriptions', async () => {
    await execFileGit('git', ['init', '--quiet'], { cwd: root });
    await mkdir(join(root, '.openlore'));
    await mkdir(join(root, 'generated'));
    await writeFile(
      join(root, '.openlore/config.json'),
      JSON.stringify({
        ...getDefaultConfig('nodejs', 'openspec'),
        configurationAssistant: { reviewMode: 'notify' },
      })
    );
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { outDir: 'generated' } })
    );
    await writeFile(join(root, '.gitignore'), 'generated/\n');
    const observe = vi.fn(async () => ({
      watchedPaths: Array.from({ length: 60 }, (_, i) => 'generated/chunk-' + i),
    }));
    expect(
      await reviewConfigurationOnIdle({
        rootPath: root,
        idle: true,
        operationActive: false,
        observe,
      })
    ).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
    const reviewed = await reviewConfigurationOnIdle({
      rootPath: root,
      idle: true,
      operationActive: false,
      observe,
      notificationsAuthorized: true,
    });
    expect(reviewed?.notice?.conditions).toHaveLength(1);
    expect(
      await reviewConfigurationOnIdle({
        rootPath: root,
        idle: true,
        operationActive: false,
        observe,
        notificationsAuthorized: true,
      })
    ).toBeUndefined();
    expect(observe).toHaveBeenCalledTimes(1);
  });
});
