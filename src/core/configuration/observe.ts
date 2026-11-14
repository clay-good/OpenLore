import { join } from 'node:path';
import { readFileConfined } from '../../utils/path-confinement.js';
import {
  serveHttpBaseUrl,
  validateServeDescriptor,
  validateServeHealth,
} from '../../cli/commands/serve-descriptor.js';
import { OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT } from '../../constants.js';
import { readConfiguration } from './inspect.js';
import type { ConfigurationOptions, ConfigurationVerificationObservation } from './types.js';

/** Bounded observations only: never scan the corpus, start a provider, or repair a daemon. */
export async function observeConfiguration(
  options: ConfigurationOptions = {}
): Promise<ConfigurationVerificationObservation> {
  const config = await readConfiguration(options);
  const observations: ConfigurationVerificationObservation = {};
  const read = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse(await readFileConfined(config.root, path, 1024 * 1024, true)) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  };
  const fingerprint = await read(join(OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT));
  const recorded = fingerprint?.fingerprintConfig as { indexPolicyRevision?: unknown } | undefined;
  if (typeof fingerprint?.indexPolicyRevision === 'string')
    observations.indexPolicyRevision = fingerprint.indexPolicyRevision;
  if (typeof recorded?.indexPolicyRevision === 'string')
    observations.indexPolicyRevision = recorded.indexPolicyRevision;
  const vector = await read(join(OPENLORE_ANALYSIS_REL_PATH, 'vector-index-meta.json'));
  if (typeof vector?.embeddingPolicyRevision === 'string')
    observations.embeddingPolicyRevision = vector.embeddingPolicyRevision;
  const descriptor = validateServeDescriptor(await read('.openlore/serve.json'));
  if (!descriptor) return observations;
  try {
    const response = await fetch(
      serveHttpBaseUrl(descriptor.host, descriptor.port) + '/health?configuration=true',
      {
        redirect: 'error',
        headers: descriptor.token ? { 'x-openlore-token': descriptor.token } : undefined,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(1000)])
          : AbortSignal.timeout(1000),
      }
    );
    if (!response.ok || Number(response.headers.get('content-length')) > 128 * 1024)
      return observations;
    const reader = response.body?.getReader();
    if (!reader) return observations;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 128 * 1024) throw new Error('Health response exceeds budget');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const health = validateServeHealth(raw, config.root, descriptor);
    if (!health) return observations;
    // Protocol health alone does not attest that the required structural tools are exposed.
    const tools = raw.tools;
    if (Array.isArray(tools))
      observations.toolsCompatible = ['orient', 'search_code'].every((name) =>
        tools.includes(name)
      );
    const configuration = raw.configuration as
      | { watchPolicyRevision?: unknown; watchedDirectories?: unknown }
      | undefined;
    if (health.watcher === 'healthy' && typeof configuration?.watchPolicyRevision === 'string')
      observations.watchPolicyRevision = configuration.watchPolicyRevision;
    if (Array.isArray(configuration?.watchedDirectories))
      observations.watchedPaths = configuration.watchedDirectories
        .filter((p): p is string => typeof p === 'string')
        .slice(0, 1000);
  } catch {
    /* Missing observations remain pending, never success. */
  }
  options.signal?.throwIfAborted();
  return observations;
}
