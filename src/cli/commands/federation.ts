/**
 * `openlore federation` — manage the multi-repo federation registry.
 *
 * Federation is an index-of-indexes: each repo keeps its own independently-built
 * `.openlore/` index, and this registry (`.openlore/federation.json`) references
 * them. Adding/removing a repo edits only the registry plus that repo's own build
 * — never a global rebuild (change: add-multi-repo-federation).
 */

import { Command } from 'commander';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { resolve } from 'node:path';
import {
  addRepo,
  removeRepo,
  listRepos,
  evaluateRepoState,
} from '../../core/federation/registry.js';

const STATE_LABEL: Record<string, string> = {
  indexed: '✓ indexed',
  unbaselined: '◐ unbaselined (staleness not yet assessable — run status/analyze to baseline)',
  stale: '⚠ stale (re-run analyze)',
  unindexed: '∅ unindexed (run analyze)',
  missing: '✗ missing path',
};

export const federationCommand = new Command('federation')
  .description('Manage the multi-repo federation registry (index-of-indexes)')
  .addCommand(
    new Command('add')
      .description('Register a repository in this project\'s federation')
      .argument('<path>', 'Path to the repository root (its own .openlore index)')
      .option('--name <name>', 'Name for the repo in the federation (default: basename)')
      .action((repoPath: string, options: { name?: string }) => {
        try {
          const { entry } = addRepo(process.cwd(), repoPath, { name: options.name });
          const fp = entry.fingerprint ? entry.fingerprint.slice(0, 12) : '(no index yet — run "openlore analyze" there)';
          console.log(`✓ Registered "${safe(entry.name)}" → ${safe(entry.path)}`);
          console.log(`  fingerprint: ${fp}`);
        } catch (err) {
          console.error(`✗ ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  )
  .addCommand(
    new Command('remove')
      .alias('rm')
      .description('Remove a repository from the federation by name or path')
      .argument('<nameOrPath>', 'Repo name or path to remove')
      .action((nameOrPath: string) => {
        try {
          const removed = removeRepo(process.cwd(), nameOrPath);
          if (removed) console.log(`✓ Removed "${nameOrPath}" from the federation.`);
          else {
            console.error(`✗ No registered repo matched "${nameOrPath}".`);
            process.exitCode = 1;
          }
        } catch (err) {
          // A corrupt manifest makes loadRegistry throw; surface it cleanly
          // instead of a raw stack trace (matches `add`'s error handling).
          console.error(`✗ ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  )
  .addCommand(
    new Command('list')
      .alias('ls')
      .description('List federated repositories and their index state')
      .action(() => {
        try {
          const repos = listRepos(process.cwd());
          if (repos.length === 0) {
            console.log('No federated repos. Add one with: openlore federation add <path>');
            return;
          }
          console.log(`Federation registry (${repos.length} repo${repos.length === 1 ? '' : 's'}) — home: ${resolve(process.cwd())}\n`);
          for (const r of repos) {
            const state = evaluateRepoState(r);
            console.log(`  ${safe(r.name).padEnd(20)} ${STATE_LABEL[state] ?? state}`);
            console.log(`  ${''.padEnd(20)} ${safe(r.path)}`);
          }
        } catch (err) {
          // A corrupt manifest makes loadRegistry throw; surface it cleanly
          // instead of a raw stack trace (matches `add`'s error handling).
          console.error(`✗ ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }),
  );
