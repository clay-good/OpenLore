/**
 * ChatAgent -- agentic tool-use loop for the diagram chatbot.
 *
 * Supports three provider formats:
 *   - Anthropic Claude   (tool_use / tool_result via /v1/messages)
 *   - OpenAI-compatible  (function calling via /chat/completions)
 *   - Google Gemini      (function calling via generateContent)
 *
 * Provider resolution (same priority as generate.ts):
 *   1. GEMINI_API_KEY                -> Gemini
 *   2. ANTHROPIC_API_KEY             -> Anthropic Claude
 *   3. OPENAI_COMPAT_BASE_URL        -> any OpenAI-compatible endpoint
 *   4. openloreConfig.generation      -> reads provider + openaiCompatBaseUrl from config
 *   5. OPENAI_API_KEY                -> OpenAI directly
 *
 * Model: OPENAI_COMPAT_MODEL env var -> openloreConfig.generation.model -> provider default.
 *
 * Max iterations: 8 (prevents runaway loops).
 */

import { CHAT_TOOLS, toChatToolDefinitions } from './chat-tools.js';
import { withRelaxedTls } from './tls-scope.js';
import { readOpenLoreConfig } from './config-manager.js';
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_CHAT_OPENAI_MODEL,
  CHAT_AGENT_MAX_TOKENS,
  API_ERROR_PREVIEW_LENGTH,
} from '../../constants.js';
import { discloseRepoConfiguredEndpoint } from './repo-config-trust.js';

// ============================================================================
// TYPES -- OpenAI
// ============================================================================

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIResponse {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: OAIToolCall[] };
    finish_reason: string;
  }>;
}

// ============================================================================
// TYPES -- Gemini
// ============================================================================

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: GeminiPart[]; role: string };
    finishReason: string;
  }>;
}

// ============================================================================
// TYPES -- Anthropic
// ============================================================================

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | string;
}

// ============================================================================
// PROVIDER DETECTION
// ============================================================================

type ProviderKind = 'gemini' | 'anthropic' | 'openai-compat';

interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Resolve the active LLM provider by checking environment keys in priority order:
 * Gemini API key → Anthropic API key → OpenAI-compatible base URL → config file → OpenAI key.
 * Returns a ProviderConfig with kind, baseUrl, apiKey, and model fields.
 */
export async function resolveProviderConfig(directory: string): Promise<ProviderConfig> {
  const geminiKey     = process.env.GEMINI_API_KEY ?? '';
  const anthropicKey  = process.env.ANTHROPIC_API_KEY ?? '';
  const compatBase    = process.env.OPENAI_COMPAT_BASE_URL ?? '';
  const compatKey     = process.env.OPENAI_COMPAT_API_KEY ?? '';
  const openaiKey     = process.env.OPENAI_API_KEY ?? '';
  const envModel      = process.env.OPENAI_COMPAT_MODEL ?? '';

  // Load project config once
  let cfgProvider: string | undefined;
  let cfgBase: string | undefined;
  let cfgModel: string | undefined;
  try {
    const cfg = await readOpenLoreConfig(directory);
    cfgProvider = cfg?.generation?.provider;
    cfgBase     = cfg?.generation?.openaiCompatBaseUrl;
    cfgModel    = cfg?.generation?.model;
  } catch { /* ignore */ }

  // Priority: explicit config provider > env key signals > fallback openai-compat
  // Explicit config always wins so users can override a globally-set env key.
  if (cfgProvider === 'gemini' || (!cfgProvider && geminiKey)) {
    return {
      kind:    'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
      apiKey:  geminiKey,
      model:   envModel || cfgModel || DEFAULT_GEMINI_MODEL,
    };
  }

  if (cfgProvider === 'anthropic' || (!cfgProvider && anthropicKey)) {
    return {
      kind:    'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey:  anthropicKey,
      model:   envModel || cfgModel || DEFAULT_ANTHROPIC_MODEL,
    };
  }

  // `cfgBase` is `generation.openaiCompatBaseUrl` from the ANALYZED REPO's config, and
  // the key below falls back to the plain OPENAI_API_KEY — so a repo that commits a
  // base URL and no provider would send the operator's OpenAI key to a host it chose.
  // The env var (`compatBase`) is operator-supplied and takes precedence; a repo-set
  // value is disclosed, matching how the same field is handled in command-helpers.ts.
  if (!compatBase) discloseRepoConfiguredEndpoint('generation.openaiCompatBaseUrl', cfgBase);
  const base = compatBase || cfgBase || 'https://api.openai.com/v1';
  const key  = compatKey  || openaiKey;
  return {
    kind:    'openai-compat',
    baseUrl: base.replace(/\/$/, ''),
    apiKey:  key,
    model:   envModel || cfgModel || DEFAULT_CHAT_OPENAI_MODEL,
  };
}

// ============================================================================
// SHARED
// ============================================================================

export interface ChatAgentOptions {
  directory: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  modelOverride?: string;
  signal?: AbortSignal;
  onToolStart?: (name: string) => void;
  onToolEnd?: (name: string) => void;
}

export interface ChatAgentResult {
  reply: string;
  filePaths: string[];
}

const MAX_ITERATIONS = 8;

/** Cap tool result size to avoid exceeding provider context limits (400 errors). */
const MAX_TOOL_RESULT_CHARS = 12_000;

/** Max retries for transient provider errors (429 / 5xx). */
const MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff. */
const RETRY_BASE_MS = 1_000;

/** Returns true for errors worth retrying (rate-limit or server-side). */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> {
  let lastError: Error = new Error('fetch failed');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise(r => setTimeout(r, delay));
      if (signal?.aborted) throw new Error('Aborted');
    }
    const response = await withRelaxedTls(() => fetch(url, { ...init, signal }));
    if (response.ok || !isRetryable(response.status)) return response;
    const errText = await response.text().catch(() => '');
    lastError = new Error(`${response.status}: ${errText.slice(0, 200)}`);
  }
  throw lastError;
}

function buildSystemPrompt(directory: string): string {
  return `You are a code analysis assistant embedded in a dependency diagram viewer.
The project directory is: ${directory}
You have access to tools that query the codebase's static analysis data.
When calling tools, always pass directory="${directory}" -- never ask the user for it.

## Core rule — never ask for file paths
If the user mentions a filename (e.g. "chat-agent.ts", "CallGraphBuilder") without a full path,
use search_code with the filename or class name as the query to locate it yourself.
NEVER ask the user to provide or confirm a path. Always resolve it autonomously with tools.

## Reasoning strategy

**For questions about a specific file or class** (e.g. "look at chat-agent.ts"):
1. Call search_code with the filename/class name to find the exact path.
2. Then call get_subgraph or get_file_dependencies on the resolved path for details.

**For questions about features, requirements, or intended behaviour** (e.g. "how does X work?",
"where should we implement Y?", "which spec covers Z?"):
1. Start with search_specs to find relevant requirements and design notes.
2. Use the linkedFiles from the results to identify the related source files.
3. Follow up with get_subgraph or analyze_impact on those files if more detail is needed.

**For questions about code structure, hubs, or refactoring**:
Start with get_architecture_overview, get_call_graph, or get_critical_hubs.

**For semantic code search** (e.g. "find the function that validates emails"):
Use search_code.

Always explain what the highlighted files/functions are. Keep replies focused and actionable.
Use markdown for code and lists.`;
}

async function executeTool(
  toolMap: Map<string, (typeof CHAT_TOOLS)[number]>,
  directory: string,
  name: string,
  args: Record<string, unknown>,
  callbacks?: Pick<ChatAgentOptions, 'onToolStart' | 'onToolEnd'>
): Promise<{ content: string; filePaths: string[] }> {
  callbacks?.onToolStart?.(name);
  const tool = toolMap.get(name);
  if (!tool) {
    return { content: JSON.stringify({ error: `Unknown tool: ${name}` }), filePaths: [] };
  }
  try {
    const { result, filePaths } = await tool.execute(directory, args);
    let content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (content.length > MAX_TOOL_RESULT_CHARS) {
      content = content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n... [truncated]';
    }
    callbacks?.onToolEnd?.(name);
    return { content, filePaths };
  } catch (err) {
    callbacks?.onToolEnd?.(name);
    return {
      content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      filePaths: [],
    };
  }
}

// ============================================================================
// OPENAI-COMPATIBLE LOOP
// ============================================================================

async function runOpenAILoop(
  cfg: ProviderConfig,
  directory: string,
  messages: ChatAgentOptions['messages'],
  callbacks?: Pick<ChatAgentOptions, 'onToolStart' | 'onToolEnd'>,
  signal?: AbortSignal
): Promise<ChatAgentResult> {
  const toolDefs = toChatToolDefinitions();
  const toolMap  = new Map(CHAT_TOOLS.map(t => [t.name, t]));
  const allFilePaths: string[] = [];

  const history: OAIMessage[] = [
    { role: 'system', content: buildSystemPrompt(directory) },
    ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal?.aborted) break;

    const response = await fetchWithRetry(
      `${cfg.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: cfg.model, messages: history, tools: toolDefs, tool_choice: 'auto' }),
      },
      signal,
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Chat API error ${response.status}: ${errText.slice(0, API_ERROR_PREVIEW_LENGTH)}`);
    }

    const data = (await response.json()) as OAIResponse;
    const choice = data.choices[0];
    if (!choice) throw new Error('Empty response from chat API');

    const msg = choice.message;
    history.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content ?? '(no response)', filePaths: [...new Set(allFilePaths)] };
    }

    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const { content, filePaths } = await executeTool(toolMap, directory, tc.function.name, args, callbacks);
      allFilePaths.push(...filePaths);
      history.push({ role: 'tool', tool_call_id: tc.id, content });
    }
  }

  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant' && m.content);
  return {
    reply: lastAssistant?.content ?? 'Analysis complete. Check highlighted nodes.',
    filePaths: [...new Set(allFilePaths)],
  };
}

// ============================================================================
// GEMINI LOOP
// ============================================================================

async function runGeminiLoop(
  cfg: ProviderConfig,
  directory: string,
  messages: ChatAgentOptions['messages'],
  callbacks?: Pick<ChatAgentOptions, 'onToolStart' | 'onToolEnd'>,
  signal?: AbortSignal
): Promise<ChatAgentResult> {
  const toolMap = new Map(CHAT_TOOLS.map(t => [t.name, t]));
  const allFilePaths: string[] = [];

  // Build function declarations for Gemini
  const functionDeclarations = CHAT_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));

  // Convert history to Gemini content format (no system role -- handled separately)
  const contents: GeminiContent[] = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const url = `${cfg.baseUrl}/${cfg.model}:generateContent?key=${cfg.apiKey}`;
  const headers = { 'Content-Type': 'application/json' };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal?.aborted) break;

    const body = {
      systemInstruction: { parts: [{ text: buildSystemPrompt(directory) }] },
      contents,
      tools: [{ function_declarations: functionDeclarations }],
      tool_config: { function_calling_config: { mode: 'AUTO' } },
    };

    const response = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, signal);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, API_ERROR_PREVIEW_LENGTH)}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('Empty response from Gemini API');

    const parts = candidate.content.parts;

    // Collect text and function calls from this turn
    const textParts = parts.filter((p): p is { text: string } => 'text' in p);
    const fnCalls   = parts.filter((p): p is { functionCall: { name: string; args: Record<string, unknown> } } => 'functionCall' in p);

    // Append model turn
    contents.push({ role: 'model', parts });

    if (fnCalls.length === 0) {
      // Final answer -- join all text parts
      const reply = textParts.map(p => p.text).join('').trim();
      return { reply: reply || '(no response)', filePaths: [...new Set(allFilePaths)] };
    }

    // Execute tool calls and build a single user turn with all responses
    const responseParts: GeminiPart[] = [];
    for (const fc of fnCalls) {
      const { content, filePaths } = await executeTool(toolMap, directory, fc.functionCall.name, fc.functionCall.args, callbacks);
      allFilePaths.push(...filePaths);
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(content) as Record<string, unknown>; }
      catch { parsed = { result: content }; }
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: parsed } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  // Max iterations -- extract last model text
  const lastModel = [...contents].reverse().find(c => c.role === 'model');
  const lastText  = lastModel?.parts.filter((p): p is { text: string } => 'text' in p).map(p => p.text).join('') ?? '';
  return {
    reply: lastText || 'Analysis complete. Check highlighted nodes.',
    filePaths: [...new Set(allFilePaths)],
  };
}

// ============================================================================
// ANTHROPIC LOOP
// ============================================================================

async function runAnthropicLoop(
  cfg: ProviderConfig,
  directory: string,
  messages: ChatAgentOptions['messages'],
  callbacks?: Pick<ChatAgentOptions, 'onToolStart' | 'onToolEnd'>,
  signal?: AbortSignal
): Promise<ChatAgentResult> {
  const toolMap = new Map(CHAT_TOOLS.map(t => [t.name, t]));
  const allFilePaths: string[] = [];

  const tools = CHAT_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const history: AnthropicMessage[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': cfg.apiKey,
  };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal?.aborted) break;

    const response = await fetchWithRetry(
      `${cfg.baseUrl}/messages`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: CHAT_AGENT_MAX_TOKENS,
          system: buildSystemPrompt(directory),
          tools,
          messages: history,
        }),
      },
      signal,
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, API_ERROR_PREVIEW_LENGTH)}`);
    }

    const data = (await response.json()) as AnthropicResponse;

    // Append assistant turn
    history.push({ role: 'assistant', content: data.content });

    if (data.stop_reason !== 'tool_use') {
      const text = data.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('');
      return { reply: text || '(no response)', filePaths: [...new Set(allFilePaths)] };
    }

    // Execute all tool_use blocks and collect results in a single user turn
    const toolUseBlocks = data.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use'
    );
    const resultBlocks: AnthropicContentBlock[] = [];
    for (const tu of toolUseBlocks) {
      const { content, filePaths } = await executeTool(toolMap, directory, tu.name, tu.input, callbacks);
      allFilePaths.push(...filePaths);
      resultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content });
    }
    history.push({ role: 'user', content: resultBlocks });
  }

  // Max iterations -- extract last assistant text
  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
  const lastText = Array.isArray(lastAssistant?.content)
    ? (lastAssistant.content as AnthropicContentBlock[])
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text).join('')
    : (lastAssistant?.content as string | undefined) ?? '';
  return {
    reply: lastText || 'Analysis complete. Check highlighted nodes.',
    filePaths: [...new Set(allFilePaths)],
  };
}

// ============================================================================
// ENTRY POINT
// ============================================================================

export async function runChatAgent(options: ChatAgentOptions): Promise<ChatAgentResult> {
  const { directory, messages, modelOverride, signal, onToolStart, onToolEnd } = options;
  const cfg = await resolveProviderConfig(directory);
  if (modelOverride) cfg.model = modelOverride;
  const callbacks = { onToolStart, onToolEnd };
  if (cfg.kind === 'gemini')    return runGeminiLoop(cfg, directory, messages, callbacks, signal);
  if (cfg.kind === 'anthropic') return runAnthropicLoop(cfg, directory, messages, callbacks, signal);
  return runOpenAILoop(cfg, directory, messages, callbacks, signal);
}
