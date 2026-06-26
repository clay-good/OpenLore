/**
 * `openlore export <format>` — export the analysis graph to interop formats.
 *
 * Currently the only format is `scip` (Source Code Intelligence Protocol).
 * The subcommand dispatch is kept thin so additional formats can be added as
 * sibling subcommands without touching the SCIP logic.
 */

import { Command } from 'commander';
import { runScipExport, type ScipExportOptions } from './scip.js';
import { runBundleExport, type BundleExportOptions } from './bundle.js';

/** Commander collector for repeatable options (`--include a --include b`). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const scipSubcommand = new Command('scip')
  .description('Export the analysis graph as an SCIP index (index.scip) for the Sourcegraph/Glean ecosystem.')
  .option('--out <path>', 'Output path for the SCIP index (default: <project-root>/index.scip)')
  .option('--project-root <path>', 'Project root to export (default: current directory)')
  .option('--include <glob>', 'Only include files matching this glob (repeatable)', collect, [])
  .option('--exclude <glob>', 'Exclude files matching this glob (repeatable)', collect, [])
  .action(async (opts: ScipExportOptions) => {
    const code = await runScipExport(opts);
    process.exit(code);
  });

const bundleSubcommand = new Command('bundle')
  .description('Export the persisted graph index as a single portable, integrity-stamped artifact a teammate or CI can import without re-analyzing.')
  .option('--out <path>', `Output path for the artifact (default: <project-root>/.openlore/index-bundle.olbundle)`)
  .option('--project-root <path>', 'Project root to export (default: current directory)')
  .action(async (opts: BundleExportOptions) => {
    const code = await runBundleExport(opts);
    process.exit(code);
  });

export const exportCommand = new Command('export')
  .description('Export the analysis graph to an interop format (scip) or a portable shareable bundle.')
  .addCommand(scipSubcommand)
  .addCommand(bundleSubcommand);
