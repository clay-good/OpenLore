/**
 * Feature inventory — the deterministic, local answer to "what's on, and how do I
 * turn on the rest?" (change: refine-happy-path-and-defaults / ZeroConfigWithGuidedActivation).
 *
 * OpenLore delivers its core value with ZERO required configuration: `orient`,
 * search, blast-radius, and the whole structural graph work with no keys set.
 * Everything beyond that core is an independent OPT-IN feature, each gated by a
 * config block or an on-disk marker. The cost of that design is discoverability:
 * a user who wants semantic search, a commit gate, or a covering-surface
 * certificate has to know which key to set, in which file, from which of ~44 docs.
 *
 * This module is the single source of truth for that map. It reads the project's
 * `.openlore/config.json` and a few well-known on-disk markers and reports, for
 * every opt-in feature: whether it is currently active, a one-line description of
 * its current state, and the ONE command or config snippet that activates it.
 *
 * It is pure data + detection — no rendering, no LLM, no network, no writes — so
 * the `openlore features` CLI, `doctor`, and a future MCP tool can all share it
 * (the MCP-tool ↔ CLI parity rule). Detection is deterministic and fail-soft: an
 * unreadable marker file degrades that one feature to "inactive", never throws.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readOpenLoreConfig } from './config-manager.js';
import { fileExists } from '../../utils/command-helpers.js';
import { LEAN_DEFAULT_PRESET } from '../../constants.js';

/** Whether an opt-in feature is on, off, or on-by-default-but-disableable. */
export type FeatureState = 'active' | 'inactive' | 'default-on';

/** A coarse grouping mirroring the capability families, for legible display. */
export type FeatureGroup = 'Search & navigation' | 'Governance & guardrails' | 'Multi-repo';

export interface FeatureStatus {
  /** Stable identifier (kebab-case), safe to switch on programmatically. */
  id: string;
  /** Human-facing title. */
  title: string;
  /** Display group. */
  group: FeatureGroup;
  /** Current state. */
  state: FeatureState;
  /**
   * Is this a genuine opt-in feature (counts toward "N of M opt-in active"), or
   * an informational / on-by-default line that has no "turn it on" action?
   */
  optIn: boolean;
  /** One-line description of the CURRENT state (what is on, or the active default). */
  detail: string;
  /** The single command or config snippet that activates it; empty when already on or informational. */
  activate: string;
  /** Canonical docs page (repo-relative), when one exists. */
  docs?: string;
}

export interface FeatureInventory {
  /** Whether a `.openlore/config.json` was found (false ⇒ run `openlore init`). */
  configFound: boolean;
  /**
   * Number of config keys a user MUST set for core value. Always 0 — the
   * zero-config baseline is a guarantee, surfaced here so it is visible.
   */
  requiredConfigKeys: 0;
  /** Count of opt-in features currently active. */
  activeCount: number;
  /** Total count of opt-in features. */
  optInCount: number;
  /** Every feature, grouped-display order preserved. */
  features: FeatureStatus[];
}

/** Read and JSON-parse a file, returning null on any failure (fail-soft). */
async function readJsonSoft(path: string): Promise<unknown | null> {
  try {
    if (!(await fileExists(path))) return null;
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Detect the MCP tool preset wired into `.mcp.json`, or null if not wired. */
async function detectWiredPreset(rootPath: string): Promise<string | null> {
  const mcp = (await readJsonSoft(join(rootPath, '.mcp.json'))) as
    | { mcpServers?: Record<string, { args?: unknown }> }
    | null;
  const args = mcp?.mcpServers?.openlore?.args;
  if (!Array.isArray(args)) return null;
  const i = args.indexOf('--preset');
  if (i >= 0 && typeof args[i + 1] === 'string') return args[i + 1] as string;
  // Wired with no explicit preset ⇒ the documented lean default.
  if (args.includes('mcp')) return LEAN_DEFAULT_PRESET;
  return null;
}

/**
 * Federation health, not a registry row count (fix-cli-conclusion-honesty). Reuses the SAME
 * `evaluateRepoState` verdicts `federation list` shows, so `features` and `federation list` can
 * never disagree: a peer whose path no longer exists is `missing` (unreachable), not "registered
 * and healthy". Fail-soft — a corrupt/absent registry reports zero peers rather than throwing.
 */
async function federationHealth(rootPath: string): Promise<{ registered: number; reachable: number; unreachable: number }> {
  try {
    const { listRepos, evaluateRepoState } = await import('../federation/registry.js');
    const repos = listRepos(rootPath);
    let reachable = 0;
    for (const r of repos) if (evaluateRepoState(r) !== 'missing') reachable++;
    return { registered: repos.length, reachable, unreachable: repos.length - reachable };
  } catch {
    return { registered: 0, reachable: 0, unreachable: 0 };
  }
}

/** Detect whether a git pre-commit hook wired to OpenLore is installed. */
async function detectCommitGateHook(rootPath: string): Promise<boolean> {
  const hookPath = join(rootPath, '.git', 'hooks', 'pre-commit');
  try {
    if (!(await fileExists(hookPath))) return false;
    return (await readFile(hookPath, 'utf-8')).includes('openlore');
  } catch {
    return false;
  }
}

/**
 * Collect the full opt-in feature inventory for a project. Deterministic and
 * fail-soft: every detection degrades to "inactive" rather than throwing.
 */
export async function collectFeatureInventory(rootPath: string): Promise<FeatureInventory> {
  const config = await readOpenLoreConfig(rootPath);
  const features: FeatureStatus[] = [];

  // ── Search & navigation ────────────────────────────────────────────────────

  // Semantic embeddings (keyword/BM25 is the first-class default; embeddings are opt-in).
  const emb = config?.embedding;
  const embActive = emb?.provider === 'local' || Boolean(emb?.baseUrl && emb?.model);
  features.push({
    id: 'semantic-embeddings',
    title: 'Semantic embeddings',
    group: 'Search & navigation',
    state: embActive ? 'active' : 'inactive',
    optIn: true,
    detail: embActive
      ? emb?.provider === 'local'
        ? 'on-device local embedder (no key, no endpoint)'
        : `remote endpoint ${emb?.baseUrl ?? ''}`.trim()
      : 'keyword (BM25) search — the first-class default',
    activate: embActive ? '' : 'openlore embed --local',
    docs: 'docs/semantic-search.md',
  });

  // Task-scoped context injection (on by default; disableable).
  const ctxMode = config?.contextInjection?.mode;
  const ctxOff = ctxMode === 'off';
  features.push({
    id: 'context-injection',
    title: 'Task-scoped context injection',
    group: 'Search & navigation',
    state: ctxOff ? 'inactive' : 'default-on',
    optIn: false,
    detail: ctxOff
      ? 'disabled (contextInjection.mode = "off")'
      : `on by default — orient --inject pre-turn hook (~${config?.contextInjection?.tokenBudget ?? 600}-token budget)`,
    activate: ctxOff ? 'set contextInjection.mode = "task-scoped" in .openlore/config.json' : '',
    docs: 'docs/agentic-workflows.md',
  });

  // Wired MCP tool preset (informational — shows the current surface).
  const preset = await detectWiredPreset(rootPath);
  features.push({
    id: 'mcp-tool-preset',
    title: 'MCP tool surface',
    group: 'Search & navigation',
    state: preset ? 'active' : 'inactive',
    optIn: false,
    detail: preset
      ? `wired to the "${preset}" preset`
      : 'no MCP server wired (run "openlore install")',
    activate: preset
      ? 'openlore connect --preset <navigation|substrate|full|…> to change the surface'
      : 'openlore install',
    docs: 'docs/mcp-tools.md',
  });

  // ── Governance & guardrails ────────────────────────────────────────────────

  // Architecture invariants (.openlore/architecture.json).
  const archActive = await fileExists(join(rootPath, '.openlore', 'architecture.json'));
  features.push({
    id: 'architecture-invariants',
    title: 'Architecture invariants',
    group: 'Governance & guardrails',
    state: archActive ? 'active' : 'inactive',
    optIn: true,
    detail: archActive
      ? 'layer / forbidden-import rules declared in .openlore/architecture.json'
      : 'no import-boundary rules declared',
    activate: archActive ? '' : 'create .openlore/architecture.json with layer/forbidden rules',
    docs: 'docs/architecture-invariants.md',
  });

  // Change-impact certificate (covering surfaces).
  const surfaces = config?.impactCertificate?.surfaces ?? [];
  const icBlock = config?.impactCertificate?.block ?? [];
  features.push({
    id: 'impact-certificate',
    title: 'Change-impact certificate',
    group: 'Governance & guardrails',
    state: surfaces.length > 0 ? 'active' : 'inactive',
    optIn: true,
    detail:
      surfaces.length > 0
        ? `${surfaces.length} covering surface(s) declared${icBlock.length > 0 ? `, ${icBlock.length} blocking` : ' (advisory)'}`
        : 'no covering surfaces declared',
    activate:
      surfaces.length > 0 ? '' : 'declare impactCertificate.surfaces in .openlore/config.json',
    docs: 'docs/cross-domain-impact.md',
  });

  // Unified enforcement policy.
  const policy = config?.enforcement?.policy ?? {};
  const policyCodes = Object.keys(policy);
  const blockingCodes = policyCodes.filter((c) => policy[c] === 'blocking');
  const frozenCodes = policyCodes.filter((c) => policy[c] === 'frozen');
  features.push({
    id: 'enforcement-policy',
    title: 'Enforcement policy',
    group: 'Governance & guardrails',
    state: policyCodes.length > 0 ? 'active' : 'inactive',
    optIn: true,
    detail:
      policyCodes.length > 0
        ? `${policyCodes.length} finding code(s) mapped${blockingCodes.length > 0 ? `, ${blockingCodes.length} blocking` : ''}${frozenCodes.length > 0 ? `, ${frozenCodes.length} frozen` : ''}${blockingCodes.length === 0 && frozenCodes.length === 0 ? ' (all advisory/off)' : ''}`
        : 'no policy declared — all findings advisory by default',
    activate:
      policyCodes.length > 0
        ? ''
        : 'map a finding code → "blocking" or "frozen" under enforcement.policy in .openlore/config.json',
    docs: 'docs/governance-dogfooding.md',
  });

  // Blast-radius blocking patterns.
  const brBlock = config?.blastRadius?.block ?? [];
  features.push({
    id: 'blast-radius-block',
    title: 'Blast-radius blocking',
    group: 'Governance & guardrails',
    state: brBlock.length > 0 ? 'active' : 'inactive',
    optIn: true,
    detail:
      brBlock.length > 0
        ? `blocking on: ${brBlock.join(', ')}`
        : 'advisory only — no blocking patterns set',
    activate: brBlock.length > 0 ? '' : 'set blastRadius.block in .openlore/config.json',
    docs: 'docs/blast-radius.md',
  });

  // Commit gate hook (enforce / decisions / blast-radius / impact-cert pre-commit).
  const gateHook = await detectCommitGateHook(rootPath);
  features.push({
    id: 'commit-gate-hook',
    title: 'Commit gate (pre-commit hook)',
    group: 'Governance & guardrails',
    state: gateHook ? 'active' : 'inactive',
    optIn: true,
    detail: gateHook
      ? 'an OpenLore pre-commit hook is installed at .git/hooks/pre-commit'
      : 'no OpenLore git hook installed',
    activate: gateHook ? '' : 'openlore enforce --install-hook',
    docs: 'docs/ci-cd.md',
  });

  // Decision autopilot (change: add-decision-autopilot).
  const autopilotOn = config?.governance?.autopilot === true;
  features.push({
    id: 'decision-autopilot',
    title: 'Decision autopilot (auto-accept + audit trail)',
    group: 'Governance & guardrails',
    state: autopilotOn ? 'active' : 'inactive',
    optIn: true,
    detail: autopilotOn
      ? 'verified decisions auto-accept and sync; commits never block; trail via `openlore decisions log`'
      : 'off — the commit gate blocks for human review of verified decisions',
    activate: autopilotOn ? '' : 'set { "governance": { "autopilot": true } } in .openlore/config.json',
    docs: 'docs/cli-reference.md',
  });

  // Panic / agent behavioral governance.
  const panicMode = config?.panicResponse?.mode;
  const panicActive = Boolean(panicMode) && panicMode !== 'off';
  features.push({
    id: 'panic-response',
    title: 'Agent behavioral governance (panic)',
    group: 'Governance & guardrails',
    state: panicActive ? 'active' : 'inactive',
    optIn: true,
    detail: panicActive
      ? `mode = "${panicMode}"`
      : 'off (default) — behavioral scoring and interventions disabled',
    activate: panicActive ? '' : 'openlore setup --panic',
    docs: 'docs/PHILOSOPHY.md',
  });

  // ── Multi-repo ─────────────────────────────────────────────────────────────

  // Spec-store binding.
  const specStore = config?.specStore;
  features.push({
    id: 'spec-store',
    title: 'Spec-store binding',
    group: 'Multi-repo',
    state: specStore ? 'active' : 'inactive',
    optIn: true,
    detail: specStore
      ? `bound to "${specStore.name}" (${specStore.targets?.length ?? 0} target repo[s])`
      : 'no external spec store bound',
    activate: specStore ? '' : 'declare specStore in .openlore/config.json',
    docs: 'docs/federation.md',
  });

  // Federation registry — reported by peer RESOLVABILITY, not registry row count. A registry with
  // peers but none reachable is degraded, not active: it counts as inactive (no ✓) and says why, so
  // `features` never disagrees with `federation list` (fix-cli-conclusion-honesty).
  const fed = await federationHealth(rootPath);
  const anyReachable = fed.reachable > 0;
  features.push({
    id: 'federation',
    title: 'Federation registry',
    group: 'Multi-repo',
    // Active only when at least one peer is actually reachable; a registry whose peers are all
    // missing provides no cross-repo value, so it is not shown as on.
    state: anyReachable ? 'active' : 'inactive',
    optIn: true,
    detail:
      fed.registered === 0
        ? 'single-repository mode — no peers registered'
        : fed.unreachable === 0
          ? `${fed.registered} peer repo(s) registered, all reachable`
          : `${fed.registered} peer(s) registered, ${fed.unreachable} unreachable (✗ missing path)`,
    activate:
      fed.registered === 0
        ? 'openlore federation add <path> --name <name>'
        : anyReachable
          ? ''
          : 'openlore federation list  # then fix or re-add the unreachable peer path(s)',
    docs: 'docs/federation.md',
  });

  const optIn = features.filter((f) => f.optIn);
  return {
    configFound: config !== null,
    requiredConfigKeys: 0,
    activeCount: optIn.filter((f) => f.state === 'active').length,
    optInCount: optIn.length,
    features,
  };
}
