/**
 * `openlore import <artifact>` — bootstrap the local graph index from a portable artifact,
 * validate-or-rebuild (change: add-shareable-graph-artifact).
 *
 * The consumer validates integrity and currency before promotion, while producer authenticity
 * is a separate optional signature verdict. Unsigned integrity is never described as authenticity.
 *   1. bundle format version compatible       (else rebuild)
 *   2. payload byte-integrity (tamper/corrupt) (else rebuild)
 *   3. index schema version matches            (else rebuild)
 *   4. graph-content digest == bundled attestation, and the store reconciles healthy (else rebuild)
 *   5. currency vs the working tree:
 *        clean build + commit == HEAD → import as-is (current versus that commit)
 *        dirty / legacy-unknown build → import as-is with approximate/unknown currency
 *        no git / commit unknown   → import as-is, currency disclosed as UNVERIFIED
 *        clean ancestor → apply the exact bounded delta through the watcher convergence path
 *        diverged / dirty ancestor / oversized delta → full local rebuild
 * Any validation failure degrades transparently to a local rebuild — import never leaves the
 * consumer worse off than having no artifact. The mechanism is offline and deterministic.
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { basename, resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';
import { gitPathArgs } from '../../utils/git-args.js';
import {
  OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_CALL_GRAPH_DB, ARTIFACT_FINGERPRINT, DEFAULT_MAX_FILES,
  OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR, OPENSPEC_DECISIONS_SUBDIR,
  WATCH_BULK_THRESHOLD,
} from '../../constants.js';
import { EdgeStore, SCHEMA_VERSION } from '../../core/services/edge-store.js';
import { VectorIndex } from '../../core/analyzer/vector-index.js';
import { mapFilesBounded } from '../../core/analyzer/bounded-file-scan.js';
import { SpecVectorIndex } from '../../core/analyzer/spec-vector-index.js';
import type { FileSignatureMap } from '../../core/analyzer/signature-extractor.js';
import { computeAttestation, reconcile, writeAttestation } from '../../core/analyzer/index-attestation.js';
import { isGitRepository, validateGitRef } from '../../core/drift/git-diff.js';
import {
  parseBundle,
  verifyPayloadIntegrity,
  verifyBundleSignature,
  verifyBundledSourceIdentity,
  recomputeProductionDigest,
  materializeBundle,
  promoteStagedIndex,
  removeDir,
  BundleError,
  BUNDLE_VERSION,
  BUNDLE_MAX_COMPRESSED_BYTES,
  IMPORT_STAGE_PREFIX,
  type Bundle,
  type BundleSignatureVerdict,
} from '../../core/analyzer/index-bundle.js';
import { runAnalysis } from './analyze.js';
import { readOpenLoreConfig, retargetPrimaryConfigRoot } from '../../core/services/config-manager.js';
import { captureSourceState, type SourceTreeState } from '../../core/analyzer/source-state.js';
import { FileWalker } from '../../core/analyzer/file-walker.js';
import { analysisGeneratedExcludes, mergeAnalysisPatterns } from '../../core/analyzer/analysis-core.js';
import { detectLanguage } from '../../core/analyzer/signature-extractor.js';
import { isTestFile } from '../../core/analyzer/test-file.js';
import { computeProjectFingerprint, fingerprintHashOfConfiguration } from '../../core/services/mcp-handlers/utils.js';
import { McpWatcher } from '../../core/services/mcp-watcher.js';
import { atomicWriteFile } from '../../core/decisions/atomic-store.js';

const execFileAsync = promisify(execFile);
const GIT_DELTA_MAX_PATHS = 4_096;
const GIT_DELTA_MAX_PATH_BYTES = 1024 * 1024;

export interface ImportOptions {
  projectRoot?: string;
}

/** A rebuild reason, or null when the pre-materialize checks pass. Pure — unit-tested. */
export function preMaterializeRebuildReason(
  bundle: Bundle,
  currentBundleVersion = BUNDLE_VERSION,
  currentSchemaVersion = SCHEMA_VERSION,
): { reason: string; detail: string } | null {
  if (!Number.isSafeInteger(bundle.manifest.bundleVersion) ||
      bundle.manifest.bundleVersion < 1 || bundle.manifest.bundleVersion > currentBundleVersion) {
    return {
      reason: 'bundle-version',
      detail:
        `Artifact bundle format v${bundle.manifest.bundleVersion} is not compatible with this OpenLore ` +
        `(supports v1 through v${currentBundleVersion}).`,
    };
  }
  if (bundle.manifest.schemaVersion !== currentSchemaVersion) {
    return {
      reason: 'schema-mismatch',
      detail:
        `Artifact index schema v${bundle.manifest.schemaVersion} does not match this OpenLore's ` +
        `schema v${currentSchemaVersion} (mismatched).`,
    };
  }
  return null;
}

export type ImportAction = 'import-current' | 'import-delta' | 'import-approximate' | 'import-currency-unknown' | 'rebuild';

/** Decide currency once the artifact has materialized and validated. Pure — unit-tested. */
export function currencyDecision(facts: {
  isGitRepo: boolean;
  sourceCommit: string | null;
  sourceTreeState: SourceTreeState;
  consumerTreeState?: SourceTreeState;
  commitMatchesHead: boolean;
  commitIsAncestor: boolean;
}): { action: ImportAction; reason: string; detail: string } {
  if (!facts.isGitRepo || !facts.sourceCommit) {
    return {
      action: 'import-currency-unknown',
      reason: 'currency-unverified',
      detail:
        'Currency could NOT be established (no git repository or no recorded build ' +
        'commit). If the source has changed since the artifact was built, run "openlore analyze".',
    };
  }
  if (facts.commitMatchesHead) {
    if (facts.sourceTreeState === 'dirty') {
      return {
        action: 'import-approximate',
        reason: 'dirty-build',
        detail: facts.consumerTreeState === 'dirty'
          ? `Approximately current — built from a dirty tree at ${facts.sourceCommit}, and the importing checkout also has local changes.`
          : `Approximately current — built from a dirty tree at ${facts.sourceCommit}.`,
      };
    }
    if (facts.consumerTreeState === 'dirty') {
      return {
        action: 'import-approximate',
        reason: 'dirty-consumer',
        detail: `Approximately current — the checkout at ${facts.sourceCommit} has local changes.`,
      };
    }
    if (facts.consumerTreeState === 'unknown') {
      return {
        action: 'import-currency-unknown',
        reason: 'consumer-tree-state-unknown',
        detail: 'Currency is unknown because the importer could not establish whether the checkout is clean.',
      };
    }
    if (facts.sourceTreeState === 'unknown') {
      return {
        action: 'import-currency-unknown',
        reason: 'tree-state-unknown',
        detail: 'Currency is unknown because the bundle did not prove whether its analyzed tree was clean.',
      };
    }
    return { action: 'import-current', reason: 'commit-matches-head', detail: `Current at commit ${facts.sourceCommit}.` };
  }
  if (facts.commitIsAncestor) {
    if (facts.sourceTreeState !== 'clean') {
      return {
        action: 'rebuild',
        reason: 'stale-tree-state',
        detail: 'Artifact was built from an ancestor whose source tree was not proven clean; an exact commit delta cannot reconstruct that baseline, so rebuilding locally.',
      };
    }
    return {
      action: 'import-delta',
      reason: 'stale',
      detail: 'Artifact was built at an ancestor commit — applying the validated bundle and catching up its exact source delta.',
    };
  }
  return {
    action: 'rebuild',
    reason: 'unrelated-commit',
    detail: 'Artifact build commit is not an ancestor of the working tree (diverged/unknown) — rebuilding locally.',
  };
}

export interface GitDeltaPaths {
  changed: string[];
  deleted: string[];
}

/** Parse `git diff --name-status -z -M` without treating repository paths as shell input. */
export function parseGitNameStatus(raw: Buffer): GitDeltaPaths {
  if (raw.length > 0 && raw[raw.length - 1] !== 0) {
    throw new Error('Malformed git delta: missing terminal NUL.');
  }
  let offset = 0;
  let pathCount = 0;
  let pathBytes = 0;
  const nextField = (): string | null => {
    if (offset >= raw.length) return null;
    const end = raw.indexOf(0, offset);
    if (end < 0) throw new Error('Malformed git delta: unterminated field.');
    const value = raw.toString('utf8', offset, end);
    offset = end + 1;
    return value;
  };
  const nextPath = (status: string): string => {
    const path = nextField();
    if (!path) throw new Error(`Malformed git delta entry for status ${status}.`);
    pathCount++;
    pathBytes += Buffer.byteLength(path);
    if (pathCount > GIT_DELTA_MAX_PATHS || pathBytes > GIT_DELTA_MAX_PATH_BYTES) {
      throw new Error('Git delta exceeds the bounded path-work budget; rebuilding is required.');
    }
    return path;
  };
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (;;) {
    const status = nextField();
    if (status === null) break;
    if (!status) throw new Error('Malformed git delta: missing status.');
    const code = status[0];
    const scored = /^[RC](\d{1,3})$/.exec(status);
    const validStatus = /^[ADMT]$/.test(status) ||
      (scored !== null && Number(scored[1]) <= 100);
    if (!validStatus || !'ACDMRT'.includes(code)) {
      throw new Error(`Git delta status ${status} cannot be caught up safely.`);
    }
    const first = nextPath(status);
    if (code === 'R' || code === 'C') {
      const second = nextPath(status);
      if (code === 'R') deleted.add(first);
      changed.add(second);
    } else if (code === 'D') {
      deleted.add(first);
    } else {
      changed.add(first);
    }
  }
  return { changed: [...changed].sort(), deleted: [...deleted].sort() };
}

function parseNulPaths(raw: Buffer, existingPathCount: number): string[] {
  if (raw.length > 0 && raw[raw.length - 1] !== 0) {
    throw new Error('Malformed git path list: missing terminal NUL.');
  }
  const paths: string[] = [];
  let offset = 0;
  let bytes = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset);
    if (end < 0) throw new Error('Malformed git path list: unterminated path.');
    if (end === offset) throw new Error('Malformed git path list: empty path.');
    const path = raw.toString('utf8', offset, end);
    paths.push(path);
    bytes += end - offset;
    if (existingPathCount + paths.length > GIT_DELTA_MAX_PATHS || bytes > GIT_DELTA_MAX_PATH_BYTES) {
      throw new Error('Git delta exceeds the bounded path-work budget; rebuilding is required.');
    }
    offset = end + 1;
  }
  return paths;
}

async function collectGitDelta(rootPath: string, sourceCommit: string): Promise<GitDeltaPaths> {
  const [{ stdout: diff }, { stdout: untracked }] = await Promise.all([
    execFileAsync('git', gitPathArgs('diff', '--name-status', '-z', '-M', sourceCommit, '--'), {
      cwd: rootPath,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    }),
    execFileAsync('git', gitPathArgs('ls-files', '--others', '--exclude-standard', '-z'), {
      cwd: rootPath,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    }),
  ]);
  const parsed = parseGitNameStatus(diff as Buffer);
  const existingPathCount = parsed.changed.length + parsed.deleted.length;
  parsed.changed.push(...parseNulPaths(untracked as Buffer, existingPathCount));
  parsed.changed = [...new Set(parsed.changed)].sort();
  return parsed;
}

async function intersectDeltaWithAnalysisCorpus(
  rootPath: string,
  analysisDir: string,
  delta: GitDeltaPaths,
): Promise<GitDeltaPaths> {
  const changedCorpusRule = [...delta.changed, ...delta.deleted].find(file =>
    basename(file) === '.gitignore' || basename(file) === '.openlore-ignore' ||
    file.replace(/\\/g, '/') === '.openlore/config.json');
  if (changedCorpusRule) {
    throw new Error(
      `Analysis corpus rules changed at ${changedCorpusRule}; rebuilding is required to establish exact membership.`,
    );
  }
  const config = await readOpenLoreConfig(rootPath);
  if ((config?.analysis.includePatterns?.length ?? 0) > 0) {
    throw new Error(
      'Configured analysis include patterns are not represented in legacy bundle fingerprints; rebuilding is required to prove exact membership.',
    );
  }
  const patterns = mergeAnalysisPatterns(config?.analysis, [], []);
  const protectedExcludePatterns = analysisGeneratedExcludes(
    rootPath,
    join(rootPath, OPENLORE_ANALYSIS_REL_PATH),
    config?.openspecPath,
  );
  const walk = await new FileWalker(rootPath, {
    maxFiles: config?.analysis.maxFiles ?? DEFAULT_MAX_FILES,
    includePatterns: patterns.includePatterns,
    restrictedIncludePatterns: config?.analysis.includePatterns,
    excludePatterns: patterns.excludePatterns,
    protectedExcludePatterns,
  }).walk();
  if (walk.summary.truncated) {
    throw new Error('The configured analysis corpus is truncated; bundle catch-up cannot prove exact membership, so a full rebuild is required.');
  }
  const currentConfigHash = fingerprintHashOfConfiguration({
    ...patterns,
    maxFiles: config?.analysis.maxFiles ?? DEFAULT_MAX_FILES,
    protectedExcludePatterns,
  });
  const bundledFingerprint = JSON.parse(await readFile(join(analysisDir, ARTIFACT_FINGERPRINT), 'utf8')) as {
    analysisConfigHash?: unknown;
  };
  if (bundledFingerprint.analysisConfigHash !== currentConfigHash) {
    throw new Error('Analysis configuration changed since the bundle was built; rebuilding is required to establish the exact corpus.');
  }
  const admitted = new Set(walk.files.map(file => file.path));
  const priorCorpus = new Set(await readBundledDependencyPaths(analysisDir));
  const changedTests = [
    ...delta.changed.filter(file => admitted.has(file) && isTestFile(file)),
    ...delta.deleted.filter(file => priorCorpus.has(file) && isTestFile(file)),
  ];
  if (changedTests.length > 0) {
    throw new Error(
      `Test-source changes require a full rebuild to preserve full-graph test impact data (${changedTests[0]}).`,
    );
  }
  const store = EdgeStore.open(join(analysisDir, ARTIFACT_CALL_GRAPH_DB));
  try {
    return {
      changed: delta.changed.filter(file => admitted.has(file) && !isTestFile(file) &&
        (detectLanguage(file) !== 'unknown' || /\.html?$/i.test(file))),
      deleted: delta.deleted.filter(file => priorCorpus.has(file) ||
        store.getFileHash(file) !== null || store.getNodesForFile(file).length > 0),
    };
  } finally {
    store.close();
  }
}

async function refreshCaughtUpIdentity(rootPath: string, analysisDir: string): Promise<void> {
  const config = await readOpenLoreConfig(rootPath);
  const protectedExcludePatterns = analysisGeneratedExcludes(
    rootPath,
    join(rootPath, OPENLORE_ANALYSIS_REL_PATH),
    config?.openspecPath,
  );
  const fingerprintConfig = {
    ...mergeAnalysisPatterns(config?.analysis, [], []),
    maxFiles: config?.analysis.maxFiles ?? DEFAULT_MAX_FILES,
    protectedExcludePatterns,
  };
  const walk = await new FileWalker(rootPath, {
    maxFiles: fingerprintConfig.maxFiles,
    includePatterns: fingerprintConfig.includePatterns,
    restrictedIncludePatterns: config?.analysis.includePatterns,
    excludePatterns: fingerprintConfig.excludePatterns,
    protectedExcludePatterns,
  }).walk();
  if (walk.summary.truncated) {
    throw new Error('The configured analysis corpus became truncated during catch-up; refusing to publish it.');
  }
  const state = await captureSourceState(rootPath);
  const hash = await computeProjectFingerprint(rootPath, { configuration: fingerprintConfig, protectedExcludePatterns });
  await atomicWriteFile(join(analysisDir, ARTIFACT_FINGERPRINT), JSON.stringify({
    hash,
    commit: state.commit,
    sourceTreeState: state.treeState,
    computedAt: new Date().toISOString(),
    fileCount: walk.files.length,
    analysisConfigHash: fingerprintHashOfConfiguration(fingerprintConfig),
  }));
  const store = EdgeStore.open(join(analysisDir, ARTIFACT_CALL_GRAPH_DB));
  try {
    const nodes = store.getAllInternalNodes();
    await writeAttestation(analysisDir, computeAttestation(
      store.getSchemaVersion(),
      nodes.map(node => ({ id: node.id, filePath: node.filePath })),
      store.getAllEdges().map(edge => ({ callerId: edge.callerId, calleeId: edge.calleeId, calleeName: edge.calleeName })),
      store.getAllClasses().map(cls => ({ id: cls.id })),
    ));
  } finally {
    store.close();
  }
  const finalState = await captureSourceState(rootPath);
  if (finalState.commit !== state.commit || finalState.treeState !== state.treeState ||
      await computeProjectFingerprint(rootPath, { configuration: fingerprintConfig, protectedExcludePatterns }) !== hash) {
    throw new Error('Source files changed during bundle catch-up; refusing to publish a stale artifact generation.');
  }
}

async function assertCaughtUpIdentityCurrent(rootPath: string, analysisDir: string): Promise<void> {
  const fingerprint = JSON.parse(await readFile(join(analysisDir, ARTIFACT_FINGERPRINT), 'utf8')) as {
    hash?: unknown;
    commit?: unknown;
    sourceTreeState?: unknown;
  };
  if (typeof fingerprint.hash !== 'string') {
    throw new Error('Caught-up fingerprint is missing its source hash.');
  }
  const config = await readOpenLoreConfig(rootPath);
  const protectedExcludePatterns = analysisGeneratedExcludes(
    rootPath,
    join(rootPath, OPENLORE_ANALYSIS_REL_PATH),
    config?.openspecPath,
  );
  const fingerprintConfig = {
    ...mergeAnalysisPatterns(config?.analysis, [], []),
    maxFiles: config?.analysis.maxFiles ?? DEFAULT_MAX_FILES,
    protectedExcludePatterns,
  };
  const capturePublishTreeState = async (): Promise<SourceTreeState> => execFileAsync(
      'git',
      gitPathArgs(
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--',
        '.',
        `:(exclude)${OPENLORE_ANALYSIS_REL_PATH}/**`,
        `:(exclude)${OPENLORE_ANALYSIS_REL_PATH}`,
        `:(exclude).openlore/${IMPORT_STAGE_PREFIX}*`,
        `:(exclude).openlore/${IMPORT_STAGE_PREFIX}*/**`,
      ),
      { cwd: rootPath },
    ).then(({ stdout }) => stdout.length === 0 ? 'clean' : 'dirty')
      .catch(() => 'unknown');
  const beforeState = await captureSourceState(rootPath);
  const beforeTreeState = await capturePublishTreeState();
  const firstHash = await computeProjectFingerprint(rootPath, {
    configuration: fingerprintConfig,
    protectedExcludePatterns,
  });
  const middleState = await captureSourceState(rootPath);
  const middleTreeState = await capturePublishTreeState();
  const secondHash = await computeProjectFingerprint(rootPath, {
    configuration: fingerprintConfig,
    protectedExcludePatterns,
  });
  const afterState = await captureSourceState(rootPath);
  const afterTreeState = await capturePublishTreeState();
  const changed = [
    ...(firstHash !== fingerprint.hash || secondHash !== fingerprint.hash ? ['content fingerprint'] : []),
    ...([beforeState.commit, middleState.commit, afterState.commit]
      .some(commit => commit !== fingerprint.commit) ? ['commit'] : []),
    ...([beforeTreeState, middleTreeState, afterTreeState]
      .some(treeState => treeState !== fingerprint.sourceTreeState) ? ['tree state'] : []),
  ];
  if (changed.length > 0) {
    throw new Error(
      `Source ${changed.join(', ')} changed before bundle catch-up publication; refusing to publish a stale generation.`,
    );
  }
}

export function provenanceDetail(verdict: BundleSignatureVerdict): string {
  if (verdict.status === 'unsigned') {
    return 'Integrity-consistent; provenance UNVERIFIED — trust the source of this bundle.';
  }
  const named = verdict.label ? `${verdict.label} (${verdict.keyId})` : verdict.keyId;
  return `Provenance verified (signed by ${named}).`;
}

async function gitResolveCommit(rootPath: string, ref: string): Promise<string | null> {
  try {
    validateGitRef(ref);
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: rootPath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitIsAncestor(rootPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: rootPath });
    return true;
  } catch {
    return false;
  }
}

/** Read the per-file signature maps the bundle persisted in llm-context.json (best-effort). */
export async function readBundledSignatures(analysisDir: string): Promise<FileSignatureMap[]> {
  try {
    const raw = await readFile(join(analysisDir, 'llm-context.json'), 'utf-8');
    const sigs = (JSON.parse(raw) as { signatures?: unknown }).signatures;
    return Array.isArray(sigs) ? sigs as FileSignatureMap[] : [];
  } catch {
    return [];
  }
}

async function readBundledDependencyPaths(analysisDir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(join(analysisDir, 'dependency-graph.json'), 'utf8')) as {
      nodes?: Array<{ file?: { path?: unknown }; path?: unknown }>;
    };
    if (!Array.isArray(raw.nodes)) return [];
    return raw.nodes.flatMap(node => {
      const path = node.file?.path ?? node.path;
      return typeof path === 'string' ? [path] : [];
    });
  } catch {
    return [];
  }
}

async function hasLegacyNativeRepositoryKeys(rootPath: string, analysisDir: string): Promise<boolean> {
  const paths = await readBundledDependencyPaths(analysisDir);
  try {
    const raw = JSON.parse(await readFile(join(analysisDir, 'llm-context.json'), 'utf8')) as {
      signatures?: Array<{ path?: unknown }>;
      callGraph?: {
        nodes?: Array<{ filePath?: unknown }>;
        classes?: Array<{ filePath?: unknown }>;
      };
    };
    for (const signature of raw.signatures ?? []) {
      if (typeof signature.path === 'string') paths.push(signature.path);
    }
    for (const node of raw.callGraph?.nodes ?? []) {
      if (typeof node.filePath === 'string') paths.push(node.filePath);
    }
    for (const cls of raw.callGraph?.classes ?? []) {
      if (typeof cls.filePath === 'string') paths.push(cls.filePath);
    }
  } catch {
    // The validation ladder reports malformed required artifacts separately.
  }
  const store = EdgeStore.open(join(analysisDir, ARTIFACT_CALL_GRAPH_DB));
  try {
    paths.push(...store.getAllInternalNodes().map(node => node.filePath));
    paths.push(...store.getAllClasses().map(cls => cls.filePath));
  } finally {
    store.close();
  }
  return paths.some(path => path.includes('\\') &&
    (sep === '\\' || !existsSync(join(rootPath, path))));
}

/**
 * Rebuild the keyword (BM25) search index from the just-materialized graph so `orient` and
 * `search_code` work immediately on an imported index — and so the imported index is the SAME index a
 * fresh `openlore analyze` would produce, not a subset. Offline and fast (no source re-parse, no API):
 * the corpus is built from the graph already in `call-graph.db`, the per-file `signatures` the bundle
 * carries in `llm-context.json` (so non-call-graph symbols — constants, types, interfaces — are indexed,
 * not just functions), and the checked-out source for body-skeleton text (read, not parsed). Best-effort
 * and additive — a failure (e.g. the optional LanceDB native dep is unavailable) leaves a fully-working
 * graph index and is reported, never fatal. Semantic search remains an opt-in via `openlore embed --local`.
 */
async function buildKeywordSearchIndex(rootPath: string, analysisDir: string): Promise<boolean> {
  const store = EdgeStore.open(join(analysisDir, ARTIFACT_CALL_GRAPH_DB));
  // A not-ready store (schema-mismatched / quarantined) has nothing to index from
  // (change: harden-index-store-lifecycle).
  if (store.notReady) {
    store.close();
    return false;
  }
  let nodes, hubIds, entryIds;
  try {
    nodes = store.getAllInternalNodes();
    hubIds = new Set(store.getHubs(Number.MAX_SAFE_INTEGER).map(n => n.id));
    entryIds = new Set(store.getEntryPoints(Number.MAX_SAFE_INTEGER).map(n => n.id));
  } finally {
    store.close();
  }
  if (nodes.length === 0) return false;

  const signatures = await readBundledSignatures(analysisDir);
  // Body-skeleton text needs the source (read, not parsed). It is present in the checkout we are
  // importing into; a missing file is skipped (that symbol is still indexed by name/signature/docstring).
  const paths = [...new Set(nodes.map(n => n.filePath))];
  const contents = await mapFilesBounded(paths, async fp => {
    try {
      return await readFile(join(rootPath, fp), 'utf-8');
    } catch {
      return null;
    }
  });
  const fileContents = new Map<string, string>();
  for (const [i, content] of contents.entries()) {
    if (content !== null) fileContents.set(paths[i], content);
  }

  await VectorIndex.build(analysisDir, nodes, signatures, hubIds, entryIds, null, fileContents);
  return true;
}

/**
 * Rebuild the keyword (BM25) SPEC search index so `search_specs` works after import — the spec index
 * (`specs` table) shares the `vector-index/` directory that the function-index rebuild recreates, and a
 * fresh analyze builds it too. Best-effort and gated on an `openspec/specs/` directory in the checkout;
 * a missing specs dir (or any failure) simply means no spec index, exactly as on a repo without specs.
 */
async function buildSpecSearchIndex(rootPath: string, analysisDir: string): Promise<boolean> {
  const specsDir = join(rootPath, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR);
  if (!existsSync(specsDir)) return false;
  const mappingJsonPath = join(analysisDir, 'mapping.json');
  const decisionsDir = join(rootPath, OPENSPEC_DIR, OPENSPEC_DECISIONS_SUBDIR);
  const { recordCount } = await SpecVectorIndex.build(analysisDir, specsDir, null, mappingJsonPath, decisionsDir);
  return recordCount > 0;
}

async function fullRebuild(rootPath: string, analysisDir: string, detail: string): Promise<number> {
  logger.warning(`Falling back to a local rebuild — ${detail}`);
  await runAnalysis(rootPath, analysisDir, { maxFiles: DEFAULT_MAX_FILES, include: [], exclude: [] });
  logger.success('Local index rebuilt.');
  return 0;
}

/** Read at most the size verified on one open descriptor; later appends are ignored. */
async function readBundleFileBounded(artifactPath: string): Promise<Buffer> {
  const handle = await open(artifactPath, 'r');
  try {
    const artifactStat = await handle.stat();
    if (!artifactStat.isFile()) {
      throw new BundleError('unreadable', `Artifact is not a regular file: ${artifactPath}`);
    }
    if (artifactStat.size > BUNDLE_MAX_COMPRESSED_BYTES) {
      throw new BundleError(
        'unreadable',
        `Artifact exceeds the ${BUNDLE_MAX_COMPRESSED_BYTES}-byte compressed bundle size cap: ${artifactPath}`,
      );
    }

    const raw = Buffer.allocUnsafe(artifactStat.size);
    let offset = 0;
    while (offset < raw.length) {
      const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return raw.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function runImportWithEffectiveConfig(artifact: string, opts: ImportOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const analysisDir = join(projectRoot, OPENLORE_ANALYSIS_REL_PATH);
  const artifactPath = resolve(artifact);

  if (!existsSync(artifactPath)) {
    logger.error(`Artifact not found: ${artifactPath}`);
    return 2;
  }

  // Parse: a file that is not an OpenLore bundle at all is a user error (wrong file), not a
  // trust failure — we do not silently full-analyze something the user did not intend.
  let bundle: Bundle;
  try {
    // Size-check and read through one descriptor so path replacement cannot swap in an
    // oversized file between metadata validation and allocation. A concurrent append is
    // ignored because the read is capped to the descriptor size observed above.
    bundle = parseBundle(await readBundleFileBounded(artifactPath));
  } catch (err) {
    if (err instanceof BundleError) {
      logger.error(err.message);
      return 2;
    }
    logger.error(`Could not read artifact: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // Signature failures are artifact rejections, not rebuild triggers. A hostile signed bundle
  // must not silently fall through to unsigned handling or make the importer perform expensive
  // source analysis on its behalf.
  const integrityOk = verifyPayloadIntegrity(bundle);
  const sourceIdentityOk = verifyBundledSourceIdentity(bundle);
  let signatureVerdict: BundleSignatureVerdict = { status: 'unsigned' };
  if (bundle.manifest.signature) {
    if (!integrityOk || !sourceIdentityOk) {
      logger.error('Signed bundle integrity or source-identity mismatch; signature cannot be trusted.');
      return 2;
    }
    try {
      const config = await readOpenLoreConfig(projectRoot);
      signatureVerdict = verifyBundleSignature(bundle, config?.bundle?.trustedSigners ?? []);
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
  }

  // (1)(3) cheap pre-materialize gates — version + schema.
  const pre = preMaterializeRebuildReason(bundle);
  if (pre) return fullRebuild(projectRoot, analysisDir, pre.detail);

  // (2) payload byte-integrity (tamper / corruption / hand-merge).
  if (!integrityOk) {
    return fullRebuild(projectRoot, analysisDir, 'artifact payload digest mismatch (corrupt or hand-edited).');
  }
  if (!sourceIdentityOk) {
    return fullRebuild(projectRoot, analysisDir, 'bundle manifest source identity does not match fingerprint.json.');
  }

  // Materialize to a staging dir so the live index is never half-clobbered by a bundle that
  // fails the deeper graph-content checks below. Any unexpected failure in this region degrades
  // to a rebuild (spec: "any validation failure degrades to a local rebuild") — never a crash.
  // The rebuild runs AFTER staging cleanup (outside this try) so it is never nested/double-run.
  const sourceCommit = bundle.manifest.sourceCommit;
  const staging = await mkdtemp(join(tmpdir(), 'openlore-import-'));
  let rebuildReason: string | null = null;
  let deltaReport: Awaited<ReturnType<McpWatcher['applyRepositoryDelta']>> | null = null;
  try {
    await materializeBundle(bundle, staging);

    // (4) graph-content digest == bundled attestation, and the store reconciles healthy.
    const store = EdgeStore.open(join(staging, ARTIFACT_CALL_GRAPH_DB));
    let digestOk = false;
    let reconcileHealthy = false;
    // A bundle whose graph store won't open at this OpenLore's schema — or is corrupt —
    // is not importable as-is; fall through to a source rebuild rather than promoting a
    // not-ready index (change: harden-index-store-lifecycle).
    const storeFault = store.notReady;
    try {
      if (!storeFault) {
        digestOk = recomputeProductionDigest(store) === bundle.manifest.attestation.digest;
        reconcileHealthy = reconcile(bundle.manifest.attestation, {
          schemaVersion: store.getSchemaVersion(),
          files: store.countFiles(),
          functions: store.countNodes(),
          edges: store.countEdges(),
          classes: store.countClasses(),
        }).verdict === 'healthy';
      }
    } finally {
      store.close();
    }

    if (storeFault) {
      rebuildReason = `bundled graph index is not usable (${storeFault.reason}); rebuilding from source.`;
    } else if (!digestOk) {
      rebuildReason = 'materialized graph digest does not match the bundled attestation (tampered).';
    } else if (!reconcileHealthy) {
      rebuildReason = 'materialized index does not reconcile against its attestation.';
    } else if (await hasLegacyNativeRepositoryKeys(projectRoot, staging)) {
      rebuildReason =
        'The bundle contains legacy native-separator repository keys; rebuilding is required to canonicalize Windows paths.';
    } else {
      // (5) currency vs the working tree.
      const isGitRepo = await isGitRepository(projectRoot);
      const consumerSourceState = await captureSourceState(projectRoot);
      let commitMatchesHead = false;
      let commitIsAncestor = false;
      let resolvedSourceCommit: string | null = null;
      if (isGitRepo && sourceCommit) {
        const head = consumerSourceState.commit;
        const source = await gitResolveCommit(projectRoot, sourceCommit);
        resolvedSourceCommit = source;
        commitMatchesHead = !!head && !!source && head === source;
        if (!commitMatchesHead && source && head) {
          commitIsAncestor = await gitIsAncestor(projectRoot, source, head);
        }
      }
      const decision = currencyDecision({
        isGitRepo,
        sourceCommit,
        sourceTreeState: bundle.manifest.sourceTreeState ?? 'unknown',
        consumerTreeState: consumerSourceState.treeState,
        commitMatchesHead,
        commitIsAncestor,
      });
      if (decision.action === 'rebuild') {
        rebuildReason = decision.detail;
      } else {
        if (decision.action === 'import-delta') {
          const delta = await intersectDeltaWithAnalysisCorpus(
            projectRoot,
            staging,
            await collectGitDelta(projectRoot, resolvedSourceCommit!),
          );
          if (delta.changed.length + delta.deleted.length > WATCH_BULK_THRESHOLD) {
            rebuildReason =
              `Artifact delta contains ${delta.changed.length + delta.deleted.length} indexed files, ` +
              `above the bounded catch-up threshold of ${WATCH_BULK_THRESHOLD}; rebuilding locally.`;
          } else {
            const watcher = new McpWatcher({
              rootPath: projectRoot,
              outputPath: staging,
              embed: false,
              selfRebuild: false,
            });
            deltaReport = await watcher.applyRepositoryDelta(delta.changed, delta.deleted);
            await refreshCaughtUpIdentity(projectRoot, staging);
          }
        }
        if (!rebuildReason) {
          let searchBuilt = false;
          const localFiles = deltaReport
            ? (await readdir(staging, { withFileTypes: true }))
                .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
                .map(entry => entry.name)
            : undefined;
          await promoteStagedIndex(bundle, staging, analysisDir, {
            localFiles,
            beforePublish: async () => {
              // Rebuild derived indexes inside the same writer transaction so another analyze
              // cannot publish a different graph between graph promotion and search construction.
              try {
                searchBuilt = await buildKeywordSearchIndex(projectRoot, analysisDir);
              } catch (err) {
                searchBuilt = false;
                await rm(join(analysisDir, 'vector-index'), { recursive: true, force: true });
                await rm(join(analysisDir, 'vector-index-meta.json'), { force: true });
                logger.debug(`import: keyword search index not built (${err instanceof Error ? err.message : String(err)})`);
              }
              try {
                await buildSpecSearchIndex(projectRoot, analysisDir);
              } catch (err) {
                logger.debug(`import: spec search index not built (${err instanceof Error ? err.message : String(err)})`);
              }
              if (deltaReport) await assertCaughtUpIdentityCurrent(projectRoot, analysisDir);
            },
            afterPublish: async () => {
              if (deltaReport) await assertCaughtUpIdentityCurrent(projectRoot, analysisDir);
            },
          });
          const finalConsumerState = await captureSourceState(projectRoot);
          const reportedDecision = finalConsumerState.commit === consumerSourceState.commit
            && finalConsumerState.treeState === consumerSourceState.treeState
            ? decision
            : {
                action: 'import-currency-unknown' as const,
                reason: 'consumer-changed-during-import',
                detail: 'Currency is unknown because the checkout changed while the bundle was being imported.',
              };
          logger.success(
            `Imported graph bundle (${bundle.manifest.files.length} files, schema v${bundle.manifest.schemaVersion}). ` +
            provenanceDetail(signatureVerdict),
          );
          if (reportedDecision.action === 'import-current') logger.info('Currency', reportedDecision.detail);
          else if (reportedDecision.action === 'import-delta' && deltaReport) {
            const deltaSize = deltaReport.changedFiles.length + deltaReport.deletedFiles.length;
            logger.info(
              'Currency',
              `Caught up from ancestor bundle: delta ${deltaSize} file(s), closure ${deltaReport.closureFiles.length} file(s), ` +
              `explicitly stale ${deltaReport.staleFiles.length}.`,
            );
            if (deltaReport.staleFiles.length > 0) {
              logger.warning(
                `${deltaReport.staleFiles.length} file(s) remain explicitly stale after bounded catch-up; run "openlore analyze --force" to converge them.`,
              );
            }
          } else logger.warning(reportedDecision.detail);
          logger.info(
            'Search',
            searchBuilt
              ? 'keyword (BM25) index rebuilt — orient/search_code ready. For semantic search: openlore embed --local'
              : 'keyword index not built — run "openlore embed" (BM25) or "openlore embed --local" (semantic) to enable orient/search_code',
          );
        }
      }
    }
  } catch (err) {
    rebuildReason = `import failed during materialization/validation (${err instanceof Error ? err.message : String(err)}).`;
  } finally {
    await removeDir(staging);
  }

  if (rebuildReason) return fullRebuild(projectRoot, analysisDir, rebuildReason);
  return 0;
}

export async function runImport(artifact: string, opts: ImportOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  // Global --config is registered before subcommand options are parsed. Scope its trust policy
  // to the effective import root, then restore process-global routing for embedders/tests.
  const restoreConfigRoot = retargetPrimaryConfigRoot(projectRoot);
  try {
    return await runImportWithEffectiveConfig(artifact, opts);
  } finally {
    restoreConfigRoot();
  }
}

export const importCommand = new Command('import')
  .description('Import a portable graph artifact; validates it, catches up bounded clean-ancestor deltas, and rebuilds when safety cannot be proven.')
  .argument('<artifact>', 'Path to the .olbundle artifact to import')
  .option('--project-root <path>', 'Project root to import into (default: current directory)')
  .action(async (artifact: string, opts: ImportOptions) => {
    const code = await runImport(artifact, opts);
    process.exit(code);
  });
