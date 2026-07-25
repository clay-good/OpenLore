/**
 * MCP handler: spec_store_status (change: add-spec-store-binding).
 *
 * A spec-store binding points OpenLore at an external spec repository that
 * declares the code repositories its plans target and reference. The declared
 * target/reference NAMES are resolved against the multi-repo federation registry
 * (`.openlore/federation.json`) — the binding adds no index machinery of its own;
 * it is a thin declarative layer over the shipped index-of-indexes.
 *
 * This handler is read-only and conclusion-shaped: it returns a single binding
 * health report (counts + named findings with stable codes + pasteable
 * remediations), never a graph. It NEVER throws for a configuration or
 * infrastructure problem and it NEVER blocks — every problem degrades to a
 * finding. No LLM (north star `c6d1ad07`).
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { validateDirectory } from './utils.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { listRepos, evaluateRepoState } from '../../federation/registry.js';
import { recheckPersistedCertificates } from './impact-certificate.js';
import type { SpecStoreConfig } from '../../../types/index.js';
import type { FederationRepoEntry, RepoIndexState } from '../../federation/types.js';

/** Stable finding codes — part of the agent-facing `--json` contract. */
export type SpecStoreFindingCode =
  | 'no-binding'          // no spec-store binding is configured (info)
  | 'binding-invalid'     // the binding block is malformed (duplicate/empty/self-referential/cross-listed)
  | 'registry-unreadable' // the federation registry exists but is corrupt/unparseable
  | 'store-path-missing'  // the store's declared path does not exist on disk
  | 'target-unresolved'   // a declared target name is not in the federation registry
  | 'target-missing'      // a resolved target's registered path no longer exists
  | 'index-missing'       // a resolved target has no built `.openlore` index
  | 'index-unbaselined'   // a resolved target has an index but no fingerprint baseline (staleness unassessable)
  | 'index-stale'         // a resolved target's index is stale vs its working tree
  | 'reference-missing'   // a declared reference is unresolved or its path is gone
  | 'certificate-stale';  // a target has a persisted impact certificate whose anchored symbols moved

export type SpecStoreFindingSeverity = 'info' | 'warn' | 'error';

export interface SpecStoreFinding {
  code: SpecStoreFindingCode;
  severity: SpecStoreFindingSeverity;
  /** The store name, target/reference name, or path the finding concerns. */
  subject: string;
  /** What is wrong, in one line. */
  message: string;
  /** A pasteable remediation. */
  remediation: string;
}

interface ResolvedRepoStatus {
  name: string;
  resolved: boolean;
  state?: RepoIndexState;
  path?: string;
}

export interface SpecStoreStatusReport {
  bound: boolean;
  store?: { name: string; path: string };
  targets: ResolvedRepoStatus[];
  references: ResolvedRepoStatus[];
  findings: SpecStoreFinding[];
  /** True when the binding carries no error-severity findings. */
  sound: boolean;
  /** Conclusion-shaped headline. */
  summary: string;
}

/**
 * Canonicalize a path for identity comparison, resolved relative to `base`
 * (the home repo) so a RELATIVE store path is interpreted against the bound
 * repository — not `process.cwd()`, which differs from the home repo on the MCP
 * dispatch path where `directory` is supplied by the caller. Falls back to the
 * resolved path when realpath fails (the path does not exist).
 */
function canonicalize(p: string, base: string): string {
  const abs = resolve(base, p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Validate the binding shape. Returns the offending findings (empty when valid).
 * Pure: no filesystem access beyond a self-reference path comparison.
 */
export function validateSpecStoreConfig(
  binding: SpecStoreConfig,
  homeDir: string,
): SpecStoreFinding[] {
  const findings: SpecStoreFinding[] = [];
  // Config arrives via raw JSON.parse with no schema validation, so any field may
  // be the wrong type. Coerce defensively — a non-string name/path must never make
  // `.trim()` throw (the contract is no-throw); it is treated as missing/invalid.
  const name = typeof binding.name === 'string' ? binding.name.trim() : '';
  const path = typeof binding.path === 'string' ? binding.path.trim() : '';

  if (!name) {
    findings.push({
      code: 'binding-invalid', severity: 'error', subject: 'specStore.name',
      message: binding.name == null ? 'Binding has no name.' : 'Binding "name" is not a string.',
      remediation: 'Set "specStore.name" to a non-empty string in .openlore/config.json.',
    });
  }
  if (!path) {
    findings.push({
      code: 'binding-invalid', severity: 'error', subject: 'specStore.path',
      message: binding.path == null ? 'Binding has no path.' : 'Binding "path" is not a string.',
      remediation: 'Set "specStore.path" to the spec repository location in .openlore/config.json.',
    });
  } else if (canonicalize(path, homeDir) === canonicalize(homeDir, homeDir)) {
    findings.push({
      code: 'binding-invalid', severity: 'error', subject: 'specStore.path',
      message: 'The spec store is bound to this repository itself; a store is an external repository.',
      remediation: 'Point "specStore.path" at the standalone spec repository, not the current repo.',
    });
  }

  // targets/references may contain non-string entries (wrong-typed JSON). Flag them
  // and reduce to the string entries for the dup/cross-list checks below.
  const targets = stringEntries(binding.targets);
  if (Array.isArray(binding.targets) && binding.targets.some(t => typeof t !== 'string')) {
    findings.push({
      code: 'binding-invalid', severity: 'error', subject: 'specStore.targets',
      message: '"specStore.targets" contains a non-string entry.',
      remediation: 'Every entry in "specStore.targets" must be a repository name string.',
    });
  }
  const dupTargets = duplicates(targets);
  for (const d of dupTargets) {
    findings.push({
      code: 'binding-invalid', severity: 'error', subject: d,
      message: `Target "${d}" is declared more than once.`,
      remediation: `Remove the duplicate "${d}" from "specStore.targets".`,
    });
  }
  const references = stringEntries(binding.references);
  if (Array.isArray(binding.references) && binding.references.some(r => typeof r !== 'string')) {
    findings.push({
      code: 'binding-invalid', severity: 'error', subject: 'specStore.references',
      message: '"specStore.references" contains a non-string entry.',
      remediation: 'Every entry in "specStore.references" must be a repository name string.',
    });
  }
  const dupRefs = duplicates(references);
  for (const d of dupRefs) {
    findings.push({
      code: 'binding-invalid', severity: 'error', subject: d,
      message: `Reference "${d}" is declared more than once.`,
      remediation: `Remove the duplicate "${d}" from "specStore.references".`,
    });
  }
  // A name cannot be both a target (the work is about it) and a reference
  // (upstream context only). Declaring it in both is a contradiction that would
  // otherwise be double-resolved with conflicting severities.
  const refSet = new Set(references);
  for (const t of new Set(targets)) {
    if (refSet.has(t)) {
      findings.push({
        code: 'binding-invalid', severity: 'error', subject: t,
        message: `"${t}" is declared as both a target and a reference.`,
        remediation: `List "${t}" under "specStore.targets" OR "specStore.references", not both.`,
      });
    }
  }
  return findings;
}

function duplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) dup.add(n);
    else seen.add(n);
  }
  return [...dup];
}

/** The string entries of a possibly-wrong-typed JSON value (non-strings dropped). */
function stringEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Resolve one declared name against the registry and classify its index state. */
function resolveTarget(
  name: string,
  byName: Map<string, FederationRepoEntry>,
): { status: ResolvedRepoStatus; finding?: SpecStoreFinding } {
  const entry = byName.get(name);
  if (!entry) {
    return {
      status: { name, resolved: false },
      finding: {
        code: 'target-unresolved', severity: 'error', subject: name,
        message: `Declared target "${name}" is not in the federation registry.`,
        remediation: `Register it: openlore federation add <path-to-${name}> --name ${name}`,
      },
    };
  }
  const state = evaluateRepoState(entry);
  const status: ResolvedRepoStatus = { name, resolved: true, state, path: entry.path };
  if (state === 'missing') {
    return { status, finding: {
      code: 'target-missing', severity: 'error', subject: name,
      message: `Target "${name}" resolves to a path that no longer exists: ${entry.path}`,
      remediation: `Update or remove "${name}" in the federation registry (openlore federation remove ${name}).`,
    } };
  }
  if (state === 'unindexed') {
    return { status, finding: {
      code: 'index-missing', severity: 'warn', subject: name,
      message: `Target "${name}" has no built index.`,
      remediation: `Build it: (cd ${entry.path} && openlore analyze)`,
    } };
  }
  if (state === 'unbaselined') {
    return { status, finding: {
      code: 'index-unbaselined', severity: 'warn', subject: name,
      message: `Target "${name}" has an index but no fingerprint baseline yet (registered before its first analyze); staleness cannot be assessed until it is baselined.`,
      remediation: `Baseline it: run "openlore federation status" to adopt the live hash, or (cd ${entry.path} && openlore analyze) then re-run "openlore federation add".`,
    } };
  }
  if (state === 'stale') {
    return { status, finding: {
      code: 'index-stale', severity: 'warn', subject: name,
      message: `Target "${name}" index is stale relative to its working tree.`,
      remediation: `Refresh it: (cd ${entry.path} && openlore analyze)`,
    } };
  }
  return { status };
}

/** Resolve a declared reference — presence only (references are context, not impact targets). */
function resolveReference(
  name: string,
  byName: Map<string, FederationRepoEntry>,
): { status: ResolvedRepoStatus; finding?: SpecStoreFinding } {
  const entry = byName.get(name);
  if (!entry || !existsSync(entry.path)) {
    return {
      status: { name, resolved: false, path: entry?.path },
      finding: {
        code: 'reference-missing', severity: 'warn', subject: name,
        message: entry
          ? `Reference "${name}" resolves to a path that no longer exists: ${entry.path}`
          : `Declared reference "${name}" is not in the federation registry.`,
        remediation: entry
          ? `Update or remove "${name}" in the federation registry.`
          : `Register it: openlore federation add <path-to-${name}> --name ${name}`,
      },
    };
  }
  return { status: { name, resolved: true, state: evaluateRepoState(entry), path: entry.path } };
}

/**
 * Compute the spec-store binding health report for a home repository. Read-only;
 * composes the federation registry only. Never throws for a binding/registry
 * problem — every problem is a finding.
 */
export async function handleSpecStoreStatus(directory: string): Promise<SpecStoreStatusReport> {
  const absDir = await validateDirectory(directory);
  const config = await readOpenLoreConfig(absDir);
  const binding = config?.specStore;

  if (!binding) {
    return {
      bound: false,
      targets: [],
      references: [],
      findings: [{
        code: 'no-binding', severity: 'info', subject: basename(absDir),
        message: 'No spec-store binding is configured; single-repository behavior is unchanged.',
        remediation: 'Add a "specStore" block to .openlore/config.json to bind an external spec store.',
      }],
      sound: true,
      summary: 'No spec-store binding configured.',
    };
  }

  const findings: SpecStoreFinding[] = [];
  findings.push(...validateSpecStoreConfig(binding, absDir));

  const storeName = typeof binding.name === 'string' ? binding.name.trim() : '';
  const storePath = typeof binding.path === 'string' ? binding.path.trim() : '';

  // Store path presence.
  if (storePath && !existsSync(resolve(absDir, storePath))) {
    findings.push({
      code: 'store-path-missing', severity: 'error', subject: storeName || storePath,
      message: `The spec store path does not exist: ${storePath}`,
      remediation: `Clone or check out the spec store at ${storePath}, or fix "specStore.path".`,
    });
  }

  // Load the federation registry. A corrupt/malformed `.openlore/federation.json`
  // makes loadRegistry throw; the contract says the check degrades infrastructure
  // failures to a finding rather than throwing, so catch it, report it as the root
  // cause, and suppress the per-target cascade (the targets may be fine — only the
  // registry is unreadable).
  let byName = new Map<string, FederationRepoEntry>();
  let registryReadable = true;
  try {
    byName = new Map<string, FederationRepoEntry>(listRepos(absDir).map(e => [e.name, e]));
  } catch (err) {
    registryReadable = false;
    findings.push({
      code: 'registry-unreadable', severity: 'error', subject: 'federation.json',
      message: `The federation registry is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Fix or delete .openlore/federation.json (expected shape: { "schemaVersion", "repos": [] }), then re-run.',
    });
  }

  const targets: ResolvedRepoStatus[] = [];
  for (const t of dedupePreserveOrder(stringEntries(binding.targets))) {
    if (!registryReadable) { targets.push({ name: t, resolved: false }); continue; }
    const { status, finding } = resolveTarget(t, byName);
    targets.push(status);
    if (finding) findings.push(finding);
    // Re-fire any stale impact certificate persisted in this target (decay lease;
    // change: add-change-impact-certificate). Cheap-gated: recheckPersistedCertificates
    // returns immediately when the target has no certificates directory, so this adds
    // nothing for repos that never opted into certificates. An expired certificate is
    // surfaced as a finding so it is never trusted past the state it was computed against.
    if (status.resolved && status.state === 'indexed' && status.path) {
      let stales: ReturnType<typeof recheckPersistedCertificates>;
      // Hard no-throw boundary: a target repo's corrupt anchor graph / certificate
      // must never break this read-only health check (handler contract: never throws).
      try { stales = recheckPersistedCertificates(status.path); } catch { stales = []; }
      for (const stale of stales) {
        const moved = stale.movedAnchors.map(m => m.subject).slice(0, 3).join(', ');
        findings.push({
          code: 'certificate-stale', severity: 'warn', subject: `${t}:${stale.change}`,
          message: `Target "${t}" has a stale impact certificate for change "${stale.change}"` +
            (moved ? ` — anchored symbol(s) moved: ${moved}.` : ' — its anchored symbols moved.'),
          remediation: `Re-fire it: (cd ${status.path} && openlore impact-certificate --change ${stale.change} --save).`,
        });
      }
    }
  }

  const references: ResolvedRepoStatus[] = [];
  for (const r of dedupePreserveOrder(stringEntries(binding.references))) {
    if (!registryReadable) { references.push({ name: r, resolved: false }); continue; }
    const { status, finding } = resolveReference(r, byName);
    references.push(status);
    if (finding) findings.push(finding);
  }

  const errors = findings.filter(f => f.severity === 'error').length;
  const warns = findings.filter(f => f.severity === 'warn').length;
  const sound = errors === 0;
  const resolvedTargets = targets.filter(t => t.resolved && t.state === 'indexed').length;

  const summary = sound
    ? `Binding "${storeName}" is sound: ${resolvedTargets}/${targets.length} target(s) indexed and consultable` +
      (warns ? `, ${warns} warning(s)` : '') + '.'
    : `Binding "${storeName}" has ${errors} blocking issue(s) and ${warns} warning(s); see findings.`;

  return {
    bound: true,
    store: { name: storeName, path: storePath },
    targets,
    references,
    findings,
    sound,
    summary,
  };
}

/** De-duplicate names for resolution while keeping first-seen order (the dup itself is a separate validation finding). */
function dedupePreserveOrder(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}
