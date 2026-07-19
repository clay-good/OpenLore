/**
 * Tests for project-detector service
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectProjectType,
  detectGitRepository,
  getProjectTypeName,
} from './project-detector.js';

describe('project-detector', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testDir = join(tmpdir(), `openlore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('detectGitRepository', () => {
    it('should return false when no .git directory exists', async () => {
      const result = await detectGitRepository(testDir);
      expect(result).toBe(false);
    });

    it('should return true when .git directory exists', async () => {
      await mkdir(join(testDir, '.git'));
      const result = await detectGitRepository(testDir);
      expect(result).toBe(true);
    });
  });

  describe('detectProjectType', () => {
    it('should detect Node.js project from package.json', async () => {
      await writeFile(join(testDir, 'package.json'), '{}');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('nodejs');
      expect(result.manifestFile).toBe('package.json');
      expect(result.confidence).toBe('high');
    });

    it('should detect Python project from pyproject.toml', async () => {
      await writeFile(join(testDir, 'pyproject.toml'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('python');
      expect(result.manifestFile).toBe('pyproject.toml');
      expect(result.confidence).toBe('high');
    });

    it('should detect Python project from setup.py', async () => {
      await writeFile(join(testDir, 'setup.py'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('python');
      expect(result.manifestFile).toBe('setup.py');
    });

    it('should detect Python project from requirements.txt', async () => {
      await writeFile(join(testDir, 'requirements.txt'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('python');
      expect(result.manifestFile).toBe('requirements.txt');
    });

    it('should detect Rust project from Cargo.toml', async () => {
      await writeFile(join(testDir, 'Cargo.toml'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('rust');
      expect(result.manifestFile).toBe('Cargo.toml');
    });

    it('should detect Go project from go.mod', async () => {
      await writeFile(join(testDir, 'go.mod'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('go');
      expect(result.manifestFile).toBe('go.mod');
    });

    it('should detect Java project from pom.xml', async () => {
      await writeFile(join(testDir, 'pom.xml'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('java');
      expect(result.manifestFile).toBe('pom.xml');
    });

    it('should detect Java project from build.gradle', async () => {
      await writeFile(join(testDir, 'build.gradle'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('java');
      expect(result.manifestFile).toBe('build.gradle');
    });

    it('should detect Java project from build.gradle.kts', async () => {
      await writeFile(join(testDir, 'build.gradle.kts'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('java');
      expect(result.manifestFile).toBe('build.gradle.kts');
    });

    it('should detect Ruby project from Gemfile', async () => {
      await writeFile(join(testDir, 'Gemfile'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('ruby');
      expect(result.manifestFile).toBe('Gemfile');
    });

    it('should detect PHP project from composer.json', async () => {
      await writeFile(join(testDir, 'composer.json'), '{}');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('php');
      expect(result.manifestFile).toBe('composer.json');
    });

    it('should return unknown when no manifest files exist', async () => {
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('unknown');
      expect(result.manifestFile).toBe(null);
      expect(result.confidence).toBe('low');
    });

    it('detects a pure-TS project (tsconfig.json, no package.json) as Node.js, not Unknown (fix-cli-output-hygiene)', async () => {
      await writeFile(join(testDir, 'tsconfig.json'), '{}');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('nodejs');
      expect(result.manifestFile).toBe('tsconfig.json');
    });

    it('prefers package.json over a co-located tsconfig.json', async () => {
      await writeFile(join(testDir, 'package.json'), '{}');
      await writeFile(join(testDir, 'tsconfig.json'), '{}');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('nodejs');
      expect(result.manifestFile).toBe('package.json');
    });

    it('should prefer higher priority manifest files', async () => {
      // pyproject.toml has higher priority than setup.py
      await writeFile(join(testDir, 'pyproject.toml'), '');
      await writeFile(join(testDir, 'setup.py'), '');
      const result = await detectProjectType(testDir);

      expect(result.projectType).toBe('python');
      expect(result.manifestFile).toBe('pyproject.toml');
    });

    it('should have medium confidence when multiple project types detected', async () => {
      // This is an unusual case - both Node.js and Python
      await writeFile(join(testDir, 'package.json'), '{}');
      await writeFile(join(testDir, 'pyproject.toml'), '');
      const result = await detectProjectType(testDir);

      expect(result.confidence).toBe('medium');
    });

    it('should detect git status correctly', async () => {
      await mkdir(join(testDir, '.git'));
      await writeFile(join(testDir, 'package.json'), '{}');
      const result = await detectProjectType(testDir);

      expect(result.hasGit).toBe(true);
    });

    it('should report no git when .git is missing', async () => {
      await writeFile(join(testDir, 'package.json'), '{}');
      const result = await detectProjectType(testDir);

      expect(result.hasGit).toBe(false);
    });
  });

  describe('nested manifest detection (Spec 26 B6A)', () => {
    it('detects a manifest one directory deep when the root has none', async () => {
      await mkdir(join(testDir, 'python'), { recursive: true });
      await writeFile(join(testDir, 'python', 'pyproject.toml'), '[project]\n');
      const result = await detectProjectType(testDir);
      expect(result.projectType).toBe('python');
      expect(result.manifestFile).toBe(join('python', 'pyproject.toml'));
      expect(result.confidence).toBe('medium');
    });

    it('still reports unknown when no manifest exists at root or depth-1', async () => {
      await mkdir(join(testDir, 'docs'), { recursive: true });
      await writeFile(join(testDir, 'docs', 'README.md'), '# hi\n');
      const result = await detectProjectType(testDir);
      expect(result.projectType).toBe('unknown');
    });

    it('prefers the root manifest over a nested one', async () => {
      await writeFile(join(testDir, 'package.json'), '{}');
      await mkdir(join(testDir, 'backend'), { recursive: true });
      await writeFile(join(testDir, 'backend', 'go.mod'), 'module x\n');
      const result = await detectProjectType(testDir);
      expect(result.projectType).toBe('nodejs');
      expect(result.manifestFile).toBe('package.json');
    });

    it('ignores node_modules when scanning depth-1', async () => {
      await mkdir(join(testDir, 'node_modules'), { recursive: true });
      await writeFile(join(testDir, 'node_modules', 'package.json'), '{}');
      const result = await detectProjectType(testDir);
      expect(result.projectType).toBe('unknown');
    });
  });

  describe('getProjectTypeName', () => {
    it('should return correct names for all project types', () => {
      expect(getProjectTypeName('nodejs')).toBe('Node.js/TypeScript');
      expect(getProjectTypeName('python')).toBe('Python');
      expect(getProjectTypeName('rust')).toBe('Rust');
      expect(getProjectTypeName('go')).toBe('Go');
      expect(getProjectTypeName('java')).toBe('Java');
      expect(getProjectTypeName('ruby')).toBe('Ruby');
      expect(getProjectTypeName('php')).toBe('PHP');
      expect(getProjectTypeName('unknown')).toBe('Unknown');
    });
  });
});
