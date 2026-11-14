import { inspectConfiguration } from './inspect.js';
import {
  applyConfiguration,
  previewConfiguration,
  revertConfiguration,
  verifyConfiguration,
} from './workflow.js';
import type { ConfigurationCandidate, ConfigurationOptions, ConfigurationPlan } from './types.js';

export interface ConfigurationRequest {
  action: 'inspect' | 'preview' | 'apply' | 'verify' | 'revert';
  candidate?: ConfigurationCandidate;
  plan?: ConfigurationPlan;
  scope?: string;
  activate?: boolean;
}
/** Authority is supplied by the caller, never deserialized from request data. */
export async function configureOpenLore(
  request: ConfigurationRequest,
  options: ConfigurationOptions = {}
): Promise<unknown> {
  options.signal?.throwIfAborted();
  if (!request || !['inspect', 'preview', 'apply', 'verify', 'revert'].includes(request.action))
    throw new Error('Unknown configuration action');
  if (request.action === 'inspect')
    return inspectConfiguration({ ...options, scope: request.scope });
  if (request.action === 'preview') {
    if (!request.candidate) throw new Error('preview requires a candidate');
    return previewConfiguration(request.candidate, options);
  }
  if (!request.plan) throw new Error(request.action + ' requires the exact preview plan');
  if (request.action === 'apply') return applyConfiguration(request.plan, options);
  if (request.action === 'verify') return verifyConfiguration(request.plan, options);
  return revertConfiguration(request.plan, options);
}
