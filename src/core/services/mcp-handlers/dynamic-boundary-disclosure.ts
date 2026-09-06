/**
 * Dynamic-boundary surfacing (change: disclose-dynamic-boundary-regions).
 *
 * The analyzer records, per file, every dispatch construct the resolver cannot follow. This module
 * is the read side shared by every conclusion whose soundness rests on reachability completeness:
 * given the files a conclusion actually traversed, it produces ONE structured
 * `known-unknowable` crossing naming the sites in scope — so the answer says *which* construct
 * bounds it, instead of the whole-README caveat that "dynamic dispatch is not captured".
 *
 * Three scoping rules keep the disclosure useful rather than fatiguing:
 *
 *  1. **Scoped to the traversal, never the repository.** A conclusion over a clean subgraph in a
 *     repository full of reflection discloses nothing. A repository-wide list would be the blanket
 *     caveat it replaces.
 *  2. **Bounded, with a receipt.** Deduplicated by kind+file, capped, and the omitted count is
 *     stated — a bounded list must never read as the whole set.
 *  3. **One-directional.** A boundary can qualify a NEGATIVE conclusion (dead, untested, safe). It
 *     can never promote a symbol to live, tested, or unsafe: an unknown is not evidence.
 *
 * A repository with no site has no artifact, so every helper here fails open to "no boundary" and
 * a clean repository pays one failed `readFile` per conclusion — and, once the report is absent,
 * nothing else.
 */

import { join } from 'node:path';
import { readArtifactBounded, ANALYSIS_ARTIFACT_MAX_BYTES } from '../../../utils/bounded-artifact-read.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_DYNAMIC_BOUNDARY,
  ARTIFACT_DEPENDENCY_GRAPH,
} from '../../../constants.js';
import { sanitizeForTerminal } from '../../../utils/misc.js';
import {
  DYNAMIC_BOUNDARY_SCHEMA_VERSION,
  DYNAMIC_BOUNDARY_KINDS,
  DYNAMIC_BOUNDARY_REFUSALS,
  DYNAMIC_BOUNDARY_KIND_LABEL,
  DYNAMIC_BOUNDARY_REFUSAL_LABEL,
  type DynamicBoundaryReport,
  type DynamicBoundaryKind,
  type FileDynamicBoundary,
  type DynamicBoundarySite,
} from '../../analyzer/dynamic-boundary.js';
import type { DisclosedDynamicSite, KnownUnknowableCrossing } from './confidence-boundary.js';

/** How many sites a crossing lists before it collapses to a count. */
export const DYNAMIC_BOUNDARY_DISCLOSURE_CAP = 8;

/**
 * The kinds that can hide a CALLER, and so can invert a "nothing reaches this" conclusion.
 *
 * Deliberately narrower than the whole vocabulary: `code-eval`, `dynamic-import` and
 * `metaprogrammed-definition` describe code being *created* or *loaded*, not an existing symbol
 * being *reached*, so qualifying a dead-code candidate on them would cry wolf. They are still
 * disclosed on traversals — the reader learns the region is reflective — they just do not move a
 * verdict on their own.
 */
export const CALLER_HIDING_KINDS: readonly DynamicBoundaryKind[] = [
  'reflective-invoke',
  'computed-member',
  'container-resolution',
];

/**
 * The kinds whose reach extends beyond their own file.
 *
 * `computed-member` is deliberately absent. A computed subscript's receiver is a LOCAL expression —
 * `paint[r.status](…)` indexes an object literal three lines up — so it can name only what its own
 * file holds. Letting it qualify through the import closure was measured on this repository: two
 * such lookups in `doctor.ts` qualified 431 of 845 files and moved 505 dead-flagged coverage gaps
 * to "undecided", every one of them on the strength of a colour-table lookup that can reach none of
 * them. That is precisely the crying-wolf this module's scoping exists to prevent.
 *
 * `reflective-invoke` and `container-resolution` do reach: the receiver of `getattr(o, name)()` is
 * a parameter that can hold anything the module graph reaches, and a DI container resolves by token
 * across the whole application.
 */
const CLOSURE_REACHING_KINDS: readonly DynamicBoundaryKind[] = [
  'reflective-invoke',
  'container-resolution',
];

/**
 * Cap on a site-artifact read. A disclosure sidecar is small by construction (bounded sites per
 * file, bounded evidence); anything approaching this is not one, and reading it would trade a
 * conclusion's availability for an annotation on it.
 */
const DYNAMIC_BOUNDARY_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Per-directory memo, mirroring the confidence boundary's staleness memo and for the same reason: a
 * single user-facing call fans out into many handlers — `blast_radius` composes `analyze_impact`
 * once per seed plus `select_tests`, so the same artifact would otherwise be read and parsed a
 * dozen times for one briefing. The window is short enough that a watcher rewrite is picked up on
 * the next agent turn.
 */
const REPORT_TTL_MS = 5000;
const reportMemo = new Map<string, { at: number; value: DynamicBoundaryReport | null }>();
const adjacencyMemo = new Map<string, { at: number; value: Map<string, string[]> }>();

/** Drop the memos — test-only hook, so a rewritten artifact is re-read immediately. */
export function __resetDynamicBoundaryMemo(): void {
  reportMemo.clear();
  adjacencyMemo.clear();
}

function memoized<T>(
  cache: Map<string, { at: number; value: T }>,
  key: string,
  now: number,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && now - hit.at < REPORT_TTL_MS) return Promise.resolve(hit.value);
  return compute().then((value) => {
    cache.set(key, { at: now, value });
    return value;
  });
}

const KNOWN_KINDS = new Set<string>(DYNAMIC_BOUNDARY_KINDS);
const KNOWN_REFUSALS = new Set<string>(DYNAMIC_BOUNDARY_REFUSALS);

/**
 * Is this parsed value a usable site record? Anything else is dropped, never trusted.
 *
 * Checked against the CLOSED VOCABULARIES, not merely for `typeof === 'string'`. A `kind` of
 * `"constructor"` or a `refusal` of `"toString"` resolves off `Object.prototype` in the label
 * lookups and renders `function Object() { [native code] }` into a disclosure an agent reads — the
 * `??` fallback never fires, because the lookup succeeded. Membership is the only check that holds.
 *
 * `totalSites` is checked as an integer no smaller than the retained list, because it is SUMMED
 * into the crossing's `count`: an artifact carrying `"09"`, `1e308` or an object turns that number
 * into a string, an infinity, or `"0[object Object]"` in a sentence a human reads.
 */
function validRecord(f: unknown): f is FileDynamicBoundary {
  if (!f || typeof f !== 'object') return false;
  const r = f as Partial<FileDynamicBoundary>;
  if (typeof r.filePath !== 'string' || typeof r.language !== 'string' || !Array.isArray(r.sites)) {
    return false;
  }
  if (r.totalSites !== undefined
    && (!Number.isSafeInteger(r.totalSites) || r.totalSites < r.sites.length)) return false;
  return r.sites.every(site => !!site && typeof site === 'object'
    && Number.isSafeInteger((site as DynamicBoundarySite).line)
    && KNOWN_KINDS.has((site as DynamicBoundarySite).kind)
    && KNOWN_REFUSALS.has((site as DynamicBoundarySite).refusal));
}

/**
 * Load the persisted report, or `null` when absent/unreadable (a repository with no site).
 *
 * Every record is validated — shape, closed vocabularies, and the one numeric field that is summed
 * — before it is served. This artifact is read on the serving path by seven
 * conclusions, and a *disclosure* sidecar must never be able to take down the conclusions it exists
 * to annotate: a malformed, truncated, hand-edited or hostile file degrades to "no boundary", never
 * to a thrown handler. The read is bounded and refuses to follow a symlink or block on a FIFO, for
 * the same reason every other `.openlore` reader on this path does.
 */
export async function loadDynamicBoundaryReport(
  absDir: string,
  now: number = Date.now(),
): Promise<DynamicBoundaryReport | null> {
  return memoized(reportMemo, absDir, now, async () => {
    const path = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DYNAMIC_BOUNDARY);
    try {
      const read = await readArtifactBounded(path, DYNAMIC_BOUNDARY_MAX_BYTES);
      if (!read) return null;
      const parsed = JSON.parse(read.text) as Partial<DynamicBoundaryReport>;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.files)) return null;
      // The schema version is stamped on write, so it must be CHECKED on read — otherwise the
      // guard exists in name only and a stale artifact from an older shape is served as current.
      // Fail open to "no boundary", the module's posture everywhere else.
      if (parsed.version !== DYNAMIC_BOUNDARY_SCHEMA_VERSION) return null;
      const files = parsed.files.filter(validRecord);
      if (files.length === 0) return null;
      return { ...(parsed as DynamicBoundaryReport), files };
    } catch {
      return null;
    }
  });
}

/**
 * Forward import adjacency (repo-relative path → the paths it imports), read from the persisted
 * dependency graph. This is what bounds a qualification to the files that can NAME a symbol; with
 * no dependency graph the map is empty and a site qualifies only within its own file — narrower,
 * which is the safe direction.
 *
 * Memoized per directory like the report above, because `find_dead_code` already reads this same
 * artifact for its own liveness signals and passes its adjacency in directly; every other caller
 * would otherwise re-read and re-parse a graph that can be the largest artifact in `.openlore`.
 */
export async function loadImportAdjacency(
  absDir: string,
  now: number = Date.now(),
): Promise<Map<string, string[]>> {
  return memoized(adjacencyMemo, absDir, now, () => readImportAdjacency(absDir));
}

async function readImportAdjacency(absDir: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const read = await readArtifactBounded(
      join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH),
      ANALYSIS_ARTIFACT_MAX_BYTES,
    );
    if (!read) return out;
    const g = JSON.parse(read.text) as {
      nodes?: Array<{ id: string; file?: { path?: string } }>;
      edges?: Array<{ source?: string; target?: string }>;
    };
    const idToPath = new Map((g.nodes ?? []).map(n => [n.id, n.file?.path ?? '']));
    for (const e of g.edges ?? []) {
      const from = e.source ? idToPath.get(e.source) : undefined;
      const to = e.target ? idToPath.get(e.target) : undefined;
      if (!from || !to) continue;
      const list = out.get(from);
      if (list) list.push(to);
      else out.set(from, [to]);
    }
  } catch {
    // No dependency graph — every closure collapses to the site's own file.
  }
  return out;
}

/** The per-file records for the files a conclusion touched, in deterministic path order. */
export function recordsForFiles(
  report: DynamicBoundaryReport | null,
  touchedFiles: Iterable<string>,
): FileDynamicBoundary[] {
  if (!report || report.files.length === 0) return [];
  const byPath = new Map(report.files.map(f => [f.filePath, f]));
  const hits: FileDynamicBoundary[] = [];
  const seen = new Set<string>();
  for (const f of touchedFiles) {
    if (seen.has(f)) continue;
    seen.add(f);
    const rec = byPath.get(f);
    if (rec) hits.push(rec);
  }
  return hits.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
}

/**
 * The structured crossing for the sites inside the traversal, or `undefined` when the traversal
 * crossed none. `count` is the EXACT number of sites in scope; `sites` is the bounded, deduplicated
 * list; `omittedSites` is the receipt for what the bound dropped.
 */
export function dynamicBoundaryCrossing(
  report: DynamicBoundaryReport | null,
  touchedFiles: Iterable<string>,
  cap: number = DYNAMIC_BOUNDARY_DISCLOSURE_CAP,
): KnownUnknowableCrossing | undefined {
  const records = recordsForFiles(report, touchedFiles);
  if (records.length === 0) return undefined;

  // Dedupe by kind+file, keeping the first (lowest-line) site of each group: a file that dispatches
  // reflectively fifty times is one fact about that file, not fifty.
  const groups = new Map<string, DisclosedDynamicSite>();
  let exact = 0;
  for (const rec of records) {
    exact += rec.totalSites ?? rec.sites.length;
    for (const s of rec.sites) {
      const key = `${rec.filePath}\u0000${s.kind}`;
      const existing = groups.get(key);
      if (!existing || s.line < existing.line) {
        groups.set(key, { file: rec.filePath, line: s.line, kind: s.kind });
      }
    }
  }

  const ordered = [...groups.values()].sort(
    (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line
      || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  const shown = ordered.slice(0, cap);
  const omitted = ordered.length - shown.length;

  // `count` is SITES; the list and `omittedSites` are file+kind GROUPS. Stating both units keeps
  // the receipt arithmetically checkable — "8 listed + 3 omitted" adds up to the group total, not
  // to the site total, so a reader who subtracts does not get a nonsense number.
  return {
    kind: 'dynamic-boundary',
    count: exact,
    sites: shown,
    ...(omitted > 0 ? { omittedSites: omitted } : {}),
    detail:
      `${exact} dispatch site(s) in this answer's scope are ones the call graph cannot follow, `
      + `across ${ordered.length} file/kind group(s); `
      + `${shown.length} listed (${shown.map(describeSite).join('; ')})`
      + `${omitted > 0 ? `, ${omitted} group(s) omitted` : ''}. `
      // The sentence stops at the general fact. Each surface's own directive differs — "nothing
      // else reaches these symbols" is right for a reachability answer and wrong for an exception
      // set, where the risk is a reflectively-reached callee whose throws are missing — so a shared
      // directive would send half its readers to verify the wrong thing.
      + 'Edges through them are absent from the graph, so this answer is a LOWER BOUND: '
      + 'anything reached only through one of these sites is missing from it.',
  };
}

/**
 * `src/a.ts:12 (reflective invocation)` — the shared phrasing for one disclosed site.
 *
 * The file path is repository-controlled (a file name may legally contain a newline, and a hostile
 * `.openlore/` may carry anything), and this string is embedded in a CLI line whose writer keeps
 * newlines because it treats its input as an OpenLore-authored message. A newline in a VALUE inside
 * that message forges an extra terminal line — a forged "all clear" under a warning block — so
 * every untrusted value is neutralized here, at the one place they are rendered.
 */
export function describeSite(s: DisclosedDynamicSite): string {
  const label = Object.hasOwn(DYNAMIC_BOUNDARY_KIND_LABEL, s.kind)
    ? DYNAMIC_BOUNDARY_KIND_LABEL[s.kind as DynamicBoundaryKind]
    : sanitizeForTerminal(s.kind);
  return `${sanitizeForTerminal(s.file)}:${s.line} (${label})`;
}

/** One site, with the file it lives in — what a qualification names. */
export interface QualifyingHit {
  file: string;
  site: DynamicBoundarySite;
}

/**
 * Maximum files walked when computing what one site file can reach, and the total the whole index
 * may retain. Bounds, not tuning knobs: a closure that runs past the first stops widening and an
 * index that runs past the second stops growing.
 *
 * The closure is an OVER-approximation of naming, not an under-one: a site's file transitively
 * importing a module does not prove it can name a symbol inside it (that needs a re-export). It is
 * the direction to err in HERE, because the closure only ever WITHHOLDS a negative conclusion —
 * over-qualifying declines to claim absence, which is conservative, while under-qualifying would
 * serve a confident "nothing calls this" next to a dispatch that does. The kinds that reach at all
 * are held down to {@link CLOSURE_REACHING_KINDS} for the same reason in reverse: a construct that
 * demonstrably cannot reach past its own file must not withhold anything beyond it.
 */
const NAMING_CLOSURE_CAP = 2000;
const NAMING_INDEX_CAP = 50_000;

/**
 * Build the qualifier a negative conclusion consults: given a candidate's file and language, does a
 * caller-hiding site sit somewhere that can actually name it?
 *
 * Scope is COMPUTABLE, not repository-wide. A site qualifies a candidate only when it is in the
 * candidate's own file, or in a file whose transitive import closure contains the candidate's
 * module — the set of files that can name the symbol. Restricted further to the candidate's own
 * language (a Python `getattr` cannot reach a Go function) and to the kinds that can hide a CALLER.
 * Sites outside that closure are left to the existing whole-repository caveat rather than silently
 * widening this one into the blanket disclosure it replaces.
 *
 * The index is INVERTED once, on the first query, rather than walked per candidate: a repository
 * with thousands of site-bearing files would otherwise pay one BFS per site file for every dead
 * candidate, and retain a closure set for each. Built once, every lookup is a map read.
 *
 * Two ordering rules make the named site the RIGHT one: a site in the candidate's own file always
 * wins over one merely able to import it, and within a file the lowest-line qualifying site wins —
 * the same rule the traversal disclosure uses, so the two never name different lines for one file.
 */
export function buildQualifier(
  report: DynamicBoundaryReport | null,
  imports: ReadonlyMap<string, string[]>,
): (file: string, language: string) => QualifyingHit | undefined {
  // Two views of the same records: what may qualify the site's OWN file, and the narrower set that
  // may also qualify a file the site can merely import.
  const pick = (f: FileDynamicBoundary, kinds: readonly DynamicBoundaryKind[]) =>
    [...f.sites].filter(s => kinds.includes(s.kind)).sort((a, b) => a.line - b.line)[0];

  const ownFileSites = (report?.files ?? [])
    .map(f => ({ file: f.filePath, language: f.language, site: pick(f, CALLER_HIDING_KINDS) }))
    .filter((f): f is { file: string; language: string; site: DynamicBoundarySite } => !!f.site)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const siteFiles = (report?.files ?? [])
    .map(f => ({ file: f.filePath, language: f.language, site: pick(f, CLOSURE_REACHING_KINDS) }))
    .filter((f): f is { file: string; language: string; site: DynamicBoundarySite } => !!f.site)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  if (ownFileSites.length === 0 && siteFiles.length === 0) return () => undefined;

  // `language\u0000file` → the site that qualifies it. Built lazily so a repository whose
  // conclusions never touch a candidate pays nothing.
  let index: Map<string, QualifyingHit> | undefined;
  const build = (): Map<string, QualifyingHit> => {
    const out = new Map<string, QualifyingHit>();
    // Own-file attribution first, across every site file, so it can never lose a race to a file
    // that merely imports the candidate and happens to sort earlier. Every caller-hiding kind
    // qualifies its own file, including the ones that reach no further.
    for (const s of ownFileSites) out.set(`${s.language}\u0000${s.file}`, { file: s.file, site: s.site });
    for (const s of siteFiles) {
      if (out.size >= NAMING_INDEX_CAP) break;
      const seen = new Set<string>([s.file]);
      const queue = [s.file];
      while (queue.length > 0 && seen.size < NAMING_CLOSURE_CAP) {
        for (const next of imports.get(queue.shift()!) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
          const key = `${s.language}\u0000${next}`;
          // First site file in sorted order wins, and an own-file entry is never displaced.
          if (!out.has(key) && out.size < NAMING_INDEX_CAP) out.set(key, { file: s.file, site: s.site });
        }
      }
    }
    return out;
  };

  return (file, language) => (index ??= build()).get(`${language}\u0000${file}`);
}

/**
 * The reason string a qualified negative verdict carries. Names the specific construct — which is
 * the whole point: it REPLACES the generic "dynamic language" caveat rather than adding to it, so
 * the reader learns which line bounds the answer instead of only that the language is dynamic.
 */
export function qualificationReason(hit: QualifyingHit): string {
  const label = Object.hasOwn(DYNAMIC_BOUNDARY_KIND_LABEL, hit.site.kind)
    ? DYNAMIC_BOUNDARY_KIND_LABEL[hit.site.kind]
    : sanitizeForTerminal(hit.site.kind);
  // `Object.hasOwn`, not `??`: a refusal of `"toString"` resolves off `Object.prototype` and the
  // fallback would never fire. An unrecognised value echoes, neutralized like every other
  // repository-controlled value rendered here.
  const why = Object.hasOwn(DYNAMIC_BOUNDARY_REFUSAL_LABEL, hit.site.refusal)
    ? DYNAMIC_BOUNDARY_REFUSAL_LABEL[hit.site.refusal]
    : sanitizeForTerminal(hit.site.refusal ?? '') || 'the resolver did not bind this dispatch';
  return `a ${label} at ${sanitizeForTerminal(hit.file)}:${hit.site.line} can reach this symbol without a graph edge `
    + `(${why}) — absence of a caller is not established here`;
}
