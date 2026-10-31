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
  const add = (entries: Record<string, string> | undefined, isDev: boolean, onlyNew = false) => {
    for (const [name, version] of Object.entries(entries ?? {})) {
      if (onlyNew && out.some(p => p.name === name)) continue;
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

/** Dependencies a `pyproject.toml` declares (PEP 621 and Poetry sections). */
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

    // Poetry: [tool.poetry.dependencies] (prod) and [tool.poetry.dev-dependencies] (dev)
    for (const [section, isDev] of [
      ['tool\\.poetry\\.dependencies', false],
      ['tool\\.poetry\\.dev-dependencies', true],
      ['tool\\.poetry\\.group\\.dev\\.dependencies', true],
    ] as const) {
      const block = raw.match(new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\[|$)`));
      if (!block) continue;
      for (const line of block[1].split('\n')) {
        const m = line.match(/^(\w[\w-]*)\s*=\s*["']([^"']+)["']/);
        // skip python version constraint line
        if (m && m[1] !== 'python') out.push({ name: m[1], version: m[2], ecosystem: 'pypi', isDev });
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
      ['workspace\\.dependencies', false],
    ] as const) {
      const block = raw.match(new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\[|$)`));
      if (!block) continue;
      for (const line of block[1].split('\n')) {
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
