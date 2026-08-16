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
 *        stale (ancestor) / diverged → full local rebuild (incremental-delta is a deferred optimization)
 * Any validation failure degrades transparently to a local rebuild — import never leaves the
 * consumer worse off than having no artifact. The mechanism is offline and deterministic.
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';
import {
  OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_CALL_GRAPH_DB, DEFAULT_MAX_FILES,
  OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR, OPENSPEC_DECISIONS_SUBDIR,
} from '../../constants.js';
import { EdgeStore, SCHEMA_VERSION } from '../../core/services/edge-store.js';
import { VectorIndex } from '../../core/analyzer/vector-index.js';
import { mapFilesBounded } from '../../core/analyzer/bounded-file-scan.js';
import { SpecVectorIndex } from '../../core/analyzer/spec-vector-index.js';
import type { FileSignatureMap } from '../../core/analyzer/signature-extractor.js';
import { reconcile } from '../../core/analyzer/index-attestation.js';
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
  type Bundle,
  type BundleSignatureVerdict,
} from '../../core/analyzer/index-bundle.js';
import { runAnalysis } from './analyze.js';
import { readOpenLoreConfig, retargetPrimaryConfigRoot } from '../../core/services/config-manager.js';
import { captureSourceState, type SourceTreeState } from '../../core/analyzer/source-state.js';

const execFileAsync = promisify(execFile);

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

export type ImportAction = 'import-current' | 'import-approximate' | 'import-currency-unknown' | 'rebuild';

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
    return {
      action: 'rebuild',
      reason: 'stale',
      detail:
        'Artifact was built at an ancestor commit — rebuilding locally so the index is current ' +
        '(never serving a stale graph as current).',
    };
  }
  return {
    action: 'rebuild',
    reason: 'unrelated-commit',
    detail: 'Artifact build commit is not an ancestor of the working tree (diverged/unknown) — rebuilding locally.',
  };
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
    bundle = parseBundle(await readFile(artifactPath));
  } catch (err) {
    if (err instanceof BundleError) {
      logger.error(err.message);
      return 2;
    }
    throw err;
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
    } else {
      // (5) currency vs the working tree.
      const isGitRepo = await isGitRepository(projectRoot);
      const consumerSourceState = await captureSourceState(projectRoot);
      let commitMatchesHead = false;
      let commitIsAncestor = false;
      if (isGitRepo && sourceCommit) {
        const head = consumerSourceState.commit;
        const source = await gitResolveCommit(projectRoot, sourceCommit);
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
        let searchBuilt = false;
        await promoteStagedIndex(bundle, staging, analysisDir, {
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
              searchBuilt = false;
              await rm(join(analysisDir, 'vector-index'), { recursive: true, force: true });
              await rm(join(analysisDir, 'vector-index-meta.json'), { force: true });
              logger.debug(`import: spec search index not built (${err instanceof Error ? err.message : String(err)})`);
            }
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
        else logger.warning(reportedDecision.detail);
        logger.info(
          'Search',
          searchBuilt
            ? 'keyword (BM25) index rebuilt — orient/search_code ready. For semantic search: openlore embed --local'
            : 'keyword index not built — run "openlore embed" (BM25) or "openlore embed --local" (semantic) to enable orient/search_code',
        );
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
  .description('Import a portable graph artifact (openlore export bundle); validates it and falls back to a local rebuild if stale, schema-skewed, or tampered.')
  .argument('<artifact>', 'Path to the .olbundle artifact to import')
  .option('--project-root <path>', 'Project root to import into (default: current directory)')
  .action(async (artifact: string, opts: ImportOptions) => {
    const code = await runImport(artifact, opts);
    process.exit(code);
  });
