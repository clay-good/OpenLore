import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_COMPAT_MODEL,
  DEFAULT_OPENAI_MODEL,
} from '../../constants.js';
import { resolveTrustedCompatBase } from '../services/repo-config-trust.js';

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
  const configured = overrides.provider ?? config?.generation?.provider as ProviderName | undefined;

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
