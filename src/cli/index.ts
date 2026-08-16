#!/usr/bin/env node

/**
 * openlore CLI entry point
 *
 * Persistent architectural memory for coding agents: deterministic, local
 * structural context served through `orient` and an MCP server.
 * Philosophy: "Archaeology over Creativity" — grounded in static analysis, not LLM guessing.
 */

// Guard the Node version BEFORE anything heavy loads. This bootstrap import runs
// the guard as a side effect; because ESM evaluates dependencies in source order
// (each fully before the next), keeping it the FIRST import makes it run ahead of
// commander and the command modules. A host on an unsupported Node (e.g.
// `openspec lore generate` under Node 20) gets one legible stderr line and a
// stable exit code, never a stack trace. Keep this the first import.
import './node-version-bootstrap.js';
// Size the V8 heap to the machine BEFORE commander and the command modules load, so a large
// repository analyzes with no `--max-old-space-size` flag (change: make-analyze-scale-to-any-repo).
// Placed right after the Node-version guard: both are early import side effects, and a re-exec here
// does essentially no wasted work before handing off to the larger-heap child. Fail-open and
// at-most-once — see heap-sizing.ts.
import './heap-bootstrap.js';
import { allowInsecureTls } from '../core/services/tls-scope.js';

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { initCommand } from './commands/init.js';
import { analyzeCommand } from './commands/analyze.js';
import { embedCommand } from './commands/embed.js';
import { orientCommand } from './commands/orient.js';
import { proveCommand } from './commands/prove.js';
import { generateCommand } from './commands/generate.js';
import { verifyCommand } from './commands/verify.js';
import { driftCommand } from './commands/drift.js';
import { runCommand } from './commands/run.js';
import { mcpCommand } from './commands/mcp.js';
import { viewCommand } from './commands/view.js';
import { doctorCommand } from './commands/doctor.js';
import { setupCommand } from './commands/setup.js';
import { refreshStoriesCommand } from './commands/refresh-stories.js';
import { auditCommand } from './commands/audit.js';
import { mappingCommand } from './commands/mapping.js';
import { testCommand } from './commands/test.js';
import { digestCommand } from './commands/digest.js';
import { decisionsCommand } from './commands/decisions.js';
import { telemetryCommand } from './commands/telemetry.js';
import { setTelemetryIdentitySource } from '../core/services/telemetry.js';
import { installCommand } from './install/index.js';
import { connectCommand } from './commands/connect.js';
import { federationCommand } from './commands/federation.js';
import { preflightCommand } from './preflight/index.js';
import { blastRadiusCommand } from './commands/blast-radius.js';
import { reviewCommand } from './commands/review.js';
import { specStoreCommand } from './commands/spec-store.js';
import { workingSetCommand } from './commands/working-set.js';
import { impactCertificateCommand } from './commands/impact-certificate.js';
import { coverageGapsCommand } from './commands/coverage-gaps.js';
import { certifyPublicSurfaceCommand } from './commands/certify-public-surface.js';
import { styleFingerprintCommand } from './commands/style-fingerprint.js';
import { briefingSinceCommand } from './commands/briefing-since.js';
import { findClonesCommand } from './commands/find-clones.js';
import { errorPropagationCommand } from './commands/error-propagation.js';
import { envImpactCommand } from './commands/env-impact.js';
import { enforceCommand } from './commands/enforce.js';
import { exportCommand } from './export/index.js';
import { importCommand } from './commands/import.js';
import { manifestCommand } from './manifest/index.js';
import { pluginManifestCommand } from './plugin-manifest/index.js';
import { serveCommand } from './commands/serve.js';
import { panicCheckCommand } from './commands/panic-check.js';
import { panicLevelCommand } from './commands/panic-level.js';
import { panicValidateCommand } from './commands/panic-validate.js';
import { panicHotspotsCommand } from './commands/panic-hotspots.js';
import { panicCalibrateCommand } from './commands/panic-calibrate.js';
import { panicReplayCommand } from './commands/panic-replay.js';
import { gryphWatchCommand } from './commands/gryph-watch.js';
import { updateCommand } from './commands/update.js';
import { featuresCommand } from './commands/features.js';
import { changeStatusCommand } from './commands/change-status.js';
import { applyJobGroupedHelp } from './help-groups.js';
import { configureLogger, logger } from '../utils/logger.js';
import { colorForStderr } from '../utils/colors.js';
import { checkExplicitConfig, type OptionValueSource } from './config-guard.js';
import { setPrimaryConfigPath } from '../core/services/config-manager.js';
import { notifyIfUpdateAvailable } from '../core/services/update-notifier.js';

// Read version from package.json at runtime so it never drifts from the published version
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const program = new Command();

// Commands where a human is watching and a once-a-day "update available" line
// on stderr is welcome. Deliberately excludes the hot paths an agent drives —
// `orient`, `mcp`, `serve`, hooks, the panic/gryph daemons — so their output is
// never polluted. The notifier is also self-suppressing (non-TTY / CI / opt-out).
const UPDATE_NOTIFY_COMMANDS = new Set([
  'install', 'connect', 'update', 'doctor', 'prove', 'analyze', 'init',
]);

// Hook to configure logger before any command runs
program.hook('preAction', (thisCommand, actionCommand) => {
  const opts = thisCommand.opts();

  configureLogger({
    quiet: opts.quiet ?? false,
    verbose: opts.verbose ?? false,
    noColor: opts.color === false,
    timestamps: process.env.CI === 'true' || opts.color === false,
  });

  // An explicitly-passed --config that does not resolve is a fatal error naming
  // the path — never a silent fallback to the default config (which would run,
  // e.g., without the enforcement policy the user asked for). Only fires when the
  // value came from the CLI, not the built-in default (OutputContractsAreUniform).
  const configSource = thisCommand.getOptionValueSource('config') as OptionValueSource;
  const configGuard = checkExplicitConfig(configSource, opts.config as string | undefined);
  if (!configGuard.ok) {
    logger.error(configGuard.message!);
    process.exit(1);
  }
  // The explicit path is readable — honor it. Config reads/writes for the current
  // project root now resolve to this file instead of the default
  // <root>/.openlore/config.json (ExplicitConfigPathIsHonored). Keyed to cwd so peer
  // (federation / spec-store) reads of other repos are never redirected.
  if (configSource === 'cli' && typeof opts.config === 'string') {
    setPrimaryConfigPath(process.cwd(), opts.config);
  }

  // Passive update notifier — cached, non-blocking, fail-silent. Only for
  // human-interactive commands, and never when --quiet.
  if (!opts.quiet && UPDATE_NOTIFY_COMMANDS.has(actionCommand.name())) {
    try {
      notifyIfUpdateAvailable(version);
    } catch {
      /* the notifier must never break a command */
    }
  }

  // Warn when SSL verification is disabled — it's a security trade-off
  if (opts.insecure) {
    // The CLI prints its own colorized, quiet-aware notice below, so the shared
    // helper stays silent here rather than duplicating it (and writing in --quiet).
    allowInsecureTls('--insecure', { announce: false });
    // Only print if we're not in quiet mode
    if (!opts.quiet) {
      const c = colorForStderr();
      process.stderr.write(
        `${c.yellow('[warn]')} --insecure: SSL certificate verification is disabled. ` +
        'Only use this on trusted networks.\n'
      );
    }
  }
});

program
  .name('openlore')
  .description(
    'Persistent architectural memory for coding agents.\n\n' +
      'OpenLore serves deterministic, local structural context — the functions, callers, ' +
      'specs, and insertion points relevant to a task — through `orient` and an MCP server, ' +
      'grounded in static analysis, not LLM guessing.\n\n' +
      'New here? Run `openlore install` to wire your coding agent and build the index in one step.'
  )
  .version(version)
  .option('-q, --quiet', 'Minimal output (errors only)', false)
  .option('-v, --verbose', 'Show debug information', false)
  .option('--no-color', 'Disable colored output (also enables timestamps)')
  .option('--config <path>', 'Path to config file', '.openlore/config.json')
  .option(
    '--api-base <url>',
    'Custom LLM API base URL (for local/enterprise OpenAI-compatible servers)'
  )
  .option('--insecure', 'Disable SSL certificate verification (for internal/self-signed certs)')
  .option('--timeout <ms>', 'LLM request timeout in milliseconds (default: 120000)', parseInt)
  .addHelpText(
    'after',
    `
Get started (one command, no API key):
  $ cd your-project
  $ openlore install      Wire your coding agent + build the structural index

  Then just code. Your agent calls orient at the start of each task and gets the
  relevant functions, callers, specs, and insertion points in one structural lookup.
  Not sure it is wired? Run: openlore doctor    Does it pay off? openlore prove --estimate

Core commands (no API key):
  openlore install      One-command setup: wire agent surfaces + build the index
  openlore orient       Relevant functions, callers, specs & insertion points for a task
  openlore mcp          Run the MCP server your agent connects to (substrate preset by default)
  openlore analyze      (Re)build the structural index from static analysis
  openlore prove        Measure OpenLore's token value on YOUR repo (--estimate = no API key)
  openlore doctor       Check your setup and tell you exactly what to fix
  openlore features     List opt-in features, what's active, and how to turn on the rest

Specs & governance:
  openlore generate     Standalone provider-backed spec generation (provider access required)
  prepare_spec_generation    Evidence for your connected host agent to author specs (no extra key)
  openlore verify       LLM-enhanced verification (provider access required)
  openlore drift        Detect when code outpaces specs (no API key by default)
  openlore test         Report spec test coverage (no API key)
  openlore digest       Plain-English summary of specs for human review (no API key)
  openlore mapping refresh   Rebuild the spec→code link index from spec anchors (no API key)
  openlore audit             Report spec coverage gaps from that index (no API key)

Run 'openlore <command> --help' for the full options of any command.

Learn more: https://github.com/clay-good/OpenLore
`
  );

// Register subcommands
program.addCommand(initCommand);
program.addCommand(analyzeCommand);
program.addCommand(embedCommand);
program.addCommand(orientCommand);
program.addCommand(proveCommand);
program.addCommand(generateCommand);
program.addCommand(verifyCommand);
program.addCommand(driftCommand);
program.addCommand(runCommand);
program.addCommand(mcpCommand);
program.addCommand(viewCommand);
program.addCommand(doctorCommand);
program.addCommand(featuresCommand);
program.addCommand(setupCommand);
program.addCommand(refreshStoriesCommand);
program.addCommand(auditCommand);
program.addCommand(mappingCommand);
program.addCommand(testCommand);
program.addCommand(digestCommand);
program.addCommand(decisionsCommand);
program.addCommand(telemetryCommand);
program.addCommand(installCommand);
program.addCommand(connectCommand);
program.addCommand(federationCommand);
program.addCommand(preflightCommand);
program.addCommand(blastRadiusCommand);
program.addCommand(reviewCommand);
program.addCommand(specStoreCommand);
program.addCommand(workingSetCommand);
program.addCommand(impactCertificateCommand);
program.addCommand(coverageGapsCommand);
program.addCommand(certifyPublicSurfaceCommand);
program.addCommand(styleFingerprintCommand);
program.addCommand(briefingSinceCommand);
program.addCommand(findClonesCommand);
program.addCommand(errorPropagationCommand);
program.addCommand(envImpactCommand);
program.addCommand(enforceCommand);
program.addCommand(exportCommand);
program.addCommand(importCommand);
program.addCommand(manifestCommand);
program.addCommand(pluginManifestCommand);
program.addCommand(serveCommand);
program.addCommand(panicCheckCommand);
program.addCommand(panicLevelCommand);
program.addCommand(panicValidateCommand);
program.addCommand(panicHotspotsCommand);
program.addCommand(panicCalibrateCommand);
program.addCommand(panicReplayCommand);
program.addCommand(gryphWatchCommand);
program.addCommand(updateCommand);
program.addCommand(changeStatusCommand);

// Group the ~49 commands by job in `openlore --help` so the front door is legible
// (CommandSurfaceGroupedByJob). Presentation only — every command stays invocable.
// Must run after the last addCommand(): it tags each registered subcommand with its group.
applyJobGroupedHelp(program);

// Attribute telemetry emitted by a CLI run to the command that produced it, so a
// CLI-originated event never lands in an MCP client's statistics
// (change: scope-telemetry-by-agent-and-session). Lazy: resolved on first emit,
// and only when telemetry is enabled — a run that emits nothing pays nothing.
setTelemetryIdentitySource(() => {
  // Commander has parsed global options by the time the lazy source resolves,
  // so this remains correct for invocations such as `openlore --verbose analyze`.
  const command = program.args[0];
  return { agent: `cli:${command || 'unknown'}`, agentVersion: version };
});

// A bare `openlore` (no command) is the most natural way a new user explores the tool.
// Show help on stdout and exit 0 instead of Commander's default (help on stderr, exit 1).
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse();
