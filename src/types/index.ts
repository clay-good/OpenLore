/**
 * Core type definitions for openlore
 */

// Project detection types
export type ProjectType = 'nodejs' | 'python' | 'rust' | 'go' | 'java' | 'ruby' | 'php' | 'unknown';

// Panic response impact level
// off: panic subsystem disabled. Freshness/epistemic tracking always runs regardless. (default)
// observe: panic scoring + state file, no intervention — observe the engine without acting
// advisory: full pipeline with L2+ response injection
// experimental_blocking: advisory + a runtime-mediated block signal at L4. EXPLICITLY OPT-IN and
//   never a default. The payload always carries advisory:true — OpenLore recommends, the runtime
//   decides enforcement; OpenLore never mandates. Do NOT enable by default until the observe-mode
//   accuracy gate is cleared (`openlore panic-validate`) — a false positive can block a correct call.
export type PanicResponseMode = 'off' | 'observe' | 'advisory' | 'experimental_blocking';

// Configuration types
export interface OpenLoreConfig {
  version: string;
  projectType: ProjectType;
  openspecPath: string;
  analysis: AnalysisConfig;
  generation: GenerationConfig;
  llm?: LLMConfig;
  embedding?: EmbeddingConfig;
  panicResponse?: {
    /**
     * Controls the panic response subsystem. Default: 'off'.
     *
     * 'off' disables: panic scoring, panic state persistence, panic interventions,
     *   panic telemetry, panic hook output.
     *   Behavioral metrics required by the freshness engine (density, oscillation,
     *   localityConfidence) continue to be computed in-memory as part of EpistemicLease.
     * 'observe': panic scoring + state written, no intervention (collect only).
     * 'advisory': full pipeline with L2+ response injection.
     * 'experimental_blocking': advisory + a runtime block signal at L4 (advisory:true always
     *   present — the runtime decides enforcement). Opt-in only; never enable by default until the
     *   observe-mode accuracy gate (`openlore panic-validate`) is cleared.
     */
    mode: PanicResponseMode;
  };
  createdAt: string;
  lastRun: string | null;
  /**
   * Optional pre-flight blast-radius guard configuration
   * (change: add-preflight-blast-radius-guard). The guard is advisory by
   * default; `block` names the high-risk patterns the git hook should fail a
   * commit on. Empty/absent = advisory-only (the default posture).
   */
  blastRadius?: BlastRadiusConfig;
  /**
   * Optional binding to an external spec store that declares the code
   * repositories its plans target and reference (change: add-spec-store-binding).
   * Configuration only: OpenLore reads the declared relationships and never
   * clones, writes to, synchronizes, or fences the store or any target. Absent
   * binding = unchanged single-repository behavior.
   */
  specStore?: SpecStoreConfig;
  /**
   * Optional declared covering surfaces + advisory posture for the change-impact
   * certificate (change: add-change-impact-certificate). A covering surface is a
   * declared semantic/governance boundary (a set of symbols or files), not a
   * directory glob. The certificate is advisory by default; `block` opts specific
   * surface severities into failing a commit. Absent = no surfaces declared.
   */
  impactCertificate?: ImpactCertificateConfig;
  /**
   * Optional task-scoped context injection settings
   * (change: add-task-scoped-context-injection). When enabled (the default),
   * `openlore orient --inject` — wired by `openlore install` as a per-task
   * pre-turn hook — emits a bounded, attributed, ignorable orientation block so
   * the agent's first turn begins already oriented to the task, amortizing the
   * per-task `orient` round-trip to zero. Absent = task-scoped injection enabled
   * with documented defaults.
   */
  contextInjection?: ContextInjectionConfig;
  /**
   * Optional unified enforcement policy (change: add-finding-enforcement-policy).
   * Maps a stable governance finding `code` to one enforcement class — the single
   * declarative source of truth for "what blocks a commit, what merely advises, and
   * what is deliberately silenced," decoupling a finding's intrinsic severity (owned
   * by its source) from this repository's risk posture (owned here). Additive and
   * optional: an absent or empty policy preserves today's behavior exactly (advisory
   * by default). Supersedes the per-surface `blastRadius.block` / `impactCertificate.block`
   * sugar, which now lowers onto this policy.
   */
  enforcement?: EnforcementConfig;
}

/**
 * How the gate treats a governance finding, independent of the finding's severity
 * (change: add-finding-enforcement-policy). `blocking` fails the gate; `advisory`
 * reports without failing (the default); `off` is a recorded, inspectable silence —
 * the finding is still listed as informational so a deliberate silence is never invisible.
 */
export type EnforcementClass = 'blocking' | 'advisory' | 'off';

/**
 * A repository's declared enforcement policy: a map from a stable finding `code`
 * to its enforcement class. Additive — a code absent from the map keeps its
 * source-declared default. An unrecognized code is retained (a policy may name a
 * code before its source ships) and surfaced as a non-failing config finding.
 */
export interface EnforcementConfig {
  policy?: Record<string, EnforcementClass>;
}

/** Whether task-scoped context injection is active (change: add-task-scoped-context-injection). */
export type ContextInjectionMode = 'off' | 'task-scoped';

/**
 * Task-scoped context-injection settings. All fields optional; the documented
 * defaults are applied when absent (mode `task-scoped`, ~600-token budget, and
 * the relevance-gate thresholds below). The gate is deterministic and never
 * learned: `orient --inject` emits the full block only when the task's graph
 * match clears the threshold, otherwise it degrades to a single pointer line.
 */
export interface ContextInjectionConfig {
  /** `off` makes `orient --inject` a no-op (exit 0); does not affect SessionStart/MCP. Default `task-scoped`. */
  mode?: ContextInjectionMode;
  /** Hard cap on the injected block size, in estimated tokens. Default 600. */
  tokenBudget?: number;
  /** Relevance gate: minimum matched-function count to emit a full block. Default 2. */
  relevanceMinMatches?: number;
  /** Relevance gate: a match with at least this fan-in (or a hub) clears the gate structurally. Default 2. */
  relevanceMinFanIn?: number;
  /** Relevance gate: minimum top match score (semantic/hybrid scale only) to clear the gate. Default 0.3. */
  relevanceMinScore?: number;
}

/** Named high-risk patterns the blast-radius hook may block on (opt-in). */
export type BlastRadiusBlockPattern = 'orphans-anchored-memory' | 'orphans-anchored-decision';

export interface BlastRadiusConfig {
  block?: BlastRadiusBlockPattern[];
}

/** Severity of a declared covering surface (change: add-change-impact-certificate). */
export type CoveringSurfaceSeverity = 'info' | 'warn' | 'critical';

/**
 * One member of a declared covering surface: a symbol name and/or a repo-relative
 * file. A symbol resolves to exactly one indexed node (unique-name match) or it
 * degrades to a finding; a file contributes all of its internal symbols.
 */
export interface CoveringSurfaceMember {
  symbol?: string;
  file?: string;
}

/**
 * A declared covering surface — a semantic or governance boundary a proposed
 * change is assessed against. Additive: absent = no surface assessment.
 */
export interface CoveringSurfaceConfig {
  /** Stable, user-facing name (e.g. "client", "data-handling", "regulated"). */
  name: string;
  /** The boundary members (symbols and/or files). */
  members: CoveringSurfaceMember[];
  /** Optional severity; a surface marked `critical` MAY be opted into blocking. */
  severity?: CoveringSurfaceSeverity;
}

export interface ImpactCertificateConfig {
  /** Declared covering surfaces this repository is assessed against. */
  surfaces?: CoveringSurfaceConfig[];
  /**
   * Surface severities whose newly-opened paths the git hook should block a commit
   * on (opt-in). Empty/absent = advisory-only (the default posture).
   */
  block?: CoveringSurfaceSeverity[];
}

/**
 * A binding to an external spec store (change: add-spec-store-binding). The
 * store is a standalone repository that holds specs/changes; `targets` and
 * `references` are repository NAMES resolved against the federation registry
 * (`.openlore/federation.json`). A target is a code repository the store's work
 * is about; a reference is upstream context it draws on.
 */
export interface SpecStoreConfig {
  /** Stable, user-facing name for the store. */
  name: string;
  /** Absolute or home-relative path to the external spec repository. */
  path: string;
  /** Federation-registered names of the code repositories the store targets. */
  targets: string[];
  /** Federation-registered names of repositories the store references for context. */
  references?: string[];
}

export interface EmbeddingConfig {
  /**
   * Embedding provider.
   *  - `'remote'` (default): an OpenAI-compatible `/embeddings` endpoint
   *    (`baseUrl` + `model` required).
   *  - `'local'`: an on-device, CPU-only embedder requiring no endpoint and no
   *    API key. The model is lazily downloaded and cached on first use. `model`
   *    is optional (defaults to a pinned small model); `baseUrl`/`apiKey` are
   *    ignored.
   * Omitting `provider` keeps the historical behaviour: a remote endpoint when
   * `baseUrl` + `model` are present, otherwise no embeddings (keyword default).
   */
  provider?: 'remote' | 'local';
  /** Base URL of the OpenAI-compatible embeddings endpoint (remote provider) */
  baseUrl?: string;
  /** Embedding model name (required for remote; optional override for local) */
  model?: string;
  /** API key — optional for local servers (remote provider only) */
  apiKey?: string;
  /** Maximum number of texts per embedding batch (default: 64) */
  batchSize?: number;
  /** Disable SSL certificate verification (e.g. self-signed certs on local servers) */
  skipSslVerify?: boolean;
}

export interface AnalysisConfig {
  maxFiles: number;
  includePatterns: string[];
  excludePatterns: string[];
}

export interface GenerationConfig {
  provider?: 'anthropic' | 'openai' | 'openai-compat' | 'copilot' | 'gemini' | 'claude-code' | 'mistral-vibe' | 'gemini-cli' | 'cursor-agent';
  model?: string;
  openaiCompatBaseUrl?: string;
  skipSslVerify?: boolean;
  /** Disable response_format field in requests (for endpoints that don't support structured output) */
  disableResponseFormat?: boolean;
  /** LLM request timeout in milliseconds. Default: 120000 (2 minutes) */
  timeout?: number;
  /** Max characters per file chunk sent to the LLM. Default: 8000. Increase for large-context models. */
  chunkMaxChars?: number;
  domains: string | string[];
}

export interface LLMConfig {
  /** Custom API base URL for OpenAI-compatible servers */
  apiBase?: string;
  /** Whether to verify SSL certificates (default: true) */
  sslVerify?: boolean;
}

// File metadata types
export interface FileMetadata {
  path: string;
  absolutePath: string;
  name: string;
  extension: string;
  size: number;
  lines: number;
  depth: number;
  directory: string;
  isEntryPoint: boolean;
  isConfig: boolean;
  isTest: boolean;
  isGenerated: boolean;
}

export interface ScoredFile extends FileMetadata {
  score: number;
  scoreBreakdown: {
    name: number;
    path: number;
    structure: number;
    connectivity: number;
  };
  tags: string[];
}

export interface FileWalkerResult {
  files: FileMetadata[];
  summary: {
    totalFiles: number;
    totalDirectories: number;
    byExtension: Record<string, number>;
    byDirectory: Record<string, number>;
    skippedCount: number;
    skippedReasons: Record<string, number>;
  };
  rootPath: string;
  timestamp: string;
}

// CLI option types
export interface GlobalOptions {
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
  config: string;
}

export interface InitOptions extends GlobalOptions {
  force: boolean;
  openspecPath: string;
}

export interface AnalyzeOptions extends GlobalOptions {
  output: string;
  maxFiles: number;
  include: string[];
  exclude: string[];
}

export interface GenerateOptions extends GlobalOptions {
  analysis: string;
  model: string;
  dryRun: boolean;
  domains: string[];
  adr: boolean;
  adrOnly: boolean;
  force?: boolean;
}

export interface VerifyOptions extends GlobalOptions {
  samples: number;
  threshold: number;
}

// Analysis result types
export interface AnalysisResult {
  repositoryMap: RepositoryMap;
  dependencyGraph: DependencyGraph;
  summary: AnalysisSummary;
  timestamp: string;
}

export interface RepositoryMap {
  root: string;
  files: ScoredFile[];
  directories: DirectoryInfo[];
  projectType: ProjectType;
}

export interface DirectoryInfo {
  path: string;
  fileCount: number;
  purpose: string;
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface DependencyNode {
  id: string;
  path: string;
  type: 'file' | 'module' | 'package';
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'import' | 'export' | 'extends' | 'implements';
}

export interface AnalysisSummary {
  totalFiles: number;
  analyzedFiles: number;
  skippedFiles: number;
  detectedDomains: string[];
  entryPoints: string[];
  confidence: number;
}

// OpenSpec output types
export interface OpenSpecDomain {
  name: string;
  path: string;
  requirements: OpenSpecRequirement[];
  entities: OpenSpecEntity[];
  sourceFiles: string[];
  confidence: number;
}

export interface OpenSpecRequirement {
  name: string;
  description: string;
  keyword: 'SHALL' | 'MUST' | 'SHOULD' | 'MAY';
  scenarios: OpenSpecScenario[];
}

export interface OpenSpecScenario {
  name: string;
  given: string;
  when: string;
  then: string;
  and?: string[];
}

export interface OpenSpecEntity {
  name: string;
  properties: EntityProperty[];
  sourceFile: string;
}

export interface EntityProperty {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

// Drift detection types
export type DriftSeverity = 'error' | 'warning' | 'info';

export type DriftIssueKind =
  | 'gap' // Code changed, spec doesn't cover it
  | 'stale' // Spec describes behavior that code no longer implements
  | 'uncovered' // New file/function with no matching spec at all
  | 'orphaned-spec' // Spec references files that no longer exist
  | 'adr-gap' // Code changed in domain referenced by an ADR
  | 'adr-orphaned' // ADR references domains that no longer exist in specs
  | 'memory-drifted' // Code-anchored memory's subject changed since it was recorded
  | 'memory-orphaned'; // Code-anchored memory's subject no longer exists

export interface DriftOptions extends GlobalOptions {
  base: string;
  files: string[];
  domains: string[];
  useLlm: boolean;
  json: boolean;
  installHook: boolean;
  uninstallHook: boolean;
  failOn: DriftSeverity;
  maxFiles: number;
  suggestTests: boolean;
}

export interface DriftIssue {
  id: string;
  kind: DriftIssueKind;
  severity: DriftSeverity;
  message: string;
  filePath: string;
  domain: string | null;
  specPath: string | null;
  changedLines?: { added: number; removed: number };
  suggestion: string;
}

export interface DriftResult {
  timestamp: string;
  baseRef: string;
  totalChangedFiles: number;
  specRelevantFiles: number;
  issues: DriftIssue[];
  summary: {
    gaps: number;
    stale: number;
    uncovered: number;
    orphanedSpecs: number;
    adrGaps: number;
    adrOrphaned: number;
    memoryDrifted: number;
    memoryOrphaned: number;
    total: number;
  };
  hasDrift: boolean;
  duration: number;
  mode: 'static' | 'llm-enhanced';
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  additions: number;
  deletions: number;
  isTest: boolean;
  isConfig: boolean;
  isGenerated: boolean;
  extension: string;
}

export interface SpecMapping {
  domain: string;
  specPath: string;
  declaredSourceFiles: string[];
  inferredSourceFiles: string[];
  allSourceFiles: string[];
  requirements: string[];
  entities: string[];
}

export interface SpecMap {
  byDomain: Map<string, SpecMapping>;
  byFile: Map<string, string[]>;
  domainCount: number;
  totalMappedFiles: number;
}

// ============================================================================
// SPEC SNAPSHOT
// ============================================================================

export interface SpecSnapshotDomain {
  name: string;
  specFile: string;
  sourceFiles: string[];
  requirementCount: number;
  mappedFunctionCount: number;
  coveragePct: number;
  specModifiedAt: string;
  sourcesModifiedAt: string;
}

export interface SpecSnapshotHub {
  name: string;
  file: string;
  fanIn: number;
  covered: boolean;
}

export interface SpecSnapshot {
  version: '1';
  generatedAt: string;
  git: { commit: string; branch: string; dirty: boolean };
  coverage: {
    totalFunctions: number;
    coveredFunctions: number;
    orphanFunctions: number;
    coveragePct: number;
  };
  domains: SpecSnapshotDomain[];
  hubs: SpecSnapshotHub[];
}

// ============================================================================
// AUDIT REPORT
// ============================================================================

export interface AuditUncoveredFunction {
  name: string;
  file: string;
  kind: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
}

export interface AuditOrphanRequirement {
  requirement: string;
  domain: string;
  specFile: string;
}

export interface AuditStaleDomain {
  name: string;
  specFile: string;
  specModifiedAt: string;
  sourcesModifiedAt: string;
  staleSince: string;
}

export interface AuditReport {
  generatedAt: string;
  summary: {
    totalFunctions: number;
    coveredFunctions: number;
    coveragePct: number;
    uncoveredCount: number;
    hubGapCount: number;
    orphanRequirementCount: number;
    staleDomainCount: number;
  };
  uncoveredFunctions: AuditUncoveredFunction[];
  hubGaps: AuditUncoveredFunction[];
  orphanRequirements: AuditOrphanRequirement[];
  staleDomains: AuditStaleDomain[];
}

// ============================================================================
// DECISIONS
// ============================================================================

export type DecisionScope =
  | 'local'        // single file, no cross-cutting concern
  | 'component'    // single component/service/module boundary
  | 'cross-domain' // touches multiple spec domains or service contracts
  | 'system';      // global constraint (auth, data model, infra, API protocol)

export type DecisionStatus =
  | 'draft'         // recorded by agent during dev session
  | 'consolidated'  // LLM has merged/resolved drafts
  | 'verified'      // cross-checked against diff — has code evidence
  | 'phantom'       // recorded but no matching code change found
  | 'approved'      // human/agent approved for sync
  | 'rejected'      // human/agent rejected
  | 'synced';       // written to spec files

/** A single architectural decision recorded during a dev session. */
export interface PendingDecision {
  /** Stable 8-char ID: sha1(sessionId:domain:title).slice(0,8) */
  id: string;
  status: DecisionStatus;

  // Content
  title: string;
  rationale: string;
  consequences: string;
  proposedRequirement: string | null;

  // Context
  affectedDomains: string[];
  affectedFiles: string[];

  /**
   * Structural anchors binding this decision to the code it describes, resolved
   * deterministically against the call graph at record time. Optional and
   * additive: legacy decisions recorded before anchoring fall back to file-level
   * freshness derived from `affectedFiles`. See {@link StructuralAnchor}.
   */
  anchors?: StructuralAnchor[];

  /** ID of a prior decision this one supersedes (agent signals a reversal) */
  supersedes?: string;

  // Provenance
  sessionId: string;
  recordedAt: string;
  consolidatedAt?: string;
  verifiedAt?: string;

  // Scope — gates ADR creation: only cross-domain and system produce ADRs
  scope?: DecisionScope;

  // Verification output
  confidence: 'high' | 'medium' | 'low';
  evidenceFile?: string;

  // Review
  reviewedAt?: string;
  reviewNote?: string;

  // Sync tracking
  syncedAt?: string;
  syncedToSpecs: string[];
}

/** Persistent store written to .openlore/decisions/pending.json */
export interface DecisionStore {
  version: '1';
  /** Cleared when a new session starts (new commit cycle) */
  sessionId: string;
  updatedAt: string;
  /**
   * Monotonic write counter for atomic compare-and-swap on save
   * (change: harden-memory-integrity-invariant). Additive — defaults to 0 for
   * legacy stores written before this field existed.
   */
  sequence?: number;
  /** Set after consolidation runs — gate uses this to skip no_decisions_recorded warning */
  lastConsolidatedAt?: string;
  decisions: PendingDecision[];
}

// ============================================================================
// CODE-ANCHORED MEMORY (change: add-code-anchored-memory-staleness)
// ============================================================================

/**
 * A structural anchor binds a persisted memory to the code it describes so that
 * the memory can self-invalidate deterministically when that code changes or
 * dies. Resolution and freshness use only static analysis — no LLM.
 *
 * - Symbol-level anchor: `nodeId` + `symbolName` set, `contentHash` is the hash
 *   of the function's source span captured at record time.
 * - File-level anchor: only `filePath` set (with optional `contentHash` = the
 *   file's content hash at record time). Used when no symbol resolves, and for
 *   legacy decisions backfilled from `affectedFiles`.
 */
export interface StructuralAnchor {
  /** Call-graph node id; absent for a file-level anchor. */
  nodeId?: string;
  /**
   * Content-addressed, location-independent stable id of the anchored symbol
   * (add-content-addressed-stable-symbol-ids). Recorded alongside `nodeId` so a
   * symbol that is later moved/renamed can be re-resolved when its `nodeId` no
   * longer matches. Absent on anchors recorded before this change and on symbols
   * with no derivable stable id — both keep their exact current behavior.
   */
  stableId?: string;
  /** Symbol name resolved at record time; absent for a pure file-level anchor. */
  symbolName?: string;
  /** Repo-relative path of the anchored file. Always present. */
  filePath: string;
  /**
   * Hash of the anchored span at record time. For a symbol anchor, the function
   * source span; for a file anchor, the whole-file content. Absent for a truly
   * legacy file anchor with no captured baseline (only existence can be checked).
   */
  contentHash?: string;
  /**
   * Provenance recorded when this anchor was carried across an unambiguous
   * rename/move (add-symbol-identity-continuity). The identity fields above were
   * re-pointed from `from` to the current symbol; `contentHash` keeps its original
   * baseline so the freshness check still reports `fresh` (exact-body carry) or
   * `drifted` (the rename changed the span). Additive + auditable: a wrong carry
   * can be traced back. Absent on anchors that never moved.
   */
  carriedAcross?: ContinuityProvenance;
  /**
   * Disclosure for an orphaned symbol anchor whose disappeared symbol had MORE
   * than one equally-plausible destination after a re-analysis
   * (add-symbol-identity-continuity). No carry-forward occurs (ambiguity is never
   * resolved by guessing); these are the candidate new locations
   * (`filePath::symbolName`) for a human/agent to reconcile. Absent unless an
   * ambiguous move was detected for this anchor.
   */
  possiblyMovedTo?: string[];
}

/** How a symbol's identity moved between two indexed states (add-symbol-identity-continuity). */
export type ContinuityReason = 'renamed' | 'moved' | 'renamed-and-moved';

/**
 * The evidence basis for a continuity match (add-symbol-identity-continuity):
 * - `exact-body` — the new symbol's source span is byte-identical to the old one
 *   (a pure move; the name did not change).
 * - `exact-signature` — the new span is identical to the old one EXCEPT the symbol's
 *   own name changed (a rename), verified by substituting the new name back to the
 *   old name and confirming it hashes to the recorded baseline span — NOT a mere
 *   parameter-shape match.
 * Both are admitted only on a strict one-to-one match; anything ambiguous yields
 * no pair (see {@link StructuralAnchor.possiblyMovedTo}).
 */
export type ContinuityBasis = 'exact-body' | 'exact-signature';

/** Recorded when an anchor is carried across a rename/move. */
export interface ContinuityProvenance {
  /** The prior symbol the anchor was carried from. */
  from: { symbolName?: string; filePath: string };
  reason: ContinuityReason;
  basis: ContinuityBasis;
  /** HEAD commit SHA at carry time (deterministic, read from git); absent outside a repo. */
  atCommit?: string;
}

/** Deterministic freshness verdict for a single anchor or an aggregated memory. */
export type MemoryFreshness = 'fresh' | 'drifted' | 'orphaned';

/** The freshness of one anchor, with the new location when a rename was detected. */
export interface AnchorVerdict {
  anchor: StructuralAnchor;
  freshness: MemoryFreshness;
  /** New location when the anchored symbol was confidently renamed/relocated. */
  relocatedTo?: string;
  /**
   * True when this verdict is `drifted` ONLY because the symbol sits in an
   * explicitly-marked stale region whose topology a budget-exceeded incremental
   * update did not recompute — the symbol's own span is unchanged. Lets callers
   * explain "not yet reconciled" vs "the code itself changed"
   * (fix-transitive-incremental-staleness).
   */
  staleRegion?: boolean;
}

/**
 * Evidence behind a `fresh` verdict (add-trust-calibrated-context-economy). The
 * exact span and hash OpenLore already compared to produce `fresh` — surfaced so
 * an agent can cite it and skip re-reading the source. Never attached to a
 * `drifted` or `orphaned` fact.
 */
export interface GroundingCertificate {
  /** Resolved symbol name; absent for a file-level certificate. */
  symbol?: string;
  /** Repo-relative path of the verified file. */
  filePath: string;
  /** 1-based inclusive line range of the verified span, when known. */
  lineSpan?: { start: number; end: number };
  /** Hash of the verified span — the same hash the freshness check compared. */
  contentHash: string;
}

/**
 * Closed set of caller-supplied memory classifications (add-bitemporal-typed-memory-operations).
 * Caller-supplied label only — never inferred or classified by an LLM. An absent or
 * unrecognized value resolves to `note`, so legacy memories and unlabeled writes behave as today.
 */
export type MemoryType =
  | 'invariant'
  | 'gotcha'
  | 'rationale'
  | 'convention'
  | 'preference'
  | 'todo'
  | 'note';

/** The seven valid memory types, for runtime validation/normalization. */
export const MEMORY_TYPES: readonly MemoryType[] = [
  'invariant', 'gotcha', 'rationale', 'convention', 'preference', 'todo', 'note',
];

/**
 * A general, code-anchored agent memory (kind `note`) — the substrate behind the
 * `remember`/`recall` tools. Stored separately from the decision gate in
 * .openlore/memory/notes.json so it never touches the commit pipeline.
 */
export interface AnchoredMemory {
  /** Stable 8-char id derived from content + resolved anchors (content-anchor dedup). */
  id: string;
  kind: 'note';
  content: string;
  anchors: StructuralAnchor[];
  recordedAt: string;
  /** Free-form retrieval tags (optional). */
  tags?: string[];
  /**
   * Caller-supplied classification from the closed {@link MemoryType} set; absent ⇒ `note`.
   * (add-bitemporal-typed-memory-operations) Never inferred.
   */
  type?: MemoryType;
  /**
   * Bitemporal valid-time marker: the `HEAD` commit SHA at record time, read from git
   * (deterministic, no LLM). Absent for legacy memories ⇒ treated as always-valid.
   * (add-bitemporal-typed-memory-operations)
   */
  validFromCommit?: string;
  /** Transaction-time of invalidation (ISO); set when this memory is superseded. */
  invalidatedAt?: string;
  /** The `HEAD` commit SHA at the time this memory was invalidated. */
  invalidatedByCommit?: string;
  /** Id of the prior memory this one supersedes (provenance for the lifecycle op). */
  supersedes?: string;
}

/** Persistent store written to .openlore/memory/notes.json */
export interface MemoryStore {
  version: '1';
  updatedAt: string;
  /**
   * Monotonic write counter for atomic compare-and-swap on save
   * (change: harden-memory-integrity-invariant). Additive — defaults to 0 for
   * legacy stores written before this field existed.
   */
  sequence?: number;
  memories: AnchoredMemory[];
}
