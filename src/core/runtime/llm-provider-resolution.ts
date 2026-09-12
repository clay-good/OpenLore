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

/** Operator signal pre-approving a CLI-backed provider, which silences the disclosure below. */
export const GENERATION_PROVIDER_ENV = 'OPENLORE_GENERATION_PROVIDER';

/**
 * Honour `generation.provider` from `.openlore/config.json`, disclosing the CLI-backed case.
 *
 * The field is committed in the analyzed repository, so on a clone it is attacker-authored.
 * For a KEYED provider the consent signal already exists: the run proceeds only if the
 * operator's own environment holds that provider's credential, and the caller below returns
 * null when it does not. The CLI-backed providers have no such brake — they are in
 * {@link NO_KEY_PROVIDERS} precisely because they need no key — so a clone shipping
 * `{"generation":{"provider":"cursor-agent"}}` gets OpenLore to spawn the operator's
 * already-authenticated agent binary on prompt text the repository wrote: their paid
 * subscription, and a prompt-injection channel into a tool-runner they did not pick.
 *
 * DISCLOSED, not refused, and the distinction is deliberate. Selecting a provider in the
 * project's own config is the documented way to configure generation, and refusing it would
 * break that for every honest repository to defend against a hostile one — while generation
 * only ever runs from an explicit `openlore generate`/`run`, never from `analyze` or a read
 * path, and the CLI providers already run sandboxed (read-only, tools disabled, throwaway
 * cwd). So the residual risk is bounded, and what the operator actually lacked was
 * VISIBILITY: they chose to generate, but not which binary would be launched. Naming the
 * provider in {@link GENERATION_PROVIDER_ENV} (or passing `--provider`, which does not come
 * through here) says the choice is theirs and silences the line.
 */
export function resolveConfiguredProvider(configValue: string | undefined): ProviderName | undefined {
  if (!configValue) return undefined;
  const provider = configValue as ProviderName;
  if (NO_KEY_PROVIDERS.has(provider) && process.env[GENERATION_PROVIDER_ENV]?.trim() !== configValue) {
    logger.warning(
      `This repository's .openlore/config.json selects generation.provider "${configValue}", ` +
        'a locally-authenticated agent CLI. It will be launched on prompt text derived from ' +
        `this repository, against your own session. Pass --provider, or set ` +
        `${GENERATION_PROVIDER_ENV}=${configValue}, to make the choice yours and silence this.`,
    );
  }
  return provider;
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
  const configured = overrides.provider ?? resolveConfiguredProvider(config?.generation?.provider);

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
