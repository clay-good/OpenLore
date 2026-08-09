/**
 * ImportResolverBridge — cross-language import resolution for call graph enrichment.
 *
 * Builds a per-file map of { localName → resolvedSourceFilePath } so that Pass 2
 * of CallGraphBuilder.build() can prefer the imported file when multiple candidates
 * share the same function name.
 *
 * TypeScript / JavaScript / Python are handled via import-parser.ts (existing).
 * Go, Java, Kotlin, C#, and PHP use lightweight declaration/import indexes here.
 */

import { dirname, resolve, posix } from 'node:path';
import type { FileAnalysis, ExportInfo } from './import-parser.js';
import { parseJSImports, parsePythonImports, parseJSExports } from './import-parser.js';

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
 * Scope: relative TS/JS/Python imports plus the statically bindable package/namespace forms
 * registered below. Unresolved imports fall through to the existing ladder unchanged.
 */
/**
 * Languages whose import or package facts {@link buildBaseImportMap} actually resolves into the
 * `confidence: 'import'` edge path (the live import-resolution pipeline). Authoritative
 * source for the `imports` capability flag in the declarative language-support registry
 * (change: add-declarative-language-support-registry). MUST match the dispatch in
 * {@link buildBaseImportMap} below. Ruby remains outside this set because its load forms do
 * not statically bind names.
 */
export const IMPORT_RESOLUTION_LANGUAGES: ReadonlySet<string> = new Set<string>([
  'TypeScript', 'JavaScript', 'Python', 'Go', 'Java', 'Kotlin', 'C#', 'PHP',
]);

/** Reserved map entry for a caller's own package directory (used by bare Go calls). */
export const PACKAGE_SCOPE_IMPORT = '\0package';

type TargetIndex = Map<string, Set<string>>;

function addTarget(index: TargetIndex, name: string, path: string): void {
  const targets = index.get(name) ?? new Set<string>();
  targets.add(path);
  index.set(name, targets);
}

function uniqueTarget(index: TargetIndex, name: string): string | undefined {
  const targets = index.get(name);
  return targets?.size === 1 ? targets.values().next().value : undefined;
}

function declaredNamespace(content: string, language: string): string | undefined {
  if (language === 'PHP') {
    return content.match(/^\s*namespace\s+([\\\w]+)\s*;/m)?.[1].replaceAll('\\', '.');
  }
  if (language === 'C#') return content.match(/^\s*namespace\s+([\w.]+)\s*[;{]/m)?.[1];
  return content.match(/^\s*package\s+([\w.]+)\s*;?/m)?.[1];
}

function declaredTypes(content: string): string[] {
  return [...content.matchAll(/\b(?:class|interface|enum|record|object|trait)\s+([A-Za-z_]\w*)/g)]
    .map(m => m[1]);
}

function resolveImportedFqn(index: TargetIndex, fqn: string, memberImport = false): string | undefined {
  const exact = uniqueTarget(index, fqn);
  if (exact || !memberImport || !fqn.includes('.')) return exact;
  return uniqueTarget(index, fqn.slice(0, fqn.lastIndexOf('.')));
}

function goImportSpecs(content: string): Array<{ alias: string; source: string }> {
  const specs: Array<{ alias: string; source: string }> = [];
  const add = (alias: string | undefined, source: string): void => {
    const local = alias ?? source.split('/').pop()!;
    if (local !== '_' && local !== '.') specs.push({ alias: local, source });
  };
  for (const m of content.matchAll(/^\s*import\s+(?:(\w+)\s+)?"([^"]+)"/gm)) add(m[1], m[2]);
  for (const block of content.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) {
    for (const m of block[1].matchAll(/^\s*(?:(\w+)\s+)?"([^"]+)"/gm)) add(m[1], m[2]);
  }
  return specs;
}

/** Build import/package bindings (change: widen-import-resolution). */
function buildStaticLanguageImportMaps(
  files: Array<{ path: string; content: string; language: string }>,
): ImportMap {
  const map: ImportMap = new Map();
  const allFilePaths = files.map(file => file.path);

  const goPackages = new Map<string, Set<string>>();
  for (const f of files.filter(f => f.language === 'Go')) {
    const pkg = f.content.match(/^\s*package\s+([A-Za-z_]\w*)\b/m)?.[1];
    if (!pkg) continue;
    const dirs = goPackages.get(pkg) ?? new Set<string>();
    dirs.add(posix.dirname(f.path));
    goPackages.set(pkg, dirs);
  }
  for (const f of files.filter(f => f.language === 'Go')) {
    const fileMap = new Map<string, string>();
    const ownPackage = f.content.match(/^\s*package\s+([A-Za-z_]\w*)\b/m)?.[1];
    const ownDir = posix.dirname(f.path);
    if (ownPackage && goPackages.get(ownPackage)?.has(ownDir)) {
      fileMap.set(PACKAGE_SCOPE_IMPORT, ownDir);
    }
    for (const [alias, target] of parseGoImports(f.path, f.content, allFilePaths)) {
      fileMap.set(alias, target);
    }
    for (const spec of goImportSpecs(f.content)) {
      const candidates = [...goPackages.values()].flatMap(dirs => [...dirs]).filter(dir =>
        spec.source === dir || spec.source.endsWith(`/${dir}`) || dir.endsWith(`/${spec.source}`),
      );
      if (candidates.length === 1) fileMap.set(spec.alias, candidates[0]);
    }
    if (fileMap.size > 0) map.set(f.path, fileMap);
  }

  const fqnIndex: TargetIndex = new Map();
  const namespaceTypes = new Map<string, Map<string, Set<string>>>();
  for (const f of files) {
    if (!['Java', 'Kotlin', 'C#', 'PHP'].includes(f.language)) continue;
    const namespace = declaredNamespace(f.content, f.language);
    if (!namespace) continue;
    const symbols = declaredTypes(f.content);
    if (f.language === 'Kotlin') {
      for (const m of f.content.matchAll(/^\s*fun\s+([A-Za-z_]\w*)\s*\(/gm)) symbols.push(m[1]);
    }
    const byName = namespaceTypes.get(namespace) ?? new Map<string, Set<string>>();
    for (const symbol of symbols) {
      addTarget(fqnIndex, `${namespace}.${symbol}`, f.path);
      const targets = byName.get(symbol) ?? new Set<string>();
      targets.add(f.path);
      byName.set(symbol, targets);
    }
    namespaceTypes.set(namespace, byName);
  }

  for (const f of files) {
    if (!['Java', 'Kotlin', 'C#', 'PHP'].includes(f.language)) continue;
    const fileMap = new Map<string, string>();
    const conflicting = new Set<string>();
    const bind = (name: string, target: string): void => {
      if (conflicting.has(name)) return;
      const existing = fileMap.get(name);
      if (existing && existing !== target) {
        fileMap.delete(name);
        conflicting.add(name);
      } else {
        fileMap.set(name, target);
      }
    };
    const ownNamespace = declaredNamespace(f.content, f.language);
    if (ownNamespace) {
      for (const [name, targets] of namespaceTypes.get(ownNamespace) ?? []) {
        if (targets.size === 1) bind(name, targets.values().next().value!);
      }
    }

    if (f.language === 'Java' || f.language === 'Kotlin') {
      for (const m of f.content.matchAll(/^\s*import\s+(?:(static)\s+)?([\w.]+)(?:\s+as\s+(\w+))?\s*;?/gm)) {
        const fqn = m[2];
        const local = m[3] ?? fqn.split('.').pop()!;
        const target = resolveImportedFqn(fqnIndex, fqn, m[1] === 'static');
        if (target) bind(local, target);
      }
    } else if (f.language === 'C#') {
      for (const m of f.content.matchAll(/^\s*using\s+(?:(\w+)\s*=\s*)?([\w.]+)\s*;/gm)) {
        const alias = m[1];
        const imported = m[2];
        const direct = resolveImportedFqn(fqnIndex, imported);
        if (alias && direct) bind(alias, direct);
        if (!alias) {
          for (const [name, targets] of namespaceTypes.get(imported) ?? []) {
            if (targets.size === 1) bind(name, targets.values().next().value!);
          }
          if (direct) bind(imported.split('.').pop()!, direct);
        }
      }
    } else {
      for (const m of f.content.matchAll(/^\s*use\s+(?:function\s+)?([\\\w]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
        const fqn = m[1].replaceAll('\\', '.');
        const local = m[2] ?? fqn.split('.').pop()!;
        const target = resolveImportedFqn(fqnIndex, fqn);
        if (target) bind(local, target);
      }
    }
    if (fileMap.size > 0) map.set(f.path, fileMap);
  }

  // Ruby intentionally remains name-only: require/autoload/open classes load files but do not
  // statically bind names, so treating them as a name map would guess at runtime behavior.
  return map;
}

export function buildBaseImportMap(
  files: Array<{ path: string; content: string; language: string }>,
): ImportMap {
  const map: ImportMap = buildStaticLanguageImportMaps(files);
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

// ---------------------------------------------------------------------------
// Re-export (barrel) resolution — change: add-call-resolution-recall
// ---------------------------------------------------------------------------

/** Extensionless form of a repo-relative path (the key the call graph resolves on). */
function stripModuleExt(p: string): string {
  return p.replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, '');
}

/** Maximum re-export chain depth followed before giving up (cycle/runaway guard). */
const REEXPORT_MAX_DEPTH = 12;

/**
 * Resolve a Python leading-dot relative import to an extensionless, repo-relative
 * module path. `from .impl import x` in `pkg/caller.py` → `pkg/impl`;
 * `from ..util.mod import y` in `pkg/sub/caller.py` → `pkg/util/mod`;
 * `from . import x` → the caller's package directory. N leading dots = N package
 * levels (1 = the current package), the remainder is a dotted module path.
 */
export function resolvePythonRelative(callerDir: string, source: string): string {
  const m = source.match(/^(\.+)(.*)$/);
  if (!m) return source;
  const levels = m[1].length;
  let base = callerDir;
  for (let i = 1; i < levels; i++) base = posix.dirname(base);
  const rest = m[2].replace(/\./g, '/');
  return rest ? posix.normalize(posix.join(base, rest)) : (base || '.');
}

/**
 * A re-export-aware import map: like {@link buildBaseImportMap}, but a `localName`
 * imported from a barrel that re-exports it (`export { x } from './impl'`,
 * `export * from './impl'`, depth-N chains) resolves to the **true definition
 * module**, not the barrel — so a call through any depth of barrel resolves to the
 * real target instead of stalling at the index and falling through to the
 * ambiguous name-only fallback (change: add-call-resolution-recall, item 1).
 *
 * `reExported` records every `${callerFile}\0${localName}` whose resolution crossed
 * ≥1 re-export hop, so the call-graph builder can label that edge with the
 * `re_export` provenance confidence (honesty: a barrel-crossed edge is still a
 * proven concrete target, but the consumer can see it was resolved through a
 * re-export rather than a direct import).
 *
 * Strict superset of {@link buildBaseImportMap}: when no re-export chain applies
 * (the common case), the resolved module is byte-identical to the direct import
 * target, so non-barrel behaviour — and the regression gate over directly-resolved
 * edges — is preserved exactly. Re-export *chasing* is TypeScript/JavaScript only
 * (the languages with an export parser that detects re-exports); Python relative
 * imports still resolve directly (no `__init__` re-export chasing — deferred).
 */
export interface ResolvedImportMap {
  map: ImportMap;
  reExported: Set<string>;
}

interface ModuleExports {
  /** Directory of the backing file (re-export sources resolve relative to this). */
  dir: string;
  exports: ExportInfo[];
}

export function buildResolvedImportMap(
  files: Array<{ path: string; content: string; language: string }>,
): ResolvedImportMap {
  // Index TS/JS module exports, keyed by extensionless repo-relative module path.
  // An `index` file is additionally keyed by its directory so `import … from './pkg'`
  // (which targets `pkg/index.ts`) finds it.
  const moduleExports = new Map<string, ModuleExports>();
  for (const f of files) {
    if (f.language !== 'TypeScript' && f.language !== 'JavaScript') continue;
    const exports = parseJSExports(f.content);
    if (exports.length === 0) continue;
    const dir = posix.dirname(f.path);
    const rec: ModuleExports = { dir, exports };
    moduleExports.set(stripModuleExt(f.path), rec);
    const base = f.path.split('/').pop() ?? '';
    if (/^index\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(base)) moduleExports.set(dir, rec);
  }

  /**
   * Resolve `name` exported by `moduleKey` to the module that truly defines it,
   * following re-export chains. Returns the resolved module (extensionless,
   * repo-relative) and whether any hop was a re-export. Cycle-/depth-bounded.
   */
  function resolveDef(
    name: string,
    moduleKey: string,
    visited: Set<string>,
    depth: number,
  ): { module: string; viaReExport: boolean } {
    const here = `${moduleKey}\0${name}`;
    // Default: the module itself (matches buildBaseImportMap; never worse).
    if (depth > REEXPORT_MAX_DEPTH || visited.has(here)) return { module: moduleKey, viaReExport: false };
    visited.add(here);
    const rec = moduleExports.get(moduleKey);
    if (!rec) return { module: moduleKey, viaReExport: false };

    // A direct (non-re-export) export of the name → defined here.
    if (rec.exports.some(e => !e.isReExport && e.name === name)) {
      return { module: moduleKey, viaReExport: false };
    }
    // A named re-export `export { name } from './src'` → follow it.
    const named = rec.exports.find(e => e.isReExport && e.name === name && e.reExportSource);
    if (named?.reExportSource) {
      const src = stripModuleExt(posix.normalize(posix.join(rec.dir, named.reExportSource)));
      const r = resolveDef(name, src, visited, depth + 1);
      return { module: r.module, viaReExport: true };
    }
    // `export * from './src'` — the name may live in any star source.
    for (const star of rec.exports) {
      if (!star.isReExport || star.name !== '*' || !star.reExportSource) continue;
      const src = stripModuleExt(posix.normalize(posix.join(rec.dir, star.reExportSource)));
      const target = moduleExports.get(src);
      // Only descend a star source that actually surfaces the name (directly or via
      // its own re-export) — never blindly retarget through an unrelated barrel.
      if (target && starExposes(name, src, new Set(visited), depth + 1)) {
        const r = resolveDef(name, src, visited, depth + 1);
        return { module: r.module, viaReExport: true };
      }
    }
    // Name not surfaced by a parsed export (e.g. re-export-after-import, or an
    // unparsed form) — fall back to the module itself, exactly as before.
    return { module: moduleKey, viaReExport: false };
  }

  /** Whether `name` is reachable as an export of `moduleKey` (direct or via re-export). */
  function starExposes(name: string, moduleKey: string, visited: Set<string>, depth: number): boolean {
    const here = `${moduleKey}\0${name}`;
    if (depth > REEXPORT_MAX_DEPTH || visited.has(here)) return false;
    visited.add(here);
    const rec = moduleExports.get(moduleKey);
    if (!rec) return false;
    if (rec.exports.some(e => e.name === name && (!e.isReExport || e.reExportSource))) {
      // A direct export, or a named re-export of this exact name.
      if (rec.exports.some(e => !e.isReExport && e.name === name)) return true;
      if (rec.exports.some(e => e.isReExport && e.name === name && e.reExportSource)) return true;
    }
    for (const star of rec.exports) {
      if (!star.isReExport || star.name !== '*' || !star.reExportSource) continue;
      const src = stripModuleExt(posix.normalize(posix.join(rec.dir, star.reExportSource)));
      if (starExposes(name, src, visited, depth + 1)) return true;
    }
    return false;
  }

  const map: ImportMap = buildStaticLanguageImportMaps(files);
  const reExported = new Set<string>();
  for (const f of files) {
    let imports;
    const tsjs = f.language === 'TypeScript' || f.language === 'JavaScript';
    if (tsjs) imports = parseJSImports(f.content);
    else if (f.language === 'Python') imports = parsePythonImports(f.content);
    else continue;

    const fileMap = new Map<string, string>();
    const dir = posix.dirname(f.path);
    for (const imp of imports) {
      if (!imp.isRelative) continue;
      // Python relative imports use leading-dot module syntax (`from .impl import x`,
      // `from ..pkg.mod import y`) — N dots = package levels up (1 = current), the rest
      // is a dotted path. posix.join would treat `.impl` as a filename, so resolve the
      // dot-prefix explicitly. TS/JS use `./`-style specifiers (and ESM `.js` that points
      // at the `.ts` source — strip it so the target matches the node filePaths).
      const target =
        f.language === 'Python' && imp.source.startsWith('.')
          ? resolvePythonRelative(dir, imp.source)
          : stripModuleExt(posix.normalize(posix.join(dir, imp.source)));
      for (const name of imp.importedNames) {
        if (tsjs && moduleExports.size > 0) {
          const r = resolveDef(name, target, new Set(), 0);
          fileMap.set(name, r.module);
          if (r.viaReExport) reExported.add(`${f.path}\0${name}`);
        } else {
          fileMap.set(name, target);
        }
      }
    }
    if (fileMap.size > 0) map.set(f.path, fileMap);
  }
  return { map, reExported };
}

/** A module's on-disk identity + source, as resolved from a relative specifier. */
export interface ResolvedModuleSource {
  path: string;
  content: string;
  language: string;
}

/**
 * Collect the re-export **barrel** files reachable from `seeds` by following their
 * relative imports and re-export sources, so an INCREMENTAL build over a file subset
 * can resolve barrel-imported calls the same way a full build does
 * (change: add-call-resolution-recall). An incremental subset is `{ changed file +
 * its callers }`; a barrel an index re-exports through is neither, so without this it
 * is absent and `buildResolvedImportMap` cannot follow the chain — the call silently
 * degrades from `re_export`/`import` to `name_only`, breaking incremental↔full parity.
 *
 * Only files that *themselves re-export* are returned: a leaf definition file at a
 * chain's end is not needed (resolveDef returns its module from the chain without its
 * content, and the call-graph trie resolves the node). `readModule(spec, fromFile)`
 * resolves a relative specifier to a module source, or undefined when it is a package
 * or cannot be read. Bounded by re-export depth and a file cap (fail-soft: beyond the
 * cap, those edges degrade rather than the build hanging).
 */
export async function collectReExportBarrels(
  seeds: Array<{ path: string; content: string; language: string }>,
  readModule: (spec: string, fromFile: string) => Promise<ResolvedModuleSource | undefined>,
  options?: { maxFiles?: number },
): Promise<ResolvedModuleSource[]> {
  const maxFiles = options?.maxFiles ?? 2000;
  const have = new Set(seeds.map(s => s.path));
  const barrels = new Map<string, ResolvedModuleSource>();
  let frontier = seeds
    .filter(s => s.language === 'TypeScript' || s.language === 'JavaScript')
    .map(s => ({ path: s.path, content: s.content }));
  let depth = 0;
  while (frontier.length > 0 && depth <= REEXPORT_MAX_DEPTH && barrels.size < maxFiles) {
    const next: Array<{ path: string; content: string }> = [];
    for (const f of frontier) {
      // A barrel chain advances along BOTH a plain import (caller → barrel) and a
      // re-export source (barrel → barrel/leaf); gather relative specifiers from both.
      const specs = new Set<string>();
      for (const imp of parseJSImports(f.content)) if (imp.isRelative) specs.add(imp.source);
      for (const ex of parseJSExports(f.content)) if (ex.isReExport && ex.reExportSource) specs.add(ex.reExportSource);
      for (const spec of specs) {
        if (barrels.size >= maxFiles) break;
        const mod = await readModule(spec, f.path);
        if (!mod || have.has(mod.path) || barrels.has(mod.path)) continue;
        // Only a file that itself re-exports is a barrel worth materialising.
        if (!parseJSExports(mod.content).some(e => e.isReExport)) continue;
        barrels.set(mod.path, mod);
        next.push({ path: mod.path, content: mod.content });
      }
    }
    frontier = next;
    depth++;
  }
  return [...barrels.values()];
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
  const dir = posix.dirname(filePath);
  for (const spec of goImportSpecs(content)) {
    if (!spec.source.startsWith('.')) continue;
    const target = posix.normalize(posix.join(dir, spec.source));
    const matches = allFilePaths.filter(path => posix.dirname(path) === target);
    if (matches.length > 0) result.set(spec.alias, target);
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
