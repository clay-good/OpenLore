/**
 * Tests for openlore doctor command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { doctorCommand } from './doctor.js';

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

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date() }),
    // checkMcpWiring reads .claude/settings.json + .mcp.json; default to "absent"
    // so the suite is independent of the repo's own dogfood files.
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  };
});

// execFile is called via promisify — mock the whole module so the wrapper
// function created at import time references our controllable vi.fn().
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

vi.mock('../../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn().mockResolvedValue({
    projectType: 'nodejs',
    createdAt: '2024-01-01T00:00:00Z',
    openspecPath: './openspec',
    maxFiles: 500,
  }),
  // Default resolution: <root>/.openlore/config.json (no --config override in tests).
  resolveOpenLoreConfigPath: (rootPath: string) => `${rootPath}/.openlore/config.json`,
}));

vi.mock('../../core/services/llm-service.js', () => ({
  createLLMService: vi.fn().mockReturnValue({
    complete: vi.fn().mockResolvedValue({ model: 'claude-opus-4-6', content: 'pong' }),
    saveLogs: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ============================================================================
// HELPERS
// ============================================================================

import { execFile as execFileMock } from 'node:child_process';

/** Make execFileMock succeed (used for git --version, claude --version, df) */
function mockExecSuccess(stdout = 'ok'): void {
  vi.mocked(execFileMock).mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(null, { stdout, stderr: '' });
    return {} as ReturnType<typeof execFileMock>;
  });
}

/** Run doctor --json and return parsed check array */
async function runDoctorJson(): Promise<Array<{ name: string; status: string; detail: string; fix?: string }>> {
  const outputs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { outputs.push(msg); });
  try {
    await doctorCommand.parseAsync(['node', 'doctor', '--json'], { from: 'user' });
  } finally {
    spy.mockRestore();
  }
  const jsonLine = outputs.find(o => { try { JSON.parse(o); return true; } catch { return false; } });
  return JSON.parse(jsonLine!);
}

// ============================================================================
// TESTS
// ============================================================================

describe('doctor command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExecSuccess();
    // Restore readFile's documented default ("absent") — clearAllMocks resets call
    // history but NOT implementations, so a test that pointed readFile at a config
    // would otherwise leak that resolution into later tests (Config schema check).
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    // Restore default LLM mock after clearAllMocks
    const llmService = await import('../../core/services/llm-service.js');
    vi.mocked(llmService.createLLMService).mockReturnValue({
      complete: vi.fn().mockResolvedValue({ model: 'claude-opus-4-6', content: 'pong' }),
      saveLogs: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  describe('command configuration', () => {
    it('should have correct name', () => {
      expect(doctorCommand.name()).toBe('doctor');
    });

    it('should describe the command', () => {
      expect(doctorCommand.description()).toContain('environment');
    });

    it('should have --json option defaulting to false', () => {
      const jsonOption = doctorCommand.options.find(o => o.long === '--json');
      expect(jsonOption).toBeDefined();
      expect(jsonOption?.defaultValue).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  describe('--json output', () => {
    it('should produce valid JSON', async () => {
      const checks = await runDoctorJson();
      expect(Array.isArray(checks)).toBe(true);
    });

    it('should include exactly 10 checks', async () => {
      const checks = await runDoctorJson();
      expect(checks).toHaveLength(10);
    });

    it('should include a Config schema check', async () => {
      const checks = await runDoctorJson();
      expect(checks.find(c => c.name === 'Config schema')).toBeDefined();
    });

    it('should include a Parse health check', async () => {
      const checks = await runDoctorJson();
      expect(checks.find(c => c.name === 'Parse health')).toBeDefined();
    });

    it('should include a Graph store check', async () => {
      const checks = await runDoctorJson();
      expect(checks.find(c => c.name === 'Graph store')).toBeDefined();
    });

    it('each check should have name, status, and detail fields', async () => {
      const checks = await runDoctorJson();
      for (const c of checks) {
        expect(c).toHaveProperty('name');
        expect(c).toHaveProperty('status');
        expect(c).toHaveProperty('detail');
        expect(['ok', 'warn', 'fail']).toContain(c.status);
      }
    });

    it('should include a Node.js version check', async () => {
      const checks = await runDoctorJson();
      const nodeCheck = checks.find(c => c.name === 'Node.js version');
      expect(nodeCheck).toBeDefined();
      expect(nodeCheck!.detail).toMatch(/^v\d+\./);
    });

    it('should include a Git repository check', async () => {
      const checks = await runDoctorJson();
      const gitCheck = checks.find(c => c.name === 'Git repository');
      expect(gitCheck).toBeDefined();
    });

    it('should include a openlore config check', async () => {
      const checks = await runDoctorJson();
      const configCheck = checks.find(c => c.name === 'openlore config');
      expect(configCheck).toBeDefined();
    });

    it('should include an Analysis artifacts check', async () => {
      const checks = await runDoctorJson();
      const artifactCheck = checks.find(c => c.name === 'Analysis artifacts');
      expect(artifactCheck).toBeDefined();
    });

    it('should include an OpenSpec directory check', async () => {
      const checks = await runDoctorJson();
      const openspecCheck = checks.find(c => c.name === 'OpenSpec directory');
      expect(openspecCheck).toBeDefined();
    });

    it('should include an LLM connection check', async () => {
      const checks = await runDoctorJson();
      const llmCheck = checks.find(c => c.name === 'LLM connection');
      expect(llmCheck).toBeDefined();
    });

    it('should include a Disk space check', async () => {
      const checks = await runDoctorJson();
      const diskCheck = checks.find(c => c.name === 'Disk space');
      expect(diskCheck).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  describe('Node.js version check', () => {
    it('should pass for the current Node.js version (>=20)', async () => {
      const checks = await runDoctorJson();
      const nodeCheck = checks.find(c => c.name === 'Node.js version')!;
      expect(nodeCheck.status).toBe('ok');
    });
  });

  // --------------------------------------------------------------------------
  describe('LLM connection check', () => {
    const keyVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPAT_API_KEY'];

    function clearLLMKeys(): Record<string, string | undefined> {
      const saved: Record<string, string | undefined> = {};
      for (const k of keyVars) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
      return saved;
    }

    function restoreLLMKeys(saved: Record<string, string | undefined>): void {
      for (const k of keyVars) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }

    it('should pass (ok) when createLLMService and complete() both succeed', async () => {
      const saved = clearLLMKeys();
      process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('ok');
        expect(llmCheck.detail).toContain('anthropic');
      } finally {
        restoreLLMKeys(saved);
      }
    });

    it('should detect gemini provider when GEMINI_API_KEY is set', async () => {
      const saved = clearLLMKeys();
      process.env.GEMINI_API_KEY = 'test-gemini-key';
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('ok');
        expect(llmCheck.detail).toContain('gemini');
      } finally {
        restoreLLMKeys(saved);
      }
    });

    it('warns (not fails) when createLLMService throws (missing API key) — LLM is optional', async () => {
      const saved = clearLLMKeys();
      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockImplementationOnce(() => {
        throw new Error('No API key');
      });
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('warn');
        expect(llmCheck.fix).toBeDefined();
        expect(llmCheck.fix).toContain('Optional');
      } finally {
        restoreLLMKeys(saved);
      }
    });

    it('warns (not fails) when complete() rejects (network error)', async () => {
      const saved = clearLLMKeys();
      process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockReturnValueOnce({
        complete: vi.fn().mockRejectedValue(new Error('Connection refused')),
        saveLogs: vi.fn().mockResolvedValue(undefined),
      } as never);
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('warn');
        expect(llmCheck.fix).toContain('Optional');
      } finally {
        restoreLLMKeys(saved);
      }
    });

    it('should include a fix suggestion when degraded', async () => {
      const saved = clearLLMKeys();
      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockImplementationOnce(() => {
        throw new Error('No API key');
      });
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.fix).toBeDefined();
      } finally {
        restoreLLMKeys(saved);
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('config check', () => {
    it('should show ok when config exists and parses', async () => {
      const checks = await runDoctorJson();
      const configCheck = checks.find(c => c.name === 'openlore config')!;
      expect(configCheck.status).toBe('ok');
      expect(configCheck.detail).toContain('nodejs');
    });

    it('should show warn when config file is not accessible', async () => {
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'));

      const checks = await runDoctorJson();
      const configCheck = checks.find(c => c.name === 'openlore config')!;
      expect(configCheck.status).toBe('warn');
      expect(configCheck.fix).toContain('openlore init');
      // Onboarding: an un-set-up repo is steered to the one-command path first.
      expect(configCheck.fix).toContain('openlore install');
    });

    it('should show fail when config file exists but cannot be parsed', async () => {
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockResolvedValue(undefined);

      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.readOpenLoreConfig).mockResolvedValue(null);

      const checks = await runDoctorJson();
      const configCheck = checks.find(c => c.name === 'openlore config')!;
      expect(configCheck.status).toBe('fail');
      expect(configCheck.fix).toContain('openlore init');
    });
  });

  // --------------------------------------------------------------------------
  describe('config schema check (add-config-schema-validation)', () => {
    it('shows ok when there is no config file to validate', async () => {
      // Default readFile mock rejects (ENOENT) — nothing to validate.
      const checks = await runDoctorJson();
      const schemaCheck = checks.find(c => c.name === 'Config schema')!;
      expect(schemaCheck.status).toBe('ok');
    });

    it('shows ok for a config with only known, well-typed keys', async () => {
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          version: '1.0.0',
          projectType: 'nodejs',
          openspecPath: 'openspec',
          analysis: { maxFiles: 1, includePatterns: [], excludePatterns: [] },
          generation: { domains: 'auto' },
          createdAt: '2026-01-01T00:00:00Z',
          lastRun: null,
        }) as never
      );
      const checks = await runDoctorJson();
      const schemaCheck = checks.find(c => c.name === 'Config schema')!;
      expect(schemaCheck.status).toBe('ok');
    });

    it('warns and names an unknown (typo\'d) key with a suggestion', async () => {
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          version: '1.0.0',
          projectType: 'nodejs',
          openspecPath: 'openspec',
          analysis: { maxFiles: 1, includePatterns: [], excludePatterns: [] },
          generation: { domains: 'auto' },
          createdAt: '2026-01-01T00:00:00Z',
          lastRun: null,
          pancResponse: { mode: 'off' },
        }) as never
      );
      const checks = await runDoctorJson();
      const schemaCheck = checks.find(c => c.name === 'Config schema')!;
      expect(schemaCheck.status).toBe('warn');
      expect(schemaCheck.detail).toContain('pancResponse');
      expect(schemaCheck.detail).toContain('panicResponse');
      expect(schemaCheck.fix).toContain('openlore init');
    });
  });

  // --------------------------------------------------------------------------
  describe('analysis artifacts check', () => {
    it('should show ok for fresh analysis (< warning threshold)', async () => {
      const { stat } = await import('node:fs/promises');
      vi.mocked(stat).mockResolvedValue({ mtime: new Date() } as ReturnType<typeof stat> extends Promise<infer T> ? T : never);

      const checks = await runDoctorJson();
      const artifactCheck = checks.find(c => c.name === 'Analysis artifacts')!;
      expect(artifactCheck.status).toBe('ok');
    });

    it('should show warn for stale analysis', async () => {
      const { stat } = await import('node:fs/promises');
      const staleDate = new Date(Date.now() - 30 * 24 * 3600 * 1000); // 30 days ago
      vi.mocked(stat).mockResolvedValue({ mtime: staleDate } as ReturnType<typeof stat> extends Promise<infer T> ? T : never);

      const checks = await runDoctorJson();
      const artifactCheck = checks.find(c => c.name === 'Analysis artifacts')!;
      expect(artifactCheck.status).toBe('warn');
      expect(artifactCheck.fix).toContain('openlore analyze');
    });

    it('should show warn when no analysis exists', async () => {
      const { stat } = await import('node:fs/promises');
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

      const checks = await runDoctorJson();
      const artifactCheck = checks.find(c => c.name === 'Analysis artifacts')!;
      expect(artifactCheck.status).toBe('warn');
      // Onboarding: steer to the one-command setup before the manual analyze.
      expect(artifactCheck.fix).toContain('openlore install');
    });
  });

  // --------------------------------------------------------------------------
  describe('exit code', () => {
    it('should report a fail when a deterministic check fails (unparseable config)', async () => {
      consoleSpy.mockImplementation(() => {});
      // A missing LLM is only a warning now (B4); a genuine fail comes from a
      // deterministic check — here an existing-but-unparseable config.
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockResolvedValue(undefined);
      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.readOpenLoreConfig).mockResolvedValue(null);

      const checks = await runDoctorJson();
      const configCheck = checks.find(c => c.name === 'openlore config')!;
      expect(configCheck.status).toBe('fail');
      const failures = checks.filter(c => c.status === 'fail');
      expect(failures.length).toBeGreaterThan(0);
    });

    it('missing LLM/embedding alone does NOT fail (exit stays 0)', async () => {
      consoleSpy.mockImplementation(() => {});
      // Valid, parseable config so the deterministic checks all pass/warn.
      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.readOpenLoreConfig).mockResolvedValue({
        projectType: 'nodejs', createdAt: '2024-01-01T00:00:00Z', openspecPath: './openspec', maxFiles: 500,
      } as never);
      const keyVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPAT_API_KEY'];
      const saved: Record<string, string | undefined> = {};
      for (const k of keyVars) { saved[k] = process.env[k]; delete process.env[k]; }

      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockImplementationOnce(() => {
        throw new Error('No API key');
      });
      try {
        const checks = await runDoctorJson();
        const llmCheck = checks.find(c => c.name === 'LLM connection')!;
        expect(llmCheck.status).toBe('warn');
        expect(checks.filter(c => c.status === 'fail')).toHaveLength(0);
      } finally {
        for (const k of keyVars) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
      }
    });

    it('should not set exitCode=1 when all checks pass', async () => {
      consoleSpy.mockImplementation(() => {});
      const saved: Record<string, string | undefined> = {};
      saved['ANTHROPIC_API_KEY'] = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      mockExecSuccess();

      try {
        await doctorCommand.parseAsync(['node', 'doctor'], { from: 'user' });
        expect(process.exitCode).not.toBe(1);
      } finally {
        if (saved['ANTHROPIC_API_KEY'] === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved['ANTHROPIC_API_KEY'];
      }
    });

    it('non-JSON: logger.success is called when all checks pass', async () => {
      // Commander.js v12 does not reset option values between parseAsync calls,
      // so we must manually reset --json to false before running in non-JSON mode.
      doctorCommand.setOptionValue('json', false);

      // Re-mock fs functions (clearAllMocks may reset mockResolvedValue)
      const { stat, access } = await import('node:fs/promises');
      vi.mocked(stat).mockResolvedValue({ mtime: new Date() } as ReturnType<typeof stat> extends Promise<infer T> ? T : never);
      vi.mocked(access).mockResolvedValue(undefined);
      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.readOpenLoreConfig).mockResolvedValue({
        projectType: 'nodejs', createdAt: '2024-01-01T00:00:00Z', openspecPath: './openspec', maxFiles: 500,
      } as never);

      // Ensure createLLMService returns a working mock (clearAllMocks resets it)
      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockReturnValue({
        complete: vi.fn().mockResolvedValue({ model: 'claude-opus-4-6', content: 'pong' }),
        saveLogs: vi.fn().mockResolvedValue(undefined),
      } as never);

      const saved = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const loggerModule = await import('../../utils/logger.js');
      vi.mocked(loggerModule.logger.success).mockClear();

      try {
        await doctorCommand.parseAsync(['node', 'doctor'], { from: 'user' });
        expect(vi.mocked(loggerModule.logger.success)).toHaveBeenCalledWith('All checks passed!');
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    it('non-JSON: logger.error called and exitCode=1 when a deterministic check fails', async () => {
      doctorCommand.setOptionValue('json', false);

      // Trigger a genuine fail via an existing-but-unparseable config (missing
      // LLM would only warn now, B4).
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockResolvedValue(undefined);
      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.readOpenLoreConfig).mockResolvedValue(null);

      const loggerModule = await import('../../utils/logger.js');
      vi.mocked(loggerModule.logger.error).mockClear();

      await doctorCommand.parseAsync(['node', 'doctor'], { from: 'user' });
      expect(vi.mocked(loggerModule.logger.error)).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('non-JSON summary names the warned check, not a hardcoded "optional features" line (fix-cli-output-hygiene)', async () => {
      doctorCommand.setOptionValue('json', false);

      // Valid config so nothing FAILS; drop every provider key so the LLM check WARNS.
      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.readOpenLoreConfig).mockResolvedValue({
        projectType: 'nodejs', createdAt: '2024-01-01T00:00:00Z', openspecPath: './openspec', maxFiles: 500,
      } as never);
      const keyVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPAT_API_KEY'];
      const saved: Record<string, string | undefined> = {};
      for (const k of keyVars) { saved[k] = process.env[k]; delete process.env[k]; }

      const llmService = await import('../../core/services/llm-service.js');
      vi.mocked(llmService.createLLMService).mockImplementationOnce(() => { throw new Error('No API key'); });

      const loggerModule = await import('../../utils/logger.js');
      vi.mocked(loggerModule.logger.warning).mockClear();

      try {
        await doctorCommand.parseAsync(['node', 'doctor'], { from: 'user' });
        const warnCalls = vi.mocked(loggerModule.logger.warning).mock.calls.map(c => String(c[0]));
        const summary = warnCalls.find(m => /\d+ warning\(s\):/.test(m));
        expect(summary, `expected a summary warning; got: ${JSON.stringify(warnCalls)}`).toBeTruthy();
        // Derived from the actual warned checks, not the old hardcoded assumption.
        expect(summary).toContain('LLM connection');
        expect(summary).not.toContain('optional features (LLM generate, embeddings) may be limited');
      } finally {
        for (const k of keyVars) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('disk space check', () => {
    it('should show fail when available disk is critically low', async () => {
      // df -k output: header + data line with low available (col 3 = 100 KB = ~0 MB)
      mockExecSuccess('Filesystem 1K-blocks Used Available Use% Mounted\n/dev/disk1 100000000 99999900 100 0% /');

      const checks = await runDoctorJson();
      const diskCheck = checks.find(c => c.name === 'Disk space')!;
      expect(diskCheck.status).toBe('fail');
      expect(diskCheck.detail).toContain('MB available');
    });

    it('should show warn when available disk is low', async () => {
      // ~400 MB available (between FAIL and WARN thresholds)
      mockExecSuccess('Filesystem 1K-blocks Used Available Use% Mounted\n/dev/disk1 100000000 99590000 410000 0% /');

      const checks = await runDoctorJson();
      const diskCheck = checks.find(c => c.name === 'Disk space')!;
      expect(diskCheck.status).toBe('warn');
      expect(diskCheck.detail).toContain('MB available');
    });

    it('should show ok when disk has plenty of space', async () => {
      // 50 GB available
      mockExecSuccess('Filesystem 1K-blocks Used Available Use% Mounted\n/dev/disk1 200000000 100000000 52428800 0% /');

      const checks = await runDoctorJson();
      const diskCheck = checks.find(c => c.name === 'Disk space')!;
      expect(diskCheck.status).toBe('ok');
      expect(diskCheck.detail).toContain('MB available');
    });
  });

  // --------------------------------------------------------------------------
  describe('MCP wiring check', () => {
    /** Make readFile return given JSON for matching relative paths, ENOENT otherwise. */
    async function mockMcpFiles(files: Record<string, unknown>): Promise<void> {
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockImplementation(((p: any) => {
        const path = String(p);
        for (const [rel, content] of Object.entries(files)) {
          if (path.endsWith(rel)) return Promise.resolve(JSON.stringify(content));
        }
        return Promise.reject(new Error('ENOENT'));
      }) as never);
    }

    const OPENLORE_SERVER = { mcpServers: { openlore: { command: 'npx', args: ['--yes', 'openlore', 'mcp'] } } };

    it('is omitted when no MCP wiring is present', async () => {
      const checks = await runDoctorJson();
      expect(checks.find(c => c.name === 'MCP wiring')).toBeUndefined();
    });

    it('warns when the server lives only in .claude/settings.json', async () => {
      await mockMcpFiles({ '.claude/settings.json': OPENLORE_SERVER });
      const checks = await runDoctorJson();
      const mcp = checks.find(c => c.name === 'MCP wiring')!;
      expect(mcp.status).toBe('warn');
      expect(mcp.detail).toContain('settings.json');
      expect(mcp.fix).toContain('--force');
    });

    it('passes when the server lives in .mcp.json', async () => {
      await mockMcpFiles({ '.mcp.json': OPENLORE_SERVER });
      const checks = await runDoctorJson();
      const mcp = checks.find(c => c.name === 'MCP wiring')!;
      expect(mcp.status).toBe('ok');
    });

    it('warns about a stale settings.json entry when both files have it', async () => {
      await mockMcpFiles({ '.claude/settings.json': OPENLORE_SERVER, '.mcp.json': OPENLORE_SERVER });
      const checks = await runDoctorJson();
      const mcp = checks.find(c => c.name === 'MCP wiring')!;
      expect(mcp.status).toBe('warn');
      expect(mcp.detail).toContain('stale');
    });
  });
});
