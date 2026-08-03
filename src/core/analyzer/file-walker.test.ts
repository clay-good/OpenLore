/**
 * Tests for FileWalker service
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkDirectory } from './file-walker.js';

describe('FileWalker', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('basic file discovery', () => {
    it('should find files in root directory', async () => {
      await writeFile(join(testDir, 'index.ts'), 'export const x = 1;');
      await writeFile(join(testDir, 'utils.ts'), 'export const y = 2;');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(2);
      expect(result.summary.totalFiles).toBe(2);
    });

    it('should find files in subdirectories', async () => {
      await mkdir(join(testDir, 'src'));
      await writeFile(join(testDir, 'src', 'main.ts'), 'console.log("hi");');
      await writeFile(join(testDir, 'README.md'), '# Test');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(2);
      expect(result.files.map((f) => f.path)).toContain('src/main.ts');
      expect(result.files.map((f) => f.path)).toContain('README.md');
    });

    it('should collect correct file metadata', async () => {
      await writeFile(join(testDir, 'app.ts'), 'const x = 1;\nconst y = 2;\nconst z = 3;');

      const result = await walkDirectory(testDir);

      const file = result.files.find((f) => f.name === 'app.ts');
      expect(file).toBeDefined();
      expect(file!.path).toBe('app.ts');
      expect(file!.extension).toBe('.ts');
      expect(file!.lines).toBe(3);
      expect(file!.depth).toBe(0);
      expect(file!.directory).toBe('');
    });

    it('should track directory depth correctly', async () => {
      await mkdir(join(testDir, 'a', 'b', 'c'), { recursive: true });
      await writeFile(join(testDir, 'root.ts'), '');
      await writeFile(join(testDir, 'a', 'level1.ts'), '');
      await writeFile(join(testDir, 'a', 'b', 'level2.ts'), '');
      await writeFile(join(testDir, 'a', 'b', 'c', 'level3.ts'), '');

      const result = await walkDirectory(testDir);

      const depths = result.files.reduce(
        (acc, f) => {
          acc[f.name] = f.depth;
          return acc;
        },
        {} as Record<string, number>
      );

      expect(depths['root.ts']).toBe(0);
      expect(depths['level1.ts']).toBe(1);
      expect(depths['level2.ts']).toBe(2);
      expect(depths['level3.ts']).toBe(3);
    });
  });

  describe('directory filtering', () => {
    it('should skip node_modules directory', async () => {
      await mkdir(join(testDir, 'node_modules', 'lodash'), { recursive: true });
      await writeFile(join(testDir, 'node_modules', 'lodash', 'index.js'), '');
      await writeFile(join(testDir, 'app.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('app.ts');
      expect(result.summary.skippedReasons['directory:node_modules']).toBeGreaterThan(0);
    });

    it('should skip .git directory', async () => {
      await mkdir(join(testDir, '.git', 'objects'), { recursive: true });
      await writeFile(join(testDir, '.git', 'config'), '');
      await writeFile(join(testDir, 'app.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('app.ts');
    });

    it('should skip dist and build directories', async () => {
      await mkdir(join(testDir, 'dist'));
      await mkdir(join(testDir, 'build'));
      await writeFile(join(testDir, 'dist', 'bundle.js'), '');
      await writeFile(join(testDir, 'build', 'output.js'), '');
      await writeFile(join(testDir, 'src.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('src.ts');
    });

    it('should skip .openlore and openspec directories', async () => {
      await mkdir(join(testDir, '.openlore'));
      await mkdir(join(testDir, 'openspec', 'specs'), { recursive: true });
      await writeFile(join(testDir, '.openlore', 'config.json'), '{}');
      await writeFile(join(testDir, 'openspec', 'specs', 'auth.md'), '');
      await writeFile(join(testDir, 'app.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('app.ts');
    });

    it('should skip __pycache__ and .pytest_cache', async () => {
      await mkdir(join(testDir, '__pycache__'));
      await mkdir(join(testDir, '.pytest_cache'));
      await writeFile(join(testDir, '__pycache__', 'module.pyc'), '');
      await writeFile(join(testDir, 'app.py'), '');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('app.py');
    });
  });

  describe('file filtering', () => {
    it('should skip lock files', async () => {
      await writeFile(join(testDir, 'package-lock.json'), '{}');
      await writeFile(join(testDir, 'pnpm-lock.yaml'), '');
      await writeFile(join(testDir, 'yarn.lock'), '');
      await writeFile(join(testDir, 'package.json'), '{}');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('package.json');
    });

    it('should skip binary and image files', async () => {
      await writeFile(join(testDir, 'logo.png'), '');
      await writeFile(join(testDir, 'icon.svg'), '');
      await writeFile(join(testDir, 'font.woff2'), '');
      await writeFile(join(testDir, 'app.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('app.ts');
    });

    it('should skip compiled files', async () => {
      await writeFile(join(testDir, 'module.pyc'), '');
      await writeFile(join(testDir, 'lib.so'), '');
      await writeFile(join(testDir, 'app.exe'), '');
      await writeFile(join(testDir, 'main.py'), '');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('main.py');
    });

    it('should skip minified files', async () => {
      await writeFile(join(testDir, 'bundle.min.js'), '');
      await writeFile(join(testDir, 'styles.min.css'), '');
      await writeFile(join(testDir, 'app.js'), '');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('app.js');
    });

    it('should skip source maps', async () => {
      await writeFile(join(testDir, 'bundle.js.map'), '');
      await writeFile(join(testDir, 'bundle.js'), '');

      const result = await walkDirectory(testDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('bundle.js');
    });
  });

  describe('entry point detection', () => {
    it('should detect index files as entry points', async () => {
      await writeFile(join(testDir, 'index.ts'), '');
      await writeFile(join(testDir, 'utils.ts'), '');

      const result = await walkDirectory(testDir);

      const indexFile = result.files.find((f) => f.name === 'index.ts');
      const utilsFile = result.files.find((f) => f.name === 'utils.ts');

      expect(indexFile!.isEntryPoint).toBe(true);
      expect(utilsFile!.isEntryPoint).toBe(false);
    });

    it('should detect main, app, server as entry points', async () => {
      await writeFile(join(testDir, 'main.ts'), '');
      await writeFile(join(testDir, 'app.js'), '');
      await writeFile(join(testDir, 'server.py'), '');
      await writeFile(join(testDir, 'helper.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files.find((f) => f.name === 'main.ts')!.isEntryPoint).toBe(true);
      expect(result.files.find((f) => f.name === 'app.js')!.isEntryPoint).toBe(true);
      expect(result.files.find((f) => f.name === 'server.py')!.isEntryPoint).toBe(true);
      expect(result.files.find((f) => f.name === 'helper.ts')!.isEntryPoint).toBe(false);
    });

    it('should detect shebang files as entry points', async () => {
      await writeFile(join(testDir, 'script.sh'), '#!/bin/bash\necho "hello"');
      await writeFile(join(testDir, 'normal.sh'), 'echo "hello"');

      const result = await walkDirectory(testDir);

      expect(result.files.find((f) => f.name === 'script.sh')!.isEntryPoint).toBe(true);
      expect(result.files.find((f) => f.name === 'normal.sh')!.isEntryPoint).toBe(false);
    });
  });

  describe('test file detection', () => {
    it('should detect test files by name pattern', async () => {
      await writeFile(join(testDir, 'app.test.ts'), '');
      await writeFile(join(testDir, 'app.spec.ts'), '');
      await writeFile(join(testDir, 'app_test.py'), '');
      await writeFile(join(testDir, 'test_app.py'), '');
      await writeFile(join(testDir, 'app.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files.find((f) => f.name === 'app.test.ts')!.isTest).toBe(true);
      expect(result.files.find((f) => f.name === 'app.spec.ts')!.isTest).toBe(true);
      expect(result.files.find((f) => f.name === 'app_test.py')!.isTest).toBe(true);
      expect(result.files.find((f) => f.name === 'test_app.py')!.isTest).toBe(true);
      expect(result.files.find((f) => f.name === 'app.ts')!.isTest).toBe(false);
    });

    it('should detect test files by directory', async () => {
      await mkdir(join(testDir, 'test'));
      await mkdir(join(testDir, '__tests__'));
      await writeFile(join(testDir, 'test', 'helper.ts'), '');
      await writeFile(join(testDir, '__tests__', 'app.ts'), '');
      await writeFile(join(testDir, 'src.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files.find((f) => f.path === 'test/helper.ts')!.isTest).toBe(true);
      expect(result.files.find((f) => f.path === '__tests__/app.ts')!.isTest).toBe(true);
      expect(result.files.find((f) => f.name === 'src.ts')!.isTest).toBe(false);
    });
  });

  describe('config file detection', () => {
    it('should detect configuration files', async () => {
      await writeFile(join(testDir, 'package.json'), '{}');
      await writeFile(join(testDir, 'tsconfig.json'), '{}');
      await writeFile(join(testDir, '.eslintrc.js'), '');
      await writeFile(join(testDir, 'vite.config.ts'), '');
      await writeFile(join(testDir, 'app.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files.find((f) => f.name === 'package.json')!.isConfig).toBe(true);
      expect(result.files.find((f) => f.name === 'tsconfig.json')!.isConfig).toBe(true);
      expect(result.files.find((f) => f.name === '.eslintrc.js')!.isConfig).toBe(true);
      expect(result.files.find((f) => f.name === 'vite.config.ts')!.isConfig).toBe(true);
      expect(result.files.find((f) => f.name === 'app.ts')!.isConfig).toBe(false);
    });
  });

  describe('generated file detection', () => {
    it('should detect generated files', async () => {
      await writeFile(join(testDir, 'types.d.ts'), '');
      await writeFile(join(testDir, 'api.generated.ts'), '');
      await writeFile(join(testDir, 'app.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files.find((f) => f.name === 'types.d.ts')!.isGenerated).toBe(true);
      expect(result.files.find((f) => f.name === 'api.generated.ts')!.isGenerated).toBe(true);
      expect(result.files.find((f) => f.name === 'app.ts')!.isGenerated).toBe(false);
    });
  });

  describe('gitignore support', () => {
    it('should respect .gitignore patterns', async () => {
      await writeFile(join(testDir, '.gitignore'), 'ignored/\n*.log');
      await mkdir(join(testDir, 'ignored'));
      await writeFile(join(testDir, 'ignored', 'secret.ts'), '');
      await writeFile(join(testDir, 'debug.log'), '');
      await writeFile(join(testDir, 'app.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.files.map((f) => f.name)).not.toContain('secret.ts');
      expect(result.files.map((f) => f.name)).not.toContain('debug.log');
      expect(result.files.map((f) => f.name)).toContain('app.ts');
    });
  });

  describe('options', () => {
    it('should respect maxFiles limit', async () => {
      for (let i = 0; i < 20; i++) {
        await writeFile(join(testDir, `file${i}.ts`), '');
      }

      const result = await walkDirectory(testDir, { maxFiles: 5 });

      expect(result.files).toHaveLength(5);
    });

    it('should respect exclude patterns', async () => {
      await mkdir(join(testDir, 'legacy'));
      await writeFile(join(testDir, 'legacy', 'old.ts'), '');
      await writeFile(join(testDir, 'new.ts'), '');

      const result = await walkDirectory(testDir, {
        excludePatterns: ['legacy'],
      });

      expect(result.files.map((f) => f.name)).not.toContain('old.ts');
      expect(result.files.map((f) => f.name)).toContain('new.ts');
    });

    it('should call progress callback', async () => {
      await writeFile(join(testDir, 'app.ts'), '');

      const progressCalls: number[] = [];
      await walkDirectory(testDir, {
        onProgress: (progress) => {
          progressCalls.push(progress.directoriesScanned);
        },
      });

      expect(progressCalls.length).toBeGreaterThan(0);
    });

    it('should support cancellation via AbortController', async () => {
      // Create nested directories to ensure multiple walkDirectory calls
      await mkdir(join(testDir, 'a'));
      await mkdir(join(testDir, 'b'));
      await mkdir(join(testDir, 'c'));
      for (let i = 0; i < 10; i++) {
        await writeFile(join(testDir, 'a', `file${i}.ts`), '');
        await writeFile(join(testDir, 'b', `file${i}.ts`), '');
        await writeFile(join(testDir, 'c', `file${i}.ts`), '');
      }

      const controller = new AbortController();

      const result = await walkDirectory(testDir, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.filesFound >= 5) {
            controller.abort();
          }
        },
      });

      // Should have stopped before processing all 30 files
      expect(result.files.length).toBeLessThan(30);
    });
  });

  describe('summary statistics', () => {
    it('should count files by extension', async () => {
      await writeFile(join(testDir, 'app.ts'), '');
      await writeFile(join(testDir, 'utils.ts'), '');
      await writeFile(join(testDir, 'style.css'), '');
      await writeFile(join(testDir, 'readme.md'), '');

      const result = await walkDirectory(testDir);

      expect(result.summary.byExtension['.ts']).toBe(2);
      expect(result.summary.byExtension['.css']).toBe(1);
      expect(result.summary.byExtension['.md']).toBe(1);
    });

    it('should count files by directory', async () => {
      await mkdir(join(testDir, 'src'));
      await mkdir(join(testDir, 'lib'));
      await writeFile(join(testDir, 'src', 'a.ts'), '');
      await writeFile(join(testDir, 'src', 'b.ts'), '');
      await writeFile(join(testDir, 'lib', 'c.ts'), '');
      await writeFile(join(testDir, 'root.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.summary.byDirectory['src']).toBe(2);
      expect(result.summary.byDirectory['lib']).toBe(1);
      expect(result.summary.byDirectory['(root)']).toBe(1);
    });

    it('counts a directory named __proto__ as an ordinary key without polluting Object.prototype', async () => {
      // The directory/extension counters are keyed by repository-derived names. A directory
      // literally named `__proto__` (or `constructor`) must be counted as a plain key and must
      // never reach `Object.prototype` — the counters are Maps materialized to plain objects.
      await mkdir(join(testDir, '__proto__'));
      await writeFile(join(testDir, '__proto__', 'a.ts'), '');
      await writeFile(join(testDir, '__proto__', 'b.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.summary.byDirectory['__proto__']).toBe(2);
      // No global prototype pollution occurred.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('a.ts');
    });

    it('should track skipped files', async () => {
      await mkdir(join(testDir, 'node_modules'));
      await writeFile(join(testDir, 'node_modules', 'pkg.js'), '');
      await writeFile(join(testDir, 'app.min.js'), '');
      await writeFile(join(testDir, 'app.ts'), '');

      const result = await walkDirectory(testDir);

      expect(result.summary.skippedCount).toBeGreaterThan(0);
    });
  });

  describe('large file size guard', () => {
    it('returns lines=-1 for files larger than 10 MB', async () => {
      // Create a file just above the 10 MB threshold by writing 10 MB + 1 byte
      const largePath = join(testDir, 'large.ts');
      const chunk = Buffer.alloc(1024 * 1024, 'x'); // 1 MB
      const handle = await import('node:fs/promises').then(m => m.open(largePath, 'w'));
      for (let i = 0; i < 11; i++) await handle.write(chunk);
      await handle.close();

      const result = await walkDirectory(testDir);
      const largeMeta = result.files.find(f => f.path === 'large.ts');
      expect(largeMeta).toBeDefined();
      expect(largeMeta!.lines).toBe(-1);
    });

    it('returns a positive line count for normal-sized files', async () => {
      await writeFile(join(testDir, 'small.ts'), 'const a = 1;\nconst b = 2;\n');
      const result = await walkDirectory(testDir);
      const meta = result.files.find(f => f.path === 'small.ts');
      expect(meta).toBeDefined();
      expect(meta!.lines).toBeGreaterThan(0);
    });
  });
});
