/**
 * Tests for chat-agent.ts:
 *  - resolveProviderConfig: provider detection logic
 *  - runChatAgent: agentic loops for OpenAI, Gemini, and Anthropic providers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveProviderConfig, runChatAgent } from './chat-agent.js';

// Mock config-manager so we can control what readOpenLoreConfig returns
vi.mock('./config-manager.js', () => ({
  readOpenLoreConfig: vi.fn().mockResolvedValue(null),
}));

// Mock chat-tools so agentic loops use a controllable tool registry
const mockToolExecute = vi.fn().mockResolvedValue({ result: { ok: true }, filePaths: ['src/a.ts'] });
vi.mock('./chat-tools.js', () => ({
  CHAT_TOOLS: [
    {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'] },
      execute: (...args: unknown[]) => mockToolExecute(...args),
    },
  ],
  toChatToolDefinitions: () => [{
    type: 'function' as const,
    function: { name: 'test_tool', description: 'A test tool', parameters: { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'] } },
  }],
}));

import { readOpenLoreConfig } from './config-manager.js';
const mockReadConfig = readOpenLoreConfig as ReturnType<typeof vi.fn>;

// ============================================================================
// ENV VAR HELPERS
// ============================================================================

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_COMPAT_BASE_URL',
  'OPENAI_COMPAT_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_COMPAT_MODEL',
] as const;

let savedEnv: Record<string, string | undefined>;

function clearEnvKeys() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('resolveProviderConfig', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    clearEnvKeys();
    mockReadConfig.mockResolvedValue(null);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  // ---------- Priority 1: Gemini ----------

  it('should select Gemini when GEMINI_API_KEY is set', async () => {
    process.env.GEMINI_API_KEY = 'gem-key';
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('gemini');
    expect(cfg.apiKey).toBe('gem-key');
  });

  it('should select Gemini when config says provider=gemini even without env key', async () => {
    mockReadConfig.mockResolvedValue({ generation: { provider: 'gemini' } });
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('gemini');
  });

  it('Gemini should use OPENAI_COMPAT_MODEL env var for model if set', async () => {
    process.env.GEMINI_API_KEY = 'gem-key';
    process.env.OPENAI_COMPAT_MODEL = 'custom-model';
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.model).toBe('custom-model');
  });

  it('Gemini should fall back to config model then default', async () => {
    process.env.GEMINI_API_KEY = 'gem-key';
    mockReadConfig.mockResolvedValue({ generation: { model: 'gemini-2.0-flash' } });
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.model).toBe('gemini-2.0-flash');
  });

  // ---------- Priority 2: Anthropic ----------

  it('should select Anthropic when ANTHROPIC_API_KEY is set (no Gemini key)', async () => {
    process.env.ANTHROPIC_API_KEY = 'ant-key';
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('anthropic');
    expect(cfg.apiKey).toBe('ant-key');
  });

  it('should select Anthropic when config says provider=anthropic', async () => {
    mockReadConfig.mockResolvedValue({ generation: { provider: 'anthropic' } });
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('anthropic');
  });

  it('Gemini takes priority over Anthropic when both keys are set', async () => {
    process.env.GEMINI_API_KEY = 'gem-key';
    process.env.ANTHROPIC_API_KEY = 'ant-key';
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('gemini');
  });

  // ---------- Priority 3: OpenAI-compat via env ----------

  it('should select openai-compat when OPENAI_COMPAT_BASE_URL is set', async () => {
    process.env.OPENAI_COMPAT_BASE_URL = 'http://localhost:11434/v1';
    process.env.OPENAI_COMPAT_API_KEY = 'compat-key';
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('openai-compat');
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.apiKey).toBe('compat-key');
  });

  it('should strip trailing slash from baseUrl', async () => {
    process.env.OPENAI_COMPAT_BASE_URL = 'http://localhost:11434/v1/';
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1');
  });

  // ---------- Priority 4: Config-based openai-compat ----------

  it('should select openai-compat from config openaiCompatBaseUrl', async () => {
    mockReadConfig.mockResolvedValue({ generation: { openaiCompatBaseUrl: 'http://local:8080' } });
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('openai-compat');
    expect(cfg.baseUrl).toBe('http://local:8080');
  });

  // ---------- Priority 5: OpenAI direct ----------

  it('should select openai-compat with OpenAI base when only OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'oai-key';
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('openai-compat');
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.apiKey).toBe('oai-key');
  });

  // ---------- Fallback ----------

  it('should fall back to openai-compat with default base when no keys set', async () => {
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('openai-compat');
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.apiKey).toBe('');
  });

  // ---------- Model resolution ----------

  it('OPENAI_COMPAT_MODEL env var takes highest priority for model', async () => {
    process.env.OPENAI_API_KEY = 'key';
    process.env.OPENAI_COMPAT_MODEL = 'env-model';
    mockReadConfig.mockResolvedValue({ generation: { model: 'cfg-model' } });
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.model).toBe('env-model');
  });

  it('config model takes second priority', async () => {
    process.env.OPENAI_API_KEY = 'key';
    mockReadConfig.mockResolvedValue({ generation: { model: 'cfg-model' } });
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.model).toBe('cfg-model');
  });

  // ---------- Config read failure ----------

  it('should handle config read failure gracefully', async () => {
    mockReadConfig.mockRejectedValue(new Error('ENOENT'));
    process.env.OPENAI_API_KEY = 'key';
    const cfg = await resolveProviderConfig('/tmp');
    expect(cfg.kind).toBe('openai-compat');
    expect(cfg.apiKey).toBe('key');
  });
});

// ============================================================================
// runChatAgent — agentic loops via mocked fetch
// ============================================================================

// Helper to create a mock fetch Response
function mockResponse(body: object, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
    redirected: false,
    statusText: ok ? 'OK' : 'Error',
    type: 'basic' as Response['type'],
    url: '',
    clone: () => mockResponse(body, ok, status),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([])),
    formData: () => Promise.resolve(new FormData()),
    // Added to `Response` by @types/node 26 (tracking the undici/WHATWG surface).
    // Unused by these tests, but the mock is typed as a full `Response`.
    bytes: () => Promise.resolve(new Uint8Array()),
  };
}

describe('runChatAgent', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    clearEnvKeys();
    mockReadConfig.mockResolvedValue(null);
    mockToolExecute.mockResolvedValue({ result: { ok: true }, filePaths: ['src/a.ts'] });

    // Default: use openai-compat (fallback)
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.unstubAllGlobals();
  });

  // ---------- OpenAI-compatible loop ----------

  describe('OpenAI-compatible loop', () => {
    it('should return text reply when no tool calls', async () => {
      fetchSpy.mockResolvedValue(mockResponse({
        choices: [{ message: { role: 'assistant', content: 'Hello!', tool_calls: [] }, finish_reason: 'stop' }],
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.reply).toBe('Hello!');
      expect(result.filePaths).toEqual([]);
    });

    it('should execute tool calls and return final reply', async () => {
      // First response: tool call
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{"directory":"/project"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      // Second response: final text
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { role: 'assistant', content: 'Done analyzing.', tool_calls: [] }, finish_reason: 'stop' }],
      }));

      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();
      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'analyze' }],
        onToolStart,
        onToolEnd,
      });

      expect(result.reply).toBe('Done analyzing.');
      expect(result.filePaths).toEqual(['src/a.ts']);
      expect(onToolStart).toHaveBeenCalledWith('test_tool');
      expect(onToolEnd).toHaveBeenCalledWith('test_tool');
    });

    it('keeps the redaction receipt visible when tool history is truncated', async () => {
      mockToolExecute.mockResolvedValue({
        result: {
          results: [{ source: '[REDACTED:api-key]' + 'x'.repeat(20_000) }],
          redactions: { count: 1, kinds: ['api-key'] },
        },
        filePaths: [],
      });
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { role: 'assistant', content: 'Safe.', tool_calls: [] }, finish_reason: 'stop' }],
      }));

      await runChatAgent({ directory: '/project', messages: [{ role: 'user', content: 'search' }] });
      const secondRequest = JSON.parse(fetchSpy.mock.calls[1][1].body) as {
        messages: Array<{ role: string; content: string }>;
      };
      const toolMessage = secondRequest.messages.find(message => message.role === 'tool');

      expect(toolMessage?.content).toContain('... [truncated]');
      expect(toolMessage?.content).toContain('Redactions: {"count":1,"kinds":["api-key"]}');
    });

    it('should throw on non-ok response', async () => {
      fetchSpy.mockResolvedValue(mockResponse({ error: 'bad request' }, false, 400));

      await expect(runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('Chat API error 400');
    });

    it('should throw on empty choices', async () => {
      fetchSpy.mockResolvedValue(mockResponse({ choices: [] }));

      await expect(runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('Empty response');
    });

    it('should return "(no response)" when content is null and no tool calls', async () => {
      fetchSpy.mockResolvedValue(mockResponse({
        choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.reply).toBe('(no response)');
    });

    it('should handle malformed tool call arguments gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: 'NOT JSON' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { role: 'assistant', content: 'Recovered.', tool_calls: [] }, finish_reason: 'stop' }],
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(result.reply).toBe('Recovered.');
    });

    it('should apply modelOverride', async () => {
      fetchSpy.mockResolvedValue(mockResponse({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));

      await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
        modelOverride: 'gpt-4o-mini',
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4o-mini');
    });
  });

  // ---------- Gemini loop ----------

  describe('Gemini loop', () => {
    beforeEach(() => {
      process.env.GEMINI_API_KEY = 'gem-key';
    });

    it('should return text reply', async () => {
      fetchSpy.mockResolvedValue(mockResponse({
        candidates: [{ content: { parts: [{ text: 'Gemini says hi' }], role: 'model' }, finishReason: 'STOP' }],
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.reply).toBe('Gemini says hi');
    });

    it('should execute function calls', async () => {
      // First: function call
      fetchSpy.mockResolvedValueOnce(mockResponse({
        candidates: [{
          content: {
            parts: [{ functionCall: { name: 'test_tool', args: { directory: '/project' } } }],
            role: 'model',
          },
          finishReason: 'STOP',
        }],
      }));
      // Second: text reply
      fetchSpy.mockResolvedValueOnce(mockResponse({
        candidates: [{ content: { parts: [{ text: 'Analysis done.' }], role: 'model' }, finishReason: 'STOP' }],
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'analyze' }],
      });
      expect(result.reply).toBe('Analysis done.');
      expect(result.filePaths).toEqual(['src/a.ts']);
    });

    it('should throw on non-ok response', async () => {
      fetchSpy.mockResolvedValue(mockResponse({}, false, 400));

      await expect(runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('Gemini API error 400');
    });

    it('should throw on empty candidates', async () => {
      fetchSpy.mockResolvedValue(mockResponse({ candidates: [] }));

      await expect(runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('Empty response from Gemini');
    });
  });

  // ---------- Anthropic loop ----------

  describe('Anthropic loop', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'ant-key';
    });

    it('should return text reply', async () => {
      fetchSpy.mockResolvedValue(mockResponse({
        content: [{ type: 'text', text: 'Claude says hello' }],
        stop_reason: 'end_turn',
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.reply).toBe('Claude says hello');
    });

    it('should execute tool_use blocks', async () => {
      // First: tool_use
      fetchSpy.mockResolvedValueOnce(mockResponse({
        content: [
          { type: 'text', text: 'Let me check...' },
          { type: 'tool_use', id: 'tu1', name: 'test_tool', input: { directory: '/project' } },
        ],
        stop_reason: 'tool_use',
      }));
      // Second: final reply
      fetchSpy.mockResolvedValueOnce(mockResponse({
        content: [{ type: 'text', text: 'All done.' }],
        stop_reason: 'end_turn',
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'analyze' }],
      });
      expect(result.reply).toBe('All done.');
      expect(result.filePaths).toEqual(['src/a.ts']);
    });

    it('should throw on non-ok response', async () => {
      fetchSpy.mockResolvedValue(mockResponse({}, false, 401));

      await expect(runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('Anthropic API error 401');
    });

    it('should send correct Anthropic headers', async () => {
      fetchSpy.mockResolvedValue(mockResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }));

      await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'hi' }],
      });

      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['x-api-key']).toBe('ant-key');
    });
  });

  // ---------- Cross-cutting ----------

  describe('cross-cutting behavior', () => {
    it('should deduplicate file paths', async () => {
      // Tool returns same file path twice across two calls
      mockToolExecute.mockResolvedValue({ result: {}, filePaths: ['src/a.ts'] });

      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [
              { id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } },
              { id: 'tc2', type: 'function', function: { name: 'test_tool', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'test' }],
      });
      // Should be deduplicated
      expect(result.filePaths).toEqual(['src/a.ts']);
    });

    it('should handle unknown tool gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'nonexistent_tool', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(result.reply).toBe('recovered');
    });

    it('should handle tool execution errors gracefully', async () => {
      mockToolExecute.mockRejectedValue(new Error('tool crash'));

      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      fetchSpy.mockResolvedValueOnce(mockResponse({
        choices: [{ message: { role: 'assistant', content: 'handled error' }, finish_reason: 'stop' }],
      }));

      const result = await runChatAgent({
        directory: '/project',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(result.reply).toBe('handled error');
    });
  });
});
