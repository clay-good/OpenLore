/**
 * Tests for openlore init command
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initCommand } from './init.js';

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

vi.mock('../../core/services/project-detector.js', () => ({
  detectProjectType: vi.fn().mockResolvedValue({
    projectType: 'nodejs',
    hasGit: true,
    manifestFile: 'package.json',
    confidence: 'high',
  }),
  getProjectTypeName: vi.fn().mockReturnValue('Node.js'),
}));

vi.mock('../../core/services/config-manager.js', () => ({
  openloreConfigExists: vi.fn().mockResolvedValue(false),
  openspecDirExists: vi.fn().mockResolvedValue(false),
  openspecConfigExists: vi.fn().mockResolvedValue(false),
  getDefaultConfig: vi.fn().mockReturnValue({ projectType: 'nodejs', createdAt: '2024-01-01' }),
  readOpenLoreConfig: vi.fn().mockResolvedValue(null),
  writeOpenLoreConfig: vi.fn().mockResolvedValue(undefined),
  readOpenSpecConfig: vi.fn().mockResolvedValue(null),
  createOpenSpecStructure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/gitignore-manager.js', () => ({
  gitignoreExists: vi.fn().mockResolvedValue(false),
  isInGitignore: vi.fn().mockResolvedValue(false),
  addToGitignore: vi.fn().mockResolvedValue(undefined),
  ensureGitignored: vi.fn().mockResolvedValue('created'),
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

// ============================================================================
// TESTS
// ============================================================================

describe('init command', () => {
  describe('command configuration', () => {
    it('should have correct name and description', () => {
      expect(initCommand.name()).toBe('init');
      expect(initCommand.description()).toContain('Initialize');
    });

    it('should have --force option defaulting to false', () => {
      const forceOption = initCommand.options.find(o => o.long === '--force');
      expect(forceOption).toBeDefined();
      expect(forceOption?.defaultValue).toBe(false);
    });

    it('should have --openspec-path option with default', () => {
      const pathOption = initCommand.options.find(o => o.long === '--openspec-path');
      expect(pathOption).toBeDefined();
      expect(pathOption?.defaultValue).toBe('./openspec');
    });
  });

  describe('path traversal protection', () => {
    beforeEach(() => {
      process.exitCode = undefined;
    });

    it('should reject openspec paths outside the project root', async () => {
      const { logger } = await import('../../utils/logger.js');
      await initCommand.parseAsync(['--openspec-path', '../outside'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('within the project directory')
      );
      expect(process.exitCode).toBe(1);
    });

    it('should reject deeply nested traversal paths', async () => {
      const { logger } = await import('../../utils/logger.js');
      await initCommand.parseAsync(['--openspec-path', '../../way/outside'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('within the project directory')
      );
      expect(process.exitCode).toBe(1);
    });

    it('should accept paths within the project root', async () => {
      await initCommand.parseAsync(['--openspec-path', './docs/specs'], { from: 'user' });
      expect(process.exitCode).not.toBe(1);
    });
  });

  describe('happy path — fresh project', () => {
    beforeEach(async () => {
      process.exitCode = undefined;
      vi.clearAllMocks();

      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.openloreConfigExists).mockResolvedValue(false);
      vi.mocked(configManager.openspecDirExists).mockResolvedValue(false);
      vi.mocked(configManager.openspecConfigExists).mockResolvedValue(false);
      vi.mocked(configManager.getDefaultConfig).mockReturnValue({ projectType: 'nodejs', createdAt: '2024-01-01' } as never);

      const detector = await import('../../core/services/project-detector.js');
      vi.mocked(detector.detectProjectType).mockResolvedValue({
        projectType: 'nodejs',
        hasGit: true,
        manifestFile: 'package.json',
        confidence: 'high',
      });
      vi.mocked(detector.getProjectTypeName).mockReturnValue('Node.js');
    });

    it('should write config when no config exists', async () => {
      const configManager = await import('../../core/services/config-manager.js');
      await initCommand.parseAsync([], { from: 'user' });
      expect(configManager.writeOpenLoreConfig).toHaveBeenCalled();
    });

    it('should create openspec structure when directory does not exist', async () => {
      const configManager = await import('../../core/services/config-manager.js');
      await initCommand.parseAsync([], { from: 'user' });
      expect(configManager.createOpenSpecStructure).toHaveBeenCalled();
    });

    it('should not create openspec structure when directory already exists', async () => {
      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.openspecDirExists).mockResolvedValue(true);

      await initCommand.parseAsync([], { from: 'user' });
      expect(configManager.createOpenSpecStructure).not.toHaveBeenCalled();
    });

    it('should not set process.exitCode on success', async () => {
      await initCommand.parseAsync([], { from: 'user' });
      expect(process.exitCode).not.toBe(1);
    });
  });

  describe('existing config handling', () => {
    beforeEach(async () => {
      process.exitCode = undefined;
      vi.clearAllMocks();

      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.openloreConfigExists).mockResolvedValue(true);
      vi.mocked(configManager.readOpenLoreConfig).mockResolvedValue({
        projectType: 'nodejs',
        createdAt: '2024-01-01T00:00:00Z',
        openspecPath: './openspec',
        maxFiles: 500,
        model: 'claude-opus-4-5',
        provider: 'anthropic',
      } as never);
      vi.mocked(configManager.openspecDirExists).mockResolvedValue(false);
      vi.mocked(configManager.openspecConfigExists).mockResolvedValue(false);
      vi.mocked(configManager.getDefaultConfig).mockReturnValue({ projectType: 'nodejs', createdAt: '2024-01-01' } as never);

      const detector = await import('../../core/services/project-detector.js');
      vi.mocked(detector.detectProjectType).mockResolvedValue({
        projectType: 'nodejs',
        hasGit: true,
        manifestFile: 'package.json',
        confidence: 'high',
      });
      vi.mocked(detector.getProjectTypeName).mockReturnValue('Node.js');
    });

    it('should exit with error in non-TTY mode without --force', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      try {
        await initCommand.parseAsync([], { from: 'user' });
        expect(process.exitCode).toBe(1);
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
      }
    });

    it('should overwrite config when --force is passed', async () => {
      const configManager = await import('../../core/services/config-manager.js');
      await initCommand.parseAsync(['--force'], { from: 'user' });
      expect(configManager.writeOpenLoreConfig).toHaveBeenCalled();
      expect(process.exitCode).not.toBe(1);
    });
  });

  describe('gitignore integration', () => {
    beforeEach(async () => {
      process.exitCode = undefined;
      vi.clearAllMocks();

      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.openloreConfigExists).mockResolvedValue(false);
      vi.mocked(configManager.openspecDirExists).mockResolvedValue(false);
      vi.mocked(configManager.openspecConfigExists).mockResolvedValue(false);
      vi.mocked(configManager.getDefaultConfig).mockReturnValue({ projectType: 'nodejs', createdAt: '2024-01-01' } as never);

      const detector = await import('../../core/services/project-detector.js');
      vi.mocked(detector.detectProjectType).mockResolvedValue({
        projectType: 'nodejs', hasGit: true, manifestFile: 'package.json', confidence: 'high',
      });
      vi.mocked(detector.getProjectTypeName).mockReturnValue('Node.js');
    });

    it('should add .openlore/ to gitignore when gitignore exists and not yet ignored', async () => {
      const gitignoreManager = await import('../../core/services/gitignore-manager.js');
      vi.mocked(gitignoreManager.gitignoreExists).mockResolvedValue(true);
      vi.mocked(gitignoreManager.isInGitignore).mockResolvedValue(false);

      // Non-TTY: auto-add
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      try {
        await initCommand.parseAsync([], { from: 'user' });
        expect(gitignoreManager.ensureGitignored).toHaveBeenCalled();
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
      }
    });

    it('should skip adding to gitignore when already ignored', async () => {
      const gitignoreManager = await import('../../core/services/gitignore-manager.js');
      vi.mocked(gitignoreManager.gitignoreExists).mockResolvedValue(true);
      vi.mocked(gitignoreManager.isInGitignore).mockResolvedValue(true);

      await initCommand.parseAsync([], { from: 'user' });
      expect(gitignoreManager.ensureGitignored).not.toHaveBeenCalled();
    });

    it('should create .gitignore with .openlore/ when no .gitignore file exists', async () => {
      const gitignoreManager = await import('../../core/services/gitignore-manager.js');
      vi.mocked(gitignoreManager.gitignoreExists).mockResolvedValue(false);
      vi.mocked(gitignoreManager.isInGitignore).mockResolvedValue(false);

      // Non-TTY: auto-add (no interactive prompt)
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      try {
        await initCommand.parseAsync([], { from: 'user' });
        expect(gitignoreManager.ensureGitignored).toHaveBeenCalledWith(
          expect.any(String),
          '.openlore/',
          expect.any(String)
        );
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
      }
    });
  });

  describe('project type detection', () => {
    beforeEach(async () => {
      process.exitCode = undefined;
      vi.clearAllMocks();

      const configManager = await import('../../core/services/config-manager.js');
      vi.mocked(configManager.openloreConfigExists).mockResolvedValue(false);
      vi.mocked(configManager.openspecDirExists).mockResolvedValue(false);
      vi.mocked(configManager.openspecConfigExists).mockResolvedValue(false);
      vi.mocked(configManager.getDefaultConfig).mockReturnValue({ projectType: 'python', createdAt: '2024-01-01' } as never);
    });

    it('should warn when project type is unknown', async () => {
      const { logger } = await import('../../utils/logger.js');
      const detector = await import('../../core/services/project-detector.js');
      vi.mocked(detector.detectProjectType).mockResolvedValue({
        projectType: 'unknown',
        hasGit: true,
        manifestFile: null,
        confidence: 'low',
      });

      await initCommand.parseAsync([], { from: 'user' });
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('detect project type'));
    });

    it('should warn when no .git directory found', async () => {
      const { logger } = await import('../../utils/logger.js');
      const detector = await import('../../core/services/project-detector.js');
      vi.mocked(detector.detectProjectType).mockResolvedValue({
        projectType: 'python',
        hasGit: false,
        manifestFile: 'pyproject.toml',
        confidence: 'high',
      });
      vi.mocked(detector.getProjectTypeName).mockReturnValue('Python');

      await initCommand.parseAsync([], { from: 'user' });
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('.git'));
    });
  });
});
