import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeGeneration, resolveGenerationProvider } from './generation-core.js';
import { writeFile } from 'node:fs/promises';
import { resolveSpecLinkIndex } from '../generator/spec-link-service.js';
import { SpecSnapshotGenerator } from '../analyzer/spec-snapshot-generator.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../generator/spec-link-service.js', () => ({
  resolveSpecLinkIndex: vi.fn().mockResolvedValue({
    state: 'available',
    index: { stats: { linked: 1, totalRequirements: 1 } },
  }),
}));
vi.mock('../generator/rag-manifest-generator.js', () => ({
  RagManifestGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generate: vi.fn().mockReturnValue({ domains: ['api'] }) });
  }),
}));
vi.mock('../analyzer/spec-snapshot-generator.js', () => ({
  SpecSnapshotGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generate: vi.fn().mockResolvedValue({}) });
  }),
}));

describe('resolveGenerationProvider', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.OPENAI_COMPAT_BASE_URL;
    delete process.env.GEMINI_API_KEY;
  });

  it('honors an explicit keyless provider and model without API keys', () => {
    expect(resolveGenerationProvider({ generation: {} }, {
      provider: 'codex-cli',
      model: 'gpt-5-codex',
    })).toEqual({
      provider: 'codex-cli',
      model: 'gpt-5-codex',
      openaiCompatBaseUrl: undefined,
    });
  });

  it('uses a keyless configured provider and configured model', () => {
    expect(resolveGenerationProvider({
      generation: { provider: 'claude-code', model: 'sonnet' },
    })).toEqual({
      provider: 'claude-code',
      model: 'sonnet',
      openaiCompatBaseUrl: undefined,
    });
  });

  it('uses the same environment priority as the CLI', () => {
    process.env.OPENAI_API_KEY = 'openai';
    process.env.GEMINI_API_KEY = 'gemini';
    process.env.ANTHROPIC_API_KEY = 'anthropic';

    expect(resolveGenerationProvider({ generation: {} })?.provider).toBe('anthropic');
  });

  it('returns null when neither a key nor a keyless provider is configured', () => {
    expect(resolveGenerationProvider({ generation: {} })).toBeNull();
  });

  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['openai-compat', 'OPENAI_COMPAT_API_KEY'],
    ['gemini', 'GEMINI_API_KEY'],
  ] as const)('requires keyed provider %s to have its own credential', (provider, envName) => {
    process.env.ANTHROPIC_API_KEY = 'wrong-provider-key';
    if (envName === 'ANTHROPIC_API_KEY') {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = 'wrong-provider-key';
    }

    expect(resolveGenerationProvider({ generation: { provider } })).toBeNull();

    process.env[envName] = 'selected-provider-key';
    expect(resolveGenerationProvider({ generation: { provider } })?.provider).toBe(provider);
  });

  it('uses the override provider default when its provider differs from configured model', () => {
    process.env.GEMINI_API_KEY = 'gemini';
    const resolved = resolveGenerationProvider(
      { generation: { provider: 'anthropic', model: 'claude-custom' } },
      { provider: 'gemini' },
    );
    expect(resolved?.model).toMatch(/gemini/i);
    expect(resolved?.model).not.toBe('claude-custom');
  });

  it('keeps a configured model when the override selects the same provider', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic';
    expect(resolveGenerationProvider(
      { generation: { provider: 'anthropic', model: 'claude-custom' } },
      { provider: 'anthropic' },
    )?.model).toBe('claude-custom');
  });
});

describe('finalizeGeneration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shares mapping, RAG manifest, and snapshot finalization', async () => {
    await finalizeGeneration({
      rootPath: '/repo',
      openspecRoot: '/repo/openspec',
      openspecPath: 'openspec',
      metadataSpecs: [] as never[],
    });

    expect(resolveSpecLinkIndex).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: '/repo', openspecPath: 'openspec', persist: true,
    }));
    expect(writeFile).toHaveBeenCalledWith(
      '/repo/openspec/rag-manifest.json',
      expect.any(String),
      'utf-8',
    );
    expect(SpecSnapshotGenerator).toHaveBeenCalledWith('/repo', 'openspec');
  });

  it('does not replace the global RAG manifest for scoped generation', async () => {
    await finalizeGeneration({
      rootPath: '/repo',
      openspecRoot: '/repo/openspec',
      openspecPath: 'openspec',
      metadataSpecs: [] as never[],
      scoped: true,
    });

    expect(writeFile).not.toHaveBeenCalled();
  });
});
