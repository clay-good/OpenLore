import { relative, isAbsolute } from 'node:path';
import { safeJoin } from '../../utils/path-confinement.js';
import { configurationDigest, repositoryPath } from './policy.js';
import { resolveOpenLoreConfigPath } from '../services/config-manager.js';
import type { ConfigurationPlan } from './types.js';
import { configureOpenLore, type ConfigurationRequest } from './adapter.js';
import { configurationRoot } from './workflow.js';
import { assembleBoundary } from '../services/mcp-handlers/confidence-boundary.js';
import { redactSecrets } from '../services/secret-redaction.js';

/** Management never bootstraps structural services. Startup environment is host-owned. */
export async function configureOpenLoreMcp(
  args: Record<string, unknown>,
  directory: string,
  signal?: AbortSignal
): Promise<unknown> {
  const root = await configurationRoot(directory);
  const request = { ...args } as unknown as ConfigurationRequest;
  if (request.plan?.root === '.') {
    const projected = request.plan as ConfigurationPlan & { rootIdentity?: string };
    if (projected.rootIdentity !== configurationDigest(root) || isAbsolute(projected.configPath))
      throw new Error('Configuration plan belongs to a different project');
    const plan = Object.fromEntries(
      Object.entries(projected).filter(
        ([key]) => key !== 'rootIdentity' && key !== 'confidenceBoundary'
      )
    ) as unknown as ConfigurationPlan;
    request.plan = { ...plan, root, configPath: safeJoin(root, projected.configPath) };
  }

  let granted = false;
  // A scoped startup grant is deliberately outside the model-controlled argument schema.
  const setting = process.env.OPENLORE_CONFIGURATION_WRITE_ROOTS;
  if (setting && setting.length <= 16_384) {
    try {
      const roots: unknown = JSON.parse(setting);
      if (Array.isArray(roots) && roots.length <= 100)
        for (const path of roots)
          if (
            typeof path === 'string' &&
            (await configurationRoot(path).catch(() => null)) === root
          )
            granted = true;
    } catch {
      /* Invalid capability configuration fails closed. */
    }
  }
  const result = await configureOpenLore(request, {
    rootPath: root,
    configPath: resolveOpenLoreConfigPath(root),
    signal,
    ...(granted && request.plan
      ? {
          authority: {
            root,
            planId: request.plan.id,
            permissions: ['write-config'] as ['write-config'],
          },
        }
      : {}),
  });
  const disclosures =
    (result as { disclosures?: Array<{ detail: string }> }).disclosures?.map((d) => d.detail) ?? [];
  const outcome = (result as { outcome?: string }).outcome;
  if (
    outcome &&
    ['blocked', 'stale-plan', 'needs-input', 'failed', 'partially-verified'].includes(outcome)
  )
    disclosures.push((result as { reason?: string }).reason ?? outcome);
  const projected = { ...(result as Record<string, unknown>) };
  if (projected.root === root) projected.root = '.';
  if (typeof projected.configPath === 'string')
    projected.configPath = repositoryPath(relative(root, projected.configPath));
  if ('root' in projected) projected.rootIdentity = configurationDigest(root);
  return redactSecrets({
    ...projected,
    confidenceBoundary: assembleBoundary({ disclosures }),
  });
}
