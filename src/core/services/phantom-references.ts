/**
 * Phantom-reference findings (change: add-phantom-reference-findings).
 *
 * Agents invent APIs and packages: an import of a module that is not there, a named import the
 * target does not export, a package no manifest declares. The invented package name is also an
 * attack surface — register the name an assistant keeps suggesting and it gets installed. Each of
 * these is decidable locally, against the repository itself, with no network request.
 *
 * For every reference a diff ADDS (never the whole repository), this module answers one question
 * and reports only the misses:
 *
 *   | finding | the reference |
 *   |---|---|
 *   | `unresolved-internal-import` | a relative import whose target file is not on disk or in the corpus |
 *   | `unresolved-internal-symbol` | a named import the target module does not export |
 *   | `undeclared-dependency` | a bare specifier no manifest in scope declares |
 *   | `unpinned-dependency` | declared in a manifest the diff changed, but absent from the lockfile beside it |
 *
 * **Honesty.** Each claim rests on evidence the repository provides, so each gap is disclosed
 * instead of guessed:
 *   - the target module's exports are parsed from its CURRENT content, never from the index, so an
 *     export the same diff adds resolves;
 *   - a module that re-exports from somewhere this reader cannot follow (`export *` of an external
 *     package) can always be the name's source, so no symbol finding is made for it;
 *   - a path alias (`@/x`, a tsconfig `paths` entry, a package.json `imports` subpath) is disclosed,
 *     never reported, because the resolver does not read alias configuration;
 *   - a language without import support, a file that could not be read, an ecosystem with no
 *     manifest, and a manifest that did not parse are each `not-assessed`;
 *   - a non-literal dynamic import is disclosed, not checked.
 *
 * Nothing here reaches the network. A declared package name is not proof that the package is safe —
 * that is supply-chain tooling's job; this module only reports names nothing in the repository
 * accounts for.
 */

import { basename, join, posix, relative, resolve, sep } from 'node:path';
import {
  ImportExportParser, extractsExports, parseJSImports, parsePythonImports, resolveImport,
  type ImportInfo,
} from '../analyzer/import-parser.js';
import { goImportSpecs } from '../analyzer/import-resolver-bridge.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import { languageSupport } from '../analyzer/language-support.js';
import {
  parseCargoManifest, parseGoModManifest, parseNpmManifest, parsePyprojectManifest,
  parseRequirementsManifest, REQUIREMENTS_CANDIDATES, type PackageEcosystem,
} from '../analyzer/external-packages.js';
import { ECOSYSTEM_LOCKFILES, pinnedNames, pinsPackage } from '../analyzer/lockfile-pins.js';
import { ecosystemOfLanguage, isRelativeSpecifier, isStdlibSpecifier, packageNameOf } from '../analyzer/stdlib-modules.js';
import { readFileConfined } from '../../utils/path-confinement.js';
import { execFileGit } from '../../utils/git-exec.js';
import { emittedText } from './generated-file-guard.js';
import type { GovernanceFinding } from './mcp-handlers/enforcement-policy.js';
import type { ChangedFile } from '../../types/index.js';

const SOURCE = 'phantom-references';

/** Bounds. A diff is small; these stop a hostile or generated one from doing unbounded work. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_ADDED_REFERENCES = 600;
const MAX_REEXPORT_DEPTH = 4;
const MAX_CANDIDATES = 3;
/** The shortest shared prefix that makes a name worth offering as a candidate. */
const MIN_CANDIDATE_PREFIX = 3;

/** A specifier that names an alias the resolver does not read (so it is disclosed, never reported). */
const BARE_ALIAS_PREFIX = /^(?:@\/|~\/|~$|#)/;

// ============================================================================
// ADDED REFERENCES (pure)
// ============================================================================

/** One reference a diff added, as written. */
export interface AddedReference {
  /** The importing file, relative to the analyzed root. */
  file: string;
  /** The module specifier as written. */
  specifier: string;
  /** Names taken FROM the target (aliases resolved to the source name); empty for default/namespace. */
  names: string[];
  line: number;
  isRelative: boolean;
  isDynamic: boolean;
  /** True when the import binds nothing by name (default, namespace, star, side-effect). */
  wholeModule: boolean;
}

/** The identity an import is compared by, so a moved or re-indented import is not "added". */
function referenceKey(imp: ImportInfo): string {
  const names = [...(imp.importedSourceNames ?? imp.importedNames)].sort();
  return `${imp.source}\u0000${names.join(',')}\u0000${imp.hasDefault ? 'd' : ''}${imp.hasNamespace ? 'n' : ''}`;
}

/**
 * The references in `head` that `base` did not have, compared by specifier and bound names so that
 * moving an import does not read as adding one. `base` is null for a file the diff adds.
 */
export function addedReferences(file: string, baseImports: ImportInfo[] | null, headImports: ImportInfo[]): AddedReference[] {
  const before = new Set((baseImports ?? []).map(referenceKey));
  const out: AddedReference[] = [];
  // The import parsers scan by pattern, not by position, so the order is settled here: findings must
  // not depend on which regex matched first.
  for (const imp of headImports) {
    if (baseImports !== null && before.has(referenceKey(imp))) continue;
    const names = imp.importedSourceNames ?? [];
    out.push({
      file,
      specifier: imp.source,
      // A name bound through an alias is checked under its SOURCE name; a default or namespace
      // import binds no name the target must export.
      names: imp.hasDefault || imp.hasNamespace ? [] : names.filter(n => n !== 'default' && n !== '*'),
      line: imp.line,
      isRelative: imp.isRelative,
      isDynamic: imp.isDynamic,
      wholeModule: imp.hasDefault || imp.hasNamespace || (imp.importedSourceNames ?? []).length === 0,
    });
  }
  return out.sort((a, z) => a.line - z.line || (a.specifier < z.specifier ? -1 : a.specifier > z.specifier ? 1 : 0));
}

/**
 * Names in `available` worth offering for a missing `name`: those sharing a prefix of at least
 * {@link MIN_CANDIDATE_PREFIX} characters with it, longest shared prefix first, then alphabetical.
 * A shared prefix is an exact comparison — nothing here scores similarity or guesses a correction.
 */
export function prefixCandidates(name: string, available: Iterable<string>): string[] {
  const shared = (a: string, b: string): number => {
    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a[i] === b[i]) i++;
    return i;
  };
  return [...available]
    .filter(n => n !== name)
    .map(n => ({ n, p: shared(n, name) }))
    .filter(c => c.p >= MIN_CANDIDATE_PREFIX)
    .sort((a, b) => b.p - a.p || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
    .slice(0, MAX_CANDIDATES)
    .map(c => c.n);
}

// ============================================================================
// RESULT
// ============================================================================

/** A file, or a whole check, that could not be assessed — never reported as resolving. */
export interface NotAssessed {
  file: string;
  reason: string;
}

export interface PhantomReferenceResult {
  findings: GovernanceFinding[];
  /** Files whose references were not checked, each with the reason. */
  notAssessed: NotAssessed[];
  /** Disclosures that apply to the whole check (aliases skipped, missing manifests, caps reached). */
  boundaries: string[];
  /** How much was looked at, so an empty finding list can be read correctly. */
  summary: { filesChecked: number; referencesChecked: number };
}

// ============================================================================
// FILE READING
// ============================================================================

/** Current content of a repository file; null when it cannot be read as text. */
async function readHead(root: string, rel: string): Promise<string | null> {
  try {
    return await readFileConfined(root, rel, MAX_FILE_BYTES);
  } catch {
    return null;
  }
}

/**
 * Content of a file at a git ref. `absent` means the ref does not have it (an added file);
 * `unreadable` is any other failure, which is a different claim and is disclosed.
 */
async function readAtRef(root: string, ref: string, repoPath: string): Promise<string | { absent: boolean }> {
  const spec = `${ref}:${repoPath}`;
  try {
    await execFileGit('git', ['cat-file', '-e', spec], { cwd: root });
  } catch {
    return { absent: true };
  }
  try {
    const { stdout } = await execFileGit('git', ['cat-file', 'blob', spec], { cwd: root, maxBuffer: MAX_FILE_BYTES });
    return stdout;
  } catch {
    return { absent: false };
  }
}

// ============================================================================
// MANIFEST SCOPE
// ============================================================================

interface ManifestScope {
  /** Declared package names per ecosystem, from every manifest between the file and the root. */
  declared: Map<PackageEcosystem, Set<string>>;
  /** Manifests read, repo-relative, nearest first — the pairing point for a lockfile. */
  manifests: Array<{ path: string; ecosystem: PackageEcosystem }>;
  /** Manifests that exist but did not parse: the ecosystem cannot be judged. */
  failed: string[];
  /** The Go module path declared by the nearest `go.mod`, if any — imports under it are internal. */
  goModules: string[];
  /** Alias patterns from tsconfig/jsconfig `paths` and package.json `imports`. */
  aliasPatterns: string[];
  /** Workspace package names: a bare import of one of these is internal. */
  workspaceNames: Set<string>;
}

/** Manifest file names, with the ecosystem each one declares for. */
const MANIFEST_KINDS: ReadonlyArray<{ name: string; ecosystem: PackageEcosystem }> = [
  { name: 'package.json', ecosystem: 'npm' },
  { name: 'pyproject.toml', ecosystem: 'pypi' },
  { name: 'Cargo.toml', ecosystem: 'cargo' },
  { name: 'go.mod', ecosystem: 'go' },
  ...REQUIREMENTS_CANDIDATES.map(name => ({ name, ecosystem: 'pypi' as const })),
];

/** The directories from a file up to the analyzed root, nearest first. */
function ancestorDirs(fileRel: string): string[] {
  const out: string[] = [];
  let dir = posix.dirname(fileRel);
  for (;;) {
    out.push(dir === '.' ? '' : dir);
    if (dir === '.' || dir === '/' || dir === '') break;
    dir = posix.dirname(dir);
  }
  return out;
}

function declaredFrom(manifest: string, text: string, ecosystem: PackageEcosystem): string[] {
  switch (ecosystem) {
    case 'npm':
      return parseNpmManifest(text).map(p => p.name);
    case 'cargo':
      return parseCargoManifest(text).map(p => p.name);
    case 'go':
      return parseGoModManifest(text).map(p => p.name);
    case 'pypi':
      return basename(manifest) === 'pyproject.toml'
        ? parsePyprojectManifest(text).map(p => p.name)
        : parseRequirementsManifest(text).map(p => p.name);
  }
}

/** Alias patterns a tsconfig/jsconfig declares, plus package.json subpath imports. */
function aliasesFrom(manifest: string, text: string): string[] {
  try {
    // Comments and trailing commas are legal in tsconfig; strip them before parsing.
    const json = basename(manifest).startsWith('tsconfig') || basename(manifest).startsWith('jsconfig')
      ? text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/,(\s*[}\]])/g, '$1')
      : text;
    const doc = JSON.parse(json) as {
      compilerOptions?: { paths?: Record<string, unknown> };
      imports?: Record<string, unknown>;
    };
    return [...Object.keys(doc.compilerOptions?.paths ?? {}), ...Object.keys(doc.imports ?? {})];
  } catch {
    return [];
  }
}

/** npm workspace globs and the package's own name, from a package.json. */
function workspaceNamesFrom(text: string): string[] {
  try {
    const doc = JSON.parse(text) as { name?: unknown; workspaces?: unknown };
    const out: string[] = [];
    if (typeof doc.name === 'string') out.push(doc.name);
    return out;
  } catch {
    return [];
  }
}

/**
 * Everything the repository declares that bears on a file's bare imports: dependencies from each
 * manifest between the file and the root, the Go module path, alias patterns, and workspace names.
 * Cached per directory chain for the length of one check.
 */
class ScopeReader {
  private readonly perDir = new Map<string, {
    declared: Array<{ ecosystem: PackageEcosystem; names: string[] }>;
    manifests: Array<{ path: string; ecosystem: PackageEcosystem }>;
    failed: string[];
    goModules: string[];
    aliasPatterns: string[];
    workspaceNames: string[];
  }>();

  constructor(private readonly root: string) {}

  async scopeFor(fileRel: string): Promise<ManifestScope> {
    const scope: ManifestScope = {
      declared: new Map(), manifests: [], failed: [], goModules: [], aliasPatterns: [],
      workspaceNames: new Set(),
    };
    for (const dir of ancestorDirs(fileRel)) {
      const read = await this.readDir(dir);
      for (const { ecosystem, names } of read.declared) {
        const set = scope.declared.get(ecosystem) ?? new Set<string>();
        for (const n of names) set.add(n);
        scope.declared.set(ecosystem, set);
      }
      scope.manifests.push(...read.manifests);
      scope.failed.push(...read.failed);
      scope.goModules.push(...read.goModules);
      scope.aliasPatterns.push(...read.aliasPatterns);
      for (const n of read.workspaceNames) scope.workspaceNames.add(n);
    }
    return scope;
  }

  private async readDir(dir: string) {
    const cached = this.perDir.get(dir);
    if (cached) return cached;
    const entry = {
      declared: [] as Array<{ ecosystem: PackageEcosystem; names: string[] }>,
      manifests: [] as Array<{ path: string; ecosystem: PackageEcosystem }>,
      failed: [] as string[],
      goModules: [] as string[],
      aliasPatterns: [] as string[],
      workspaceNames: [] as string[],
    };
    const at = (name: string) => (dir ? `${dir}/${name}` : name);

    for (const { name, ecosystem } of MANIFEST_KINDS) {
      const path = at(name);
      const text = await readHead(this.root, path);
      if (text === null) continue;
      entry.manifests.push({ path, ecosystem });
      try {
        entry.declared.push({ ecosystem, names: declaredFrom(path, text, ecosystem) });
      } catch {
        entry.failed.push(path);
      }
      if (name === 'package.json') {
        entry.aliasPatterns.push(...aliasesFrom(path, text));
        entry.workspaceNames.push(...workspaceNamesFrom(text));
      }
      if (name === 'go.mod') {
        const m = /^module\s+(\S+)/m.exec(text);
        if (m) entry.goModules.push(m[1]);
      }
    }
    for (const config of ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json']) {
      const path = at(config);
      const text = await readHead(this.root, path);
      if (text !== null) entry.aliasPatterns.push(...aliasesFrom(path, text));
    }
    this.perDir.set(dir, entry);
    return entry;
  }
}

/** Whether a bare specifier matches an alias pattern (`@app/*`, `#internal`, `@/x`). */
function matchesAlias(specifier: string, patterns: readonly string[]): boolean {
  if (BARE_ALIAS_PREFIX.test(specifier)) return true;
  for (const pattern of patterns) {
    if (pattern === specifier) return true;
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (specifier.length >= head.length + tail.length && specifier.startsWith(head) && specifier.endsWith(tail)) return true;
  }
  return false;
}

// ============================================================================
// EXPORT ORACLE
// ============================================================================

/** What a module exports, read from its current content. */
interface ModuleExports {
  names: Set<string>;
  /** True when the module re-exports from a place this reader could not follow. */
  opaque: boolean;
}

/**
 * Exports of the module at `rel`, parsed from its CURRENT content and followed through re-exporting
 * modules (a barrel). `opaque` is set when a `export * from …` points somewhere unfollowable — an
 * external package, an unresolvable path, or past the depth limit — because the name asked for could
 * legitimately come from there, so nothing may be claimed missing.
 */
class ExportReader {
  private readonly cache = new Map<string, ModuleExports | null>();
  private readonly parser = new ImportExportParser();

  constructor(private readonly root: string) {}

  /** Null when the module's exports cannot be parsed at all (unsupported language, unreadable). */
  async exportsOf(rel: string, depth = 0): Promise<ModuleExports | null> {
    const key = `${rel}\u0000${depth}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    this.cache.set(key, null); // cycle guard: a module re-exporting itself resolves to "unknown"
    const result = await this.read(rel, depth);
    this.cache.set(key, result);
    return result;
  }

  private async read(rel: string, depth: number): Promise<ModuleExports | null> {
    if (!extractsExports(rel)) return null;
    const text = await readHead(this.root, rel);
    if (text === null) return null;
    const analysis = this.parser.parseContent(join(this.root, rel), text);
    const names = new Set<string>();
    let opaque = false;
    for (const e of analysis.exports) {
      if (!e.isReExport) { names.add(e.name); continue; }
      // `export { a } from './x'` names `a` here; `export * from './x'` names nothing itself.
      if (e.name && e.name !== '*') { names.add(e.name); continue; }
      if (depth >= MAX_REEXPORT_DEPTH || !e.reExportSource) { opaque = true; continue; }
      const target = await this.resolveTarget(rel, e.reExportSource);
      if (!target) { opaque = true; continue; }
      const nested = await this.exportsOf(target, depth + 1);
      if (!nested) { opaque = true; continue; }
      for (const n of nested.names) names.add(n);
      if (nested.opaque) opaque = true;
    }
    return { names, opaque };
  }

  /** A re-export's target, as a repo-relative path; null when it is external or unresolvable. */
  private async resolveTarget(fromRel: string, specifier: string): Promise<string | null> {
    if (!isRelativeSpecifier(specifier) && !specifier.startsWith('.')) return null;
    const abs = await resolveImport(specifier, join(this.root, fromRel), { baseDir: this.root });
    if (!abs) return null;
    const rel = relative(this.root, abs).split(sep).join('/');
    return rel && !rel.startsWith('..') ? rel : null;
  }
}

// ============================================================================
// THE CHECK
// ============================================================================

/** A finding's text is repository content: bounded, redacted, and screened before it is returned. */
function finding(
  code: string,
  severity: GovernanceFinding['severity'],
  subject: string,
  message: string,
  location: { path: string; line?: number },
): GovernanceFinding {
  return {
    code, severity, source: SOURCE,
    subject: emittedText(subject),
    message: emittedText(message),
    discriminator: emittedText(`${location.path}:${location.line ?? 0}`),
    location: { path: emittedText(location.path), ...(location.line ? { line: location.line } : {}) },
  };
}

/**
 * Check every reference the diff adds. Read-only, offline, and advisory: each miss is a registered
 * finding, and everything that could not be judged is disclosed rather than counted as resolved.
 *
 * `prefetched` is the diff already read by a caller (blast_radius reads it with lockfiles kept), so
 * the check costs no second git diff.
 */
export async function checkPhantomReferences(
  root: string,
  baseRef: string,
  prefetched?: readonly ChangedFile[],
  corpusFiles?: Iterable<string>,
): Promise<PhantomReferenceResult> {
  const findings: GovernanceFinding[] = [];
  const notAssessed: NotAssessed[] = [];
  const boundaries: string[] = [];
  const absRoot = resolve(root);

  const { getChangedFiles, getRepoPrefix, reframeRepoPath } = await import('../drift/git-diff.js');
  const files = prefetched
    ?? (await getChangedFiles({ rootPath: absRoot, baseRef, includeUnstaged: true, includeSkippable: true })).files;
  const prefix = (await getRepoPrefix(absRoot)) ?? '';
  const framed: ChangedFile[] = [];
  for (const f of files) {
    const path = reframeRepoPath(f.path, prefix);
    if (path !== null) framed.push({ ...f, path });
  }
  const changedPaths = new Set(framed.map(f => f.path));

  const corpus = new Set<string>(corpusFiles ?? []);
  const exports = new ExportReader(absRoot);
  const scopes = new ScopeReader(absRoot);

  const sources = framed.filter(f => f.status !== 'deleted' && supportsImports(f.path));
  if (sources.length > MAX_FILES) {
    boundaries.push(`Reference checking covered the first ${MAX_FILES} of ${sources.length} changed source files.`);
  }
  const aliasesSkipped = new Set<string>();
  const dynamicSkipped = new Set<string>();
  const ecosystemsWithoutManifest = new Set<PackageEcosystem>();
  const manifestsFailed = new Set<string>();
  let referencesChecked = 0;
  let filesChecked = 0;

  for (const file of sources.slice(0, MAX_FILES)) {
    const headText = await readHead(absRoot, file.path);
    if (headText === null) {
      notAssessed.push({ file: file.path, reason: 'the file could not be read as text' });
      continue;
    }
    const baseText = file.status === 'added' ? { absent: true } : await readAtRef(absRoot, baseRef, prefix + file.path);
    if (typeof baseText !== 'string' && !baseText.absent) {
      notAssessed.push({ file: file.path, reason: `the base revision of the file could not be read, so its added references are unknown` });
      continue;
    }
    const headImports = extractImports(file.path, headText);
    if (headImports === null) {
      notAssessed.push({ file: file.path, reason: `this check cannot read ${detectLanguage(file.path)} imports` });
      continue;
    }
    const baseImports = typeof baseText === 'string' ? extractImports(file.path, baseText) : null;
    filesChecked++;

    for (const ref of addedReferences(file.path, baseImports, headImports)) {
      if (referencesChecked >= MAX_ADDED_REFERENCES) {
        boundaries.push(`Reference checking stopped at ${MAX_ADDED_REFERENCES} added references; later ones were not checked.`);
        break;
      }
      referencesChecked++;
      if (ref.isDynamic && ref.specifier === '') {
        dynamicSkipped.add(ref.file);
        continue;
      }
      const ecosystem = ecosystemOfLanguage(detectLanguage(file.path));
      const relativeSpec = isRelativeSpecifier(ref.specifier) || (ecosystem === 'pypi' && ref.specifier.startsWith('.'));

      // ── Internal: the target must be a file on disk or in the corpus ────────
      const target = await resolveInternal(absRoot, file.path, ref.specifier, ecosystem);
      if (target) {
        await checkSymbols(ref, target);
        continue;
      }
      if (relativeSpec) {
        const candidates = pathCandidates(absRoot, file.path, ref.specifier, corpus);
        findings.push(finding(
          'unresolved-internal-import', 'error', ref.specifier,
          `${ref.file} imports '${ref.specifier}', which is not a file in this repository${candidates.length ? `; nearby: ${candidates.join(', ')}` : ''}.`,
          { path: ref.file, line: ref.line },
        ));
        continue;
      }

      // ── External: a bare specifier ──────────────────────────────────────────
      if (ecosystem === null) {
        notAssessed.push({ file: ref.file, reason: `'${ref.specifier}': this language has no manifest the check can read` });
        continue;
      }
      if (isStdlibSpecifier(ecosystem, ref.specifier)) continue;
      const scope = await scopes.scopeFor(file.path);
      if (matchesAlias(ref.specifier, scope.aliasPatterns)) {
        aliasesSkipped.add(ref.specifier);
        continue;
      }
      for (const f of scope.failed) manifestsFailed.add(f);
      const pkg = packageNameOf(ecosystem, ref.specifier);
      if (pkg === null) continue;
      const internalGo = ecosystem === 'go' ? goPackageDir(ref.specifier, scope.goModules) : null;
      if (internalGo !== null) {
        // An import under the module's own path names a directory in this repository.
        if (corpus.size === 0) continue;
        const present = [...corpus].some(f => posix.dirname(f) === internalGo || f.startsWith(internalGo + '/'))
          || (await readHead(absRoot, internalGo)) !== null;
        if (!present) {
          findings.push(finding(
            'unresolved-internal-import', 'error', ref.specifier,
            `${ref.file} imports '${ref.specifier}', which is under this module's own path but names no package directory in the repository.`,
            { path: ref.file, line: ref.line },
          ));
        }
        continue;
      }
      if (isInternalPackage(ecosystem, ref.specifier, pkg, scope)) continue;
      const manifests = scope.manifests.filter(m => m.ecosystem === ecosystem);
      if (manifests.length === 0) {
        ecosystemsWithoutManifest.add(ecosystem);
        notAssessed.push({ file: ref.file, reason: `'${ref.specifier}': no ${ecosystem} manifest in scope declares dependencies` });
        continue;
      }
      if (scope.failed.some(f => manifests.some(m => m.path === f))) {
        notAssessed.push({ file: ref.file, reason: `'${ref.specifier}': a manifest in scope did not parse` });
        continue;
      }
      const declared = scope.declared.get(ecosystem) ?? new Set<string>();
      if (!declares(ecosystem, declared, pkg)) {
        findings.push(finding(
          'undeclared-dependency', 'error', pkg,
          `${ref.file} imports '${ref.specifier}', which no manifest in scope declares (${manifests.map(m => m.path).join(', ')}).`,
          { path: ref.file, line: ref.line },
        ));
        continue;
      }
      // ── Declared: is it pinned, when the diff changed the declaring manifest? ──
      const changedManifest = manifests.find(m => changedPaths.has(m.path));
      if (!changedManifest) continue;
      const unpinned = await unpinnedIn(absRoot, changedManifest, ecosystem, pkg);
      if (unpinned) {
        findings.push(finding(
          'unpinned-dependency', 'warning', pkg,
          `${ref.file} imports '${ref.specifier}'; ${changedManifest.path} declares it but ${unpinned} does not pin it — a clean install will not have it.`,
          { path: changedManifest.path },
        ));
      }
    }
  }

  if (aliasesSkipped.size) {
    boundaries.push(`Path aliases are not resolved, so these were not checked: ${[...aliasesSkipped].sort().slice(0, 10).map(emittedText).join(', ')}.`);
  }
  if (dynamicSkipped.size) {
    boundaries.push(`Dynamic imports with a computed specifier were not checked (${dynamicSkipped.size} file${dynamicSkipped.size === 1 ? '' : 's'}).`);
  }
  if (manifestsFailed.size) {
    boundaries.push(`These manifests did not parse, so their ecosystem was not judged: ${[...manifestsFailed].sort().map(emittedText).join(', ')}.`);
  }
  if (corpus.size === 0) {
    boundaries.push('The index was not consulted for this check; imports were resolved against the working tree alone.');
  }

  return { findings, notAssessed, boundaries, summary: { filesChecked, referencesChecked } };

  /** Report a named import the target module does not export. */
  async function checkSymbols(ref: AddedReference, target: string): Promise<void> {
    if (ref.wholeModule || ref.names.length === 0) return;
    const available = await exports.exportsOf(target);
    if (!available) {
      notAssessed.push({ file: ref.file, reason: `'${ref.specifier}': the target module's exports could not be parsed` });
      return;
    }
    if (available.opaque) {
      notAssessed.push({ file: ref.file, reason: `'${ref.specifier}': the target re-exports from somewhere this check cannot follow, so a missing name cannot be proven` });
      return;
    }
    for (const name of ref.names) {
      if (available.names.has(name)) continue;
      const candidates = prefixCandidates(name, available.names);
      findings.push(finding(
        'unresolved-internal-symbol', 'error', `${ref.specifier}#${name}`,
        `${ref.file} imports '${name}' from '${ref.specifier}', which ${target} does not export${candidates.length ? `; it exports ${candidates.join(', ')}` : ''}.`,
        { path: ref.file, line: ref.line },
      ));
    }
  }
}

/** Whether a file's language has import support in the language-support matrix. */
export function supportsImports(filePath: string): boolean {
  return languageSupport(detectLanguage(filePath)).capabilities.includes('imports');
}

/**
 * The imports a file declares, as written. Null when this check cannot read the language's imports:
 * the matrix may claim import support that only the call-graph resolver provides (Java, Kotlin, C#,
 * PHP), and a file in one of those is disclosed as not assessed rather than counted as clean.
 */
export function extractImports(filePath: string, content: string): ImportInfo[] | null {
  switch (detectLanguage(filePath)) {
    case 'TypeScript':
    case 'JavaScript':
      return parseJSImports(content);
    case 'Python':
      return parsePythonImports(content);
    case 'Go':
      // Go imports a PACKAGE path, so it binds no names this check could verify against a file.
      return goImportSpecs(content).map(spec => ({
        source: spec.source,
        isRelative: spec.source.startsWith('.'),
        isPackage: !spec.source.startsWith('.'),
        isBuiltin: false,
        importedNames: spec.alias ? [spec.alias] : [],
        importedSourceNames: [],
        hasDefault: false,
        hasNamespace: true,
        isTypeOnly: false,
        isDynamic: false,
        line: spec.line,
      }));
    default:
      return null;
  }
}

/** The target of an internal import, repo-relative; null when it is not a file in this repository. */
async function resolveInternal(
  absRoot: string,
  fromRel: string,
  specifier: string,
  ecosystem: PackageEcosystem | null,
): Promise<string | null> {
  if (specifier === '') return null;
  // Python's absolute intra-project imports look like packages, so the resolver tries both.
  if (!isRelativeSpecifier(specifier) && !specifier.startsWith('.') && ecosystem !== 'pypi') return null;
  let abs: string | null;
  try {
    abs = await resolveImport(specifier, join(absRoot, fromRel), { baseDir: absRoot });
  } catch {
    return null;
  }
  if (!abs) return null;
  const rel = relative(absRoot, abs).split(sep).join('/');
  return rel && !rel.startsWith('..') ? rel : null;
}

/** Corpus paths near an unresolved relative import: same directory, or the same file name. */
function pathCandidates(absRoot: string, fromRel: string, specifier: string, corpus: ReadonlySet<string>): string[] {
  if (corpus.size === 0) return [];
  const attempted = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
  const wantedDir = posix.dirname(attempted);
  const wantedBase = basename(attempted).replace(/\.[^.]+$/, '');
  const out = new Set<string>();
  for (const path of corpus) {
    if (posix.dirname(path) !== wantedDir) continue;
    const base = basename(path).replace(/\.[^.]+$/, '');
    if (prefixCandidates(wantedBase, [base]).length || base === wantedBase) out.add(path);
    if (out.size >= MAX_CANDIDATES) break;
  }
  return [...out].sort().slice(0, MAX_CANDIDATES);
}

/**
 * The repository directory a Go import under the module's own path names; null when the specifier is
 * not under any declared module path.
 */
function goPackageDir(specifier: string, goModules: readonly string[]): string | null {
  for (const module of goModules) {
    if (specifier === module) return '';
    if (specifier.startsWith(module + '/')) return specifier.slice(module.length + 1);
  }
  return null;
}

/** Whether a bare specifier names something inside this repository rather than a dependency. */
function isInternalPackage(
  ecosystem: PackageEcosystem,
  specifier: string,
  pkg: string,
  scope: ManifestScope,
): boolean {
  if (scope.workspaceNames.has(pkg)) return true;
  if (ecosystem === 'go') {
    return scope.goModules.some(m => specifier === m || specifier.startsWith(m + '/'));
  }
  return false;
}

/** Whether a manifest set declares a package, by the ecosystem's own name comparison. */
function declares(ecosystem: PackageEcosystem, declared: ReadonlySet<string>, pkg: string): boolean {
  if (ecosystem === 'go') {
    for (const name of declared) {
      if (pkg === name || pkg.startsWith(name + '/')) return true;
    }
    return false;
  }
  return pinsPackage(ecosystem, declared, pkg);
}

/**
 * The lockfile beside a changed manifest that fails to pin `pkg`, or null when every lockfile found
 * pins it, none exists, or none could be parsed (which proves nothing).
 */
async function unpinnedIn(
  absRoot: string,
  manifest: { path: string; ecosystem: PackageEcosystem },
  ecosystem: PackageEcosystem,
  pkg: string,
): Promise<string | null> {
  const dir = posix.dirname(manifest.path);
  for (const name of ECOSYSTEM_LOCKFILES[ecosystem]) {
    const path = dir === '.' || dir === '' ? name : `${dir}/${name}`;
    const text = await readHead(absRoot, path);
    if (text === null) continue;
    const pins = pinnedNames(name, text);
    if (pins === null) continue; // unparseable: no claim
    if (pinsPackage(ecosystem, pins, pkg)) return null;
    return path;
  }
  return null;
}

/** The finding codes this module emits, as registered in the finding-code catalogue. */
export const PHANTOM_REFERENCE_CODES = [
  'unresolved-internal-import',
  'unresolved-internal-symbol',
  'undeclared-dependency',
  'unpinned-dependency',
] as const;
