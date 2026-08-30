/**
 * Architecture invariant checker (spec-23; change: widen-architecture-rule-vocabulary).
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
import type { DependencyEdge } from '../analyzer/dependency-graph.js';
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
  /** Ordered path receipt for transitive and cycle findings. */
  path?: string[];
  /** Lower-confidence edge evidence when the verdict does not rest only on imports. */
  confidence?: string;
  /** Derived instability values for `moreUnstable` findings. */
  instability?: { dependent: number; dependency: number };
  /** The sibling conclusion that owns deletion/dead-code advice. */
  relatedConclusion?: 'find_dead_code';
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
function matchPathPattern(rel: string, pattern: string): string | null {
  const r = norm(rel);
  const p = norm(pattern.replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\*+$/, ''));
  if (!p) return null;
  const patternParts = p.split('/');
  const relParts = r.split('/');
  if (relParts.length < patternParts.length) return null;
  let capture: string | undefined;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === '$1') {
      capture = relParts[i];
    } else if (patternParts[i] !== relParts[i]) {
      return null;
    }
  }
  return capture ?? '';
}

export function pathMatches(rel: string, pattern: string): boolean {
  return matchPathPattern(rel, pattern) !== null;
}

function withCapture(pattern: string, capture: string): string {
  return pattern.replace('$1', capture);
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
      const capture = matchPathPattern(fromRel, rule.from);
      if (capture !== null && pathMatches(toRel, withCapture(rule.to, capture))) {
        return rule.reason ?? `"${rule.from}" must not depend on "${rule.to}"`;
      }
      return null;
    }
    case 'allowedOnly': {
      const capture = matchPathPattern(fromRel, rule.module);
      if (capture === null) return null;
      // Intra-module dependencies are always allowed.
      if (pathMatches(toRel, withCapture(rule.module, capture))) return null;
      if (rule.mayDependOn.some(allowed => pathMatches(toRel, withCapture(allowed, capture)))) return null;
      const why = rule.reason ? ` — ${rule.reason}` : '';
      return `"${rule.module}" may depend only on [${rule.mayDependOn.join(', ')}]${why}`;
    }
    case 'required':
    case 'circular':
    case 'reachable':
    case 'orphan':
    case 'moreUnstable':
      return null;
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
    case 'required': return [rule.from, rule.to];
    case 'circular': return [rule.scope, ...rule.allowed];
    case 'reachable': return [rule.from, rule.to];
    case 'orphan': return [rule.scope];
    case 'moreUnstable': return [rule.scope];
  }
}

function violationBase(rule: ArchitectureRule): Pick<Violation, 'kind' | 'source' | 'ruleId' | 'scope' | 'decision'> {
  return {
    kind: rule.kind,
    source: rule.source,
    ...(rule.ruleId ? { ruleId: rule.ruleId } : {}),
    ...(rule.scope ? { scope: rule.scope } : {}),
    ...(rule.decision ? { decision: rule.decision } : {}),
  };
}

function edgeConfidence(edge: DependencyEdge): string | undefined {
  const confidence = edge.resolutionConfidence ?? edge.httpEdge?.confidence;
  if (confidence && confidence !== 'import' && confidence !== 'exact') return confidence;
  if (edge.isCallEdge && !confidence) return 'unknown';
  return undefined;
}

function graphIndex(depGraph: DependencyGraphResult, rels: Map<string, string>): {
  nodes: string[];
  outgoing: Map<string, Array<{ to: string; edge: DependencyEdge }>>;
  incoming: Map<string, Array<{ from: string; edge: DependencyEdge }>>;
  metrics: Map<string, { inDegree: number; outDegree: number }>;
} {
  const nodes = [...new Set(depGraph.nodes.map(node => toRel(node.id, rels)))].sort();
  const outgoing = new Map(nodes.map(node => [node, [] as Array<{ to: string; edge: DependencyEdge }>]));
  const incoming = new Map(nodes.map(node => [node, [] as Array<{ from: string; edge: DependencyEdge }>]));
  for (const edge of depGraph.edges) {
    const from = toRel(edge.source, rels);
    const to = toRel(edge.target, rels);
    if (from === to) continue;
    outgoing.get(from)?.push({ to, edge });
    incoming.get(to)?.push({ from, edge });
  }
  for (const entries of outgoing.values()) entries.sort((a, b) => a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
  for (const entries of incoming.values()) entries.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
  const metrics = new Map(depGraph.nodes.map(node => [
    toRel(node.id, rels),
    { inDegree: node.metrics.inDegree, outDegree: node.metrics.outDegree },
  ]));
  return { nodes, outgoing, incoming, metrics };
}

function stronglyConnected(
  nodes: string[],
  outgoing: Map<string, Array<{ to: string }>>,
  incoming: Map<string, Array<{ from: string }>>,
): string[][] {
  const allowed = new Set(nodes);
  const visited = new Set<string>();
  const finish: string[] = [];
  for (const start of nodes) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ node: string; index: number; next: string[] }> = [{
      node: start,
      index: 0,
      next: (outgoing.get(start) ?? []).map(edge => edge.to).filter(node => allowed.has(node)),
    }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = frame.next[frame.index++];
      if (next !== undefined) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({
            node: next,
            index: 0,
            next: (outgoing.get(next) ?? []).map(edge => edge.to).filter(node => allowed.has(node)),
          });
        }
      } else {
        finish.push(frame.node);
        stack.pop();
      }
    }
  }
  visited.clear();
  const components: string[][] = [];
  for (const start of finish.reverse()) {
    if (visited.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const node = stack.pop()!;
      component.push(node);
      for (const edge of incoming.get(node) ?? []) {
        if (allowed.has(edge.from) && !visited.has(edge.from)) {
          visited.add(edge.from);
          stack.push(edge.from);
        }
      }
    }
    if (component.length > 1) components.push(component.sort());
  }
  return components.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

function componentMatchesAllowedPattern(component: string[], pattern: string): boolean {
  const capture = matchPathPattern(component[0], pattern);
  if (capture === null) return false;
  if (!pattern.split('/').includes('$1')) return component.every(node => pathMatches(node, pattern));
  return component.every(node => matchPathPattern(node, pattern) === capture);
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
  const index = graphIndex(depGraph, rels);

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
          ...violationBase(rule),
          from: fromRel,
          to: toRelPath,
          reason,
          ...(edgeConfidence(edge) ? { confidence: edgeConfidence(edge) } : {}),
        });
      }
    }
  }

  for (const rule of rules.rules) {
    if (rule.kind === 'required') {
      for (const from of index.nodes) {
        const capture = matchPathPattern(from, rule.from);
        if (capture === null) continue;
        const target = withCapture(rule.to, capture);
        if ((index.outgoing.get(from) ?? []).some(edge => pathMatches(edge.to, target))) continue;
        violations.push({
          ...violationBase(rule),
          from,
          to: target,
          reason: rule.reason ?? `"${rule.from}" must directly depend on "${rule.to}"`,
        });
      }
    } else if (rule.kind === 'circular') {
      const scoped = index.nodes.filter(node => pathMatches(node, rule.scope));
      for (const component of stronglyConnected(scoped, index.outgoing, index.incoming)) {
        if (rule.allowed.some(pattern => componentMatchesAllowedPattern(component, pattern))) continue;
        const confidences = new Set<string>();
        for (const from of component) {
          for (const edge of index.outgoing.get(from) ?? []) {
            if (component.includes(edge.to)) {
              const confidence = edgeConfidence(edge.edge);
              if (confidence) confidences.add(confidence);
            }
          }
        }
        violations.push({
          ...violationBase(rule),
          from: component[0],
          to: component[0],
          path: component,
          reason: rule.reason ?? `dependency cycle under "${rule.scope}": ${component.join(' → ')}`,
          ...(confidences.size > 0 ? { confidence: [...confidences].sort().join(',') } : {}),
        });
      }
    } else if (rule.kind === 'reachable') {
      const targets = index.nodes.filter(node => pathMatches(node, rule.to));
      const queue = [...targets];
      const nextHop = new Map<string, { to: string; edge: DependencyEdge }>();
      const reached = new Set(targets);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const node = queue[cursor];
        for (const edge of index.incoming.get(node) ?? []) {
          if (reached.has(edge.from)) continue;
          reached.add(edge.from);
          nextHop.set(edge.from, { to: node, edge: edge.edge });
          queue.push(edge.from);
        }
      }
      for (const from of [...reached].sort()) {
        if (pathMatches(from, rule.from) || pathMatches(from, rule.to)) continue;
        const path = [from];
        const confidences = new Set<string>();
        let current = from;
        while (nextHop.has(current)) {
          const hop = nextHop.get(current)!;
          const confidence = edgeConfidence(hop.edge);
          if (confidence) confidences.add(confidence);
          current = hop.to;
          path.push(current);
        }
        violations.push({
          ...violationBase(rule),
          from,
          to: path[path.length - 1],
          path,
          reason: rule.reason ?? `files outside "${rule.from}" must not reach "${rule.to}"`,
          relatedConclusion: 'find_dead_code',
          ...(confidences.size > 0 ? { confidence: [...confidences].sort().join(',') } : {}),
        });
      }
    } else if (rule.kind === 'orphan') {
      for (const node of index.nodes.filter(candidate => pathMatches(candidate, rule.scope))) {
        if ((index.incoming.get(node) ?? []).length > 0) continue;
        violations.push({
          ...violationBase(rule),
          from: node,
          to: node,
          reason: rule.reason ?? `"${node}" has no incoming dependency within the indexed graph`,
          relatedConclusion: 'find_dead_code',
        });
      }
    } else if (rule.kind === 'moreUnstable') {
      for (const from of index.nodes.filter(candidate => pathMatches(candidate, rule.scope))) {
        const fromMetrics = index.metrics.get(from);
        if (!fromMetrics) continue;
        const fromTotal = fromMetrics.inDegree + fromMetrics.outDegree;
        const dependent = fromTotal === 0 ? 0 : fromMetrics.outDegree / fromTotal;
        for (const { to, edge } of index.outgoing.get(from) ?? []) {
          const toMetrics = index.metrics.get(to);
          if (!toMetrics) continue;
          const toTotal = toMetrics.inDegree + toMetrics.outDegree;
          const dependency = toTotal === 0 ? 0 : toMetrics.outDegree / toTotal;
          if (dependency <= dependent) continue;
          violations.push({
            ...violationBase(rule),
            from,
            to,
            instability: { dependent, dependency },
            reason: rule.reason ?? `stable module (${dependent.toFixed(3)}) depends on a more-unstable module (${dependency.toFixed(3)})`,
            ...(edgeConfidence(edge) ? { confidence: edgeConfidence(edge) } : {}),
          });
        }
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
