/**
 * `generation.provider` is committed in the ANALYZED repository, so on a clone it is
 * attacker-authored. For a keyed provider the operator's own credential is the consent
 * signal (and resolution returns null without it); the CLI-backed providers have no such
 * brake — they need no key — so a clone naming one would make OpenLore spawn the victim's
 * already-authenticated agent binary on prompt text the repository wrote.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveGenerationProvider,
  resolveTrustedProvider,
  GENERATION_PROVIDER_ENV,
} from './llm-provider-resolution.js';
import { logger } from '../../utils/logger.js';

const CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_COMPAT_API_KEY',
  'GEMINI_API_KEY',
];

describe('resolveTrustedProvider', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    for (const name of [...CREDENTIAL_ENV, GENERATION_PROVIDER_ENV]) delete process.env[name];
  });
  afterEach(() => { process.env = { ...saved }; });

  it('ignores a repo-supplied CLI provider and says so', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    expect(resolveTrustedProvider('cursor-agent')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/generation\.provider/);
  });

  it('accepts a CLI provider the OPERATOR names in the environment', () => {
    process.env[GENERATION_PROVIDER_ENV] = 'claude-code';
    expect(resolveTrustedProvider('claude-code')).toBe('claude-code');
    // The gate is per-provider: naming one does not admit a different one.
    expect(resolveTrustedProvider('codex-cli')).toBeUndefined();
  });

  it('accepts a keyed provider — the operator credential is the consent signal', () => {
    expect(resolveTrustedProvider('anthropic')).toBe('anthropic');
  });
});

describe('resolveGenerationProvider — repo config cannot select an agent CLI', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.spyOn(logger, 'warning').mockImplementation(() => {});
    for (const name of [...CREDENTIAL_ENV, GENERATION_PROVIDER_ENV]) delete process.env[name];
  });
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...saved }; });

  it('a clone shipping provider: cursor-agent does not spawn the agent binary', () => {
    // With the repo value dropped and no credential in the environment, resolution
    // returns null — nothing is spawned and no prompt is built.
    expect(resolveGenerationProvider({ generation: { provider: 'cursor-agent' } })).toBeNull();
  });

  it('an explicit operator override still selects a CLI provider', () => {
    expect(resolveGenerationProvider(
      { generation: { provider: 'cursor-agent' } },
      { provider: 'claude-code' },
    )).toMatchObject({ provider: 'claude-code' });
  });

  it('a repo-supplied keyed provider is still honoured when the operator holds its key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-value';
    expect(resolveGenerationProvider({ generation: { provider: 'anthropic', model: 'm' } }))
      .toMatchObject({ provider: 'anthropic', model: 'm' });
  });
});
