/**
 * Tests for openlore view command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { viewCommand, sanitizeErrorMessage, safePath } from './view.js';
import { safeJoin } from '../../utils/path-confinement.js';

vi.mock('../../utils/path-confinement.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/path-confinement.js')>()),
  confinedAtomicWriteFile: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../../utils/logger.js', () => ({
  logger: {
    section: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
    success: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../utils/command-helpers.js', () => ({
  fileExists: vi.fn().mockResolvedValue(false),
}));

// Mock vite and react plugin to avoid heavy imports in test environment
vi.mock('vite', () => ({
  createServer: vi.fn().mockResolvedValue({
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@vitejs/plugin-react', () => ({
  default: vi.fn().mockReturnValue({ name: 'vite:react' }),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

vi.mock('../../core/analyzer/vector-index.js', () => ({
  VectorIndex: {
    exists: vi.fn().mockReturnValue(false),
    search: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../core/analyzer/embedding-service.js', () => ({
  EmbeddingService: {
    fromEnv: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../../core/analyzer/code-shaper.js', () => ({
  getSkeletonContent: vi.fn().mockReturnValue(''),
  detectLanguage: vi.fn().mockReturnValue('typescript'),
}));

vi.mock('../../core/services/chat-agent.js', () => ({
  runChatAgent: vi.fn().mockResolvedValue({ reply: '', filePaths: [] }),
  resolveProviderConfig: vi.fn().mockResolvedValue({ kind: 'anthropic', model: 'claude', baseUrl: '', apiKey: '' }),
}));

vi.mock('./view-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./view-files.js')>()),
  collectSpecMarkdown: vi.fn().mockResolvedValue({ content: '# Spec', bytes: 6, truncated: false }),
  readConfinedFile: vi.fn().mockResolvedValue(Buffer.from('export const value = 1;')),
}));

vi.mock('./viewer-freshness.js', () => ({
  readViewerFreshness: vi.fn().mockResolvedValue({
    generatedAt: '2026-08-09T00:00:00.000Z', analyzedCommit: 'abc', currentCommit: 'def',
    status: 'stale', filesChangedSince: 1,
  }),
  setViewerFreshnessHeaders: vi.fn((setHeader: (name: string, value: string) => void) => {
    setHeader('X-OpenLore-Analysis-Freshness', 'stale');
  }),
}));

// Mock fs so the descriptor write in the wiring test never touches the real repo.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// TESTS
// ============================================================================

describe('view command', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  describe('command configuration', () => {
    it('should have correct name', () => {
      expect(viewCommand.name()).toBe('view');
    });

    it('should describe the viewer', () => {
      expect(viewCommand.description()).toContain('viewer');
    });

    it('should have --analysis option with default', () => {
      const opt = viewCommand.options.find(o => o.long === '--analysis');
      expect(opt).toBeDefined();
      expect(opt?.defaultValue).toContain('.openlore');
      expect(opt?.defaultValue).toContain('analysis');
    });

    it('should have --spec option with default', () => {
      const opt = viewCommand.options.find(o => o.long === '--spec');
      expect(opt).toBeDefined();
      expect(opt?.defaultValue).toContain('openspec');
      expect(opt?.defaultValue).toContain('specs');
    });

    it('should have --port option with numeric default', () => {
      const opt = viewCommand.options.find(o => o.long === '--port');
      expect(opt).toBeDefined();
      expect(Number(opt?.defaultValue)).toBeGreaterThan(0);
    });

    it('should have --host option', () => {
      const opt = viewCommand.options.find(o => o.long === '--host');
      expect(opt).toBeDefined();
    });

    it('should have --no-open option', () => {
      const opt = viewCommand.options.find(o => o.long === '--no-open');
      expect(opt).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  describe('missing analysis file validation', () => {
    it('should set exitCode=1 when analysis directory has no graph file', async () => {
      const { fileExists } = await import('../../utils/command-helpers.js');
      vi.mocked(fileExists).mockResolvedValue(false);

      await viewCommand.parseAsync([], { from: 'user' });

      expect(process.exitCode).toBe(1);
    });

    it('should log error when graph file is missing', async () => {
      const { fileExists } = await import('../../utils/command-helpers.js');
      vi.mocked(fileExists).mockResolvedValue(false);
      const { logger } = await import('../../utils/logger.js');

      await viewCommand.parseAsync([], { from: 'user' });

      expect(logger.error).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  describe('port validation', () => {
    it('should set exitCode=1 for invalid port (non-numeric)', async () => {
      const { fileExists } = await import('../../utils/command-helpers.js');
      // Make graph exist, but viewer assets missing — will fail there
      // First call (graph): true, second call (viewer index.html): false
      vi.mocked(fileExists).mockResolvedValueOnce(true).mockResolvedValue(false);

      await viewCommand.parseAsync(['--port', 'abc'], { from: 'user' });

      expect(process.exitCode).toBe(1);
    });

    it('should set exitCode=1 for port 0', async () => {
      const { fileExists } = await import('../../utils/command-helpers.js');
      vi.mocked(fileExists).mockResolvedValueOnce(true).mockResolvedValue(false);

      await viewCommand.parseAsync(['--port', '0'], { from: 'user' });

      expect(process.exitCode).toBe(1);
    });

    it('should set exitCode=1 for port > 65535', async () => {
      const { fileExists } = await import('../../utils/command-helpers.js');
      vi.mocked(fileExists).mockResolvedValueOnce(true).mockResolvedValue(false);

      await viewCommand.parseAsync(['--port', '99999'], { from: 'user' });

      expect(process.exitCode).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  describe('default option values use constants', () => {
    it('analysis default should not be a raw hardcoded string', () => {
      const opt = viewCommand.options.find(o => o.long === '--analysis');
      // Should reference the actual computed path, not a raw literal
      expect(opt?.defaultValue).toMatch(/\.openlore.analysis/);
    });

    it('spec default should not be a raw hardcoded string', () => {
      const opt = viewCommand.options.find(o => o.long === '--spec');
      expect(opt?.defaultValue).toMatch(/openspec.specs/);
    });
  });
});

// ============================================================================
// PURE UTILITY FUNCTION TESTS
// ============================================================================

describe('sanitizeErrorMessage', () => {
  // -- Filesystem path redaction --
  it('should redact macOS paths (/Users/...)', () => {
    expect(sanitizeErrorMessage('ENOENT: /Users/alice/project/src/foo.ts'))
      .toBe('ENOENT: [path]');
  });

  it('should redact Linux paths (/home/...)', () => {
    expect(sanitizeErrorMessage('Error reading /home/deploy/app/config.json'))
      .toBe('Error reading [path]');
  });

  it('should redact Windows paths (C:\\...)', () => {
    expect(sanitizeErrorMessage('Not found: C:\\Users\\bob\\project\\file.ts'))
      .toBe('Not found: [path]');
  });

  it('should redact multiple paths in one message', () => {
    const msg = 'Copy /Users/a/src to /Users/b/dst failed';
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain('/Users/');
  });

  // -- API key redaction --
  it('should redact Gemini-style ?key= parameters', () => {
    expect(sanitizeErrorMessage('Request to https://api.google.com?key=AIzaSyB1234567890abcdefg failed'))
      .toContain('?key=[REDACTED]');
    expect(sanitizeErrorMessage('Request to https://api.google.com?key=AIzaSyB1234567890abcdefg failed'))
      .not.toContain('AIzaSyB');
  });

  it('should redact Anthropic API keys (sk-ant-...)', () => {
    expect(sanitizeErrorMessage('Auth failed with sk-ant-api03-abcdefghij1234567890'))
      .toContain('[REDACTED]');
    expect(sanitizeErrorMessage('Auth failed with sk-ant-api03-abcdefghij1234567890'))
      .not.toContain('sk-ant-');
  });

  it('should redact OpenAI API keys (sk-...)', () => {
    expect(sanitizeErrorMessage('Key: sk-proj-abcdefghijklmnopqrstuvwx'))
      .toContain('[REDACTED]');
    expect(sanitizeErrorMessage('Key: sk-proj-abcdefghijklmnopqrstuvwx'))
      .not.toContain('sk-proj-');
  });

  it('should redact Bearer tokens', () => {
    expect(sanitizeErrorMessage('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload'))
      .toContain('Bearer [REDACTED]');
    expect(sanitizeErrorMessage('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload'))
      .not.toContain('eyJhbG');
  });

  it('should redact x-api-key header values', () => {
    expect(sanitizeErrorMessage('x-api-key: sk-ant-api03-abcdef1234567890'))
      .toContain('x-api-key: [REDACTED]');
  });

  // -- Pass-through --
  it('should not alter messages without sensitive content', () => {
    const msg = 'Connection refused on port 8080';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it('should handle empty string', () => {
    expect(sanitizeErrorMessage('')).toBe('');
  });
});

// ============================================================================
// safePath — path traversal prevention
// ============================================================================

// A POSIX-absolute literal is not a path on Windows: safePath resolves it, so the
// assertion compared 'C:\project\src\foo.ts' against '/project/src/foo.ts'. Resolve the root
// once and build the expectations with join(), so both sides speak the host's syntax.
const PROJECT_ROOT = resolve('/project');

describe('safePath', () => {
  it('should allow a path within the project root', () => {
    const result = safePath(PROJECT_ROOT, 'src/foo.ts');
    expect(result).toBe(join(PROJECT_ROOT, 'src', 'foo.ts'));
  });

  it('should allow the project root itself', () => {
    const result = safePath(PROJECT_ROOT, '.');
    expect(result).toBe(PROJECT_ROOT);
  });

  it('should reject path traversal above root', () => {
    expect(safePath(PROJECT_ROOT, '../../../etc/passwd')).toBeNull();
  });

  it('should reject absolute paths outside root', () => {
    expect(safePath(PROJECT_ROOT, '/etc/passwd')).toBeNull();
  });

  it('should allow nested paths', () => {
    const result = safePath(PROJECT_ROOT, 'src/core/deep/file.ts');
    expect(result).toBe(join(PROJECT_ROOT, 'src', 'core', 'deep', 'file.ts'));
  });

  it('should reject prefix trick (e.g. /project-evil)', () => {
    // "/project-evil" starts with "/project" but is NOT inside it
    expect(safePath(PROJECT_ROOT, '../project-evil/hack.ts')).toBeNull();
  });

  it('should handle relative paths that resolve inside root', () => {
    // src/../src/file.ts resolves to /project/src/file.ts
    const result = safePath(PROJECT_ROOT, 'src/../src/file.ts');
    expect(result).toBe(join(PROJECT_ROOT, 'src', 'file.ts'));
  });

  // skipIf(win32): creating a symlink needs elevated privileges or Developer Mode there, so a
  // stock runner cannot build the escape this is about. The confinement is platform-independent
  // and is exercised on Linux.
  it.skipIf(process.platform === 'win32')('rejects an in-root symlink whose target is outside the project root', () => {
    const base = mkdtempSync(join(tmpdir(), 'openlore-view-path-'));
    const root = join(base, 'repo');
    const outside = join(base, 'outside.txt');
    mkdirSync(root);
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(root, 'escape.ts'));
    try {
      expect(safePath(root, 'escape.ts')).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('matches the shared MCP confinement guard on the same paths', () => {
    for (const candidate of ['.', 'src/file.ts', '../outside.ts', '/etc/passwd']) {
      let shared: string | null = null;
      try { shared = safeJoin(PROJECT_ROOT, candidate); } catch { /* rejected */ }
      expect(safePath(PROJECT_ROOT, candidate)).toBe(shared);
    }
  });
});

// ============================================================================
// API guard wiring — every /api route sits behind the shared guard
// ============================================================================

describe('view server API guard wiring', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });
  afterEach(() => {
    // The action installs SIGINT/SIGTERM handlers; drop them so they don't
    // accumulate across the suite.
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  /** Run the view action far enough to capture the vite plugin config. */
  async function captureViteConfig() {
    const { fileExists } = await import('../../utils/command-helpers.js');
    // graph exists, viewer index.html exists → createServer is reached.
    vi.mocked(fileExists).mockResolvedValue(true);
    const { createServer } = await import('vite');

    // Pass an explicit valid port. Commander >=13 restores pre-parse state on each
    // parse, so the shared viewCommand instance no longer leaks the last-parsed --port
    // from the port-validation tests above — but being explicit keeps this test
    // independent of that ordering either way.
    await viewCommand.parseAsync(['--no-open', '--port', '5199'], { from: 'user' });

    expect(vi.mocked(createServer)).toHaveBeenCalled();
    return vi.mocked(createServer).mock.calls[0][0] as {
      plugins: Array<{ name?: string; configureServer?: (s: unknown) => void; transformIndexHtml?: () => unknown }>;
    };
  }

  it('registers the /api guard before any /api/* route', async () => {
    const cfg = await captureViteConfig();
    const plugin = (cfg.plugins.flat() as Array<{ name?: string; configureServer?: (s: unknown) => void }>)
      .find((p) => p && p.name === 'openlore-graph-api');
    expect(plugin).toBeDefined();

    // `use` is called either as use(mw) — the root session guard — or use(path, mw).
    const registrations: Array<{ path: string }> = [];
    const fakeDevServer = {
      middlewares: {
        use: (a: unknown) => registrations.push({ path: typeof a === 'string' ? a : '/' }),
      },
    };
    plugin!.configureServer!(fakeDevServer);

    // The root session guard is registered FIRST, so `/` and its assets — not just
    // `/api` — are gated. That is what stops another local process fetching the page.
    expect(registrations[0].path).toBe('/');

    const guardIdx = registrations.findIndex((r) => r.path === '/api');
    const firstRouteIdx = registrations.findIndex((r) => r.path.startsWith('/api/'));
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(firstRouteIdx).toBeGreaterThanOrEqual(0);
    // The guard is registered (and therefore runs) before every scoped /api/* route.
    expect(guardIdx).toBeLessThan(firstRouteIdx);
    // No /api/* route may be registered before the guard.
    const routesBeforeGuard = registrations
      .slice(0, guardIdx)
      .filter((r) => r.path.startsWith('/api'));
    expect(routesBeforeGuard).toEqual([]);
  });

  it('does NOT put the token in the page it serves', async () => {
    // The whole point of the session handshake: the page used to embed the token, so
    // `curl http://127.0.0.1:PORT/` handed the credential to any local process — the
    // very attacker the token exists to stop.
    const cfg = await captureViteConfig();
    const plugin = (cfg.plugins.flat() as Array<{ name?: string; transformIndexHtml?: unknown }>)
      .find((p) => p && p.name === 'openlore-graph-api');
    expect(plugin).toBeDefined();
    expect(plugin!.transformIndexHtml).toBeUndefined();
  });

  it('writes a discovery descriptor on start', async () => {
    await captureViteConfig();
    const { confinedAtomicWriteFile } = await import('../../utils/path-confinement.js');
    const wrote = vi.mocked(confinedAtomicWriteFile).mock.calls.find(([, p]) => String(p).endsWith('view.json'));
    expect(wrote).toBeDefined();
    const payload = JSON.parse(String(wrote![2]));
    expect(payload).toMatchObject({ pid: process.pid, host: expect.any(String) });
    expect(typeof payload.token).toBe('string');
    expect(payload.token.length).toBeGreaterThan(0);
    // The descriptor carries the token that gates /api/chat, so it must not be
    // world-readable: another local process could otherwise read it and drive the
    // LLM-backed route the token exists to protect.
    expect(wrote![3]).toMatchObject({ mode: 0o600 });
  });

  it('routes spec traversal through the bounded symlink-skipping collector', async () => {
    const cfg = await captureViteConfig();
    const plugin = (cfg.plugins.flat() as Array<{ name?: string; configureServer?: (s: unknown) => void }>)
      .find((p) => p && p.name === 'openlore-graph-api')!;
    const routes = new Map<string, (...args: any[]) => unknown>();
    plugin.configureServer!({ middlewares: { use: (path: unknown, handler: unknown) => {
      if (typeof path === 'string' && typeof handler === 'function') routes.set(path, handler as (...args: any[]) => unknown);
    } } });
    const headers = new Map<string, string>();
    const response = {
      statusCode: 0, setHeader: (name: string, value: string) => headers.set(name, value),
      end: vi.fn(),
    };
    await routes.get('/api/spec')!({}, response);

    const { collectSpecMarkdown } = await import('./view-files.js');
    expect(collectSpecMarkdown).toHaveBeenCalledWith(expect.any(String), {
      confinementRoot: process.cwd(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.end).toHaveBeenCalledWith('# Spec');
    expect(headers.get('X-OpenLore-Spec-Truncated')).toBe('false');
  });

  it('serves stale metadata through /api/freshness and blocks traversal at /api/skeleton', async () => {
    const cfg = await captureViteConfig();
    const plugin = (cfg.plugins.flat() as Array<{ name?: string; configureServer?: (s: unknown) => void }>)
      .find((p) => p && p.name === 'openlore-graph-api')!;
    const routes = new Map<string, (...args: any[]) => unknown>();
    plugin.configureServer!({ middlewares: { use: (path: unknown, handler: unknown) => {
      if (typeof path === 'string' && typeof handler === 'function') routes.set(path, handler as (...args: any[]) => unknown);
    } } });

    const freshnessResponse = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await routes.get('/api/freshness')!({}, freshnessResponse);
    expect(freshnessResponse.statusCode).toBe(200);
    expect(JSON.parse(freshnessResponse.end.mock.calls[0][0])).toMatchObject({
      status: 'stale', filesChangedSince: 1,
    });

    const skeletonResponse = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await routes.get('/api/skeleton')!({ url: '/?file=../../etc/passwd' }, skeletonResponse);
    expect(skeletonResponse.statusCode).toBe(403);
    const { readConfinedFile } = await import('./view-files.js');
    expect(readConfinedFile).not.toHaveBeenCalled();
  });
});
