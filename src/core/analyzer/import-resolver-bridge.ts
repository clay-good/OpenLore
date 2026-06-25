/**
 * ImportResolverBridge — cross-language import resolution for call graph enrichment.
 *
 * Builds a per-file map of { localName → resolvedSourceFilePath } so that Pass 2
 * of CallGraphBuilder.build() can prefer the imported file when multiple candidates
 * share the same function name.
 *
 * TypeScript / JavaScript / Python are handled via import-parser.ts (existing).
 * Go, Rust, Ruby, Java get lightweight regex parsers here.
 */

import { dirname, resolve, posix } from 'node:path';
import type { FileAnalysis } from './import-parser.js';
import { parseJSImports, parsePythonImports } from './import-parser.js';

/** filePath → Map<localName, resolvedSourceFilePath> */
export type ImportMap = Map<string, Map<string, string>>;

/**
 * Build an ImportMap from in-memory file sources, for base-class resolution inside
 * CallGraphBuilder.build() (Pass 7, buildClassNodes). When a class extends a base whose
 * simple name is also declared elsewhere, the import the child actually wrote is the
 * decisive evidence for which declaration is the real base — it must outrank the
 * same-directory / global-unique fallbacks, otherwise a same-named class in the child's
 * own directory is wired as a false base (a precision regression, since CHA's stated bias
 * is false-negatives over false-positives).
 *
 * Unlike {@link buildImportMap} (which absolutizes the source via resolve() and so can
 * never prefix-match the repo-relative filePaths the call graph keys on), this preserves
 * the caller's path style with a posix join+normalize, yielding an extensionless,
 * repo-relative target (e.g. `widgets/sphere.ts` importing `../shapes/base` → `shapes/base`)
 * that prefix-matches the class node's `shapes/base.ts`.
 *
 * Scope: relative TS/JS/Python imports — the languages with a content-level import parser.
 * Non-relative (package) imports and other languages are skipped; resolution then falls
 * through to the same-directory / global-unique layers exactly as before (additive — this
 * can only recover a correct base, never introduce a new wrong one).
 */
/**
 * Languages whose relative imports {@link buildBaseImportMap} actually resolves into the
 * `confidence: 'import'` edge path (the live import-resolution pipeline). Authoritative
 * source for the `imports` capability flag in the declarative language-support registry
 * (change: add-declarative-language-support-registry). MUST match the dispatch in
 * {@link buildBaseImportMap} below. (Go/Rust/Ruby/Java parsers exist elsewhere but are not
 * wired into this live path, so the registry does not claim `imports` for them — honesty
 * over latent capability.)
 */
export const IMPORT_RESOLUTION_LANGUAGES: ReadonlySet<string> = new Set<string>([
  'TypeScript', 'JavaScript', 'Python',
]);

export function buildBaseImportMap(
  files: Array<{ path: string; content: string; language: string }>,
): ImportMap {
  const map: ImportMap = new Map();
  for (const f of files) {
    let imports;
    if (f.language === 'TypeScript' || f.language === 'JavaScript') {
      imports = parseJSImports(f.content);
    } else if (f.language === 'Python') {
      imports = parsePythonImports(f.content);
    } else {
      continue;
    }
    const fileMap = new Map<string, string>();
    const dir = posix.dirname(f.path);
    for (const imp of imports) {
      if (!imp.isRelative) continue;
      const target = posix.normalize(posix.join(dir, imp.source));
      for (const name of imp.importedNames) fileMap.set(name, target);
    }
    if (fileMap.size > 0) map.set(f.path, fileMap);
  }
  return map;
}

/** Build an ImportMap from TS/JS/Python FileAnalysis objects (from import-parser). */
export function buildImportMap(analyses: FileAnalysis[]): ImportMap {
  const map: ImportMap = new Map();
  for (const analysis of analyses) {
    const fileMap = new Map<string, string>();
    const dir = dirname(analysis.filePath);
    for (const imp of analysis.imports) {
      if (!imp.isRelative) continue;
      const resolvedSource = resolve(dir, imp.source);
      for (const name of imp.importedNames) {
        fileMap.set(name, resolvedSource);
      }
    }
    if (fileMap.size > 0) map.set(analysis.filePath, fileMap);
  }
  return map;
}

/**
 * Given a caller file and a callee name, return the source file the name was
 * imported from (if known), or undefined.
 */
export function findCalleeFileViaImport(
  importMap: ImportMap,
  callerFilePath: string,
  calleeName: string,
): string | undefined {
  return importMap.get(callerFilePath)?.get(calleeName);
}

// ---------------------------------------------------------------------------
// Language-specific import parsers (Go, Rust, Ruby, Java)
// ---------------------------------------------------------------------------

export function parseGoImports(
  filePath: string,
  content: string,
  allFilePaths: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  const dir = dirname(filePath);

  // Single import: import "path/to/pkg"  or  import alias "path/to/pkg"
  for (const m of content.matchAll(/import\s+(?:(\w+)\s+)?"([^"]+)"/g)) {
    const importPath = m[2];
    if (!importPath.startsWith('.')) continue;
    const resolved = resolve(dir, importPath);
    const match = allFilePaths.find(f => f.startsWith(resolved));
    if (match) result.set(m[1] ?? importPath.split('/').pop()!, resolved);
  }

  // Grouped import block: import ( ... )
  for (const group of content.matchAll(/import\s+\(\s*([\s\S]*?)\s*\)/g)) {
    for (const line of group[1].split('\n')) {
      const m = line.trim().match(/^(?:(\w+)\s+)?"([^"]+)"/);
      if (!m || !m[2].startsWith('.')) continue;
      const resolved = resolve(dir, m[2]);
      result.set(m[1] ?? m[2].split('/').pop()!, resolved);
    }
  }

  return result;
}

export function parseRustImports(
  _filePath: string,
  content: string,
  allFilePaths: string[],
): Map<string, string> {
  const result = new Map<string, string>();

  // use crate::module::TypeName;  or  use super::foo::Bar;
  for (const m of content.matchAll(/use\s+((?:crate|super|self)(?:::\w+)+);/g)) {
    const parts = m[1].split('::');
    const typeName = parts[parts.length - 1];
    const modulePath = parts.slice(1, -1).join('/');
    const candidate = allFilePaths.find(f =>
      f.endsWith(`/${modulePath}.rs`) || f.endsWith(`/${modulePath}/mod.rs`),
    );
    if (candidate) result.set(typeName, candidate);
  }

  return result;
}

export function parseRubyImports(
  filePath: string,
  content: string,
  allFilePaths: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  const dir = dirname(filePath);

  for (const m of content.matchAll(/require_relative\s+['"]([^'"]+)['"]/g)) {
    const resolved = resolve(dir, m[1]);
    const candidate = allFilePaths.find(f => f === resolved || f === `${resolved}.rb`);
    if (candidate) result.set(m[1].split('/').pop()!.replace(/\.rb$/, ''), candidate);
  }

  return result;
}

export function parseJavaImports(
  content: string,
  allFilePaths: string[],
): Map<string, string> {
  const result = new Map<string, string>();

  for (const m of content.matchAll(/^import\s+(?:static\s+)?[\w.]+\.(\w+);/gm)) {
    const candidate = allFilePaths.find(f => f.endsWith(`/${m[1]}.java`));
    if (candidate) result.set(m[1], candidate);
  }

  return result;
}
