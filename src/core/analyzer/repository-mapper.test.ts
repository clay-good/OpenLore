/**
 * Tests for Repository Mapper
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryMapper, mapRepository } from './repository-mapper.js';
import { renderBlock } from '../../cli/install/block.js';
import { mergeEntries } from '../../cli/install/json-managed.js';

describe('RepositoryMapper', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('basic mapping', () => {
    it('keeps installer-owned artifacts out of repository characterization', async () => {
      await mkdir(join(testDir, 'src'));
      await mkdir(join(testDir, 'scripts'));
      await writeFile(join(testDir, 'src', 'index.ts'), 'export function main() {}');
      await writeFile(join(testDir, 'src', 'payments.ts'), 'export function charge() {}');
      await writeFile(join(testDir, 'scripts', 'report.py'), 'def report():\n    return 1\n');
      await writeFile(join(testDir, 'AGENTS.md'), renderBlock('OpenLore instructions'));
      await writeFile(join(testDir, '.clinerules'), renderBlock('OpenLore instructions'));
      await writeFile(join(testDir, '.mcp.json'), JSON.stringify(mergeEntries({}, [{
        path: 'mcpServers.openlore', value: { command: 'openlore' },
      }]).next));

      const map = await new RepositoryMapper(testDir).map();

      expect(map.summary.languages.map(language => language.language)).toContain('Python');
      expect(map.highValueFiles.map(file => file.path)).not.toContain('AGENTS.md');
      expect(map.highValueFiles.map(file => file.path)).not.toContain('.mcp.json');
      expect(map.allFiles.find(file => file.path === 'AGENTS.md')?.tooling).toBe(true);
      expect(map.allFiles.find(file => file.path === '.mcp.json')?.tooling).toBe(true);
      expect(map.allFiles.find(file => file.path === '.clinerules')?.tooling).toBe(true);
      expect(Object.values(map.clusters.byDomain).flat().map(file => file.path)).not.toContain('AGENTS.md');
    });

    it('characterizes a user AGENTS.md that also contains an OpenLore block', async () => {
      await writeFile(join(testDir, 'AGENTS.md'), `# User instructions\n\n${renderBlock('OpenLore instructions')}`);
      await writeFile(join(testDir, 'index.ts'), 'export function main() {}');

      const map = await new RepositoryMapper(testDir).map();

      expect(map.allFiles.find(file => file.path === 'AGENTS.md')?.tooling).not.toBe(true);
      expect(map.summary.languages.map(language => language.language)).toContain('Markdown');
    });

    it('should map a simple project structure', async () => {
      // Create a simple Node.js project
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({ name: 'test-project', dependencies: {} })
      );
      await mkdir(join(testDir, 'src'));
      await writeFile(join(testDir, 'src', 'index.ts'), 'export const main = () => {};');
      await writeFile(join(testDir, 'src', 'utils.ts'), 'export const helper = () => {};');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.metadata.projectName).toBe('test-project');
      expect(map.metadata.projectType).toBe('nodejs');
      expect(map.summary.analyzedFiles).toBeGreaterThan(0);
      expect(map.allFiles.length).toBeGreaterThan(0);
    });

    it('should extract project name from package.json', async () => {
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({ name: 'my-awesome-project' })
      );
      await writeFile(join(testDir, 'index.ts'), 'export default {}');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.metadata.projectName).toBe('my-awesome-project');
    });

    it('should use directory name if no package.json', async () => {
      await writeFile(join(testDir, 'main.py'), 'print("hello")');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      // Should use the test directory name
      expect(map.metadata.projectName).toBeTruthy();
    });
  });

  describe('project type detection', () => {
    it('should detect Node.js projects', async () => {
      await writeFile(join(testDir, 'package.json'), '{}');
      await writeFile(join(testDir, 'index.js'), '');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.metadata.projectType).toBe('nodejs');
    });

    it('should detect Python projects', async () => {
      await writeFile(join(testDir, 'pyproject.toml'), '[project]\nname = "test"');
      await writeFile(join(testDir, 'main.py'), '');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.metadata.projectType).toBe('python');
    });

    it('should detect Rust projects', async () => {
      await writeFile(join(testDir, 'Cargo.toml'), '[package]\nname = "test"');
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(join(testDir, 'src', 'main.rs'), '');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.metadata.projectType).toBe('rust');
    });

    it('should detect Go projects', async () => {
      await writeFile(join(testDir, 'go.mod'), 'module test');
      await writeFile(join(testDir, 'main.go'), 'package main');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.metadata.projectType).toBe('go');
    });
  });

  describe('framework detection', () => {
    it('should detect React', async () => {
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({ dependencies: { react: '^18.0.0' } })
      );
      await writeFile(join(testDir, 'App.tsx'), 'export const App = () => <div />;');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      const react = map.summary.frameworks.find(f => f.name === 'React');
      expect(react).toBeDefined();
      expect(react!.category).toBe('frontend');
    });

    it('should detect Next.js', async () => {
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({ dependencies: { next: '^14.0.0' } })
      );
      await writeFile(join(testDir, 'next.config.js'), 'module.exports = {}');
      await mkdir(join(testDir, 'pages'));
      await writeFile(join(testDir, 'pages', 'index.tsx'), 'export default function Home() {}');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      const nextjs = map.summary.frameworks.find(f => f.name === 'Next.js');
      expect(nextjs).toBeDefined();
      expect(nextjs!.confidence).toBe('high');
    });

    it('should detect Express', async () => {
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({ dependencies: { express: '^4.18.0' } })
      );
      await writeFile(join(testDir, 'server.ts'), 'import express from "express";');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      const express = map.summary.frameworks.find(f => f.name === 'Express');
      expect(express).toBeDefined();
      expect(express!.category).toBe('backend');
    });

    it('should detect testing frameworks', async () => {
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({ devDependencies: { vitest: '^1.0.0' } })
      );
      await writeFile(join(testDir, 'vitest.config.ts'), 'export default {}');
      await writeFile(join(testDir, 'app.ts'), 'export const x = 1;');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      const vitest = map.summary.frameworks.find(f => f.name === 'Vitest');
      expect(vitest).toBeDefined();
      expect(vitest!.category).toBe('testing');
    });

    it('should detect GitHub Actions CI', async () => {
      await mkdir(join(testDir, '.github', 'workflows'), { recursive: true });
      await writeFile(join(testDir, '.github', 'workflows', 'ci.yml'), 'name: CI');
      await writeFile(join(testDir, 'app.ts'), 'export const x = 1;');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      const ghActions = map.summary.frameworks.find(f => f.name === 'GitHub Actions');
      expect(ghActions).toBeDefined();
      expect(ghActions!.category).toBe('ci');
    });
  });

  describe('language breakdown', () => {
    it('should calculate language breakdown', async () => {
      await writeFile(join(testDir, 'app.ts'), 'export const x = 1;');
      await writeFile(join(testDir, 'util.ts'), 'export const y = 2;');
      await writeFile(join(testDir, 'style.css'), 'body {}');
      await writeFile(join(testDir, 'data.json'), '{}');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      const ts = map.summary.languages.find(l => l.extension === '.ts');
      const css = map.summary.languages.find(l => l.extension === '.css');
      const json = map.summary.languages.find(l => l.extension === '.json');

      expect(ts).toBeDefined();
      expect(ts!.fileCount).toBe(2);
      expect(css).toBeDefined();
      expect(css!.fileCount).toBe(1);
      expect(json).toBeDefined();
    });
  });

  describe('file categorization', () => {
    it('should identify entry points', async () => {
      await writeFile(join(testDir, 'index.ts'), 'export default {}');
      await writeFile(join(testDir, 'main.ts'), 'console.log("main")');
      await writeFile(join(testDir, 'utils.ts'), 'export const x = 1;');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.entryPoints.length).toBeGreaterThanOrEqual(2);
      expect(map.entryPoints.some(f => f.name === 'index.ts')).toBe(true);
      expect(map.entryPoints.some(f => f.name === 'main.ts')).toBe(true);
    });

    it('should identify schema files', async () => {
      await writeFile(join(testDir, 'user.schema.ts'), 'export interface User {}');
      await writeFile(join(testDir, 'user.model.ts'), 'export class UserModel {}');
      await writeFile(join(testDir, 'utils.ts'), 'export const x = 1;');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.schemaFiles.length).toBeGreaterThanOrEqual(2);
    });

    it('should identify config files', async () => {
      await writeFile(join(testDir, 'package.json'), '{}');
      await writeFile(join(testDir, 'tsconfig.json'), '{}');
      await writeFile(join(testDir, '.eslintrc.js'), 'module.exports = {}');
      await writeFile(join(testDir, 'app.ts'), 'export const x = 1;');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.configFiles.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('file clustering', () => {
    it('should cluster files by directory', async () => {
      await mkdir(join(testDir, 'src'));
      await mkdir(join(testDir, 'lib'));
      await writeFile(join(testDir, 'src', 'a.ts'), '');
      await writeFile(join(testDir, 'src', 'b.ts'), '');
      await writeFile(join(testDir, 'lib', 'c.ts'), '');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.clusters.byDirectory['src']).toBeDefined();
      expect(map.clusters.byDirectory['src'].length).toBe(2);
      expect(map.clusters.byDirectory['lib']).toBeDefined();
      expect(map.clusters.byDirectory['lib'].length).toBe(1);
    });

    it('should cluster files by layer', async () => {
      await mkdir(join(testDir, 'components'));
      await mkdir(join(testDir, 'services'));
      await mkdir(join(testDir, 'models'));
      await mkdir(join(testDir, 'utils'));

      await writeFile(join(testDir, 'components', 'Button.tsx'), 'export const Button = () => {};');
      await writeFile(join(testDir, 'services', 'api.service.ts'), 'export class ApiService {}');
      await writeFile(join(testDir, 'models', 'user.model.ts'), 'export interface User {}');
      await writeFile(join(testDir, 'utils', 'format.util.ts'), 'export function format() {}');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.clusters.byLayer.presentation.length).toBeGreaterThanOrEqual(1);
      expect(map.clusters.byLayer.business.length).toBeGreaterThanOrEqual(1);
      expect(map.clusters.byLayer.data.length).toBeGreaterThanOrEqual(1);
      expect(map.clusters.byLayer.infrastructure.length).toBeGreaterThanOrEqual(1);
    });

    it('should infer domains from directory structure', async () => {
      await mkdir(join(testDir, 'users'));
      await mkdir(join(testDir, 'orders'));

      await writeFile(join(testDir, 'users', 'user.service.ts'), '');
      await writeFile(join(testDir, 'users', 'user.model.ts'), '');
      await writeFile(join(testDir, 'orders', 'order.service.ts'), '');
      await writeFile(join(testDir, 'orders', 'order.model.ts'), '');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.clusters.byDomain['users']).toBeDefined();
      expect(map.clusters.byDomain['orders']).toBeDefined();
    });

    it('infers leaf Java packages as domains, not the reverse-DNS org root (#138)', async () => {
      const pkg = join(testDir, 'src', 'main', 'java', 'com', 'example');
      await mkdir(join(pkg, 'inventory'), { recursive: true });
      await mkdir(join(pkg, 'billing'), { recursive: true });

      await writeFile(join(pkg, 'inventory', 'Item.java'), 'class Item {}');
      await writeFile(join(pkg, 'inventory', 'Warehouse.java'), 'class Warehouse {}');
      await writeFile(join(pkg, 'billing', 'Invoice.java'), 'class Invoice {}');
      await writeFile(join(pkg, 'billing', 'Ledger.java'), 'class Ledger {}');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      expect(map.clusters.byDomain['inventory']).toBeDefined();
      expect(map.clusters.byDomain['billing']).toBeDefined();
      // The bug: every file collapsed into the org root instead of leaf packages.
      expect(map.clusters.byDomain['example']).toBeUndefined();
      expect(map.clusters.byDomain['com']).toBeUndefined();
    });
  });

  describe('output generation', () => {
    it('should write repository-map.json', async () => {
      await writeFile(join(testDir, 'app.ts'), 'export const x = 1;');

      const outputDir = join(testDir, '.openlore', 'analysis');
      const mapper = new RepositoryMapper(testDir, { outputDir });
      const map = await mapper.map();
      await mapper.writeOutput(map);

      const { readFile } = await import('node:fs/promises');
      const mapContent = await readFile(join(outputDir, 'repository-map.json'), 'utf-8');
      const parsed = JSON.parse(mapContent);

      expect(parsed.metadata).toBeDefined();
      expect(parsed.summary).toBeDefined();
      expect(parsed.allFiles).toBeDefined();
    });

    it('should write SUMMARY.md', async () => {
      await writeFile(join(testDir, 'app.ts'), 'export const x = 1;');

      const outputDir = join(testDir, '.openlore', 'analysis');
      const mapper = new RepositoryMapper(testDir, { outputDir });
      const map = await mapper.map();
      await mapper.writeOutput(map);

      const { readFile } = await import('node:fs/promises');
      const summary = await readFile(join(outputDir, 'SUMMARY.md'), 'utf-8');

      expect(summary).toContain('# Repository Analysis');
      expect(summary).toContain('## Overview');
      expect(summary).toContain('## Languages');
    });
  });

  describe('mapRepository convenience function', () => {
    it('should map and write output', async () => {
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({ name: 'convenience-test' })
      );
      await writeFile(join(testDir, 'app.ts'), 'export const x = 1;');

      const map = await mapRepository(testDir, {
        outputDir: join(testDir, '.openlore', 'analysis'),
      });

      expect(map.metadata.projectName).toBe('convenience-test');
      expect(map.allFiles.length).toBeGreaterThan(0);
    });
  });

  describe('progress callback', () => {
    it('should call progress callback during mapping', async () => {
      await writeFile(join(testDir, 'app.ts'), 'export const x = 1;');

      const stages: string[] = [];
      const mapper = new RepositoryMapper(testDir, {
        onProgress: (stage) => {
          if (!stages.includes(stage)) {
            stages.push(stage);
          }
        },
      });

      await mapper.map();

      expect(stages).toContain('loading');
      expect(stages).toContain('walking');
      expect(stages).toContain('scoring');
      expect(stages).toContain('analyzing');
      expect(stages).toContain('complete');
    });
  });

  describe('realistic project structure', () => {
    it('should correctly analyze an Express API structure', async () => {
      // Create Express-like project
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'express-api',
          dependencies: {
            express: '^4.18.0',
            jsonwebtoken: '^9.0.0',
          },
          devDependencies: {
            vitest: '^1.0.0',
          },
        })
      );

      await mkdir(join(testDir, 'src', 'routes'), { recursive: true });
      await mkdir(join(testDir, 'src', 'controllers'));
      await mkdir(join(testDir, 'src', 'models'));
      await mkdir(join(testDir, 'src', 'middleware'));
      await mkdir(join(testDir, 'src', 'services'));
      await mkdir(join(testDir, 'tests'));

      await writeFile(join(testDir, 'src', 'index.ts'), 'import express from "express";\nexport const app = express();');
      await writeFile(join(testDir, 'src', 'routes', 'users.ts'), 'import { Router } from "express";\nexport const router = Router();');
      await writeFile(join(testDir, 'src', 'controllers', 'userController.ts'), 'export class UserController {}');
      await writeFile(join(testDir, 'src', 'models', 'User.ts'), 'export interface User { id: string; }');
      await writeFile(join(testDir, 'src', 'middleware', 'auth.ts'), 'export function authMiddleware() {}');
      await writeFile(join(testDir, 'src', 'services', 'userService.ts'), 'export class UserService {}');
      await writeFile(join(testDir, 'tests', 'users.test.ts'), 'test("users", () => {});');

      const mapper = new RepositoryMapper(testDir);
      const map = await mapper.map();

      // Check project detection
      expect(map.metadata.projectType).toBe('nodejs');
      expect(map.metadata.projectName).toBe('express-api');

      // Check framework detection
      expect(map.summary.frameworks.some(f => f.name === 'Express')).toBe(true);
      expect(map.summary.frameworks.some(f => f.name === 'JWT Auth')).toBe(true);
      expect(map.summary.frameworks.some(f => f.name === 'Vitest')).toBe(true);

      // Check high-value files
      const highValueNames = map.highValueFiles.map(f => f.name);
      expect(highValueNames).toContain('userController.ts');
      expect(highValueNames).toContain('User.ts');

      // Check layer detection
      expect(map.clusters.byLayer.business.length).toBeGreaterThan(0);
      expect(map.clusters.byLayer.data.length).toBeGreaterThan(0);
      expect(map.clusters.byLayer.infrastructure.length).toBeGreaterThan(0);
    });
  });

  // A truncated walk analyzed only a prefix of the repository. The map must carry that receipt so
  // `analyze` can disclose the partial corpus instead of reporting a smaller count as if it were
  // the whole repo (change: harden-walker-corpus-boundary).
  describe('partial-corpus disclosure', () => {
    it('propagates the truncation receipt when maxFiles is hit and renders it in the summary', async () => {
      for (let i = 0; i < 6; i++) {
        await writeFile(join(testDir, `mod${i}.ts`), `export const v${i} = ${i};`);
      }

      const outputDir = join(testDir, '.out');
      const mapper = new RepositoryMapper(testDir, { maxFiles: 2, outputDir });
      const map = await mapper.map();

      expect(map.summary.truncated).toBeDefined();
      expect(map.summary.truncated?.limit).toBe(2);

      await mapper.writeOutput(map);
      const summary = await import('node:fs/promises').then((fs) =>
        fs.readFile(join(outputDir, 'SUMMARY.md'), 'utf-8'),
      );
      expect(summary).toContain('Partial corpus');
    });

    it('leaves no truncation receipt when the walk completes within the cap', async () => {
      await writeFile(join(testDir, 'a.ts'), 'export const a = 1;');
      await writeFile(join(testDir, 'b.ts'), 'export const b = 2;');

      const map = await new RepositoryMapper(testDir, { maxFiles: 100 }).map();

      expect(map.summary.truncated).toBeUndefined();
    });
  });
});
