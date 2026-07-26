/**
 * Trust boundary for network settings read out of `.openlore/config.json`.
 *
 * That file is committed IN the repository being analyzed, so on a cloned repo it is
 * attacker-authored — the same premise `safeOpenspecDir` already acts on for
 * `openspecPath`. Two of its fields decide where an OPERATOR credential goes and
 * whether the connection carrying it is verified:
 *
 *   - `llm.apiBase` — the provider endpoint. Anthropic requests carry the victim's
 *     `ANTHROPIC_API_KEY` in an `x-api-key` header, OpenAI's carry `OPENAI_API_KEY`
 *     as a bearer token. A repo that sets `apiBase` to a host it controls collects
 *     that key on the victim's next `openlore generate` / `drift` — or on their next
 *     commit, since the decisions gate runs consolidation from the pre-commit hook.
 *   - `llm.sslVerify: false` — turns off certificate verification, which is what
 *     makes the redirect survivable for an on-path attacker as well.
 *
 * The rule this module enforces: repo data may not choose where operator credentials
 * go, nor waive the verification protecting them. An operator can still do both — via
 * `--api-base` / `--insecure` or the provider env vars, all of which come from the
 * person running the command rather than from the clone.
 *
 * A loopback `apiBase` is exempt: pointing at a local proxy (ollama, LiteLLM, a
 * recording proxy) is the legitimate reason to commit the field at all, and a
 * loopback address cannot exfiltrate to an attacker's host.
 *
 * NOT covered here, deliberately: `generation.openaiCompatBaseUrl`. It has no default
 * — an openai-compat provider is unusable without it — so a committed value is the
 * documented way to configure a team's gateway, and refusing it would break working
 * repos. It gets a disclosure instead (see `command-helpers.ts`).
 */

import { logger } from '../../utils/logger.js';
import { isLoopbackHost } from '../../utils/loopback.js';

/** True when `url` names the loopback interface (and so cannot reach the network). */
function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the effective `apiBase`, dropping a repo-supplied non-loopback endpoint.
 *
 * @param flagValue  `--api-base`, supplied by the operator on the command line.
 * @param configValue `llm.apiBase` from the repository's `.openlore/config.json`.
 * @returns the endpoint to use, or `undefined` for "the provider default".
 */
export function resolveTrustedApiBase(
  flagValue: string | undefined,
  configValue: string | undefined,
): string | undefined {
  if (flagValue) return flagValue;
  if (!configValue) return undefined;
  if (isLoopbackUrl(configValue)) return configValue;
  logger.warning(
    `Ignoring llm.apiBase "${configValue}" from .openlore/config.json: a repository's ` +
      'config may not redirect provider requests that carry your API key. ' +
      'Pass --api-base to use it deliberately.',
  );
  return undefined;
}

/**
 * Refuse a TLS opt-out that came from the repository's config, whatever spelling it
 * uses (`generation.skipSslVerify`, `embedding.skipSslVerify`). Always returns
 * `false` — "do not skip verification" — and says so once when the field was set.
 */
export function rejectRepoConfiguredTlsOptOut(field: string, value: boolean | undefined): boolean {
  if (value) {
    logger.warning(
      `Ignoring ${field}=true from .openlore/config.json: a repository may not disable ` +
        'TLS verification. Set it outside the repo to do so deliberately — ' +
        '--insecure for the LLM path, EMBED_SKIP_SSL_VERIFY=1 for embeddings.',
    );
  }
  return false;
}

/**
 * Disclose a repo-configured endpoint that will receive credentials and repository
 * text, when it is not loopback.
 *
 * Used for the endpoints that CANNOT be dropped without breaking a working
 * configuration — `generation.openaiCompatBaseUrl` and `embedding.baseUrl` have no
 * provider default, so a committed value is the only way to name the gateway. The
 * honest move for those is to make the destination visible rather than silent; a
 * refusal belongs only where a default exists to fall back to.
 */
const disclosed = new Set<string>();

export function discloseRepoConfiguredEndpoint(field: string, url: string | undefined): void {
  if (!url || isLoopbackUrl(url)) return;
  // Once per (field, endpoint) per process. `resolveEmbedder` runs on EVERY orient /
  // search_code / semantic call, so an unlatched warning buried a team using a
  // legitimate self-hosted endpoint under one line per MCP request.
  const key = `${field}\u0000${url}`;
  if (disclosed.has(key)) return;
  disclosed.add(key);
  logger.warning(
    `${field} from .openlore/config.json points at ${url} — requests (and any API key ` +
      'for them) go to that host. Confirm you trust this repository.',
  );
}

/**
 * Resolve TLS verification. `--insecure` decides when present; a repo-supplied
 * `sslVerify: false` is ignored, because a clone must not be able to turn off
 * certificate verification for the machine analyzing it.
 */
export function resolveTrustedSslVerify(
  flagInsecure: boolean | undefined,
  configSslVerify: boolean | undefined,
): boolean {
  if (flagInsecure != null) return !flagInsecure;
  if (configSslVerify === false) {
    logger.warning(
      'Ignoring llm.sslVerify=false from .openlore/config.json: a repository may not ' +
        'disable TLS verification. Pass --insecure to do so deliberately.',
    );
  }
  return true;
}
