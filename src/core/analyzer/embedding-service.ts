/**
 * EmbeddingService
 *
 * Computes text embeddings via any OpenAI-compatible `/embeddings` endpoint
 * (OpenAI, Ollama, LocalAI, vLLM, LM Studio, …).
 *
 * Configuration (in priority order):
 *   1. Constructor argument `EmbeddingConfig`
 *   2. Environment variables: EMBED_BASE_URL, EMBED_MODEL, EMBED_API_KEY
 *
 * The service batches texts in groups of `batchSize` (default 64) and
 * resolves all batches sequentially to avoid overloading the server.
 */

import type { OpenLoreConfig } from '../../types/index.js';
import {
  EMBED_TLS_ENV,
  announceInsecureTls,
  envTlsOptOut,
  isInsecureTlsAllowed,
  withRelaxedTls,
} from '../services/tls-scope.js';
import { refuseRepoConfiguredEndpoint, rejectRepoConfiguredTlsOptOut } from '../services/repo-config-trust.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * The structural contract every embedder satisfies. `VectorIndex` is agnostic to
 * the embedder source — only construction differs between the remote
 * (`EmbeddingService`) and on-device (`LocalEmbeddingService`) providers.
 * See {@link resolveEmbedder} (in `embedder.ts`) for the shared provider
 * selection used by every consumer.
 */
export interface Embedder {
  /** Compute one embedding vector per input text, in the same order. */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Identifier recorded in the index metadata sidecar. Local-provider names are
   * prefixed `local:` so the served retrieval mode can be derived without
   * re-constructing the embedder.
   */
  readonly modelName: string;
}

export interface EmbeddingConfig {
  /** Base URL of the OpenAI-compatible API, e.g. "http://localhost:11434/v1" */
  baseUrl: string;
  /** Embedding model name, e.g. "nomic-embed-text" or "text-embedding-3-small" */
  model: string;
  /** API key — optional for local servers */
  apiKey?: string;
  /** Maximum number of texts per API call (default: 64) */
  batchSize?: number;
  /** Disable SSL certificate verification (e.g. self-signed certs on local servers) */
  skipSslVerify?: boolean;
}

// ============================================================================
// EMBEDDING SERVICE
// ============================================================================

export class EmbeddingService implements Embedder {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private batchSize: number;
  private relaxTls: boolean;

  /**
   * Maximum characters per text before truncation.
   * ~24 000 chars ≈ 6 000 words ≈ 8 000 tokens — stays under the 8 192-token
   * limit of most embedding models (nomic-embed-text, text-embedding-3-small…).
   */
  private static readonly MAX_CHARS_PER_TEXT = 24000;

  constructor(config: EmbeddingConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.model = config.model;
    this.apiKey = config.apiKey ?? '';
    this.batchSize = config.batchSize ?? 64;
    this.relaxTls = config.skipSslVerify === true;
    if (config.skipSslVerify) {
      announceInsecureTls('embedding.skipSslVerify');
    }
  }

  /** The configured embedding model name (recorded in the index metadata sidecar). */
  get modelName(): string {
    return this.model;
  }

  /**
   * Build an EmbeddingService from environment variables.
   * Throws if EMBED_BASE_URL or EMBED_MODEL are not set.
   */
  static fromEnv(): EmbeddingService {
    const baseUrl = process.env.EMBED_BASE_URL;
    const model = process.env.EMBED_MODEL;
    if (!baseUrl) throw new Error('EMBED_BASE_URL environment variable is required');
    if (!model) throw new Error('EMBED_MODEL environment variable is required');
    return new EmbeddingService({
      baseUrl,
      model,
      apiKey: process.env.EMBED_API_KEY,
      skipSslVerify: envTlsOptOut(EMBED_TLS_ENV),
    });
  }

  /**
   * Build a remote EmbeddingService from a OpenLoreConfig.
   * Returns null if no remote embedding config is present (missing baseUrl/model
   * or a non-remote provider). Use `resolveEmbedder` (in `embedder.ts`) to also
   * pick up the local provider.
   */
  static fromConfig(cfg: OpenLoreConfig): EmbeddingService | null {
    if (cfg.embedding?.provider === 'local') return null;
    if (!cfg.embedding?.baseUrl || !cfg.embedding?.model) return null;
    // This config is committed in the analyzed repository, and embedding ships the
    // repo's OWN SOURCE TEXT (plus any embedding key) to `baseUrl`. Unlike the LLM
    // compat endpoint there IS a safe fallback here — the local BM25 keyword index,
    // which is the zero-config default — so a non-loopback endpoint the repository
    // chose is refused rather than merely disclosed.
    const trustedBaseUrl = refuseRepoConfiguredEndpoint(
      'embedding.baseUrl',
      cfg.embedding.baseUrl,
      'Falling back to the local keyword (BM25) index; set EMBED_BASE_URL to use a remote endpoint deliberately.',
    );
    if (!trustedBaseUrl) return null;
    return new EmbeddingService({
      baseUrl: trustedBaseUrl,
      model: cfg.embedding.model,
      apiKey: cfg.embedding.apiKey,
      // The repository's own opt-out is refused (always false); the OPERATOR's
      // environment still applies, so a config-selected loopback endpoint with a
      // self-signed certificate is reachable without inventing a repo-trusted flag.
      skipSslVerify:
        rejectRepoConfiguredTlsOptOut('embedding.skipSslVerify', cfg.embedding.skipSslVerify) ||
        envTlsOptOut(EMBED_TLS_ENV),
      batchSize: cfg.embedding.batchSize,
    });
  }

  /**
   * Compute embeddings for a list of texts.
   * Returns one embedding vector per input text (same order).
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.callEmbeddingsApi(batch);
      results.push(...vectors);
    }

    return results;
  }

  private async callEmbeddingsApi(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;

    // Truncate each text to stay within the model's token limit.
    // Most embedding models (nomic-embed-text, text-embedding-3-small…) cap at
    // 8 192 tokens. Slicing at MAX_CHARS_PER_TEXT characters is a safe
    // approximation (1 token ≈ 4 chars on average).
    const truncated = texts.map(t =>
      t.length > EmbeddingService.MAX_CHARS_PER_TEXT
        ? t.slice(0, EmbeddingService.MAX_CHARS_PER_TEXT)
        : t
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // INTENTIONAL EGRESS: this feature sends repository text to the operator-selected endpoint.
    // codeql[js/file-access-to-http]
    const response = await withRelaxedTls(() => fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: truncated, model: this.model }),
    }), this.relaxTls || isInsecureTlsAllowed());

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Embedding API error ${response.status} from ${url}: ${body.slice(0, 200)}`
      );
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    if (!Array.isArray(json.data)) {
      throw new Error(`Unexpected embedding response format: missing "data" array`);
    }

    // Sort by index to guarantee order matches input
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map(d => d.embedding);
  }
}
