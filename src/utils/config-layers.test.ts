import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { globalOpenLoreConfigPath, mergeConfigLayers, readLayeredConfig } from './config-layers.js';
import { getDefaultConfig, readOpenLoreConfig, readOpenLoreConfigStrict, readProjectOpenLoreConfig, writeOpenLoreConfig } from '../core/services/config-manager.js';
import { refuseRepoConfiguredEndpoint, rejectRepoConfiguredTlsOptOut, resolveTrustedCompatBase, resolveTrustedSslVerify } from '../core/services/repo-config-trust.js';
import { logger } from './logger.js';
import { readConfig, readContextInjection, piMaySpawnDaemon, piToolSurface } from '../pi/extension.js';
import { autoInitSuppression, repairInBackground } from '../core/services/cold-start-bootstrap.js';

describe('user and project configuration layers', () => {
  let root: string;
  let globalPath: string;
  let project: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-config-layers-'));
    globalPath = join(root, 'user.json');
    project = join(root, 'project');
    await mkdir(join(project, '.openlore'), { recursive: true });
    vi.stubEnv('OPENLORE_GLOBAL_CONFIG', globalPath);
    vi.stubEnv('OPENLORE_PI_NO_SPAWN', '0');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('defaults to the Windows-compatible home directory path', () => {
    vi.stubEnv('OPENLORE_GLOBAL_CONFIG', '');
    expect(globalOpenLoreConfigPath()).toBe(join(homedir(), '.openlore', 'config.json'));
  });

  it('uses the same global-only defaults in CLI/MCP and Pi without creating project config', async () => {
    await writeFile(globalPath, JSON.stringify({
      generation: { provider: 'openai', model: 'user-model' },
      contextInjection: { mode: 'off' }, pi: { spawnDaemon: false, toolSurface: 'all' },
    }));
    expect(await readOpenLoreConfig(project)).toMatchObject({ generation: { provider: 'openai', model: 'user-model' } });
    expect(await readOpenLoreConfigStrict(project)).toMatchObject({ generation: { provider: 'openai' } });
    expect(await readConfig(project)).toMatchObject({ generation: { provider: 'openai', model: 'user-model' } });
    expect(await readContextInjection(project)).toEqual({ mode: 'off' });
    expect(await piMaySpawnDaemon(project)).toBe(false);
    expect(await piToolSurface(project)).toBe('all');
    await expect(access(join(project, '.openlore', 'config.json'))).rejects.toThrow();
  });

  it('merges object fields but replaces arrays, scalars and null with project values', async () => {
    await writeFile(globalPath, JSON.stringify({
      generation: { provider: 'openai', model: 'user-model' },
      analysis: { maxFiles: 123, excludePatterns: ['vendor/**'] },
      contextInjection: { mode: 'off', tokenBudget: 800 },
    }));
    await writeFile(join(project, '.openlore', 'config.json'), JSON.stringify({
      generation: { provider: 'openai', model: 'project-model' }, analysis: { excludePatterns: [] },
      contextInjection: { mode: 'task-scoped' },
    }));
    const config = await readOpenLoreConfig(project);
    expect(config).toMatchObject({
      generation: { provider: 'openai', model: 'project-model' },
      analysis: { maxFiles: 123, excludePatterns: [] },
      contextInjection: { mode: 'task-scoped', tokenBudget: 800 },
    });
    expect(mergeConfigLayers({ embedding: { model: 'x' } }, { embedding: null })).toEqual({});
  });

  it('does not inherit model or endpoint settings from a different provider', () => {
    const merged = mergeConfigLayers({ generation: {
      provider: 'openai-compat', model: 'old', openaiCompatBaseUrl: 'http://localhost:1234', skipSslVerify: true,
    } }, { generation: { provider: 'anthropic', model: 'new' } });
    expect(merged.generation).toEqual({ provider: 'anthropic', model: 'new' });
  });

  it('honors global auto-init suppression in the synchronous MCP repair path', async () => {
    await writeFile(globalPath, JSON.stringify({ autoInit: false }));
    expect(autoInitSuppression(project)).toMatchObject({ reason: 'config' });
    expect(repairInBackground(project, 'index-absent', { analyze: vi.fn() })).toBeNull();
    await writeFile(join(project, '.openlore', 'config.json'), JSON.stringify({ autoInit: true }));
    expect(autoInitSuppression(project)?.reason).not.toBe('config');
  });

  it('lets a project disable inherited embeddings with a null override', async () => {
    await writeFile(globalPath, JSON.stringify({ embedding: { baseUrl: 'http://localhost:11434', model: 'user-embed' } }));
    await writeFile(join(project, '.openlore', 'config.json'), JSON.stringify({ embedding: null }));
    expect(await readOpenLoreConfig(project)).not.toHaveProperty('embedding');
  });

  it('keeps explicit config files exclusive and ordinary writes project-local', async () => {
    const original = JSON.stringify({ generation: { provider: 'openai', model: 'user-model' } });
    await writeFile(globalPath, original);
    const explicit = join(root, 'explicit.json');
    await writeFile(explicit, JSON.stringify({ ...getDefaultConfig('nodejs', 'openspec'), generation: { provider: 'anthropic', model: 'explicit-model' } }));
    expect(await readOpenLoreConfig(project, explicit)).toMatchObject({ generation: { provider: 'anthropic', model: 'explicit-model' } });
    await writeOpenLoreConfig(project, getDefaultConfig('nodejs', 'openspec'));
    expect(await readFile(globalPath, 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(join(project, '.openlore', 'config.json'), 'utf8'))).toHaveProperty('projectType', 'nodejs');
  });

  it('rejects malformed global or project config at the strict enforcement boundary', async () => {
    await writeFile(globalPath, '{ broken');
    await expect(readOpenLoreConfigStrict(project)).rejects.toThrow(globalPath);
    await writeFile(globalPath, '{}');
    await writeFile(join(project, '.openlore', 'config.json'), '{ broken project');
    await expect(readOpenLoreConfigStrict(project)).rejects.toThrow(/malformed JSON/);
    await writeFile(globalPath, '[]');
    await expect(readLayeredConfig(join(project, '.openlore', 'config.json'))).rejects.toThrow(/not a JSON object/);
  });

  it('keeps the user provider/model pair over the built-in model `openlore init` writes', async () => {
    await writeFile(globalPath, JSON.stringify({ generation: { provider: 'openai', model: 'gpt-5' } }));
    await writeOpenLoreConfig(project, getDefaultConfig('nodejs', 'openspec'));
    expect((await readOpenLoreConfig(project))?.generation).toMatchObject({ provider: 'openai', model: 'gpt-5' });
    // A user provider with no user model: the built-in model must not pair with it either.
    await writeFile(globalPath, JSON.stringify({ generation: { provider: 'openai' } }));
    expect((await readOpenLoreConfig(project))?.generation).not.toHaveProperty('model');
  });

  it('does not inherit a user credential or TLS opt-out into a block whose endpoint the project chose', async () => {
    await writeFile(globalPath, JSON.stringify({ embedding: {
      baseUrl: 'https://embed.example.com/v1', model: 'user-embed', apiKey: 'user-secret', skipSslVerify: true,
    } }));
    await writeFile(join(project, '.openlore', 'config.json'), JSON.stringify({ embedding: { baseUrl: 'http://127.0.0.1:9999/v1' } }));
    expect((await readOpenLoreConfig(project))?.embedding).toEqual({ baseUrl: 'http://127.0.0.1:9999/v1', model: 'user-embed' });
    // The same endpoint as the user's keeps the user's key: the user chose that destination.
    await writeFile(join(project, '.openlore', 'config.json'), JSON.stringify({ embedding: { baseUrl: 'https://embed.example.com/v1', batchSize: 8 } }));
    expect((await readOpenLoreConfig(project))?.embedding).toMatchObject({ apiKey: 'user-secret' });
  });

  it('says once why an inherited user apiKey is not sent to a project-chosen endpoint', async () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    try {
      await writeFile(globalPath, JSON.stringify({ embedding: { baseUrl: 'https://embed.example.com/v1', model: 'm', apiKey: 'user-secret' } }));
      await writeFile(join(project, '.openlore', 'config.json'), JSON.stringify({ embedding: { baseUrl: 'http://127.0.0.1:9999/v1' } }));
      await readOpenLoreConfig(project);
      await readOpenLoreConfig(project);
      const withheld = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('embedding.apiKey'));
      expect(withheld).toHaveLength(1);
      expect(withheld[0]).not.toContain('user-secret');
      // The same endpoint as the user's keeps the key, so there is nothing to say.
      warn.mockClear();
      await writeFile(join(project, '.openlore', 'config.json'), JSON.stringify({ embedding: { baseUrl: 'https://embed.example.com/v1' } }));
      await readOpenLoreConfig(project);
      expect(warn.mock.calls.some(([m]) => String(m).includes('embedding.apiKey'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('drops a restated TLS opt-out beside a project-chosen endpoint', async () => {
    await writeFile(globalPath, JSON.stringify({ llm: { apiBase: 'https://corp-proxy.example', sslVerify: false } }));
    // Restating the user's value must not move the user's opt-out to the provider default.
    await writeFile(join(project, '.openlore', 'config.json'), JSON.stringify({ llm: { apiBase: '', sslVerify: false } }));
    const cfg = await readOpenLoreConfig(project);
    expect(cfg?.llm?.sslVerify).toBeUndefined();
    expect(resolveTrustedSslVerify(undefined, cfg?.llm?.sslVerify)).toBe(true);
  });

  it('applies repository trust checks to project values only, not user-wide values', async () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    try {
      await writeFile(globalPath, JSON.stringify({
        embedding: { baseUrl: 'https://embed.example.com/v1', model: 'm', skipSslVerify: true },
        generation: { provider: 'openai-compat', openaiCompatBaseUrl: 'https://gw.example.com/v1' },
      }));
      const cfg = await readOpenLoreConfig(project);
      expect(refuseRepoConfiguredEndpoint('embedding.baseUrl', cfg?.embedding?.baseUrl, '')).toBe('https://embed.example.com/v1');
      expect(rejectRepoConfiguredTlsOptOut('embedding.skipSslVerify', cfg?.embedding?.skipSslVerify)).toBe(true);
      expect(resolveTrustedCompatBase(undefined, cfg?.generation.openaiCompatBaseUrl)).toBe('https://gw.example.com/v1');
      expect(warn).not.toHaveBeenCalled();
      // A project-chosen remote endpoint is still refused and blamed on the repository.
      expect(refuseRepoConfiguredEndpoint('embedding.baseUrl', 'https://evil.example/v1', '')).toBeUndefined();
      expect(rejectRepoConfiguredTlsOptOut('generation.skipSslVerify', true)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the project file alone for read-modify-write and accepts embedding: null there', async () => {
    await writeFile(globalPath, JSON.stringify({ embedding: { baseUrl: 'https://embed.example.com/v1', model: 'm', apiKey: 'user-secret' } }));
    await writeFile(join(project, '.openlore', 'config.json'), JSON.stringify({ ...getDefaultConfig('nodejs', 'openspec'), embedding: null }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const own = await readProjectOpenLoreConfig(project);
      expect(own?.embedding).toBeNull();
      expect(JSON.stringify(own)).not.toContain('user-secret');
      expect(stderr.mock.calls.join('')).not.toContain('embedding');
    } finally {
      stderr.mockRestore();
    }
  });

  it('does not mutate layer objects or allow prototype pollution', () => {
    const user = { generation: { provider: 'openai', model: 'old' } };
    const projectConfig = JSON.parse('{"__proto__":{"polluted":true},"generation":{"provider":"anthropic"}}');
    mergeConfigLayers(user, projectConfig);
    expect(user.generation.model).toBe('old');
    expect({}).not.toHaveProperty('polluted');
  });
});
