/**
 * `openlore connect` — a friendly front-end over the install engine.
 * (change: add-agent-onboarding-connect)
 *
 *   openlore connect [agent]      connect one agent, or pick interactively
 *   openlore connect list         show every supported agent + connection status
 *   openlore connect remove [agent]   disconnect an agent (or all detected)
 *
 * This adds the onboarding ergonomics (a discoverable verb, a status view, an
 * interactive multi-select, and `--preset` awareness) WITHOUT duplicating any
 * wiring logic: every action delegates to `runInstall` / `surfaceStatus`, which
 * drive the same idempotent, sentinel-based adapters as `openlore install`.
 */

import { Command } from 'commander';
import { checkbox } from '@inquirer/prompts';
import { logger } from '../../utils/logger.js';
import { runInstall, surfaceStatus } from '../install/index.js';
import { type AgentName } from '../install/detect.js';

interface ConnectOpts {
  preset?: string;
  allTools?: boolean;
  dryRun?: boolean;
  force?: boolean;
  analyze?: boolean;
  /** Skip the interactive picker and wire every detected agent (zero-interaction). */
  yes?: boolean;
  /** Project root; defaults to process.cwd() in runInstall. Used by tests. */
  cwd?: string;
}

/**
 * Connect one agent, or — with no agent and an interactive terminal — let the
 * user pick several. Non-interactive with no agent falls back to detection
 * (same as bare `openlore install`).
 */
export async function runConnect(agent: string | undefined, opts: ConnectOpts): Promise<number> {
  if (agent) {
    return runInstall({ agent: agent as AgentName, ...opts });
  }

  // Zero-interaction: --yes (or a non-interactive terminal) wires every detected
  // agent with no prompt, exactly like bare `openlore install`.
  if (opts.yes) {
    return runInstall(opts);
  }

  if (process.stdout.isTTY) {
    const status = await surfaceStatus();
    const selected = await checkbox<AgentName>({
      message: 'Connect OpenLore to which agents?',
      choices: status.map((s) => ({
        name: `${s.agent}${s.detected ? ' (detected)' : ''}${s.connected ? ' — already connected' : ''}`,
        value: s.agent,
        checked: s.detected && !s.connected,
      })),
    });
    if (!selected.length) {
      logger.info('Connect', 'No agents selected — nothing to do.');
      return 0;
    }
    return runInstall({ agents: selected, ...opts });
  }

  // Non-interactive: behave like bare install (detect + wire).
  return runInstall(opts);
}

export const connectCommand = new Command('connect')
  .description(
    'Connect OpenLore to a coding agent (idempotent): inject guidance, register the MCP server ' +
    'and SessionStart hook, and set the run permission. Omit the agent for an interactive picker.'
  )
  .argument('[agent]', 'Agent to connect (claude-code, cursor, cline, continue, agents-md)')
  .option('--preset <name>', 'Wire the MCP server to a tool preset (minimal, navigation, memory, verify, federation, or full). Default (no preset) wires the lean navigation surface; pass "full" to wire all 62 tools (the prior default).')
  .option('--all-tools', 'Wire the full surface (alias of --preset full). Matches `openlore mcp --all-tools`.')
  .option('--dry-run', 'Print the planned changes without writing any files', false)
  .option('--force', 'Overwrite OpenLore-managed blocks even if hand-edited', false)
  .option('-y, --yes', 'Skip the interactive picker; wire every detected agent', false)
  .option('--no-analyze', 'Configure surfaces only; do not build the index')
  .addHelpText(
    'after',
    `
Examples:
  $ openlore connect                      Pick agents interactively, wire them up
  $ openlore connect claude-code          Connect Claude Code (guidance + MCP + hook + permission)
  $ openlore connect cursor --preset memory
  $ openlore connect list                 Show supported agents and their status
  $ openlore connect remove claude-code   Disconnect Claude Code
`
  )
  .action(async (agent: string | undefined, opts: ConnectOpts) => {
    const code = await runConnect(agent, opts);
    if (code !== 0) process.exit(code);
  });

connectCommand
  .command('list')
  .description('List supported agents and whether OpenLore is connected to each')
  .action(async () => {
    const status = await surfaceStatus();
    logger.discovery('Supported agents:');
    for (const s of status) {
      const state = s.connected ? 'connected' : s.detected ? 'detected, not connected' : 'not connected';
      logger.info(s.agent.padEnd(14), state);
    }
  });

connectCommand
  .command('remove [agent]')
  .description('Disconnect OpenLore from an agent (or all detected agents)')
  .option('--dry-run', 'Print the planned changes without writing any files', false)
  .action(async (agent: string | undefined, opts: { dryRun?: boolean }) => {
    const code = await runInstall({
      agent: agent as AgentName | undefined,
      uninstall: true,
      analyze: false,
      dryRun: opts.dryRun,
    });
    if (code !== 0) process.exit(code);
  });
