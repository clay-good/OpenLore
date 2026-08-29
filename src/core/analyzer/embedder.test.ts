import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEmbedder, embedderMode, servedRetrievalMode } from './embedder.js';
import { LocalEmbeddingService, DEFAULT_LOCAL_MODEL } from './local-embedding-service.js';
import { EmbeddingService, type Embedder } from './embedding-service.js';
import type { OpenLoreConfig } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

const cfg = (embedding?: OpenLoreConfig['embedding']): OpenLoreConfig =>
  ({ version: '1.0', embedding } as unknown as OpenLoreConfig);

describe('resolveEmbedder — provider selection (lexical default, semantic opt-in)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_MODEL;
    delete process.env.EMBED_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns null (first-class keyword default) when nothing is configured', async () => {
    expect(await resolveEmbedder(null)).toBeNull();
    expect(await resolveEmbedder(cfg(undefined))).toBeNull();
  });

  it('uses the local provider when embedding.provider is "local"', async () => {
    const e = await resolveEmbedder(cfg({ provider: 'local' }));
    expect(e).toBeInstanceOf(LocalEmbeddingService);
    expect(e?.modelName).toBe(`local:${DEFAULT_LOCAL_MODEL}`);
  });

  it('honours a local model override', async () => {
    const e = await resolveEmbedder(cfg({ provider: 'local', model: 'Xenova/bge-small-en-v1.5' }));
    expect(e?.modelName).toBe('local:Xenova/bge-small-en-v1.5');
  });

  it('uses the remote endpoint when baseUrl + model are set (no provider)', async () => {
    const e = await resolveEmbedder(cfg({ baseUrl: 'http://localhost:1234/v1', model: 'nomic-embed-text' }));
    expect(e).toBeInstanceOf(EmbeddingService);
    expect(e?.modelName).toBe('nomic-embed-text');
  });

  it('an explicit local provider wins over ambient EMBED_* env (embed --local is not silently overridden)', async () => {
    process.env.EMBED_BASE_URL = 'http://localhost:9999/v1';
    process.env.EMBED_MODEL = 'env-model';
    const e = await resolveEmbedder(cfg({ provider: 'local' }));
    expect(e).toBeInstanceOf(LocalEmbeddingService);
    expect(e?.modelName).toBe(`local:${DEFAULT_LOCAL_MODEL}`);
  });

  it('still uses EMBED_* env when no local provider is set', async () => {
    process.env.EMBED_BASE_URL = 'http://localhost:9999/v1';
    process.env.EMBED_MODEL = 'env-model';
    const e = await resolveEmbedder(cfg({ baseUrl: 'http://other/v1', model: 'cfg-model' }));
    expect(e).toBeInstanceOf(EmbeddingService);
    expect(e?.modelName).toBe('env-model'); // env precedence preserved for remote
  });
});

describe('embedderMode — honest mode reporting', () => {
  it('maps no embedder to the keyword default', () => {
    expect(embedderMode(null)).toBe('keyword');
    expect(embedderMode(undefined)).toBe('keyword');
  });

  it('maps a local-prefixed model to local-semantic', () => {
    expect(embedderMode({ modelName: 'local:Xenova/all-MiniLM-L6-v2', embed: async () => [] })).toBe('local-semantic');
  });

  it('maps a plain model name to remote-semantic', () => {
    expect(embedderMode({ modelName: 'text-embedding-3-small', embed: async () => [] })).toBe('remote-semantic');
  });
});

describe('servedRetrievalMode — honest about what the index actually serves', () => {
  let dir: string;
  const remote: Embedder = { modelName: 'text-embedding-3-small', embed: async () => [] };
  const local: Embedder = { modelName: 'local:Xenova/all-MiniLM-L6-v2', embed: async () => [] };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-served-mode-'));
  });

  it('reports keyword when no embedder is resolved', () => {
    expect(servedRetrievalMode(null, dir, 'code')).toBe('keyword');
  });

  it('reports keyword when an embedder is configured but the index has no vectors', async () => {
    await writeFile(join(dir, 'vector-index-meta.json'), JSON.stringify({ hasEmbeddings: false }));
    expect(servedRetrievalMode(local, dir, 'code')).toBe('keyword');
    expect(servedRetrievalMode(remote, dir, 'code')).toBe('keyword');
  });

  it('reports the embedder mode when the index has vectors', async () => {
    await writeFile(join(dir, 'vector-index-meta.json'), JSON.stringify({ hasEmbeddings: true }));
    expect(servedRetrievalMode(local, dir, 'code')).toBe('local-semantic');
    expect(servedRetrievalMode(remote, dir, 'code')).toBe('remote-semantic');
  });

  it('trusts the embedder when no sidecar exists (legacy index)', () => {
    expect(servedRetrievalMode(remote, dir, 'code')).toBe('remote-semantic');
  });

  it('consults the spec sidecar for kind=spec', async () => {
    await writeFile(join(dir, 'spec-index-meta.json'), JSON.stringify({ hasEmbeddings: false }));
    expect(servedRetrievalMode(local, dir, 'spec')).toBe('keyword');
  });
});

describe('LocalEmbeddingService', () => {
  it('records a local: prefixed model name for sidecar mode detection', () => {
    expect(new LocalEmbeddingService().modelName).toBe(`local:${DEFAULT_LOCAL_MODEL}`);
    expect(LocalEmbeddingService.fromConfig({ provider: 'local', model: 'm' }).modelName).toBe('local:m');
  });

  it('returns [] for an empty input without loading the model', async () => {
    expect(await new LocalEmbeddingService().embed([])).toEqual([]);
  });
});

/**
 * A half-configured environment is an operator mistake, not a preference. Silently
 * degrading to BM25 left the operator staring at an EMBED_BASE_URL they had
 * demonstrably set, with nothing in the output explaining why it did nothing.
 */
describe('resolveEmbedder — half-configured environment is disclosed', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_MODEL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('warns and falls back to BM25 when EMBED_BASE_URL is set without EMBED_MODEL', async () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    process.env.EMBED_BASE_URL = 'https://embeddings.internal:8443/v1';
    expect(await resolveEmbedder(null)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/EMBED_MODEL/);
  });

  it('warns and falls back to BM25 when EMBED_MODEL is set without EMBED_BASE_URL', async () => {
    // The mirrored half-configured case: `fromEnv` throws on the missing base URL, so the
    // disclosure must not be keyed on the base URL being present.
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    process.env.EMBED_MODEL = 'nomic-embed-text';
    expect(await resolveEmbedder(null)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/EMBED_BASE_URL/);
  });

  it('does not frame the keyword index as a degraded fallback', async () => {
    // `config` / KeywordIndexIsAFirstClassDefaultNotADegradedFallback forbids that framing.
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    process.env.EMBED_BASE_URL = 'https://embeddings.internal:8443/v1';
    await resolveEmbedder(null);
    expect(warn.mock.calls[0][0]).not.toMatch(/fall(ing|s)? back|degraded/i);
  });

  it('stays silent when nothing at all is configured (the ordinary default)', async () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    expect(await resolveEmbedder(null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
