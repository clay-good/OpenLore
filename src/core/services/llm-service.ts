/**
 * LLM Service
 *
 * Provides a clean interface for LLM interactions with proper error handling,
 * retry logic, token management, and cost tracking.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import logger from '../../utils/logger.js';
import { redactSecrets } from './secret-redaction.js';
import { protectPrompt } from '../../utils/prompt-boundary.js';
import { announceInsecureTls, withRelaxedTls } from './tls-scope.js';
import {
  CLAUDE_MAX_CONTEXT_TOKENS,
  CLAUDE_MAX_OUTPUT_TOKENS,
  MISTRAL_VIBE_MAX_CONTEXT_TOKENS,
  MISTRAL_VIBE_MAX_OUTPUT_TOKENS,
  LLM_CLI_MAX_BUFFER_BYTES,
  LLM_CLI_TIMEOUT_MS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_COMPAT_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_INITIAL_DELAY_MS,
  DEFAULT_LLM_MAX_DELAY_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_COST_WARNING_THRESHOLD,
  CONTEXT_LIMIT_WARNING_RATIO,
  OPENLORE_DIR,
  OPENLORE_LOGS_SUBDIR,
} from '../../constants.js';

/**
 * Strip NUL bytes from a CLI prompt. Node's `child_process` rejects arguments
 * that contain a NUL ("must be a string without null bytes"), and a prompt built
 * from a git diff or file content can carry one (binary-ish content, a stray
 * control byte in source). Every CLI-based provider applies this before spawning,
 * so one bad byte never aborts an otherwise-valid call (e.g. the decisions
 * extractor consolidating a diff).
 */
export function sanitizeCliPrompt(prompt: string): string {
  return prompt.includes('\0') ? prompt.replace(/\0/g, '') : prompt;
}

function withIsolatedCliCwd<T>(run: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'openlore-llm-'));
  try {
    return run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ============================================================================
// CLAUDE CODE PROVIDER (uses local `claude` CLI, no API key required)
// ============================================================================

/**
 * Claude Code CLI provider
 *
 * Routes LLM calls through the local `claude` CLI binary in non-interactive
 * mode (`claude -p ...`).  Authentication is handled by the Claude Code session
 * (Max/Pro subscription) — no ANTHROPIC_API_KEY is required.
 */
export class ClaudeCodeProvider implements LLMProvider {
  name = 'claude-code';
  maxContextTokens = CLAUDE_MAX_CONTEXT_TOKENS;
  maxOutputTokens = CLAUDE_MAX_OUTPUT_TOKENS;
  private model: string | undefined;

  constructor(model?: string) {
    // Only pass --model if it looks like a Claude model name.
    // Ignore the sentinel 'claude-code' string and non-Claude model names
    // (e.g. 'mistral-large-latest' from a shared config).
    this.model = model && model !== 'claude-code' && model.startsWith('claude-') ? model : undefined;
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const { execFileSync } = await import('child_process');

    const fullPrompt = request.systemPrompt + request.userPrompt;
    const args = [
      '-p', sanitizeCliPrompt(request.userPrompt),
      '--system-prompt', sanitizeCliPrompt(request.systemPrompt),
      '--output-format', 'json',
      '--tools', '',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--no-chrome',
      '--setting-sources', '',
      '--no-session-persistence',
    ];
    if (this.model) args.push('--model', this.model);

    // Remove Claude Code session env vars so the CLI can run inside an existing session
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.CLAUDE_CODE_IDE_PORT;

    let raw: string;
    try {
      raw = withIsolatedCliCwd((cwd) => execFileSync('claude', args, {
        encoding: 'utf8',
        maxBuffer: LLM_CLI_MAX_BUFFER_BYTES,
        timeout: LLM_CLI_TIMEOUT_MS,
        env,
        cwd,
      }));
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; status?: number };
      const detail = e.stderr || e.stdout || e.message || String(err);
      throw Object.assign(new Error(`claude CLI failed: ${detail}`), { retryable: false });
    }

    let parsed: { result: string; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new Error(`claude CLI returned non-JSON output: ${raw.slice(0, 200)}`);
    }

    if (parsed.is_error) {
      throw Object.assign(new Error(`claude CLI error: ${parsed.result}`), { retryable: false });
    }

    const inputTokens = parsed.usage?.input_tokens ?? estimateTokens(fullPrompt);
    const outputTokens = parsed.usage?.output_tokens ?? estimateTokens(parsed.result ?? '');

    return {
      content: parsed.result ?? '',
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      model: this.model ?? 'claude-code',
      finishReason: 'stop',
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }
}

// ============================================================================
// CODEX CLI PROVIDER (uses local `codex` CLI, no cloud API key)
// ============================================================================

export class CodexCLIProvider implements LLMProvider {
  name = 'codex-cli';
  maxContextTokens = 1_000_000;
  maxOutputTokens = 8_192;
  private model: string | undefined;

  constructor(model?: string) {
    this.model = model && model !== 'codex-cli' ? model : undefined;
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const { execFileSync } = await import('child_process');
    const fullPrompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.userPrompt}`
      : request.userPrompt;
    const bin = process.env.CODEX_CLI ?? 'codex';

    let content: string;
    try {
      content = withIsolatedCliCwd((cwd) => {
        const outputPath = join(cwd, 'response.txt');
        const args = [
          'exec',
          '--sandbox', 'read-only',
          '--ignore-user-config',
          '--ignore-rules',
          '--ephemeral',
          '--skip-git-repo-check',
          '--color', 'never',
          '--output-last-message', outputPath,
          '--cd', cwd,
        ];
        if (this.model) args.push('--model', this.model);
        args.push(sanitizeCliPrompt(fullPrompt));
        execFileSync(bin, args, {
          encoding: 'utf8',
          maxBuffer: LLM_CLI_MAX_BUFFER_BYTES,
          timeout: LLM_CLI_TIMEOUT_MS,
          cwd,
        });
        return readFileSync(outputPath, 'utf8').trim();
      });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const detail = e.stderr ?? e.stdout ?? e.message ?? String(err);
      throw Object.assign(new Error(`codex CLI failed: ${detail}`), { retryable: false });
    }

    const inputTokens = estimateTokens(fullPrompt);
    const outputTokens = estimateTokens(content);
    return {
      content,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      model: this.model ?? 'codex-cli',
      finishReason: 'stop',
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }
}

// ============================================================================
// MISTRAL VIBE PROVIDER (uses local `mistral-vibe` CLI, no API key required)
// ============================================================================

/**
 * Mistral Vibe CLI provider
 *
 * Routes LLM calls through the local `mistral-vibe` CLI binary (standalone, no npm).
 * No API key required — uses local LLM execution.
 * If the binary is not on PATH, set MISTRAL_VIBE_CLI to its full path.
 * The CLI is invoked as `vibe` (not `mistral-vibe`).
 */
export class MistralVibeProvider implements LLMProvider {
  name = 'mistral-vibe';
  maxContextTokens = MISTRAL_VIBE_MAX_CONTEXT_TOKENS;
  maxOutputTokens = MISTRAL_VIBE_MAX_OUTPUT_TOKENS;
  private model: string | undefined;

  constructor(model?: string) {
    // Ignore the sentinel 'mistral-vibe' string — let the CLI pick the default
    this.model = model && model !== 'mistral-vibe' ? model : undefined;
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const { execFileSync } = await import('child_process');

    // Mistral Vibe CLI takes a single prompt; combine system + user prompts
    const fullPrompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.userPrompt}`
      : request.userPrompt;

    // vibe CLI: -p for prompt, --output json for JSON, --agent for model/agent name
    const args = ['-p', sanitizeCliPrompt(fullPrompt), '--output', 'json', '--enabled-tools', ''];
    if (this.model) args.push('--agent', this.model);

    // Use MISTRAL_VIBE_CLI if set (standalone install not on PATH), else 'vibe'
    const mistralVibeBin = process.env.MISTRAL_VIBE_CLI ?? 'vibe';

    let raw: string;
    try {
      raw = withIsolatedCliCwd((cwd) => execFileSync(mistralVibeBin, args, {
        encoding: 'utf8',
        maxBuffer: LLM_CLI_MAX_BUFFER_BYTES,
        timeout: LLM_CLI_TIMEOUT_MS,
        cwd,
      }));
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; status?: number };
      const detail = e.stderr ?? e.stdout ?? e.message ?? String(err);
      throw Object.assign(new Error(`mistral-vibe CLI failed: ${detail}`), { retryable: false });
    }

    // Defensive parsing: vibe --output json format is undocumented.
    // Try multiple known shapes before falling back to raw text.
    let content = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const parsed = JSON.parse(raw) as unknown;

      if (Array.isArray(parsed)) {
        // Shape: [{role, content}, ...] — "all messages at end"
        const msgs = parsed as Array<Record<string, unknown>>;
        const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
        content = String(lastAssistant?.content ?? '');
      } else if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Record<string, unknown>;
        // Shape: {result: string, usage?: {...}} — Claude Code-style
        if (typeof p.result === 'string') {
          content = p.result;
          const u = p.usage as Record<string, number> | undefined;
          inputTokens = u?.input_tokens;
          outputTokens = u?.output_tokens;
        // Shape: {message: string} or {text: string} or {content: string}
        } else {
          content = String(p.message ?? p.text ?? p.content ?? '');
        }
      }
    } catch {
      // non-JSON output: use raw text
    }

    if (!content) content = raw.trim();
    inputTokens ??= estimateTokens(fullPrompt);
    outputTokens ??= estimateTokens(content);

    return {
      content,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      model: this.model ?? 'mistral-vibe',
      finishReason: 'stop',
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Completion request parameters
 */
export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?: 'text' | 'json';
  /** JSON Schema for structured output (used by OpenAI-compatible providers). */
  jsonSchema?: object;
}

/**
 * Completion response
 */
export interface CompletionResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  model: string;
  finishReason: 'stop' | 'length' | 'error';
}

/**
 * LLM provider interface
 */
export interface LLMProvider {
  name: string;
  generateCompletion(request: CompletionRequest): Promise<CompletionResponse>;
  countTokens(text: string): number;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export type ProviderName = 'anthropic' | 'openai' | 'openai-compat' | 'copilot' | 'gemini' | 'gemini-cli' | 'antigravity-cli' | 'claude-code' | 'codex-cli' | 'mistral-vibe' | 'cursor-agent';

/**
 * Token usage tracking
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

/**
 * Cost tracking
 */
export interface CostTracking {
  estimatedCost: number;
  currency: string;
  byProvider: Record<string, number>;
}

/**
 * LLM service options
 */
export interface LLMServiceOptions {
  /** Primary provider to use */
  provider?: ProviderName;
  /** Model override */
  model?: string;
  /** Custom API base URL (e.g., for local/enterprise OpenAI-compatible servers) */
  apiBase?: string;
  /** Disable SSL verification (for internal/self-signed certificates) */
  sslVerify?: boolean;
  /** Base URL for openai-compat provider (overrides OPENAI_COMPAT_BASE_URL env var) */
  openaiCompatBaseUrl?: string;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Initial retry delay in ms */
  initialDelay?: number;
  /** Maximum retry delay in ms */
  maxDelay?: number;
  /** Request timeout in ms */
  timeout?: number;
  /** Cost warning threshold in USD */
  costWarningThreshold?: number;
  /** Log directory for prompts/responses */
  logDir?: string;
  /** Enable prompt logging */
  enableLogging?: boolean;
  /** Disable response_format field in requests (for endpoints that don't support it) */
  disableResponseFormat?: boolean;
}

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  timeout: number;
}

// ============================================================================
// SSL / FETCH HELPERS
// ============================================================================

/**
 * Record the user's TLS opt-out. The relaxation itself is applied per request by
 * `withRelaxedTls` around each `fetch`, so verification is not left off for the
 * lifetime of the process (see tls-scope.ts).
 */
function disableSslVerification(): void {
  announceInsecureTls('--insecure or llm.sslVerify=false');
}

/**
 * Blank long opaque alphanumeric runs in the PROMPTS only.
 *
 * The shared redactor matches credential SHAPES (`sk-…`, `AIza…`, header forms). A
 * prompt additionally carries the repository's own source text, where a hardcoded key
 * for some provider OpenLore knows nothing about has no recognizable shape — so this
 * keeps the blanket heuristic the removed private redactor applied. It stays scoped to
 * the two prompt fields because it is lossy (it also blanks legitimate hashes), and a
 * mangled response/error would make the log useless for its actual purpose.
 */
function blankLongOpaqueTokens(request: CompletionRequest): CompletionRequest {
  const blank = (s: string): string =>
    s
      .replace(/(?:api[_-]?key|password|secret|token|auth)['":\s]*[=:]\s*['"]?[\w-]{20,}['"]?/gi, '[REDACTED]')
      .replace(/['"]?[a-zA-Z0-9]{32,}['"]?/g, '[REDACTED]');
  return { ...request, systemPrompt: blank(request.systemPrompt), userPrompt: blank(request.userPrompt) };
}

/**
 * Validate and normalise an API base URL.
 * Returns the cleaned URL or throws on invalid input.
 */
function normalizeApiBase(url: string): string {
  // Must be a valid, absolute URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid API base URL: "${url}". Must be a valid URL (e.g., http://localhost:8000/v1).`);
  }

  // Only allow http and https schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol in API base URL: "${parsed.protocol}". Only http and https are allowed.`);
  }

  // Strip trailing slashes for consistent path joining
  return parsed.toString().replace(/\/+$/, '');
}

// ============================================================================
// RETRY-AFTER PARSING
// ============================================================================

/**
 * Parse the number of milliseconds to wait before retrying a 429 response.
 *
 * Checks (in order):
 *  1. Standard `Retry-After` HTTP header (seconds as integer, or HTTP-date)
 *  2. `Limit resets at: YYYY-MM-DD HH:MM:SS UTC` in the response body
 *
 * Returns `undefined` when nothing useful is found so the caller can fall back
 * to its own exponential-backoff delay.
 */
export function parseRetryAfterMs(body: string, retryAfterHeader?: string | null): number | undefined {
  const BUFFER_MS = 500; // small buffer to avoid hitting the wall again immediately

  // 1. Retry-After header
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000) + BUFFER_MS;
    }
    // HTTP-date format
    const headerDate = Date.parse(retryAfterHeader);
    if (!isNaN(headerDate)) {
      const ms = headerDate - Date.now();
      if (ms > 0) return ms + BUFFER_MS;
    }
  }

  // 2. "Limit resets at: YYYY-MM-DD HH:MM:SS UTC" in body
  const match = body.match(/Limit resets at:\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*UTC)/i);
  if (match) {
    const resetMs = Date.parse(match[1].replace(' UTC', 'Z').replace(' ', 'T'));
    if (!isNaN(resetMs)) {
      const ms = resetMs - Date.now();
      if (ms > 0) return ms + BUFFER_MS;
    }
  }

  return undefined;
}

// ============================================================================
// PRICING (per 1M tokens)
// ============================================================================

const PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  anthropic: {
    // Claude 4 family
    'claude-opus-4':    { input: 15.0, output: 75.0 },
    'claude-sonnet-4':  { input: 3.0,  output: 15.0 },
    'claude-haiku-4':   { input: 0.80, output: 4.0  },
    // Claude 3.7 / 3.5
    'claude-3-7-sonnet': { input: 3.0,  output: 15.0 },
    'claude-3-5-sonnet': { input: 3.0,  output: 15.0 },
    'claude-3-5-haiku':  { input: 0.80, output: 4.0  },
    // Claude 3 (legacy)
    'claude-3-opus':    { input: 15.0, output: 75.0 },
    'claude-3-sonnet':  { input: 3.0,  output: 15.0 },
    'claude-3-haiku':   { input: 0.25, output: 1.25 },
    // Fallback: assume Sonnet-class pricing
    default: { input: 3.0, output: 15.0 },
  },
  openai: {
    // GPT-4o family
    'gpt-4o':              { input: 2.5,  output: 10.0 },
    'gpt-4o-mini':         { input: 0.15, output: 0.6  },
    // o-series reasoning models
    'o1':                  { input: 15.0, output: 60.0 },
    'o1-mini':             { input: 3.0,  output: 12.0 },
    'o3':                  { input: 10.0, output: 40.0 },
    'o3-mini':             { input: 1.1,  output: 4.4  },
    'o4-mini':             { input: 1.1,  output: 4.4  },
    // Legacy (still in use)
    'gpt-4-turbo':         { input: 10.0, output: 30.0 },
    'gpt-4':               { input: 30.0, output: 60.0 },
    'gpt-3.5-turbo':       { input: 0.5,  output: 1.5  },
    default: { input: 2.5, output: 10.0 },
  },
  'openai-compat': {
    // Mistral
    'mistral-large-latest':  { input: 2.0,  output: 6.0  },
    'mistral-small-latest':  { input: 0.1,  output: 0.3  },
    'codestral-latest':      { input: 0.2,  output: 0.6  },
    // Groq
    'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
    'llama-3.1-8b-instant':    { input: 0.05, output: 0.08 },
    default: { input: 1.0, output: 3.0 },
  },
  gemini: {
    'gemini-2.0-flash':      { input: 0.1,   output: 0.4  },
    'gemini-2.0-flash-lite': { input: 0.075, output: 0.3  },
    'gemini-2.5-pro':        { input: 1.25,  output: 10.0 },
    'gemini-1.5-pro':        { input: 1.25,  output: 5.0  },
    'gemini-1.5-flash':      { input: 0.075, output: 0.3  },
    default: { input: 0.1, output: 0.4 },
  },
  'claude-code': {
    // No per-token cost: covered by Claude Max/Pro subscription
    default: { input: 0, output: 0 },
  },
  'mistral-vibe': {
    // No per-token cost: local CLI tool
    default: { input: 0, output: 0 },
  },
  'gemini-cli': {
    // No per-token cost: covered by Google account free tier
    default: { input: 0, output: 0 },
  },
  'antigravity-cli': {
    // No per-token cost in openlore: Google account / Antigravity subscription
    default: { input: 0, output: 0 },
  },
  'codex-cli': {
    // No per-token cost in openlore: ChatGPT subscription / CLI auth
    default: { input: 0, output: 0 },
  },
  'cursor-agent': {
    // No per-token cost in openlore: Cursor subscription / CLI auth
    default: { input: 0, output: 0 },
  },
  copilot: {
    // No per-token cost: covered by GitHub Copilot subscription
    default: { input: 0, output: 0 },
  },
};

/**
 * Exported for use in pre-flight cost estimation.
 * Look up pricing for a model ID using prefix/family matching.
 * Exact match first, then longest prefix match, then provider default.
 *
 * This is robust to minor version suffixes like "claude-sonnet-4-6-20251120"
 * matching the "claude-sonnet-4" family entry.
 */
export function lookupPricing(
  providerName: string,
  modelId: string
): { input: number; output: number } {
  const table = PRICING[providerName] ?? PRICING.anthropic;

  // 1. Exact match
  if (table[modelId]) return table[modelId];

  // 2. Longest prefix match (handles "claude-sonnet-4-6-20251120" → "claude-sonnet-4")
  const modelLower = modelId.toLowerCase();
  let bestKey = '';
  for (const key of Object.keys(table)) {
    if (key === 'default') continue;
    if (modelLower.startsWith(key) && key.length > bestKey.length) {
      bestKey = key;
    }
  }
  if (bestKey) return table[bestKey];

  // 3. Provider default
  return table.default ?? { input: 3.0, output: 15.0 };
}

// ============================================================================
// TOKEN ESTIMATION
// ============================================================================

/**
 * Estimate token count from text (rough approximation)
 * ~4 characters per token for English text
 */
export function estimateTokens(text: string): number {
  // More accurate estimation considering code
  // Code tends to have more tokens per character due to special chars
  const codePatterns = /[{}()[\];:,.<>/\\|`~!@#$%^&*=+]/g;
  const codeCharCount = (text.match(codePatterns) || []).length;
  const regularCharCount = text.length - codeCharCount;

  // Regular text: ~4 chars per token, code chars: ~2 chars per token
  return Math.ceil(regularCharCount / 4 + codeCharCount / 2);
}

/**
 * Coerce an untrusted token count from a provider's `usage` block to a finite,
 * non-negative number. Many OpenAI-compatible gateways (Ollama, LM Studio, some
 * proxies) omit `usage` entirely; without this a missing field throws (object
 * undefined) or poisons cost tracking with NaN (every later `+= NaN` stays NaN).
 */
function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

// ============================================================================
// ANTHROPIC PROVIDER
// ============================================================================

/**
 * Anthropic Claude provider
 */
export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  maxContextTokens = 200000;
  maxOutputTokens = 4096;

  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private relaxTls: boolean;

  constructor(apiKey: string, model = DEFAULT_ANTHROPIC_MODEL, baseUrl?: string, sslVerify = true) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl ? normalizeApiBase(baseUrl) : 'https://api.anthropic.com/v1';
    this.relaxTls = !sslVerify;
    if (!sslVerify) disableSslVerification();
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await withRelaxedTls(() => fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? this.maxOutputTokens,
        temperature: request.temperature ?? 0.3,
        system: request.systemPrompt,
        messages: [
          { role: 'user', content: request.userPrompt },
        ],
        stop_sequences: request.stopSequences,
      }),
    }), this.relaxTls);

    if (!response.ok) {
      const error = await response.text();
      const errorObj = this.parseError(error, response.status, response.headers.get('retry-after'));
      throw errorObj;
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
      stop_reason: string;
    };

    // `content` may be absent on a malformed/error-shaped 200 (some gateways do this).
    const content = (Array.isArray(data.content) ? data.content : [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('');

    const inputTokens = tokenCount(data.usage?.input_tokens);
    const outputTokens = tokenCount(data.usage?.output_tokens);
    return {
      content,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      model: data.model,
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason === 'max_tokens' ? 'length' : 'error',
    };
  }

  private parseError(error: string, status: number, retryAfterHeader?: string | null): Error & { status?: number; retryable?: boolean; retryAfterMs?: number } {
    const detail = error.trim() || '(empty response body)';
    const err = new Error(`HTTP ${status}: ${detail}`) as Error & { status?: number; retryable?: boolean; retryAfterMs?: number };
    err.status = status;
    err.retryable = status === 429 || status >= 500;
    if (status === 429) {
      err.retryAfterMs = parseRetryAfterMs(error, retryAfterHeader);
    }
    return err;
  }
}

// ============================================================================
// OPENAI PROVIDER
// ============================================================================

/**
 * Wrap a top-level array schema in an object so it satisfies OpenAI's
 * structured-output requirement that the root type is "object".
 * The existing unwrap logic in completeJSON (single-key object → array)
 * reverses this transparently.  See: #52
 */
function wrapArraySchema(schema: object): object {
  if ((schema as Record<string, unknown>).type === 'array') {
    return {
      type: 'object',
      properties: { items: schema },
      required: ['items'],
    };
  }
  return schema;
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!isSchemaRecord(schema)) return false;

  const type = schema.type;
  if (type === 'null') return true;
  if (Array.isArray(type) && type.includes('null')) return true;

  for (const key of ['anyOf', 'oneOf']) {
    const schemas = schema[key];
    if (Array.isArray(schemas) && schemas.some(schemaAllowsNull)) {
      return true;
    }
  }

  return false;
}

function makeSchemaNullable(schema: unknown): unknown {
  if (schemaAllowsNull(schema)) return schema;

  if (isSchemaRecord(schema)) {
    const type = schema.type;
    if (typeof type === 'string') {
      schema.type = [type, 'null'];
      return schema;
    }
  }

  return { anyOf: [schema, { type: 'null' }] };
}

function normalizeOpenAISchemaNode(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      normalizeOpenAISchemaNode(item);
    }
    return;
  }

  if (!isSchemaRecord(node)) return;

  const isObjectSchema = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));

  if (isObjectSchema) {
    const properties = isSchemaRecord(node.properties) ? node.properties : {};
    const originalRequired = new Set(
      Array.isArray(node.required)
        ? node.required.filter((field): field is string => typeof field === 'string')
        : [],
    );

    node.properties = properties;
    node.additionalProperties = false;
    node.required = Object.keys(properties);

    for (const [key, propertySchema] of Object.entries(properties)) {
      normalizeOpenAISchemaNode(propertySchema);
      if (!originalRequired.has(key)) {
        properties[key] = makeSchemaNullable(properties[key]);
      }
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (isObjectSchema && key === 'properties') continue;
    normalizeOpenAISchemaNode(value);
  }
}

function normalizeOpenAIResponseSchema(schema: object): object {
  const clonedSchema = JSON.parse(JSON.stringify(schema)) as object;
  const wrappedSchema = wrapArraySchema(clonedSchema);
  normalizeOpenAISchemaNode(wrappedSchema);
  return wrappedSchema;
}

/**
 * OpenAI provider
 */
export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  maxContextTokens = 128000;
  maxOutputTokens = 4096;

  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private relaxTls: boolean;

  constructor(apiKey: string, model = DEFAULT_OPENAI_MODEL, baseUrl?: string, sslVerify = true) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl ? normalizeApiBase(baseUrl) : 'https://api.openai.com/v1';
    this.relaxTls = !sslVerify;
    if (!sslVerify) disableSslVerification();
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? this.maxOutputTokens,
      temperature: request.temperature ?? 0.3,
      stop: request.stopSequences,
    };

    if (request.responseFormat === 'json' && request.jsonSchema) {
      // Use OpenAI structured outputs when a JSON schema is provided.
      // This forces the model to conform to the schema (e.g. start an array). (#26)
      // Wrap top-level array schemas in an object to satisfy OpenAI's requirement. (#52)
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: normalizeOpenAIResponseSchema(request.jsonSchema),
        },
      };
    } else if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const response = await withRelaxedTls(() => fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    }), this.relaxTls);

    if (!response.ok) {
      const error = await response.text();
      const errorObj = this.parseError(error, response.status, response.headers.get('retry-after'));
      throw errorObj;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model: string;
    };

    const inputTokens = tokenCount(data.usage?.prompt_tokens);
    const outputTokens = tokenCount(data.usage?.completion_tokens);
    return {
      content: data.choices[0]?.message?.content ?? '',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: tokenCount(data.usage?.total_tokens) || inputTokens + outputTokens,
      },
      model: data.model,
      finishReason: data.choices[0]?.finish_reason === 'stop' ? 'stop' : data.choices[0]?.finish_reason === 'length' ? 'length' : 'error',
    };
  }

  private parseError(error: string, status: number, retryAfterHeader?: string | null): Error & { status?: number; retryable?: boolean; retryAfterMs?: number } {
    const detail = error.trim() || '(empty response body)';
    const err = new Error(`HTTP ${status}: ${detail}`) as Error & { status?: number; retryable?: boolean; retryAfterMs?: number };
    err.status = status;
    err.retryable = status === 429 || status >= 500;
    if (status === 429) {
      err.retryAfterMs = parseRetryAfterMs(error, retryAfterHeader);
    }
    return err;
  }
}

// ============================================================================
// OPENAI-COMPATIBLE PROVIDER
// ============================================================================

/**
 * Generic OpenAI-compatible provider.
 * Works with any API that implements the OpenAI chat completions format:
 * Mistral AI, Groq, Together AI, Ollama, LM Studio, etc.
 *
 * Required env vars:
 *   OPENAI_COMPAT_API_KEY   — API key (use "ollama" for local setups without auth)
 *   OPENAI_COMPAT_BASE_URL  — Base URL, e.g. https://api.mistral.ai/v1
 */
interface ModelInfo {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}
export class OpenAICompatibleProvider implements LLMProvider {
  name = 'openai-compat';
  maxContextTokens = 128000;
  maxOutputTokens = 4096;

  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private disableResponseFormat: boolean;
  private relaxTls: boolean;

  constructor(apiKey: string, baseUrl: string, model = DEFAULT_OPENAI_COMPAT_MODEL, disableResponseFormat = false, sslVerify = true) {
    this.apiKey = apiKey;
    this.baseUrl = normalizeApiBase(baseUrl);
    this.model = model;
    this.disableResponseFormat = disableResponseFormat;
    this.relaxTls = !sslVerify;
    if (!sslVerify) disableSslVerification();
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  /**
   * Fetch available models from the API endpoint
   */
  private async fetchAvailableModels(): Promise<string[]> {
    try {
      const response = await withRelaxedTls(() => fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      }), this.relaxTls);

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { data: ModelInfo[] };
      return data.data?.map(model => model.id).sort() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Get known models for common API endpoints when /models is not available
   */
  private getKnownModelsForEndpoint(): string[] {
    const url = this.baseUrl.toLowerCase();

    if (url.includes('codestral.mistral.ai')) {
      return ['codestral-2508', 'codestral-latest'];
    }

    if (url.includes('api.mistral.ai')) {
      return [
        'mistral-large-3-25-12',
        'mistral-medium-3-1-25-08',
        'mistral-small-4-0-26-03',
        'mistral-nemo-12b-24-07',
        'codestral-2508',
        'devstral-2-25-12'
      ];
    }

    if (url.includes('api.openai.com')) {
      return [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-4',
        'gpt-3.5-turbo'
      ];
    }

    if (url.includes('api.groq.com')) {
      return [
        'llama-3.1-70b-versatile',
        'llama-3.1-8b-instant',
        'mixtral-8x7b-32768'
      ];
    }

    // For unknown endpoints, return empty array
    return [];
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      max_tokens: request.maxTokens ?? this.maxOutputTokens,
      temperature: request.temperature ?? 0.3,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.stopSequences && { stop: request.stopSequences }),
    };

    if (!this.disableResponseFormat) {
      if (request.responseFormat === 'json' && request.jsonSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            schema: normalizeOpenAIResponseSchema(request.jsonSchema),
          },
        };
      } else if (request.responseFormat === 'json') {
        body.response_format = { type: 'json_object' };
      }
    }

    const response = await withRelaxedTls(() => fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    }), this.relaxTls);

    if (!response.ok) {
      const error = await response.text();
      const detail = error.trim() || '(empty response body)';
      const err = new Error(`HTTP ${response.status}: ${detail}`) as Error & { status?: number; retryable?: boolean; retryAfterMs?: number };
      err.status = response.status;
      err.retryable = response.status === 429 || response.status >= 500;
      if (response.status === 429) {
        err.retryAfterMs = parseRetryAfterMs(error, response.headers.get('retry-after'));
      }
      throw err;
    }

    let content = '';
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finishReason: 'stop' | 'length' | 'error' = 'stop';
    let model = this.model;

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break outer;
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            model?: string;
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) content += delta;
          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr === 'length' ? 'length' : 'stop';
          if (chunk.model) model = chunk.model;
          if (chunk.usage) {
            const inputTokens = tokenCount(chunk.usage.prompt_tokens);
            const outputTokens = tokenCount(chunk.usage.completion_tokens);
            usage = {
              inputTokens,
              outputTokens,
              totalTokens: tokenCount(chunk.usage.total_tokens) || inputTokens + outputTokens,
            };
          }
        } catch { /* ignore malformed SSE chunks */ }
      }
    }

    return { content, usage, model, finishReason };
  }
}

// ============================================================================
// COPILOT PROVIDER (via copilot-api proxy — OpenAI-compatible)
// ============================================================================

/**
 * GitHub Copilot provider via copilot-api proxy.
 * Requires a running copilot-api proxy (https://github.com/ericc-ch/copilot-api)
 * which exposes an OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Required env vars:
 *   COPILOT_API_BASE_URL — Base URL of the copilot-api proxy (default: http://localhost:4141/v1)
 *
 * Optional env vars:
 *   COPILOT_API_KEY      — API key if the proxy requires auth (default: "copilot")
 */
export class CopilotProvider implements LLMProvider {
  name = 'copilot';
  maxContextTokens = 128000;
  maxOutputTokens = 4096;

  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private relaxTls: boolean;

  constructor(baseUrl: string, model = DEFAULT_COPILOT_MODEL, apiKey = 'copilot', sslVerify = true) {
    this.apiKey = apiKey;
    this.baseUrl = normalizeApiBase(baseUrl);
    this.model = model;
    this.relaxTls = !sslVerify;
    if (!sslVerify) disableSslVerification();
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      max_tokens: request.maxTokens ?? this.maxOutputTokens,
      temperature: request.temperature ?? 0.3,
      ...(request.stopSequences && { stop: request.stopSequences }),
    };

    if (request.responseFormat === 'json' && request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: wrapArraySchema(request.jsonSchema),
        },
      };
    } else if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const response = await withRelaxedTls(() => fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    }), this.relaxTls);

    if (!response.ok) {
      const error = await response.text();
      const detail = error.trim() || '(empty response body)';
      const err = new Error(`HTTP ${response.status}: ${detail}`) as Error & { status?: number; retryable?: boolean; retryAfterMs?: number };
      err.status = response.status;
      err.retryable = response.status === 429 || response.status >= 500;
      if (response.status === 429) {
        err.retryAfterMs = parseRetryAfterMs(error, response.headers.get('retry-after'));
      }

      throw err;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model: string;
    };

    const inputTokens = tokenCount(data.usage?.prompt_tokens);
    const outputTokens = tokenCount(data.usage?.completion_tokens);
    return {
      content: data.choices[0]?.message?.content ?? '',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: tokenCount(data.usage?.total_tokens) || inputTokens + outputTokens,
      },
      model: data.model ?? this.model,
      finishReason: data.choices[0]?.finish_reason === 'stop' ? 'stop' : data.choices[0]?.finish_reason === 'length' ? 'length' : 'error',
    };
  }
}

// ============================================================================
// GEMINI CLI PROVIDER (uses local `gemini` CLI, no API key required)
// ============================================================================

/**
 * Gemini CLI provider
 *
 * Routes LLM calls through the local `gemini` CLI binary in non-interactive
 * mode (`gemini -p ...`).  Authentication is handled by the Google account
 * session — no GEMINI_API_KEY is required.
 * If the binary is not on PATH, set GEMINI_CLI to its full path.
 */
export class GeminiCLIProvider implements LLMProvider {
  name = 'gemini-cli';
  maxContextTokens = 1_000_000;
  maxOutputTokens = 8_192;
  private model: string | undefined;

  constructor(model?: string) {
    this.model = model && model !== 'gemini-cli' ? model : undefined;
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const { execFileSync } = await import('child_process');

    const fullPrompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.userPrompt}`
      : request.userPrompt;

    // Gemini has no tool-disable flag. Its default approval mode is the
    // restricted fail-closed mode for headless calls; no tool is pre-approved,
    // and extensions are disabled so project configuration cannot add tools.
    const geminiCLIBin = process.env.GEMINI_CLI ?? 'gemini';

    let raw: string;
    try {
      raw = withIsolatedCliCwd((cwd) => {
        const policyPath = join(cwd, 'deny-all-tools.toml');
        writeFileSync(policyPath, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n');
        const args = [
          '-p', sanitizeCliPrompt(fullPrompt),
          '--output-format', 'json',
          '--approval-mode', 'default',
          '--admin-policy', policyPath,
          '--extensions', 'none',
        ];
        if (this.model) args.push('-m', this.model);
        return execFileSync(geminiCLIBin, args, {
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024,
          timeout: 300_000,
          cwd,
        });
      });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const detail = e.stderr ?? e.stdout ?? e.message ?? String(err);
      throw Object.assign(new Error(`gemini CLI failed: ${detail}`), { retryable: false });
    }

    // Format: {response: string, stats: {models: {[name]: {tokens: {input, candidates, total}}}}}
    let content: string;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let modelUsed = this.model ?? 'gemini-cli';

    try {
      const parsed = JSON.parse(raw) as {
        response?: string;
        stats?: { models?: Record<string, { tokens?: { input?: number; candidates?: number; total?: number } }> };
      };

      content = parsed.response ?? '';

      if (parsed.stats?.models) {
        const models = Object.entries(parsed.stats.models);
        if (models.length > 0) {
          modelUsed = models[0][0];
          // Sum tokens across all models used (gemini-cli may use multiple internally)
          inputTokens = models.reduce((sum, [, m]) => sum + (m.tokens?.input ?? 0), 0);
          outputTokens = models.reduce((sum, [, m]) => sum + (m.tokens?.candidates ?? 0), 0);
        }
      }
    } catch {
      content = raw.trim();
    }

    if (!content) content = raw.trim();
    inputTokens ??= estimateTokens(fullPrompt);
    outputTokens ??= estimateTokens(content);

    return {
      content,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      model: modelUsed,
      finishReason: 'stop',
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }
}

// ============================================================================
// ANTIGRAVITY CLI PROVIDER (Google Gemini agent family)
// ============================================================================

export class AntigravityCLIProvider implements LLMProvider {
  name = 'antigravity-cli';
  maxContextTokens = 1_000_000;
  maxOutputTokens = 8_192;
  private model: string | undefined;

  constructor(model?: string) {
    this.model = model && model !== 'antigravity-cli' ? model : undefined;
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const { execFileSync } = await import('child_process');
    const fullPrompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.userPrompt}`
      : request.userPrompt;
    const args = ['--sandbox', '-p', sanitizeCliPrompt(fullPrompt)];
    if (this.model) args.push('--model', this.model);
    const bin = process.env.ANTIGRAVITY_CLI ?? 'agy';

    let content: string;
    try {
      content = withIsolatedCliCwd((cwd) => execFileSync(bin, args, {
        encoding: 'utf8',
        maxBuffer: LLM_CLI_MAX_BUFFER_BYTES,
        timeout: LLM_CLI_TIMEOUT_MS,
        cwd,
      }).trim());
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const detail = e.stderr ?? e.stdout ?? e.message ?? String(err);
      throw Object.assign(new Error(`antigravity CLI failed: ${detail}`), { retryable: false });
    }

    const inputTokens = estimateTokens(fullPrompt);
    const outputTokens = estimateTokens(content);
    return {
      content,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      model: this.model ?? 'antigravity-cli',
      finishReason: 'stop',
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }
}

// ============================================================================
// CURSOR AGENT CLI PROVIDER (uses local `cursor-agent` CLI, no cloud API key)
// ============================================================================

/**
 * Cursor Agent CLI provider
 *
 * Routes LLM calls through the Cursor Agent CLI in print mode (`-p`, JSON output).
 * Authentication is handled by Cursor (see Cursor CLI headless documentation) —
 * e.g. `cursor-agent login` or `CURSOR_API_KEY` — not ANTHROPIC_API_KEY / OPENAI_API_KEY.
 * If the binary is not on PATH, set `CURSOR_AGENT_CLI` to its full path.
 */
export class CursorAgentProvider implements LLMProvider {
  name = 'cursor-agent';
  maxContextTokens = 1_000_000;
  maxOutputTokens = 8192;
  private model: string | undefined;

  constructor(model?: string) {
    this.model = model && model !== 'cursor-agent' ? model : undefined;
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const { execFileSync } = await import('child_process');

    const fullPrompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.userPrompt}`
      : request.userPrompt;

    // Ask mode is Cursor's read-only restricted-permission mode. Print mode
    // otherwise has full write and shell access.
    const args = ['-p', sanitizeCliPrompt(fullPrompt), '--output-format', 'json', '--mode=ask'];
    if (this.model) args.push('--model', this.model);

    const bin = process.env.CURSOR_AGENT_CLI ?? 'cursor-agent';

    let raw: string;
    try {
      raw = withIsolatedCliCwd((cwd) => execFileSync(bin, args, {
        encoding: 'utf8',
        maxBuffer: LLM_CLI_MAX_BUFFER_BYTES,
        timeout: LLM_CLI_TIMEOUT_MS,
        cwd,
      }));
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; status?: number };
      const detail = e.stderr ?? e.stdout ?? e.message ?? String(err);
      throw Object.assign(new Error(`cursor-agent CLI failed: ${detail}`), { retryable: false });
    }

    let content: string;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (parsed.is_error === true && typeof parsed.result === 'string') {
        throw Object.assign(new Error(`cursor-agent CLI error: ${parsed.result}`), { retryable: false });
      }

      if (typeof parsed.result === 'string') {
        content = parsed.result;
      } else if (typeof parsed.response === 'string') {
        content = parsed.response;
      } else {
        content = String(parsed.message ?? parsed.text ?? parsed.content ?? '');
      }

      const u = parsed.usage as Record<string, number | undefined> | undefined;
      if (u) {
        inputTokens = (u.input_tokens ?? u.inputTokens) as number | undefined;
        outputTokens = (u.output_tokens ?? u.outputTokens) as number | undefined;
      }
    } catch (err: unknown) {
      if (err instanceof Error && /cursor-agent CLI error:/.test(err.message)) throw err;
      content = raw.trim();
    }

    if (!content) content = raw.trim();
    inputTokens ??= estimateTokens(fullPrompt);
    outputTokens ??= estimateTokens(content);

    return {
      content,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      model: this.model ?? 'cursor-agent',
      finishReason: 'stop',
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }
}

// ============================================================================
// GEMINI PROVIDER
// ============================================================================

/**
 * Google Gemini provider
 */
export class GeminiProvider implements LLMProvider {
  name = 'gemini';
  maxContextTokens = 1000000;
  maxOutputTokens = 8192;

  private apiKey: string;
  private model: string;
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
  private relaxTls: boolean;

  constructor(apiKey: string, model = DEFAULT_GEMINI_MODEL, sslVerify = true) {
    this.apiKey = apiKey;
    this.model = model;
    this.relaxTls = !sslVerify;
    if (!sslVerify) disableSslVerification();
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      contents: [
        { role: 'user', parts: [{ text: request.userPrompt }] },
      ],
      systemInstruction: {
        parts: [{ text: request.systemPrompt }],
      },
      generationConfig: {
        temperature: request.temperature ?? 0.3,
        maxOutputTokens: request.maxTokens ?? this.maxOutputTokens,
        ...(request.responseFormat === 'json' && { responseMimeType: 'application/json' }),
        ...(request.responseFormat === 'json' && request.jsonSchema && { responseSchema: request.jsonSchema }),
        ...(request.stopSequences && { stopSequences: request.stopSequences }),
      },
    };

    const url = `${this.baseUrl}/${this.model}:generateContent?key=${this.apiKey}`;
    const response = await withRelaxedTls(() => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), this.relaxTls);

    if (!response.ok) {
      const error = await response.text();
      const detail = error.trim() || '(empty response body)';
      const err = new Error(`HTTP ${response.status}: ${detail}`) as Error & { status?: number; retryable?: boolean; retryAfterMs?: number };
      err.status = response.status;
      err.retryable = response.status === 429 || response.status >= 500;
      if (response.status === 429) {
        err.retryAfterMs = parseRetryAfterMs(error, response.headers.get('retry-after'));
      }
      throw err;
    }

    const data = await response.json() as {
      candidates: Array<{
        content: { parts: Array<{ text: string }>; role: string };
        finishReason: string;
      }>;
      usageMetadata: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
      };
    };

    const content = data.candidates[0]?.content?.parts?.map(p => p.text).join('') ?? '';
    const finishReason = data.candidates[0]?.finishReason;

    const inputTokens = tokenCount(data.usageMetadata?.promptTokenCount);
    const outputTokens = tokenCount(data.usageMetadata?.candidatesTokenCount);
    return {
      content,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: tokenCount(data.usageMetadata?.totalTokenCount) || inputTokens + outputTokens,
      },
      model: this.model,
      finishReason: finishReason === 'STOP' ? 'stop' : finishReason === 'MAX_TOKENS' ? 'length' : 'error',
    };
  }
}

// ============================================================================
// MOCK PROVIDER (for testing)
// ============================================================================

/**
 * Mock provider for testing
 */
export class MockLLMProvider implements LLMProvider {
  name = 'mock';
  maxContextTokens = 100000;
  maxOutputTokens = 4096;

  private responses: Map<string, string> = new Map();
  private defaultResponse = '{"result": "mock response"}';
  public callHistory: CompletionRequest[] = [];
  public shouldFail = false;
  public failCount = 0;
  private currentFailCount = 0;

  setResponse(promptContains: string, response: string): void {
    this.responses.set(promptContains, response);
  }

  setDefaultResponse(response: string): void {
    this.defaultResponse = response;
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  async generateCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    this.callHistory.push(request);

    if (this.shouldFail && this.currentFailCount < this.failCount) {
      this.currentFailCount++;
      const err = new Error('Mock failure') as Error & { status?: number; retryable?: boolean };
      err.status = 500;
      err.retryable = true;
      throw err;
    }

    // Find matching response
    let content = this.defaultResponse;
    for (const [key, value] of this.responses) {
      if (request.userPrompt.includes(key) || request.systemPrompt.includes(key)) {
        content = value;
        break;
      }
    }

    const inputTokens = this.countTokens(request.systemPrompt + request.userPrompt);
    const outputTokens = this.countTokens(content);

    return {
      content,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      model: 'mock-model',
      finishReason: 'stop',
    };
  }

  reset(): void {
    this.callHistory = [];
    this.shouldFail = false;
    this.failCount = 0;
    this.currentFailCount = 0;
    this.responses.clear();
  }
}

// ============================================================================
// LLM SERVICE
// ============================================================================

/**
 * LLM Service - main interface for LLM interactions
 */
export class LLMService {
  private provider: LLMProvider;
  private retryConfig: RetryConfig;
  private options: Required<LLMServiceOptions>;
  private tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 };
  private costTracking: CostTracking = { estimatedCost: 0, currency: 'USD', byProvider: {} };
  private requestLog: Array<{ timestamp: string; request: CompletionRequest; response?: CompletionResponse; error?: string }> = [];

  constructor(provider: LLMProvider, options: LLMServiceOptions = {}) {
    this.provider = provider;
    this.options = {
      provider: options.provider ?? 'anthropic',
      model: options.model ?? '',
      apiBase: options.apiBase ?? '',
      sslVerify: options.sslVerify ?? true,
      openaiCompatBaseUrl: options.openaiCompatBaseUrl ?? '',
      maxRetries: options.maxRetries ?? DEFAULT_LLM_MAX_RETRIES,
      initialDelay: options.initialDelay ?? DEFAULT_LLM_INITIAL_DELAY_MS,
      maxDelay: options.maxDelay ?? DEFAULT_LLM_MAX_DELAY_MS,
      timeout: options.timeout ?? DEFAULT_LLM_TIMEOUT_MS,
      costWarningThreshold: options.costWarningThreshold ?? DEFAULT_LLM_COST_WARNING_THRESHOLD,
      logDir: options.logDir ?? `${OPENLORE_DIR}/${OPENLORE_LOGS_SUBDIR}`,
      enableLogging: options.enableLogging ?? false,
      disableResponseFormat: options.disableResponseFormat ?? false,
    };
    this.retryConfig = {
      maxRetries: this.options.maxRetries,
      initialDelay: this.options.initialDelay,
      maxDelay: this.options.maxDelay,
      timeout: this.options.timeout,
    };
  }

  /**
   * Get the provider name
   */
  getProviderName(): string {
    return this.provider.name;
  }

  /**
   * Get maximum context tokens for the provider
   */
  getMaxContextTokens(): number {
    return this.provider.maxContextTokens;
  }

  /**
   * Count tokens in text
   */
  countTokens(text: string): number {
    return this.provider.countTokens(text);
  }

  /**
   * Get current token usage
   */
  getTokenUsage(): TokenUsage {
    return { ...this.tokenUsage };
  }

  /**
   * Get current cost tracking
   */
  getCostTracking(): CostTracking {
    return { ...this.costTracking };
  }

  /**
   * Reset usage tracking
   */
  resetTracking(): void {
    this.tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 };
    this.costTracking = { estimatedCost: 0, currency: 'USD', byProvider: {} };
    this.requestLog = [];
  }

  /**
   * Generate a completion with retry logic
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Pre-calculate tokens and warn if approaching limit
    const inputTokens = this.countTokens(request.systemPrompt + request.userPrompt);
    const maxTokens = request.maxTokens ?? this.provider.maxOutputTokens;
    const totalExpected = inputTokens + maxTokens;

    if (totalExpected > this.provider.maxContextTokens * CONTEXT_LIMIT_WARNING_RATIO) {
      logger.warning(`Approaching context limit: ${totalExpected} tokens (max: ${this.provider.maxContextTokens})`);
    }

    if (totalExpected > this.provider.maxContextTokens) {
      throw new Error(`Request exceeds context limit: ${totalExpected} > ${this.provider.maxContextTokens}`);
    }

    // Execute with retry logic
    let lastError: Error | null = null;
    let delay = this.retryConfig.initialDelay;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        logger.debug(`LLM request attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1}`);

        const response = await this.executeWithTimeout(request);

        // Update tracking
        this.updateTracking(response);

        // Log if enabled
        if (this.options.enableLogging) {
          this.logRequest(request, response);
        }

        // Check cost threshold
        if (this.costTracking.estimatedCost > this.options.costWarningThreshold) {
          logger.warning(`Cost threshold exceeded: $${this.costTracking.estimatedCost.toFixed(4)} > $${this.options.costWarningThreshold}`);
        }

        return response;
      } catch (error) {
        lastError = error as Error;
        const errWithStatus = error as Error & { retryable?: boolean };

        // Log error
        if (this.options.enableLogging) {
          this.logRequest(request, undefined, lastError.message);
        }

        // Check if retryable
        if (!errWithStatus.retryable || attempt === this.retryConfig.maxRetries) {
          throw lastError;
        }

        // Use the provider-supplied reset time if available, otherwise exponential backoff
        const retryAfterMs = (errWithStatus as Error & { retryAfterMs?: number }).retryAfterMs;
        const waitMs = retryAfterMs !== undefined ? retryAfterMs : delay;

        logger.warning(`LLM request failed (attempt ${attempt + 1}), retrying in ${waitMs}ms: ${lastError.message}`);
        await this.sleep(waitMs);

        // Only advance the backoff delay when we didn't use a provider-supplied wait
        if (retryAfterMs === undefined) {
          delay = Math.min(delay * 2, this.retryConfig.maxDelay);
        }
      }
    }

    throw lastError ?? new Error('Unknown error');
  }

  /**
   * Generate a completion expecting JSON response
   */
  async completeJSON<T>(request: CompletionRequest, schema?: object): Promise<T> {
    const jsonRequest = { ...request, responseFormat: 'json' as const, jsonSchema: schema };

    // Add JSON instruction to prompt if not already present
    if (!jsonRequest.systemPrompt.toLowerCase().includes('json')) {
      jsonRequest.systemPrompt += '\n\nRespond with valid JSON only.';
    }

    // When a schema is provided, append it to the system prompt so the model
    // knows the exact shape expected (especially that it must start an array).
    // This addresses issue #26: without this, models may return a single object.
    if (schema) {
      jsonRequest.systemPrompt += `\n\nYour response MUST conform to this JSON Schema:\n${JSON.stringify(schema)}`;
    }

    const response = await this.complete(jsonRequest);
    let content = response.content;

    // Extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      content = jsonMatch[1].trim();
    }

    // Parse JSON
    let parsed: T;
    try {
      parsed = JSON.parse(content) as T;
    } catch (parseError) {
      // Retry with correction prompt for parse errors
      logger.warning('JSON parse failed, attempting correction');

      const correctionPrompt = protectPrompt(
        'Fix the invalid JSON in the untrusted data block and return only valid JSON. Do not include any explanation.',
        `Invalid JSON:\n${content}\n\nError: ${(parseError as Error).message}`,
      );
      const correctionRequest: CompletionRequest = {
        ...correctionPrompt,
        temperature: 0.1,
        responseFormat: 'json',
      };

      const correctionResponse = await this.complete(correctionRequest);
      let correctedContent = correctionResponse.content;

      // Extract from code blocks again
      const correctedMatch = correctedContent.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (correctedMatch) {
        correctedContent = correctedMatch[1].trim();
      }

      parsed = JSON.parse(correctedContent) as T;
    }

    // Unwrap single-key object whose value is an array (e.g. {entities:[...]} → [...])
    // LLM correction attempts sometimes wrap arrays in an object
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      const keys = Object.keys(parsed as object);
      if (keys.length === 1) {
        const val = (parsed as Record<string, unknown>)[keys[0]];
        if (Array.isArray(val)) {
          parsed = val as unknown as T;
        }
      }
    }

    // Validate against schema if provided (after successful parsing)
    if (schema) {
      this.validateSchema(parsed, schema);
    }

    return parsed;
  }

  /**
   * Execute request with timeout
   */
  private async executeWithTimeout(request: CompletionRequest): Promise<CompletionResponse> {
    const timeoutMs = this.retryConfig.timeout;

    // change: fix-process-exit-lifecycle
    // The timeout timer MUST be cleared once the race settles. Without this, a
    // request that fails fast (e.g. an unreachable provider rejecting in <1s)
    // leaves the setTimeout pending for the full request timeout — keeping the
    // event loop alive so the whole command hangs until the timer fires at the
    // 120s mark, long after it reported the failure. `unref` is defence in depth:
    // even a missed clear degrades to an early exit rather than a hang.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.provider.generateCompletion(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`LLM request timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Update tracking after a successful request
   */
  private updateTracking(response: CompletionResponse): void {
    this.tokenUsage.inputTokens += response.usage.inputTokens;
    this.tokenUsage.outputTokens += response.usage.outputTokens;
    this.tokenUsage.totalTokens += response.usage.totalTokens;
    this.tokenUsage.requests++;

    // Calculate cost
    const cost = this.calculateCost(response);
    this.costTracking.estimatedCost += cost;
    this.costTracking.byProvider[this.provider.name] = (this.costTracking.byProvider[this.provider.name] ?? 0) + cost;
  }

  /**
   * Calculate cost for a response
   */
  private calculateCost(response: CompletionResponse): number {
    const modelPricing = lookupPricing(this.provider.name, response.model);
    const inputCost = (response.usage.inputTokens / 1_000_000) * modelPricing.input;
    const outputCost = (response.usage.outputTokens / 1_000_000) * modelPricing.output;
    return inputCost + outputCost;
  }

  /**
   * Log request/response
   */
  private logRequest(request: CompletionRequest, response?: CompletionResponse, error?: string): void {
    // Scrub the WHOLE entry, not just the request. `error` is the provider's response
    // body verbatim (`HTTP ${status}: ${detail}`), and an OpenAI-compatible gateway
    // that echoes the inbound request in its diagnostics puts the Authorization /
    // x-api-key header we just sent into that text — which then lands in a file on
    // disk. This is the channel mcp-security's "Secret Confinement Across All Output
    // Paths" names ("or written artifact"), so it uses the shared redactor rather
    // than a private, request-only copy that had drifted from it.
    const logEntry = redactSecrets({
      timestamp: new Date().toISOString(),
      request: blankLongOpaqueTokens(request),
      response,
      error,
    });

    this.requestLog.push(logEntry);
  }

  /**
   * Simple schema validation
   */
  private validateSchema(data: unknown, schema: object): void {
    const schemaObj = schema as Record<string, unknown>;

    if (schemaObj.type === 'array') {
      if (!Array.isArray(data)) {
        throw new Error('Expected JSON array but received object');
      }
      // Validate each item against the items schema if provided
      const itemsSchema = schemaObj.items as Record<string, unknown> | undefined;
      if (itemsSchema?.required && Array.isArray(itemsSchema.required)) {
        for (const item of data as Record<string, unknown>[]) {
          for (const field of itemsSchema.required as string[]) {
            if (!(field in item)) {
              throw new Error(`Missing required field in array item: ${field}`);
            }
          }
        }
      }
    } else if (schemaObj.type === 'object' && schemaObj.required && Array.isArray(schemaObj.required)) {
      const dataObj = data as Record<string, unknown>;
      for (const field of schemaObj.required) {
        if (!(field in dataObj)) {
          throw new Error(`Missing required field: ${field}`);
        }
      }
    }
  }

  /**
   * Save logs to disk
   */
  async saveLogs(): Promise<void> {
    if (this.requestLog.length === 0) return;

    await mkdir(this.options.logDir, { recursive: true });

    const filename = `llm-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filepath = join(this.options.logDir, filename);

    // 0600: the log holds the full prompt corpus (i.e. the repository's source) and
    // provider diagnostics. Redaction is the first defense; not leaving it
    // world-readable to every other local process is the second.
    await writeFile(filepath, JSON.stringify({
      summary: {
        tokenUsage: this.tokenUsage,
        costTracking: this.costTracking,
      },
      requests: this.requestLog,
    }, null, 2), { mode: 0o600 });

    logger.debug(`Saved LLM logs to ${filepath}`);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create an LLM service with the specified provider
 */
export function createLLMService(options: LLMServiceOptions = {}): LLMService {
  const providerName = options.provider ?? 'anthropic';
  const sslVerify = options.sslVerify ?? true;
  let provider: LLMProvider;

  if (providerName === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }
    const apiBase = options.apiBase ?? process.env.ANTHROPIC_API_BASE ?? undefined;
    provider = new AnthropicProvider(apiKey, options.model ?? DEFAULT_ANTHROPIC_MODEL, apiBase, sslVerify);
  } else if (providerName === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    const apiBase = options.apiBase ?? process.env.OPENAI_API_BASE ?? undefined;
    provider = new OpenAIProvider(apiKey, options.model ?? DEFAULT_OPENAI_MODEL, apiBase, sslVerify);
  } else if (providerName === 'openai-compat') {
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    const baseUrl = options.openaiCompatBaseUrl ?? options.apiBase ?? process.env.OPENAI_COMPAT_BASE_URL;
    if (!apiKey) {
      throw new Error('OPENAI_COMPAT_API_KEY environment variable is not set');
    }
    if (!baseUrl) {
      throw new Error('openaiCompatBaseUrl must be set in config or OPENAI_COMPAT_BASE_URL env var (e.g. https://api.mistral.ai/v1)');
    }
    provider = new OpenAICompatibleProvider(apiKey, baseUrl, options.model ?? DEFAULT_OPENAI_COMPAT_MODEL, options.disableResponseFormat ?? false, sslVerify);
  } else if (providerName === 'copilot') {
    const baseUrl = options.openaiCompatBaseUrl ?? options.apiBase ?? process.env.COPILOT_API_BASE_URL ?? 'http://localhost:4141/v1';
    const apiKey = process.env.COPILOT_API_KEY ?? 'copilot';
    provider = new CopilotProvider(baseUrl, options.model ?? DEFAULT_COPILOT_MODEL, apiKey, sslVerify);
  } else if (providerName === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    provider = new GeminiProvider(apiKey, options.model ?? DEFAULT_GEMINI_MODEL, sslVerify);
  } else if (providerName === 'claude-code') {
    provider = new ClaudeCodeProvider(options.model);
  } else if (providerName === 'codex-cli') {
    provider = new CodexCLIProvider(options.model);
  } else if (providerName === 'mistral-vibe') {
    provider = new MistralVibeProvider(options.model);
  } else if (providerName === 'gemini-cli') {
    provider = new GeminiCLIProvider(options.model);
  } else if (providerName === 'antigravity-cli') {
    provider = new AntigravityCLIProvider(options.model);
  } else if (providerName === 'cursor-agent') {
    provider = new CursorAgentProvider(options.model);
  } else {
    throw new Error(`Unknown provider: ${providerName}. Supported: anthropic, openai, openai-compat, copilot, gemini, gemini-cli, antigravity-cli, claude-code, codex-cli, mistral-vibe, cursor-agent`);
  }

  if (!sslVerify) {
    logger.warning('SSL verification is disabled. Use only for trusted internal servers.');
  }

  return new LLMService(provider, options);
}

/**
 * Create an LLM service with a mock provider (for testing)
 */
export function createMockLLMService(options: LLMServiceOptions = {}): { service: LLMService; provider: MockLLMProvider } {
  const provider = new MockLLMProvider();
  const service = new LLMService(provider, options);
  return { service, provider };
}
