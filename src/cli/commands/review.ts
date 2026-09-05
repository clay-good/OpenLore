/**
 * `openlore review` — the PR-review surface (changes: add-pr-review-surface,
 * harden-review-render-and-action).
 *
 * Composes two analyses that already ship into ONE deterministic, conclusion-shaped
 * briefing for a `base..head` range, rendered as Markdown for a PR comment (or JSON
 * for a programmatic consumer):
 *
 *   - the structural delta  (`handleStructuralDiff`): added / removed / signature-
 *     changed symbols, the callers they leave stale, and rename/move candidates;
 *   - the blast radius       (`computeBlastRadius`): hubs touched, layers crossed,
 *     tests to run, governing decisions, and the spec/memory/decision drift the
 *     change introduces — `computeBlastRadius` already folds change-scoped drift in,
 *     so `review` does not separately re-run `detectDrift`.
 *
 * No new structural computation, no LLM, no new MCP tool (north star c6d1ad07).
 * Advisory by default (exit 0); opt-in gating classifies the blast-radius orphan
 * findings through `.openlore/config.json` `enforcement.policy` (including the legacy
 * `blastRadius.block` lowering). Degrades honestly — a missing index, an unreachable
 * base, or a non-git directory states what it could not compute rather than emitting
 * a misleading empty briefing. Decision: 4f3efb11.
 */

import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { gitPathArgs } from '../../utils/git-args.js';
import { logger, configureLogger } from '../../utils/logger.js';
import { readOpenLoreConfigStrict } from '../../core/services/config-manager.js';
import { writeStdout } from '../output.js';
import { computeBlastRadius, type BlastRadiusBriefing } from '../../core/services/mcp-handlers/blast-radius.js';
import { handleStructuralDiff } from '../../core/services/mcp-handlers/structural-diff.js';
import { isGitRepositoryRoot } from '../../core/drift/git-diff.js';
import { blastRadiusAssessmentComplete, blastRadiusFindings } from './enforce.js';
import { classifyFindings, effectivePolicy } from '../../core/services/mcp-handlers/enforcement-policy.js';
import { applyEnforcementBaseline, enforcementFindingIdentity } from '../../core/services/mcp-handlers/enforcement-baseline.js';
import { frameServedContent, type ServedContentProvenance } from '../../core/services/served-content.js';
import { ENFORCEMENT_BASELINE_REL_PATH, OPENLORE_CONFIG_REL_PATH } from '../../constants.js';
import type { GovernanceFinding } from '../../core/services/mcp-handlers/enforcement-policy.js';
import type { OpenLoreConfig } from '../../types/index.js';
import { execFileGit as execFileAsync } from '../../utils/git-exec.js';

/** Hidden HTML marker the GitHub Action greps for to find-and-update its single
 * sticky comment (create once, update in place, never duplicate). MUST be the first
 * line of the rendered markdown so a simple substring match locates it. */
export const REVIEW_MARKER = '<!-- openlore-review -->';
/** Reserved machine exit for an intentional blastRadius policy gate. Other nonzero
 * exits are execution failures and must not be reported as policy findings. */
export const REVIEW_GATE_EXIT_CODE = 3;

// These shapes mirror `handleStructuralDiff`'s return (it is typed `unknown`); the
// fields we read are marked optional so the renderer's guards against a partial/error
// payload are type-checked rather than lint noise.
interface SymbolRef { name: string; file: string; className?: string | null; signature?: string }
interface StructuralResult {
  base?: string;
  head?: string;
  message?: string;
  error?: string;
  changedFiles?: Array<{ path: string; status: string; oldPath?: string }>;
  summary?: {
    addedFunctions: number; removedFunctions: number; signatureChanges: number;
    addedEdges: number; removedEdges: number; staleCallers: number; renameCandidates: number;
  };
  added?: SymbolRef[];
  removed?: Array<SymbolRef & { staleCallers?: Array<{ file: string; name: string }> }>;
  signatureChanged?: Array<SymbolRef & { before: string; after: string; staleCallers?: Array<{ file: string; name: string }> }>;
  renameCandidates?: Array<{ from: SymbolRef; to: SymbolRef; confidence: string; note: string }>;
}

export interface ReviewBriefing {
  base: string;
  head: string;
  structural: StructuralResult;
  blast: BlastRadiusBriefing | { error: string };
  caveats: string[];
  enforcement?: {
    gated: boolean;
    frozen: number;
    new: number;
    retired: number;
    requiresInitialization: string[];
    /** Bounded evidence for the blast-radius orphan findings that caused the gate. */
    evidence: Array<{ code: string; state: 'blocking' | 'frozen:new' | 'frozen:uninitialized' | 'frozen:invalid' | 'config:invalid'; remediation?: string }>;
    omittedEvidence: number;
  };
  /** `ok` when at least one of the two analyses produced a real result; `unavailable`
   * when both failed (e.g. not a git repo). The CLI/Action stays advisory either way. */
  status: 'ok' | 'unavailable';
}


/** True when two git refs resolve to the same commit. On any git error returns false
 * (conservative — we'd rather emit the divergence caveat than silently hide it). */
async function sameCommit(cwd: string, refA: string, refB: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--verify', `${refA}^{commit}`], { cwd }),
      execFileAsync('git', ['rev-parse', '--verify', `${refB}^{commit}`], { cwd }),
    ]);
    return a.stdout.trim() === b.stdout.trim() && a.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Read the baseline from the selected trusted base ref. Using the base tip rather
 * than the merge-base incorporates ratchet progress that landed after the branch
 * fork; a stale candidate must rebase instead of restoring retired exceptions.
 * A missing path is distinct from an unreadable ref: only the former is trusted absence. */
async function readTrustedBaseline(cwd: string, baseRef: string): Promise<{ text: string | null } | { error: string }> {
  try {
    const baseCommit = (await execFileAsync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd })).stdout.trim();
    if (!baseCommit) return { error: `could not resolve trusted base "${baseRef}"` };
    const listed = (await execFileAsync(
      'git', gitPathArgs('ls-tree', '-z', '--name-only', baseCommit, '--', ENFORCEMENT_BASELINE_REL_PATH),
      { cwd, maxBuffer: 2 * 1024 * 1024 },
    )).stdout;
    if (listed.length === 0) return { text: null };
    if (listed !== `${ENFORCEMENT_BASELINE_REL_PATH}\0`) return { error: 'trusted baseline path resolved ambiguously' };
    const shown = await execFileAsync(
      'git', ['show', `${baseCommit}:${ENFORCEMENT_BASELINE_REL_PATH}`],
      { cwd, maxBuffer: 2 * 1024 * 1024 },
    );
    return { text: shown.stdout };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read the committed policy at the same trusted base as the baseline. This keeps a
 * malformed candidate config from silently downgrading a previously frozen code. */
async function readTrustedConfig(cwd: string, baseRef: string): Promise<{ config: OpenLoreConfig | null } | { error: string }> {
  try {
    const baseCommit = (await execFileAsync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd })).stdout.trim();
    if (!baseCommit) return { error: `could not resolve trusted base "${baseRef}"` };
    const listed = (await execFileAsync(
      'git', gitPathArgs('ls-tree', '-z', '--name-only', baseCommit, '--', OPENLORE_CONFIG_REL_PATH),
      { cwd, maxBuffer: 1_048_576 },
    )).stdout;
    if (listed.length === 0) return { config: null };
    if (listed !== `${OPENLORE_CONFIG_REL_PATH}\0`) return { error: 'trusted config path resolved ambiguously' };
    const shown = await execFileAsync('git', ['show', `${baseCommit}:${OPENLORE_CONFIG_REL_PATH}`], { cwd, maxBuffer: 1_048_576 });
    const parsed = JSON.parse(shown.stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'trusted config is not an object' };
    return { config: parsed as OpenLoreConfig };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function wouldRetireCount(trustedText: string | null, findings: readonly GovernanceFinding[], frozenCodes: ReadonlySet<string>): number {
  if (!trustedText) return 0;
  const current = new Set(findings.map((finding) => JSON.stringify(enforcementFindingIdentity(finding))));
  const retired = new Set<string>();
  for (const line of trustedText.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as unknown;
    if (!Array.isArray(record) || record[0] !== 'finding' || typeof record[1] !== 'string') continue;
    const key = JSON.stringify(record);
    if (frozenCodes.has(record[1]) && !current.has(key)) retired.add(key);
  }
  return retired.size;
}

/** Run both analyses for a `base..head` range and assemble the briefing. Never throws —
 * a thrown handler is captured as that section's `{error}` so an advisory caller (the
 * CLI, the CI Action) is never broken by a composed failure. */
export async function composeReview(opts: { cwd: string; base?: string; head?: string; analysisFailed?: boolean }): Promise<ReviewBriefing> {
  const caveats: string[] = [];

  // Suppress the per-call "Successfully validated directory" chatter from the
  // composed handlers so only the briefing (or --json) reaches stdout.
  configureLogger({ quiet: true });
  let structural: StructuralResult;
  let blast: BlastRadiusBriefing | { error: string };
  try {
    const [s, b] = await Promise.all([
      handleStructuralDiff({ directory: opts.cwd, baseRef: opts.base, headRef: opts.head })
        .then(r => r as StructuralResult)
        .catch(err => ({ error: err instanceof Error ? err.message : String(err) }) as StructuralResult),
      // computeBlastRadius diffs the working tree against `base` — it has no headRef.
      // In CI the runner checks out the head SHA so working tree == head; locally with
      // an explicit `--head` that differs, we caveat it below rather than silently
      // mixing ranges.
      computeBlastRadius({ directory: opts.cwd, baseRef: opts.base })
        .catch(err => ({ error: err instanceof Error ? err.message : String(err) })),
    ]);
    structural = s;
    blast = b;
  } finally {
    configureLogger({ quiet: false });
  }

  // Honest range note: blast radius is always working-tree-vs-base; structural honors
  // an explicit head. Flag the case where they can diverge (an explicit --head that
  // is NOT the checked-out commit). In CI the runner checks out the head SHA, so
  // working tree == head and this caveat is correctly suppressed (no noise per PR).
  if (opts.head && opts.head !== 'working tree') {
    const headIsWorkingTree = await sameCommit(opts.cwd, opts.head, 'HEAD');
    if (!headIsWorkingTree) {
      caveats.push(
        `Blast radius is computed against the working tree vs "${opts.base ?? 'HEAD'}"; the structural delta uses "${opts.base ?? 'HEAD'}..${opts.head}". ` +
          'They can differ when --head is not the checked-out commit.',
      );
    }
  }
  if (opts.analysisFailed) {
    caveats.push('The index build failed during this review, so the blast radius may be incomplete or stale.');
  }
  if (!('error' in blast) && blast.confidenceBoundary?.staleness) {
    caveats.push(`Blast radius reflects a stale index (built at "${blast.confidenceBoundary.staleness.indexCommit}").`);
  }
  // Surface a silent base-ref fallback (a typo'd / unreachable --base) so the briefing
  // never misrepresents what it diffed. Derive the resolved base from whichever analysis
  // succeeded — so a shallow CI checkout with no index (blast unavailable) still discloses
  // the fallback via the structural delta's resolved base.
  const resolvedFromAnalyses = !('error' in blast) ? blast.resolvedBaseRef : (!structural.error ? structural.base : undefined);
  if (opts.base && resolvedFromAnalyses && resolvedFromAnalyses !== opts.base) {
    caveats.push(`Base ref "${opts.base}" did not resolve — diffed against "${resolvedFromAnalyses}" instead.`);
  }
  if (!structural.error && blast && 'error' in blast) {
    caveats.push(`Blast radius unavailable (${blast.error}) — showing the structural delta only. Run \`openlore analyze\` for the full briefing.`);
  }
  // This review is posted as a PR comment, so a briefing caveat that never reaches it
  // is a caveat nobody sees. In particular an uncomputed test set must not render as
  // an absent "Tests to run" section, which reads as "no tests are impacted".
  if (blast && !('error' in blast) && blast.tests.unavailable) {
    caveats.push(`Tests to run could not be computed (${blast.tests.unavailable}) — this is not the same as "no tests are impacted".`);
  }

  const resolvedBase = (!('error' in blast) && blast.resolvedBaseRef) || structural.base || opts.base || 'HEAD';
  return {
    base: resolvedBase,
    head: opts.head ?? 'working tree',
    structural,
    blast,
    caveats,
    status: structural.error && blast && 'error' in blast ? 'unavailable' : 'ok',
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────────

/** GitHub rejects an issue/PR comment body over this many characters with HTTP 422.
 * renderMarkdown clamps to it so the bundled Action can always post the briefing. */
export const MAX_MARKDOWN_CHARS = 65536;
/** Per-item identifier clamp — one pathologically long symbol/file name (minified or
 * generated code) must not blow a single bullet past the comment limit on its own. */
const MAX_IDENT = 160;
/** Per-inline-list clamp — hubs/layers/decisions are joined onto one line; bound the
 * count so a hub-heavy change stays a briefing, not an unbounded line. */
const INLINE_CAP = 12;

function fileName(p: string): string {
  return p.replace(/^.*\//, '');
}

/** Clip an identifier/message to a sane length so no single token dominates the briefing. */
function clip(s: string, max = MAX_IDENT): string {
  const codePoints = Array.from(s);
  return codePoints.length > max ? codePoints.slice(0, max - 1).join('') + '…' : s;
}

function sanitizeReviewValue(value: string): string {
  return value
    .replaceAll(REVIEW_MARKER, '')
    // eslint-disable-next-line no-control-regex -- repository text must not carry layout/bidi controls into a PR comment
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]+/gu, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('@', '@\u200b')
    .replaceAll('://', ':&#47;&#47;')
    .replace(/\bwww\./giu, 'www&#46;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Render repository-derived prose as inert, single-line Markdown. */
function markdownText(value: string, max = MAX_IDENT): string {
  return sanitizeReviewValue(clip(value, max))
    .replaceAll('#', '&#35;')
    .replaceAll('`', '&#96;')
    .replaceAll('\\', '&#92;')
    .replaceAll('*', '&#42;')
    // CommonMark does not treat an intraword underscore as emphasis. Preserve that
    // common identifier spelling while escaping boundary underscores such as _text_.
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '&#95;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;')
    .replaceAll('!', '&#33;')
    .replaceAll('|', '&#124;')
    .replaceAll('~', '&#126;');
}

/** Wrap repository-derived text in a CommonMark code span whose fence is longer
 * than every backtick run in the value, so the value cannot close the span. */
function inlineCode(value: string, max = MAX_IDENT): string {
  const safe = sanitizeReviewValue(clip(value, max));
  const longestRun = Math.max(0, ...Array.from(safe.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const content = safe.startsWith('`') || safe.endsWith('`') ? ` ${safe} ` : safe;
  return `${fence}${content}${fence}`;
}

/** Preserve the established plain-basename rendering for ordinary files, but move
 * a pathological Markdown-bearing basename into a dynamically fenced code span. */
function renderedFileName(value: string): string {
  const clipped = clip(value);
  const safe = markdownText(clipped);
  return safe === clipped ? clipped : inlineCode(clipped);
}

function renderCaveat(value: string): string {
  return markdownText(value, 500)
    .replaceAll('&#96;openlore analyze&#96;', '`openlore analyze`');
}

/** Join an inline list with a bounded count + "…and N more" tail (no unbounded one-liner). */
function inlineList(items: string[], cap = INLINE_CAP, sep = ', '): string {
  if (items.length <= cap) return items.join(sep);
  return items.slice(0, cap).join(sep) + sep + `…and ${items.length - cap} more`;
}

/** One-line conclusion summarising the whole review. */
function headline(b: ReviewBriefing): string {
  const s = b.structural.summary;
  const blast = b.blast;
  if (b.status === 'unavailable') return 'OpenLore could not analyze this change (see notes below).';
  const parts: string[] = [];
  if (s) {
    if (s.removedFunctions) parts.push(`removed ${s.removedFunctions} function${s.removedFunctions === 1 ? '' : 's'}`);
    if (s.addedFunctions) parts.push(`added ${s.addedFunctions} function${s.addedFunctions === 1 ? '' : 's'}`);
    if (s.signatureChanges) parts.push(`changed ${s.signatureChanges} signature${s.signatureChanges === 1 ? '' : 's'}`);
    if (s.staleCallers) parts.push(`${s.staleCallers} caller${s.staleCallers === 1 ? '' : 's'} now stale`);
  }
  if (!('error' in blast)) {
    if (blast.impact.hubsTouched.length) parts.push(`touches ${blast.impact.hubsTouched.length} hub${blast.impact.hubsTouched.length === 1 ? '' : 's'}`);
    // Phrased as a CLAUSE, not a bare fragment: `parts` is joined into
    // "This change <parts>." — pushing "tests to run could not be computed" alone
    // rendered "This change tests to run could not be computed." at the top of a PR
    // comment, and displaced the clean "No structural changes detected." headline.
    if (blast.tests.unavailable) parts.push('has a test set that could not be computed');
    else if (blast.tests.count) parts.push(`${blast.tests.count} test${blast.tests.count === 1 ? '' : 's'} to run`);
  }
  if (parts.length) return `This change ${parts.join(', ')}.`;
  // "No structural changes detected." is an affirmative all-clear, and it is the line
  // a reviewer acts on. Only say it when both halves actually ran: with the blast
  // radius unavailable (a shallow CI checkout, no index) an empty `parts` means
  // "half the analysis is missing", not "nothing changed".
  if ('error' in blast) {
    return 'Structural delta is clean, but the blast radius could not be computed (see notes below).';
  }
  return 'No structural changes detected.';
}

function mdList(items: string[], cap = 12): string[] {
  const out = items.slice(0, cap).map(i => `- ${i}`);
  if (items.length > cap) out.push(`- …and ${items.length - cap} more`);
  return out;
}

/** Render the full briefing as a Markdown PR comment. First line is the sticky marker. */
export function renderMarkdown(b: ReviewBriefing): string {
  const L: string[] = [];
  L.push(REVIEW_MARKER);
  L.push('## 🔭 OpenLore structural review');
  L.push('');
  L.push(`**${headline(b)}**`);
  L.push('');
  L.push(`<sub>Deterministic structural analysis (no LLM) of ${inlineCode(`${b.base}…${b.head}`, MAX_IDENT * 2 + 1)}.</sub>`);
  L.push('');

  // Keep the gate receipt before any repository-derived detail/caveats. The final
  // GitHub-size clamp preserves this prefix, so the Action never fails without evidence.
  if (b.enforcement && (b.enforcement.gated || b.enforcement.frozen || b.enforcement.new || b.enforcement.retired || b.enforcement.requiresInitialization.length)) {
    L.push('### Blast-radius orphan enforcement');
    L.push(`- **State:** ${b.enforcement.frozen} frozen, ${b.enforcement.new} new, ${b.enforcement.retired} retired${b.enforcement.gated ? ' — gate blocked' : ''}.`);
    if (b.enforcement.evidence.length) {
      for (const item of b.enforcement.evidence) {
        if (item.remediation) L.push(`- **Action:** ${markdownText(item.remediation, 500)}`);
      }
      L.push(`- **Gate evidence:** ${inlineList(b.enforcement.evidence.map((item) => `${inlineCode(item.code)} (${markdownText(item.state, 24)})`))}${b.enforcement.omittedEvidence ? `; …and ${b.enforcement.omittedEvidence} more` : ''}.`);
    }
    if (b.enforcement.requiresInitialization.length) {
      L.push(`- **Action:** run \`openlore enforce\` locally to initialize ${inlineList(b.enforcement.requiresInitialization.map((code) => inlineCode(code)))}, then review and commit the baseline.`);
    } else if (b.enforcement.retired > 0) {
      L.push(`- **Action:** run \`openlore enforce\` locally to retire ${b.enforcement.retired} resolved baseline ${b.enforcement.retired === 1 ? 'identity' : 'identities'}, then review and stage the baseline shrink.`);
    }
    L.push('');
  }

  const s = b.structural;
  if (s.error) {
    L.push(`> ⚠ Structural delta unavailable: ${markdownText(s.error, 500)}`);
    L.push('');
  } else if (s.summary) {
    // ── Structural delta ───────────────────────────────────────────────────────
    const removed = s.removed ?? [];
    const added = s.added ?? [];
    const sig = s.signatureChanged ?? [];
    const renames = s.renameCandidates ?? [];
    if (removed.length || added.length || sig.length || renames.length) {
      L.push('### Structural delta');
      if (removed.length) {
        L.push(...mdList(removed.map(r => {
          const stale = (r.staleCallers?.length ?? 0);
          return `**Removed** ${inlineCode(r.name)} (${renderedFileName(fileName(r.file))})${stale ? ` — ${stale} caller${stale === 1 ? '' : 's'} now dangling` : ''}`;
        })));
      }
      if (sig.length) {
        L.push(...mdList(sig.map(c => {
          const stale = (c.staleCallers?.length ?? 0);
          return `**Signature changed** ${inlineCode(c.name)} (${renderedFileName(fileName(c.file))})${stale ? ` — ${stale} caller${stale === 1 ? '' : 's'} may be stale` : ''}`;
        })));
      }
      if (added.length) {
        L.push(...mdList(added.map(a => `**Added** ${inlineCode(a.name)} (${renderedFileName(fileName(a.file))})`)));
      }
      if (renames.length) {
        L.push(...mdList(renames.map(r => `**Renamed/moved** ${inlineCode(r.from.name)} → ${inlineCode(r.to.name)} (${markdownText(r.confidence, 24)})`)));
      }
      L.push('');
    } else if (s.message) {
      L.push(`_${markdownText(s.message, 500)}_`);
      L.push('');
    }
  }

  // ── Blast radius ─────────────────────────────────────────────────────────────
  const blast = b.blast;
  if ('error' in blast) {
    L.push(`> ⚠ Blast radius unavailable: ${markdownText(blast.error, 500)}`);
    L.push('');
  } else {
    const testSoundness = blast.tests.soundness as { caveats?: string[] } | undefined;
    const testBoundaryCaveats = (testSoundness?.caveats ?? []).filter(caveat =>
      /substring fallback|may have widened/i.test(caveat),
    );
    const hasImpact = blast.impact.hubsTouched.length || blast.impact.layersCrossed.length ||
      blast.impact.governingDecisions.length || blast.tests.count || blast.tests.unavailable ||
      blast.tests.truncatedAtDepth !== undefined || testBoundaryCaveats.length > 0;
    if (hasImpact) {
      L.push('### Blast radius');
      if (blast.impact.hubsTouched.length) {
        L.push(`- **Hubs touched:** ${inlineList(blast.impact.hubsTouched.map(h => `${inlineCode(h.symbol)} (${h.fanIn} callers)`))}`);
      }
      if (blast.impact.layersCrossed.length) {
        L.push(`- **Layers crossed:** ${inlineList(blast.impact.layersCrossed.map(l => markdownText(l, 60)))}`);
      }
      if (blast.impact.governingDecisions.length) {
        L.push(`- **Governing decisions:** ${inlineList(blast.impact.governingDecisionProvenance.map(d => `[${d.provenance}] ${markdownText(d.title, 200)}`), INLINE_CAP, '; ')}`);
      }
      if (blast.tests.unavailable) {
        L.push(`- **Tests to run:** could not be computed (${markdownText(blast.tests.unavailable, 200)}) — not the same as "none impacted".`);
      } else if (blast.tests.count) {
        const tests = blast.tests.toRun.slice(0, 10).map(t => inlineCode(t.test)).join(', ');
        L.push(`- **Tests to run (${blast.tests.count}):** ${tests}${blast.tests.count > 10 ? ', …' : ''}`);
      }
      if (blast.tests.truncatedAtDepth !== undefined) {
        L.push(`- **Test-selection boundary:** reachability was truncated at depth ${blast.tests.truncatedAtDepth}; deeper tests may exist.`);
      }
      for (const caveat of testBoundaryCaveats) L.push(`- **Test-selection boundary:** ${markdownText(caveat, 500)}`);
      L.push('');
    }

    // ── Drift this change introduces (from the blast briefing) ─────────────────
    // Conclusion-shaped: cap each category and summarise the tail, so a wide change
    // (many ADRs reference a touched domain) stays a briefing, not a wall of text.
    const DRIFT_CAP = 5;
    const driftLines: string[] = [];
    for (const m of blast.memory.willDrift.slice(0, DRIFT_CAP)) {
      driftLines.push(`**Memory** [${m.provenance}] ${m.kind === 'memory-orphaned' ? 'orphaned' : 'drifted'}: ${markdownText(m.message, 200)}`);
    }
    const memExtra = blast.memory.drifted + blast.memory.orphaned - Math.min(blast.memory.willDrift.length, DRIFT_CAP);
    if (memExtra > 0) driftLines.push(`…and ${memExtra} more anchored memor${memExtra === 1 ? 'y' : 'ies'}`);
    for (const d of blast.decisions.items.slice(0, DRIFT_CAP)) driftLines.push(`**Decision** [${d.provenance}] ${markdownText(d.kind, 60)}: ${markdownText(d.message, 200)}`);
    if (blast.decisions.affected > Math.min(blast.decisions.items.length, DRIFT_CAP)) {
      driftLines.push(`…and ${blast.decisions.affected - Math.min(blast.decisions.items.length, DRIFT_CAP)} more decision issue(s)`);
    }
    for (const sp of blast.specs.items.slice(0, DRIFT_CAP)) driftLines.push(`**Spec** [${sp.provenance}] ${markdownText(sp.kind, 60)}: ${markdownText(sp.message, 200)}`);
    if (blast.specs.willGoStale > Math.min(blast.specs.items.length, DRIFT_CAP)) {
      driftLines.push(`…and ${blast.specs.willGoStale - Math.min(blast.specs.items.length, DRIFT_CAP)} more spec issue(s)`);
    }
    if (driftLines.length) {
      L.push('### Drift introduced by this change');
      L.push(...driftLines.map(d => `- ${d}`));
      L.push('');
    }
  }

  if (b.caveats.length) {
    L.push('### Notes');
    L.push(...b.caveats.map(c => `- ${renderCaveat(c)}`));
    L.push('');
  }

  L.push('<sub>Advisory by default — gate mode covers opted-in blast-radius orphan enforcement and rejects an invalid candidate enforcement config. Generated by [OpenLore](https://github.com/clay-good/OpenLore) `openlore review`.</sub>');
  const body = L.slice(1).join('\n') + '\n';
  const bodyProvenances = new Set<ServedContentProvenance>(['source-derived']);
  if (!('error' in blast)) {
    for (const d of blast.impact.governingDecisionProvenance) bodyProvenances.add(d.provenance);
    for (const m of blast.memory.willDrift) bodyProvenances.add(m.provenance);
    for (const d of blast.decisions.items) bodyProvenances.add(d.provenance);
    for (const s of blast.specs.items) bodyProvenances.add(s.provenance);
  }
  const provenances = [...bodyProvenances];
  let out = REVIEW_MARKER + '\n' + frameServedContent(body, provenances, 'structural review') + '\n';
  // Final safety net: GitHub rejects a comment body over MAX_MARKDOWN_CHARS (422). The
  // per-item clips + inline caps make this practically unreachable, but a degenerate diff
  // must never produce an un-postable briefing. Head-truncate (the sticky marker is line 1,
  // so it survives) and append a clear notice.
  if (out.length > MAX_MARKDOWN_CHARS) {
    const notice = '\n\n<sub>⚠ Briefing truncated to fit GitHub\'s comment size limit — run `openlore review` locally for the full output.</sub>\n';
    let completedLines = '';
    for (const line of body.split('\n')) {
      const candidate = completedLines + line + '\n';
      const framed = REVIEW_MARKER + '\n' + frameServedContent(candidate + notice, provenances, 'structural review') + '\n';
      if (framed.length > MAX_MARKDOWN_CHARS) break;
      completedLines = candidate;
    }
    out = REVIEW_MARKER + '\n' + frameServedContent(completedLines + notice, provenances, 'structural review') + '\n';
  }
  return out;
}

/** Compact terminal rendering (human-readable, to stdout). */
export function renderHuman(b: ReviewBriefing): string {
  const L: string[] = [];
  L.push('');
  L.push('🔭 OpenLore structural review');
  L.push('   ' + headline(b));
  const s = b.structural;
  if (s.error) L.push(`   ⚠ structural delta: ${s.error}`);
  else if (s.summary) {
    const { removedFunctions: rm, addedFunctions: ad, signatureChanges: sc, staleCallers: st, renameCandidates: rc } = s.summary;
    L.push(`   Delta: ${rm} removed, ${ad} added, ${sc} sig change(s), ${st} stale caller(s), ${rc} rename(s)`);
  }
  const blast = b.blast;
  if ('error' in blast) L.push(`   ⚠ blast radius: ${blast.error}`);
  else {
    if (blast.impact.hubsTouched.length) L.push('   Hubs: ' + blast.impact.hubsTouched.map(h => `${h.symbol} (${h.fanIn})`).join(', '));
    if (blast.impact.layersCrossed.length) L.push('   Layers crossed: ' + blast.impact.layersCrossed.join(', '));
    if (blast.tests.unavailable) L.push('   Tests to run: could not be computed — not the same as "none impacted".');
    else if (blast.tests.count) L.push(`   Tests to run (${blast.tests.count}): ${blast.tests.toRun.slice(0, 8).map(t => t.test).join(', ')}${blast.tests.count > 8 ? ', …' : ''}`);
    if (blast.tests.truncatedAtDepth !== undefined) L.push(`   ⚠ Test reachability was truncated at depth ${blast.tests.truncatedAtDepth}; deeper tests may exist.`);
    const testSoundness = blast.tests.soundness as { caveats?: string[] } | undefined;
    for (const caveat of testSoundness?.caveats ?? []) {
      if (/substring fallback|may have widened/i.test(caveat)) L.push(`   ⚠ ${caveat}`);
    }
    if (blast.impact.governingDecisions.length) L.push('   Governing decisions: ' + blast.impact.governingDecisionProvenance.map(d => `[${d.provenance}] ${d.title}`).join('; '));
  }
  for (const c of b.caveats) L.push(`   ⚠ ${c}`);
  if (b.enforcement?.gated) {
    const evidence = b.enforcement.evidence.map((item) => `${item.code} (${item.state})`).join(', ');
    L.push(`   ⛔ Blast-radius orphan enforcement blocked${evidence ? `: ${evidence}` : '.'}`);
  }
  L.push('');
  return L.join('\n');
}

export interface ReviewCliOptions {
  cwd?: string;
  base?: string;
  head?: string;
  format?: 'markdown' | 'json';
  out?: string;
  /** Hook/gating mode: govern blast-radius orphan findings through the effective policy. */
  hook?: boolean;
}

export async function runReviewCli(opts: ReviewCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const format = opts.format ?? 'markdown';

  const briefing = await composeReview({
    cwd,
    base: opts.base,
    head: opts.head,
    analysisFailed: process.env.OPENLORE_REVIEW_ANALYZE_FAILED === 'true',
  });

  const orphanCodes = ['orphans-anchored-memory', 'orphans-anchored-decision'] as const;
  const trustedBaseRef = briefing.base || opts.base || 'HEAD~1';
  let candidateConfig: OpenLoreConfig | null = null;
  let candidateConfigError: string | null = null;
  try {
    candidateConfig = await readOpenLoreConfigStrict(cwd);
  } catch (error) {
    candidateConfigError = error instanceof Error ? error.message : String(error);
  }
  const trustedConfig = await readTrustedConfig(cwd, trustedBaseRef);
  const trustedPolicy = effectivePolicy('config' in trustedConfig ? trustedConfig.config : null);
  const policy = effectivePolicy(candidateConfigError && 'config' in trustedConfig ? trustedConfig.config : candidateConfig);
  const frozenOrphanCodes = orphanCodes.filter((code) => policy[code] === 'frozen');
  const trustedFrozenOrphanCodes = orphanCodes.filter((code) => trustedPolicy[code] === 'frozen');
  if (candidateConfigError) {
    if ('error' in trustedConfig) {
      briefing.caveats.push(`Candidate config is invalid and the trusted config could not be read; enforcement policy is unverifiable: ${candidateConfigError}`);
      briefing.caveats.push(`Trusted config could not be read: ${trustedConfig.error}`);
    } else if (trustedConfig.config === null) {
      briefing.caveats.push(`Candidate config is invalid and the trusted base has no config; enforcement policy is unverifiable: ${candidateConfigError}`);
    } else {
      briefing.caveats.push(`Candidate config is invalid; review retained the trusted enforcement policy: ${candidateConfigError}`);
    }
  }

  const blastBriefing = 'error' in briefing.blast ? null : briefing.blast;
  const blastAvailable = blastBriefing !== null;
  const assessmentComplete = blastBriefing !== null && blastRadiusAssessmentComplete(blastBriefing);
  const assessedCodes = assessmentComplete ? new Set<string>(orphanCodes) : new Set<string>();
  if (blastAvailable && !assessmentComplete) {
    briefing.caveats.push('Blast-radius orphan baseline was not reconciled because drift analysis was incomplete.');
  }
  const trusted = await readTrustedBaseline(cwd, trustedBaseRef);
  const trustedReadError = 'error' in trusted ? trusted.error : null;
  const findings = blastBriefing === null ? [] : blastRadiusFindings(blastBriefing);
  const reconciled = await applyEnforcementBaseline(
    cwd,
    classifyFindings(findings, policy),
    policy,
    assessedCodes,
    'read-only',
    // `null` means the path was proven absent at the trusted ref. An unreadable
    // ref is not absence and must remain `undefined` so it cannot establish trust.
    'text' in trusted ? trusted.text : undefined,
  );
  const gateEvidence: NonNullable<ReviewBriefing['enforcement']>['evidence'] = reconciled.gate.blocking.map((finding) => ({
    code: finding.code,
    state: finding.enforcementClass === 'frozen' ? 'frozen:new' as const : 'blocking' as const,
    ...(finding.remediation ? { remediation: finding.remediation } : {}),
  }));
  const evidenceByCode = new Map(gateEvidence.map((item) => [item.code, item]));
  if (candidateConfigError) evidenceByCode.set('enforcement-config', { code: 'enforcement-config', state: 'config:invalid' });
  for (const code of reconciled.baseline.requiresInitialization ?? []) {
    if (!evidenceByCode.has(code)) evidenceByCode.set(code, { code, state: 'frozen:uninitialized' });
  }
  const frozenAssessmentInvalid = (frozenOrphanCodes.length > 0 && (
    !assessmentComplete || candidateConfigError !== null || trustedReadError !== null || reconciled.baseline.integrityError === true
  )) || (trustedFrozenOrphanCodes.length > 0 && trustedReadError !== null);
  if (frozenAssessmentInvalid) {
    for (const code of frozenOrphanCodes) evidenceByCode.set(code, { code, state: 'frozen:invalid' });
  }
  if (reconciled.baseline.integrityError) {
    for (const code of trustedFrozenOrphanCodes) evidenceByCode.set(code, { code, state: 'frozen:invalid' });
  }
  if (trustedReadError) {
    for (const code of trustedFrozenOrphanCodes) evidenceByCode.set(code, { code, state: 'frozen:invalid' });
  }
  const evidence = [...evidenceByCode.values()];
  const retired = assessmentComplete && !frozenAssessmentInvalid && 'text' in trusted
    ? wouldRetireCount(trusted.text, findings, new Set(frozenOrphanCodes))
    : 0;
  const enforcementGated = reconciled.gate.gated || frozenAssessmentInvalid || candidateConfigError !== null;
  if (enforcementGated || evidence.length > 0 || frozenOrphanCodes.length > 0 || trustedFrozenOrphanCodes.length > 0) {
    briefing.enforcement = {
      gated: enforcementGated,
      frozen: frozenAssessmentInvalid ? 0 : reconciled.baseline.frozen,
      new: frozenAssessmentInvalid ? 0 : reconciled.baseline.new,
      retired,
      requiresInitialization: reconciled.baseline.requiresInitialization ?? [],
      evidence: evidence.slice(0, INLINE_CAP),
      omittedEvidence: Math.max(0, evidence.length - INLINE_CAP),
    };
  }
  if (reconciled.baseline.caveat) briefing.caveats.push(reconciled.baseline.caveat);
  if (trustedReadError && (candidateConfigError !== null || frozenOrphanCodes.length > 0 || trustedFrozenOrphanCodes.length > 0)) {
    briefing.caveats.push(`Frozen baseline trust check failed: ${trustedReadError}`);
  }

  const rendered = format === 'json'
    ? JSON.stringify({ schemaVersion: 2, ...briefing }, null, 2) + '\n'
    : renderMarkdown(briefing);

  if (opts.out) {
    // Never throw (advisory contract): if the path is unwritable, say so on stderr and
    // fall back to stdout so the briefing is not lost. Diagnostics stay off stdout.
    try {
      await writeFile(opts.out, rendered, 'utf-8');
      process.stderr.write(`[ok] Wrote review briefing to ${opts.out}\n`);
    } catch (err) {
      process.stderr.write(`[warn] Could not write ${opts.out} (${err instanceof Error ? err.message : String(err)}); writing to stdout instead.\n`);
      await writeStdout(rendered);
    }
  } else if (format === 'json') {
    // Await the flush: a large JSON briefing piped to a consumer is truncated at the
    // ~64KB pipe buffer if process.exit() races the async write (see writeStdout).
    await writeStdout(rendered);
  } else {
    // Markdown to stdout (so the CI Action can capture it); a compact human summary
    // to stderr so an interactive run is readable without scraping the markdown.
    await writeStdout(rendered);
    if (process.stderr.isTTY) process.stderr.write(renderHuman(briefing) + '\n');
  }

  if (opts.hook && enforcementGated) {
    process.stderr.write('\n⛔ openlore review: enforcement found blocking, new, uninitialized, unverifiable, or invalid-config state.\n\n');
    return REVIEW_GATE_EXIT_CODE;
  }
  return 0;
}

export const reviewCommand = new Command('review')
  .description('Deterministic structural PR review: structural delta + blast radius as a Markdown briefing (advisory). Composes structural_diff + blast_radius — no LLM.')
  .option('--base <ref>', 'Base git ref to compare against (default: auto-detected — requested → main → master → HEAD~1)')
  .option('--head <ref>', 'Head git ref (default: working tree)')
  .option('--format <fmt>', 'Output format: markdown (default) or json', 'markdown')
  .option('--out <path>', 'Write the briefing to a file instead of stdout')
  .option('--hook', 'Gate blocking, frozen-new, uninitialized, or unverifiable blast-radius orphan enforcement, plus invalid candidate config', false)
  .action(async (opts: { base?: string; head?: string; format?: string; out?: string; hook?: boolean }) => {
    const format = opts.format === 'json' ? 'json' : 'markdown';
    if (opts.format && opts.format !== 'json' && opts.format !== 'markdown') {
      logger.error(`Unknown --format "${opts.format}". Use "markdown" or "json".`);
      process.exit(2);
    }
    // A non-git directory cannot produce a review at all — say so cleanly on stderr
    // (exit 0, advisory) so stdout stays empty rather than carrying a marker-less,
    // non-markdown line that a `review > out.md` consumer would capture.
    // Root-only: review composes blast_radius/structural_diff, whose working-tree
    // path joins are correct only at the repository root; below-root it refuses
    // rather than emit an inconsistent (partly disclosed, partly over-seeded) review.
    if (!(await isGitRepositoryRoot(process.cwd()).catch(() => false))) {
      process.stderr.write('[warn] openlore review: not a git repository (or not at its root) — nothing to compare. Run at the repository root.\n');
      process.exit(0);
    }
    const code = await runReviewCli({
      base: opts.base,
      head: opts.head,
      format,
      out: opts.out,
      hook: opts.hook,
    });
    process.exit(code);
  });
