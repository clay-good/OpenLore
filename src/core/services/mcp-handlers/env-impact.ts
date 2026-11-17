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
import { readFileConfined } from '../../../utils/path-confinement.js';
import { validateDirectory, readCachedContext, diagnoseIndexUnservable } from './utils.js';
import { loadTraversalIndex } from './traversal.js';
import { computeStaleness } from './confidence-boundary.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ENV_INVENTORY } from '../../../constants.js';
import { extractEnvReadSites, ENV_SOURCE_EXTENSIONS, type EnvVar, type EnvReadSite } from '../../analyzer/env-extractor.js';
import { scanEnvHelperBindings, MAX_CALL_SITES_PER_WRAPPER } from '../../analyzer/env-helper-binding.js';
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
/**
 * Files read for the unfollowed-indirect-read census. The census is repo-wide by
 * nature — an env name this tool cannot follow is, by definition, not associated with
 * the variable being asked about — so it is bounded by file count and disclosed when
 * the bound bites (change: follow-env-name-through-helper).
 */
const MAX_CENSUS_FILES = 1500;
/** Unfollowed sites named individually in the boundary evidence. */
const MAX_CENSUS_EVIDENCE = 10;

/** A read site mapped to its enclosing function (or module-level). */
interface ResolvedReadSite {
  file: string;
  line: number;
  required: boolean;
  /** Enclosing function `name::file`, or null for a module-level read. */
  enclosingFunction: string | null;
  /** The same-file helper the name was followed through, when it was not read directly. */
  via?: { helper: string; file: string; line: number };
}

/**
 * Count the environment reads whose key is NOT a literal and that the one-hop rule could
 * not follow, across the repository's in-scope source files. A counted boundary names its
 * evidence; a generic caveat would leave an agent unable to judge the size of the gap.
 *
 * Read-only, bounded, and path-confined. Any failure degrades to "not counted" rather
 * than to a claim of zero.
 */
async function censusUnfollowedReads(absDir: string, files: string[], name: string): Promise<{
  counted: boolean;
  total: number;
  fileCount: number;
  truncatedFiles: number;
  evidence: Array<{ file: string; line: number; keyExpression: string; reason: string }>;
  callSiteCapHit: boolean;
  bindings: EnvReadSite[];
}> {
  const scanned = files.slice(0, MAX_CENSUS_FILES);
  const truncatedFiles = files.length - scanned.length;
  const evidence: Array<{ file: string; line: number; keyExpression: string; reason: string }> = [];
  const touchedFiles = new Set<string>();
  const bindings: EnvReadSite[] = [];
  let total = 0;
  let callSiteCapHit = false;
  let read = 0;
  for (const rel of scanned) {
    let source: string;
    try {
      source = await readFileConfined(absDir, rel);
    } catch {
      continue;
    }
    read++;
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    let scan;
    try {
      scan = scanEnvHelperBindings(source, rel, ext);
    } catch {
      continue;
    }
    if (scan.callSiteCapHit) callSiteCapHit = true;
    // The same pass that counts the shortfall also recovers the sites it CAN prove, so a
    // bound call site is reported even when the cached inventory predates this rule and
    // never associated the call-site file with the variable.
    for (const b of scan.bindings) {
      if (b.name === name) bindings.push({ name: b.name, file: b.file, line: b.line, required: b.required, via: b.via });
    }
    if (scan.unfollowed.length === 0) continue;
    total += scan.unfollowed.length;
    touchedFiles.add(rel);
    for (const u of scan.unfollowed) {
      if (evidence.length < MAX_CENSUS_EVIDENCE) evidence.push(u);
    }
  }
  return {
    counted: read > 0 || scanned.length === 0,
    total,
    fileCount: touchedFiles.size,
    truncatedFiles,
    evidence,
    callSiteCapHit,
    bindings,
  };
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
/**
 * Why the inventory is empty, when it is.
 *
 * "Run analyze first" is advice that cannot help a repository the scan does not cover: the
 * extractor reads TS/JS/Python/Go/Ruby only, so a Rust or Java repository reads env vars the
 * inventory will never hold however many times it is analyzed. Name the boundary instead
 * (change: fix-env-scope-hint).
 */
async function emptyInventoryHint(absDir: string): Promise<string> {
  const RUN_ANALYZE = 'No environment variables in the inventory. Run analyze_codebase first.';
  try {
    const { readCachedContext } = await import('./utils.js');
    const { ENV_SOURCE_EXTENSIONS } = await import('../../analyzer/env-extractor.js');
    const cached = await readCachedContext(absDir);
    const nodes = cached?.callGraph?.nodes ?? [];
    if (!nodes.length) return RUN_ANALYZE;
    const inScope = nodes.some(n => {
      const dot = n.filePath.lastIndexOf('.');
      return dot >= 0 && ENV_SOURCE_EXTENSIONS.has(n.filePath.slice(dot).toLowerCase());
    });
    if (inScope) return RUN_ANALYZE;
    return 'No file in this repository is in scope for environment-variable scanning, which reads '
      + `${[...ENV_SOURCE_EXTENSIONS].sort().join(' ')} only. Re-running analyze will not change `
      + 'that; a read in another language is a disclosed boundary, not a missing index.';
  } catch {
    return RUN_ANALYZE;
  }
}

export async function handleAnalyzeEnvImpact(input: AnalyzeEnvImpactInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { error: 'Provide `name` — an environment variable, e.g. DATABASE_URL.' };

  const ctx = await readCachedContext(absDir);
  if (!ctx) return await diagnoseIndexUnservable(absDir);
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
        : await emptyInventoryHint(absDir),
    };
  }

  const boundaries = new Set<string>();
  const depthBound = Number.isFinite(input.maxDepth as number)
    ? Math.max(MIN_DEPTH, Math.min(input.maxDepth as number, MAX_DEPTH))
    : DEFAULT_DEPTH;

  // ── The repository's in-scope source files, for the one-hop pass + its census ──
  const censusFiles = [...new Set(cg.nodes.filter(n => !n.isExternal).map(n => n.filePath))]
    .filter(f => {
      const dot = f.lastIndexOf('.');
      return dot >= 0 && ENV_SOURCE_EXTENSIONS.has(f.slice(dot).toLowerCase());
    })
    .sort();
  const census = await censusUnfollowedReads(absDir, censusFiles, name);

  // ── Re-scan only the files the inventory flags for this var, line-precise ────
  const rawSites: EnvReadSite[] = [];
  for (const rel of entry.files) {
    const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.')).toLowerCase() : '';
    let source: string;
    try {
      // `rel` comes from the env inventory — a repository-committed artifact, so the
      // path is attacker-controlled (the index attestation is advisory). Confine it:
      // the re-scan's read sites are returned to the caller, so an escape leaks the
      // contents of a file outside the root (compare symbol-span.ts:102).
      source = await readFileConfined(absDir, rel);
    } catch {
      boundaries.add(`source unreadable since analysis — re-run analyze_codebase (${rel})`);
      continue;
    }
    for (const s of extractEnvReadSites(source, rel, ext)) {
      if (s.name === name) rawSites.push(s);
    }
  }
  // Merge the one-hop bindings the census proved, deduplicated against the per-file rescan.
  {
    const seen = new Set(rawSites.map(s => `${s.file}:${s.line}:${s.via?.line ?? ''}`));
    for (const b of census.bindings) {
      const key = `${b.file}:${b.line}:${b.via?.line ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rawSites.push(b);
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
      resolvedSites.push({ file: s.file, line: s.line, required: s.required, enclosingFunction: labelOf(best), ...(s.via ? { via: s.via } : {}) });
      readingFnIds.add(best.id);
    } else {
      resolvedSites.push({ file: s.file, line: s.line, required: s.required, enclosingFunction: null, ...(s.via ? { via: s.via } : {}) });
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
  // Over the precomputed traversal structure (change: optimize-reachability-precompute);
  // `sortNeighbors` keeps the ascending-caller expansion order this walk always used.
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const traversal = await loadTraversalIndex(absDir, cg);
  const distOf = traversal.bfsDepths(
    [...readingFnIds], 'backward', depthBound, undefined, { sortNeighbors: true },
  );
  // The depth cap stays a disclosed boundary, fired on exactly the prior condition:
  // the walk reached a node AT the cap and therefore declined to expand it.
  for (const d of distOf.values()) {
    if (d >= depthBound) {
      boundaries.add(`backward traversal bounded at depth ${depthBound}; deeper callers not enumerated`);
      break;
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

  // ── The name-through-a-parameter boundary (change: follow-env-name-through-helper) ──
  // An env name passed as an argument is followed EXACTLY ONE HOP, and only where the
  // binding is provable from literal text. Everything else is counted here, with its
  // evidence, so the lower bound's remaining shortfall is a number rather than a caveat.
  const viaSites = resolvedSites.filter(s => s.via);
  if (viaSites.length > 0) {
    const helpers = [...new Set(viaSites.map(s => `${s.via!.helper}::${s.via!.file}`))].sort();
    boundaries.add(
      `${viaSites.length} read site(s) are a call site of a helper that performs the read — the name is ` +
        'a string literal at the call site and was followed ONE HOP into a same-file helper ' +
        `(${helpers.slice(0, 5).join(', ')}). The reported file/line is the CALL SITE, where the ` +
        'variable is named; the helper is disclosed per site in `via`.',
    );
  }

  const capNote = census.callSiteCapHit
    ? ` Per-helper call sites are capped at ${MAX_CALL_SITES_PER_WRAPPER}, and that cap was reached, so some literal call sites of a followed helper are not listed.`
    : '';
  const truncNote = census.truncatedFiles > 0
    ? ` The census read the first ${MAX_CENSUS_FILES} in-scope files; ${census.truncatedFiles} more were not counted.`
    : '';
  if (census.total > 0) {
    boundaries.add(
      `An environment-variable name that reaches a read through a function parameter is followed ONE ` +
        'HOP ONLY, and only when the helper is a same-file free function whose parameter flows straight ' +
        'into the read and the call site passes a plain string literal. ' +
        `${census.total} environment read(s) in ${census.fileCount} file(s) take a non-literal key that ` +
        'could not be followed, so READ SITES ARE A LOWER BOUND: those reads name no variable here and ' +
        'may belong to this one. See unfollowedEnvReads for the evidence.' + capNote + truncNote,
    );
  } else {
    boundaries.add(
      'An environment-variable name that reaches a read through a function parameter is followed ONE ' +
        'HOP ONLY (a same-file free function whose parameter flows straight into the read, called with a ' +
        'plain string literal); a two-hop helper, a computed key, a reassigned or shadowed parameter, or a ' +
        'non-literal argument is NOT followed. ' +
        (census.counted
          ? 'No unfollowed non-literal environment read was found in this repository\'s in-scope files.'
          : 'This repository\'s in-scope files could not be counted, so the size of that gap is unknown.')
        + capNote + truncNote,
    );
  }
  boundaries.add(
    'Blast radius is a SOUND LOWER BOUND over the call graph: dynamic dispatch, reflection, and ' +
      'externally-consumed exports can add callers not enumerated here.',
  );

  // ── Where infrastructure sets it (change: add-iac-code-binding) ──────────────
  // Keys and locations only: no value is read into the output.
  const { scanEnvDeclarations } = await import('../env-declaration-scan.js');
  const iac = await scanEnvDeclarations(absDir);
  for (const b of iac.boundaries) boundaries.add(b);
  // Repository text (resource names, paths) is screened before it reaches output.
  const { emittedText } = await import('../generated-file-guard.js');
  const declaredBy = iac.declarations.filter(d => d.name === name)
    .map(d => ({ ecosystem: d.ecosystem, resource: emittedText(d.resource), file: emittedText(d.file), line: d.line, literalValue: d.literalValue }));
  // A `.env`-style declaration file that lists the name (even with an empty value) declares it.
  const inEnvFile = entry.hasDefault || entry.files.some(f => /(?:^|\/)\.env(?:\.[^/]*)?$/.test(f));
  const declaration = declaredBy.length || inEnvFile ? 'declared' : 'undeclared-in-corpus';
  if (declaration === 'undeclared-in-corpus') {
    boundaries.add(
      'undeclared-in-corpus: no file in this repository sets this variable. It is not "unset": it may be ' +
        'injected at runtime, by a secret store, or by CI variables defined outside the repository.',
    );
  }
  if (iac.opaque.length) {
    boundaries.add(
      `${iac.opaque.length} infrastructure source(s) set variables this scan cannot list (envFrom, env_file, ` +
        'or a map built by an expression); see opaqueEnvSources — the variable may be set there.',
    );
  }

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
      readSitesViaHelper: viaSites.length,
      unfollowedEnvReads: census.total,
      moduleLevelReadSites: moduleLevelCount,
      readingFunctions: readingFnIds.size,
      declaredBy: declaredBy.length,
      affectedFunctions: affectedFunctions.length,
      affectedFiles: affectedFiles.size,
      reachingTests: reachingTests.length,
    },
    readSites: resolvedSites,
    ...(census.evidence.length
      ? {
        unfollowedEnvReads: census.evidence,
        ...(census.total > census.evidence.length ? { unfollowedEnvReadsTruncated: census.total - census.evidence.length } : {}),
      }
      : {}),
    declaration,
    declaredBy: declaredBy.slice(0, MAX_LIST),
    ...(declaredBy.length > MAX_LIST ? { declaredByTruncated: declaredBy.length - MAX_LIST } : {}),
    ...(iac.opaque.length ? { opaqueEnvSources: iac.opaque.slice(0, 20).map(o => ({ ...o, resource: emittedText(o.resource), file: emittedText(o.file) })) } : {}),
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
      '(a hard break if the var is removed). A site with `via` is a CALL SITE whose string literal ' +
      'names the variable, followed one hop into the same-file helper that reads it. ' +
      'unfollowedEnvReads = reads whose key is not a literal and could not be followed (the remaining ' +
      'shortfall of the lower bound). declaredBy = infrastructure files that set it (key and ' +
      'location only, never the value). Computed live from the cached graph + a re-read of the ' +
      "var's files — re-run analyze_codebase after edits.",
  };
}
