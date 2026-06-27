/**
 * Spec-09 — analyze step + fact derivation.
 *
 * Ensures a cached repo is analyzed (init → analyze) so the tools have artifacts
 * to read, asserts those artifacts exist, then derives the realistic args
 * (`RepoFacts`) the tool driver feeds to function/file/query-scoped tools.
 *
 * Derivation reads the repo's OWN analysis (via deterministic read tools) so the
 * harness adapts to whatever repo it is pointed at — never hard-coded names.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openloreInit } from '../../../../api/init.js';
import { openloreAnalyze } from '../../../../api/analyze.js';
import { VectorIndex } from '../../../analyzer/vector-index.js';
import {
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_CALL_GRAPH_DB,
  ARTIFACT_REPO_STRUCTURE,
  OPENLORE_ANALYSIS_REL_PATH,
} from '../../../../constants.js';
import { dispatchTool } from '../../tool-dispatch.js';
import type { RepoFacts } from './tool-driver.js';

/**
 * Artifacts `analyze` must produce for the tools to read. These are the three the
 * read path depends on; `mapping.json` is intentionally NOT here — it is built on
 * demand by `get_mapping`, not by `analyze`.
 */
const REQUIRED_ARTIFACTS = [ARTIFACT_REPO_STRUCTURE, ARTIFACT_LLM_CONTEXT, ARTIFACT_CALL_GRAPH_DB];

/**
 * Run static analysis (no LLM) against a cached repo and assert artifacts exist.
 * @throws if any required artifact is missing after analyze (fail loudly).
 */
export async function analyzeRepo(dir: string): Promise<void> {
  await openloreInit({ rootPath: dir });
  const result = await openloreAnalyze({ rootPath: dir, force: true });

  const analysisDir = join(dir, OPENLORE_ANALYSIS_REL_PATH);
  const missing = REQUIRED_ARTIFACTS.filter((a) => !existsSync(join(analysisDir, a)));
  if (missing.length) {
    throw new Error(
      `live-data: analyze produced no ${missing.join(', ')} in ${analysisDir} — analyze step failed for this repo.`,
    );
  }

  // The `openloreAnalyze` API builds the call-graph artifacts but NOT the search
  // index. orient / search_code / suggest_insertion_points need it, so build the
  // keyword-only (BM25) index here — embedSvc=null keeps it offline and
  // deterministic (no model download, no network), mirroring `openlore analyze
  // --no-embed`. Without this, orient correctly returns "No analysis found".
  await buildKeywordIndex(dir, analysisDir, result.artifacts.llmContext);
}

async function buildKeywordIndex(
  dir: string,
  analysisDir: string,
  llmContext: { callGraph?: unknown; signatures?: unknown } | undefined,
): Promise<void> {
  const cg = (llmContext?.callGraph ?? null) as
    | { nodes: Array<{ id: string; filePath: string }>; hubFunctions: Array<{ id: string }>; entryPoints: Array<{ id: string }> }
    | null;
  if (!cg || cg.nodes.length === 0) return; // nothing to index (tiny repo); leave as-is

  const sigs = (llmContext?.signatures ?? []) as Parameters<typeof VectorIndex.build>[2];
  const hubIds = new Set(cg.hubFunctions.map((f) => f.id));
  const entryIds = new Set(cg.entryPoints.map((f) => f.id));

  const fileContents = new Map<string, string>();
  await Promise.all(
    [...new Set(cg.nodes.map((n) => n.filePath))].map(async (fp) => {
      try {
        fileContents.set(fp, await readFile(join(dir, fp), 'utf-8'));
      } catch {
        /* skip unreadable files */
      }
    }),
  );

  await VectorIndex.build(analysisDir, cg.nodes as Parameters<typeof VectorIndex.build>[1], sigs, hubIds, entryIds, null, fileContents, false);
}

/** Walk an arbitrary tool result for the first objects carrying a function name + file. */
function collectNamedFunctions(result: unknown, out: Array<{ name: string; file?: string }>): void {
  if (out.length >= 4 || result === null || typeof result !== 'object') return;
  if (Array.isArray(result)) {
    for (const item of result) collectNamedFunctions(item, out);
    return;
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj.name === 'string' && obj.name.length > 0) {
    const file = typeof obj.file === 'string' ? obj.file : typeof obj.filePath === 'string' ? obj.filePath : undefined;
    out.push({ name: obj.name, file });
  }
  for (const v of Object.values(obj)) collectNamedFunctions(v, out);
}

async function safeDispatch(name: string, dir: string): Promise<unknown> {
  try {
    return await dispatchTool(name, { directory: dir }, dir);
  } catch {
    return null;
  }
}

/**
 * Derive realistic, deterministic args from the analyzed repo. Best-effort: any
 * fact that cannot be derived is left undefined, and tools needing it derive-skip
 * (distinct from a missing driver entry). Stable for a given repo+SHA.
 */
export async function deriveFacts(dir: string): Promise<RepoFacts> {
  const facts: RepoFacts = { directory: dir };

  // Prefer hubs (richest: name + file + ordering); fall back to leaf functions.
  const found: Array<{ name: string; file?: string }> = [];
  collectNamedFunctions(await safeDispatch('get_critical_hubs', dir), found);
  if (found.length < 2) collectNamedFunctions(await safeDispatch('get_leaf_functions', dir), found);

  // Deterministic pick: alphabetical-first names for stable snapshots/args.
  const byName = [...found].sort((a, b) => a.name.localeCompare(b.name));
  if (byName[0]) {
    facts.functionName = byName[0].name;
    facts.filePath = byName[0].file;
    // searchTerm derived from a real symbol — guaranteed to exist in the repo.
    facts.searchTerm = byName[0].name;
  }
  if (byName[1]) facts.secondFunction = byName[1].name;

  // Spec domain only if the repo actually ships specs (cloned OSS repos rarely do).
  const domains = await safeDispatch('list_spec_domains', dir);
  const domainList: string[] = [];
  collectStrings(domains, 'domain', domainList);
  collectStrings(domains, 'name', domainList);
  if (domainList[0]) facts.specDomain = domainList[0];

  // Env var only if the repo declares/reads one (for analyze_env_impact). Pick the
  // alphabetical-first name for a stable, deterministic arg.
  const envResult = await safeDispatch('get_env_vars', dir);
  const envNames: string[] = [];
  collectStrings(envResult, 'name', envNames);
  const sortedEnv = [...envNames].sort((a, b) => a.localeCompare(b));
  if (sortedEnv[0]) facts.envVar = sortedEnv[0];

  return facts;
}

function collectStrings(result: unknown, key: string, out: string[]): void {
  if (out.length >= 8 || result === null || typeof result !== 'object') return;
  if (Array.isArray(result)) {
    for (const item of result) collectStrings(item, key, out);
    return;
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj[key] === 'string' && (obj[key] as string).length > 0) out.push(obj[key] as string);
  for (const v of Object.values(obj)) collectStrings(v, key, out);
}
