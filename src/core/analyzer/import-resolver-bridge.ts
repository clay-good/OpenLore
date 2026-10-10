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
import { kotlinCodeMask, scanKotlinFile, type KotlinDeclaration, type KotlinFileHeader } from './kotlin-source.js';
import { kotlinFacadeName } from './kotlin-jvm-names.js';

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

/** Conventional directories a package root sits under, stripped when deciding whether an absolute
 *  import names an in-project module. Declared and shallow — see {@link EXTERNAL_IMPORT_PREFIX}. */
const PACKAGE_ROOT_PREFIXES = ['src/', 'lib/', 'app/'] as const;
export const IMPORT_TOP_LEVEL_QUALIFIER = '\0top-level';

/**
 * Kotlin scope bindings (change: fix-kotlin-package-binding-soundness). A Kotlin file's map holds,
 * beside the type bindings every JVM file has, one entry per callable name that is in scope by an
 * explicit import, the file's own package, or a wildcard import, in that order of precedence (the
 * order the Kotlin language specifies). Each namespace is separate, because Kotlin lets a class, a
 * function, and a property share a name:
 *
 * - `KOTLIN_FUNCTION_PREFIX + name`  → a package-level function (binds a receiverless call only)
 * - `KOTLIN_EXTENSION_PREFIX + name` → a package-level extension function (binds a receiver call)
 * - `KOTLIN_PROPERTY_PREFIX + name`  → a package-level property
 * - `KOTLIN_MEMBER_PREFIX + name`    → a member imported by name (`import a.b.Obj.member`)
 * - `KOTLIN_EXTERNAL_PREFIX + name`  → an explicit import that names nothing in the repository;
 *   it shadows a same-package or wildcard symbol of that name, as it does in the language
 *
 * A callable value is `file\0declaredName\0offset,offset…` (see {@link decodeKotlinCallable}); the
 * offsets are the declaring `fun` / `val` keywords, so the consumer binds the exact declaration
 * and never a same-named member. A name that is ambiguous at its level has no entry at all.
 */
export const KOTLIN_FUNCTION_PREFIX = '\0kt-fn:';
export const KOTLIN_EXTENSION_PREFIX = '\0kt-ext:';
export const KOTLIN_PROPERTY_PREFIX = '\0kt-prop:';
export const KOTLIN_MEMBER_PREFIX = '\0kt-member:';
export const KOTLIN_EXTERNAL_PREFIX = '\0kt-external:';
/**
 * A type name that is in scope but declared in more than one file at the level that decided it.
 * The value is the candidate files joined by `\0`, so a consumer can disclose the ambiguity with
 * its candidates instead of reporting "no such type".
 */
export const KOTLIN_AMBIGUOUS_TYPE_PREFIX = '\0kt-ambiguous-type:';

export interface KotlinCallableBinding { file: string; name: string; offsets: number[] }

export function decodeKotlinCallable(value: string | undefined): KotlinCallableBinding | undefined {
  if (!value) return undefined;
  const [file, name, offsets] = value.split('\0');
  if (!file || !name) return undefined;
  return { file, name, offsets: (offsets ?? '').split(',').filter(Boolean).map(Number) };
}

/** `import a.b.Obj.member` → the declaring file and the owner type name. */
export function decodeKotlinMember(value: string | undefined): { file: string; owner: string } | undefined {
  if (!value) return undefined;
  const [file, owner] = value.split('\0');
  return file && owner ? { file, owner } : undefined;
}

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

/*
 * INDENT IS `[ \t]`, NEVER `\s` (see classify-yaml.ts for the full rationale). `\s`
 * matches `\n`, so `^\s*KEYWORD` under /m rescans every remaining newline to EOF from
 * each of O(n) line starts and gives them back one at a time — quadratic on a file of
 * blank lines, which costs the attacker nothing. Measured in isolation at 50 KB of
 * newlines: `^\s*package\s+…` 8.0 s, the Java import form 7.1 s, the Kotlin `fun` form
 * 6.9 s, all now 0-1 ms. Narrowing the INDENT is a no-op — a newline there means a
 * different line, which `^` under /m already anchors. The keyword-to-value run in a
 * DECLARATION keeps `\s` (a `package\ncom.example;` really is legal, and
 * `parseJavaPackage` accepts it) and is length-bounded instead, which is linear without
 * narrowing what matches.
 *
 * Hardening, not a demonstrated exploit: the audit measured these quadratic in isolation
 * but could not reach them end to end with a newline payload through `extractSignatures`.
 */
function declaredNamespace(content: string, language: string): string | undefined {
  const code = sanitizeForRegex(content, false);
  if (language === 'PHP') {
    return code.match(/^[ \t]*namespace\s{1,80}([\\\w]+)[ \t]*[;{]/m)?.[1].replaceAll('\\', '.');
  }
  if (language === 'C#') return code.match(/^[ \t]*namespace\s{1,80}([\w.]+)[ \t]*[;{]/m)?.[1];
  return code.match(/^[ \t]*package\s{1,80}([\w.]+)[ \t]*;?/m)?.[1];
}

function declaredTypes(content: string, language: string): string[] {
  const keywords = language === 'PHP'
    ? 'class|interface|enum|trait'
    : language === 'C#'
      ? 'class|interface|enum|record|struct'
      : 'class|interface|enum|record';
  return [...sanitizeForRegex(content, false).matchAll(
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
    const m = text.match(/^[ \t]*(?:([A-Za-z_]\w*|[._])[ \t]+)?"([^"]+)"/);
    if (!m || m[1] === '_' || m[1] === '.') return;
    specs.push({ alias: m[1], source: m[2] });
  };
  for (const line of code.split('\n')) {
    if (!inBlock) {
      const single = line.match(/^[ \t]*import[ \t]+(?!\()(.+)$/);
      if (single) add(single[1]);
      const open = line.match(/^[ \t]*import[ \t]*\((.*)$/);
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

const KOTLIN_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'object', 'enum']);

type KotlinScopeKind = 'type' | 'function' | 'extension' | 'property';
interface KotlinSymbol { file: string; declaration: KotlinDeclaration }
type KotlinPackageIndex = Map<string, Record<Exclude<KotlinScopeKind, 'type'>, Map<string, KotlinSymbol[]>>>;

const kotlinScopeKind = (d: KotlinDeclaration): KotlinScopeKind | undefined =>
  d.kind === 'function' ? (d.receiverType ? 'extension' : 'function')
    : d.kind === 'property' ? (d.receiverType ? undefined : 'property')
      : undefined;

/**
 * Bind the names each Kotlin file has in scope (change: fix-kotlin-package-binding-soundness).
 *
 * Precedence is the language's: an explicit import, then the file's own package, then a wildcard
 * import. A name is resolved at the first level that declares it; when that level declares it in
 * more than one file the name is ambiguous and binds nothing, and a lower level is NOT consulted
 * (the compiler would not consult it either). Default-import names are never bound here, so a call
 * to `listOf(...)` stays external unless the file imports a project `listOf` or shares its package.
 */
function bindKotlinScopes(
  files: Array<{ path: string; content: string; language: string }>,
  headerOf: (f: { path: string; content: string }) => KotlinFileHeader,
  jvmFqnIndex: TargetIndex,
  jvmTypesByPackage: Map<string, Map<string, Set<string>>>,
  map: ImportMap,
): void {
  const packages: KotlinPackageIndex = new Map();
  for (const f of files) {
    const header = headerOf(f);
    let pkg = packages.get(header.packageName);
    if (!pkg) { pkg = { function: new Map(), extension: new Map(), property: new Map() }; packages.set(header.packageName, pkg); }
    for (const declaration of header.declarations) {
      const kind = kotlinScopeKind(declaration);
      if (!kind || kind === 'type') continue;
      const list = pkg[kind].get(declaration.name) ?? [];
      list.push({ file: f.path, declaration });
      pkg[kind].set(declaration.name, list);
    }
  }

  // `expect class X` is the binding target of `X`; `actual class X` and `actual typealias X`
  // in other source sets do not make the name ambiguous.
  const expectTypes = new Map<string, Set<string>>();
  for (const f of files) {
    const header = headerOf(f);
    for (const declaration of header.declarations) {
      if (!KOTLIN_TYPE_KINDS.has(declaration.kind) || !declaration.modifiers.includes('expect')) continue;
      const key = `${header.packageName}\0${declaration.name}`;
      const set = expectTypes.get(key) ?? new Set<string>();
      set.add(f.path);
      expectTypes.set(key, set);
    }
  }
  const expectTypeFiles = (pkgName: string, name: string): Set<string> | undefined => expectTypes.get(`${pkgName}\0${name}`);

  /** Symbols of `name` in `pkg` that `viewer` may see: `private` is visible in its own file only. */
  const visible = (pkgName: string, kind: Exclude<KotlinScopeKind, 'type'>, name: string, viewer: string): KotlinSymbol[] =>
    (packages.get(pkgName)?.[kind].get(name) ?? [])
      .filter(sym => sym.file === viewer || !sym.declaration.modifiers.includes('private'));

  const encode = (all: KotlinSymbol[]): string | null => {
    // Kotlin Multiplatform: an `expect` declaration is the binding target of its name, and its
    // `actual` declarations do not compete with it (change: add-kotlin-multiplatform-source-sets).
    const expected = all.filter(sym => sym.declaration.modifiers.includes('expect'));
    const symbols = expected.length > 0 ? expected : all;
    const fileSet = new Set(symbols.map(sym => sym.file));
    // Overloads in one file are one graph node; the same name in two files is ambiguous.
    if (fileSet.size !== 1) return null;
    return `${symbols[0].file}\0${symbols[0].declaration.name}\0${symbols.map(sym => sym.declaration.offset).join(',')}`;
  };

  for (const f of files) {
    const header = headerOf(f);
    const fileMap = new Map<string, string>();
    // `null` = ambiguous or shadowed at the level that decided the name: nothing lower may bind it.
    const decided: Record<KotlinScopeKind, Map<string, string | null>> = {
      type: new Map(), function: new Map(), extension: new Map(), property: new Map(),
    };
    const typeQualifier = new Map<string, string>();
    const external = new Set<string>();

    const offer = (kind: KotlinScopeKind, level: Map<string, Set<string>>, local: string, value: string): void => {
      const values = level.get(`${kind}\0${local}`) ?? new Set<string>();
      values.add(value);
      level.set(`${kind}\0${local}`, values);
    };
    const commit = (level: Map<string, Set<string>>): void => {
      for (const [key, values] of level) {
        const [kind, local] = key.split('\0') as [KotlinScopeKind, string];
        if (decided[kind].has(local)) continue;
        decided[kind].set(local, values.size === 1 ? values.values().next().value! : null);
        if (kind === 'type' && values.size > 1) {
          fileMap.set(`${KOTLIN_AMBIGUOUS_TYPE_PREFIX}${local}`, [...values].sort().join('\0'));
        }
      }
    };
    const offerPackageName = (level: Map<string, Set<string>>, pkgName: string, name: string, local: string): boolean => {
      let found = false;
      for (const kind of ['function', 'extension', 'property'] as const) {
        const symbols = visible(pkgName, kind, name, f.path);
        if (symbols.length === 0) continue;
        found = true;
        const encoded = encode(symbols);
        // Two files → offer two distinct values, which `commit` records as ambiguous.
        if (encoded) offer(kind, level, local, encoded);
        else for (const sym of symbols) offer(kind, level, local, `${sym.file}\0${sym.declaration.name}\0${sym.declaration.offset}`);
      }
      const typeFiles = expectTypeFiles(pkgName, name) ?? jvmTypesByPackage.get(pkgName)?.get(name);
      if (typeFiles && typeFiles.size > 0) {
        found = true;
        for (const file of typeFiles) offer('type', level, local, file);
        typeQualifier.set(local, name);
      }
      return found;
    };

    // Level 1 — explicit imports.
    const explicit = new Map<string, Set<string>>();
    for (const imp of header.imports) {
      if (imp.wildcard) continue;
      const dot = imp.fqn.lastIndexOf('.');
      const name = dot < 0 ? imp.fqn : imp.fqn.slice(dot + 1);
      const pkgName = dot < 0 ? '' : imp.fqn.slice(0, dot);
      const local = imp.alias ?? name;
      if (offerPackageName(explicit, pkgName, name, local)) continue;
      // `import a.b.Outer.Inner` / `import a.b.Obj.member`: the owner is a type of a shorter package.
      const ownerDot = pkgName.lastIndexOf('.');
      const owner = ownerDot < 0 ? pkgName : pkgName.slice(ownerDot + 1);
      const ownerFiles = pkgName ? jvmTypesByPackage.get(ownerDot < 0 ? '' : pkgName.slice(0, ownerDot))?.get(owner) : undefined;
      const ownerFile = ownerFiles?.size === 1 ? ownerFiles.values().next().value! : uniqueTarget(jvmFqnIndex, pkgName);
      if (ownerFile) {
        offer('type', explicit, local, ownerFile);
        // A nested class is recorded under its qualified name.
        typeQualifier.set(local, `${owner}.${name}`);
        fileMap.set(`${KOTLIN_MEMBER_PREFIX}${local}`, `${ownerFile}\0${owner}`);
        continue;
      }
      // Names nothing in the repository: a library symbol. It still shadows lower levels.
      external.add(local);
      fileMap.set(`${EXTERNAL_IMPORT_PREFIX}${local}`, imp.fqn);
      for (const kind of ['type', 'function', 'extension', 'property'] as const) decided[kind].set(local, null);
    }
    commit(explicit);

    // Level 2 — the file's own package.
    const samePackage = new Map<string, Set<string>>();
    const offerWholePackage = (level: Map<string, Set<string>>, pkgName: string): void => {
      const pkg = packages.get(pkgName);
      for (const kind of ['function', 'extension', 'property'] as const) {
        for (const name of pkg?.[kind].keys() ?? []) {
          const symbols = visible(pkgName, kind, name, f.path);
          if (symbols.length === 0) continue;
          const encoded = encode(symbols);
          if (encoded) offer(kind, level, name, encoded);
          else for (const sym of symbols) offer(kind, level, name, `${sym.file}\0${sym.declaration.name}\0${sym.declaration.offset}`);
        }
      }
      for (const [name, allTypeFiles] of jvmTypesByPackage.get(pkgName) ?? []) {
        const typeFiles = expectTypeFiles(pkgName, name) ?? allTypeFiles;
        for (const file of typeFiles) offer('type', level, name, file);
        if (!typeQualifier.has(name)) typeQualifier.set(name, name);
      }
    };
    offerWholePackage(samePackage, header.packageName);
    commit(samePackage);

    // Level 3 — wildcard imports. Two wildcard packages that both declare a name make it ambiguous.
    const wildcard = new Map<string, Set<string>>();
    for (const imp of header.imports) if (imp.wildcard) offerWholePackage(wildcard, imp.fqn);
    commit(wildcard);

    for (const [local, target] of decided.type) {
      if (!target) continue;
      fileMap.set(local, target);
      fileMap.set(`${IMPORT_QUALIFIER_PREFIX}${local}`, typeQualifier.get(local) ?? local);
    }
    for (const [kind, prefix] of [
      ['function', KOTLIN_FUNCTION_PREFIX], ['extension', KOTLIN_EXTENSION_PREFIX], ['property', KOTLIN_PROPERTY_PREFIX],
    ] as const) {
      for (const [local, value] of decided[kind]) if (value) fileMap.set(`${prefix}${local}`, value);
    }
    for (const local of external) fileMap.set(`${KOTLIN_EXTERNAL_PREFIX}${local}`, local);
    for (const key of [...fileMap.keys()]) {
      // A member import is kept only while its type binding survived precedence.
      if (key.startsWith(KOTLIN_MEMBER_PREFIX) && !fileMap.has(key.slice(KOTLIN_MEMBER_PREFIX.length))) fileMap.delete(key);
    }

    // Fully qualified references in code (`com.acme.repo.Store()`), as for Java.
    const code = kotlinCodeMask(f.content);
    for (const m of code.matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g)) {
      const exactTarget = resolveImportedFqn(jvmFqnIndex, m[0]);
      const qualifier = exactTarget ? m[0] : m[0].slice(0, m[0].lastIndexOf('.'));
      const target = exactTarget ?? resolveImportedFqn(jvmFqnIndex, qualifier);
      if (target && !fileMap.has(qualifier)) {
        fileMap.set(qualifier, target);
        fileMap.set(`${IMPORT_QUALIFIER_PREFIX}${qualifier}`, qualifier.split('.').pop()!);
      }
    }
    if (fileMap.size > 0) map.set(f.path, fileMap);
  }
}

/** Build import/package bindings (change: widen-import-resolution). */
function buildStaticLanguageImportMaps(
  files: Array<{ path: string; content: string; language: string }>,
): ImportMap {
  const map: ImportMap = new Map();
  const allFilePaths = files.map(file => file.path);
  const kotlinHeaders = new Map<string, KotlinFileHeader>();
  const kotlinHeader = (f: { path: string; content: string }): KotlinFileHeader => {
    let header = kotlinHeaders.get(f.path);
    if (!header) { header = scanKotlinFile(f.content); kotlinHeaders.set(f.path, header); }
    return header;
  };

  const goPackageSetsByDir = new Map<string, Set<string>>();
  const goFileDirs = new Set<string>();
  for (const f of files.filter(f => f.language === 'Go')) {
    const dir = posix.dirname(f.path);
    goFileDirs.add(dir);
    const pkg = sanitizeForRegex(f.content, false).match(/^[ \t]*package\s{1,80}([A-Za-z_]\w*)\b/m)?.[1];
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
      /^[ \t]*package\s{1,80}([A-Za-z_]\w*)\b/m,
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
    // A Kotlin file with no `package` line is in the root package, which is a real package.
    const namespace = f.language === 'Kotlin'
      ? kotlinHeader(f).packageName
      : declaredNamespace(f.content, f.language);
    if (namespace === undefined || (!namespace && f.language !== 'Kotlin')) continue;
    const ecosystem = ecosystemFor(f.language);
    const fqnIndex = fqnIndexes.get(ecosystem) ?? new Map<string, Set<string>>();
    const namespaceTypes = namespaceTypesByEcosystem.get(ecosystem) ?? new Map();
    // Kotlin: package-level types only, read by the declaration scanner. A member function is
    // not a package symbol, and a package-level function is bound by `bindKotlinScopes` below.
    const symbols = f.language === 'Kotlin'
      ? kotlinHeader(f).declarations.filter(d => KOTLIN_TYPE_KINDS.has(d.kind)).map(d => d.name)
      : declaredTypes(f.content, f.language);
    if (f.language === 'PHP') {
      symbols.push(...declaredTopLevelFunctions(f.content));
    }
    // A Kotlin file with package-level functions or properties compiles to a facade class
    // (`FooKt`), which is what Java imports (change: add-kotlin-java-interop-resolution). Two
    // files with one facade name in one package leave the name with two targets, so it binds
    // nothing.
    if (f.language === 'Kotlin' && kotlinHeader(f).declarations.some(d =>
      (d.kind === 'function' || d.kind === 'property') && !d.modifiers.includes('private'))) {
      symbols.push(kotlinFacadeName(f.path, f.content));
    }
    const byName = namespaceTypes.get(namespace) ?? new Map<string, Set<string>>();
    for (const symbol of symbols) {
      addTarget(fqnIndex, namespace ? `${namespace}.${symbol}` : symbol, f.path);
      const targets = byName.get(symbol) ?? new Set<string>();
      targets.add(f.path);
      byName.set(symbol, targets);
    }
    namespaceTypes.set(namespace, byName);
    fqnIndexes.set(ecosystem, fqnIndex);
    namespaceTypesByEcosystem.set(ecosystem, namespaceTypes);
  }

  bindKotlinScopes(
    files.filter(f => f.language === 'Kotlin'),
    kotlinHeader,
    fqnIndexes.get('JVM') ?? new Map(),
    namespaceTypesByEcosystem.get('JVM') ?? new Map(),
    map,
  );

  for (const f of files) {
    if (!['Java', 'C#', 'PHP'].includes(f.language)) continue;
    const ecosystem = ecosystemFor(f.language);
    const fqnIndex = fqnIndexes.get(ecosystem) ?? new Map();
    const namespaceTypes = namespaceTypesByEcosystem.get(ecosystem) ?? new Map();
    const code = sanitizeForRegex(f.content, false);
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

    if (f.language === 'Java') {
      for (const m of code.matchAll(/^[ \t]*import\s{1,80}(?:(static)\s{1,80})?([\w.]+)(?:\s{1,80}as\s{1,80}(\w+))?[ \t]*;?/gm)) {
        const fqn = m[2];
        const local = m[3] ?? fqn.split('.').pop()!;
        const target = resolveImportedFqn(fqnIndex, fqn, m[1] === 'static');
        const qualifier = m[1] ? undefined : fqn.split('.').pop()!;
        if (target) bind(local, target, qualifier);
      }
    } else if (f.language === 'C#') {
      for (const m of code.matchAll(/^[ \t]*using\s{1,80}(?:(\w+)[ \t]*=[ \t]*)?([\w.]+)[ \t]*;/gm)) {
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
      for (const m of code.matchAll(/^[ \t]*use\s{1,80}(?:(function)\s{1,80})?([\\\w]+)(?:\s{1,80}as\s{1,80}(\w+))?[ \t]*;/gm)) {
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
  const addModulePath = (path: string): void => {
    projectModules.add(path);
    // An absolute import is written relative to the PACKAGE root, not the repository root:
    // `src/myapp/models.py` is imported as `myapp.models`, and the `src/` layout is the
    // packaging default for a large share of Python projects. Matching only the full path would
    // refuse every intra-project import in them — with a message claiming the source said the
    // type was elsewhere, which would be false.
    //
    // The prefix list is DECLARED and shallow on purpose. Registering every path suffix instead
    // would make any file whose basename collides with a real module look in-project — a
    // `vendor/shims/logging.py` would vouch for `import logging` — which reopens exactly the
    // namesake door this marker exists to close.
    for (const prefix of PACKAGE_ROOT_PREFIXES) {
      if (path.startsWith(prefix)) projectModules.add(path.slice(prefix.length));
    }
  };
  for (const f of files) {
    // `stripModuleExt` knows only the TS/JS extensions; a Python module path needs `.py` off too.
    addModulePath(stripModuleExt(f.path).replace(/\.py$/, ''));
    // A package import (`from pkg import X`) reaches `pkg/__init__.py`.
    if (f.path.endsWith('/__init__.py')) addModulePath(f.path.slice(0, -'/__init__.py'.length));
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
