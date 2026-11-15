/**
 * Tests for gitignore-manager service
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  gitignoreExists,
  readGitignore,
  isInGitignore,
  addToGitignore,
  ensureGitignored,
  createGitignore,
} from './gitignore-manager.js';

describe('gitignore-manager', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('gitignoreExists', () => {
    it('should return false when .gitignore does not exist', async () => {
      const result = await gitignoreExists(testDir);
      expect(result).toBe(false);
    });

    it('should return true when .gitignore exists', async () => {
      await writeFile(join(testDir, '.gitignore'), '');

      const result = await gitignoreExists(testDir);
      expect(result).toBe(true);
    });
  });

  describe('readGitignore', () => {
    it('should return null when .gitignore does not exist', async () => {
      const result = await readGitignore(testDir);
      expect(result).toBe(null);
    });

    it('should return content when .gitignore exists', async () => {
      await writeFile(join(testDir, '.gitignore'), 'node_modules/\n.env\n');

      const result = await readGitignore(testDir);
      expect(result).toBe('node_modules/\n.env\n');
    });
  });

  describe('isInGitignore', () => {
    it('should return false when .gitignore does not exist', async () => {
      const result = await isInGitignore(testDir, 'node_modules/');
      expect(result).toBe(false);
    });

    it('should return true when entry exists', async () => {
      await writeFile(join(testDir, '.gitignore'), 'node_modules/\n.env\n');

      const result = await isInGitignore(testDir, 'node_modules/');
      expect(result).toBe(true);
    });

    it('should return false when entry does not exist', async () => {
      await writeFile(join(testDir, '.gitignore'), 'node_modules/\n.env\n');

      const result = await isInGitignore(testDir, '.openlore/');
      expect(result).toBe(false);
    });

    it('should match entries with different trailing slashes', async () => {
      await writeFile(join(testDir, '.gitignore'), 'node_modules\n');

      // Should match even with trailing slash
      const result = await isInGitignore(testDir, 'node_modules/');
      expect(result).toBe(true);
    });

    it('should ignore comments', async () => {
      await writeFile(join(testDir, '.gitignore'), '# node_modules/\n.env\n');

      const result = await isInGitignore(testDir, 'node_modules/');
      expect(result).toBe(false);
    });

    it('should ignore empty lines', async () => {
      await writeFile(join(testDir, '.gitignore'), '\n\nnode_modules/\n\n');

      const result = await isInGitignore(testDir, 'node_modules/');
      expect(result).toBe(true);
    });
  });

  describe('addToGitignore', () => {
    it('should add entry to existing .gitignore', async () => {
      await writeFile(join(testDir, '.gitignore'), 'node_modules/\n');

      const result = await addToGitignore(testDir, '.openlore/');
      expect(result).toBe(true);

      const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.openlore/');
      expect(content).toContain('node_modules/');
    });

    it('adds exactly one line: no comment and no blank line', async () => {
      await writeFile(join(testDir, '.gitignore'), 'node_modules/\n');

      await addToGitignore(testDir, '.openlore/');

      expect(await readFile(join(testDir, '.gitignore'), 'utf-8')).toBe('node_modules/\n.openlore/\n');
    });

    it('should return false if entry already exists', async () => {
      await writeFile(join(testDir, '.gitignore'), '.openlore/\n');

      const result = await addToGitignore(testDir, '.openlore/');
      expect(result).toBe(false);
    });

    it('should create .gitignore if it does not exist', async () => {
      const result = await addToGitignore(testDir, '.openlore/');
      expect(result).toBe(true);

      const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.openlore/');
    });

    it('should ensure newline before adding entry', async () => {
      await writeFile(join(testDir, '.gitignore'), 'node_modules/'); // No trailing newline

      await addToGitignore(testDir, '.openlore/');

      const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('node_modules/\n');
      expect(content).toContain('.openlore/\n');
    });
  });

  describe('ensureGitignored', () => {
    it("returns 'created' and writes .gitignore when none exists (the fresh `git init` case)", async () => {
      const result = await ensureGitignored(testDir, '.openlore/');
      expect(result).toBe('created');

      expect(await readFile(join(testDir, '.gitignore'), 'utf-8')).toBe('.openlore/\n');
    });

    it("returns 'appended' when adding to an existing .gitignore", async () => {
      await writeFile(join(testDir, '.gitignore'), 'node_modules/\n');

      const result = await ensureGitignored(testDir, '.openlore/');
      expect(result).toBe('appended');

      const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.openlore/');
    });

    it("returns 'present' and does not rewrite when the entry already exists", async () => {
      await writeFile(join(testDir, '.gitignore'), '.openlore/\n');

      const result = await ensureGitignored(testDir, '.openlore/');
      expect(result).toBe('present');
    });

    it("returns 'present' and writes nothing when git already ignores the entry another way", async () => {
      execFileSync('git', ['init', '-q'], { cwd: testDir });
      await writeFile(join(testDir, '.git', 'info', 'exclude'), '.openlore/\n');

      expect(await ensureGitignored(testDir, '.openlore/')).toBe('present');
      await expect(readFile(join(testDir, '.gitignore'), 'utf-8')).rejects.toThrow();
    });

    it('a git repository not ignoring the entry gets the one line', async () => {
      execFileSync('git', ['init', '-q'], { cwd: testDir });
      expect(await ensureGitignored(testDir, '.openlore/')).toBe('created');
      expect(await readFile(join(testDir, '.gitignore'), 'utf-8')).toBe('.openlore/\n');
      expect(await ensureGitignored(testDir, '.openlore/')).toBe('present');
    });

    it('is idempotent across repeated calls', async () => {
      expect(await ensureGitignored(testDir, '.openlore/')).toBe('created');
      expect(await ensureGitignored(testDir, '.openlore/')).toBe('present');
      expect(await ensureGitignored(testDir, '.openlore/')).toBe('present');

      const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
      // Exactly one occurrence — no duplicate lines.
      expect(content.match(/\.openlore\//g)?.length).toBe(1);
    });
  });

  describe('createGitignore', () => {
    it('should create .gitignore with entries', async () => {
      await createGitignore(testDir, [
        { entry: 'node_modules/', comment: 'Dependencies' },
        { entry: '.env' },
        { entry: 'dist/', comment: 'Build output' },
      ]);

      const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('# Dependencies');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.env');
      expect(content).toContain('# Build output');
      expect(content).toContain('dist/');
    });

    it('should create empty .gitignore with no entries', async () => {
      await createGitignore(testDir, []);

      const content = await readFile(join(testDir, '.gitignore'), 'utf-8');
      expect(content).toBe('');
    });
  });
});
