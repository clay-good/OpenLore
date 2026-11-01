/**
 * Which package names a lockfile pins (change: add-phantom-reference-findings).
 *
 * A dependency added to a manifest but never installed is a reference that resolves nowhere at
 * build time: the manifest declares it, the lockfile does not pin it, and CI fails on a clean
 * install. The check needs one question answered per ecosystem — "does this lockfile pin a package
 * of this name?" — so each reader returns the NAME SET only. Versions, integrity hashes, and
 * resolution trees are deliberately not modelled.
 *
 * Every reader is pure and returns `null` when it cannot understand the file, because
 * "this lockfile pins nothing" and "this lockfile could not be read" lead a reader to opposite
 * conclusions, and only the first may produce a finding.
 */

import { parse as parseYaml } from 'yaml';
import type { PackageEcosystem } from './external-packages.js';

/** The lockfiles each ecosystem's manifests are paired with, in the order they are looked for. */
export const ECOSYSTEM_LOCKFILES: Readonly<Record<PackageEcosystem, readonly string[]>> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'],
  pypi: ['poetry.lock', 'uv.lock', 'pdm.lock', 'Pipfile.lock', 'requirements.lock'],
  cargo: ['Cargo.lock'],
  go: ['go.sum'],
};

/**
 * Compare two package names of one ecosystem as the ecosystem itself does: Python distribution
 * names are case-insensitive with `-`, `_` and `.` equivalent (PEP 503), and Cargo crate names are
 * written with `-` in a manifest and `_` in a `use` path. npm and Go names are exact.
 */
export function normalizePackageName(ecosystem: PackageEcosystem, name: string): string {
  switch (ecosystem) {
    case 'pypi':
      return name.toLowerCase().replace(/[-_.]+/g, '-');
    case 'cargo':
      return name.toLowerCase().replace(/_/g, '-');
    default:
      return name;
  }
}

/** npm package name from a `package-lock.json` tree path (`node_modules/a/node_modules/@s/b` → `@s/b`). */
function npmNameFromTreePath(path: string): string | null {
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  const name = path.slice(at + marker.length);
  return name.length ? name : null;
}

/** Strip a pnpm/yarn version suffix: `foo@1.2.3` → `foo`, `@scope/pkg@npm:1.0.0` → `@scope/pkg`. */
function stripVersionSuffix(spec: string): string | null {
  let body = spec.startsWith('/') ? spec.slice(1) : spec;
  // A pnpm peer suffix (`foo@1.0.0(bar@2.0.0)`) holds `@` of its own, so it goes before the version
  // separator is looked for — otherwise the cut lands inside the parenthesis.
  const paren = body.indexOf('(');
  if (paren !== -1) body = body.slice(0, paren);
  // A scoped name's own leading `@` is not a separator, so search from the second character.
  const at = body.lastIndexOf('@');
  const name = at > 0 ? body.slice(0, at) : body;
  return !name || name.startsWith('.') ? null : name;
}

function pinsFromPackageLock(text: string): Set<string> | null {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return null; }
  if (doc === null || typeof doc !== 'object') return null;
  const out = new Set<string>();
  const { packages, dependencies } = doc as { packages?: unknown; dependencies?: unknown };
  // Lockfile v2/v3: `packages` keyed by tree path. The root package has the key "".
  if (packages && typeof packages === 'object') {
    for (const key of Object.keys(packages)) {
      const name = npmNameFromTreePath(key);
      if (name) out.add(name);
    }
  }
  // Lockfile v1: a recursive `dependencies` map keyed by name.
  const walk = (node: unknown, depth: number) => {
    if (depth > 20 || !node || typeof node !== 'object') return;
    for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
      out.add(name);
      const nested = (child as { dependencies?: unknown })?.dependencies;
      if (nested) walk(nested, depth + 1);
    }
  };
  if (dependencies && typeof dependencies === 'object') walk(dependencies, 0);
  return packages || dependencies ? out : null;
}

function pinsFromPnpmLock(text: string): Set<string> | null {
  let doc: unknown;
  try { doc = parseYaml(text); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  const out = new Set<string>();
  let sawSection = false;
  // `packages` (every version) and, from lockfile v9, `snapshots`.
  for (const section of ['packages', 'snapshots'] as const) {
    const node = (doc as Record<string, unknown>)[section];
    if (!node || typeof node !== 'object') continue;
    sawSection = true;
    for (const key of Object.keys(node)) {
      const name = stripVersionSuffix(key);
      if (name) out.add(name);
    }
  }
  // A workspace-only lockfile has `importers` but no package of its own.
  if (!sawSection && 'importers' in (doc as Record<string, unknown>)) sawSection = true;
  return sawSection ? out : null;
}

function pinsFromYarnLock(text: string): Set<string> | null {
  const out = new Set<string>();
  let sawEntry = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // An entry header starts at column 0 and ends with a colon; one header may list several specs.
    if (line === '' || /^[\s#]/.test(line) || !line.endsWith(':')) continue;
    const header = line.slice(0, -1);
    if (header === '__metadata' || header.startsWith('"__metadata')) continue;
    for (const spec of header.split(',')) {
      const name = stripVersionSuffix(spec.trim().replace(/^["']|["']$/g, ''));
      if (name) { out.add(name); sawEntry = true; }
    }
  }
  return sawEntry ? out : null;
}

/** TOML lockfiles (Cargo, poetry, uv, pdm) list `[[package]]` blocks with a `name` key. */
function pinsFromTomlPackages(text: string): Set<string> | null {
  const out = new Set<string>();
  let inPackage = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line.startsWith('[[')) { inPackage = /^\[\[\s*package\s*\]\]/.test(line); continue; }
    if (line.startsWith('[')) { inPackage = false; continue; }
    if (!inPackage) continue;
    const m = /^name\s*=\s*["']([^"']+)["']/.exec(line);
    if (m) out.add(m[1]);
  }
  return out.size ? out : null;
}

function pinsFromPipfileLock(text: string): Set<string> | null {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  const out = new Set<string>();
  let sawSection = false;
  for (const section of ['default', 'develop']) {
    const node = (doc as Record<string, unknown>)[section];
    if (!node || typeof node !== 'object') continue;
    sawSection = true;
    for (const name of Object.keys(node)) out.add(name);
  }
  return sawSection ? out : null;
}

function pinsFromGoSum(text: string): Set<string> | null {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    // `module version h1:hash` — three fields, the hash marked by its algorithm prefix.
    if (parts.length < 3 || !/^[a-z0-9]+:/.test(parts[2])) return null;
    out.add(parts[0]);
  }
  return out.size ? out : null;
}

/**
 * The package names a lockfile pins, or `null` when the file is not a lockfile this reader
 * understands or could not be parsed. `lockfileName` is the file's base name.
 */
export function pinnedNames(lockfileName: string, text: string): Set<string> | null {
  switch (lockfileName) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return pinsFromPackageLock(text);
    case 'pnpm-lock.yaml':
      return pinsFromPnpmLock(text);
    case 'yarn.lock':
    case 'bun.lock':
      return pinsFromYarnLock(text);
    case 'Cargo.lock':
    case 'poetry.lock':
    case 'uv.lock':
    case 'pdm.lock':
      return pinsFromTomlPackages(text);
    case 'Pipfile.lock':
      return pinsFromPipfileLock(text);
    case 'go.sum':
      return pinsFromGoSum(text);
    default:
      return null;
  }
}

/**
 * Whether a lockfile's pin set covers a package. Go is a prefix match, because an import path
 * (`github.com/x/y/pkg/sub`) is longer than the module path the lockfile pins (`github.com/x/y`);
 * the other ecosystems compare normalized names.
 */
export function pinsPackage(ecosystem: PackageEcosystem, pins: ReadonlySet<string>, name: string): boolean {
  if (ecosystem === 'go') {
    for (const pinned of pins) {
      if (name === pinned || name.startsWith(pinned + '/')) return true;
    }
    return false;
  }
  const wanted = normalizePackageName(ecosystem, name);
  for (const pinned of pins) {
    if (normalizePackageName(ecosystem, pinned) === wanted) return true;
  }
  return false;
}
