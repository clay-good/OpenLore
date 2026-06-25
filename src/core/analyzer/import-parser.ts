/**
 * Import/Export Parser
 *
 * Parses source files to extract imports and exports.
 * Uses regex-based parsing for speed and simplicity.
 * Supports JavaScript/TypeScript, Python, and Java.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Information about an import statement
 */
export interface ImportInfo {
  source: string;
  isRelative: boolean;
  isPackage: boolean;
  isBuiltin: boolean;
  importedNames: string[];
  hasDefault: boolean;
  hasNamespace: boolean;
  isTypeOnly: boolean;
  isDynamic: boolean;
  line: number;
  /**
   * Set when this import is an HTML asset reference (`<script src>` /
   * `<link rel=stylesheet href>`) rather than a code import, so the dependency
   * graph can label the edge. Absent for ordinary code imports.
   */
  assetKind?: 'script' | 'stylesheet';
}

/**
 * Information about an export statement
 */
export interface ExportInfo {
  name: string;
  isDefault: boolean;
  isType: boolean;
  isReExport: boolean;
  reExportSource?: string;
  kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 'unknown';
  line: number;
}

/**
 * Complete analysis of a file's imports and exports
 */
export interface FileAnalysis {
  filePath: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  localImports: string[];
  externalImports: string[];
  parseErrors: string[];
  /** Java package declaration (e.g. "com.example.service"), if this is a .java file */
  javaPackage?: string;
}

/**
 * Options for import resolution
 */
export interface ResolveOptions {
  /** Base directory for resolving relative imports */
  baseDir: string;
  /** TypeScript paths aliases (from tsconfig) */
  pathAliases?: Record<string, string[]>;
  /** File extensions to try when resolving */
  extensions?: string[];
  /** Java package declaration of the source file (used to locate source root) */
  sourcePackage?: string;
}

// ============================================================================
// NODE.JS BUILTINS
// ============================================================================

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  // Node.js prefixed versions
  'node:assert', 'node:async_hooks', 'node:buffer', 'node:child_process',
  'node:cluster', 'node:console', 'node:constants', 'node:crypto', 'node:dgram',
  'node:diagnostics_channel', 'node:dns', 'node:domain', 'node:events',
  'node:fs', 'node:http', 'node:http2', 'node:https', 'node:inspector',
  'node:module', 'node:net', 'node:os', 'node:path', 'node:perf_hooks',
  'node:process', 'node:punycode', 'node:querystring', 'node:readline',
  'node:repl', 'node:stream', 'node:string_decoder', 'node:timers', 'node:tls',
  'node:trace_events', 'node:tty', 'node:url', 'node:util', 'node:v8',
  'node:vm', 'node:wasi', 'node:worker_threads', 'node:zlib',
  // fs/promises and other submodules
  'fs/promises', 'node:fs/promises', 'stream/promises', 'node:stream/promises',
  'timers/promises', 'node:timers/promises', 'util/types', 'node:util/types',
]);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a module path is a relative import
 */
function isRelativeImport(source: string): boolean {
  return source.startsWith('.') || source.startsWith('/');
}

/**
 * Check if a module is a Node.js builtin
 */
function isBuiltinModule(source: string): boolean {
  return NODE_BUILTINS.has(source) || NODE_BUILTINS.has(source.split('/')[0]);
}

/**
 * Get line number for a match position in content
 */
function getLineNumber(content: string, position: number): number {
  return content.substring(0, position).split('\n').length;
}

/**
 * Parse named imports from a string like "X, Y as Z, W"
 */
function parseNamedImports(namesStr: string): string[] {
  return namesStr
    .split(',')
    .map(name => {
      const trimmed = name.trim();
      // Handle "X as Y" - we want the local name Y
      const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
      if (asMatch) {
        return asMatch[2];
      }
      // Handle type imports like "type X"
      if (trimmed.startsWith('type ')) {
        return trimmed.slice(5).trim();
      }
      return trimmed;
    })
    .filter(name => name && !name.includes(' '));
}

// ============================================================================
// JAVASCRIPT/TYPESCRIPT PARSER
// ============================================================================

/**
 * Parse imports from JavaScript/TypeScript content
 */
export function parseJSImports(content: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  // Remove comments to avoid false matches
  const cleanContent = content
    .replace(/\/\*[\s\S]*?\*\//g, '') // Block comments
    .replace(/\/\/.*$/gm, '');        // Line comments

  // ES Module: import X from 'module'
  let match: RegExpExecArray | null;
  const defaultImportRegex = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = defaultImportRegex.exec(cleanContent)) !== null) {
    const source = match[2];
    imports.push({
      source,
      isRelative: isRelativeImport(source),
      isPackage: !isRelativeImport(source) && !isBuiltinModule(source),
      isBuiltin: isBuiltinModule(source),
      importedNames: [match[1]],
      hasDefault: true,
      hasNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
      line: getLineNumber(content, match.index),
    });
  }

  // ES Module: import X, { Y, Z } from 'module' (mixed import - default + named)
  const mixedImportRegex = /import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = mixedImportRegex.exec(cleanContent)) !== null) {
    const source = match[3];
    const names = [match[1], ...parseNamedImports(match[2])];
    imports.push({
      source,
      isRelative: isRelativeImport(source),
      isPackage: !isRelativeImport(source) && !isBuiltinModule(source),
      isBuiltin: isBuiltinModule(source),
      importedNames: names,
      hasDefault: true,
      hasNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
      line: getLineNumber(content, match.index),
    });
  }

  // ES Module: import { X, Y } from 'module'
  const namedImportRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = namedImportRegex.exec(cleanContent)) !== null) {
    const source = match[2];
    const names = parseNamedImports(match[1]);
    imports.push({
      source,
      isRelative: isRelativeImport(source),
      isPackage: !isRelativeImport(source) && !isBuiltinModule(source),
      isBuiltin: isBuiltinModule(source),
      importedNames: names,
      hasDefault: false,
      hasNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
      line: getLineNumber(content, match.index),
    });
  }

  // ES Module: import * as X from 'module'
  const namespaceImportRegex = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = namespaceImportRegex.exec(cleanContent)) !== null) {
    const source = match[2];
    imports.push({
      source,
      isRelative: isRelativeImport(source),
      isPackage: !isRelativeImport(source) && !isBuiltinModule(source),
      isBuiltin: isBuiltinModule(source),
      importedNames: [match[1]],
      hasDefault: false,
      hasNamespace: true,
      isTypeOnly: false,
      isDynamic: false,
      line: getLineNumber(content, match.index),
    });
  }

  // ES Module: import 'module' (side effect)
  const sideEffectRegex = /import\s+['"]([^'"]+)['"](?!\s*from)/g;
  while ((match = sideEffectRegex.exec(cleanContent)) !== null) {
    const source = match[1];
    imports.push({
      source,
      isRelative: isRelativeImport(source),
      isPackage: !isRelativeImport(source) && !isBuiltinModule(source),
      isBuiltin: isBuiltinModule(source),
      importedNames: [],
      hasDefault: false,
      hasNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
      line: getLineNumber(content, match.index),
    });
  }

  // Type-only imports: import type { X } from 'module'
  const typeImportRegex = /import\s+type\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = typeImportRegex.exec(cleanContent)) !== null) {
    const source = match[3];
    const names = match[1] ? parseNamedImports(match[1]) : [match[2]];
    imports.push({
      source,
      isRelative: isRelativeImport(source),
      isPackage: !isRelativeImport(source) && !isBuiltinModule(source),
      isBuiltin: isBuiltinModule(source),
      importedNames: names,
      hasDefault: !!match[2],
      hasNamespace: false,
      isTypeOnly: true,
      isDynamic: false,
      line: getLineNumber(content, match.index),
    });
  }

  // CommonJS: require('module')
  const requireRegex = /(?:const|let|var)\s+(?:(\w+)|\{([^}]+)\})\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(cleanContent)) !== null) {
    const source = match[3];
    const names = match[1] ? [match[1]] : parseNamedImports(match[2]);
    imports.push({
      source,
      isRelative: isRelativeImport(source),
      isPackage: !isRelativeImport(source) && !isBuiltinModule(source),
      isBuiltin: isBuiltinModule(source),
      importedNames: names,
      hasDefault: !!match[1],
      hasNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
      line: getLineNumber(content, match.index),
    });
  }

  // Dynamic import: import('module')
  const dynamicImportRegex = /(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(cleanContent)) !== null) {
    const source = match[1];
    imports.push({
      source,
      isRelative: isRelativeImport(source),
      isPackage: !isRelativeImport(source) && !isBuiltinModule(source),
      isBuiltin: isBuiltinModule(source),
      importedNames: [],
      hasDefault: false,
      hasNamespace: false,
      isTypeOnly: false,
      isDynamic: true,
      line: getLineNumber(content, match.index),
    });
  }

  return imports;
}

/**
 * Parse exports from JavaScript/TypeScript content
 */
export function parseJSExports(content: string): ExportInfo[] {
  const exports: ExportInfo[] = [];

  // Remove comments
  const cleanContent = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  let match: RegExpExecArray | null;

  // export default
  const defaultExportRegex = /export\s+default\s+(?:(class|function)\s+(\w+)|(\w+))/g;
  while ((match = defaultExportRegex.exec(cleanContent)) !== null) {
    const kind = match[1] as 'class' | 'function' | undefined;
    const name = match[2] || match[3] || 'default';
    exports.push({
      name,
      isDefault: true,
      isType: false,
      isReExport: false,
      kind: kind || 'unknown',
      line: getLineNumber(content, match.index),
    });
  }

  // export { X, Y } or export { X } from 'module'
  const namedExportRegex = /export\s+\{([^}]+)\}(?:\s+from\s+['"]([^'"]+)['"])?/g;
  while ((match = namedExportRegex.exec(cleanContent)) !== null) {
    const names = parseNamedImports(match[1]);
    const reExportSource = match[2];
    for (const name of names) {
      exports.push({
        name,
        isDefault: false,
        isType: false,
        isReExport: !!reExportSource,
        reExportSource,
        kind: 'unknown',
        line: getLineNumber(content, match.index),
      });
    }
  }

  // export const/let/var
  const varExportRegex = /export\s+(?:const|let|var)\s+(\w+)/g;
  while ((match = varExportRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: false,
      isType: false,
      isReExport: false,
      kind: 'variable',
      line: getLineNumber(content, match.index),
    });
  }

  // export function
  const funcExportRegex = /export\s+function\s+(\w+)/g;
  while ((match = funcExportRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: false,
      isType: false,
      isReExport: false,
      kind: 'function',
      line: getLineNumber(content, match.index),
    });
  }

  // export class
  const classExportRegex = /export\s+class\s+(\w+)/g;
  while ((match = classExportRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: false,
      isType: false,
      isReExport: false,
      kind: 'class',
      line: getLineNumber(content, match.index),
    });
  }

  // export type
  const typeExportRegex = /export\s+type\s+(\w+)/g;
  while ((match = typeExportRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: false,
      isType: true,
      isReExport: false,
      kind: 'type',
      line: getLineNumber(content, match.index),
    });
  }

  // export interface
  const interfaceExportRegex = /export\s+interface\s+(\w+)/g;
  while ((match = interfaceExportRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: false,
      isType: true,
      isReExport: false,
      kind: 'interface',
      line: getLineNumber(content, match.index),
    });
  }

  // export enum
  const enumExportRegex = /export\s+enum\s+(\w+)/g;
  while ((match = enumExportRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: false,
      isType: false,
      isReExport: false,
      kind: 'enum',
      line: getLineNumber(content, match.index),
    });
  }

  // export * from 'module'
  const reExportAllRegex = /export\s+\*\s+(?:as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/g;
  while ((match = reExportAllRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1] || '*',
      isDefault: false,
      isType: false,
      isReExport: true,
      reExportSource: match[2],
      kind: 'unknown',
      line: getLineNumber(content, match.index),
    });
  }

  // module.exports
  const moduleExportsRegex = /module\.exports\s*=\s*(\w+)/g;
  while ((match = moduleExportsRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: true,
      isType: false,
      isReExport: false,
      kind: 'unknown',
      line: getLineNumber(content, match.index),
    });
  }

  // exports.X
  const exportsRegex = /exports\.(\w+)\s*=/g;
  while ((match = exportsRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: false,
      isType: false,
      isReExport: false,
      kind: 'unknown',
      line: getLineNumber(content, match.index),
    });
  }

  return exports;
}

// ============================================================================
// PYTHON PARSER
// ============================================================================

const PYTHON_BUILTINS = new Set([
  // stdlib modules (Python 3)
  'abc', 'argparse', 'ast', 'asyncio', 'base64', 'builtins', 'cgi', 'cmath',
  'cmd', 'code', 'codecs', 'collections', 'concurrent', 'configparser',
  'contextlib', 'copy', 'csv', 'dataclasses', 'datetime', 'decimal',
  'difflib', 'dis', 'email', 'enum', 'errno', 'fileinput', 'fnmatch',
  'fractions', 'ftplib', 'functools', 'gc', 'getpass', 'gettext', 'glob',
  'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'imaplib', 'importlib',
  'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'linecache',
  'locale', 'logging', 'lzma', 'math', 'mimetypes', 'multiprocessing',
  'numbers', 'operator', 'os', 'pathlib', 'pickle', 'platform', 'pprint',
  'queue', 'random', 're', 'shlex', 'shutil', 'signal', 'smtplib', 'socket',
  'socketserver', 'sqlite3', 'ssl', 'stat', 'statistics', 'string',
  'struct', 'subprocess', 'sys', 'tarfile', 'tempfile', 'textwrap',
  'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'traceback',
  'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'warnings',
  'weakref', 'xml', 'xmlrpc', 'zipfile', 'zipimport', 'zlib',
  '__future__',
]);

/**
 * Parse imports from Python content
 */
export function parsePythonImports(content: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  // Remove comments and collapse multi-line parenthesized imports onto one line
  // e.g. "from x import (\n  A,\n  B\n)" → "from x import A, B"
  const cleanContent = content
    .replace(/#.*$/gm, '')
    .replace(/\(\s*([\s\S]*?)\s*\)/g, (_, inner) => inner.replace(/\s*\n\s*/g, ', '));

  let match: RegExpExecArray | null;

  // import X or import X, Y or import X.Y.Z. Allow leading indentation so
  // function-level / deferred imports (common in Python to break import cycles or
  // lazy-load) are captured, not just module-top-level ones.
  const importRegex = /^[ \t]*import[ \t]+([^\n\r]+)$/gm;
  while ((match = importRegex.exec(cleanContent)) !== null) {
    const modules = match[1].split(',').map(m => m.trim()).filter(Boolean);
    for (const mod of modules) {
      const source = mod.split(/\s+as\s+/)[0].trim();
      imports.push({
        source,
        isRelative: source.startsWith('.'),
        isPackage: !source.startsWith('.'),
        isBuiltin: PYTHON_BUILTINS.has(source.split('.')[0]),
        importedNames: [mod.includes(' as ') ? mod.split(/\s+as\s+/)[1].trim() : source.split('.').pop()!],
        hasDefault: false,
        hasNamespace: true,
        isTypeOnly: false,
        isDynamic: false,
        line: getLineNumber(content, match.index),
      });
    }
  }

  // from X import Y or from X import Y, Z (including multi-line after collapsing).
  // Allow leading indentation so function-level / deferred relative imports are
  // captured (e.g. `    from .compare import compare` inside a function body).
  const fromImportRegex = /^[ \t]*from\s+([\w.]+)\s+import\s+(.+)$/gm;
  while ((match = fromImportRegex.exec(cleanContent)) !== null) {
    const source = match[1];
    const importsPart = match[2].trim().replace(/[()]/g, '');

    if (importsPart === '*') {
      imports.push({
        source,
        isRelative: source.startsWith('.'),
        isPackage: !source.startsWith('.'),
        isBuiltin: PYTHON_BUILTINS.has(source.split('.')[0]),
        importedNames: ['*'],
        hasDefault: false,
        hasNamespace: true,
        isTypeOnly: false,
        isDynamic: false,
        line: getLineNumber(content, match.index),
      });
    } else {
      const names = importsPart.split(',').map(n => {
        const trimmed = n.trim();
        return trimmed.includes(' as ') ? trimmed.split(/\s+as\s+/)[1].trim() : trimmed;
      }).filter(Boolean);

      imports.push({
        source,
        isRelative: source.startsWith('.'),
        isPackage: !source.startsWith('.'),
        isBuiltin: PYTHON_BUILTINS.has(source.split('.')[0]),
        importedNames: names,
        hasDefault: false,
        hasNamespace: false,
        isTypeOnly: false,
        isDynamic: false,
        line: getLineNumber(content, match.index),
      });
    }
  }

  return imports;
}

/**
 * Parse exports from Python content (module-level definitions)
 */
function parsePythonExports(content: string): ExportInfo[] {
  const exports: ExportInfo[] = [];

  // Remove comments
  const cleanContent = content.replace(/#.*$/gm, '');

  let match: RegExpExecArray | null;

  // Check for __all__ definition
  const allMatch = cleanContent.match(/__all__\s*=\s*\[([^\]]+)\]/);
  if (allMatch) {
    const names = allMatch[1].match(/['"](\w+)['"]/g);
    if (names) {
      for (const name of names) {
        const cleanName = name.replace(/['"]/g, '');
        exports.push({
          name: cleanName,
          isDefault: false,
          isType: false,
          isReExport: false,
          kind: 'unknown',
          line: getLineNumber(content, allMatch.index ?? 0),
        });
      }
    }
  }

  // Class definitions at module level (no indentation)
  const classRegex = /^class\s+(\w+)/gm;
  while ((match = classRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: false,
      isType: false,
      isReExport: false,
      kind: 'class',
      line: getLineNumber(content, match.index),
    });
  }

  // Function definitions at module level (no indentation)
  const funcRegex = /^def\s+(\w+)/gm;
  while ((match = funcRegex.exec(cleanContent)) !== null) {
    // Skip private functions
    if (!match[1].startsWith('_')) {
      exports.push({
        name: match[1],
        isDefault: false,
        isType: false,
        isReExport: false,
        kind: 'function',
        line: getLineNumber(content, match.index),
      });
    }
  }

  // Module-level variables (UPPER_CASE constants)
  const constRegex = /^([A-Z][A-Z0-9_]*)\s*=/gm;
  while ((match = constRegex.exec(cleanContent)) !== null) {
    exports.push({
      name: match[1],
      isDefault: false,
      isType: false,
      isReExport: false,
      kind: 'variable',
      line: getLineNumber(content, match.index),
    });
  }

  return exports;
}

// ============================================================================
// JAVA PARSER
// ============================================================================

/** Package prefixes considered JDK/standard-library imports (not project code) */
const JAVA_BUILTIN_PREFIXES = [
  'java.',
  'javax.',
  'jakarta.',
  'sun.',
  'com.sun.',
  'jdk.',
  'org.w3c.',
  'org.xml.',
];

function isJavaBuiltin(source: string): boolean {
  return JAVA_BUILTIN_PREFIXES.some(p => source.startsWith(p));
}

/**
 * Extract the package declaration from Java source content.
 * Returns undefined for files without a package declaration (default package).
 */
export function parseJavaPackage(content: string): string | undefined {
  // Strip block comments so we don't match inside them.
  const clean = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const match = clean.match(/^\s*package\s+([\w.]+)\s*;/m);
  return match ? match[1] : undefined;
}

/**
 * Parse imports from Java source content.
 *
 * Handles:
 *   import com.foo.Bar;
 *   import com.foo.*;                 (wildcard — hasNamespace=true)
 *   import static com.foo.Bar.baz;    (static member import — class is com.foo.Bar)
 *   import static com.foo.Bar.*;      (static wildcard — class is com.foo.Bar)
 */
function parseJavaImports(content: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  // Strip comments to avoid false matches
  const clean = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const importRegex = /^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(clean)) !== null) {
    const isStatic = !!match[1];
    let source = match[2];
    const isWildcard = source.endsWith('.*');

    // For `import static com.foo.Bar.baz;` the member `baz` is not a class —
    // the class we want to link to is `com.foo.Bar`. Strip the trailing
    // lowercase identifier (Java convention: classes start uppercase).
    if (isStatic && !isWildcard) {
      const lastDot = source.lastIndexOf('.');
      if (lastDot > 0) {
        const last = source.slice(lastDot + 1);
        if (/^[a-z_$]/.test(last)) {
          source = source.slice(0, lastDot);
        }
      }
    }

    // For `import static com.foo.Bar.*;` strip the `.*` — we still want to
    // resolve `com.foo.Bar` (the class), not `com.foo` (the package).
    if (isStatic && isWildcard) {
      source = source.slice(0, -2);
    }

    const cleanSource = isWildcard && !isStatic ? source.slice(0, -2) : source;
    const isBuiltin = isJavaBuiltin(cleanSource);
    const displayName = isWildcard && !isStatic
      ? '*'
      : cleanSource.slice(cleanSource.lastIndexOf('.') + 1);

    imports.push({
      source,
      isRelative: false,
      isPackage: !isBuiltin,
      isBuiltin,
      importedNames: [displayName],
      hasDefault: false,
      hasNamespace: isWildcard && !isStatic,
      isTypeOnly: false,
      isDynamic: false,
      line: getLineNumber(content, match.index),
    });
  }

  return imports;
}

/**
 * Parse exports from Java source content.
 *
 * "Exports" in Java are public top-level types: classes, interfaces,
 * enums, records, and annotations. Also includes public static methods
 * and public fields on those types since downstream mapping uses
 * function-level exports to connect requirements to code.
 */
function parseJavaExports(content: string): ExportInfo[] {
  const exports: ExportInfo[] = [];

  const clean = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  let match: RegExpExecArray | null;

  // public class|interface|enum|record|@interface Name
  const typeRegex =
    /\bpublic\s+(?:static\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+)*(class|interface|enum|record|@interface)\s+(\w+)/g;
  while ((match = typeRegex.exec(clean)) !== null) {
    const keyword = match[1];
    const name = match[2];
    const kind: ExportInfo['kind'] =
      keyword === 'interface' || keyword === '@interface' ? 'interface'
      : keyword === 'enum' ? 'enum'
      : 'class';
    exports.push({
      name,
      isDefault: false,
      isType: false,
      isReExport: false,
      kind,
      line: getLineNumber(content, match.index),
    });
  }

  // Public methods: `public [static] [final] ReturnType name(`
  // We keep this conservative: only methods with an explicit `public` modifier.
  // The return-type capture is non-greedy and excludes keywords that start
  // type declarations (class/interface/enum/record) to avoid false matches.
  const methodRegex =
    /\bpublic\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+|default\s+|native\s+)*(?!class\b|interface\b|enum\b|record\b|@interface\b)(?:<[^>]+>\s+)?[\w<>[\], ?.]+?\s+(\w+)\s*\(/g;
  while ((match = methodRegex.exec(clean)) !== null) {
    const name = match[1];
    // Filter obvious non-methods (the regex can match some constructors or
    // edge cases; keep common false-positives out).
    if (['class', 'interface', 'enum', 'record', 'new', 'return', 'if', 'for', 'while'].includes(name)) continue;
    exports.push({
      name,
      isDefault: false,
      isType: false,
      isReExport: false,
      kind: 'function',
      line: getLineNumber(content, match.index),
    });
  }

  return exports;
}

// ============================================================================
// IMPORT RESOLUTION
// ============================================================================

/**
 * Resolve a relative import to an absolute file path
 */
export async function resolveImport(
  importSource: string,
  fromFile: string,
  options: ResolveOptions
): Promise<string | null> {
  const fromExt = extname(fromFile).toLowerCase();
  const isPython = fromExt === '.py' || fromExt === '.pyw';
  const isJava = fromExt === '.java';

  // Java imports are always absolute class FQNs (com.foo.Bar), never relative.
  // Resolve them against the computed source root (dir minus packagePath).
  if (isJava) {
    return resolveJavaImport(importSource, fromFile, options);
  }

  // For non-Python files, external packages can never resolve to a local file.
  // For Python files we must NOT bail out here: `from services.retriever import X`
  // looks like a package import but may well be a local module under rootDir.
  if (!isRelativeImport(importSource) && !isPython) {
    return null;
  }

  const fromDir = dirname(fromFile);

  // Default extensions depend on the source file type
  const extensions = options.extensions ?? (
    isPython
      ? ['.py', '.pyw']
      : ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
  );

  // Python relative imports use dot-prefix notation:
  //   from .utils import foo   → source = ".utils"   → resolve as "./utils"
  //   from ..models import X   → source = "..models"  → resolve as "../models"
  //   from ...pkg import Y     → source = "...pkg"    → resolve as "../../pkg"
  // N dots = (N-1) levels up from fromDir. Also handles dotted paths: .db.models → ./db/models
  let normalizedSource = importSource;
  if (isPython && importSource.startsWith('.')) {
    let dots = 0;
    while (dots < importSource.length && importSource[dots] === '.') dots++;
    const rest = importSource.slice(dots).replace(/\./g, '/');
    // dots=1 → './', dots=2 → '../', dots=3 → '../../', etc.
    const prefix = dots === 1 ? './' : '../'.repeat(dots - 1);
    normalizedSource = rest ? prefix + rest : prefix.replace(/\/$/, '') || '.';
  } else if (isPython && !importSource.startsWith('.')) {
    // Absolute-style intra-project import: "services.retriever" or "services.retriever.utils"
    // Convert dotted module path to a filesystem path relative to rootDir.
    // e.g. "services.retriever" → "<rootDir>/services/retriever.py"
    normalizedSource = './' + importSource.replace(/\./g, '/');
  }

  // For Python absolute imports resolve from rootDir, not fromDir,
  // because Python's module system uses sys.path (typically the project root).
  // Fall back to fromDir if baseDir is empty to avoid resolving against cwd.
  const resolveBase = (isPython && !importSource.startsWith('.'))
    ? (options.baseDir || fromDir)
    : fromDir;

  const basePath = resolve(resolveBase, normalizedSource);

  // Strip any existing extension from the import source.
  // This handles the TypeScript NodeNext convention where imports are written
  // as `./foo.js` but the actual file on disk is `./foo.ts`.
  // Without this, we'd try `foo.js.ts`, `foo.js.tsx`, etc. and find nothing.
  const existingExt = extname(basePath); // e.g. ".js", ".ts", ""
  const baseWithoutExt = existingExt
    ? basePath.slice(0, -existingExt.length)
    : basePath;

  // Build candidate list (order matters: most specific first):
  // 1. Exact path as-is (the import may already point to the real file)
  // 2. Strip the extension, try every known extension (handles .js -> .ts)
  // 3. Directory index files (handles `./components` -> `./components/index.ts`)
  // 4. Python packages: module/__init__.py
  const candidates: string[] = [
    basePath,
    ...extensions.map(ext => baseWithoutExt + ext),
    ...extensions.map(ext => join(basePath, `index${ext}`)),
    ...extensions.map(ext => join(baseWithoutExt, `index${ext}`)),
    ...(isPython ? extensions.map(ext => join(basePath, `__init__${ext}`)) : []),
  ];

  // Deduplicate while preserving order
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Not found, try next
    }
  }

  return null;
}

/**
 * Resolve a Java import (fully-qualified class name) to an absolute file path.
 *
 * Java imports are always absolute: `import com.example.foo.Bar;`
 * To find `com/example/foo/Bar.java`, we compute the "source root" by
 * stripping the file's package path from its directory. E.g. for
 *   /repo/src/main/java/com/example/service/UserService.java
 *   package com.example.service;
 * the source root is /repo/src/main/java.
 *
 * If the package declaration is missing or doesn't match the directory
 * structure, fall back to walking the file's ancestors looking for a
 * conventional source root (src/main/java, src/test/java, src, app).
 */
async function resolveJavaImport(
  importSource: string,
  fromFile: string,
  options: ResolveOptions
): Promise<string | null> {
  if (isJavaBuiltin(importSource)) return null;
  // Wildcard non-static import (`import com.foo.*;`) cannot be resolved to a
  // specific file.
  if (importSource.endsWith('.*')) return null;

  const fromDir = dirname(fromFile);
  const candidateRoots: string[] = [];

  // Primary strategy: strip the package path from fromDir.
  if (options.sourcePackage) {
    const pkgPath = options.sourcePackage.replace(/\./g, '/');
    // Normalize separators for comparison (Windows may have backslashes).
    const normalizedDir = fromDir.replace(/\\/g, '/');
    if (normalizedDir.endsWith('/' + pkgPath)) {
      candidateRoots.push(fromDir.slice(0, fromDir.length - pkgPath.length - 1));
    } else if (normalizedDir === pkgPath || normalizedDir.endsWith(pkgPath)) {
      candidateRoots.push(fromDir.slice(0, fromDir.length - pkgPath.length));
    }
  }

  // Fallback: walk up the directory tree looking for conventional Java source
  // roots. Covers default-package files and inconsistent package declarations.
  const conventional = ['src/main/java', 'src/test/java', 'src/main/kotlin', 'src/test/kotlin', 'src', 'app'];
  for (const marker of conventional) {
    const normalizedFrom = fromFile.replace(/\\/g, '/');
    const idx = normalizedFrom.lastIndexOf('/' + marker + '/');
    if (idx >= 0) {
      candidateRoots.push(fromFile.slice(0, idx + 1 + marker.length));
    }
  }

  // Last resort: baseDir (project root).
  if (options.baseDir) {
    candidateRoots.push(options.baseDir);
  }

  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const relPath = importSource.replace(/\./g, '/') + '.java';
  for (const root of candidateRoots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const candidate = join(root, relPath);
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // try next root
    }
  }

  return null;
}

// ============================================================================
// MAIN PARSER CLASS
// ============================================================================

/**
 * Import/Export Parser
 */
// ============================================================================
// HTML ASSET IMPORTS (decision b555b680)
// ============================================================================

// `<script ... src="…">` — any inline-referenced external script is a file dep.
const HTML_SCRIPT_SRC_RE = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
// `<link …>` — filtered to rel=stylesheet below (rel/href order varies).
const HTML_LINK_RE = /<link\b([^>]*)>/gi;

/**
 * Normalize an HTML asset href into a document-relative import source, or null
 * when it should not produce a dependency edge. Absolute URLs (`http(s)://`,
 * protocol-relative `//`), `data:`/`mailto:`/`tel:`/`javascript:` URIs, `#`
 * anchors, root-absolute `/…` (web-root — out of scope), and empty refs are
 * dropped. Query strings and fragments are stripped, and a bare `app.js` is
 * prefixed `./` so it is treated as relative by isRelativeImport / resolveImport.
 */
function normalizeAssetHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(trimmed)) return null; // http(s):// or //
  if (/^(?:data|mailto|tel|javascript):/i.test(trimmed)) return null;
  if (trimmed.startsWith('#')) return null;
  const clean = trimmed.split(/[?#]/)[0];
  if (!clean) return null;
  if (clean.startsWith('/')) return null; // root-absolute assumes a web root — out of scope
  return clean.startsWith('.') ? clean : './' + clean;
}

function assetImport(source: string, line: number, assetKind: 'script' | 'stylesheet'): ImportInfo {
  return {
    source,
    isRelative: true,
    isPackage: false,
    isBuiltin: false,
    importedNames: [],
    hasDefault: false,
    hasNamespace: false,
    isTypeOnly: false,
    isDynamic: false,
    line,
    assetKind,
  };
}

/**
 * Extract local asset references from an HTML file as ImportInfo entries:
 * `<script src=…>` (script) and `<link rel="stylesheet" href=…>` (stylesheet).
 * External/CDN URLs and non-stylesheet links are excluded. The existing
 * dependency-graph edge machinery resolves these against the document directory.
 */
export function parseHtmlAssetImports(content: string): ImportInfo[] {
  const out: ImportInfo[] = [];
  // Blank out HTML comments so commented-out <script>/<link> tags don't produce
  // phantom edges. Same-length whitespace (newlines kept) preserves line numbers.
  const scan = content.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const lineAt = (idx: number): number => scan.slice(0, idx).split('\n').length;

  HTML_SCRIPT_SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_SCRIPT_SRC_RE.exec(scan)) !== null) {
    const src = normalizeAssetHref(m[1]);
    if (src) out.push(assetImport(src, lineAt(m.index), 'script'));
  }

  HTML_LINK_RE.lastIndex = 0;
  while ((m = HTML_LINK_RE.exec(scan)) !== null) {
    const attrs = m[1];
    // rel attribute anchored on a left boundary (so `data-rel` does not match)
    // and order-independent over multi-token rel (`preload stylesheet`).
    if (!/(?:^|\s)rel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(attrs)) continue;
    const hrefM = /(?:^|\s)href\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!hrefM) continue;
    const href = normalizeAssetHref(hrefM[1]);
    if (href) out.push(assetImport(href, lineAt(m.index), 'stylesheet'));
  }

  return out;
}

export class ImportExportParser {
  private cache: Map<string, FileAnalysis> = new Map();

  /**
   * Clear the parse cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get file extension type
   */
  private getFileType(filePath: string): 'js' | 'ts' | 'python' | 'java' | 'html' | 'unknown' {
    const ext = extname(filePath).toLowerCase();

    if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'ts';
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'js';
    if (['.py', '.pyw'].includes(ext)) return 'python';
    if (ext === '.java') return 'java';
    if (['.html', '.htm'].includes(ext)) return 'html';

    return 'unknown';
  }

  /**
   * Parse a file and extract imports/exports
   */
  async parseFile(filePath: string): Promise<FileAnalysis> {
    // Check cache
    const cached = this.cache.get(filePath);
    if (cached) {
      return cached;
    }

    const analysis: FileAnalysis = {
      filePath,
      imports: [],
      exports: [],
      localImports: [],
      externalImports: [],
      parseErrors: [],
    };

    try {
      const content = await readFile(filePath, 'utf-8');
      const fileType = this.getFileType(filePath);

      if (fileType === 'js' || fileType === 'ts') {
        analysis.imports = parseJSImports(content);
        analysis.exports = parseJSExports(content);
      } else if (fileType === 'python') {
        analysis.imports = parsePythonImports(content);
        analysis.exports = parsePythonExports(content);
      } else if (fileType === 'java') {
        analysis.imports = parseJavaImports(content);
        analysis.exports = parseJavaExports(content);
        analysis.javaPackage = parseJavaPackage(content);
      } else if (fileType === 'html') {
        // HTML asset references (decision b555b680): <script src>, <link stylesheet>.
        analysis.imports = parseHtmlAssetImports(content);
      } else {
        analysis.parseErrors.push(`Unsupported file type: ${extname(filePath)}`);
      }

      // Categorize imports
      for (const imp of analysis.imports) {
        if (imp.isRelative) {
          analysis.localImports.push(imp.source);
        } else if (imp.isPackage) {
          // Extract package name (first part of path)
          const pkgName = imp.source.startsWith('@')
            ? imp.source.split('/').slice(0, 2).join('/')
            : imp.source.split('/')[0];
          if (!analysis.externalImports.includes(pkgName)) {
            analysis.externalImports.push(pkgName);
          }
        }
      }
    } catch (error) {
      analysis.parseErrors.push(`Failed to read file: ${(error as Error).message}`);
    }

    // Cache the result
    this.cache.set(filePath, analysis);

    return analysis;
  }

  /**
   * Parse multiple files
   */
  async parseFiles(filePaths: string[]): Promise<Map<string, FileAnalysis>> {
    const results = new Map<string, FileAnalysis>();

    for (const filePath of filePaths) {
      const analysis = await this.parseFile(filePath);
      results.set(filePath, analysis);
    }

    return results;
  }
}

/**
 * Convenience function to parse a single file
 */
export async function parseFile(filePath: string): Promise<FileAnalysis> {
  const parser = new ImportExportParser();
  return parser.parseFile(filePath);
}

/**
 * Convenience function to parse multiple files
 */
export async function parseFiles(filePaths: string[]): Promise<Map<string, FileAnalysis>> {
  const parser = new ImportExportParser();
  return parser.parseFiles(filePaths);
}
