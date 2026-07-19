/**
 * `openlore export bundle` — serialize the persisted graph index into a single portable,
 * integrity-stamped artifact (change: add-shareable-graph-artifact).
 *
 * A team analyzes once and commits the artifact; a teammate or a CI job imports it
 * (`openlore import`) and bootstraps a verified index in seconds instead of cold-indexing.
 * The artifact is a deterministic function of the index — exporting the same index twice is
 * byte-identical — so it is a generated, regenerate-don't-merge file (see docs).
 */

import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { logger } from '../../utils/logger.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_CALL_GRAPH_DB } from '../../constants.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { buildBundle, BundleError, BUNDLE_DEFAULT_FILENAME } from '../../core/analyzer/index-bundle.js';

const require = createRequire(import.meta.url);

export interface BundleExportOptions {
  out?: string;
  projectRoot?: string;
}

function toolVersion(): string {
  const pkg = require('../../../package.json') as { version: string };
  return pkg.version;
}

/** Fold any lagging write-ahead log into the main db so the bundled call-graph.db is self-contained. */
function checkpointStore(dbPath: string): void {
  try {
    const store = EdgeStore.open(dbPath);
    try {
      // A schema-mismatched / quarantined store has no WAL of its own to fold — and
      // must not be mutated on this read path (change: harden-index-store-lifecycle).
      if (!store.notReady) store.checkpoint();
    } finally {
      store.close();
    }
  } catch (err) {
    // Best-effort: a fresh analyze leaves the WAL already folded. If a checkpoint is blocked
    // (e.g. the watcher daemon holds the WAL), the bundled db could miss unflushed rows — but
    // the attestation is re-computed from the same db, so the bundle stays self-consistent.
    logger.debug(`export bundle: WAL checkpoint skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}

export async function runBundleExport(opts: BundleExportOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const analysisDir = join(projectRoot, OPENLORE_ANALYSIS_REL_PATH);
  const outPath = resolve(opts.out ?? join(projectRoot, OPENLORE_DIR, BUNDLE_DEFAULT_FILENAME));

  const dbPath = join(analysisDir, ARTIFACT_CALL_GRAPH_DB);
  if (existsSync(dbPath)) checkpointStore(dbPath);

  let result;
  try {
    result = await buildBundle(analysisDir, toolVersion());
  } catch (err) {
    if (err instanceof BundleError) {
      logger.error(err.message);
      return 2;
    }
    throw err;
  }

  // Create the output's parent dir so `--out dist/x.olbundle` into a not-yet-existing folder
  // writes cleanly instead of throwing an uncaught ENOENT (the default path always exists).
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, result.buffer);

  const { manifest, buffer } = result;
  const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
  // Show a repo-relative path when the artifact lands inside the repo; otherwise
  // show the absolute path, never a meaningless `../../../..` chain.
  const rel = relative(projectRoot, outPath);
  const insideRepo = rel !== '' && !rel.startsWith('..');
  const relOut = insideRepo ? rel : outPath;
  // The .gitattributes hint only makes sense for an in-repo path; if the artifact was written
  // outside the repo, recommend the default glob instead of a pattern git can't apply.
  const gitattrPath = insideRepo ? (rel || BUNDLE_DEFAULT_FILENAME) : `*.olbundle`;
  logger.success(
    `Exported graph bundle → ${relOut}\n` +
    `  ${manifest.files.length} files, ${sizeMb} MB, schema v${manifest.schemaVersion}, ` +
    `commit ${manifest.sourceCommit ?? 'unknown'}\n` +
    '  Tip: this is a generated, regenerate-don\'t-merge artifact. Add to .gitattributes:\n' +
    `    ${gitattrPath} -diff -merge`,
  );
  return 0;
}
