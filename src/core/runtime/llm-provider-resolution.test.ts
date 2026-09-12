/**
 * `generation.provider` is committed in the ANALYZED repository, so on a clone it is
 * attacker-authored. For a keyed provider the operator's own credential is the consent
 * signal (and resolution returns null without it); the CLI-backed providers have no such
 * brake — they need no key — so a clone naming one gets the operator's already-authenticated
 * agent binary launched on prompt text the repository wrote.
 *
 * Selecting a provider in config is the documented way to configure generation, so that is
 * honoured and DISCLOSED rather than refused. These tests pin the disclosure, and pin that
 * it does not fire when the operator made the choice themselves.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveGenerationProvider,
  resolveConfiguredProvider,
  GENERATION_PROVIDER_ENV,
} from './llm-provider-resolution.js';
import { logger } from '../../utils/logger.js';

const CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_COMPAT_API_KEY',
  'GEMINI_API_KEY',
];

describe('resolveConfiguredProvider', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    for (const name of [...CREDENTIAL_ENV, GENERATION_PROVIDER_ENV]) delete process.env[name];
  });
  afterEach(() => { process.env = { ...saved }; });

  it('honours a repo-supplied CLI provider but discloses it', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    expect(resolveConfiguredProvider('cursor-agent')).toBe('cursor-agent');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/generation\.provider/);
    // The operator has to be able to see WHOSE choice it was and what it costs them.
    expect(warn.mock.calls[0][0]).toMatch(/this repository/i);
  });

  it('stays silent when the OPERATOR named the provider in the environment', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    process.env[GENERATION_PROVIDER_ENV] = 'claude-code';
    expect(resolveConfiguredProvider('claude-code')).toBe('claude-code');
    expect(warn).not.toHaveBeenCalled();
    // Per-provider: naming one does not pre-approve a different one.
    expect(resolveConfiguredProvider('codex-cli')).toBe('codex-cli');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts a keyed provider — the operator credential is the consent signal', () => {
    expect(resolveConfiguredProvider('anthropic')).toBe('anthropic');
  });
});

describe('resolveGenerationProvider — a repo-selected agent CLI is disclosed', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.spyOn(logger, 'warning').mockImplementation(() => {});
    for (const name of [...CREDENTIAL_ENV, GENERATION_PROVIDER_ENV]) delete process.env[name];
  });
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...saved }; });

  it('a clone shipping provider: cursor-agent resolves, and says whose choice it was', () => {
    // Honoured: config is the documented way to select a provider, and refusing it would
    // break every honest repository. What the operator gets instead is the disclosure —
    // they invoked generation, but did not choose which local binary would run.
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    expect(resolveGenerationProvider({ generation: { provider: 'cursor-agent' } }))
      .toMatchObject({ provider: 'cursor-agent' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/this repository/i);
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
