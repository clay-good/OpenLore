/**
 * `openlore manifest <emit|validate>` — federation manifest emitter.
 *
 * Each OpenLore-instrumented repo can publish a small, public, deterministic
 * `.well-known/openlore.json` describing what it exposes. A future federation
 * index (separate spec) reads these manifests to answer cross-repo questions.
 * This command only emits and validates; it never makes network calls.
 */

import { Command } from 'commander';
import { runManifestEmit, type ManifestEmitOptions } from './emit.js';
import { runManifestValidate } from './validate.js';

const emitSubcommand = new Command('emit')
  .description('Write .well-known/openlore.json describing this repo (public symbols, routes, stats, …).')
  .option('--out <path>', 'Output path (default: <project-root>/.well-known/openlore.json)')
  .option('--project-root <path>', 'Project root to describe (default: current directory)')
  .option('--include-private', 'Include non-public symbols (produces a larger manifest)', false)
  .option('--max-symbols <int>', 'Truncate public_symbols to this many (sets "truncated": true)', (v) => parseInt(v, 10))
  .option('--dry-run', 'Show the destination and manifest size without writing the file', false)
  .action(async (opts: ManifestEmitOptions) => {
    process.exit(await runManifestEmit(opts));
  });

const validateSubcommand = new Command('validate')
  .description('Schema-check an existing manifest against openlore-manifest-v1.json.')
  .argument('<path>', 'Path to the manifest JSON to validate')
  .action((path: string) => {
    process.exit(runManifestValidate(path));
  });

export const manifestCommand = new Command('manifest')
  .description('Emit or validate a federation manifest (.well-known/openlore.json).')
  .addCommand(emitSubcommand)
  .addCommand(validateSubcommand);
