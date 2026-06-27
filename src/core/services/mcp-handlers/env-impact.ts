/**
 * `analyze_env_impact` MCP handler (change: add-env-config-impact-graph).
 *
 * The `get_env_vars` inventory answers *which* env vars a project declares or
 * reads. It is silent on the question an agent asks before touching config:
 * **"if I remove or rename this env var, what breaks?"** This tool answers that as
 * a conclusion: given an env var `name`, it returns the line-precise read sites,
 * the functions and tests reachable from those reads (the blast radius), whether
 * the var is declared with a default, and the honesty `boundaries` that make the
 * result a sound lower bound.
 *
 * It is the configuration analogue of `analyze_impact` (blast radius of a function
 * change) and `analyze_error_propagation` (exceptions that escape a function).
 * Computed live from the cached call graph (function spans + backward adjacency)
 * plus a re-read of only the files the inventory associates with the var — the
 * `find_clones` / `analyze_error_propagation` precedent: no new persisted artifact,
 * no schema migration, no edit to the analyze walk.
 *
 * Scope: environment variables in TypeScript / JavaScript / Python / Go / Ruby —
 * exactly the read patterns the env extractor supports. Config-object key reads are
 * a disclosed out-of-scope boundary, never guessed.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateDirectory, readCachedContext } from './utils.js';
import { buildAdjacency } from './graph.js';
import { computeStaleness } from './confidence-boundary.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ENV_INVENTORY } from '../../../constants.js';
import { extractEnvReadSites, type EnvVar, type EnvReadSite } from '../../analyzer/env-extractor.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';

export interface AnalyzeEnvImpactInput {
  directory: string;
  /** The environment variable to analyze, e.g. DATABASE_URL. */
  name?: string;
  /** Backward-reachability depth bound (default 12, clamped to [1, 30]). */
  maxDepth?: number;
}

const DEFAULT_DEPTH = 12;
const MIN_DEPTH = 1;
const MAX_DEPTH = 30;
/** Cap the blast-radius and test lists so a hub read does not flood the payload. */
const MAX_LIST = 200;

/** A read site mapped to its enclosing function (or module-level). */
interface ResolvedReadSite {
  file: string;
  line: number;
  required: boolean;
  /** Enclosing function `name::file`, or null for a module-level read. */
  enclosingFunction: string | null;
}

const labelOf = (n: FunctionNode): string => `${n.name}::${n.filePath}`;

/** Load the env inventory: the cached artifact, else a live re-extraction. */
async function loadInventory(absDir: string): Promise<EnvVar[] | null> {
  const artifactPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ENV_INVENTORY);
  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as EnvVar[];
  } catch {
    // fall through to live extraction
  }
  try {
    const { extractEnvVars } = await import('../../analyzer/env-extractor.js');
    const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
    const { readOpenLoreConfig } = await import('../config-manager.js');
    const cfg = await readOpenLoreConfig(absDir);
    const exclude = cfg?.analysis.excludePatterns ?? [];
    const mapper = new RepositoryMapper(absDir, { excludePatterns: exclude.length > 0 ? exclude : undefined });
    const repoMap = await mapper.map();
    return await extractEnvVars(repoMap.allFiles.map(f => f.path), absDir);
  } catch {
    return null;
  }
}

/**
 * Compute the impact of removing/renaming an env var. Read-only, deterministic,
 * offline. Returns `unknown` (additive-by-cast), conclusion-shaped — read sites +
 * blast radius + reaching tests + disclosed boundaries, never a graph.
 */
export async function handleAnalyzeEnvImpact(input: AnalyzeEnvImpactInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { error: 'Provide `name` — an environment variable, e.g. DATABASE_URL.' };

  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;

  const inventory = await loadInventory(absDir);
  if (!inventory) return { error: 'Environment-variable inventory unavailable. Run analyze_codebase first.' };

  // ── Resolve the var (exact, case-sensitive — env vars are case-sensitive) ────
  const entry = inventory.find(v => v.name === name);
  if (!entry) {
    const upper = name.toUpperCase();
    const allNames = inventory.map(v => v.name).sort();
    const fuzzy = allNames.filter(n => n.toUpperCase().includes(upper) || upper.includes(n.toUpperCase()));
    // A single-letter typo (DATABSE_URL) matches no substring — fall back to the
    // full inventory so the real variable is always surfaced, never a dead end.
    const candidates = (fuzzy.length ? fuzzy : allNames).slice(0, 10);
    return {
      error: `No environment variable "${name}" in the inventory.`,
      candidates,
      hint: candidates.length
        ? (fuzzy.length ? 'Did you mean one of these?' : 'Not in the inventory. Known variables include:')
        : 'No environment variables in the inventory. Run analyze_codebase first.',
    };
  }

  const boundaries = new Set<string>();
  const depthBound = Number.isFinite(input.maxDepth as number)
    ? Math.max(MIN_DEPTH, Math.min(input.maxDepth as number, MAX_DEPTH))
    : DEFAULT_DEPTH;

  // ── Re-scan only the files the inventory flags for this var, line-precise ────
  const rawSites: EnvReadSite[] = [];
  for (const rel of entry.files) {
    const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.')).toLowerCase() : '';
    let source: string;
    try {
      source = await readFile(join(absDir, rel), 'utf-8');
    } catch {
      boundaries.add(`source unreadable since analysis — re-run analyze_codebase (${rel})`);
      continue;
    }
    for (const s of extractEnvReadSites(source, rel, ext)) {
      if (s.name === name) rawSites.push(s);
    }
  }

  // ── Map each read site to its enclosing function by line containment ─────────
  // Group code nodes by file for O(reads × nodes-in-file) containment.
  const nodesByFile = new Map<string, FunctionNode[]>();
  for (const n of cg.nodes) {
    if (n.isExternal) continue;
    const arr = nodesByFile.get(n.filePath);
    if (arr) arr.push(n);
    else nodesByFile.set(n.filePath, [n]);
  }

  const resolvedSites: ResolvedReadSite[] = [];
  const readingFnIds = new Set<string>();
  let moduleLevelCount = 0;
  for (const s of rawSites) {
    const candidates = nodesByFile.get(s.file) ?? [];
    let best: FunctionNode | undefined;
    for (const n of candidates) {
      if (n.startLine === undefined || n.endLine === undefined) continue;
      if (n.startLine <= s.line && s.line <= n.endLine) {
        if (!best || (n.endLine - n.startLine) < (best.endLine! - best.startLine!)) best = n;
      }
    }
    if (best) {
      resolvedSites.push({ file: s.file, line: s.line, required: s.required, enclosingFunction: labelOf(best) });
      readingFnIds.add(best.id);
    } else {
      resolvedSites.push({ file: s.file, line: s.line, required: s.required, enclosingFunction: null });
      moduleLevelCount++;
    }
  }
  resolvedSites.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || (a.enclosingFunction ?? '').localeCompare(b.enclosingFunction ?? ''));

  if (moduleLevelCount > 0) {
    boundaries.add(
      `${moduleLevelCount} read site(s) are module-level (outside any function) — they execute at ` +
        'import time, so the effective blast radius is every importer of that module, beyond the ' +
        'call-graph callers reported here.',
    );
  }

  // Honesty: read-site LINES come from the current source (re-read above) but are
  // mapped to enclosing functions via the CACHED graph's line spans. If source
  // changed since `analyze`, a read can be attributed to the wrong function — or,
  // if its new line falls outside every stale span, FALSELY reported module-level.
  // Disclose the staleness (git-based, same signal the other conclusion tools use)
  // rather than presenting a possibly-misattributed result as clean.
  const staleness = await computeStaleness(absDir);
  if (staleness) {
    boundaries.add(
      `Index may be stale: ${staleness.detail} Read-site lines come from the current source but are ` +
        'mapped to functions via the cached spans, so enclosing-function attribution (and any ' +
        'module-level classification) may be off until you re-run analyze_codebase.',
    );
  }

  // ── Blast radius: backward BFS from each reading function ────────────────────
  const { nodeMap, backward } = buildAdjacency(cg);
  const distOf = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [];
  for (const id of readingFnIds) { distOf.set(id, 0); queue.push({ id, depth: 0 }); }
  while (queue.length) {
    const { id, depth } = queue.shift()!;
    if (depth >= depthBound) { boundaries.add(`backward traversal bounded at depth ${depthBound}; deeper callers not enumerated`); continue; }
    for (const caller of [...(backward.get(id) ?? [])].sort()) {
      if (!distOf.has(caller)) { distOf.set(caller, depth + 1); queue.push({ id: caller, depth: depth + 1 }); }
    }
  }

  const affectedFunctions: Array<{ symbol: string; file: string; distance: number }> = [];
  const reachingTests: Array<{ test: string; file: string }> = [];
  for (const [id, dist] of distOf) {
    if (dist === 0) continue; // the reading function itself, not an upstream caller
    const n = nodeMap.get(id);
    if (!n || n.isExternal) continue;
    if (n.isTest) reachingTests.push({ test: n.name, file: n.filePath });
    else affectedFunctions.push({ symbol: labelOf(n), file: n.filePath, distance: dist });
  }
  affectedFunctions.sort((a, b) => a.distance - b.distance || a.symbol.localeCompare(b.symbol));
  reachingTests.sort((a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test));

  // Affected files = files of reading functions ∪ files of affected callers.
  const affectedFiles = new Set<string>();
  for (const s of resolvedSites) affectedFiles.add(s.file);
  for (const f of affectedFunctions) affectedFiles.add(f.file);

  const requiredSites = resolvedSites.filter(s => s.required).length;
  if (resolvedSites.length === 0) {
    boundaries.add(
      'No source read sites found — the variable is declared (e.g. in an .env file) but not read in ' +
        'a supported language (TS/JS/Python/Go/Ruby), or only read in test files (excluded). It may ' +
        'still be consumed by tooling/runtime outside static reach.',
    );
  }
  boundaries.add(
    'Config-object key reads (config.x.y, a parsed settings tree) are OUT OF SCOPE — only environment ' +
      'variable reads are analyzed.',
  );
  boundaries.add(
    'Blast radius is a SOUND LOWER BOUND over the call graph: dynamic dispatch, reflection, and ' +
      'externally-consumed exports can add callers not enumerated here.',
  );

  return {
    variable: {
      name,
      required: entry.required,
      hasDefault: entry.hasDefault,
      declaredInEnvFile: entry.hasDefault,
      ...(entry.description ? { description: entry.description } : {}),
      files: entry.files,
    },
    summary: {
      readSites: resolvedSites.length,
      requiredReadSites: requiredSites,
      moduleLevelReadSites: moduleLevelCount,
      readingFunctions: readingFnIds.size,
      affectedFunctions: affectedFunctions.length,
      affectedFiles: affectedFiles.size,
      reachingTests: reachingTests.length,
    },
    readSites: resolvedSites,
    affectedFunctions: affectedFunctions.slice(0, MAX_LIST),
    reachingTests: reachingTests.slice(0, MAX_LIST),
    affectedFiles: [...affectedFiles].sort(),
    ...(affectedFunctions.length > MAX_LIST ? { affectedFunctionsTruncated: affectedFunctions.length - MAX_LIST } : {}),
    ...(reachingTests.length > MAX_LIST ? { reachingTestsTruncated: reachingTests.length - MAX_LIST } : {}),
    ...(staleness ? { staleness } : {}),
    boundaries: [...boundaries].sort(),
    note:
      'readSites = where this env var is read (file/line/enclosing function; module-level = read at ' +
      'import time). affectedFunctions = upstream callers that transitively reach a read (the blast ' +
      'radius). reachingTests = tests to run. requiredReadSites = reads with no site-local fallback ' +
      '(a hard break if the var is removed). Computed live from the cached graph + a re-read of the ' +
      "var's files — re-run analyze_codebase after edits.",
  };
}
