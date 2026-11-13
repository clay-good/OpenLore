/** Host-independent configuration protocol. Repository data never carries authority. */
export type ConfigurationLane = 'index' | 'watch' | 'embed';
export interface FilePolicyRule {
  id: string;
  pattern: string;
  lanes: Partial<Record<ConfigurationLane, 'include' | 'exclude'>>;
  reason: string;
  evidenceRefs?: string[];
}
export interface FilePolicies {
  rules: FilePolicyRule[];
}
export interface ConfigurationAssistantConfig {
  reviewMode?: 'manual' | 'notify';
}
export interface ConfigurationEvidence {
  id: string;
  path: string;
  revision: string;
  kind: 'manifest' | 'ignore' | 'topology' | 'tracked';
  facts: Record<string, string | string[]>;
}
export interface ConfigurationDisclosure {
  code: string;
  path?: string;
  detail: string;
}
export interface ConfigurationContinuation {
  scope: string;
  evidenceRevision: string;
  rootRevision: string;
  snapshot: Array<{ path: string; revision: string }>;
}
export interface ConfigurationInspection {
  version: 1;
  root: string;
  configPath: string;
  configRevision: string;
  evidenceRevision: string;
  policyRevision: string;
  selection: {
    rules: FilePolicyRule[];
    includePatterns: string[];
    excludePatterns: string[];
    reviewMode: 'manual' | 'notify';
  };
  evidence: ConfigurationEvidence[];
  samples: string[];
  excludedDirectories: string[];
  counts: { entries: number; contentBytes: number; sourceFilesObserved: number };
  complete: boolean;
  disclosures: ConfigurationDisclosure[];
  continuation?: ConfigurationContinuation;
  runtime: {
    compatibilityScope: 'descriptor-and-protocol';
    daemon: 'absent' | 'compatible' | 'incompatible' | 'unknown';
    watcher: 'healthy' | 'stopped' | 'unknown';
    index: 'absent' | 'present-unverified';
  };
  recommendations: ConfigurationRecommendation[];
}
export interface ConfigurationRecommendation {
  id: string;
  rule: FilePolicyRule;
  evidenceRefs: string[];
  basis: 'declared' | 'hypothesis';
  impact: string;
  uncertainty: string[];
}
export interface ConfigurationCandidate {
  rules: FilePolicyRule[];
  reviewMode?: 'manual' | 'notify';
  analysis?: { includePatterns?: string[]; excludePatterns?: string[] };
}
export type ConfigurationOutcome =
  | 'needs-input'
  | 'blocked'
  | 'stale-plan'
  | 'applied-pending-verification'
  | 'verified'
  | 'partially-verified'
  | 'failed'
  | 'reverted';
export interface ConfigurationPatch {
  field:
    | 'filePolicies'
    | 'configurationAssistant'
    | 'analysis'
    | 'version'
    | 'projectType'
    | 'openspecPath'
    | 'generation'
    | 'createdAt'
    | 'lastRun';
  before: unknown;
  after: unknown;
}
export interface ConfigurationPlan {
  version: 1;
  id: string;
  root: string;
  configPath: string;
  configRevision: string;
  evidenceRevision: string;
  policyRevision: string;
  createdAt: string;
  inspection?: Pick<ConfigurationOptions, 'scope' | 'budget' | 'continuation'>;
  candidate: ConfigurationCandidate;
  patches: ConfigurationPatch[];
  conflicts: string[];
  examples: Record<string, string[]>;
  disclosures: ConfigurationDisclosure[];
  effects: string[];
  requiredPermissions: Array<'write-config' | 'replace-choices'>;
}
export interface ConfigurationVerificationObservation {
  /** A host must observe working-tree freshness separately from an artifact policy stamp. */
  indexGenerationCurrent?: boolean;
  indexPolicyRevision?: string;
  watchPolicyRevision?: string;
  embeddingPolicyRevision?: string;
  toolsCompatible?: boolean;
  watchedPaths?: string[];
  sourceEventDelivered?: boolean;
  canaryCleaned?: boolean;
}
export interface ConfigurationReceipt {
  version: 1;
  planId: string;
  outcome: ConfigurationOutcome;
  reason?: string;
  configPublished: boolean;
  policyRevision?: string;
  verification?: Record<string, 'verified' | 'pending' | 'not-assessed' | 'failed'>;
  observations?: ConfigurationVerificationObservation;
  disclosures: ConfigurationDisclosure[];
  rollbackId?: string;
  retained?: boolean;
  observedAt?: string;
}
export interface ConfigurationAuthority {
  root: string;
  planId: string;
  permissions: Array<'write-config' | 'replace-choices' | 'runtime' | 'probe'>;
}
export interface ConfigurationOptions {
  rootPath?: string;
  configPath?: string;
  signal?: AbortSignal;
  protectedExcludePatterns?: string[];
  /** A trusted host capability, never copied from serialized tool arguments. */
  authority?: ConfigurationAuthority;
  scope?: string;
  continuation?: ConfigurationContinuation;
  budget?: Partial<{
    entries: number;
    depth: number;
    bytes: number;
    fileBytes: number;
    milliseconds: number;
  }>;
  observe?: (root: string, signal?: AbortSignal) => Promise<ConfigurationVerificationObservation>;
  activate?: (plan: ConfigurationPlan, signal?: AbortSignal) => Promise<void>;
  /** Host-owned optional probe, responsible for source and derived-entry cleanup. */
  canaryTimeoutMs?: number;
  canary?: (
    plan: ConfigurationPlan,
    signal?: AbortSignal
  ) => Promise<{ delivered: boolean; cleaned: boolean }>;
}
