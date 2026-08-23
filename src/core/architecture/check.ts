/**
 * Architecture invariant checker (spec-23).
 *
 * Deterministic, offline passes over the file-level dependency graph. Two entry
 * points:
 *   - `scanViolations` — the full current-violations report (continuous reporting).
 *   - `canImport` — the pre-edit query: "may a file under A import B?", answered
 *     BEFORE the edge is written. Pure; writes nothing.
 *
 * The `layers` kind reuses `classifyLayerEdge` from the call-graph analyzer so the
 * layering convention has exactly one source of truth.
 */

import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { classifyLayerEdge } from '../analyzer/call-graph.js';
import type { ArchitectureRule, ArchitectureRules, RuleSource } from './rules.js';

/** A concrete dependency that breaks a declared rule. Paths are repo-relative. */
export interface Violation {
  kind: ArchitectureRule['kind'];
  from: string;
  to: string;
  reason: string;
  source: RuleSource;
  ruleId?: string;
  scope?: string;
  decision?: ArchitectureRule['decision'];
}

/** Result of a full scan. */
export interface ScanResult {
  violations: Violation[];
  warnings: string[];
  checkedEdges: number;
  rulesApplied: number;
}

/** Verdict for a hypothetical (pre-edit) import. */
export interface ImportVerdict {
  allowed: boolean;
  /** The governing rule when disallowed (or the unresolved-target note). */
  rule?: { kind: ArchitectureRule['kind'] | 'unresolved'; source?: RuleSource; reason: string };
  /** The resolved target file (relative) when a symbol was resolved to one. */
  resolvedTo?: string;
  reason: string;
}

/** Normalize a path to forward slashes with no trailing slash. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Prefix/dir match: `pattern` is treated as a path prefix (a directory or an exact
 * file). Trailing `/`, `/*`, `/**`, or `*` are tolerated and stripped. Deterministic;
 * no full glob engine (kept to the well-understood dir-prefix vocabulary).
 */
export function pathMatches(rel: string, pattern: string): boolean {
  const r = norm(rel);
  const p = norm(pattern.replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\*+$/, ''));
  if (!p) return false;
  return r === p || r.startsWith(p + '/');
}

/**
 * Evaluate one directed edge (relative paths) against one rule. Returns a reason
 * string when the edge violates the rule, or null when it's legal under that rule.
 */
function edgeViolation(fromRel: string, toRel: string, rule: ArchitectureRule): string | null {
  // Decision rule scope bounds the source code governed by the rule. Config and
  // legacy rules have no scope and retain their exact behavior.
  if (rule.scope && !pathMatches(fromRel, rule.scope)) return null;
  switch (rule.kind) {
    case 'layers': {
      const cls = classifyLayerEdge(fromRel, toRel, rule.layers);
      if (!cls) return null;
      return `layer "${cls.fromLayer}" must not depend on upper layer "${cls.toLayer}"`;
    }
    case 'forbidden': {
      if (pathMatches(fromRel, rule.from) && pathMatches(toRel, rule.to)) {
        return rule.reason ?? `"${rule.from}" must not depend on "${rule.to}"`;
      }
      return null;
    }
    case 'allowedOnly': {
      if (!pathMatches(fromRel, rule.module)) return null;
      // Intra-module dependencies are always allowed.
      if (pathMatches(toRel, rule.module)) return null;
      if (rule.mayDependOn.some(allowed => pathMatches(toRel, allowed))) return null;
      const why = rule.reason ? ` — ${rule.reason}` : '';
      return `"${rule.module}" may depend only on [${rule.mayDependOn.join(', ')}]${why}`;
    }
  }
}

/** Build an absolute→relative path map from dependency-graph nodes. */
function relMap(depGraph: DependencyGraphResult): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of depGraph.nodes) {
    if (n.file?.absolutePath && n.file?.path) m.set(n.file.absolutePath, norm(n.file.path));
  }
  return m;
}

/** Resolve an edge endpoint (absolute id or already-relative) to a relative path. */
function toRel(id: string, rels: Map<string, string>): string {
  return rels.get(id) ?? norm(id);
}

/** Every rule prefix, for the non-existent-path warning pass. */
function rulePrefixes(rule: ArchitectureRule): string[] {
  switch (rule.kind) {
    case 'layers': return Object.values(rule.layers).flat();
    case 'forbidden': return [rule.from, rule.to];
    case 'allowedOnly': return [rule.module, ...rule.mayDependOn];
  }
}

/**
 * Full violation scan over the dependency graph. Reports every edge that breaks a
 * declared rule, plus warnings for rule prefixes that match no file in the repo
 * (likely typos) — never a throw.
 */
export function scanViolations(depGraph: DependencyGraphResult, rules: ArchitectureRules): ScanResult {
  const warnings = [...rules.warnings];
  if (rules.rules.length === 0) {
    return { violations: [], warnings, checkedEdges: 0, rulesApplied: 0 };
  }

  const rels = relMap(depGraph);
  const allRel = [...rels.values()];

  // Warn on prefixes that match nothing (typos / stale rules).
  const seenPrefix = new Set<string>();
  for (const rule of rules.rules) {
    for (const prefix of rulePrefixes(rule)) {
      if (seenPrefix.has(prefix)) continue;
      seenPrefix.add(prefix);
      if (!allRel.some(f => pathMatches(f, prefix))) {
        warnings.push(`rule path "${prefix}" matches no file in the repository — check for a typo`);
      }
    }
  }

  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const edge of depGraph.edges) {
    const fromRel = toRel(edge.source, rels);
    const toRelPath = toRel(edge.target, rels);
    if (fromRel === toRelPath) continue;
    for (const rule of rules.rules) {
      const reason = edgeViolation(fromRel, toRelPath, rule);
      if (reason) {
        const key = `${rule.kind}|${rule.decision?.id ?? ''}|${rule.ruleId ?? ''}|${fromRel}|${toRelPath}|${reason}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          kind: rule.kind,
          from: fromRel,
          to: toRelPath,
          reason,
          source: rule.source,
          ...(rule.ruleId ? { ruleId: rule.ruleId } : {}),
          ...(rule.scope ? { scope: rule.scope } : {}),
          ...(rule.decision ? { decision: rule.decision } : {}),
        });
      }
    }
  }

  // Deterministic ordering.
  violations.sort((a, b) =>
    a.from !== b.from ? (a.from < b.from ? -1 : 1)
      : a.to !== b.to ? (a.to < b.to ? -1 : 1)
        : a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1)
          : `${a.decision?.id ?? ''}\0${a.ruleId ?? ''}` < `${b.decision?.id ?? ''}\0${b.ruleId ?? ''}` ? -1
            : `${a.decision?.id ?? ''}\0${a.ruleId ?? ''}` > `${b.decision?.id ?? ''}\0${b.ruleId ?? ''}` ? 1 : 0);

  return { violations, warnings, checkedEdges: depGraph.edges.length, rulesApplied: rules.rules.length };
}

/**
 * Pre-edit query: would importing `to` from `fromFile` be allowed under the rules?
 * `to` may be a file path (relative or absolute) or a bare exported symbol — in the
 * latter case it is resolved to its declaring file via the dependency graph. When
 * the target cannot be resolved to a file, the verdict is permissive (`allowed:
 * true`) with an `unresolved` note: the checker only decides what it can ground.
 */
export function canImport(
  fromFile: string,
  to: string,
  rules: ArchitectureRules,
  depGraph?: DependencyGraphResult
): ImportVerdict {
  if (rules.rules.length === 0) {
    return { allowed: true, reason: 'no architecture rules declared — inert' };
  }

  const rels = depGraph ? relMap(depGraph) : new Map<string, string>();
  const fromRel = toRel(fromFile, rels);

  // Resolve the target to a relative file path.
  const looksLikePath = to.includes('/') || /\.[a-z]{1,5}$/i.test(to);
  let targets: string[];
  if (looksLikePath) {
    targets = [toRel(to, rels)];
  } else if (depGraph) {
    // Bare symbol → declaring file(s).
    targets = depGraph.nodes
      .filter(n => (n.exports ?? []).some(e => e.name === to))
      .map(n => norm(n.file.path))
      .sort();
    if (targets.length === 0) {
      return {
        allowed: true,
        rule: { kind: 'unresolved', reason: `symbol "${to}" not found among exports` },
        reason: `could not resolve "${to}" to a file; no rule could be evaluated`,
      };
    }
  } else {
    return {
      allowed: true,
      rule: { kind: 'unresolved', reason: 'no dependency graph available to resolve symbol' },
      reason: `could not resolve "${to}" without a dependency graph; no rule could be evaluated`,
    };
  }

  // Disallow if ANY candidate target breaks ANY rule (conservative pre-edit guard).
  for (const target of targets) {
    if (fromRel === target) continue;
    for (const rule of rules.rules) {
      const reason = edgeViolation(fromRel, target, rule);
      if (reason) {
        return {
          allowed: false,
          rule: { kind: rule.kind, source: rule.source, reason },
          resolvedTo: target,
          reason: `importing "${target}" from "${fromRel}" violates a ${rule.kind} rule: ${reason}`,
        };
      }
    }
  }

  return {
    allowed: true,
    resolvedTo: looksLikePath ? undefined : targets[0],
    reason: `no rule forbids importing ${looksLikePath ? `"${targets[0]}"` : `"${to}"`} from "${fromRel}"`,
  };
}
