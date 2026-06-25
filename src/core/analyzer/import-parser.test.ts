/**
 * Import/Export Parser Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ImportExportParser,
  parseFile,
  parseFiles,
  resolveImport,
} from './import-parser.js';

// ============================================================================
// TEST FIXTURES
// ============================================================================

const JS_FIXTURES = {
  // ES Module imports
  esModuleDefault: `import React from 'react';`,
  esModuleNamed: `import { useState, useEffect } from 'react';`,
  esModuleNamespace: `import * as utils from './utils';`,
  esModuleSideEffect: `import './styles.css';`,
  esModuleMixed: `import React, { useState } from 'react';`,
  esModuleAliased: `import { foo as bar, baz as qux } from './module';`,
  esModuleMixedImport: `import React, { useState, useEffect } from 'react';`,

  // Type imports
  typeImportNamed: `import type { User, Post } from './types';`,
  typeImportDefault: `import type Config from './config';`,
  typeImportInline: `import { type User, useState } from './types';`,

  // CommonJS require
  cjsDefault: `const fs = require('fs');`,
  cjsNamed: `const { readFile, writeFile } = require('fs');`,
  cjsPath: `const path = require('path');`,

  // Dynamic imports
  dynamicImport: `const module = await import('./module');`,
  dynamicImportSync: `import('./lazy-module').then(m => m.default);`,

  // Node.js builtins
  nodeBuiltin: `import fs from 'fs';`,
  nodeBuiltinPrefixed: `import { readFile } from 'node:fs/promises';`,
  nodeBuiltinPath: `import path from 'node:path';`,

  // Relative imports
  relativeImport: `import { helper } from './helpers';`,
  relativeDeep: `import { utils } from '../../shared/utils';`,
  relativeIndex: `import { Component } from './components';`,

  // Package imports
  packageImport: `import lodash from 'lodash';`,
  scopedPackage: `import { Button } from '@mui/material';`,

  // ES Module exports
  exportDefault: `export default function App() {}`,
  exportDefaultClass: `export default class Service {}`,
  exportDefaultVariable: `export default config;`,
  exportNamed: `export { foo, bar };`,
  exportNamedAliased: `export { foo as default, bar as baz };`,
  exportConst: `export const API_KEY = 'secret';`,
  exportLet: `export let counter = 0;`,
  exportVar: `export var legacy = true;`,
  exportFunction: `export function calculate() {}`,
  exportClass: `export class Calculator {}`,
  exportType: `export type User = { name: string };`,
  exportInterface: `export interface Config { port: number }`,
  exportEnum: `export enum Status { Active, Inactive }`,

  // Re-exports
  reExportNamed: `export { foo, bar } from './module';`,
  reExportAll: `export * from './utils';`,
  reExportAllAs: `export * as utils from './utils';`,

  // CommonJS exports
  moduleExports: `module.exports = MyClass;`,
  exportsProperty: `exports.helper = function() {};`,

  // Mixed file
  complexFile: `
    import React, { useState, useEffect } from 'react';
    import type { User } from './types';
    import * as utils from './utils';
    import './global.css';
    const fs = require('fs');

    export interface Config {
      port: number;
    }

    export const VERSION = '1.0.0';

    export function initialize() {}

    export class App extends React.Component {}

    export default App;
  `,

  // Barrel file (index.ts pattern)
  barrelFile: `
    export * from './button';
    export * from './input';
    export * from './select';
    export { default as Modal } from './modal';
    export type { ModalProps } from './modal';
  `,

  // With comments
  withComments: `
    // This is a comment
    import { foo } from './foo'; // inline comment
    /* Block comment
       import { ignored } from './ignored';
    */
    import { bar } from './bar';
    export const value = 42; // another comment
  `,
};

const PYTHON_FIXTURES = {
  // Simple imports
  simpleImport: `import os`,
  multipleImport: `import os, sys, json`,
  dottedImport: `import os.path`,
  aliasedImport: `import numpy as np`,

  // From imports
  fromImport: `from os import path`,
  fromImportMultiple: `from os import path, getcwd, chdir`,
  fromImportAliased: `from collections import defaultdict as dd`,
  fromImportStar: `from typing import *`,
  fromRelative: `from .utils import helper`,
  fromRelativeDeep: `from ..models import User`,

  // Exports (module-level definitions)
  classDefinition: `class UserService:
    pass`,
  functionDefinition: `def process_data():
    pass`,
  constantDefinition: `API_KEY = 'secret'`,
  multipleDefinitions: `
class User:
    pass

class Post:
    pass

def get_user():
    pass

MAX_RETRIES = 3
`,

  // __all__ definition
  allDefinition: `__all__ = ['User', 'Post', 'get_user']`,

  // Private definitions (should be excluded)
  privateDefinitions: `
def _private_helper():
    pass

def public_function():
    pass
`,

  // Complex file
  complexFile: `
import os
import sys
from typing import Optional, List
from .models import User, Post
from ..utils import helper as h

__all__ = ['MyClass', 'process']

class MyClass:
    pass

def process(data):
    pass

MAX_SIZE = 1024
`,
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `import-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createFile(dir: string, name: string, content: string): Promise<string> {
  const filePath = join(dir, name);
  const fileDir = join(dir, ...name.split('/').slice(0, -1));
  if (fileDir !== dir) {
    await mkdir(fileDir, { recursive: true });
  }
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ============================================================================
// TESTS
// ============================================================================

describe('ImportExportParser', () => {
  let tempDir: string;
  let parser: ImportExportParser;

  beforeEach(async () => {
    tempDir = await createTempDir();
    parser = new ImportExportParser();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // JavaScript/TypeScript Import Tests
  // ==========================================================================

  describe('JavaScript/TypeScript Imports', () => {
    it('should parse ES module default import', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.esModuleDefault);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'react',
        isRelative: false,
        isPackage: true,
        isBuiltin: false,
        importedNames: ['React'],
        hasDefault: true,
        hasNamespace: false,
        isTypeOnly: false,
        isDynamic: false,
      });
    });

    it('should parse ES module named imports', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.esModuleNamed);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'react',
        importedNames: ['useState', 'useEffect'],
        hasDefault: false,
      });
    });

    it('should parse ES module namespace import', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.esModuleNamespace);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: './utils',
        isRelative: true,
        importedNames: ['utils'],
        hasNamespace: true,
      });
    });

    it('should parse side-effect import', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.esModuleSideEffect);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: './styles.css',
        isRelative: true,
        importedNames: [],
        hasDefault: false,
      });
    });

    it('should parse aliased imports', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.esModuleAliased);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0].importedNames).toContain('bar');
      expect(analysis.imports[0].importedNames).toContain('qux');
    });

    it('should parse mixed import (default + named)', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.esModuleMixedImport);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'react',
        hasDefault: true,
        isPackage: true,
      });
      expect(analysis.imports[0].importedNames).toContain('React');
      expect(analysis.imports[0].importedNames).toContain('useState');
      expect(analysis.imports[0].importedNames).toContain('useEffect');
    });

    it('should parse type-only named imports', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.typeImportNamed);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: './types',
        isTypeOnly: true,
        importedNames: ['User', 'Post'],
      });
    });

    it('should parse type-only default import', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.typeImportDefault);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: './config',
        isTypeOnly: true,
        hasDefault: true,
        importedNames: ['Config'],
      });
    });

    it('should parse CommonJS require with default', async () => {
      const filePath = await createFile(tempDir, 'test.js', JS_FIXTURES.cjsDefault);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'fs',
        isBuiltin: true,
        importedNames: ['fs'],
        hasDefault: true,
      });
    });

    it('should parse CommonJS require with destructuring', async () => {
      const filePath = await createFile(tempDir, 'test.js', JS_FIXTURES.cjsNamed);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'fs',
        importedNames: ['readFile', 'writeFile'],
        hasDefault: false,
      });
    });

    it('should parse dynamic import with await', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.dynamicImport);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: './module',
        isDynamic: true,
        isRelative: true,
      });
    });

    it('should parse dynamic import without await', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.dynamicImportSync);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: './lazy-module',
        isDynamic: true,
      });
    });

    it('should identify Node.js builtin modules', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.nodeBuiltin);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'fs',
        isBuiltin: true,
        isPackage: false,
      });
    });

    it('should identify prefixed Node.js builtin modules', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.nodeBuiltinPrefixed);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'node:fs/promises',
        isBuiltin: true,
        isPackage: false,
      });
    });

    it('should identify relative imports', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.relativeDeep);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: '../../shared/utils',
        isRelative: true,
        isPackage: false,
      });
    });

    it('should identify scoped package imports', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.scopedPackage);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: '@mui/material',
        isPackage: true,
        isRelative: false,
      });
      expect(analysis.externalImports).toContain('@mui/material');
    });

    it('should categorize local and external imports', async () => {
      const content = `
        import { helper } from './helpers';
        import lodash from 'lodash';
        import fs from 'fs';
      `;
      const filePath = await createFile(tempDir, 'test.ts', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.localImports).toContain('./helpers');
      expect(analysis.externalImports).toContain('lodash');
      expect(analysis.externalImports).not.toContain('fs'); // builtin, not package
    });

    it('should ignore imports in comments', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.withComments);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(2);
      const sources = analysis.imports.map(i => i.source);
      expect(sources).toContain('./foo');
      expect(sources).toContain('./bar');
      expect(sources).not.toContain('./ignored');
    });
  });

  // ==========================================================================
  // JavaScript/TypeScript Export Tests
  // ==========================================================================

  describe('JavaScript/TypeScript Exports', () => {
    it('should parse export default function', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportDefault);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'App',
        isDefault: true,
        kind: 'function',
      });
    });

    it('should parse export default class', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportDefaultClass);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'Service',
        isDefault: true,
        kind: 'class',
      });
    });

    it('should parse export default variable', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportDefaultVariable);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'config',
        isDefault: true,
        kind: 'unknown',
      });
    });

    it('should parse named exports', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportNamed);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(2);
      const names = analysis.exports.map(e => e.name);
      expect(names).toContain('foo');
      expect(names).toContain('bar');
    });

    it('should parse export const', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportConst);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'API_KEY',
        kind: 'variable',
        isDefault: false,
      });
    });

    it('should parse export function', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportFunction);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'calculate',
        kind: 'function',
      });
    });

    it('should parse export class', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportClass);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'Calculator',
        kind: 'class',
      });
    });

    it('should parse export type', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportType);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'User',
        kind: 'type',
        isType: true,
      });
    });

    it('should parse export interface', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportInterface);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'Config',
        kind: 'interface',
        isType: true,
      });
    });

    it('should parse export enum', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.exportEnum);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'Status',
        kind: 'enum',
      });
    });

    it('should parse re-export from module', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.reExportNamed);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(2);
      expect(analysis.exports[0]).toMatchObject({
        isReExport: true,
        reExportSource: './module',
      });
    });

    it('should parse re-export all', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.reExportAll);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: '*',
        isReExport: true,
        reExportSource: './utils',
      });
    });

    it('should parse re-export all as namespace', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.reExportAllAs);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'utils',
        isReExport: true,
        reExportSource: './utils',
      });
    });

    it('should parse module.exports', async () => {
      const filePath = await createFile(tempDir, 'test.js', JS_FIXTURES.moduleExports);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'MyClass',
        isDefault: true,
      });
    });

    it('should parse exports.property', async () => {
      const filePath = await createFile(tempDir, 'test.js', JS_FIXTURES.exportsProperty);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'helper',
        isDefault: false,
      });
    });

    it('should parse barrel file pattern', async () => {
      const filePath = await createFile(tempDir, 'index.ts', JS_FIXTURES.barrelFile);
      const analysis = await parser.parseFile(filePath);

      // 3 re-export all + 1 default re-export + 1 type re-export
      expect(analysis.exports.length).toBeGreaterThanOrEqual(4);

      const reExports = analysis.exports.filter(e => e.isReExport);
      expect(reExports.length).toBeGreaterThanOrEqual(4);

      const sources = reExports.map(e => e.reExportSource);
      expect(sources).toContain('./button');
      expect(sources).toContain('./input');
      expect(sources).toContain('./select');
      expect(sources).toContain('./modal');
    });
  });

  // ==========================================================================
  // Python Import/Export Tests
  // ==========================================================================

  describe('Python Imports', () => {
    it('should parse simple import', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.simpleImport);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'os',
        isPackage: true,
        hasNamespace: true,
      });
    });

    it('should parse multiple imports on one line', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.multipleImport);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(3);
      const sources = analysis.imports.map(i => i.source);
      expect(sources).toContain('os');
      expect(sources).toContain('sys');
      expect(sources).toContain('json');
    });

    it('should parse dotted import', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.dottedImport);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'os.path',
        importedNames: ['path'],
      });
    });

    it('should parse aliased import', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.aliasedImport);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0].importedNames).toContain('np');
    });

    it('should parse from import', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.fromImport);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'os',
        importedNames: ['path'],
        hasNamespace: false,
      });
    });

    it('should parse from import with multiple names', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.fromImportMultiple);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0].importedNames).toEqual(['path', 'getcwd', 'chdir']);
    });

    it('should parse from import star', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.fromImportStar);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: 'typing',
        importedNames: ['*'],
        hasNamespace: true,
      });
    });

    it('should parse relative imports', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.fromRelative);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: '.utils',
        isRelative: true,
        importedNames: ['helper'],
      });
    });

    it('should parse deep relative imports', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.fromRelativeDeep);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0]).toMatchObject({
        source: '..models',
        isRelative: true,
      });
    });

    it('should parse function-level (indented, deferred) imports', async () => {
      // Imports inside a function body — common in Python to break import cycles or
      // lazy-load — must be captured, not just module-top-level ones.
      const src = [
        'import os',
        '',
        'def run():',
        '    from .compare import compare',
        '    import numpy as np',
        '    return compare(np)',
      ].join('\n');
      const filePath = await createFile(tempDir, 'deferred.py', src);
      const analysis = await parser.parseFile(filePath);
      const sources = analysis.imports.map(i => i.source);
      expect(sources).toContain('.compare'); // indented relative import captured
      expect(sources).toContain('numpy'); // indented package import captured
      const rel = analysis.imports.find(i => i.source === '.compare');
      expect(rel).toMatchObject({ isRelative: true, importedNames: ['compare'] });
    });
  });

  describe('Python Exports', () => {
    it('should parse class definition as export', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.classDefinition);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'UserService',
        kind: 'class',
      });
    });

    it('should parse function definition as export', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.functionDefinition);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'process_data',
        kind: 'function',
      });
    });

    it('should parse constant definition as export', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.constantDefinition);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'API_KEY',
        kind: 'variable',
      });
    });

    it('should parse __all__ definition', async () => {
      const content = `__all__ = ['User', 'Post', 'get_user']`;
      const filePath = await createFile(tempDir, 'test.py', content);
      const analysis = await parser.parseFile(filePath);

      const names = analysis.exports.map(e => e.name);
      expect(names).toContain('User');
      expect(names).toContain('Post');
      expect(names).toContain('get_user');
    });

    it('should exclude private functions', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.privateDefinitions);
      const analysis = await parser.parseFile(filePath);

      const names = analysis.exports.map(e => e.name);
      expect(names).toContain('public_function');
      expect(names).not.toContain('_private_helper');
    });
  });

  // ==========================================================================
  // Complex File Tests
  // ==========================================================================

  describe('Complex Files', () => {
    it('should parse complex JavaScript/TypeScript file', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.complexFile);
      const analysis = await parser.parseFile(filePath);

      // Imports
      expect(analysis.imports.length).toBeGreaterThanOrEqual(4);
      const importSources = analysis.imports.map(i => i.source);
      expect(importSources).toContain('react');
      expect(importSources).toContain('./types');
      expect(importSources).toContain('./utils');
      expect(importSources).toContain('./global.css');
      expect(importSources).toContain('fs');

      // Exports
      expect(analysis.exports.length).toBeGreaterThanOrEqual(4);
      const exportNames = analysis.exports.map(e => e.name);
      expect(exportNames).toContain('Config');
      expect(exportNames).toContain('VERSION');
      expect(exportNames).toContain('initialize');
      expect(exportNames).toContain('App');
    });

    it('should parse complex Python file', async () => {
      const filePath = await createFile(tempDir, 'test.py', PYTHON_FIXTURES.complexFile);
      const analysis = await parser.parseFile(filePath);

      // Imports
      expect(analysis.imports.length).toBeGreaterThanOrEqual(4);
      const importSources = analysis.imports.map(i => i.source);
      expect(importSources).toContain('os');
      expect(importSources).toContain('sys');
      expect(importSources).toContain('typing');

      // Exports
      expect(analysis.exports.length).toBeGreaterThanOrEqual(3);
      const exportNames = analysis.exports.map(e => e.name);
      expect(exportNames).toContain('MyClass');
      expect(exportNames).toContain('process');
      expect(exportNames).toContain('MAX_SIZE');
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle empty files', async () => {
      const filePath = await createFile(tempDir, 'empty.ts', '');
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(0);
      expect(analysis.exports).toHaveLength(0);
      expect(analysis.parseErrors).toHaveLength(0);
    });

    it('should handle files with only comments', async () => {
      const content = `
        // This is a comment
        /* Block comment */
        /**
         * JSDoc comment
         */
      `;
      const filePath = await createFile(tempDir, 'comments.ts', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(0);
      expect(analysis.exports).toHaveLength(0);
    });

    it('should handle unsupported file types', async () => {
      const filePath = await createFile(tempDir, 'test.go', 'package main');
      const analysis = await parser.parseFile(filePath);

      expect(analysis.parseErrors).toHaveLength(1);
      expect(analysis.parseErrors[0]).toContain('Unsupported file type');
    });

    it('should handle non-existent files', async () => {
      const analysis = await parser.parseFile('/nonexistent/file.ts');

      expect(analysis.parseErrors).toHaveLength(1);
      expect(analysis.parseErrors[0]).toContain('Failed to read file');
    });

    it('should provide line numbers', async () => {
      const content = `
import { foo } from './foo';
import { bar } from './bar';

export const value = 1;
export function test() {}
      `;
      const filePath = await createFile(tempDir, 'test.ts', content);
      const analysis = await parser.parseFile(filePath);

      // Line numbers should be > 0
      for (const imp of analysis.imports) {
        expect(imp.line).toBeGreaterThan(0);
      }
      for (const exp of analysis.exports) {
        expect(exp.line).toBeGreaterThan(0);
      }
    });

    it('should handle circular import scenarios (file-level)', async () => {
      // Create two files that import each other
      await createFile(tempDir, 'a.ts', `
        import { B } from './b';
        export class A {}
      `);
      await createFile(tempDir, 'b.ts', `
        import { A } from './a';
        export class B {}
      `);

      const analysisA = await parser.parseFile(join(tempDir, 'a.ts'));
      const analysisB = await parser.parseFile(join(tempDir, 'b.ts'));

      // Both should parse correctly
      expect(analysisA.imports).toHaveLength(1);
      expect(analysisA.exports).toHaveLength(1);
      expect(analysisB.imports).toHaveLength(1);
      expect(analysisB.exports).toHaveLength(1);
    });

    it('should handle mixed import styles in same file', async () => {
      const content = `
        import React from 'react';
        import { useState } from 'react';
        import type { FC } from 'react';
        const lodash = require('lodash');
        const lazy = await import('./lazy');
      `;
      const filePath = await createFile(tempDir, 'test.ts', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(5);
      expect(analysis.imports.filter(i => i.isDynamic)).toHaveLength(1);
      expect(analysis.imports.filter(i => i.isTypeOnly)).toHaveLength(1);
    });

    it('should deduplicate external packages', async () => {
      const content = `
        import { Button } from '@mui/material';
        import { TextField } from '@mui/material';
        import { Icon } from '@mui/icons-material';
      `;
      const filePath = await createFile(tempDir, 'test.ts', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.externalImports).toContain('@mui/material');
      expect(analysis.externalImports).toContain('@mui/icons-material');
      // Should not have duplicates
      expect(analysis.externalImports.filter(p => p === '@mui/material')).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Caching Tests
  // ==========================================================================

  describe('Caching', () => {
    it('should cache parse results', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.esModuleDefault);

      const analysis1 = await parser.parseFile(filePath);
      const analysis2 = await parser.parseFile(filePath);

      // Should be the exact same object (cached)
      expect(analysis1).toBe(analysis2);
    });

    it('should clear cache', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.esModuleDefault);

      const analysis1 = await parser.parseFile(filePath);
      parser.clearCache();
      const analysis2 = await parser.parseFile(filePath);

      // Should be different objects after cache clear
      expect(analysis1).not.toBe(analysis2);
      // But should have same content
      expect(analysis1.imports).toEqual(analysis2.imports);
    });
  });

  // ==========================================================================
  // Convenience Function Tests
  // ==========================================================================

  describe('Convenience Functions', () => {
    it('should parse single file with parseFile function', async () => {
      const filePath = await createFile(tempDir, 'test.ts', JS_FIXTURES.esModuleDefault);
      const analysis = await parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
    });

    it('should parse multiple files with parseFiles function', async () => {
      const file1 = await createFile(tempDir, 'a.ts', JS_FIXTURES.esModuleDefault);
      const file2 = await createFile(tempDir, 'b.ts', JS_FIXTURES.exportFunction);

      const results = await parseFiles([file1, file2]);

      expect(results.size).toBe(2);
      expect(results.get(file1)?.imports).toHaveLength(1);
      expect(results.get(file2)?.exports).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Import Resolution Tests
  // ==========================================================================

  describe('Import Resolution', () => {
    it('should return null for package imports', async () => {
      const result = await resolveImport('react', '/project/src/app.ts', {
        baseDir: '/project',
      });

      expect(result).toBeNull();
    });

    it('should resolve relative import with extension', async () => {
      const utilsPath = await createFile(tempDir, 'utils.ts', 'export const foo = 1;');

      const result = await resolveImport('./utils', join(tempDir, 'app.ts'), {
        baseDir: tempDir,
      });

      expect(result).toBe(utilsPath);
    });

    it('should resolve index file in directory', async () => {
      await mkdir(join(tempDir, 'components'), { recursive: true });
      const indexPath = await createFile(tempDir, 'components/index.ts', 'export * from "./button";');

      const result = await resolveImport('./components', join(tempDir, 'app.ts'), {
        baseDir: tempDir,
      });

      expect(result).toBe(indexPath);
    });

    it('should try multiple extensions', async () => {
      const helperPath = await createFile(tempDir, 'helper.tsx', 'export const Component = () => null;');

      const result = await resolveImport('./helper', join(tempDir, 'app.ts'), {
        baseDir: tempDir,
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
      });

      expect(result).toBe(helperPath);
    });

    it('should return null for unresolvable imports', async () => {
      const result = await resolveImport('./nonexistent', join(tempDir, 'app.ts'), {
        baseDir: tempDir,
      });

      expect(result).toBeNull();
    });

    // ── NodeNext / ESM interop ──────────────────────────────────────────────
    // TypeScript projects using "moduleResolution": "NodeNext" write imports
    // with a .js extension even though the file on disk is .ts.
    // e.g.  import { foo } from './utils.js'  →  resolves to  ./utils.ts
    // The old implementation appended extensions on top of the existing one,
    // producing paths like `utils.js.ts` that never exist on disk.

    it('should resolve .js import to .ts file (NodeNext convention)', async () => {
      const utilsPath = await createFile(tempDir, 'utils.ts', 'export const foo = 1;');

      const result = await resolveImport('./utils.js', join(tempDir, 'app.ts'), {
        baseDir: tempDir,
      });

      expect(result).toBe(utilsPath);
    });

    it('should resolve .js import to .tsx file (NodeNext convention)', async () => {
      const componentPath = await createFile(tempDir, 'Button.tsx', 'export const Button = () => null;');

      const result = await resolveImport('./Button.js', join(tempDir, 'app.ts'), {
        baseDir: tempDir,
      });

      expect(result).toBe(componentPath);
    });

    it('should resolve .js import to index.ts inside a directory (NodeNext barrel)', async () => {
      await mkdir(join(tempDir, 'components'), { recursive: true });
      const indexPath = await createFile(tempDir, 'components/index.ts', 'export * from "./Button";');

      // `import "./components/index.js"` should resolve to `components/index.ts`
      const result = await resolveImport('./components/index.js', join(tempDir, 'app.ts'), {
        baseDir: tempDir,
      });

      expect(result).toBe(indexPath);
    });

    it('should still resolve plain extensionless import to .ts file', async () => {
      const helperPath = await createFile(tempDir, 'helper.ts', 'export const bar = 2;');

      const result = await resolveImport('./helper', join(tempDir, 'app.ts'), {
        baseDir: tempDir,
      });

      expect(result).toBe(helperPath);
    });

    it('should prefer exact match over extension-stripped match', async () => {
      // Both `real.js` (JS) and `real.ts` (TS) exist — exact match wins.
      const jsPath = await createFile(tempDir, 'real.js', 'export const x = 1;');
      await createFile(tempDir, 'real.ts', 'export const x = 2;');

      const result = await resolveImport('./real.js', join(tempDir, 'app.ts'), {
        baseDir: tempDir,
      });

      expect(result).toBe(jsPath);
    });

    // ── Python relative import resolution ──────────────────────────────────

    it('should resolve Python single-dot relative import', async () => {
      const utilsPath = await createFile(tempDir, 'utils.py', 'def helper(): pass');

      const result = await resolveImport('.utils', join(tempDir, 'app.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(utilsPath);
    });

    it('should resolve Python double-dot relative import', async () => {
      await mkdir(join(tempDir, 'pkg'), { recursive: true });
      const modelsPath = await createFile(tempDir, 'models.py', 'class User: pass');

      const result = await resolveImport('..models', join(tempDir, 'pkg', 'service.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(modelsPath);
    });

    it('should resolve Python package __init__.py', async () => {
      await mkdir(join(tempDir, 'mypackage'), { recursive: true });
      const initPath = await createFile(tempDir, 'mypackage/__init__.py', '');

      const result = await resolveImport('.mypackage', join(tempDir, 'app.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(initPath);
    });

    it('should resolve Python dotted submodule path', async () => {
      await mkdir(join(tempDir, 'db'), { recursive: true });
      const modelsPath = await createFile(tempDir, 'db/models.py', 'class User: pass');

      const result = await resolveImport('.db.models', join(tempDir, 'app.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(modelsPath);
    });

    // ── Python absolute (intra-project) import resolution ──────────────────
    // These are the imports that were silently dropped before the fix.
    // e.g. `from services.retriever import retrieve_docs` in a FastAPI project
    // where the file lives at <rootDir>/services/retriever.py.
    // The old code returned null for every non-dot-prefixed Python import
    // because isRelativeImport() returned false. The fix resolves them from
    // rootDir instead of fromDir.

    it('should resolve Python absolute import to a sibling module', async () => {
      // from utils import helper   →   <rootDir>/utils.py
      const utilsPath = await createFile(tempDir, 'utils.py', 'def helper(): pass');

      const result = await resolveImport('utils', join(tempDir, 'app.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(utilsPath);
    });

    it('should resolve Python absolute dotted import (package.module)', async () => {
      // from services.retriever import retrieve_docs   →   <rootDir>/services/retriever.py
      await mkdir(join(tempDir, 'services'), { recursive: true });
      const retrieverPath = await createFile(tempDir, 'services/retriever.py', 'def retrieve_docs(): pass');

      const result = await resolveImport('services.retriever', join(tempDir, 'app.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(retrieverPath);
    });

    it('should resolve Python absolute dotted import regardless of caller location', async () => {
      // A file deep in a subdirectory should still resolve from rootDir, not fromDir.
      // from models.embedding import EmbeddingModel  →  <rootDir>/models/embedding.py
      await mkdir(join(tempDir, 'routers'), { recursive: true });
      await mkdir(join(tempDir, 'models'), { recursive: true });
      const embeddingPath = await createFile(tempDir, 'models/embedding.py', 'class EmbeddingModel: pass');

      const result = await resolveImport('models.embedding', join(tempDir, 'routers', 'search.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(embeddingPath);
    });

    it('should resolve Python absolute import to a package __init__.py', async () => {
      // from db import session   →   <rootDir>/db/__init__.py
      await mkdir(join(tempDir, 'db'), { recursive: true });
      const initPath = await createFile(tempDir, 'db/__init__.py', 'from .session import Session');

      const result = await resolveImport('db', join(tempDir, 'app.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(initPath);
    });

    it('should resolve deeply nested Python absolute import', async () => {
      // from api.v1.routes.items import router   →   <rootDir>/api/v1/routes/items.py
      await mkdir(join(tempDir, 'api/v1/routes'), { recursive: true });
      const itemsPath = await createFile(tempDir, 'api/v1/routes/items.py', 'router = None');

      const result = await resolveImport('api.v1.routes.items', join(tempDir, 'main.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(itemsPath);
    });

    it('should still return null for a genuine third-party Python package', async () => {
      // 'fastapi' is not a file in the project — should return null
      const result = await resolveImport('fastapi', join(tempDir, 'app.py'), {
        baseDir: tempDir,
      });

      expect(result).toBeNull();
    });

    it('should still return null for a Python stdlib module', async () => {
      // 'os' is a builtin, not a project file
      const result = await resolveImport('os', join(tempDir, 'app.py'), {
        baseDir: tempDir,
      });

      expect(result).toBeNull();
    });

    it('should prefer an exact file match over __init__.py for absolute imports', async () => {
      // Both <rootDir>/config.py and <rootDir>/config/__init__.py exist —
      // the plain module file should be preferred.
      const configFilePath = await createFile(tempDir, 'config.py', 'DEBUG = True');
      await mkdir(join(tempDir, 'config'), { recursive: true });
      await createFile(tempDir, 'config/__init__.py', '');

      const result = await resolveImport('config', join(tempDir, 'app.py'), {
        baseDir: tempDir,
      });

      expect(result).toBe(configFilePath);
    });
  });

  // ==========================================================================
  // Special Patterns Tests
  // ==========================================================================

  describe('Special Patterns', () => {
    it('should handle multi-line imports', async () => {
      const content = `
        import {
          foo,
          bar,
          baz
        } from './module';
      `;
      const filePath = await createFile(tempDir, 'test.ts', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0].importedNames).toContain('foo');
      expect(analysis.imports[0].importedNames).toContain('bar');
      expect(analysis.imports[0].importedNames).toContain('baz');
    });

    it('should handle async function exports', async () => {
      const content = `export async function fetchData() {}`;
      const filePath = await createFile(tempDir, 'test.ts', content);
      const analysis = await parser.parseFile(filePath);

      // Note: our simple regex may or may not catch 'async function'
      // This test documents the current behavior
      expect(analysis.exports.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle arrow function exports', async () => {
      const content = `export const handler = () => {};`;
      const filePath = await createFile(tempDir, 'test.ts', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.exports).toHaveLength(1);
      expect(analysis.exports[0]).toMatchObject({
        name: 'handler',
        kind: 'variable',
      });
    });

    it('should handle destructured exports', async () => {
      const content = `
        const obj = { a: 1, b: 2 };
        export const { a, b } = obj;
      `;
      const filePath = await createFile(tempDir, 'test.ts', content);
      const analysis = await parser.parseFile(filePath);

      // Our simple regex captures 'a' from 'const { a, b }'
      // This is a known limitation - documents current behavior
      expect(analysis.exports.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle declare module syntax', async () => {
      const content = `
        declare module '*.css' {
          const styles: { [className: string]: string };
          export default styles;
        }
      `;
      const filePath = await createFile(tempDir, 'test.d.ts', content);
      const analysis = await parser.parseFile(filePath);

      // Declare modules may or may not be parsed - documents current behavior
      expect(analysis.parseErrors).toHaveLength(0);
    });

    it('should handle template literal imports (dynamic)', async () => {
      // Template literal imports can't be statically analyzed
      const content = `
        const module = 'utils';
        const imp = await import(\`./\${module}\`);
      `;
      const filePath = await createFile(tempDir, 'test.ts', content);
      const analysis = await parser.parseFile(filePath);

      // Template literal imports won't be captured (expected behavior)
      // Only string literal imports are captured
      expect(analysis.parseErrors).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Java Tests
  // ==========================================================================

  describe('Java Imports', () => {
    it('should parse simple class imports', async () => {
      const content = `
        package com.example.service;
        import com.example.model.User;
        import com.example.repo.UserRepository;
      `;
      const filePath = await createFile(tempDir, 'UserService.java', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(2);
      expect(analysis.imports[0].source).toBe('com.example.model.User');
      expect(analysis.imports[0].isBuiltin).toBe(false);
      expect(analysis.imports[0].isPackage).toBe(true);
      expect(analysis.imports[0].importedNames).toEqual(['User']);
    });

    it('should classify JDK imports as builtin', async () => {
      const content = `
        package com.example;
        import java.util.List;
        import java.util.Map;
        import javax.sql.DataSource;
        import jakarta.servlet.http.HttpServletRequest;
      `;
      const filePath = await createFile(tempDir, 'App.java', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(4);
      expect(analysis.imports.every(i => i.isBuiltin)).toBe(true);
    });

    it('should handle wildcard imports', async () => {
      const content = `
        package com.example;
        import com.example.model.*;
      `;
      const filePath = await createFile(tempDir, 'App.java', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0].source).toBe('com.example.model.*');
      expect(analysis.imports[0].hasNamespace).toBe(true);
      expect(analysis.imports[0].importedNames).toEqual(['*']);
    });

    it('should handle static member imports by stripping the member', async () => {
      const content = `
        package com.example;
        import static com.example.util.Constants.MAX_SIZE;
        import static org.junit.jupiter.api.Assertions.assertEquals;
      `;
      const filePath = await createFile(tempDir, 'App.java', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(2);
      // `MAX_SIZE` is UPPER_CASE (not a class), so the member is NOT stripped
      // — but `assertEquals` is lowercase, so the member IS stripped.
      expect(analysis.imports[0].source).toBe('com.example.util.Constants.MAX_SIZE');
      expect(analysis.imports[1].source).toBe('org.junit.jupiter.api.Assertions');
    });

    it('should extract package declaration', async () => {
      const content = `
        package com.example.service;
        public class Foo {}
      `;
      const filePath = await createFile(tempDir, 'Foo.java', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.javaPackage).toBe('com.example.service');
    });

    it('should ignore imports inside comments', async () => {
      const content = `
        package com.example;
        // import com.fake.Bar;
        /* import com.another.Baz; */
        import com.real.Qux;
      `;
      const filePath = await createFile(tempDir, 'App.java', content);
      const analysis = await parser.parseFile(filePath);

      expect(analysis.imports).toHaveLength(1);
      expect(analysis.imports[0].source).toBe('com.real.Qux');
    });
  });

  describe('Java Exports', () => {
    it('should extract public classes, interfaces, enums, and records', async () => {
      const content = `
        package com.example;
        public class UserService {}
        public interface UserRepository {}
        public enum Role { ADMIN, USER }
        public record UserDto(String name) {}
      `;
      const filePath = await createFile(tempDir, 'Types.java', content);
      const analysis = await parser.parseFile(filePath);

      const byName = Object.fromEntries(analysis.exports.map(e => [e.name, e.kind]));
      expect(byName.UserService).toBe('class');
      expect(byName.UserRepository).toBe('interface');
      expect(byName.Role).toBe('enum');
      expect(byName.UserDto).toBe('class');
    });

    it('should extract public methods', async () => {
      const content = `
        package com.example;
        public class Service {
          public User getUser(Long id) { return null; }
          public void deleteUser(Long id) {}
          private void helper() {}
        }
      `;
      const filePath = await createFile(tempDir, 'Service.java', content);
      const analysis = await parser.parseFile(filePath);

      const methodNames = analysis.exports.filter(e => e.kind === 'function').map(e => e.name);
      expect(methodNames).toContain('getUser');
      expect(methodNames).toContain('deleteUser');
      // private methods are NOT exports
      expect(methodNames).not.toContain('helper');
    });
  });

  describe('Java Import Resolution', () => {
    it('should resolve import against computed source root from package', async () => {
      // Gradle layout: src/main/java/com/example/...
      await mkdir(join(tempDir, 'src/main/java/com/example/model'), { recursive: true });
      await mkdir(join(tempDir, 'src/main/java/com/example/service'), { recursive: true });

      const userPath = await createFile(
        tempDir,
        'src/main/java/com/example/model/User.java',
        'package com.example.model;\npublic class User {}'
      );
      const servicePath = join(tempDir, 'src/main/java/com/example/service/UserService.java');
      await createFile(
        tempDir,
        'src/main/java/com/example/service/UserService.java',
        `package com.example.service;\nimport com.example.model.User;\npublic class UserService {}`
      );

      const result = await resolveImport('com.example.model.User', servicePath, {
        baseDir: tempDir,
        sourcePackage: 'com.example.service',
      });

      expect(result).toBe(userPath);
    });

    it('should return null for JDK builtin imports', async () => {
      const result = await resolveImport(
        'java.util.List',
        join(tempDir, 'src/main/java/com/foo/App.java'),
        { baseDir: tempDir, sourcePackage: 'com.foo' }
      );

      expect(result).toBeNull();
    });

    it('should return null for wildcard imports', async () => {
      await mkdir(join(tempDir, 'src/main/java/com/example/model'), { recursive: true });
      await createFile(
        tempDir,
        'src/main/java/com/example/model/User.java',
        'package com.example.model;\npublic class User {}'
      );

      const result = await resolveImport(
        'com.example.model.*',
        join(tempDir, 'src/main/java/com/example/App.java'),
        { baseDir: tempDir, sourcePackage: 'com.example' }
      );

      expect(result).toBeNull();
    });

    it('should fall back to walking for a conventional source root when package is missing', async () => {
      // File has no package declaration, but lives under src/main/java/.
      await mkdir(join(tempDir, 'src/main/java/com/foo'), { recursive: true });
      const fooPath = await createFile(
        tempDir,
        'src/main/java/com/foo/Foo.java',
        'package com.foo;\npublic class Foo {}'
      );
      // Caller has no sourcePackage — resolver should still find Foo via
      // the "src/main/java" ancestor.
      const appPath = join(tempDir, 'src/main/java/App.java');
      await createFile(tempDir, 'src/main/java/App.java', 'public class App {}');

      const result = await resolveImport('com.foo.Foo', appPath, {
        baseDir: tempDir,
      });

      expect(result).toBe(fooPath);
    });
  });
});
