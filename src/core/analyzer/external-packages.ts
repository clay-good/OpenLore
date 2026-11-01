/**
 * External package extractor.
 *
 * Parses package manifests (npm, pip, cargo, go) to build a flat list
 * of direct dependencies. No LLM required — pure filesystem reads.
 *
 * Each manifest kind has a PURE parser over the file's text, and the directory-based functions read
 * the file and call it. The phantom-reference check (change: add-phantom-reference-findings) reads
 * manifests itself — it needs to know which manifest could not be parsed, which a swallowed error
 * cannot tell it — and parses them with these same functions, so "what counts as declared" has one
 * definition.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PackageEcosystem = 'npm' | 'pypi' | 'cargo' | 'go';

export interface ExternalPackage {
  name: string;
  version: string;
  ecosystem: PackageEcosystem;
  isDev: boolean;
}

// ============================================================================
// PARSERS
// ============================================================================

/**
 * Dependencies a `package.json` declares. Throws on malformed JSON, so a caller that must not treat
 * an unreadable manifest as "declares nothing" can tell the two apart.
 */
export function parseNpmManifest(text: string): ExternalPackage[] {
  const pkg = JSON.parse(text) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const out: ExternalPackage[] = [];
  // Membership through a Set: a scan of `out` per entry is quadratic, and a manifest's dependency
  // count is repository-controlled.
  const seen = new Set<string>();
  const add = (entries: Record<string, string> | undefined, isDev: boolean, onlyNew = false) => {
    for (const [name, version] of Object.entries(entries ?? {})) {
      if (onlyNew && seen.has(name)) continue;
      seen.add(name);
      out.push({ name, version, ecosystem: 'npm', isDev });
    }
  };
  add(pkg.dependencies, false);
  add(pkg.devDependencies, true);
  add(pkg.peerDependencies, false, true);
  // An optional dependency is declared: an import of one must not read as undeclared.
  add(pkg.optionalDependencies, false, true);
  return out;
}

async function parseNpm(rootDir: string): Promise<ExternalPackage[]> {
  try {
    return parseNpmManifest(await readFile(join(rootDir, 'package.json'), 'utf-8'));
  } catch { return []; }
}

/**
 * The body of a TOML table: the lines after its `[header]` line, up to the next line that opens a
 * table. Found without a regex over the content, so no section shape can make it backtrack.
 */
export function tomlSection(raw: string, header: string): string {
  /** The table a line opens, if it opens one: `[x]`, `[[x]]`, with an optional trailing comment. */
  const tableOf = (line: string): string | null => {
    const m = /^\s*(\[{1,2})\s*([^\]]*?)\s*(\]{1,2})\s*(?:#.*)?$/.exec(line.replace(/\r$/, ''));
    return m && m[1].length === m[3].length ? m[2].replace(/["']/g, '') : null;
  };
  const lines = raw.split('\n');
  const start = lines.findIndex(l => tableOf(l) === header);
  if (start === -1) return '';
  const body: string[] = [];
  // Only another TABLE HEADER ends the section. A value's array can start a line with `[` and look
  // exactly like one, so a line inside an unclosed array — or right after a key awaiting its value
  // — is never read as a header.
  let depth = 0;
  let awaitingValue = false;
  for (const line of lines.slice(start + 1)) {
    // A comment may sit at column 0, and a quoted value may hold a bracket; neither is structure.
    const text = line.replace(/\r$/, '').replace(/(^|\s)#.*$/, '').replace(/"[^"]*"|'[^']*'/g, '""');
    if (depth === 0 && !awaitingValue && tableOf(line) !== null) break;
    body.push(line);
    for (const ch of text) {
      if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
    }
    if (text.trim() !== '') awaitingValue = /=\s*$/.test(text);
  }
  return body.join('\n');
}

/**
 * The distribution name a `pyproject.toml` declares, from PEP 621 `[project]` or Poetry's
 * `[tool.poetry]`. A repository importing its own distribution is importing itself, not a
 * dependency.
 */
export function parsePyprojectName(raw: string): string | null {
  for (const header of ['project', 'tool.poetry']) {
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(tomlSection(raw, header));
    if (name) return name[1];
  }
  return null;
}

/** Dependencies a `pyproject.toml` declares (PEP 621, extras, dependency groups, Poetry). */
export function parsePyprojectManifest(raw: string): ExternalPackage[] {
  {
    const out: ExternalPackage[] = [];

    // PEP 621: [project] dependencies = ["requests>=2.0", ...]
    const pep621Block = raw.match(/^\[project\]\s*\n([\s\S]*?)(?=^\[)/m);
    const depsMatch = pep621Block
      ? pep621Block[1].match(/^dependencies\s*=\s*\[([^\]]*)\]/m)
      : raw.match(/^dependencies\s*=\s*\[([^\]]*)\]/m);
    if (depsMatch) {
      for (const line of depsMatch[1].split('\n')) {
        const m = line.match(/["']([a-zA-Z0-9_.-]+)([^"']*)?["']/);
        if (m) out.push({ name: m[1], version: m[2]?.trim() ?? '*', ecosystem: 'pypi', isDev: false });
      }
    }

    // PEP 621 extras ([project.optional-dependencies]) and PEP 735 groups ([dependency-groups]):
    // each holds one array of requirements per extra or group name.
    for (const [header, isDev] of [['project.optional-dependencies', false], ['dependency-groups', true]] as const) {
      // `{ include-group = "tests" }` names another group, not a distribution, so it is removed
      // before the requirement strings are read.
      const body = tomlSection(raw, header).replace(/include-group\s*=\s*["'][^"']*["']/g, '');
      for (const m of body.matchAll(/["']([a-zA-Z0-9_.-]+)([^"']*)?["']/g)) {
        out.push({ name: m[1], version: m[2]?.trim() ?? '*', ecosystem: 'pypi', isDev });
      }
    }

    // Poetry: [tool.poetry.dependencies] (prod) and [tool.poetry.dev-dependencies] (dev)
    for (const [section, isDev] of [
      ['tool.poetry.dependencies', false],
      ['tool.poetry.dev-dependencies', true],
      ['tool.poetry.group.dev.dependencies', true],
    ] as const) {
      for (const line of tomlSection(raw, section).split('\n')) {
        const m = line.match(/^(\w[\w-]*)\s*=\s*["']([^"']+)["']/);
        // skip python version constraint line
        if (m && m[1] !== 'python') { out.push({ name: m[1], version: m[2], ecosystem: 'pypi', isDev }); continue; }
        // An inline table declares the dependency too: `foo = { version = "1.0", extras = [...] }`.
        const inline = line.match(/^(\w[\w-]*)\s*=\s*\{/);
        if (inline && inline[1] !== 'python') {
          const version = /version\s*=\s*["']([^"']+)["']/.exec(line);
          out.push({ name: inline[1], version: version?.[1] ?? '*', ecosystem: 'pypi', isDev });
        }
      }
    }

    return out;
  }
}

async function parsePyproject(rootDir: string): Promise<ExternalPackage[]> {
  try {
    return parsePyprojectManifest(await readFile(join(rootDir, 'pyproject.toml'), 'utf-8'));
  } catch { return []; }
}

/** Requirements a `requirements.txt`-style file pins, one per line. */
export function parseRequirementsManifest(raw: string): ExternalPackage[] {
  const out: ExternalPackage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const m = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*([>=<!][^\s;#]*)?/);
    if (m) out.push({ name: m[1], version: m[2]?.trim() ?? '*', ecosystem: 'pypi', isDev: false });
  }
  return out;
}

/** The `requirements*.txt` paths, relative to a directory, that {@link extractExternalPackages} reads. */
export const REQUIREMENTS_CANDIDATES: readonly string[] = [
  'requirements.txt', 'requirements/base.txt', 'requirements/prod.txt', 'requirements/dev.txt',
];

async function parseRequirements(rootDir: string): Promise<ExternalPackage[]> {
  const out: ExternalPackage[] = [];
  for (const candidate of REQUIREMENTS_CANDIDATES) {
    try {
      out.push(...parseRequirementsManifest(await readFile(join(rootDir, candidate), 'utf-8')));
    } catch { /* file absent */ }
  }
  return out;
}

/** Dependencies a `Cargo.toml` declares, including build and workspace sections. */
export function parseCargoManifest(raw: string): ExternalPackage[] {
  {
    const out: ExternalPackage[] = [];
    // A dependency declared in any of these sections is declared; `[workspace.dependencies]` is how
    // a Cargo workspace declares versions its members inherit with `pkg.workspace = true`.
    for (const [section, isDev] of [
      ['dependencies', false], ['dev-dependencies', true], ['build-dependencies', true],
      ['workspace.dependencies', false],
    ] as const) {
      for (const line of tomlSection(raw, section).split('\n')) {
        const simple = line.match(/^(\w[\w-]*)\s*=\s*["']([^"']+)["']/);
        if (simple) { out.push({ name: simple[1], version: simple[2], ecosystem: 'cargo', isDev }); continue; }
        const inline = line.match(/^(\w[\w-]*)\s*=\s*\{[^}]*version\s*=\s*["']([^"']+)["']/);
        if (inline) out.push({ name: inline[1], version: inline[2], ecosystem: 'cargo', isDev });
        // `pkg = { workspace = true }` inherits the workspace's version; the name is still declared.
        const inherited = line.match(/^(\w[\w-]*)\s*=\s*\{[^}]*workspace\s*=\s*true/);
        if (inherited && !out.some(p => p.name === inherited[1])) {
          out.push({ name: inherited[1], version: 'workspace', ecosystem: 'cargo', isDev });
        }
      }
    }
    return out;
  }
}

async function parseCargo(rootDir: string): Promise<ExternalPackage[]> {
  try {
    return parseCargoManifest(await readFile(join(rootDir, 'Cargo.toml'), 'utf-8'));
  } catch { return []; }
}

/** Modules a `go.mod` requires. */
export function parseGoModManifest(raw: string): ExternalPackage[] {
  {
    const out: ExternalPackage[] = [];
    let inRequire = false;
    for (const line of raw.split('\n')) {
      if (line.match(/^require\s*\(/)) { inRequire = true; continue; }
      if (inRequire && line.trim() === ')') { inRequire = false; continue; }
      const singleReq = line.match(/^require\s+(\S+)\s+(\S+)/);
      if (singleReq) { out.push({ name: singleReq[1], version: singleReq[2], ecosystem: 'go', isDev: false }); continue; }
      if (inRequire) {
        const m = line.trim().match(/^(\S+)\s+(\S+)/);
        if (m && !m[1].startsWith('//')) {
          out.push({ name: m[1], version: m[2], ecosystem: 'go', isDev: false });
        }
      }
    }
    return out;
  }
}

async function parseGoMod(rootDir: string): Promise<ExternalPackage[]> {
  try {
    return parseGoModManifest(await readFile(join(rootDir, 'go.mod'), 'utf-8'));
  } catch { return []; }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export interface ExternalPackageSummary {
  total: number;
  byEcosystem: Partial<Record<PackageEcosystem, number>>;
  packages: ExternalPackage[];
}

export async function extractExternalPackages(rootDir: string): Promise<ExternalPackageSummary> {
  const results = await Promise.all([
    parseNpm(rootDir),
    parsePyproject(rootDir),
    parseRequirements(rootDir),
    parseCargo(rootDir),
    parseGoMod(rootDir),
  ]);

  // Deduplicate by name+ecosystem
  const seen = new Set<string>();
  const packages: ExternalPackage[] = [];
  for (const batch of results) {
    for (const pkg of batch) {
      const key = `${pkg.ecosystem}:${pkg.name}`;
      if (!seen.has(key)) { seen.add(key); packages.push(pkg); }
    }
  }

  const byEcosystem: Partial<Record<PackageEcosystem, number>> = {};
  for (const pkg of packages) {
    byEcosystem[pkg.ecosystem] = (byEcosystem[pkg.ecosystem] ?? 0) + 1;
  }

  return { total: packages.length, byEcosystem, packages };
}
