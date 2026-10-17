/**
 * `openlore embed` — switch the semantic embedding provider in one command.
 *
 * The headline use is `openlore embed --local`: it turns on a zero-config,
 * on-device embedder (no endpoint, no API key) and rebuilds the semantic index.
 * The model is lazily downloaded and cached on first use. `openlore embed --off`
 * reverts to the first-class keyword (BM25) default. Either way the index is
 * rebuilt with `--force` so vectors from a different model are never reused
 * (which would mix dimensions).
 */

import { Command } from 'commander';
import { logger } from '../../utils/logger.js';
import { readProjectOpenLoreConfig, writeOpenLoreConfig } from '../../core/services/config-manager.js';
import { DEFAULT_LOCAL_MODEL } from '../../core/analyzer/local-embedding-service.js';

interface EmbedOptions {
  local?: boolean;
  off?: boolean;
  model?: string;
}

export const embedCommand = new Command('embed')
  .description('Switch the semantic embedding provider and rebuild the index')
  .option('--local', 'Use the on-device local embedder — no endpoint, no API key', false)
  .option('--off', 'Revert to the first-class keyword (BM25) default (no embeddings)', false)
  .option('--model <id>', 'Override the local embedding model (advanced; default is a pinned small model)')
  .addHelpText(
    'after',
    `
Examples:
  $ openlore embed --local           Turn on on-device semantic search and rebuild the index
  $ openlore embed --off             Revert to the keyword (BM25) default and rebuild

Notes:
  • The local model is downloaded and cached under ~/.openlore/models on first use
    (one-time, ~23 MB) — no API key, no endpoint, CPU only.
  • Keyword (BM25) search is the first-class default and keeps working without this.
  • For a remote OpenAI-compatible endpoint instead, set EMBED_BASE_URL/EMBED_MODEL
    or an "embedding" block in .openlore/config.json, then run "openlore analyze".
`
  )
  .action(async (options: EmbedOptions) => {
    const rootPath = process.cwd();

    if (options.local && options.off) {
      logger.error('Pass only one of --local or --off.');
      process.exitCode = 1;
      return;
    }
    if (!options.local && !options.off) {
      logger.error('Specify what to do: "openlore embed --local" (on-device semantic) or "openlore embed --off" (keyword default).');
      process.exitCode = 1;
      return;
    }

    const cfg = await readProjectOpenLoreConfig(rootPath);
    if (!cfg) {
      logger.error('No openlore configuration found. Run "openlore init" first.');
      process.exitCode = 1;
      return;
    }

    if (options.off) {
      // null (not delete) so an inherited user-wide embedding stays off for this project.
      cfg.embedding = null;
      await writeOpenLoreConfig(rootPath, cfg);
      logger.success('Embeddings disabled — reverted to the keyword (BM25) default.');
      logger.discovery('Rebuilding the keyword index…');
      const { analyzeCommand } = await import('./analyze.js');
      // --no-embed forces a clean keyword-only rebuild regardless of EMBED_* env.
      await analyzeCommand.parseAsync(['--force', '--no-embed'], { from: 'user' });
      return;
    }

    const model = options.model || DEFAULT_LOCAL_MODEL;
    // Switch the provider to local. Replacing the block (rather than merging the
    // remote endpoint) is intentional: --local picks the on-device provider.
    cfg.embedding = { provider: 'local', model };
    await writeOpenLoreConfig(rootPath, cfg);
    logger.success(`Embedding provider set to local (${model}).`);
    logger.info('Model', `Cached under ~/.openlore/models on first use — no API key, no endpoint, CPU only.`);
    // An explicit local provider wins over EMBED_* env in resolveEmbedder, but warn
    // anyway so the user isn't surprised that their endpoint env is being ignored.
    if (process.env.EMBED_BASE_URL || process.env.EMBED_MODEL) {
      logger.warning('EMBED_* environment variables are set but ignored — "embed --local" uses the on-device provider. Run "openlore embed --off" then unset EMBED_* to use the remote endpoint.');
    }

    // Rebuild the index with the local embedder. --force guarantees a clean full
    // re-embed when switching from a keyword or remote index (vectors from a
    // different model must not be reused).
    logger.discovery('Building the local-semantic index (downloads the model on first run)…');
    const { analyzeCommand } = await import('./analyze.js');
    await analyzeCommand.parseAsync(['--force'], { from: 'user' });
  });
