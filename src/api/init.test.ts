/**
 * Tests for openloreInit programmatic API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreInit } from './init.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../core/services/project-detector.js', () => ({
  detectProjectType: vi.fn(),
  getProjectTypeName: vi.fn(),
}));

vi.mock('../core/services/config-manager.js', () => ({
  getDefaultConfig: vi.fn(),
  writeOpenLoreConfig: vi.fn(),
  openloreConfigExists: vi.fn(),
  openspecDirExists: vi.fn(),
  createOpenSpecStructure: vi.fn(),
  detectExistingSpecDir: vi.fn().mockResolvedValue(null),
}));

vi.mock('../core/services/gitignore-manager.js', () => ({
  gitignoreExists: vi.fn(),
  isInGitignore: vi.fn(),
  addToGitignore: vi.fn(),
  ensureGitignored: vi.fn(),
}));

import {
  detectProjectType,
  getProjectTypeName,
} from '../core/services/project-detector.js';
import {
  getDefaultConfig,
  writeOpenLoreConfig,
  openloreConfigExists,
  openspecDirExists,
  createOpenSpecStructure,
} from '../core/services/config-manager.js';
import {
  gitignoreExists,
  isInGitignore,
  addToGitignore,
  ensureGitignored,
} from '../core/services/gitignore-manager.js';

const mockDetectProjectType = vi.mocked(detectProjectType);
const mockGetProjectTypeName = vi.mocked(getProjectTypeName);
const mockGetDefaultConfig = vi.mocked(getDefaultConfig);
const mockWriteOpenLoreConfig = vi.mocked(writeOpenLoreConfig);
const mockOpenLoreConfigExists = vi.mocked(openloreConfigExists);
const mockOpenspecDirExists = vi.mocked(openspecDirExists);
const mockCreateOpenSpecStructure = vi.mocked(createOpenSpecStructure);
const mockGitignoreExists = vi.mocked(gitignoreExists);
const mockIsInGitignore = vi.mocked(isInGitignore);
const mockAddToGitignore = vi.mocked(addToGitignore);
const mockEnsureGitignored = vi.mocked(ensureGitignored);

// ============================================================================
// SETUP
// ============================================================================

const ROOT = '/test/project';
const DEFAULT_CONFIG = { version: '1.0.0', openspecPath: './openspec' } as ReturnType<typeof getDefaultConfig>;

beforeEach(() => {
  vi.clearAllMocks();
  mockDetectProjectType.mockResolvedValue({ projectType: 'nodejs' } as Awaited<ReturnType<typeof detectProjectType>>);
  mockGetProjectTypeName.mockReturnValue('nodejs');
  mockGetDefaultConfig.mockReturnValue(DEFAULT_CONFIG);
  mockWriteOpenLoreConfig.mockResolvedValue(undefined);
  mockOpenLoreConfigExists.mockResolvedValue(false);
  mockOpenspecDirExists.mockResolvedValue(false);
  mockCreateOpenSpecStructure.mockResolvedValue(undefined);
  mockGitignoreExists.mockResolvedValue(false);
  mockIsInGitignore.mockResolvedValue(false);
  mockAddToGitignore.mockResolvedValue(true);
  mockEnsureGitignored.mockResolvedValue('created');
});

// ============================================================================
// TESTS
// ============================================================================

describe('openloreInit', () => {
  describe('happy path — new project', () => {
    it('creates config and openspec structure', async () => {
      const result = await openloreInit({ rootPath: ROOT });

      expect(result.created).toBe(true);
      expect(result.projectType).toBe('nodejs');
      expect(result.configPath).toBe('.openlore/config.json');
      expect(mockWriteOpenLoreConfig).toHaveBeenCalledOnce();
      expect(mockCreateOpenSpecStructure).toHaveBeenCalledOnce();
    });

    it('delegates .openlore/ gitignore handling to ensureGitignored (which creates the file when absent)', async () => {
      await openloreInit({ rootPath: ROOT });

      // The create-or-append/skip decision lives in ensureGitignored (covered by its
      // own tests); init just delegates so a fresh `git init` repo always gets ignored.
      expect(mockEnsureGitignored).toHaveBeenCalledWith(ROOT, '.openlore/', expect.any(String));
    });

    it('skips createOpenSpecStructure when openspec dir already exists', async () => {
      mockOpenspecDirExists.mockResolvedValue(true);

      await openloreInit({ rootPath: ROOT });

      expect(mockCreateOpenSpecStructure).not.toHaveBeenCalled();
    });
  });

  describe('skip when config already exists', () => {
    it('returns created=false and skips writing config', async () => {
      mockOpenLoreConfigExists.mockResolvedValue(true);

      const result = await openloreInit({ rootPath: ROOT });

      expect(result.created).toBe(false);
      expect(mockWriteOpenLoreConfig).not.toHaveBeenCalled();
    });

    it('force=true re-creates config even if it exists', async () => {
      mockOpenLoreConfigExists.mockResolvedValue(true);

      const result = await openloreInit({ rootPath: ROOT, force: true });

      expect(result.created).toBe(true);
      expect(mockWriteOpenLoreConfig).toHaveBeenCalledOnce();
    });
  });

  describe('path validation', () => {
    it('throws if openspecPath escapes project root', async () => {
      await expect(
        openloreInit({ rootPath: ROOT, openspecPath: '../outside' })
      ).rejects.toThrow();
    });

    it('accepts relative openspecPath within root', async () => {
      await expect(
        openloreInit({ rootPath: ROOT, openspecPath: './openspec' })
      ).resolves.toBeDefined();
    });

    it('rejects an openspec symlink that resolves outside the project', async () => {
      const root = await mkdtemp(join(tmpdir(), 'openlore-init-root-'));
      const outside = await mkdtemp(join(tmpdir(), 'openlore-init-outside-'));
      try {
        await mkdir(root, { recursive: true });
        await symlink(outside, join(root, 'openspec'), 'dir');

        await expect(openloreInit({ rootPath: root })).rejects.toThrow(/escape|outside/i);
        expect(mockWriteOpenLoreConfig).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('progress callbacks', () => {
    it('fires progress events', async () => {
      const events: string[] = [];
      await openloreInit({
        rootPath: ROOT,
        onProgress: e => events.push(e.status),
      });
      expect(events).toContain('complete');
    });

    it('fires skip event when config exists', async () => {
      mockOpenLoreConfigExists.mockResolvedValue(true);
      const events: string[] = [];
      await openloreInit({
        rootPath: ROOT,
        onProgress: e => events.push(e.status),
      });
      expect(events).toContain('skip');
    });
  });
});
