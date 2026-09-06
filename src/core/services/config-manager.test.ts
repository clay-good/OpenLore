/**
 * Tests for config-manager service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getDefaultConfig,
  readOpenLoreConfig,
  readOpenLoreConfigStrict,
  writeOpenLoreConfig,
  openloreConfigExists,
  readOpenSpecConfig,
  writeOpenSpecConfig,
  openspecDirExists,
  openspecConfigExists,
  createOpenSpecStructure,
  mergeOpenSpecConfig,
  detectExistingSpecDir,
  normalizeOpenLoreConfig,
  resetConfigValidationWarnings,
} from './config-manager.js';
import { logger } from '../../utils/logger.js';

describe('config-manager', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('detectExistingSpecDir (Spec 26 B5)', () => {
    it('returns null when no specs exist anywhere', async () => {
      expect(await detectExistingSpecDir(testDir)).toBeNull();
    });

    it('detects specs under docs/specs/ and reports the root', async () => {
      await mkdir(join(testDir, 'docs', 'specs', 'auth'), { recursive: true });
      await writeFile(join(testDir, 'docs', 'specs', 'auth', 'spec.md'), '# auth\n');
      const found = await detectExistingSpecDir(testDir);
      expect(found).toEqual({ root: 'docs', specsRel: 'docs/specs', count: 1 });
    });

    it('prefers openspec/ over docs/ when both exist', async () => {
      await mkdir(join(testDir, 'openspec', 'specs'), { recursive: true });
      await writeFile(join(testDir, 'openspec', 'specs', 'a.md'), '# a\n');
      await mkdir(join(testDir, 'docs', 'specs'), { recursive: true });
      await writeFile(join(testDir, 'docs', 'specs', 'b.md'), '# b\n');
      const found = await detectExistingSpecDir(testDir);
      expect(found?.root).toBe('openspec');
    });

    it('ignores an empty specs directory (no *.md)', async () => {
      await mkdir(join(testDir, 'openspec', 'specs'), { recursive: true });
      expect(await detectExistingSpecDir(testDir)).toBeNull();
    });

    it('detects a bare specs/ dir as root "."', async () => {
      await mkdir(join(testDir, 'specs'), { recursive: true });
      await writeFile(join(testDir, 'specs', 'overview.md'), '# o\n');
      const found = await detectExistingSpecDir(testDir);
      expect(found).toEqual({ root: '.', specsRel: 'specs', count: 1 });
    });
  });

  describe('getDefaultConfig', () => {
    it('should return config with correct defaults', () => {
      const config = getDefaultConfig('nodejs', './openspec');

      expect(config.version).toBe('1.2.0');
      expect(config.projectType).toBe('nodejs');
      expect(config.openspecPath).toBe('./openspec');
      expect(config.analysis.maxFiles).toBe(100_000);
      expect(config.analysis.includePatterns).toEqual([]);
      expect(config.analysis.excludePatterns).toEqual([]);
      expect(config.generation.model).toBe('claude-sonnet-4-6');
      expect(config.generation.domains).toBe('auto');
      expect(config.createdAt).toBeDefined();
      expect(config.lastRun).toBe(null);
    });

    it('should use provided project type', () => {
      const config = getDefaultConfig('python', './specs');

      expect(config.projectType).toBe('python');
      expect(config.openspecPath).toBe('./specs');
    });
  });

  describe('openloreConfigExists', () => {
    it('should return false when config does not exist', async () => {
      const result = await openloreConfigExists(testDir);
      expect(result).toBe(false);
    });

    it('should return true when config exists', async () => {
      await mkdir(join(testDir, '.openlore'), { recursive: true });
      await writeFile(join(testDir, '.openlore', 'config.json'), '{}');

      const result = await openloreConfigExists(testDir);
      expect(result).toBe(true);
    });
  });

  describe('writeOpenLoreConfig and readOpenLoreConfig', () => {
    it('should write and read config correctly', async () => {
      const config = getDefaultConfig('rust', './docs/specs');

      await writeOpenLoreConfig(testDir, config);
      const readConfig = await readOpenLoreConfig(testDir);

      expect(readConfig).toEqual(config);
    });

    it('should create .openlore directory if it does not exist', async () => {
      const config = getDefaultConfig('go', './openspec');

      await writeOpenLoreConfig(testDir, config);

      const content = await readFile(join(testDir, '.openlore', 'config.json'), 'utf-8');
      expect(JSON.parse(content)).toEqual(config);
    });

    it('should return null when config does not exist', async () => {
      const result = await readOpenLoreConfig(testDir);
      expect(result).toBe(null);
    });  // skipIf(win32): creating a symlink there needs elevated privileges or Developer Mode,
  // so this cannot build the premise it asserts about and would test a plain file instead.
  // What it guards is platform-independent and is exercised on Linux.


    it.skipIf(process.platform === 'win32')('refuses to write config through an outbound .openlore symlink', async () => {
      const outside = join(tmpdir(), `openlore-config-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        await mkdir(outside, { recursive: true });
        await symlink(outside, join(testDir, '.openlore'), 'dir');

        await expect(
          writeOpenLoreConfig(testDir, getDefaultConfig('nodejs', './openspec')),
        ).rejects.toThrow(/escape|outside/i);
        await expect(readFile(join(outside, 'config.json'), 'utf8')).rejects.toThrow();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('openspecDirExists', () => {
    it('should return false when directory does not exist', async () => {
      const result = await openspecDirExists(join(testDir, 'openspec'));
      expect(result).toBe(false);
    });

    it('should return true when directory exists', async () => {
      await mkdir(join(testDir, 'openspec'));

      const result = await openspecDirExists(join(testDir, 'openspec'));
      expect(result).toBe(true);
    });
  });

  describe('openspecConfigExists', () => {
    it('should return false when config.yaml does not exist', async () => {
      await mkdir(join(testDir, 'openspec'));

      const result = await openspecConfigExists(join(testDir, 'openspec'));
      expect(result).toBe(false);
    });

    it('should return true when config.yaml exists', async () => {
      await mkdir(join(testDir, 'openspec'));
      await writeFile(join(testDir, 'openspec', 'config.yaml'), 'schema: spec-driven');

      const result = await openspecConfigExists(join(testDir, 'openspec'));
      expect(result).toBe(true);
    });
  });

  describe('writeOpenSpecConfig and readOpenSpecConfig', () => {
    it('should write and read YAML config correctly', async () => {
      const config = {
        schema: 'spec-driven',
        context: 'Test project context',
      };

      const openspecPath = join(testDir, 'openspec');
      await writeOpenSpecConfig(openspecPath, config);
      const readConfig = await readOpenSpecConfig(openspecPath);

      expect(readConfig).toEqual(config);
    });

    it('should return null when config does not exist', async () => {
      const result = await readOpenSpecConfig(join(testDir, 'openspec'));
      expect(result).toBe(null);
    });
  });

  describe('createOpenSpecStructure', () => {
    it('should create openspec directory and specs subdirectory', async () => {
      const openspecPath = join(testDir, 'openspec');

      await createOpenSpecStructure(openspecPath);

      expect(await openspecDirExists(openspecPath)).toBe(true);
      expect(await openspecDirExists(join(openspecPath, 'specs'))).toBe(true);
    });
  });

  describe('mergeOpenSpecConfig', () => {
    it('should create new config when existing is null', () => {
      const openloreMeta = {
        generatedAt: '2025-01-30T12:00:00Z',
        domains: ['auth', 'api'],
        confidence: 0.85,
      };

      const result = mergeOpenSpecConfig(null, openloreMeta);

      expect(result.schema).toBe('spec-driven');
      expect(result.context).toBe('');
      expect(result['openlore']).toEqual(openloreMeta);
    });

    it('should preserve existing config and merge openlore metadata', () => {
      const existing = {
        schema: 'custom-schema',
        context: 'Existing context',
        customField: 'value',
      };
      const openloreMeta = {
        generatedAt: '2025-01-30T12:00:00Z',
        domains: ['auth'],
      };

      const result = mergeOpenSpecConfig(existing, openloreMeta);

      expect(result.schema).toBe('custom-schema');
      expect(result.context).toBe('Existing context');
      expect(result.customField).toBe('value');
      expect(result['openlore']).toEqual(openloreMeta);
    });

    it('should merge openlore metadata with existing openlore data', () => {
      const existing = {
        schema: 'spec-driven',
        'openlore': {
          generatedAt: '2025-01-29T12:00:00Z',
          sourceProject: 'Original',
        },
      };
      const openloreMeta = {
        generatedAt: '2025-01-30T12:00:00Z',
        domains: ['api'],
      };

      const result = mergeOpenSpecConfig(existing, openloreMeta);

      expect(result['openlore']?.generatedAt).toBe('2025-01-30T12:00:00Z');
      expect(result['openlore']?.sourceProject).toBe('Original');
      expect(result['openlore']?.domains).toEqual(['api']);
    });
  });

  describe('readOpenLoreConfig — malformed JSON', () => {
    it('returns null when config.json contains invalid JSON', async () => {
      const configDir = join(testDir, '.openlore');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), '{ invalid json !!!', 'utf-8');

      const result = await readOpenLoreConfig(testDir);
      expect(result).toBeNull();
    });
  });

  describe('readOpenLoreConfigStrict', () => {
    it('returns null only when config.json is absent', async () => {
      await expect(readOpenLoreConfigStrict(testDir)).resolves.toBeNull();
    });

    it('rejects malformed JSON instead of lowering it to no policy', async () => {
      const configDir = join(testDir, '.openlore');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), '{ invalid json !!!', 'utf-8');

      await expect(readOpenLoreConfigStrict(testDir)).rejects.toThrow(/Invalid JSON.*config\.json/i);
    });

    it('rejects fatal schema findings', async () => {
      const configDir = join(testDir, '.openlore');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), JSON.stringify({
        ...getDefaultConfig('nodejs', 'openspec'),
        enforcement: { policy: { 'stale-decision-reference': 'not-a-class' } },
      }), 'utf-8');

      await expect(readOpenLoreConfigStrict(testDir)).rejects.toThrow(/enforcement\.policy/i);
    });
  });

  describe('readOpenLoreConfig — schema validation warnings (add-config-schema-validation)', () => {
    async function writeRawConfig(obj: unknown): Promise<void> {
      const configDir = join(testDir, '.openlore');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), JSON.stringify(obj), 'utf-8');
    }

    beforeEach(() => {
      resetConfigValidationWarnings();
      // Diagnostics go to stderr (keeping machine stdout pure); ensure the logger is
      // not in quiet mode, which suppresses them.
      logger.configure({ quiet: false, noColor: true });
    });

    /** Spy on the stderr channel the emitter writes to, returning captured lines. */
    function spyStderr(): { restore: () => void; lines: () => string[] } {
      const captured: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
      return { restore: () => spy.mockRestore(), lines: () => captured };
    }

    it('emits no warning for a valid config, and returns it unchanged', async () => {
      const s = spyStderr();
      try {
        const valid = getDefaultConfig('nodejs', 'openspec');
        await writeRawConfig(valid);
        const result = await readOpenLoreConfig(testDir);
        expect(result).not.toBeNull();
        expect(result?.projectType).toBe('nodejs');
        expect(s.lines().filter(m => m.includes('config.json'))).toHaveLength(0);
      } finally {
        s.restore();
      }
    });

    it('loads a pre-2.2 config by backfilling domains without replacing custom settings', async () => {
      const s = spyStderr();
      const source = await readFile(
        new URL('./fixtures/configs/2.1.9-customized.json', import.meta.url),
        'utf-8',
      );
      const legacy = JSON.parse(source) as Record<string, unknown>;
      try {
        const configDir = join(testDir, '.openlore');
        await mkdir(configDir, { recursive: true });
        const configPath = join(configDir, 'config.json');
        await writeFile(configPath, source, 'utf-8');

        const result = await readOpenLoreConfig(testDir);

        expect(result).toEqual({
          ...legacy,
          generation: { ...(legacy.generation as Record<string, unknown>), domains: 'auto' },
        });
        expect(await readFile(configPath, 'utf-8')).toBe(source);
        expect(s.lines().some(line => line.includes("generation.domains") && line.includes('"auto"'))).toBe(true);
      } finally {
        s.restore();
      }
    });

    it('loads every immutable release fixture without changing its bytes', async () => {
      const fixtureDir = new URL('./fixtures/configs/', import.meta.url);
      const fixtureNames = (await readdir(fixtureDir)).filter(name => name.endsWith('.json')).sort();
      const packageJson = JSON.parse(
        await readFile(new URL('../../../package.json', import.meta.url), 'utf-8'),
      ) as { version: string };
      expect(fixtureNames.some(name => name.startsWith(`${packageJson.version}-`))).toBe(true);

      const s = spyStderr();
      try {
        for (const fixtureName of fixtureNames) {
          resetConfigValidationWarnings();
          const source = await readFile(new URL(fixtureName, fixtureDir), 'utf-8');
          const configDir = join(testDir, '.openlore');
          await mkdir(configDir, { recursive: true });
          const configPath = join(configDir, 'config.json');
          await writeFile(configPath, source, 'utf-8');

          await expect(readOpenLoreConfig(testDir), fixtureName).resolves.not.toBeNull();
          expect(await readFile(configPath, 'utf-8'), fixtureName).toBe(source);
        }
      } finally {
        s.restore();
      }
    });

    it('normalization is idempotent and preserves explicit domain selections', () => {
      const legacy = {
        ...getDefaultConfig('nodejs', 'openspec'),
        generation: { model: 'custom' },
      };
      const first = normalizeOpenLoreConfig(legacy);
      const second = normalizeOpenLoreConfig(first.config);
      expect(first.findings.map(finding => finding.key)).toEqual(['generation.domains']);
      expect(second).toEqual({ config: first.config, findings: [] });

      const explicit = {
        ...legacy,
        generation: { model: 'custom', domains: ['auth', 'payments'] },
      };
      expect(normalizeOpenLoreConfig(explicit)).toEqual({ config: explicit, findings: [] });
    });

    it('does not repair a missing or truncated required top-level section', async () => {
      const defaults = getDefaultConfig('nodejs', 'openspec');
      const missingGeneration: Partial<typeof defaults> = structuredClone(defaults);
      delete missingGeneration.generation;
      await writeRawConfig(missingGeneration);
      await expect(readOpenLoreConfig(testDir)).rejects.toThrow(/generation/);

      await writeRawConfig({ ...defaults, analysis: {} });
      await expect(readOpenLoreConfig(testDir)).rejects.toThrow(/analysis\.(maxFiles|includePatterns|excludePatterns)/);
    });

    it('still rejects a present but invalid domains value', async () => {
      await writeRawConfig({
        ...getDefaultConfig('nodejs', 'openspec'),
        generation: { domains: 42 },
      });

      await expect(readOpenLoreConfig(testDir)).rejects.toThrow(/generation\.domains/);
    });

    it('warns with a did-you-mean on a typo\'d key, and still applies defaults', async () => {
      const s = spyStderr();
      try {
        const cfg = { ...getDefaultConfig('nodejs', 'openspec'), pancResponse: { mode: 'off' } };
        await writeRawConfig(cfg);
        const result = await readOpenLoreConfig(testDir);
        expect(result).not.toBeNull(); // never a hard failure
        expect(s.lines().some(m => m.includes('pancResponse') && m.includes('panicResponse'))).toBe(true);
      } finally {
        s.restore();
      }
    });

    it('is silent in quiet mode (errors-only)', async () => {
      logger.configure({ quiet: true });
      const s = spyStderr();
      try {
        await writeRawConfig({ ...getDefaultConfig('nodejs', 'openspec'), pancResponse: { mode: 'off' } });
        const result = await readOpenLoreConfig(testDir);
        expect(result).not.toBeNull();
        expect(s.lines().filter(m => m.includes('config.json'))).toHaveLength(0);
      } finally {
        s.restore();
        logger.configure({ quiet: false });
      }
    });

    it('deduplicates warnings across reads — one emission per process, not per read', async () => {
      const s = spyStderr();
      try {
        await writeRawConfig({ ...getDefaultConfig('nodejs', 'openspec'), embeding: {} });
        await readOpenLoreConfig(testDir);
        await readOpenLoreConfig(testDir);
        await readOpenLoreConfig(testDir);
        expect(s.lines().filter(m => m.includes('embeding'))).toHaveLength(1);
      } finally {
        s.restore();
      }
    });

    it('discloses a newer version stamp without crashing the read', async () => {
      const s = spyStderr();
      try {
        await writeRawConfig({ ...getDefaultConfig('nodejs', 'openspec'), version: '99.0.0' });
        const result = await readOpenLoreConfig(testDir);
        expect(result).not.toBeNull();
        expect(s.lines().some(m => m.includes('newer'))).toBe(true);
      } finally {
        s.restore();
      }
    });

    it('rejects an empty config with an attributable file and remedy', async () => {
      await writeRawConfig({});

      // The message attributes a HOST filesystem path the reader can open in their own
      // shell, so it is correctly rendered with the platform separator (unlike a
      // repository-relative path OpenLore SERVES, which is POSIX everywhere). Assert the
      // same thing — the config file is named, inside its `.openlore` directory —
      // separator-agnostically.
      await expect(readOpenLoreConfig(testDir)).rejects.toThrow(/[\\/]\.openlore[\\/]config\.json/);
      await expect(readOpenLoreConfig(testDir)).rejects.toThrow(/analysis/);
      await expect(readOpenLoreConfig(testDir)).rejects.toThrow(/openlore init/);
    });

    it('rejects a malformed nested field before a caller can dereference it', async () => {
      await writeRawConfig({
        ...getDefaultConfig('nodejs', 'openspec'),
        analysis: { maxFiles: 'lots', includePatterns: [], excludePatterns: [] },
      });

      await expect(readOpenLoreConfig(testDir)).rejects.toThrow(/analysis\.maxFiles/);
    });

    it('reports but preserves malformed optional sections for their domain validators', async () => {
      const s = spyStderr();
      try {
        await writeRawConfig({
          ...getDefaultConfig('nodejs', 'openspec'),
          specStore: { name: 42, path: false, targets: ['api'] },
        });

        const config = await readOpenLoreConfig(testDir);
        expect(config).not.toBeNull();
        expect(s.lines().some(line => line.includes('specStore.name'))).toBe(true);
        expect(s.lines().some(line => line.includes('specStore.path'))).toBe(true);
      } finally {
        s.restore();
      }
    });

    it('keeps invalid-config diagnostics off stdout', async () => {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await writeRawConfig({});
        await expect(readOpenLoreConfig(testDir)).rejects.toThrow();
        expect(stdout).not.toHaveBeenCalled();
      } finally {
        stdout.mockRestore();
      }
    });
  });

  describe('readOpenSpecConfig — malformed YAML', () => {
    it('returns null when config.yaml contains invalid YAML', async () => {
      const openspecDir = join(testDir, 'openspec');
      await mkdir(openspecDir, { recursive: true });
      // This string is syntactically invalid YAML (tabs where spaces expected, etc.)
      await writeFile(join(openspecDir, 'config.yaml'), 'key: [unclosed bracket', 'utf-8');

      const result = await readOpenSpecConfig(openspecDir);
      // Invalid YAML should return null (caught internally)
      expect(result).toBeNull();
    });
  });
});
