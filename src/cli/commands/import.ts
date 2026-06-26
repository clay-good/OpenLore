/**
 * `openlore import <artifact>` — bootstrap the local graph index from a portable artifact,
 * validate-or-rebuild (change: add-shareable-graph-artifact).
 *
 * Safe by construction: the consumer validates the artifact before trusting it and NEVER
 * serves a stale, schema-mismatched, or tampered bundle as current. The validation ladder:
 *   1. bundle format version compatible       (else rebuild)
 *   2. payload byte-integrity (tamper/corrupt) (else rebuild)
 *   3. index schema version matches            (else rebuild)
 *   4. graph-content digest == bundled attestation, and the store reconciles healthy (else rebuild)
 *   5. currency vs the working tree:
 *        commit == HEAD            → import as-is (verified current)
 *        no git / commit unknown   → import as-is, currency disclosed as UNVERIFIED
 *        stale (ancestor) / diverged → full local rebuild (incremental-delta is a deferred optimization)
 * Any validation failure degrades transparently to a local rebuild — import never leaves the
 * consumer worse off than having no artifact. The mechanism is offline and deterministic.
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';
import { OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_CALL_GRAPH_DB, DEFAULT_MAX_FILES } from '../../constants.js';
import { EdgeStore, SCHEMA_VERSION } from '../../core/services/edge-store.js';
import { reconcile } from '../../core/analyzer/index-attestation.js';
import { isGitRepository, validateGitRef } from '../../core/drift/git-diff.js';
import {
  parseBundle,
  verifyPayloadIntegrity,
  recomputeProductionDigest,
  materializeBundle,
  promoteStagedIndex,
  removeDir,
  BundleError,
  BUNDLE_VERSION,
  type Bundle,
} from '../../core/analyzer/index-bundle.js';
import { runAnalysis } from './analyze.js';

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
  if (bundle.manifest.bundleVersion !== currentBundleVersion) {
    return {
      reason: 'bundle-version',
      detail:
        `Artifact bundle format v${bundle.manifest.bundleVersion} is not compatible with this OpenLore ` +
        `(expects v${currentBundleVersion}).`,
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

export type ImportAction = 'import-fresh' | 'import-unverified' | 'rebuild';

/** Decide currency once the artifact has materialized and validated. Pure — unit-tested. */
export function currencyDecision(facts: {
  isGitRepo: boolean;
  sourceCommit: string | null;
  commitMatchesHead: boolean;
  commitIsAncestor: boolean;
}): { action: ImportAction; reason: string; detail: string } {
  if (!facts.isGitRepo || !facts.sourceCommit) {
    return {
      action: 'import-unverified',
      reason: 'currency-unverified',
      detail:
        'Imported as-is, but currency could NOT be verified (no git repository or no recorded build ' +
        'commit). If the source has changed since the artifact was built, run "openlore analyze".',
    };
  }
  if (facts.commitMatchesHead) {
    return { action: 'import-fresh', reason: 'commit-matches-head', detail: 'Artifact commit matches the working tree — imported as-is, verified current.' };
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

async function fullRebuild(rootPath: string, analysisDir: string, detail: string): Promise<number> {
  logger.warning(`Falling back to a local rebuild — ${detail}`);
  await runAnalysis(rootPath, analysisDir, { maxFiles: DEFAULT_MAX_FILES, include: [], exclude: [] });
  logger.success('Local index rebuilt.');
  return 0;
}

export async function runImport(artifact: string, opts: ImportOptions): Promise<number> {
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

  // (1)(3) cheap pre-materialize gates — version + schema.
  const pre = preMaterializeRebuildReason(bundle);
  if (pre) return fullRebuild(projectRoot, analysisDir, pre.detail);

  // (2) payload byte-integrity (tamper / corruption / hand-merge).
  if (!verifyPayloadIntegrity(bundle)) {
    return fullRebuild(projectRoot, analysisDir, 'artifact payload digest mismatch (corrupt or hand-edited).');
  }

  // Materialize to a staging dir so the live index is never half-clobbered by a bundle that
  // fails the deeper graph-content checks below.
  const staging = await mkdtemp(join(tmpdir(), 'openlore-import-'));
  try {
    await materializeBundle(bundle, staging);

    // (4) graph-content digest == bundled attestation, and the store reconciles healthy.
    const store = EdgeStore.open(join(staging, ARTIFACT_CALL_GRAPH_DB));
    let digestOk: boolean;
    let reconcileHealthy: boolean;
    try {
      digestOk = recomputeProductionDigest(store) === bundle.manifest.attestation.digest;
      reconcileHealthy = reconcile(bundle.manifest.attestation, {
        schemaVersion: store.getSchemaVersion(),
        files: store.countFiles(),
        functions: store.countNodes(),
        edges: store.countEdges(),
        classes: store.countClasses(),
      }).verdict === 'healthy';
    } finally {
      store.close();
    }
    if (!digestOk) {
      return fullRebuild(projectRoot, analysisDir, 'materialized graph digest does not match the bundled attestation (tampered).');
    }
    if (!reconcileHealthy) {
      return fullRebuild(projectRoot, analysisDir, 'materialized index does not reconcile against its attestation.');
    }

    // (5) currency vs the working tree.
    const isGitRepo = await isGitRepository(projectRoot);
    const sourceCommit = bundle.manifest.sourceCommit;
    let commitMatchesHead = false;
    let commitIsAncestor = false;
    if (isGitRepo && sourceCommit) {
      const head = await gitResolveCommit(projectRoot, 'HEAD');
      const source = await gitResolveCommit(projectRoot, sourceCommit);
      commitMatchesHead = !!head && !!source && head === source;
      if (!commitMatchesHead && source && head) {
        commitIsAncestor = await gitIsAncestor(projectRoot, source, head);
      }
    }

    const decision = currencyDecision({ isGitRepo, sourceCommit, commitMatchesHead, commitIsAncestor });
    if (decision.action === 'rebuild') {
      return fullRebuild(projectRoot, analysisDir, decision.detail);
    }

    await promoteStagedIndex(bundle, staging, analysisDir);
    if (decision.action === 'import-unverified') {
      logger.success(`Imported graph bundle (${bundle.manifest.files.length} files, schema v${bundle.manifest.schemaVersion}).`);
      logger.warning(decision.detail);
    } else {
      logger.success(`Imported graph bundle — verified current at commit ${sourceCommit}.`);
    }
    return 0;
  } finally {
    await removeDir(staging);
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
