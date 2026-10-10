/**
 * Kotlin reference-project conformance model (change: add-kotlin-reference-corpus-conformance).
 *
 * Analyzes a copy of `fixtures/kotlin-reference/` through the real analysis pipeline and exposes
 * the facts the expectations ledger checks. The fixture is parsed only: no Kotlin compiler and no
 * build tool is run.
 */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { openloreAnalyze } from '../../../api/analyze.js';
import { ARTIFACT_PARSE_HEALTH, OPENLORE_DIR } from '../../../constants.js';
import { CallGraphBuilder } from '../call-graph.js';
import type { FunctionCfg } from '../cfg.js';
import { detectLanguage, languageSupport } from '../language-support.js';
import { handleAnalyzeEnvImpact } from '../../services/mcp-handlers/env-impact.js';
import { handleAnalyzeErrorPropagation } from '../../services/mcp-handlers/error-propagation.js';
import { handleFindDeadCode } from '../../services/mcp-handlers/reachability.js';
import { handleCertifyPublicSurface } from '../../services/mcp-handlers/public-surface.js';

export const KOTLIN_REFERENCE_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kotlin-reference',
);

/** Source roots stripped from node ids so ledger entries stay short and readable. */
const SHORT_ROOTS = [
  'src/main/kotlin/com/acme/',
  'src/test/kotlin/com/acme/',
  'src/main/java/com/acme/',
  'src/commonMain/kotlin/com/acme/',
  'src/jvmMain/kotlin/com/acme/',
];

export function shortId(id: string): string {
  for (const root of SHORT_ROOTS) if (id.startsWith(root)) return id.slice(root.length);
  return id;
}

export interface RefNode {
  id: string;
  name: string;
  filePath: string;
  className?: string;
  isExternal?: boolean;
  isTest?: boolean;
  signature?: string;
  docstring?: string;
  language?: string;
  [key: string]: unknown;
}

export interface RefEdge {
  from: string;
  to: string;
  confidence: string;
  kind: string;
}

export interface RefClass {
  name: string;
  filePath?: string;
  parentClasses?: string[];
  interfaces?: string[];
  [key: string]: unknown;
}

export interface KotlinReferenceModel {
  root: string;
  nodes: Map<string, RefNode>;
  edges: RefEdge[];
  classes: RefClass[];
  entryPoints: string[];
  routes: Array<{ method: string; path: string; file: string; framework?: string; handler?: string }>;
  schemas: Array<{ name: string; file: string; fields: string[]; orm?: string }>;
  envVars: Array<{ name: string; files: string[]; required?: boolean }>;
  uiComponents: Array<{ name: string; file: string }>;
  middleware: Array<{ name: string; file: string }>;
  projectType: string;
  frameworks: string[];
  domains: string[];
  /** Repo-relative source files that produced at least one analysis record. */
  analyzedFiles: Set<string>;
  /** `source -> target` file dependency edges that came from an import (not a call edge). */
  importEdges: Array<{ from: string; to: string }>;
  /** Exported symbol names per file, from the dependency graph. */
  exportsByFile: Map<string, string[]>;
  /** The capabilities the language-support registry derives for Kotlin. */
  capabilities: string[];
  /** Control-flow overlays keyed by short node id. */
  cfgs: Map<string, FunctionCfg>;
  /** Repo-relative files that parse-health reports with a syntax error. */
  parseErrorFiles: string[];
  /** The dead-code conclusion for the analyzed copy (computed once, on first use). */
  deadCode: () => Promise<DeadCodeConclusion>;
  /** Repo-relative files with at least one counted operator-dispatch site. */
  operatorBoundaryFiles: () => Promise<string[]>;
  /** Recorded dynamic-boundary sites, as `file::kind` (repo-relative file). */
  dynamicSites: () => Promise<string[]>;
  /** The `analyze_env_impact` conclusion for one variable. */
  envImpact: (name: string) => Promise<Record<string, unknown>>;
  /** The `analyze_error_propagation` conclusion for one symbol (`name::path`). */
  errorPropagation: (symbol: string) => Promise<Record<string, unknown>>;
  /** Names listed by the public-surface conclusion (computed once, on first use). */
  publicSurfaceNames: () => Promise<string[]>;
  /** Raw artifacts, for probes that need a field this model does not lift. */
  raw: { repoStructure: Record<string, unknown>; dependencyGraph: Record<string, unknown>; llmContext: Record<string, unknown> };
}

export interface DeadCodeConclusion {
  candidates: string[];
  /** Candidate id → `high` / `medium` / `low`. */
  confidence: Record<string, string>;
  rootKinds: Record<string, number>;
  /** Repo-relative files that an entry-point adapter names as externally wired. */
  wiredFiles: string[];
}

function once<T>(compute: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => (cached ??= compute());
}

async function sourceFiles(root: string, dir = ''): Promise<Array<{ path: string; content: string; language: string }>> {
  const out: Array<{ path: string; content: string; language: string }> = [];
  for (const item of await readdir(join(root, dir), { withFileTypes: true })) {
    const relative = dir ? `${dir}/${item.name}` : item.name;
    if (item.isDirectory()) {
      if (item.name !== OPENLORE_DIR) out.push(...await sourceFiles(root, relative));
      continue;
    }
    const language = detectLanguage(relative);
    if (language === 'Kotlin' || language === 'Java') {
      out.push({ path: relative, content: await readFile(join(root, relative), 'utf-8'), language });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8')) as unknown;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (value && typeof value === 'object') {
    for (const key of ['routes', 'schemas', 'envVars', 'components', 'middleware', 'items']) {
      const inner = (value as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
    }
  }
  return [];
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Analyze a private copy of the reference project. The caller owns cleanup through the returned
 * `dispose`.
 */
export async function analyzeKotlinReference(): Promise<{ model: KotlinReferenceModel; dispose: () => Promise<void> }> {
  // The canonical path: the analysis artifacts record real paths, and the system temporary
  // directory is a symbolic link on some platforms.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openlore-kotlin-reference-')));
  await cp(KOTLIN_REFERENCE_FIXTURE, root, { recursive: true });
  await mkdir(join(root, OPENLORE_DIR), { recursive: true });
  await writeFile(join(root, OPENLORE_DIR, 'config.json'), JSON.stringify({
    version: '1.0.0', projectType: 'unknown', openspecPath: './openspec',
    analysis: { maxFiles: 100000, includePatterns: [], excludePatterns: [] },
    generation: { model: 'none', domains: 'auto' },
    createdAt: '2026-10-10T00:00:00.000Z', lastRun: null,
  }));
  await openloreAnalyze({ rootPath: root, force: true, quiet: true });

  const out = join(root, OPENLORE_DIR, 'analysis');
  const llmContext = await readJson(join(out, 'llm-context.json')) as Record<string, unknown>;
  const repoStructure = await readJson(join(out, 'repo-structure.json')) as Record<string, unknown>;
  const dependencyGraph = await readJson(join(out, 'dependency-graph.json')) as Record<string, unknown>;
  const inventory = async (name: string): Promise<Array<Record<string, unknown>>> =>
    asArray(await readJson(join(out, name)).catch(() => []));

  const callGraph = (llmContext.callGraph ?? {}) as Record<string, unknown>;
  const nodes = new Map<string, RefNode>();
  for (const raw of asArray(callGraph.nodes)) {
    const node = raw as unknown as RefNode;
    nodes.set(shortId(node.id), { ...node, id: shortId(node.id), filePath: shortId(str(node.filePath)) });
  }
  const edges: RefEdge[] = asArray(callGraph.edges).map(e => ({
    from: shortId(str(e.callerId)),
    to: shortId(str(e.calleeId)),
    confidence: str(e.confidence),
    kind: str(e.kind) || 'calls',
  }));
  const classes = asArray(callGraph.classes).map(c => ({ ...c, filePath: shortId(str(c.filePath)) })) as unknown as RefClass[];
  const entryPoints = asArray(callGraph.entryPoints).map(e => shortId(str(e.id ?? e)));

  const rel = (absolute: string): string =>
    shortId(absolute.startsWith(root) ? absolute.slice(root.length).replace(/^[\\/]+/, '').replaceAll('\\', '/') : absolute);
  const importEdges = asArray(dependencyGraph.edges)
    .filter(e => e.isCallEdge !== true)
    .map(e => ({ from: rel(str(e.source)), to: rel(str(e.target)) }));
  const exportsByFile = new Map<string, string[]>();
  const analyzedFiles = new Set<string>();
  for (const node of asArray(dependencyGraph.nodes)) {
    const file = (node.file ?? {}) as Record<string, unknown>;
    const path = rel(str(file.path) || str(node.id));
    analyzedFiles.add(path);
    const exported = asArray(node.exports).map(x => str(x.name)).filter(Boolean);
    exportsByFile.set(path, exported);
  }

  // Control-flow overlays are not in the JSON artifacts, so they come from a direct build of the
  // same files. Only the overlays are read from it; every other fact is the pipeline's.
  const direct = await new CallGraphBuilder().build(await sourceFiles(root));
  const cfgs = new Map<string, FunctionCfg>();
  for (const [id, cfg] of direct.cfgs ?? []) cfgs.set(shortId(id), cfg);

  const parseHealth = await readJson(join(out, ARTIFACT_PARSE_HEALTH)).catch(() => null) as
    { files?: Array<{ file?: string; path?: string; errorCount?: number; errors?: number }> } | null;
  const parseErrorFiles = (parseHealth?.files ?? [])
    .filter(f => (f.errorCount ?? f.errors ?? 1) > 0)
    .map(f => shortId(str(f.file ?? f.path)));

  const model: KotlinReferenceModel = {
    root,
    nodes,
    edges,
    classes,
    entryPoints,
    routes: (await inventory('route-inventory.json')).map(r => ({
      method: str(r.method).toUpperCase(), path: str(r.path), file: shortId(str(r.file)),
      framework: str(r.framework) || undefined, handler: str(r.handler) || undefined,
    })),
    schemas: (await inventory('schema-inventory.json')).map(s => ({
      name: str(s.name), file: shortId(str(s.file)), orm: str(s.orm) || undefined,
      fields: asArray(s.fields).map(f => str(f.name)),
    })),
    envVars: (await inventory('env-inventory.json')).map(v => ({
      name: str(v.name),
      files: (Array.isArray(v.files) ? v.files as unknown[] : []).map(f => shortId(str(f))),
      required: typeof v.required === 'boolean' ? v.required : undefined,
    })),
    uiComponents: (await inventory('ui-inventory.json')).map(c => ({ name: str(c.name), file: shortId(str(c.file)) })),
    middleware: (await inventory('middleware-inventory.json')).map(m => ({ name: str(m.name), file: shortId(str(m.file)) })),
    projectType: str(repoStructure.projectType),
    frameworks: (Array.isArray(repoStructure.frameworks) ? repoStructure.frameworks as unknown[] : []).map(str),
    domains: asArray(repoStructure.domains).map(d => str(d.name)),
    analyzedFiles,
    importEdges,
    exportsByFile,
    capabilities: [...languageSupport('Kotlin').capabilities],
    cfgs,
    parseErrorFiles,
    deadCode: once(async () => {
      const result = await handleFindDeadCode({ directory: root, maxResults: 1000 }) as Record<string, unknown>;
      const wiring = (result.externalWiring ?? {}) as Record<string, unknown>;
      const idOf = (c: Record<string, unknown>): string =>
        `${shortId(str(c.file))}::${c.className ? `${str(c.className)}.` : ''}${str(c.name)}`;
      return {
        candidates: asArray(result.candidateDead).map(idOf),
        confidence: Object.fromEntries(asArray(result.candidateDead).map(c => [idOf(c), str(c.confidence)])),
        rootKinds: (result.rootKinds ?? {}) as Record<string, number>,
        wiredFiles: asArray(wiring.files).map(f => shortId(str(f.file ?? f.path))),
      };
    }),
    operatorBoundaryFiles: once(async () => {
      const report = await readJson(join(out, 'dynamic-boundary.json')).catch(() => null) as
        { operatorDispatch?: { files?: Array<{ filePath?: string; sites?: number }> } } | null;
      return (report?.operatorDispatch?.files ?? []).filter(f => (f.sites ?? 0) > 0).map(f => shortId(str(f.filePath)));
    }),
    dynamicSites: once(async () => {
      const report = await readJson(join(out, 'dynamic-boundary.json')).catch(() => null) as
        { files?: Array<{ filePath?: string; sites?: Array<{ kind?: string }> }> } | null;
      return (report?.files ?? []).flatMap(f => (f.sites ?? []).map(site => `${shortId(str(f.filePath))}::${str(site.kind)}`));
    }),
    envImpact: async (name: string) => await handleAnalyzeEnvImpact({ directory: root, name }) as Record<string, unknown>,
    errorPropagation: async (symbol: string) => await handleAnalyzeErrorPropagation({ directory: root, symbol }) as Record<string, unknown>,
    publicSurfaceNames: once(async () => {
      const result = await handleCertifyPublicSurface({ directory: root }) as Record<string, unknown>;
      return asArray(result.surface).map(e => str(e.name));
    }),
    raw: { repoStructure, dependencyGraph, llmContext },
  };
  return { model, dispose: () => rm(root, { recursive: true, force: true }) };
}
