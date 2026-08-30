/**
 * Architecture invariant rules (spec-23; change: widen-architecture-rule-vocabulary).
 *
 * A small, opt-in, fully declarative rule format for dependency / layer /
 * module-boundary constraints. Rules are author-declared in
 * `.openlore/architecture.json` (and optionally sourced from synced ADR files),
 * NEVER inferred by an LLM. Parsing is total: malformed entries become warnings
 * and are skipped — loading rules never throws.
 *
 * The checker ([check.ts](./check.ts)) compiles these down to deterministic
 * passes over the file-level dependency graph, reusing the canonical
 * `classifyLayerEdge` primitive from the call-graph analyzer for the `layers` kind.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { reviewedFileContentProvenance } from '../services/served-content.js';

/** Where a rule came from — an author's config file, or a recorded decision (spec-16). */
export type RuleSource = 'config' | 'decision';

export interface DecisionRuleReceipt {
  id: string;
  title: string;
  rationale: string;
  servedContentMetadata?: { provenance: 'reviewed-corpus' | 'local-unreviewed' };
}

interface RuleProvenance {
  /** Stable decision-local id; absent on config and legacy Invariant rules. */
  ruleId?: string;
  /** Repository-relative source-path boundary for decision-carried rules. */
  scope?: string;
  /** Governing decision receipt, attached by the trusted corpus loader. */
  decision?: DecisionRuleReceipt;
}

/**
 * Ordered layering: key order is top → bottom, so a lower layer depending on an
 * upper layer is a violation. Each layer maps to one or more path prefixes.
 */
export interface LayersRule extends RuleProvenance {
  kind: 'layers';
  layers: Record<string, string[]>;
  source: RuleSource;
}

/** "Files under `from` must not depend on files under `to`." */
export interface ForbiddenRule extends RuleProvenance {
  kind: 'forbidden';
  from: string;
  to: string;
  reason?: string;
  source: RuleSource;
}

/** Module boundary: "files under `module` may depend ONLY on `mayDependOn` (plus themselves)." */
export interface AllowedOnlyRule extends RuleProvenance {
  kind: 'allowedOnly';
  module: string;
  mayDependOn: string[];
  reason?: string;
  source: RuleSource;
}

/** "Every file under `from` must directly depend on at least one file under `to`." */
export interface RequiredRule extends RuleProvenance {
  kind: 'required';
  from: string;
  to: string;
  reason?: string;
  source: RuleSource;
}

/** "Dependency cycles under `scope` are forbidden except within allowed prefixes." */
export interface CircularRule extends RuleProvenance {
  kind: 'circular';
  scope: string;
  allowed: string[];
  reason?: string;
  source: RuleSource;
}

/** "Files outside `from` must not transitively reach files under `to`." */
export interface ReachableRule extends RuleProvenance {
  kind: 'reachable';
  from: string;
  to: string;
  reason?: string;
  source: RuleSource;
}

/** "Files under `scope` must have at least one incoming dependency." */
export interface OrphanRule extends RuleProvenance {
  kind: 'orphan';
  scope: string;
  reason?: string;
  source: RuleSource;
}

/** "Files under `scope` must not depend on a strictly more-unstable file." */
export interface MoreUnstableRule extends RuleProvenance {
  kind: 'moreUnstable';
  scope: string;
  reason?: string;
  source: RuleSource;
}

export type ArchitectureRule =
  | LayersRule
  | ForbiddenRule
  | AllowedOnlyRule
  | RequiredRule
  | CircularRule
  | ReachableRule
  | OrphanRule
  | MoreUnstableRule;

/** The parsed rule set plus warnings and whether declared config was fully assessed. */
export interface ArchitectureRules {
  rules: ArchitectureRule[];
  warnings: string[];
  /** False when a declared config could not be read or fully parsed. */
  assessmentComplete?: boolean;
}

/** The on-disk shape of `.openlore/architecture.json` (all keys optional). */
interface RawArchitectureConfig {
  layers?: Record<string, string[]>;
  forbidden?: Array<{ from?: unknown; to?: unknown; reason?: unknown }>;
  allowedOnly?: Array<{ module?: unknown; mayDependOn?: unknown; reason?: unknown }>;
  required?: Array<{ from?: unknown; to?: unknown; reason?: unknown }>;
  circular?: Array<{ scope?: unknown; allowed?: unknown; reason?: unknown }>;
  reachable?: Array<{ from?: unknown; to?: unknown; reason?: unknown }>;
  orphan?: Array<{ scope?: unknown; reason?: unknown }>;
  moreUnstable?: Array<{ scope?: unknown; reason?: unknown }>;
}

const ARCHITECTURE_CONFIG_FILE = 'architecture.json';
const ARCHITECTURE_CONFIG_KEYS = new Set<keyof RawArchitectureConfig>([
  'layers', 'forbidden', 'allowedOnly', 'required', 'circular', 'reachable', 'orphan', 'moreUnstable',
]);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function isPathPattern(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim() === '') return false;
  const captureSegments = v.split('/').filter(segment => segment.includes('$'));
  return captureSegments.every(segment => segment === '$1') && captureSegments.length <= 1;
}

function hasCapture(pattern: string): boolean {
  return pattern.split('/').includes('$1');
}

function captureCanResolve(source: string, targets: readonly string[]): boolean {
  return hasCapture(source) || targets.every(target => !hasCapture(target));
}

/**
 * Parse a raw config object into validated rules. Total: every malformed entry is
 * recorded as a warning and skipped; this never throws. `source` tags provenance.
 */
export function parseArchitectureRules(raw: unknown, source: RuleSource): ArchitectureRules {
  const rules: ArchitectureRule[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { rules, warnings: ['architecture rules: expected a JSON object'] };
  }
  const cfg = raw as RawArchitectureConfig;
  for (const key of Object.keys(cfg)) {
    if (!ARCHITECTURE_CONFIG_KEYS.has(key as keyof RawArchitectureConfig)) {
      warnings.push(`architecture rules: unknown top-level key ${JSON.stringify(key)} — skipped`);
    }
  }

  // layers
  if (cfg.layers !== undefined) {
    if (cfg.layers && typeof cfg.layers === 'object' && !Array.isArray(cfg.layers)) {
      const layerEntries: Array<[string, string[]]> = [];
      for (const [name, prefixes] of Object.entries(cfg.layers)) {
        if (isStringArray(prefixes) && prefixes.length > 0 && prefixes.every(isPathPattern)) {
          layerEntries.push([name, prefixes]);
        } else {
          warnings.push(`layers.${name}: expected a non-empty array of path prefixes — skipped`);
        }
      }
      const layers = Object.fromEntries(layerEntries);
      if (Object.keys(layers).length >= 2) {
        rules.push({ kind: 'layers', layers, source });
      } else if (Object.keys(layers).length > 0) {
        warnings.push('layers: need at least 2 layers to define a direction — skipped');
      }
    } else {
      warnings.push('layers: expected an object mapping layer name → path prefixes — skipped');
    }
  }

  // forbidden
  if (cfg.forbidden !== undefined) {
    if (Array.isArray(cfg.forbidden)) {
      cfg.forbidden.forEach((r, i) => {
        if (r && isPathPattern(r.from) && isPathPattern(r.to) && captureCanResolve(r.from, [r.to])) {
          rules.push({
            kind: 'forbidden',
            from: r.from,
            to: r.to,
            reason: typeof r.reason === 'string' ? r.reason : undefined,
            source,
          });
        } else {
          warnings.push(`forbidden[${i}]: requires string "from" and "to" — skipped`);
        }
      });
    } else {
      warnings.push('forbidden: expected an array — skipped');
    }
  }

  // allowedOnly
  if (cfg.allowedOnly !== undefined) {
    if (Array.isArray(cfg.allowedOnly)) {
      cfg.allowedOnly.forEach((r, i) => {
        if (
          r
          && isPathPattern(r.module)
          && isStringArray(r.mayDependOn)
          && r.mayDependOn.every(isPathPattern)
          && captureCanResolve(r.module, r.mayDependOn)
        ) {
          rules.push({
            kind: 'allowedOnly',
            module: r.module,
            mayDependOn: r.mayDependOn,
            reason: typeof r.reason === 'string' ? r.reason : undefined,
            source,
          });
        } else {
          warnings.push(`allowedOnly[${i}]: requires string "module" and string[] "mayDependOn" — skipped`);
        }
      });
    } else {
      warnings.push('allowedOnly: expected an array — skipped');
    }
  }


  const parseFromTo = (
    kind: 'required' | 'reachable',
    entries: unknown,
  ): void => {
    if (entries === undefined) return;
    if (!Array.isArray(entries)) {
      warnings.push(`${kind}: expected an array — skipped`);
      return;
    }
    entries.forEach((entry, i) => {
      const rule = entry as { from?: unknown; to?: unknown; reason?: unknown } | null;
      if (
        rule
        && isPathPattern(rule.from)
        && isPathPattern(rule.to)
        && captureCanResolve(rule.from, [rule.to])
      ) {
        rules.push({
          kind,
          from: rule.from,
          to: rule.to,
          reason: typeof rule.reason === 'string' ? rule.reason : undefined,
          source,
        });
      } else {
        warnings.push(`${kind}[${i}]: requires non-empty path-pattern strings "from" and "to" — skipped`);
      }
    });
  };
  parseFromTo('required', cfg.required);
  parseFromTo('reachable', cfg.reachable);

  if (cfg.circular !== undefined) {
    if (Array.isArray(cfg.circular)) {
      cfg.circular.forEach((entry, i) => {
        if (
          entry
          && isPathPattern(entry.scope)
          && (entry.allowed === undefined
            || (isStringArray(entry.allowed) && entry.allowed.every(isPathPattern)))
          && captureCanResolve(entry.scope, entry.allowed ?? [])
        ) {
          rules.push({
            kind: 'circular',
            scope: entry.scope,
            allowed: entry.allowed ?? [],
            reason: typeof entry.reason === 'string' ? entry.reason : undefined,
            source,
          });
        } else {
          warnings.push(`circular[${i}]: requires a non-empty "scope" and optional string[] "allowed" — skipped`);
        }
      });
    } else {
      warnings.push('circular: expected an array — skipped');
    }
  }

  const parseScoped = (
    kind: 'orphan' | 'moreUnstable',
    entries: unknown,
  ): void => {
    if (entries === undefined) return;
    if (!Array.isArray(entries)) {
      warnings.push(`${kind}: expected an array — skipped`);
      return;
    }
    entries.forEach((entry, i) => {
      const rule = entry as { scope?: unknown; reason?: unknown } | null;
      if (rule && isPathPattern(rule.scope)) {
        rules.push({
          kind,
          scope: rule.scope,
          reason: typeof rule.reason === 'string' ? rule.reason : undefined,
          source,
        });
      } else {
        warnings.push(`${kind}[${i}]: requires a non-empty path-pattern string "scope" — skipped`);
      }
    });
  };
  parseScoped('orphan', cfg.orphan);
  parseScoped('moreUnstable', cfg.moreUnstable);

  return { rules, warnings };
}

/**
 * Parse `Invariant:` markers out of synced ADR files. We read SYNCED files only —
 * never `pending.json` fields, which are purged on sync (spec-16 edge case).
 * Supported single-line grammar (deterministic, no LLM):
 *
 *   Invariant: forbidden <fromPrefix> -> <toPrefix> [(reason)]
 *   Invariant: allowedOnly <modulePrefix> -> <prefixA>, <prefixB> [(reason)]
 *
 * Anything else is ignored. Returns rules tagged `source: 'decision'`.
 */
export function parseInvariantMarkers(adrText: string): ArchitectureRule[] {
  const rules: ArchitectureRule[] = [];
  for (const line of adrText.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*>]\s*)*Invariant:\s*(.+)$/i);
    if (!m) continue;
    let body = m[1].trim();
    let reason: string | undefined;
    const reasonMatch = body.match(/\(([^)]*)\)\s*$/);
    if (reasonMatch) {
      reason = reasonMatch[1].trim() || undefined;
      body = body.slice(0, reasonMatch.index).trim();
    }
    const forbidden = body.match(/^forbidden\s+(\S+)\s*->\s*(\S+)$/i);
    if (forbidden) {
      rules.push({ kind: 'forbidden', from: forbidden[1], to: forbidden[2], reason, source: 'decision' });
      continue;
    }
    const allowed = body.match(/^allowedOnly\s+(\S+)\s*->\s*(.+)$/i);
    if (allowed) {
      const mayDependOn = allowed[2].split(',').map(s => s.trim()).filter(Boolean);
      if (mayDependOn.length > 0) {
        rules.push({ kind: 'allowedOnly', module: allowed[1], mayDependOn, reason, source: 'decision' });
      }
    }
  }
  return rules;
}

/** Read invariants from synced ADR files under `openspec/decisions/adr-*.md`. */
async function loadDecisionInvariants(
  absDir: string,
  openspecPath: string,
): Promise<{ rules: ArchitectureRule[]; warnings: string[] }> {
  const rules: ArchitectureRule[] = [];
  const warnings: string[] = [];
  let decisionsDir: string;
  try {
    decisionsDir = safeJoin(absDir, join(openspecPath, 'decisions'));
  } catch {
    return { rules, warnings: ['decision ADR path escapes the repository — ignored'] };
  }
  let entries: string[];
  try {
    entries = await readdir(decisionsDir);
  } catch {
    return { rules, warnings }; // no decisions dir — fine
  }
  const records: Array<{
    name: string;
    id: string;
    status: string | undefined;
    supersedes?: string;
    title: string;
    rationale: string;
    parsed: ArchitectureRule[];
    hasV1Marker: boolean;
  }> = [];
  for (const name of entries.sort()) {
    if (!/^adr-.*\.md$/i.test(name)) continue;
    try {
      const adrPath = safeJoin(absDir, join(openspecPath, 'decisions', name));
      const text = await readFile(adrPath, 'utf-8');
      const status = text.match(/^## Status\s*\n\s*\n([^\n]+)/m)?.[1]?.trim().toLowerCase();
      const parsed = parseInvariantMarkers(text);
      const idMatches = [...text.matchAll(/^> Decision ID:\s*([A-Za-z0-9_-]+)\s*$/gm)];
      const idMatch = idMatches.at(-1);
      const decisionId = idMatch?.[1]
        ?? name.match(/^adr-([0-9]+)/i)?.[1]
        ?? name;
      const recordedIndex = text.lastIndexOf('> Recorded by openlore decisions');
      const footerText = recordedIndex >= 0
        ? text.slice(recordedIndex)
        : idMatch?.index === undefined ? '' : text.slice(idMatch.index);
      const title = text.match(/^#\s+ADR-[^:]+:\s*(.+)$/m)?.[1]?.trim() ?? name;
      const rationale = text.match(/^## Context\s*\n([\s\S]*?)(?=^##\s)/m)?.[1]?.trim() ?? '';
      records.push({
        name,
        id: decisionId,
        status,
        supersedes: footerText.match(/^> Supersedes:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1],
        title,
        rationale,
        parsed,
        hasV1Marker: new RegExp(
          `^> Recorded by openlore decisions[^\\n]*\\n> Decision ID:\\s*${decisionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n` +
          '(?:> Supersedes:[^\\n]*\\n)?' +
          '> OpenLore constraints:\\s*[^\\n]+\\n?\\s*$',
        ).test(footerText),
      });
    } catch {
      warnings.push(`could not read decision file ${name}`);
    }
  }
  // Status-less ADRs predate lifecycle metadata and were historically active.
  // Preserve that additive compatibility; any explicit non-authoritative status
  // still retires the marker.
  const isLegacyAuthoritative = (status: string | undefined) =>
    status === undefined || status === 'accepted' || status === 'approved';
  const authoritative = records.filter((record) => isLegacyAuthoritative(record.status));
  const edges = new Map<string, string>();
  for (const record of authoritative) {
    if (!record.supersedes) continue;
    if (record.supersedes === record.id) {
      warnings.push(`${record.name}: ignored self-supersession on legacy decision ${record.id}`);
      continue;
    }
    edges.set(record.id, record.supersedes);
  }
  const cycleMembers = new Set<string>();
  for (const start of [...edges.keys()].sort()) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor && edges.has(cursor) && !positions.has(cursor)) {
      positions.set(cursor, path.length);
      path.push(cursor);
      cursor = edges.get(cursor);
    }
    if (cursor && positions.has(cursor)) {
      for (const id of path.slice(positions.get(cursor))) cycleMembers.add(id);
    }
  }
  if (cycleMembers.size > 0) {
    warnings.push(`legacy decision supersession cycle has no terminal decision: ${[...cycleMembers].sort().join(', ')}`);
  }
  const retiredIds = new Set<string>(cycleMembers);
  for (const [source, target] of edges) {
    if (!cycleMembers.has(source) && !cycleMembers.has(target)) retiredIds.add(target);
  }
  for (const record of records) {
    const accepted = isLegacyAuthoritative(record.status);
    if (!accepted || retiredIds.has(record.id) || record.hasV1Marker) {
      if (record.parsed.length > 0) {
        const reason = record.hasV1Marker ? 'a v1 decision constraint block'
          : retiredIds.has(record.id) ? 'supersession'
            : `status ${JSON.stringify(record.status ?? 'unknown')}`;
        warnings.push(`${record.name}: ${record.parsed.length} legacy decision rule(s) retired by ${reason}`);
      }
      continue;
    }
    const provenance = record.status === undefined
      ? 'local-unreviewed' as const
      : await reviewedFileContentProvenance(absDir, join(openspecPath, 'decisions', record.name));
    rules.push(...record.parsed.map((rule, index) => ({
      ...rule,
      ruleId: `legacy-${index + 1}`,
      decision: {
        id: record.id,
        title: record.title,
        rationale: record.rationale,
        servedContentMetadata: { provenance },
      },
    })));
  }
  return { rules, warnings };
}

/**
 * Load the effective architecture rules for a project: the opt-in config file
 * merged with any decision-sourced invariants. Absent config is NOT an error —
 * returns an empty, inert rule set. Never throws.
 */
export async function loadArchitectureRules(
  absDir: string,
  opts: { includeDecisions?: boolean; openspecPath?: string } = {}
): Promise<ArchitectureRules> {
  const rules: ArchitectureRule[] = [];
  const warnings: string[] = [];
  let assessmentComplete = true;

  // Config file (opt-in).
  try {
    const raw = await readFile(join(absDir, OPENLORE_DIR, ARCHITECTURE_CONFIG_FILE), 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push(`${OPENLORE_DIR}/${ARCHITECTURE_CONFIG_FILE}: invalid JSON — ignored`);
      assessmentComplete = false;
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const fromConfig = parseArchitectureRules(parsed, 'config');
      rules.push(...fromConfig.rules);
      warnings.push(...fromConfig.warnings);
      if (fromConfig.warnings.length > 0) assessmentComplete = false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`${OPENLORE_DIR}/${ARCHITECTURE_CONFIG_FILE}: could not read — ${error instanceof Error ? error.message : String(error)}`);
      assessmentComplete = false;
    }
  }

  // Decision-sourced invariants (spec-16 tie), opt-in via flag.
  if (opts.includeDecisions !== false) {
    const openspecPath = opts.openspecPath ?? 'openspec';
    const fromDecisions = await loadDecisionInvariants(absDir, openspecPath);
    rules.push(...fromDecisions.rules);
    warnings.push(...fromDecisions.warnings);
    const { loadDecisionConstraintState } = await import('../decisions/constraint-ledger.js');
    try {
      const constrained = await loadDecisionConstraintState(absDir, openspecPath);
      rules.push(...constrained.rules);
      warnings.push(...constrained.warnings);
    } catch (error) {
      warnings.push(`decision constraints unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { rules, warnings, assessmentComplete };
}

/** True when no rules are declared — the instrument is fully inert. */
export function rulesAreInert(rules: ArchitectureRules): boolean {
  return rules.rules.length === 0;
}
