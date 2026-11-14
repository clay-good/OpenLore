import { jsonOutput, writeStdout } from '../output.js';
import { readFileConfined } from '../../utils/path-confinement.js';
import { dirname, basename } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Command } from 'commander';
import { configureOpenLore, configurationRoot } from '../../api/configuration.js';
import type {
  ConfigurationRequest,
  ConfigurationPlan,
  ConfigurationCandidate,
} from '../../api/configuration.js';

export const configureCommand = new Command('configure')
  .description('Inspect, preview, apply, verify or revert a reviewed local configuration plan')
  .argument('<action>', 'inspect | preview | apply | verify | revert')
  .option('--directory <path>', 'Repository root', process.cwd())
  .option('--candidate-file <path>', 'Bounded JSON candidate for preview')
  .option('--plan-file <path>', 'Exact JSON preview plan')
  .option('--apply', 'Authorize the exact plan to change local configuration')
  .option('--replace-choices', 'Authorize replacing the existing choices shown by the plan')
  .option('--json', 'Print a structured result')
  .action(async (action: ConfigurationRequest['action'], opts, command) => {
    const root = await configurationRoot(opts.directory as string);
    async function jsonFile<T>(path: string | undefined): Promise<T | undefined> {
      if (!path) return undefined;
      const canonical = await realpath(path);
      return JSON.parse(
        await readFileConfined(dirname(canonical), basename(canonical), 1024 * 1024, true)
      ) as T;
    }
    const plan = await jsonFile<ConfigurationPlan>(opts.planFile as string | undefined);
    const candidate = await jsonFile<ConfigurationCandidate>(
      opts.candidateFile as string | undefined
    );
    const explicitConfig = command.optsWithGlobals().config as string | undefined;
    const result = await configureOpenLore(
      { action, plan, candidate },
      {
        rootPath: root,
        configPath: explicitConfig,
        ...(opts.apply && plan
          ? {
              authority: {
                root,
                planId: plan.id,
                permissions: [
                  'write-config',
                  ...(opts.replaceChoices ? ['replace-choices' as const] : []),
                ] as Array<'write-config' | 'replace-choices'>,
              },
            }
          : {}),
      }
    );
    await writeStdout(jsonOutput(result) + '\n');
  });
