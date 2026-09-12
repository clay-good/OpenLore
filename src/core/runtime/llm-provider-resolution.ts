import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_COMPAT_MODEL,
  DEFAULT_OPENAI_MODEL,
} from '../../constants.js';
import { resolveTrustedCompatBase } from '../services/repo-config-trust.js';
import { logger } from '../../utils/logger.js';

export type ProviderName = 'anthropic' | 'openai' | 'openai-compat' | 'gemini'
  | 'claude-code' | 'codex-cli' | 'mistral-vibe' | 'copilot' | 'gemini-cli'
  | 'antigravity-cli' | 'cursor-agent';

const NO_KEY_PROVIDERS = new Set<ProviderName>([
  'claude-code', 'codex-cli', 'mistral-vibe', 'copilot', 'gemini-cli',
  'antigravity-cli', 'cursor-agent',
]);

const KEY_ENV_BY_PROVIDER: Partial<Record<ProviderName, keyof NodeJS.ProcessEnv>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compat': 'OPENAI_COMPAT_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: DEFAULT_ANTHROPIC_MODEL,
  gemini: DEFAULT_GEMINI_MODEL,
  'openai-compat': DEFAULT_OPENAI_COMPAT_MODEL,
  copilot: DEFAULT_COPILOT_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
  'claude-code': 'claude-code',
  'codex-cli': 'codex-cli',
  'mistral-vibe': 'mistral-vibe',
  'gemini-cli': 'gemini-cli',
  'antigravity-cli': 'antigravity-cli',
  'cursor-agent': 'cursor-agent',
};

export interface GenerationProviderConfig {
  generation?: { provider?: string; model?: string; openaiCompatBaseUrl?: string };
}

export interface GenerationProviderOverrides {
  provider?: ProviderName;
  model?: string;
  openaiCompatBaseUrl?: string;
}

/** Operator signal admitting a CLI-backed provider named by the repository's config. */
export const GENERATION_PROVIDER_ENV = 'OPENLORE_GENERATION_PROVIDER';

/**
 * Accept `generation.provider` from the repository's `.openlore/config.json` only where
 * the operator has already consented to that provider.
 *
 * The field is committed in the analyzed repo, so on a clone it is attacker-authored. For
 * a KEYED provider the consent signal already exists: the run only proceeds if the
 * operator's own environment holds that provider's credential, and the caller below
 * returns null when it does not. The CLI-backed providers have no such brake — they are in
 * {@link NO_KEY_PROVIDERS} precisely because they need no key, so a clone shipping
 * `{"generation":{"provider":"cursor-agent"}}` would make OpenLore spawn the victim's
 * already-authenticated agent binary on prompt text the repository wrote: their paid
 * subscription, and a prompt-injection channel into a tool-runner they never chose.
 *
 * So a NO_KEY provider is honoured from repo config only when the operator names it in
 * `OPENLORE_GENERATION_PROVIDER` (or passes it as an override, which does not come through
 * here at all). Otherwise it is ignored and resolution continues from the environment —
 * the same warn-and-ignore shape `repo-config-trust` uses for endpoints.
 */
export function resolveTrustedProvider(configValue: string | undefined): ProviderName | undefined {
  if (!configValue) return undefined;
  const provider = configValue as ProviderName;
  if (!NO_KEY_PROVIDERS.has(provider)) return provider;
  if (process.env[GENERATION_PROVIDER_ENV]?.trim() === configValue) return provider;
  logger.warning(
    `Ignoring generation.provider "${configValue}" from .openlore/config.json: a repository ` +
      'may not choose to run a locally-authenticated agent CLI on its own prompt text. ' +
      `Set ${GENERATION_PROVIDER_ENV}=${configValue} to use it deliberately.`,
  );
  return undefined;
}

export interface ResolvedGenerationProvider {
  provider: ProviderName;
  model: string;
  openaiCompatBaseUrl?: string;
}

/** Canonical provider/model resolution shared by CLI and embeddable entry points. */
export function resolveGenerationProvider(
  config?: GenerationProviderConfig,
  overrides: GenerationProviderOverrides = {},
): ResolvedGenerationProvider | null {
  const configured = overrides.provider ?? resolveTrustedProvider(config?.generation?.provider);

  const provider = configured
    ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic'
      : process.env.GEMINI_API_KEY ? 'gemini'
      : process.env.OPENAI_COMPAT_API_KEY ? 'openai-compat'
      : 'openai');

  if (!NO_KEY_PROVIDERS.has(provider)) {
    const credentialName = KEY_ENV_BY_PROVIDER[provider];
    if (!credentialName || !process.env[credentialName]) return null;
  }

  const configuredModel = config?.generation?.provider === provider
    ? config.generation.model
    : undefined;

  return {
    provider,
    model: overrides.model ?? configuredModel ?? DEFAULT_MODELS[provider],
    openaiCompatBaseUrl: provider === 'openai-compat'
      ? resolveTrustedCompatBase(
        overrides.openaiCompatBaseUrl ?? process.env.OPENAI_COMPAT_BASE_URL,
        config?.generation?.openaiCompatBaseUrl,
      )
      : undefined,
  };
}
