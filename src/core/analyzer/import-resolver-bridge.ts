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
export const PACKAGE_SCOPE_NAME = '\0package-name';
export const GO_IMPORT_PACKAGE_PREFIX = '\0go-package:';

/** Reserved metadata entry mapping a source-level qualifier to its declared type name. */
export const IMPORT_QUALIFIER_PREFIX = '\0qualifier:';

/**
 * Key prefix marking a name the file imports from a specifier this map could NOT resolve to an
 * in-project file — a package, or a path alias (change: shrink-receiver-resolution-boundary).
 *
 * The source STATES where that name comes from, and it is not here. Without this, a consumer that
 * only checks "did the map bind it?" cannot tell "not imported at all" from "imported from
 * somewhere I cannot see", and binds `import { Client } from 'pg'` to an in-project class that
 * happens to share the name and the method. `\0`-prefixed like the other reserved keys, so it can
 * never collide with a real identifier.
 */
export const EXTERNAL_IMPORT_PREFIX = '\0external:';
export const IMPORT_TOP_LEVEL_QUALIFIER = '\0top-level';

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

function sanitizeForRegex(
  content: string,
  preserveStrings: boolean,
  nestedBlockComments = false,
): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'string' = 'code';
  let quote = '';
  let preserveCurrentString = false;
  let blockDepth = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += '\n'; } else out += ' ';
    } else if (state === 'block') {
      if (nestedBlockComments && ch === '/' && next === '*') {
        out += '  '; i++; blockDepth++;
      }
      else if (ch === '*' && next === '/') {
        out += '  '; i++; blockDepth--;
        if (blockDepth === 0) state = 'code';
      }
      else out += ch === '\n' ? '\n' : ' ';
    } else if (state === 'string') {
      if (ch === '\\' && quote !== '`' && next) {
        out += preserveCurrentString ? ch + next : '  ';
        i++;
      } else if (ch === quote) {
        out += preserveCurrentString ? ch : ' ';
        state = 'code';
      } else {
        out += preserveCurrentString || ch === '\n' ? ch : ' ';
      }
    } else if (ch === '/' && next === '/') {
      out += '  '; i++; state = 'line';
    } else if (ch === '/' && next === '*') {
      out += '  '; i++; state = 'block'; blockDepth = 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      preserveCurrentString = preserveStrings && ch === '"';
      state = 'string';
      out += preserveCurrentString ? ch : ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

function declaredNamespace(content: string, language: string): string | undefined {
  const code = sanitizeForRegex(content, false, language === 'Kotlin');
  if (language === 'PHP') {
    return code.match(/^\s*namespace\s+([\\\w]+)\s*[;{]/m)?.[1].replaceAll('\\', '.');
  }
  if (language === 'C#') return code.match(/^\s*namespace\s+([\w.]+)\s*[;{]/m)?.[1];
  return code.match(/^\s*package\s+([\w.]+)\s*;?/m)?.[1];
}

function declaredTypes(content: string, language: string): string[] {
  const keywords = language === 'Kotlin'
    ? 'class|interface|enum|object'
    : language === 'PHP'
      ? 'class|interface|enum|trait'
      : language === 'C#'
        ? 'class|interface|enum|record|struct'
        : 'class|interface|enum|record';
  return [...sanitizeForRegex(content, false, language === 'Kotlin').matchAll(
    new RegExp(`\\b(?:${keywords})\\s+([A-Za-z_]\\w*)`, 'g'),
  )]
    .map(m => m[1]);
}

function declaredTopLevelFunctions(content: string): string[] {
  const code = sanitizeForRegex(content, false);
  const functions: string[] = [];
  const scopes: boolean[] = [];
  let pendingType = false;
  for (const match of code.matchAll(/\b(class|interface|trait|enum)\s+[A-Za-z_]\w*|\bfunction\s+([A-Za-z_]\w*)|[{}]/g)) {
    const token = match[0];
    if (/^(?:class|interface|trait|enum)\b/.test(token)) pendingType = true;
    else if (token === '{') { scopes.push(pendingType); pendingType = false; }
    else if (token === '}') scopes.pop();
    else if (match[2] && !scopes.includes(true)) functions.push(match[2]);
  }
  return functions;
}

function resolveImportedFqn(index: TargetIndex, fqn: string, memberImport = false): string | undefined {
  const exact = uniqueTarget(index, fqn);
  if (exact || !memberImport || !fqn.includes('.')) return exact;
  return uniqueTarget(index, fqn.slice(0, fqn.lastIndexOf('.')));
}

interface GoImportSpec { alias?: string; source: string }

function goImportSpecs(content: string): GoImportSpec[] {
  const specs: GoImportSpec[] = [];
  const code = sanitizeForRegex(content, true);
  let inBlock = false;
  const add = (text: string): void => {
    const m = text.match(/^\s*(?:([A-Za-z_]\w*|[._])\s+)?"([^"]+)"/);
    if (!m || m[1] === '_' || m[1] === '.') return;
    specs.push({ alias: m[1], source: m[2] });
  };
  for (const line of code.split('\n')) {
    if (!inBlock) {
      const single = line.match(/^\s*import\s+(?!\()(.+)$/);
      if (single) add(single[1]);
      const open = line.match(/^\s*import\s*\((.*)$/);
      if (open) {
        inBlock = true;
        const close = open[1].indexOf(')');
        add(close >= 0 ? open[1].slice(0, close) : open[1]);
        if (close >= 0) inBlock = false;
      }
    } else {
      const close = line.indexOf(')');
      add(close >= 0 ? line.slice(0, close) : line);
      if (close >= 0) inBlock = false;
    }
  }
  return specs;
}

/** Build import/package bindings (change: widen-import-resolution). */
function buildStaticLanguageImportMaps(
  files: Array<{ path: string; content: string; language: string }>,
): ImportMap {
  const map: ImportMap = new Map();
  const allFilePaths = files.map(file => file.path);

  const goPackageSetsByDir = new Map<string, Set<string>>();
  const goFileDirs = new Set<string>();
  for (const f of files.filter(f => f.language === 'Go')) {
    const dir = posix.dirname(f.path);
    goFileDirs.add(dir);
    const pkg = sanitizeForRegex(f.content, false).match(/^\s*package\s+([A-Za-z_]\w*)\b/m)?.[1];
    if (!pkg) continue;
    const packages = goPackageSetsByDir.get(dir) ?? new Set<string>();
    packages.add(pkg);
    goPackageSetsByDir.set(dir, packages);
  }
  const goPackageByDir = new Map(
    [...goPackageSetsByDir].flatMap(([dir, packages]) => {
      const production = [...packages].filter(pkg => !pkg.endsWith('_test'));
      const selected = packages.size === 1
        ? packages.values().next().value!
        : production.length === 1 && [...packages].every(
          pkg => pkg === production[0] || pkg === `${production[0]}_test`,
        )
          ? production[0]
          : undefined;
      return selected ? [[dir, selected] as const] : [];
    }),
  );
  const goDirsBySuffix = new Map<string, Set<string>>();
  for (const dir of goFileDirs) {
    const parts = dir.split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      const dirs = goDirsBySuffix.get(suffix) ?? new Set<string>();
      dirs.add(dir);
      goDirsBySuffix.set(suffix, dirs);
    }
  }
  for (const f of files.filter(f => f.language === 'Go')) {
    const fileMap = new Map<string, string>();
    const ownDir = posix.dirname(f.path);
    const ownPackage = sanitizeForRegex(f.content, false).match(
      /^\s*package\s+([A-Za-z_]\w*)\b/m,
    )?.[1];
    if (ownPackage) {
      fileMap.set(PACKAGE_SCOPE_IMPORT, ownDir);
      fileMap.set(PACKAGE_SCOPE_NAME, ownPackage);
    }
    for (const [alias, target] of parseGoImports(f.path, f.content, allFilePaths, {
      fileDirs: goFileDirs,
      dirsBySuffix: goDirsBySuffix,
      packageByDir: goPackageByDir,
    })) {
      fileMap.set(alias, target);
      const importedPackage = goPackageByDir.get(target);
      if (importedPackage) fileMap.set(`${GO_IMPORT_PACKAGE_PREFIX}${alias}`, importedPackage);
    }
    if (fileMap.size > 0) map.set(f.path, fileMap);
  }

  const ecosystemFor = (language: string): string =>
    language === 'Java' || language === 'Kotlin' ? 'JVM' : language;
  const fqnIndexes = new Map<string, TargetIndex>();
  const namespaceTypesByEcosystem = new Map<string, Map<string, Map<string, Set<string>>>>();
  for (const f of files) {
    if (!['Java', 'Kotlin', 'C#', 'PHP'].includes(f.language)) continue;
    const namespace = declaredNamespace(f.content, f.language);
    if (!namespace) continue;
    const ecosystem = ecosystemFor(f.language);
    const fqnIndex = fqnIndexes.get(ecosystem) ?? new Map<string, Set<string>>();
    const namespaceTypes = namespaceTypesByEcosystem.get(ecosystem) ?? new Map();
    const symbols = declaredTypes(f.content, f.language);
    if (f.language === 'Kotlin') {
      for (const m of sanitizeForRegex(f.content, false, true).matchAll(/^\s*fun\s+([A-Za-z_]\w*)\s*\(/gm)) symbols.push(m[1]);
    } else if (f.language === 'PHP') {
      symbols.push(...declaredTopLevelFunctions(f.content));
    }
    const byName = namespaceTypes.get(namespace) ?? new Map<string, Set<string>>();
    for (const symbol of symbols) {
      addTarget(fqnIndex, `${namespace}.${symbol}`, f.path);
      const targets = byName.get(symbol) ?? new Set<string>();
      targets.add(f.path);
      byName.set(symbol, targets);
    }
    namespaceTypes.set(namespace, byName);
    fqnIndexes.set(ecosystem, fqnIndex);
    namespaceTypesByEcosystem.set(ecosystem, namespaceTypes);
  }

  for (const f of files) {
    if (!['Java', 'Kotlin', 'C#', 'PHP'].includes(f.language)) continue;
    const ecosystem = ecosystemFor(f.language);
    const fqnIndex = fqnIndexes.get(ecosystem) ?? new Map();
    const namespaceTypes = namespaceTypesByEcosystem.get(ecosystem) ?? new Map();
    const code = sanitizeForRegex(f.content, false, f.language === 'Kotlin');
    const fileMap = new Map<string, string>();
    const conflicting = new Set<string>();
    const bind = (name: string, target: string, declaredQualifier?: string): void => {
      if (conflicting.has(name)) return;
      const existing = fileMap.get(name);
      if (existing && existing !== target) {
        fileMap.delete(name);
        fileMap.delete(`${IMPORT_QUALIFIER_PREFIX}${name}`);
        conflicting.add(name);
      } else {
        fileMap.set(name, target);
        if (declaredQualifier) fileMap.set(`${IMPORT_QUALIFIER_PREFIX}${name}`, declaredQualifier);
      }
    };
    const ownNamespace = declaredNamespace(f.content, f.language);
    if (ownNamespace) {
      for (const [name, targets] of namespaceTypes.get(ownNamespace) ?? []) {
        if (targets.size === 1) bind(name, targets.values().next().value!, name);
      }
    }

    if (f.language === 'Java' || f.language === 'Kotlin') {
      for (const m of code.matchAll(/^\s*import\s+(?:(static)\s+)?([\w.]+)(?:\s+as\s+(\w+))?\s*;?/gm)) {
        const fqn = m[2];
        const local = m[3] ?? fqn.split('.').pop()!;
        const target = resolveImportedFqn(fqnIndex, fqn, m[1] === 'static');
        const qualifier = m[1] ? undefined : fqn.split('.').pop()!;
        if (target) bind(local, target, qualifier);
      }
    } else if (f.language === 'C#') {
      for (const m of code.matchAll(/^\s*using\s+(?:(\w+)\s*=\s*)?([\w.]+)\s*;/gm)) {
        const alias = m[1];
        const imported = m[2];
        const direct = resolveImportedFqn(fqnIndex, imported);
        if (alias && direct) bind(alias, direct, imported.split('.').pop()!);
        if (!alias) {
          for (const [name, targets] of namespaceTypes.get(imported) ?? []) {
            if (targets.size === 1) bind(name, targets.values().next().value!, name);
          }
          if (direct) bind(imported.split('.').pop()!, direct, imported.split('.').pop()!);
        }
      }
    } else {
      for (const m of code.matchAll(/^\s*use\s+(?:(function)\s+)?([\\\w]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
        const fqn = m[2].replaceAll('\\', '.');
        const local = m[3] ?? fqn.split('.').pop()!;
        const target = resolveImportedFqn(fqnIndex, fqn);
        if (target) bind(
          local,
          target,
          m[1] ? IMPORT_TOP_LEVEL_QUALIFIER : fqn.split('.').pop()!,
        );
      }
    }
    if (f.language !== 'PHP') {
      for (const m of code.matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g)) {
        const exactTarget = resolveImportedFqn(fqnIndex, m[0]);
        const qualifier = exactTarget ? m[0] : m[0].slice(0, m[0].lastIndexOf('.'));
        const target = exactTarget ?? resolveImportedFqn(fqnIndex, qualifier);
        if (target) bind(qualifier, target, qualifier.split('.').pop()!);
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
  // Extensionless paths of every file in the analysis, so a Python absolute import can be told
  // apart from a third-party one (`from repo import Repo` vs `from psycopg import Client`).
  const projectModules = new Set<string>();
  for (const f of files) {
    // `stripModuleExt` knows only the TS/JS extensions; a Python module path needs `.py` off too.
    const base = stripModuleExt(f.path).replace(/\.py$/, '');
    // Register every path SUFFIX, because an absolute import is written relative to the package
    // root, not the repository root: `src/myapp/models.py` is imported as `myapp.models`. The
    // `src/` layout is the packaging default for a large share of Python projects, and matching
    // only the full path would refuse every intra-project import in them — and refuse it with a
    // message claiming the source said the type was elsewhere, which would be false.
    for (let cut = 0; cut !== -1; cut = base.indexOf('/', cut + 1)) {
      projectModules.add(cut === 0 ? base : base.slice(cut === 0 ? 0 : cut + 1));
    }
    projectModules.add(base);
    // A package import (`from pkg import X`) reaches `pkg/__init__.py`.
    if (f.path.endsWith('/__init__.py')) {
      const pkg = f.path.slice(0, -'/__init__.py'.length);
      for (let cut = 0; cut !== -1; cut = pkg.indexOf('/', cut + 1)) {
        projectModules.add(cut === 0 ? pkg : pkg.slice(cut + 1));
      }
      projectModules.add(pkg);
    }
  }
  for (const f of files) {
    let imports;
    const tsjs = f.language === 'TypeScript' || f.language === 'JavaScript';
    if (tsjs) imports = parseJSImports(f.content);
    else if (f.language === 'Python') imports = parsePythonImports(f.content);
    else continue;

    const fileMap = new Map<string, string>();
    const dir = posix.dirname(f.path);
    for (const imp of imports) {
      if (!imp.isRelative) {
        // A non-relative specifier is not automatically third-party. In TS/JS a bare specifier
        // resolves through node_modules (or a path alias this map cannot follow), so the name is
        // NOT from this project. In Python an absolute import is the ordinary way to reach a
        // sibling package, so it is external only when no project file matches the dotted module.
        // Recording which names arrive from an unresolvable specifier lets a consumer REFUSE
        // instead of falling back to a repo-wide namesake, which the source has just contradicted
        // (change: shrink-receiver-resolution-boundary). No binding is recorded either way —
        // there is no in-project target to bind to.
        const pythonModule = f.language === 'Python'
          ? imp.source.replaceAll('.', '/')
          : undefined;
        // A path ALIAS (`@/repo`, `~/lib`, `#internal`) is an in-project specifier this map
        // simply cannot follow — the source did NOT say the type is external, so refusing on it
        // would be a false claim and would cost every aliased repo its chained-receiver recall.
        //
        // The leading `@` alone does NOT mean alias: `@nestjs/common` is a scoped PACKAGE, and
        // treating it as in-project restores exactly the false edge this marker exists to stop.
        // The alias convention has an EMPTY scope segment (`@/`); a scoped package names one.
        const aliased = !pythonModule && /^(?:@\/|~\/|~$|#)/.test(imp.source);
        if (!aliased && (!pythonModule || !projectModules.has(pythonModule))) {
          for (const name of imp.importedNames) {
            fileMap.set(`${EXTERNAL_IMPORT_PREFIX}${name}`, imp.source);
          }
        }
        continue;
      }
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

interface GoImportIndex {
  fileDirs: ReadonlySet<string>;
  dirsBySuffix: ReadonlyMap<string, ReadonlySet<string>>;
  packageByDir: ReadonlyMap<string, string>;
}

export function parseGoImports(
  filePath: string,
  content: string,
  allFilePaths: string[],
  index?: GoImportIndex,
): Map<string, string> {
  const result = new Map<string, string>();
  const dir = posix.dirname(filePath);
  const fileDirs = index?.fileDirs ?? new Set(allFilePaths.map(path => posix.dirname(path)));
  const dirsBySuffix = index?.dirsBySuffix ?? (() => {
    const suffixes = new Map<string, Set<string>>();
    for (const candidate of fileDirs) {
      const parts = candidate.split('/');
      for (let i = 0; i < parts.length; i++) {
        const suffix = parts.slice(i).join('/');
        const dirs = suffixes.get(suffix) ?? new Set<string>();
        dirs.add(candidate);
        suffixes.set(suffix, dirs);
      }
    }
    return suffixes;
  })();
  for (const spec of goImportSpecs(content)) {
    let candidates: ReadonlySet<string> | undefined;
    if (spec.source.startsWith('.')) {
      const target = posix.normalize(posix.join(dir, spec.source));
      if (fileDirs.has(target)) candidates = new Set([target]);
    } else {
      const parts = spec.source.split('/');
      for (let i = 0; i < parts.length && !candidates; i++) {
        candidates = dirsBySuffix.get(parts.slice(i).join('/'));
      }
    }
    if (candidates?.size !== 1) continue;
    const target = candidates.values().next().value!;
    const alias = spec.alias ?? index?.packageByDir.get(target);
    if (alias) result.set(alias, target);
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
