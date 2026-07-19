/**
 * `openlore manifest emit` — write `.well-known/openlore.json`.
 *
 * A pure file-emission feature: it reads the analysis artifacts OpenLore has
 * already produced plus local git state, and writes a small, public,
 * deterministic self-description. No network, no graph-schema changes.
 *
 * Determinism: `generated_at` is the HEAD commit date (not wall-clock), and all
 * arrays are sorted, so re-emitting on the same graph + commit is byte-stable.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { logger } from '../../utils/logger.js';
import { readCachedContext } from '../../core/services/mcp-handlers/utils.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_ROUTE_INVENTORY,
} from '../../constants.js';
import type { FunctionNode, SerializedCallGraph } from '../../core/analyzer/call-graph.js';
import { derivePublicSymbols, type ExportEntry, type PublicSymbol } from './detect/public-symbols.js';
import { deriveHttpRoutes, type ManifestRoute, type RouteInventoryEntry } from './detect/http-routes.js';
import {
  deriveEventsEmitted,
  deriveEventsConsumed,
  deriveRpcEndpoints,
  type ManifestEvent,
  type ManifestConsumedEvent,
  type ManifestRpcEndpoint,
} from './detect/events.js';

export const MANIFEST_VERSION = 1;
const SCHEMA_URL = 'https://raw.githubusercontent.com/clay-good/OpenLore/main/schemas/openlore-manifest-v1.json';

const require = createRequire(import.meta.url);

export interface ManifestEmitOptions {
  out?: string;
  projectRoot?: string;
  includePrivate?: boolean;
  maxSymbols?: number;
  dryRun?: boolean;
}

export interface Manifest {
  $schema: string;
  openlore_manifest_version: number;
  generated_at: string;
  generator: { name: string; version: string };
  repo: { name: string; git_remote: string | null; git_commit: string | null; default_branch: string | null };
  languages: Array<{ name: string; files: number; functions: number }>;
  stats: { functions: number; files: number; modules: number; avg_mccabe: number; clusters: number };
  exports: {
    truncated?: boolean;
    public_symbols: PublicSymbol[];
    http_routes: ManifestRoute[];
    rpc_endpoints: ManifestRpcEndpoint[];
    events_emitted: ManifestEvent[];
    events_consumed: ManifestConsumedEvent[];
  };
  imports: { external_packages: Array<{ name: string; version_range: string | null }> };
  specs: { count: number; drift_state: 'clean' | 'drifted' | 'unverified' };
  links: { repo: string | null; docs: string | null };
}

// ── git helpers (all best-effort; never throw) ─────────────────────────────

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Convert a git remote (ssh or https) to a browseable https URL, sans `.git`. */
function normalizeRemoteToWebUrl(remote: string | null): string | null {
  if (!remote) return null;
  let url = remote.trim().replace(/\.git$/, '');
  const ssh = url.match(/^git@([^:]+):(.+)$/);
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
  url = url.replace(/^ssh:\/\/git@/, 'https://');
  return url;
}

function detectDefaultBranch(cwd: string): string | null {
  const originHead = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead) return originHead.replace(/^origin\//, '');
  for (const candidate of ['main', 'master']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', candidate]) !== null) return candidate;
  }
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

// ── artifact loading ────────────────────────────────────────────────────────

interface DependencyGraphNode {
  file?: { path?: string };
  exports?: ExportEntry[];
}

/** repo-relative file path → its top-level exports (from dependency-graph.json). */
function loadExportsByFile(analysisDir: string): Map<string, ExportEntry[]> {
  const map = new Map<string, ExportEntry[]>();
  const file = join(analysisDir, ARTIFACT_DEPENDENCY_GRAPH);
  if (!existsSync(file)) return map;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as { nodes?: DependencyGraphNode[] };
    for (const node of data.nodes ?? []) {
      const path = node.file?.path;
      if (path && Array.isArray(node.exports)) map.set(path, node.exports);
    }
  } catch {
    // tolerate a malformed/partial artifact — emit what we can
  }
  return map;
}

function loadRoutes(analysisDir: string): RouteInventoryEntry[] {
  const file = join(analysisDir, ARTIFACT_ROUTE_INVENTORY);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as { routes?: RouteInventoryEntry[] };
    return data.routes ?? [];
  } catch {
    return [];
  }
}

function countSpecs(projectRoot: string): number {
  try {
    // glob is already a dependency; use sync matching against openspec/specs.
    const specsDir = join(projectRoot, 'openspec', 'specs');
    if (!existsSync(specsDir)) return 0;
    const { globSync } = require('glob') as typeof import('glob');
    return globSync('*/spec.md', { cwd: specsDir }).length;
  } catch {
    return 0;
  }
}

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: unknown;
}

/**
 * Map package entry points (dist build outputs) back to their TS/JS source
 * files, restricted to those the dependency graph actually knows about. These
 * define the default "public" surface.
 */
function entrySourceFiles(pkg: PackageJson | null, exportsByFile: Map<string, ExportEntry[]>): string[] {
  if (!pkg) return [];
  const dist: string[] = [];
  if (typeof pkg.main === 'string') dist.push(pkg.main);
  if (typeof pkg.module === 'string') dist.push(pkg.module);
  const collect = (node: unknown): void => {
    if (typeof node === 'string') dist.push(node);
    else if (node && typeof node === 'object') for (const v of Object.values(node)) collect(v);
  };
  collect(pkg.exports);

  const toSrc = (p: string): string => p.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.(js|d\.ts)$/, '.ts');
  const candidates = new Set(dist.map(toSrc));
  return [...candidates].filter(f => exportsByFile.has(f)).sort();
}

function readPackageJson(projectRoot: string): PackageJson | null {
  const path = join(projectRoot, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function toolVersion(): string {
  return (require('../../../package.json') as { version: string }).version;
}

// ── stats / languages ────────────────────────────────────────────────────────

function computeStats(graph: SerializedCallGraph): Manifest['stats'] {
  const real = graph.nodes.filter(n => !n.isExternal);
  const files = new Set(real.map(n => n.filePath));
  const clusters = new Set(real.map(n => n.communityId).filter((c): c is string => !!c));
  const mccabe = real.map(n => n.cyclomaticComplexity).filter((c): c is number => typeof c === 'number');
  const avg = mccabe.length ? mccabe.reduce((a, b) => a + b, 0) / mccabe.length : 0;
  return {
    functions: real.length,
    files: files.size,
    modules: graph.classes.length,
    avg_mccabe: Math.round(avg * 10) / 10,
    clusters: clusters.size,
  };
}

function computeLanguages(nodes: FunctionNode[]): Manifest['languages'] {
  const byLang = new Map<string, { files: Set<string>; functions: number }>();
  for (const n of nodes) {
    if (n.isExternal) continue;
    const lang = n.language.toLowerCase();
    let entry = byLang.get(lang);
    if (!entry) { entry = { files: new Set(), functions: 0 }; byLang.set(lang, entry); }
    entry.files.add(n.filePath);
    entry.functions++;
  }
  return [...byLang.entries()]
    .map(([name, v]) => ({ name, files: v.files.size, functions: v.functions }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── external packages ─────────────────────────────────────────────────────────
// TODO(spec-05-followup): first_use requires persisted per-file import sources
// from the analyzer (not currently surfaced), so it is omitted here.

function deriveExternalPackages(pkg: ReturnType<typeof readPackageJson>): Manifest['imports']['external_packages'] {
  if (!pkg) return [];
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  return Object.entries(deps)
    .map(([name, version_range]) => ({ name, version_range: version_range ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── manifest assembly ─────────────────────────────────────────────────────────

export interface ManifestInputs {
  projectRoot: string;
  graph: SerializedCallGraph;
  exportsByFile: Map<string, ExportEntry[]>;
  routes: RouteInventoryEntry[];
  pkg: ReturnType<typeof readPackageJson>;
  specCount: number;
  git: {
    remote: string | null;
    commit: string | null;
    defaultBranch: string | null;
    committedAt: string | null;
  };
  toolVersion: string;
  hasDocs: boolean;
}

/** Build the manifest object (pure — all I/O is done by the caller). */
export function buildManifest(inputs: ManifestInputs, opts: ManifestEmitOptions): Manifest {
  const repoWebUrl = normalizeRemoteToWebUrl(inputs.git.remote);
  const repoName =
    inputs.pkg?.name ??
    (repoWebUrl ? basename(repoWebUrl) : basename(inputs.projectRoot));

  let publicSymbols = derivePublicSymbols({
    nodes: inputs.graph.nodes,
    classes: inputs.graph.classes,
    exportsByFile: inputs.exportsByFile,
    entryFiles: entrySourceFiles(inputs.pkg, inputs.exportsByFile),
    includePrivate: opts.includePrivate ?? false,
  });
  let truncated = false;
  if (typeof opts.maxSymbols === 'number' && publicSymbols.length > opts.maxSymbols) {
    publicSymbols = publicSymbols.slice(0, opts.maxSymbols);
    truncated = true;
  }

  return {
    $schema: SCHEMA_URL,
    openlore_manifest_version: MANIFEST_VERSION,
    // Commit date keeps the manifest byte-stable per commit; fall back to epoch
    // when git is unavailable (still deterministic, never wall-clock).
    generated_at: inputs.git.committedAt ?? '1970-01-01T00:00:00Z',
    generator: { name: 'openlore', version: inputs.toolVersion },
    repo: {
      name: repoName,
      git_remote: inputs.git.remote,
      git_commit: inputs.git.commit,
      default_branch: inputs.git.defaultBranch,
    },
    languages: computeLanguages(inputs.graph.nodes),
    stats: computeStats(inputs.graph),
    exports: {
      ...(truncated ? { truncated: true } : {}),
      public_symbols: publicSymbols,
      http_routes: deriveHttpRoutes(inputs.routes),
      rpc_endpoints: deriveRpcEndpoints(),
      events_emitted: deriveEventsEmitted(),
      events_consumed: deriveEventsConsumed(),
    },
    imports: { external_packages: deriveExternalPackages(inputs.pkg) },
    specs: { count: inputs.specCount, drift_state: 'unverified' },
    links: {
      repo: repoWebUrl,
      docs: inputs.hasDocs && repoWebUrl ? `${repoWebUrl}/tree/${inputs.git.defaultBranch ?? 'main'}/docs` : null,
    },
  };
}

/** Serialize a manifest to the exact bytes written to disk. */
export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

export async function runManifestEmit(opts: ManifestEmitOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const analysisDir = join(projectRoot, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  const ctx = await readCachedContext(projectRoot);
  const graph = ctx?.callGraph;
  if (!graph || graph.nodes.length === 0) {
    logger.error('No analysis graph found. Run `openlore analyze` first.');
    return 2;
  }

  const manifest = buildManifest(
    {
      projectRoot,
      graph,
      exportsByFile: loadExportsByFile(analysisDir),
      routes: loadRoutes(analysisDir),
      pkg: readPackageJson(projectRoot),
      specCount: countSpecs(projectRoot),
      git: {
        remote: git(projectRoot, ['config', '--get', 'remote.origin.url']),
        commit: git(projectRoot, ['rev-parse', '--short', 'HEAD']),
        defaultBranch: detectDefaultBranch(projectRoot),
        committedAt: git(projectRoot, ['show', '-s', '--format=%cI', 'HEAD']),
      },
      toolVersion: toolVersion(),
      hasDocs: existsSync(join(projectRoot, 'docs')),
    },
    opts
  );

  const outPath = resolve(opts.out ?? join(projectRoot, '.well-known', 'openlore.json'));
  const bytes = serializeManifest(manifest);

  if (opts.dryRun) {
    // Preview only: never touch the working tree (manifest emit writes into the
    // repo, so a dry run lets a user see the destination and size first).
    logger.success(`Dry run — would write ${outPath} (${Buffer.byteLength(bytes)} bytes); nothing written`);
  } else {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, bytes);
    logger.success(`Wrote ${outPath} (${Buffer.byteLength(bytes)} bytes)`);
  }
  logger.info('public symbols', manifest.exports.public_symbols.length + (manifest.exports.truncated ? ' (truncated)' : ''));
  logger.info('http routes', manifest.exports.http_routes.length);
  logger.info('external packages', manifest.imports.external_packages.length);
  if (manifest.exports.events_emitted.length === 0 && manifest.exports.rpc_endpoints.length === 0) {
    logger.info('events / rpc', 'none detected (analyzer does not surface these yet)');
  }

  return 0;
}
