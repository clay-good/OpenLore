/**
 * `openlore features` — the single answer to "what's on, and how do I turn on
 * the rest?" (change: refine-happy-path-and-defaults / ZeroConfigWithGuidedActivation).
 *
 * OpenLore needs ZERO config keys for core value. Everything beyond the core is an
 * independent opt-in feature, each gated by a config block or an on-disk marker.
 * This command reports every opt-in feature's current state and the ONE command or
 * config snippet that activates it — so a user never has to grep 44 docs to find
 * where to turn something on. Deterministic, local, no LLM, no network.
 *
 * Detection lives in the shared `collectFeatureInventory()` so the CLI, `doctor`,
 * and a future MCP tool stay in parity over one source of truth.
 */

import { Command } from 'commander';
import type { ChalkInstance } from 'chalk';
import { logger } from '../../utils/logger.js';
import { palette } from '../../utils/colors.js';
import {
  collectFeatureInventory,
  type FeatureStatus,
  type FeatureGroup,
} from '../../core/services/feature-inventory.js';

const GROUP_ORDER: FeatureGroup[] = [
  'Search & navigation',
  'Governance & guardrails',
  'Multi-repo',
];

function printFeature(f: FeatureStatus, c: ChalkInstance): void {
  const icon =
    f.state === 'active'
      ? c.green('✓')
      : f.state === 'default-on'
        ? c.cyan('•')
        : c.dim('○');
  console.log(`  ${icon}  ${f.title.padEnd(38)} ${c.dim(f.detail)}`);
  // Show the activation hint only when there is an action to take.
  if (f.state === 'inactive' && f.activate) {
    console.log(`         ${' '.repeat(38)} ${c.yellow(`→ ${f.activate}`)}`);
  }
}

export const featuresCommand = new Command('features')
  .description("List OpenLore's opt-in features, what's active, and how to turn on the rest")
  .option('--json', 'Output the feature inventory as JSON', false)
  .option('--inactive', 'Show only features that are not yet active', false)
  .addHelpText(
    'after',
    `
Examples:
  $ openlore features            Show every feature, its state, and how to enable it
  $ openlore features --inactive Show only what is not yet turned on
  $ openlore features --json     Machine-readable inventory (for scripts / agents)

OpenLore needs zero config for its core value — orient, search, blast-radius, and
the whole structural graph work with no keys set. The features below are all opt-in.
`
  )
  .action(async (options: { json?: boolean; inactive?: boolean }) => {
    const rootPath = process.cwd();
    const inventory = await collectFeatureInventory(rootPath);

    if (options.json) {
      console.log(JSON.stringify(inventory, null, 2));
      return;
    }

    const useColor = Boolean(process.stdout.isTTY);
    const c = palette(useColor);

    logger.section('openlore features');
    console.log('');

    if (!inventory.configFound) {
      logger.warning('No .openlore/config.json found — run "openlore init" first (or "openlore install").');
      console.log('');
    }

    console.log(
      `  ${c.dim('Core value needs zero config: orient, search, blast-radius, and the full graph work with no keys set.')}`
    );
    console.log('');

    const shown = options.inactive
      ? inventory.features.filter((f) => f.state === 'inactive')
      : inventory.features;

    for (const group of GROUP_ORDER) {
      const inGroup = shown.filter((f) => f.group === group);
      if (inGroup.length === 0) continue;
      console.log(`  ${c.bold(group)}`);
      for (const f of inGroup) printFeature(f, c);
      console.log('');
    }

    if (options.inactive && shown.length === 0) {
      logger.success('Every opt-in feature is already active.');
      console.log('');
    }

    console.log(
      `  ${c.dim(`${inventory.activeCount} of ${inventory.optInCount} opt-in features active · legend:`)} ` +
        `${c.green('✓ on')} ${c.cyan('• default-on')} ${c.dim('○ off')}`
    );
    console.log('');
  });
